const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const { status } = require('./support');

test('run, stop and non-starting keepalive encode to six bytes', () => {
  assert.deepEqual(Array.from(p.command(1, 1, 1, 1)), [0xA5, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(p.command(255, 1, 100, 2)), [0xA5, 1, 255, 1, 100, 2]);
  assert.deepEqual(Array.from(p.command(2, 2)), [0xA5, 1, 2, 2, 0, 0]);
  assert.deepEqual(Array.from(p.command(3, 3)), [0xA5, 1, 3, 3, 0, 0]);
});
test('invalid commands never become wire packets', () => {
  for (const sequence of [0, 256, -1, 1.5, '1']) assert.throws(() => p.command(sequence, 1, 30, 1));
  for (const speed of [0, 101, -1, 2.5, NaN, Infinity, '30']) assert.throws(() => p.command(1, 1, speed, 1));
  for (const dir of [0, 3, 1.5, '1']) assert.throws(() => p.command(1, 1, 30, dir));
  for (const op of [2, 3]) {
    assert.throws(() => p.command(1, op, 1, 0));
    assert.throws(() => p.command(1, op, 0, 1));
  }
  assert.throws(() => p.command(1, 4));
});
test('status distinguishes PWM commands from optional measured RPM', () => {
  const stopped = p.decode(status()).state;
  assert.equal(stopped.running, false);
  assert.equal(stopped.rpm, null);
  assert.equal(stopped.encoderConfigured, false);
  const moving = p.decode(status({ targetSpeed: 70, outputSpeed: 40, targetDir: 2, outputDir: 1,
    encoderMode: 1, pulsesPerRev: 330, rpm: 1234, sequence: 9, op: 1 }));
  assert.equal(moving.sequence, 9);
  assert.equal(moving.state.transitioning, true);
  assert.equal(moving.state.rpm, 1234);
  assert.equal(moving.state.encoderConfigured, true);
  assert.equal(moving.state.pulsesPerRev, 330);
});
test('truncated, incompatible and internally inconsistent status is rejected', () => {
  for (const frame of [null, new Uint8Array(20), new ArrayBuffer(19), new ArrayBuffer(21)]) assert.throws(() => p.decode(frame));
  for (const patch of [{ magic: 0 }, { version: 2 }, { op: 1 }, { sequence: 1 }, { result: 1 },
    { sequence: 1, op: 4 }, { sequence: 1, op: 1, result: 4 }, { flags: 32 },
    { targetSpeed: 101, targetDir: 1 }, { outputSpeed: 101, outputDir: 1 },
    { targetSpeed: 1, targetDir: 0 }, { outputSpeed: 1, outputDir: 0 }, { targetDir: 1 },
    { flags: 7 }, { flags: 11 }, { pwmReady: false, targetSpeed: 1, targetDir: 1 },
    { encoderMode: 2 }, { encoderMode: 1, pulsesPerRev: 0 }, { pulsesPerRev: 1 },
    { rpm: 0 }, { pwmHz: 0 }, { leaseMs: 0 }, { reason: 5 }]) {
    assert.throws(() => p.decode(status(patch)), JSON.stringify(patch));
  }
});
test('matching error results remain available to the BLE exchange', () => {
  for (let result = 1; result <= 3; result++) assert.equal(p.decode(status({ sequence: 1, op: 1, result })).result, result);
});
