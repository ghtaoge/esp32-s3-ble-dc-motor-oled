const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const { MotorClient } = require('../utils/ble');
const { status } = require('./support');
const tick = () => new Promise(resolve => setImmediate(resolve));
const device = { deviceId: 'test-device', name: 'S3-MOTOR-TEST' };

function fixture() {
  let valueListener, connectionListener, foundListener;
  const f = { writes: [], reads: [], states: [], connections: [], closed: [], created: [], faults: [], found: [],
    board: {}, onWrite: null, onRead: null, onServices: null, onClose: null };
  f.emit = (patch = {}, extra = {}) => valueListener({ deviceId: device.deviceId, serviceId: p.SERVICE_UUID.toUpperCase(),
    characteristicId: p.STATUS_UUID.toUpperCase(), value: status({ ...f.board, ...patch }), ...extra });
  f.ack = (args, patch = {}) => {
    const frame = new Uint8Array(args.value);
    if (frame[3] === 1) f.board = { targetSpeed: frame[4], outputSpeed: frame[4], targetDir: frame[5], outputDir: frame[5] };
    if (frame[3] === 2) f.board = { targetSpeed: 0, outputSpeed: 0, targetDir: 0, outputDir: 0, reason: 1 };
    f.emit({ sequence: frame[2], op: frame[3], ...patch });
  };
  f.drop = () => connectionListener({ deviceId: device.deviceId, connected: false });
  const ok = args => args.success({});
  global.wx = {
    onBluetoothDeviceFound(fn) { foundListener = fn; }, offBluetoothDeviceFound() {},
    onBLECharacteristicValueChange(fn) { valueListener = fn; }, offBLECharacteristicValueChange() {},
    onBLEConnectionStateChange(fn) { connectionListener = fn; }, offBLEConnectionStateChange() {},
    authorize: ok, openBluetoothAdapter: ok, closeBluetoothAdapter: ok,
    startBluetoothDevicesDiscovery: ok, stopBluetoothDevicesDiscovery: ok,
    getBluetoothDevices(args) { args.success({ devices: [] }); },
    createBLEConnection(args) { f.created.push(args.deviceId); f.board = {}; ok(args); },
    closeBLEConnection(args) { f.closed.push(args.deviceId); if (f.onClose) f.onClose(args); else ok(args); },
    getBLEDeviceServices(args) {
      if (f.onServices) f.onServices(args); else args.success({ services: [{ uuid: p.SERVICE_UUID.toUpperCase() }] });
    },
    getBLEDeviceCharacteristics(args) { args.success({ characteristics: [
      { uuid: p.WRITE_UUID.toUpperCase(), properties: { write: true } },
      { uuid: p.STATUS_UUID.toUpperCase(), properties: { read: true, notify: true } }
    ] }); },
    notifyBLECharacteristicValueChange: ok,
    readBLECharacteristicValue(args) {
      f.reads.push(args);
      if (f.onRead) return f.onRead(args);
      ok(args); queueMicrotask(() => f.emit());
    },
    writeBLECharacteristicValue(args) {
      f.writes.push(args);
      if (f.onWrite) return f.onWrite(args);
      ok(args); queueMicrotask(() => f.ack(args));
    }
  };
  f.client = new MotorClient({ onDevice: d => f.found.push(d), onScanEnd() {},
    onState: state => f.states.push(state), onConnection: connected => f.connections.push(connected),
    onFault: error => f.faults.push(error) });
  f.discover = devices => foundListener({ devices });
  f.connect = () => f.client.connect(device);
  return f;
}

