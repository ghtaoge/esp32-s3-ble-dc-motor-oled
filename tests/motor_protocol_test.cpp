#include "motor_protocol.h"

constexpr bool frameChecks() {
  motor::Command cmd;
  uint8_t frame[] = {0xA5, 1, 1, motor::Run, 1, 1};
  if (motor::decode(frame, 6, cmd) != motor::Ok || cmd.speed != 1 || cmd.direction != 1) return false;
  for (unsigned speed = 0; speed < 256; ++speed) {
    for (unsigned dir = 0; dir < 256; ++dir) {
      frame[4] = speed; frame[5] = dir;
      const bool expected = speed >= 1 && speed <= 100 && (dir == 1 || dir == 2);
      if ((motor::decode(frame, 6, cmd) == motor::Ok) != expected) return false;
    }
  }
  frame[3] = motor::Stop; frame[4] = frame[5] = 0;
  if (motor::decode(frame, 6, cmd) != motor::Ok) return false;
  frame[3] = motor::Keepalive;
  if (motor::decode(frame, 6, cmd) != motor::Ok) return false;
  frame[4] = 1;
  if (motor::decode(frame, 6, cmd) != motor::BadRange) return false;
  frame[3] = 4;
  if (motor::decode(frame, 6, cmd) != motor::BadFrame) return false;
  frame[3] = motor::Run; frame[2] = 0;
  if (motor::decode(frame, 6, cmd) != motor::BadFrame) return false;
  if (motor::decode(nullptr, 6, cmd) != motor::BadFrame || motor::decode(frame, 5, cmd) != motor::BadFrame) return false;
  return true;
}
static_assert(frameChecks(), "Command envelope and exhaustive range validation");
static_assert(motor::rpmFor(20, 1000, 20) == 60, "One shaft turn per second");
static_assert(motor::rpmFor(0, 500, 20) == 0, "Stationary configured sensor");
static_assert(motor::rpmFor(1, 1000, 0) == 65535, "Unconfigured sensor is not zero RPM");
static_assert(motor::rpmFor(1000000, 1, 1) == 65534, "Overflow-safe saturation");
