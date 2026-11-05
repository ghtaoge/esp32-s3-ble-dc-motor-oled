#pragma once
#include <stddef.h>
#include <stdint.h>

namespace motor {
constexpr uint32_t LeaseMs = 1500, StepMs = 20, ReverseHoldMs = 300;
constexpr uint8_t StepPercent = 2;

// This model describes commanded PWM, not measured mechanical speed or motion.
// All deadlines use elapsed unsigned milliseconds so millis() wrap is harmless.
class Runtime {
 public:
  uint8_t targetSpeed = 0, outputSpeed = 0, targetDir = 0, outputDir = 0;
  uint8_t reason = 0;

  // The protocol decoder has already validated speed=1..100, direction=1..2.
  constexpr void run(uint8_t speed, uint8_t direction, uint32_t now) {
    if (!targetSpeed) stepAt_ = now;
    targetSpeed = speed;
    targetDir = direction;
    reason = 0;
    lastLeaseAt_ = now;
  }

  // A heartbeat only renews the lease. It never restores an earlier command.
  constexpr void keepalive(uint32_t now) { lastLeaseAt_ = now; }

  // Stop is immediate; do not ramp a lost connection down. Preserve a real
  // coast interval even if Stop and an opposite Run arrive between two ticks.
  constexpr void stop(uint8_t stopReason, uint32_t now) {
    if (outputSpeed) {
      lastDrivenDir_ = outputDir;
      coastAt_ = now;
    }
    targetSpeed = outputSpeed = targetDir = outputDir = 0;
    reason = stopReason;
  }

  constexpr bool transitioning() const {
    return targetSpeed != outputSpeed || targetDir != outputDir;
  }

  // Returns whether the externally visible output/stop state changed. This
  // performs at most one 2% step even after a delayed task, avoiding catch-up
  // jumps. Lease expiry takes priority over the PWM step deadline.
  constexpr bool tick(uint32_t now) {
    if (targetSpeed && uint32_t(now - lastLeaseAt_) >= LeaseMs) {
      stop(3, now);
      return true;
    }
    if (!targetSpeed || uint32_t(now - stepAt_) < StepMs) return false;
    stepAt_ = now;

    if (outputSpeed && outputDir != targetDir) {
      outputSpeed = outputSpeed > StepPercent ? outputSpeed - StepPercent : 0;
      if (!outputSpeed) {
        lastDrivenDir_ = outputDir;
        outputDir = 0;
        coastAt_ = now;
      }
      return true;
    }

    if (!outputSpeed) {
      if (lastDrivenDir_ && lastDrivenDir_ != targetDir &&
          uint32_t(now - coastAt_) < ReverseHoldMs) return false;
      outputDir = lastDrivenDir_ = targetDir;
      outputSpeed = targetSpeed < StepPercent ? targetSpeed : StepPercent;
      return true;
    }

    const uint8_t previous = outputSpeed;
    if (outputSpeed < targetSpeed) {
      outputSpeed = targetSpeed - outputSpeed <= StepPercent ? targetSpeed : outputSpeed + StepPercent;
    } else if (outputSpeed > targetSpeed) {
      outputSpeed = outputSpeed - targetSpeed <= StepPercent ? targetSpeed : outputSpeed - StepPercent;
    }
    return outputSpeed != previous;
  }

 private:
  uint32_t lastLeaseAt_ = 0, stepAt_ = 0, coastAt_ = 0;
  uint8_t lastDrivenDir_ = 0;
};

// One atomic token carries both connection state and generation. A fast
// disconnect/reconnect still invalidates every command from the previous link.
constexpr bool linkConnected(uint32_t token) { return token & 1U; }
constexpr uint32_t nextLink(uint32_t token, bool connected) {
  return ((token + 2U) & ~1U) | uint32_t(connected);
}

struct TileSpan { uint8_t first = 0, count = 0; };
// SSD1306 R0 full-buffer layout: 16 tiles per 128-byte row, 8 bytes per tile.
constexpr TileSpan changedTiles(const uint8_t* frame, const uint8_t* previous) {
  TileSpan span;
  for (uint8_t tile = 0; tile < 16; ++tile) {
    for (uint8_t byte = 0; byte < 8; ++byte) {
      const size_t offset = size_t(tile) * 8 + byte;
      if (frame[offset] == previous[offset]) continue;
      if (!span.count) span.first = tile;
      span.count = tile - span.first + 1;
      break;
    }
  }
  return span;
}
}
