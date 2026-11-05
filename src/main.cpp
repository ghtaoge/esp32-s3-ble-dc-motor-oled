#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "motor_protocol.h"
#include "motor_runtime.h"

constexpr bool usablePin(int pin) {
  return pin == 1 || pin == 2 || (pin >= 4 && pin <= 18) || pin == 21 ||
         (pin >= 38 && pin <= 44) || pin == 47;
}
constexpr bool distinctPins() {
  const int pins[] = {OLED_SDA, OLED_SCL, MOTOR_IN1, MOTOR_IN2, MOTOR_PWM, MOTOR_STBY};
  for (size_t i = 0; i < 6; ++i) {
    if (!usablePin(pins[i])) return false;
    for (size_t j = i + 1; j < 6; ++j) if (pins[i] == pins[j]) return false;
    if (ENCODER_PIN >= 0 && pins[i] == ENCODER_PIN) return false;
  }
  return true;
}
static_assert(distinctPins(), "Select distinct exposed GPIOs; avoid USB, strapping and PSRAM pins");
static_assert((ENCODER_PIN == -1 && ENCODER_PULSES_PER_REV == 0) ||
              (usablePin(ENCODER_PIN) && ENCODER_PULSES_PER_REV > 0 && ENCODER_PULSES_PER_REV <= 65535),
              "Configure both encoder GPIO and A-rising pulses per measured shaft revolution");

