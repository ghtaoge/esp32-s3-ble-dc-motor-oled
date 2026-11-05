const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const initial = { oledReady: true, pwmReady: true, running: false, transitioning: false,
  encoderConfigured: false, encoderMode: 0, targetSpeed: 0, outputSpeed: 0, targetDir: 0, outputDir: 0,
  reason: 0, pwmHz: 20000, leaseMs: 1500, rpm: null, pulsesPerRev: 0 };
function fakeClock() {
  let next = 0;
  const timers = new Map();
  return { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}
function fixture() {
  let definition, privacy;
  const updates = [], clock = fakeClock();
  class FakeClient {
    constructor(events) { this.events = events; this.runs = []; this.stops = 0; this.disconnects = 0; }
    async scan() {}
    async stopScan() {}
    async connect(device) { this.ready = true; this.events.onState(initial); this.events.onConnection(true, device); }
    async disconnect() { this.ready = false; this.disconnects++; }
    async destroy() { this.ready = false; this.destroyed = true; }
    async run(speed, direction) {
      this.runs.push({ speed, direction });
      const state = { ...initial, targetSpeed: speed, outputSpeed: speed, targetDir: direction, outputDir: direction, running: true };
      this.events.onState(state); return state;
    }
    async stop() { this.stops++; this.events.onState({ ...initial, reason: 1 }); return initial; }
  }
  const wx = { onNeedPrivacyAuthorization(fn) { privacy = fn; }, offNeedPrivacyAuthorization() {},
    getPrivacySetting(args) { args.success({ privacyContractName: '《测试隐私指引》' }); } };
  const context = { Page(def) { definition = def; },
    require() { return { MotorClient: FakeClient, message: error => error.message }; },
    wx, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, console, Set };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../pages/index/index.js'), 'utf8'), context);
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { updates.push({ ...patch }); Object.assign(this.data, patch); } };
  page.onLoad(); page.onShow();
  return { page, client: page.client, updates, clock, privacy: resolve => privacy(resolve) };
}
async function connect(page) {
  page.setData({ devices: [{ deviceId: 'board', name: 'S3-MOTOR-TEST' }] });
  await page.connect({ currentTarget: { dataset: { id: 'board' } } });
}

test('connection only reads status; draft changes require explicit Start', async () => {
  const { page, client, clock } = fixture();
  try {
    await connect(page);
    page.previewSpeed({ detail: { value: 40 } }); clock.flush();
    page.changeSpeed({ detail: { value: 45 } });
    page.selectDirection({ currentTarget: { dataset: { direction: '2' } } });
    assert.equal(page.data.speed, 45);
    assert.equal(page.data.direction, 2);
    assert.deepEqual(client.runs, []);
    assert.equal(page.data.outputSpeed, 0);
    await page.run();
    assert.deepEqual(client.runs, [{ speed: 45, direction: 2 }]);
    assert.equal(page.data.outputSpeed, 45);
  } finally { page.onUnload(); }
});
test('telemetry updates actual PWM without overwriting staged settings or claiming RPM', async () => {
  const { page, client } = fixture();
  try {
    await connect(page);
    page.changeSpeed({ detail: { value: 60 } });
    client.events.onState({ ...initial, targetSpeed: 20, outputSpeed: 10, targetDir: 1, outputDir: 1, running: true, transitioning: true });
    assert.equal(page.data.speed, 60);
    assert.equal(page.data.outputSpeed, 10);
    assert.equal(page.data.rpm, null);
    assert.match(page.data.rpmText, /未接|未配置/);
    client.events.onState({ ...initial, encoderConfigured: true, encoderMode: 1, pulsesPerRev: 330, rpm: 120 });
    assert.equal(page.data.rpmText, '120 RPM');
  } finally { page.onUnload(); }
});
test('Stop remains callable while Run is waiting and its old result cannot overwrite Stop', async () => {
  const { page, client } = fixture();
  let complete;
  try {
    await connect(page);
    client.run = () => new Promise(resolve => { complete = resolve; });
    const run = page.run();
    assert.equal(page.data.sending, true);
    await page.stop();
    assert.equal(client.stops, 1);
    assert.equal(page.data.outputSpeed, 0);
    assert.match(page.data.syncText, /确认停止/);
    complete({ ...initial, targetSpeed: 30, outputSpeed: 30 }); await run;
    assert.match(page.data.syncText, /确认停止/);
    assert.equal(page.data.sending, false);
  } finally { page.onUnload(); }
});
test('hiding during pending Run disconnects immediately and returning does not resume', async () => {
  const { page, client, clock } = fixture();
  let complete;
  try {
    await connect(page);
    client.run = () => new Promise(resolve => { complete = resolve; });
    const run = page.run();
    page.onHide();
    assert.equal(client.disconnects, 1);
    assert.equal(page.data.connected, false);
    client.events.onState({ ...initial, targetSpeed: 90, outputSpeed: 90 });
    complete(initial); await run;
    page.onShow(); clock.flush();
    assert.equal(page.data.connected, false);
    assert.equal(page.data.outputSpeed, 0);
    assert.equal(page.data.sending, false);
    assert.equal(client.runs.length, 0);
  } finally { page.onUnload(); }
});
test('an old result after reconnect cannot change the new connection', async () => {
  const { page, client } = fixture();
  let complete;
  try {
    await connect(page);
    client.run = () => new Promise(resolve => { complete = resolve; });
    const run = page.run();
    client.events.onConnection(false);
    await connect(page);
    complete(initial); await run;
    assert.equal(page.data.connected, true);
    assert.equal(page.data.outputSpeed, 0);
    assert.equal(page.data.syncText, '');
  } finally { page.onUnload(); }
});
test('hidden late connection is closed rather than enabled', async () => {
  const { page, client } = fixture();
  try {
    page.onHide();
    client.events.onConnection(true, { name: 'late' });
    assert.equal(client.disconnects, 2);
    assert.equal(page.data.connected, false);
  } finally { page.onUnload(); }
});
test('privacy waits for native agreement and resolves each request once', () => {
  const { page, privacy } = fixture();
  const results = [];
  try {
    privacy(result => results.push(result)); privacy(result => results.push(result));
    page.preparePrivacyAgree();
    assert.equal(results.length, 0);
    assert.equal(page.data.privacyName, '《测试隐私指引》');
    page.agreePrivacy(); page.agreePrivacy();
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.event === 'agree' && r.buttonId === 'agree-privacy'));
    assert.equal(page.data.showPrivacy, false);
  } finally { page.onUnload(); }
});
test('unload destroys client, rejects privacy and ignores late telemetry', () => {
  const { page, client, privacy } = fixture();
  const results = [];
  privacy(result => results.push(result));
  page.onUnload();
  const snapshot = JSON.stringify(page.data);
  client.events.onState({ ...initial, outputSpeed: 50 });
  client.events.onConnection(true, { name: 'late' });
  assert.equal(JSON.stringify(page.data), snapshot);
  assert.equal(client.destroyed, true);
  assert.equal(results[0].event, 'disagree');
});
