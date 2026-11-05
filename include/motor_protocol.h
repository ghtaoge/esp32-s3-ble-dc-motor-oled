#pragma once
#include <stddef.h>
#include <stdint.h>

namespace motor {
constexpr uint8_t Version = 1;
constexpr size_t CommandSize = 6, StatusSize = 20;
constexpr uint16_t PwmHz = 20000, UnavailableRpm = 65535;
enum Operation : uint8_t { Run = 1, Stop = 2, Keepalive = 3 };
enum Result : uint8_t { Ok = 0, BadFrame = 1, BadRange = 2, PwmError = 3 };
struct Command { uint8_t sequence = 0, op = 0, speed = 0, direction = 0; };
constexpr void write16(uint8_t* bytes, uint16_t value) { bytes[0] = value; bytes[1] = value >> 8; }
constexpr Result decode(const uint8_t* bytes, size_t size, Command& cmd) {
  if (!bytes || size != CommandSize || bytes[0] != 0xA5 || bytes[1] != Version || !bytes[2]) return BadFrame;
  cmd = {bytes[2], bytes[3], bytes[4], bytes[5]};
  if (cmd.op < Run || cmd.op > Keepalive) return BadFrame;
  if (cmd.op == Run) return cmd.speed >= 1 && cmd.speed <= 100 && (cmd.direction == 1 || cmd.direction == 2) ? Ok : BadRange;
  return cmd.speed == 0 && cmd.direction == 0 ? Ok : BadRange;
}
// A-rising pulses per measured shaft revolution; 0xFFFF means unconfigured.
constexpr uint16_t rpmFor(uint32_t pulses, uint32_t elapsedMs, uint16_t pulsesPerRev) {
  if (!elapsedMs || !pulsesPerRev) return UnavailableRpm;
  const uint64_t denominator = uint64_t(elapsedMs) * pulsesPerRev;
  const uint64_t rpm = (uint64_t(pulses) * 60000 + denominator / 2) / denominator;
  return rpm > 65534 ? 65534 : uint16_t(rpm);
}
}