namespace {
constexpr char Service[] = "e75b0001-4e42-4ea0-9b38-33c7bc713100";
constexpr char Write[] = "e75b0002-4e42-4ea0-9b38-33c7bc713100";
constexpr char Status[] = "e75b0003-4e42-4ea0-9b38-33c7bc713100";
constexpr uint8_t Resolution = 10;
constexpr bool EncoderConfigured = ENCODER_PIN >= 0;
constexpr uint32_t DisplayIntervalMs = 250, NotifyIntervalMs = 150, TelemetryMs = 1000;
U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
BLECharacteristic* statusCharacteristic = nullptr;
QueueHandle_t commands = nullptr, displayQueue = nullptr;
std::atomic<uint32_t> linkState{0};
uint32_t handledLink = 0;
struct Packet { uint32_t link, receivedAt; uint8_t size; uint8_t bytes[motor::CommandSize]; };
struct DisplayState {
  uint8_t targetSpeed, outputSpeed, targetDir, outputDir, reason;
  uint16_t rpm;
  bool connected, pwmReady, transitioning;
};
motor::Runtime control;
bool oledReady = false, pwmReady = false, pwmAttached = false;
bool displayDirty = true, statusDirty = true;
uint8_t appliedSpeed = 0, appliedDir = 0;
uint16_t rpm = motor::UnavailableRpm;
uint32_t notifyAt = 0, rpmAt = 0, previousPulses = 0;
volatile uint32_t encoderPulses = 0;
portMUX_TYPE encoderMux = portMUX_INITIALIZER_UNLOCKED;

bool connected() { return motor::linkConnected(linkState.load()); }
void ARDUINO_ISR_ATTR countPulse() {
  portENTER_CRITICAL_ISR(&encoderMux);
  encoderPulses = encoderPulses + 1U;
  portEXIT_CRITICAL_ISR(&encoderMux);
}
void disableBridge() {
  // Standby first: even a PWM API failure must leave the bridge disabled.
  digitalWrite(MOTOR_STBY, LOW);
  if (pwmAttached) ledcWrite(MOTOR_PWM, 0);
  digitalWrite(MOTOR_IN1, LOW); digitalWrite(MOTOR_IN2, LOW);
  appliedSpeed = appliedDir = 0;
}
void applyOutput() {
  if (control.outputSpeed == appliedSpeed && control.outputDir == appliedDir) return;
  if (!control.outputSpeed) { disableBridge(); return; }
  if (!pwmReady) { control.stop(4, millis()); disableBridge(); return; }
  if (control.outputDir != appliedDir) {
    digitalWrite(MOTOR_STBY, LOW);
    if (!ledcWrite(MOTOR_PWM, 0)) {
      pwmReady = false; control.stop(4, millis()); disableBridge(); return;
    }
    digitalWrite(MOTOR_IN1, control.outputDir == 1 ? HIGH : LOW);
    digitalWrite(MOTOR_IN2, control.outputDir == 2 ? HIGH : LOW);
  }
  const uint32_t duty = (uint32_t(control.outputSpeed) * ((1UL << Resolution) - 1) + 50) / 100;
  if (!ledcWrite(MOTOR_PWM, duty)) {
    pwmReady = false; control.stop(4, millis()); disableBridge(); return;
  }
  digitalWrite(MOTOR_STBY, HIGH);
  appliedSpeed = control.outputSpeed; appliedDir = control.outputDir;
}
void stopMotor(uint8_t reason) {
  control.stop(reason, millis()); disableBridge();
  displayDirty = statusDirty = true;
}
void encodeStatus(uint8_t* bytes, uint8_t seq, uint8_t op, uint8_t result) {
  bytes[0] = 0x5A; bytes[1] = motor::Version; bytes[2] = seq; bytes[3] = op; bytes[4] = result;
  bytes[5] = (oledReady ? 1 : 0) | (pwmReady ? 2 : 0) | (control.outputSpeed ? 4 : 0) |
             (control.transitioning() ? 8 : 0) | (EncoderConfigured ? 16 : 0);
  bytes[6] = control.targetSpeed; bytes[7] = control.outputSpeed;
  bytes[8] = control.targetDir; bytes[9] = control.outputDir; bytes[10] = control.reason;
  bytes[11] = EncoderConfigured ? 1 : 0;
  motor::write16(bytes + 12, motor::PwmHz); motor::write16(bytes + 14, motor::LeaseMs);
  motor::write16(bytes + 16, rpm); motor::write16(bytes + 18, ENCODER_PULSES_PER_REV);
}
void publish(uint8_t seq = 0, uint8_t op = 0, uint8_t result = 0, bool notify = true) {
  uint8_t bytes[motor::StatusSize];
  encodeStatus(bytes, seq, op, result);
  statusCharacteristic->setValue(bytes, sizeof(bytes));
  if (notify && connected()) statusCharacteristic->notify();
  // Read yields neutral current state rather than the last command's error.
  if (seq || op || result) {
    encodeStatus(bytes, 0, 0, 0); statusCharacteristic->setValue(bytes, sizeof(bytes));
  }
  notifyAt = millis(); statusDirty = false;
}
const char* directionName(uint8_t direction) { return direction == 1 ? "正转" : direction == 2 ? "反转" : "停止"; }
void drawDisplay(const DisplayState& state) {
  display.clearBuffer();
  display.drawUTF8(0, 12, state.connected ? "蓝牙已连接" : "等待蓝牙连接");
  char line[64];
  snprintf(line, sizeof(line), "目标:%3u%% %s", state.targetSpeed, directionName(state.targetDir));
  display.drawUTF8(0, 28, line);
  snprintf(line, sizeof(line), "输出:%3u%% %s", state.outputSpeed, directionName(state.outputDir));
  display.drawUTF8(0, 44, line);
  if (!state.pwmReady) display.drawUTF8(0, 60, "PWM初始化失败");
  else if (state.reason == 3) display.drawUTF8(0, 60, "保活超时 / 已停机");
  else if (state.rpm != motor::UnavailableRpm) {
    snprintf(line, sizeof(line), "实测:%5u RPM", state.rpm); display.drawUTF8(0, 60, line);
  } else display.drawUTF8(0, 60, state.transitioning ? "调速中 / RPM未配置" : "PWM控制 / 无测速");
}
void displayTask(void*) {
  DisplayState state;
  uint8_t previous[1024] = {};
  bool first = true;
  uint32_t lastAt = millis() - DisplayIntervalMs;
  for (;;) {
    xQueueReceive(displayQueue, &state, portMAX_DELAY);
    const uint32_t elapsed = millis() - lastAt;
    if (elapsed < DisplayIntervalMs) vTaskDelay(pdMS_TO_TICKS(DisplayIntervalMs - elapsed));
    DisplayState latest;
    if (xQueueReceive(displayQueue, &latest, 0) == pdTRUE) state = latest;
    drawDisplay(state);
    const uint8_t* frame = display.getBufferPtr();
    if (first) { display.sendBuffer(); first = false; }
    else for (uint8_t row = 0; row < 8; ++row) {
      const auto span = motor::changedTiles(frame + row * 128, previous + row * 128);
      if (span.count) display.updateDisplayArea(span.first, row, span.count, 1);
    }
    memcpy(previous, frame, sizeof(previous)); lastAt = millis();
  }
}
void queueDisplay() {
  if (!displayDirty) return;
  if (displayQueue) {
    const DisplayState state{control.targetSpeed, control.outputSpeed, control.targetDir, control.outputDir,
                             control.reason, rpm, connected(), pwmReady, control.transitioning()};
    xQueueOverwrite(displayQueue, &state);
  }
  displayDirty = false;
}
void initDisplay() {
  Wire.begin(OLED_SDA, OLED_SCL); Wire.setTimeOut(50);
  for (uint8_t address : {0x3C, 0x3D}) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() != 0) continue;
    display.setI2CAddress(address << 1); display.setBusClock(400000); display.begin();
    Wire.setTimeOut(50); display.setFont(u8g2_font_wqy12_t_gb2312);
    oledReady = true;
    Serial.printf("OLED SSD1306 0x%02X SDA=%d SCL=%d\n", address, OLED_SDA, OLED_SCL);
    return;
  }
  Serial.println("OLED not found; BLE motor control remains available.");
}
class ServerCallbacks : public BLEServerCallbacks {
  void change(bool up) {
    uint32_t old = linkState.load();
    while (!linkState.compare_exchange_weak(old, motor::nextLink(old, up))) {}
  }
  void onConnect(BLEServer*) override { change(true); }
  void onDisconnect(BLEServer*) override { change(false); }
};
class WriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value = characteristic->getValue();
    Packet packet{}; packet.link = linkState.load(); packet.receivedAt = millis();
    packet.size = value.length() == motor::CommandSize ? motor::CommandSize : 0;
    memcpy(packet.bytes, value.c_str(), value.length() < sizeof(packet.bytes) ? value.length() : sizeof(packet.bytes));
    xQueueSend(commands, &packet, 0);
  }
};
uint32_t syncConnection() {
  const uint32_t link = linkState.load();
  if (handledLink != link) {
    handledLink = link; stopMotor(2); publish();
  }
  return link;
}
uint8_t apply(const motor::Command& cmd, uint32_t receivedAt) {
  if (cmd.op == motor::Stop) { stopMotor(1); return motor::Ok; }
  if (cmd.op == motor::Keepalive) { control.keepalive(receivedAt); return motor::Ok; }
  if (!pwmReady) return motor::PwmError;
  control.run(cmd.speed, cmd.direction, receivedAt);
  displayDirty = statusDirty = true;
  return motor::Ok;
}
void sampleRpm(uint32_t now) {
  if (!EncoderConfigured || now - rpmAt < 250) return;
  portENTER_CRITICAL(&encoderMux);
  const uint32_t pulses = encoderPulses;
  portEXIT_CRITICAL(&encoderMux);
  const uint16_t measured = motor::rpmFor(pulses - previousPulses, now - rpmAt, ENCODER_PULSES_PER_REV);
  previousPulses = pulses; rpmAt = now;
  if (rpm != measured) { rpm = measured; displayDirty = statusDirty = true; }
}
}
void setup() {
  // External 10k pulldowns on STBY and PWMA keep the bridge off before setup.
  pinMode(MOTOR_STBY, OUTPUT); digitalWrite(MOTOR_STBY, LOW);
  pinMode(MOTOR_PWM, OUTPUT); digitalWrite(MOTOR_PWM, LOW);
  pinMode(MOTOR_IN1, OUTPUT); digitalWrite(MOTOR_IN1, LOW);
  pinMode(MOTOR_IN2, OUTPUT); digitalWrite(MOTOR_IN2, LOW);
  Serial.begin(115200); Serial.setTxTimeoutMs(0);
  pwmReady = pwmAttached = ledcAttach(MOTOR_PWM, motor::PwmHz, Resolution);
  disableBridge();
  if (!pwmReady) control.stop(4, millis());
  initDisplay();
  if (EncoderConfigured) {
    pinMode(ENCODER_PIN, INPUT); // Sensor voltage/pullup must be verified externally.
    rpmAt = millis(); attachInterrupt(digitalPinToInterrupt(ENCODER_PIN), countPulse, RISING);
  }
  commands = xQueueCreate(8, sizeof(Packet));
  if (!commands) { Serial.println("Command queue allocation failed"); while (true) delay(1000); }
  char name[24];
  snprintf(name, sizeof(name), "S3-MOTOR-%04X", static_cast<unsigned>((ESP.getEfuseMac() >> 32) & 0xFFFF));
  if (!BLEDevice::init(name)) { Serial.println("BLE init failed"); while (true) delay(1000); }
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks()); server->advertiseOnDisconnect(true);
  BLEService* service = server->createService(Service);
  auto* write = service->createCharacteristic(Write, BLECharacteristic::PROPERTY_WRITE);
  write->setCallbacks(new WriteCallbacks());
  statusCharacteristic = service->createCharacteristic(Status, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
#if defined(CONFIG_BLUEDROID_ENABLED)
  statusCharacteristic->addDescriptor(new BLE2902());
#endif
  publish(0, 0, 0, false); service->start();
  BLEAdvertisementData advertisement, scanResponse;
  advertisement.setFlags(0x06); advertisement.setCompleteServices(BLEUUID(Service)); scanResponse.setName(name);
  auto* advertising = BLEDevice::getAdvertising();
  advertising->setAdvertisementData(advertisement); advertising->setScanResponseData(scanResponse); advertising->start();
  if (oledReady) {
    displayQueue = xQueueCreate(1, sizeof(DisplayState));
    if (!displayQueue || xTaskCreatePinnedToCore(displayTask, "oled", 6144, nullptr, 1, nullptr, 0) != pdPASS) {
      if (displayQueue) vQueueDelete(displayQueue);
      displayQueue = nullptr; oledReady = false;
      Serial.println("OLED task allocation failed"); publish(0, 0, 0, false);
    }
  }
  queueDisplay();
  Serial.printf("BLE=%s TB6612 IN1=%d IN2=%d PWM=%d STBY=%d PWM=%s Flash=%lu PSRAM=%lu\n",
    name, MOTOR_IN1, MOTOR_IN2, MOTOR_PWM, MOTOR_STBY, pwmReady ? "ready" : "FAILED",
    static_cast<unsigned long>(ESP.getFlashChipSize()), static_cast<unsigned long>(ESP.getPsramSize()));
}
void loop() {
  syncConnection();
  const uint32_t now = millis();
  if (control.tick(now)) {
    applyOutput(); displayDirty = statusDirty = true;
    if (!control.transitioning()) publish();
  }
  sampleRpm(now);
  const uint32_t sinceNotify = millis() - notifyAt;
  if ((statusDirty && sinceNotify >= NotifyIntervalMs) || (connected() && sinceNotify >= TelemetryMs)) publish();
  queueDisplay();
  Packet packet;
  const bool received = xQueueReceive(commands, &packet, pdMS_TO_TICKS(5)) == pdTRUE;
  const uint32_t link = syncConnection();
  if (received && packet.link == link && motor::linkConnected(link) && millis() - packet.receivedAt < motor::LeaseMs) {
    motor::Command cmd;
    uint8_t result = motor::decode(packet.bytes, packet.size, cmd);
    if (result == motor::BadFrame) return;
    if (result == motor::Ok) result = apply(cmd, packet.receivedAt);
    if (packet.link == linkState.load()) publish(packet.bytes[2], packet.bytes[3], result);
    else syncConnection();
  }
}
