// These static assertions execute the production model during C++17
// compilation; no copied state machine, ESP32 board or RTOS simulator is used.
#include "motor_runtime.h"

namespace {
using motor::Runtime;

constexpr bool stopped(const Runtime& state) {
  return !state.targetSpeed && !state.outputSpeed && !state.targetDir &&
         !state.outputDir && !state.transitioning();
}

constexpr bool safeBootAndHeartbeat() {
  Runtime state;
  if (!stopped(state) || state.reason) return false;
  for (uint32_t now = 0; now < 10000; now += 10) {
    state.keepalive(now);
    if (state.tick(now) || !stopped(state)) return false;
  }
  return true;
}

constexpr bool allSpeedsRampWithoutOvershoot() {
  for (uint8_t direction = 1; direction <= 2; ++direction) {
    for (uint8_t speed = 1; speed <= 100; ++speed) {
      Runtime state;
      state.run(speed, direction, 100);
      if (state.outputSpeed || state.outputDir || !state.transitioning()) return false;
      if (state.tick(119) || state.outputSpeed) return false;
      for (uint32_t step = 1; step <= 50; ++step) {
        const auto previous = state.outputSpeed;
        state.tick(100 + step * motor::StepMs);
        const auto expected = step * motor::StepPercent < speed ? step * motor::StepPercent : speed;
        if (state.outputSpeed != expected || state.outputDir != direction ||
            state.outputSpeed < previous || state.outputSpeed - previous > motor::StepPercent ||
            state.targetSpeed != speed || state.targetDir != direction || state.reason) return false;
      }
      if (state.transitioning() || state.tick(1120)) return false;
    }
  }
  return true;
}

constexpr bool everyPairOfSameDirectionTargetsIsBounded(uint8_t firstBegin, uint8_t firstEnd) {
  for (uint8_t first = firstBegin; first <= firstEnd; ++first) {
    Runtime settled;
    settled.run(first, 1, 0);
    for (uint32_t now = 20; now <= 1000; now += 20) settled.tick(now);
    for (uint8_t second = 1; second <= 100; ++second) {
      Runtime state = settled;
      state.run(second, 1, 1000);
      for (uint32_t now = 1020; now <= 2000; now += 20) {
        const auto previous = state.outputSpeed;
        state.tick(now);
        const int delta = int(state.outputSpeed) - previous;
        if (delta < -motor::StepPercent || delta > motor::StepPercent || state.outputDir != 1 ||
            state.outputSpeed < (first < second ? first : second) ||
            state.outputSpeed > (first > second ? first : second)) return false;
      }
      if (state.outputSpeed != second || state.transitioning()) return false;
    }
  }
  return true;
}

constexpr bool targetUpdatesDoNotPostponeSteps() {
  Runtime state;
  state.run(100, 1, 100);
  for (uint32_t now = 101; now <= 1120; ++now) {
    state.run(100, 1, now);
    state.tick(now);
    const auto steps = (now - 100) / 20;
    const auto expected = steps < 50 ? steps * 2 : 100;
    if (state.outputSpeed != expected) return false;
  }
  return state.outputSpeed == 100 && !state.transitioning();
}

constexpr bool everySpeedReversesOnlyAfterCoast() {
  for (uint8_t direction = 1; direction <= 2; ++direction) {
    for (uint8_t speed = 1; speed <= 100; ++speed) {
      Runtime state;
      state.run(speed, direction, 0);
      for (uint32_t now = 20; now <= 1000; now += 20) state.tick(now);
      const uint8_t opposite = direction == 1 ? 2 : 1;
      state.run(speed, opposite, 1000);
      uint32_t coastAt = 0;
      for (uint32_t now = 1020; now <= 3300; now += 20) {
        // Renew only the lease, never replace the reversal request.
        if (now % 400 == 0) state.keepalive(now);
        const auto previous = state.outputSpeed;
        const auto previousDir = state.outputDir;
        state.tick(now);
        if (previous && !state.outputSpeed) coastAt = now;
        if (!coastAt) {
          if (state.outputDir != direction || state.outputSpeed >= previous ||
              previous - state.outputSpeed > motor::StepPercent) return false;
        } else if (now - coastAt < motor::ReverseHoldMs) {
          if (state.outputSpeed || state.outputDir) return false;
        } else {
          if (!state.outputSpeed || state.outputDir != opposite ||
              (previousDir && previousDir != opposite) || state.outputSpeed > speed) return false;
        }
      }
      if (!coastAt || state.outputSpeed != speed || state.outputDir != opposite || state.transitioning()) return false;
    }
  }
  return true;
}

constexpr bool stopIsImmediateAndHeartbeatCannotRestart() {
  for (uint8_t direction = 1; direction <= 2; ++direction) {
    Runtime state;
    state.run(100, direction, 0);
    for (uint32_t now = 20; now <= 500; now += 20) state.tick(now);
    if (state.outputSpeed != 50) return false;
    state.stop(1, 501);
    if (!stopped(state) || state.reason != 1) return false;
    for (uint32_t now = 502; now <= 4000; ++now) {
      state.keepalive(now);
      if (state.tick(now) || !stopped(state) || state.reason != 1) return false;
    }
  }
  return true;
}

constexpr bool stopThenOppositeRunKeepsCoastDeadline() {
  Runtime state;
  state.run(20, 1, 0);
  for (uint32_t now = 20; now <= 200; now += 20) state.tick(now);
  state.stop(1, 201);
  state.stop(1, 250); // Repeated Stop must not extend the original coast time.
  state.run(20, 2, 281);
  for (uint32_t now = 301; now < 501; now += 20) {
    if (state.tick(now) || state.outputSpeed || state.outputDir) return false;
  }
  return state.tick(501) && state.outputSpeed == 2 && state.outputDir == 2;
}

constexpr bool sameDirectionRestartDoesNotWaitForReverseHold() {
  Runtime state;
  state.run(20, 1, 0);
  state.tick(20);
  state.stop(1, 21);
  state.run(20, 1, 22);
  return !state.tick(41) && state.tick(42) && state.outputSpeed == 2 && state.outputDir == 1;
}

constexpr bool leaseExpiresBeforeStepDeadline() {
  constexpr uint32_t starts[] = {0U, 123456U, 0xFFFFFFF0U, 0xFFFFFFFFU};
  for (auto start : starts) {
    Runtime state;
    state.run(50, 1, start);
    state.tick(start + 20);
    // This also makes the next ramp step due only after the lease has expired.
    state.tick(start + motor::LeaseMs - 1);
    if (!state.outputSpeed || state.reason) return false;
    if (!state.tick(start + motor::LeaseMs) || !stopped(state) || state.reason != 3) return false;
    state.keepalive(start + motor::LeaseMs + 1);
    if (state.tick(start + motor::LeaseMs + 20) || !stopped(state)) return false;
  }
  return true;
}

constexpr bool heartbeatExtendsOnlyTheCurrentRun() {
  Runtime state;
  state.run(30, 1, 0);
  state.tick(20);
  state.keepalive(1499);
  state.tick(1500);
  if (!state.targetSpeed || state.reason) return false;
  state.tick(2998);
  if (!state.targetSpeed || state.reason) return false;
  return state.tick(2999) && stopped(state) && state.reason == 3;
}

constexpr bool reversalCancellationUsesLatestTarget() {
  Runtime state;
  state.run(20, 1, 0);
  for (uint32_t now = 20; now <= 200; now += 20) state.tick(now);
  state.run(100, 2, 200);
  for (uint32_t now = 220; now <= 300; now += 20) state.tick(now);
  if (state.outputSpeed != 10 || state.outputDir != 1) return false;
  state.run(14, 1, 301); // Return to the direction still physically commanded.
  state.tick(320);
  if (state.outputSpeed != 12 || state.outputDir != 1) return false;
  state.tick(340);
  if (state.outputSpeed != 14 || state.transitioning()) return false;
  state.run(14, 2, 341);
  for (uint32_t now = 360; now <= 480; now += 20) state.tick(now);
  if (state.outputSpeed || state.outputDir || !state.transitioning()) return false;
  state.run(9, 1, 481); // Cancellation during coast can resume the last direction.
  state.tick(500);
  return state.outputSpeed == 2 && state.outputDir == 1 && state.targetSpeed == 9;
}

constexpr bool stopDuringReversalCannotLeaveDeferredMotion() {
  Runtime state;
  state.run(10, 1, 0);
  for (uint32_t now = 20; now <= 100; now += 20) state.tick(now);
  state.run(100, 2, 100);
  for (uint32_t now = 120; now <= 200; now += 20) state.tick(now);
  if (state.outputSpeed || !state.transitioning()) return false;
  state.stop(2, 250);
  for (uint32_t now = 251; now <= 2000; ++now) {
    state.keepalive(now);
    if (state.tick(now) || !stopped(state) || state.reason != 2) return false;
  }
  return true;
}

constexpr bool stepAndCoastWorkAcrossClockWrap() {
  constexpr uint32_t starts[] = {0U, 0xFFFFFFF0U, 0xFFFFFF00U, 0xFFFFFFFFU};
  for (auto start : starts) {
    Runtime state;
    state.run(2, 1, start);
    if (state.tick(start + 19) || !state.tick(start + 20)) return false;
    state.run(2, 2, start + 21);
    if (!state.tick(start + 40) || state.outputSpeed || state.outputDir) return false;
    for (uint32_t elapsed = 60; elapsed < 340; elapsed += 20) {
      if (state.tick(start + elapsed) || state.outputSpeed || state.outputDir) return false;
    }
    if (!state.tick(start + 340) || state.outputSpeed != 2 || state.outputDir != 2) return false;
  }
  return true;
}

constexpr bool aDelayedTaskNeverCatchesUpInOneJump() {
  Runtime state;
  state.run(100, 1, 0);
  if (!state.tick(1000) || state.outputSpeed != 2) return false;
  if (state.tick(1001) || state.outputSpeed != 2) return false;
  return state.tick(1020) && state.outputSpeed == 4;
}

constexpr bool linkGenerationsInvalidateQueuedWork() {
  uint32_t token = 0;
  for (uint32_t generation = 1; generation <= 1000; ++generation) {
    const bool connected = generation & 1U;
    const auto next = motor::nextLink(token, connected);
    if (next == token || motor::linkConnected(next) != connected || (next & ~1U) != generation * 2U) return false;
    token = next;
  }
  return motor::nextLink(0xFFFFFFFFU, false) == 0 &&
         motor::nextLink(0xFFFFFFFEU, true) == 1;
}

constexpr bool changedDisplaySpansAreBounded() {
  uint8_t frame[130] = {}, previous[130] = {};
  frame[0] = frame[129] = 1; // Adjacent rows must be ignored.
  if (motor::changedTiles(frame + 1, previous + 1).count) return false;
  for (size_t byte = 0; byte < 128; ++byte) {
    frame[byte + 1] = 1;
    const auto span = motor::changedTiles(frame + 1, previous + 1);
    if (span.first != byte / 8 || span.count != 1) return false;
    frame[byte + 1] = 0;
  }
  frame[2 * 8 + 1] = frame[12 * 8 + 1] = 1;
  const auto span = motor::changedTiles(frame + 1, previous + 1);
  return span.first == 2 && span.count == 11;
}

static_assert(safeBootAndHeartbeat(), "Boot and idle heartbeats must never drive the motor");
static_assert(allSpeedsRampWithoutOvershoot(), "Every speed and both directions must ramp within 2% per tick");
// Partition exhaustive target pairs to stay within normal constexpr evaluator
// limits, with no special compiler flags needed.
static_assert(everyPairOfSameDirectionTargetsIsBounded(1, 10), "Speed target pairs 1..10 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(11, 20), "Speed target pairs 11..20 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(21, 30), "Speed target pairs 21..30 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(31, 40), "Speed target pairs 31..40 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(41, 50), "Speed target pairs 41..50 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(51, 60), "Speed target pairs 51..60 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(61, 70), "Speed target pairs 61..70 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(71, 80), "Speed target pairs 71..80 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(81, 90), "Speed target pairs 81..90 x 1..100 must stay bounded");
static_assert(everyPairOfSameDirectionTargetsIsBounded(91, 100), "Speed target pairs 91..100 x 1..100 must stay bounded");
static_assert(targetUpdatesDoNotPostponeSteps(), "Frequent commands must not starve a due control tick");
static_assert(everySpeedReversesOnlyAfterCoast(), "Reversal must ramp to zero and coast at least 300ms");
static_assert(stopIsImmediateAndHeartbeatCannotRestart(), "Stop immediately clears all movement and heartbeats cannot restore it");
static_assert(stopThenOppositeRunKeepsCoastDeadline(), "Quick Stop/Run must preserve the original reverse coast deadline");
static_assert(sameDirectionRestartDoesNotWaitForReverseHold(), "Same-direction restart can ramp on its next 20ms tick");
static_assert(leaseExpiresBeforeStepDeadline(), "Lease expiry must stop at 1500ms even before a due PWM tick and across wrap");
static_assert(heartbeatExtendsOnlyTheCurrentRun(), "Keepalive renews only the current lease");
static_assert(reversalCancellationUsesLatestTarget(), "Changing targets during ramp or coast must not execute a stale direction");
static_assert(stopDuringReversalCannotLeaveDeferredMotion(), "Stopping in coast must cancel all deferred movement");
static_assert(stepAndCoastWorkAcrossClockWrap(), "Both PWM and coast deadlines must survive millis wrap");
static_assert(aDelayedTaskNeverCatchesUpInOneJump(), "A late tick must never jump across multiple ramp steps");
static_assert(linkGenerationsInvalidateQueuedWork(), "Connection generations must invalidate old queued work, including wrap");
static_assert(changedDisplaySpansAreBounded(), "Display updates must remain within the current tile row");
}
