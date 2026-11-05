# 微信蓝牙控制直流电机与 OLED

独立 PlatformIO 工程，适用于 **ESP32-S3 N16R8 + TB6612FNG + SSD1306 128×64 I²C OLED**。手机微信小程序通过 BLE 近距离控制一台有刷直流电机，支持启停、正反转、PWM 调速和状态回传，无需 Wi-Fi 或服务器。

OLED 接线固定为 **SDA → GPIO8、SCL → GPIO9**。本工程不修改其他 OLED、舵机项目。

你现有的 **EC11 是手拧旋钮编码器**，通常用于菜单、音量或手动调速输入。本版不连接 EC11，也不将其当作电机轴测速器；界面中的“方向”是控制指令，PWM 百分比不是实测转速。未来可以增加 EC11 本地调速，或另接适合电机轴的编码器测量 RPM。

## 1. 先确认电机电源

电机额定电压已确认是 **4.5V**，VM 使用独立 4.5V 电源。电源需能承担电机启动／堵转电流，还需核对 TB6612 模块的持续电流能力和散热条件。当前电机电流参数及实际电源型号尚未提供。**电机不能直接接 ESP32 GPIO 或开发板 3V3 供电。**

TB6612 的 **VCC 是逻辑电源，VM 是电机电源**。本方案 VCC 接 ESP32 的 3V3；VM 使用匹配电机的独立电源。芯片资料中的绝对最大值和短时峰值不能当成模块长期工作能力。供电范围、散热与去耦按[东芝 TB6612FNG 数据手册](https://toshiba.semicon-storage.com/info/TB6612FNG_datasheet_en_20141001.pdf?did=10660&prodName=TB6612FNG)和具体模块资料核对。

## 2. 接线

断电后接线，按模块丝印名称连接。GPIO 编号不是排针序号。

| 部件 | 引脚 | 连接 |
| --- | --- | --- |
| OLED | VCC | ESP32 3V3 |
| OLED | GND | ESP32 GND |
| OLED | SDA | **GPIO8** |
| OLED | SCL / SCK | **GPIO9** |
| TB6612 | VCC | ESP32 3V3 |
| TB6612 | GND | ESP32 GND、独立电源负极共地 |
| TB6612 | VM | 独立 **4.5V** 电机电源正极 |
| TB6612 | AIN1 | **GPIO4** |
| TB6612 | AIN2 | **GPIO5** |
| TB6612 | PWMA | **GPIO6** |
| TB6612 | STBY | **GPIO7** |
| TB6612 | AO1 / A01、AO2 / A02 | 电机两根线 |
| TB6612 | BIN1、BIN2、PWMB | 未使用的 B 通道输入接 GND |
| TB6612 | BO1、BO2 | 不连接 |

建议在 **STBY → GND、PWMA → GND 各加一只 10kΩ 下拉电阻**，使复位期间保持关闭；若模块已将 STBY 固定拉高或接有使能跳帽，需要先按模块原理图取消该连接，让 GPIO7 控制 STBY。

```text
电脑 USB ─────── ESP32-S3
                  ├─ 3V3 ─── OLED VCC、TB6612 VCC
                  ├─ GPIO8 ─ OLED SDA
                  ├─ GPIO9 ─ OLED SCL
                  ├─ GPIO4 ─ TB6612 AIN1
                  ├─ GPIO5 ─ TB6612 AIN2
                  ├─ GPIO6 ─ TB6612 PWMA
                  ├─ GPIO7 ─ TB6612 STBY
                  └─ GND ─── OLED GND、TB6612 GND ── 电机电源负极
独立 4.5V 电源正极 ────────── TB6612 VM
电机两根线 ──────────────── TB6612 AO1、AO2
```

开发板使用 USB 供电，独立电源正极只接驱动 VM，两边共地。OLED 用 3.3V 供电，避免 I²C 上拉到 5V。驱动电源附近按模块要求安装去耦和储能电容；电机线尽量短，远离 I²C 和 USB 线。

本项目使用 GPIO4～9；不要改用 N16R8 的 GPIO35、36、37，这些引脚被 OPI PSRAM 占用，见 [Espressif 开发板说明](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)。

## 3. 编译与烧录

用 VS Code / PlatformIO 打开本目录，选择 `esp32-s3-n16r8`。配置为 16 MB Flash、8 MB OPI PSRAM，Arduino-ESP32 3.x，U8g2 2.36.15。

编译日志中的通用基板名称可能仍显示 N8／8MB／No PSRAM；本项目已在 `platformio.ini` 覆盖 N16R8 的内存配置，实际硬件容量可看启动串口日志。

```sh
pio run
pio device list
pio run --target upload --upload-port COM你的串口号
pio device monitor --baud 115200 --port COM你的串口号
```

上传会替换板上的固件。首次上传前先断开电机电源，只给开发板和 OLED 供电检查。若 `pio` 不在 PATH，使用 PlatformIO 扩展终端；本机也可执行：

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run
```

下载连接失败时，按住 BOOT，点按 RST / EN，再松开 BOOT 并重试。日志通过原生 USB CDC 输出，波特率为 115200。

固件启动后广播 `S3-MOTOR-XXXX`，检测 OLED 的 `0x3C` / `0x3D` 地址；OLED 未检测到时仍可蓝牙控制。修好屏幕接线后复位重新检测。

## 4. 微信小程序

1. 微信开发者工具导入 `miniprogram/`，填写自己的小程序 AppID。`touristappid` 是源码占位；BLE 必须用手机真机验证。
2. 在小程序后台按实际用途配置蓝牙权限说明及用户隐私保护指引。页面包含微信原生隐私授权按钮。
3. 手机打开蓝牙，用有开发权限的微信账号预览，点击“搜索开发板”，连接 `S3-MOTOR-XXXX`。无需先在系统蓝牙设置中配对。
4. 保持电机空载并固定好，接通电机电源；设置 PWM 与方向，点击“启动 / 应用设置”。滑块和方向按钮只调整待发送值。
5. 点击“停止输出”。正在发送指令时也能停止；为取消尚未确认的启动指令，此时可能直接断开蓝牙。

需要保留源码 AppID 占位时，可以生成本地副本：

```sh
python tools/prepare_wechat.py --appid 你的小程序AppID
```

然后导入 `.local/wechat/`。修改源码后重新生成副本。部分安卓手机还需要附近设备权限、定位权限或定位服务，按系统提示处理。

## 5. 控制与显示

- PWM 为 **20kHz、10 位分辨率**，界面设置 1～100%；停止使用单独指令。使用的 [Espressif LEDC API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html)由硬件持续生成 PWM。
- 上电、连接、重新连接和返回页面都不自动启动。运行期间每 20ms 最多变化 2 个百分点。
- 换向先降至 0，再滑行等待 300ms，随后逐步升至新目标。这段等待不代表已测得电机停转；具体负载可能需要更长时间。
- 停止将 STBY 拉低，使驱动输出为高阻，电机可能继续滑行。它不是机械制动或电机电源隔离。正常调速时，TB6612 的 PWM 低电平区间属于短路制动模式，见芯片控制真值表。
- 手机前台运行时约每 400ms 保活；固件 1500ms 未收到有效运行指令或保活就停止输出。蓝牙协议栈报告连接变化时也会停止。退出页面、切后台或保活失败会关闭连接；恢复后需要手动重新连接及启动。
- OLED 和小程序显示连接状态、目标／当前 PWM 及方向指令。小程序显示完整停止原因，OLED 明确提示 PWM 故障和保活超时。当前 PWM 仍是控制输出，无法判断电机是否卡住、断线或断电。
- 默认不配置测速输入，RPM 显示“测速未配置”。EC11 不提供当前这台电机的轴转速数据。

BLE 当前未设置配对口令或访问认证，附近兼容客户端可连接并控制，适合个人台架调试。

## 6. 后续接真正的电机轴编码器

本工程预留单路脉冲测速入口，默认关闭：

```ini
-D ENCODER_PIN=-1
-D ENCODER_PULSES_PER_REV=0
```

需要另行确认适合电机的编码器型号、供电电压、输出电路和分辨率后再启用，GPIO15 可作为候选输入。**EC11 本版不接入此接口。**

`ENCODER_PULSES_PER_REV` 指被测轴转一圈时 **A 相上升沿数量**，不是 A/B 相四倍频计数。如果编码器装在减速器前的电机轴上，而要显示减速器输出轴 RPM，需要结合减速比换算；不能直接照抄商品中的 CPR 数字。

编码器供电电压与输出电平可能不同：5V 推挽输出必须通过合适电平转换后才能接 ESP32；开集电极／开漏输出能否用 3.3V 上拉，需按其资料确认。不要将未知编码器信号直接接 GPIO。此预留模式只计转速大小，方向仍来自控制指令，不做闭环恒速控制。

## 7. 验证

```sh
npm test
pio run
```

自动测试覆盖协议、连接时序、停止与页面生命周期；编译检查当前固件依赖。真机还需依次验收：上电无输出、连接无输出、低 PWM 空载运行、停止、正反转过渡、运行中断开／切后台、重新连接不自动启动、OLED 与手机反馈一致。低 PWM 时电机可能无法克服静摩擦，不能仅凭显示值判断是否转动。

C++ 编译期测试直接运行固件的控制模型，覆盖全部 10,000 组同向速度调整、换向停顿、停机后快速反向启动、计时回绕和保活超时。安装上述 PlatformIO 工具链后，在本目录执行：

```powershell
& "$env:USERPROFILE\.platformio\packages\toolchain-xtensa-esp-elf\bin\xtensa-esp32s3-elf-g++.exe" -std=c++17 -Wall -Wextra -Werror -fsyntax-only -I include tests/motor_protocol_test.cpp tests/motor_runtime_test.cpp
```

这些检查不替代微信开发者工具的 WXML 编译或手机与硬件联调。

当前本机验证：小程序 26 项自动测试通过；两个 C++ 测试文件的编译期断言全部通过；`pio run` 编译成功。尚未烧录或进行手机与电机真机联调。

BLE 连接与隐私交互复用本地 `esp32-s3-ble-servo-oled` 项目代码，保留 MIT `LICENSE`。U8g2 与字库按各自许可证使用。微信接口参考：[BLE 写入](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html)、[BLE Notify](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.notifyBLECharacteristicValueChange.html)。