test('connect waits for actual characteristic event and never sends a RUN', async () => {
  const f = fixture();
  try {
    f.onRead = args => args.success({ value: status() });
    let done = false;
    const connected = f.connect().then(s => { done = true; return s; });
    while (!f.reads.length) await tick();
    await tick(); assert.equal(done, false);
    f.emit(); await connected;
    assert.equal(f.client.ready, true);
    assert.equal(f.writes.length, 0);
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('explicit RUN and idle STOP use separate acknowledged commands', async () => {
  const f = fixture();
  try {
    await f.connect();
    const running = await f.client.run(35, 2);
    assert.equal(running.outputSpeed, 35);
    assert.equal(running.outputDir, 2);
    const stopped = await f.client.stop();
    assert.equal(stopped.outputSpeed, 0);
    assert.deepEqual(f.writes.map(w => [...new Uint8Array(w.value)]), [[0xA5, 1, 1, 1, 35, 2], [0xA5, 1, 2, 2, 0, 0]]);
    assert.equal(f.client.ready, true);
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('STOP during a pending RUN closes immediately and discards queued RUNs', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const runs = Promise.allSettled([f.client.run(20, 1), f.client.run(80, 2)]);
    await tick();
    const stopping = f.client.stop();
    assert.equal(f.client.ready, false);
    assert.equal(f.closed.length, 1);
    await stopping;
    assert.ok((await runs).every(r => r.status === 'rejected'));
    assert.equal(f.writes.length, 1);
    f.ack(f.writes[0]);
    f.onWrite = null;
    await f.connect();
    assert.equal(f.writes.length, 1, 'reconnect cannot replay an old RUN');
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('ACK before native success is retained but does not finish the RUN early', async () => {
  const f = fixture();
  try {
    await f.connect();
    let write, finished = false;
    f.onWrite = args => { write = args; f.ack(args); };
    const run = f.client.run(50, 1).then(s => { finished = true; return s; });
    await tick(); assert.equal(finished, false);
    assert.equal(f.client.heartbeatTimer, null);
    write.success({});
    assert.equal((await run).targetSpeed, 50);
    assert.ok(f.client.heartbeatTimer);
  } finally { await f.client.destroy(); }
});
test('sequence-zero telemetry and unrelated events cannot acknowledge a RUN', async () => {
  const f = fixture();
  try {
    await f.connect(); f.onWrite = args => args.success({});
    let finished = false;
    const run = f.client.run(40, 1).then(s => { finished = true; return s; });
    await tick();
    f.emit({ targetSpeed: 40, targetDir: 1 });
    f.emit({ sequence: 255, op: 1, targetSpeed: 40, targetDir: 1 });
    f.emit({}, { deviceId: 'another', value: new ArrayBuffer(1) });
    f.emit({}, { serviceId: 'another', value: new ArrayBuffer(1) });
    await tick(); assert.equal(finished, false);
    f.ack(f.writes[0]); await run;
  } finally { await f.client.destroy(); }
});
test('keepalive starts only after RUN and has at most one unfinished exchange', async t => {
  const f = fixture();
  try {
    await f.connect(); t.mock.timers.enable({ apis: ['setTimeout'] });
    await f.client.run(30, 1);
    f.onWrite = args => args.success({});
    t.mock.timers.tick(400); await tick();
    assert.equal(f.writes.length, 2);
    assert.deepEqual([...new Uint8Array(f.writes[1].value)].slice(3), [3, 0, 0]);
    t.mock.timers.tick(1200); await tick();
    assert.equal(f.writes.length, 2, 'no interval queue accumulates while awaiting ACK');
    f.ack(f.writes[1]); await tick();
    t.mock.timers.tick(400); await tick();
    assert.equal(f.writes.length, 3);
  } finally { await f.client.destroy(); }
});
test('keepalive failure drops the link and cannot restart after reconnect', async t => {
  const f = fixture();
  try {
    await f.connect(); t.mock.timers.enable({ apis: ['setTimeout'] });
    await f.client.run(30, 1);
    f.onWrite = args => args.fail({ errCode: 10008, errMsg: 'failed' });
    t.mock.timers.tick(400); await tick();
    assert.equal(f.client.ready, false);
    assert.equal(f.closed.length, 1);
    assert.equal(f.faults.length, 1);
    t.mock.timers.tick(5000); await tick();
    assert.equal(f.writes.length, 2);
    // Disable mocked timers before connect's deliberate 250ms discovery pause.
    t.mock.timers.reset(); f.onWrite = null;
    await f.connect();
    assert.equal(f.writes.length, 2);
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('late native success after firmware timeout does not arm a heartbeat', async () => {
  const f = fixture();
  try {
    await f.connect(); let write;
    f.onWrite = args => { write = args; f.ack(args); };
    const run = f.client.run(30, 1);
    await tick();
    f.emit({ targetSpeed: 0, outputSpeed: 0, targetDir: 0, outputDir: 0, reason: 3 });
    write.success({}); await run;
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('a missing native callback after ACK is bounded and drops the link', async t => {
  const f = fixture();
  try {
    await f.connect(); t.mock.timers.enable({ apis: ['setTimeout'] });
    f.onWrite = args => f.ack(args);
    const timedOut = assert.rejects(f.client.run(30, 1), /超时/);
    await tick(); t.mock.timers.tick(3500); await timedOut;
    assert.equal(f.client.ready, false);
    assert.equal(f.closed.length, 1);
  } finally { await f.client.destroy(); }
});
test('old write callbacks cannot revive control after disconnect and reconnect', async () => {
  const f = fixture();
  try {
    await f.connect(); let old;
    f.onWrite = args => { old = args; f.ack(args); };
    const previous = Promise.allSettled([f.client.run(30, 1)]);
    await tick(); await f.client.disconnect();
    assert.equal((await previous)[0].status, 'rejected');
    f.onWrite = null; await f.connect();
    old.success({}); await tick();
    assert.equal(f.client.heartbeatTimer, null);
    assert.equal(f.writes.length, 1);
  } finally { await f.client.destroy(); }
});
test('remote disconnect cancels a pending command and clears keepalive', async () => {
  const f = fixture();
  try {
    await f.connect(); await f.client.run(30, 1);
    f.onWrite = args => args.success({});
    const run = assert.rejects(f.client.run(40, 2));
    await tick(); f.drop(); await run;
    assert.equal(f.client.ready, false);
    assert.equal(f.client.heartbeatTimer, null);
    assert.equal(f.connections.at(-1), false);
  } finally { await f.client.destroy(); }
});
test('destroy cancels output immediately even when scan cleanup stalls', async () => {
  const f = fixture();
  try {
    await f.connect(); await f.client.run(30, 1);
    let scanStop;
    wx.stopBluetoothDevicesDiscovery = args => { scanStop = args; };
    const destroying = f.client.destroy();
    assert.equal(f.client.ready, false);
    assert.equal(f.closed.length, 1);
    await tick(); scanStop.success({}); await destroying;
    assert.equal(f.client.heartbeatTimer, null);
  } finally { await f.client.destroy(); }
});
test('discovery selects only the motor name or service', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    f.discover([{ deviceId: 'name', name: 'S3-MOTOR-1234' },
      { deviceId: 'service', advertisServiceUUIDs: [p.SERVICE_UUID] }, { deviceId: 'servo', name: 'S3-SERVO-1234' }]);
    assert.deepEqual(f.found.map(d => d.deviceId), ['name', 'service']);
  } finally { await f.client.destroy(); }
});
