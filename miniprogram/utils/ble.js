const protocol = require('./protocol');
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_QUEUED = 8;
function call(name, args = {}, timeout = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => { clearTimeout(timer); callback(value); };
    if (timeout) timer = setTimeout(() => reject(new Error('蓝牙操作超时，请检查连接后重试')), timeout);
    try {
      wx[name](Object.assign({}, args, {
        success: value => finish(resolve, value), fail: error => finish(reject, error)
      }));
    } catch (error) { finish(reject, error); }
  });
}
function message(error) {
  const code = error && error.errCode;
  if (code === 10001) return '请打开手机蓝牙后重试';
  if (code === 10008 || code === 10012) return '连接超时，请靠近开发板后重试';
  if (code === 10006) return '设备已断开，请重新连接';
  if (code === 10009) return '当前系统不支持低功耗蓝牙';
  if (code === 10003) return '连接失败，请确认开发板未被其他手机占用';
  if (code === 10016 || /auth|permission|privacy/i.test((error && error.errMsg) || '')) return '请允许微信使用蓝牙；部分安卓手机还需开启定位服务和附近设备权限';
  return (error && (error.message || error.errMsg)) || '操作失败，请稍后重试';
}

class MotorClient {
  constructor(events) {
    this.events = events;
    this.device = null;
    this.session = null;
    this.ready = false;
    this.sequence = 0;
    this.chain = Promise.resolve();
    this.queued = 0;
    this.discoveryChain = Promise.resolve();
    this.nativeCloses = new Map();
    this.scanGeneration = 0;
    this.controlGeneration = 0;
    this.found = ({ devices }) => { if (!this.disposed && this.scanRequested) this.acceptDevices(devices || []); };
    this.value = event => this.onValue(event);
    this.connection = event => {
      if (this.device && event.deviceId === this.device.deviceId && !event.connected) {
        if (this.session && this.session.closingPrevious) return;
        this.endSession(new Error('设备已断开，请重新连接'));
        if (!this.disposed) this.events.onConnection(false);
      }
    };
    wx.onBluetoothDeviceFound(this.found);
    wx.onBLECharacteristicValueChange(this.value);
    wx.onBLEConnectionStateChange(this.connection);
  }
  assertSession(session, requireReady = false) {
    if (this.disposed || !session || this.session !== session || !this.device || (requireReady && !this.ready)) throw new Error('连接已关闭，请重新连接开发板');
  }
  withSession(session, operation, timeout = 10000) {
    // Remove each listener on completion: a never-resolved session Promise would
    // otherwise retain every successful command until the next disconnection.
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.cancel.delete(cancel);
        callback(value);
      };
      const cancel = error => finish(reject, error);
      const timer = setTimeout(() => cancel(new Error('蓝牙操作超时，请检查连接后重试')), timeout);
      session.cancel.add(cancel);
      try {
        this.assertSession(session);
        Promise.resolve(operation()).then(value => finish(resolve, value), error => finish(reject, error));
      } catch (error) { finish(reject, error); }
    });
  }
  discoveryCall(name, args) {
    // Native discovery start/stop calls must not overtake each other when a
    // scan is cancelled and restarted while a platform callback is delayed.
    const job = this.discoveryChain.catch(() => {}).then(() => call(name, args, 10000));
    this.discoveryChain = job.catch(() => {});
    return job;
  }
  closeNative(deviceId) {
    if (this.nativeCloses.has(deviceId)) return this.nativeCloses.get(deviceId);
    const closing = call('closeBLEConnection', { deviceId }, 5000).catch(() => {});
    this.nativeCloses.set(deviceId, closing);
    closing.then(() => {
      if (this.nativeCloses.get(deviceId) === closing) this.nativeCloses.delete(deviceId);
    });
    return closing;
  }
  acceptDevices(devices) {
    devices.forEach(device => {
      const name = device.localName || device.name || '';
      const advertised = (device.advertisServiceUUIDs || []).some(id => same(id, protocol.SERVICE_UUID));
      if (name.startsWith('S3-MOTOR-') || advertised) this.events.onDevice(Object.assign({}, device, { name: name || 'S3 电机控制器' }));
    });
  }
  async scan() {
    const generation = ++this.scanGeneration;
    this.scanRequested = true;
    clearTimeout(this.scanTimer);
    const active = () => !this.disposed && generation === this.scanGeneration;
    try {
      await this.discoveryCall('stopBluetoothDevicesDiscovery').catch(() => {});
      if (!active()) return;
      await call('authorize', { scope: 'scope.bluetooth' });
      if (!active()) return;
      await call('openBluetoothAdapter', { mode: 'central' });
      if (!active()) return;
      await this.discoveryCall('startBluetoothDevicesDiscovery', { services: [protocol.SERVICE_UUID], allowDuplicatesKey: false });
      if (!active()) return;
      this.scanTimer = setTimeout(() => this.stopScan(), 12000);
      const cached = await call('getBluetoothDevices', {}, 10000);
      if (active()) this.acceptDevices(cached.devices || []);
    } catch (error) {
      if (active()) await this.stopScan();
      throw error;
    }
  }
  async stopScan(silent = false) {
    const generation = ++this.scanGeneration;
    this.scanRequested = false;
    clearTimeout(this.scanTimer);
    await this.discoveryCall('stopBluetoothDevicesDiscovery').catch(() => {});
    if (!this.disposed && !silent && generation === this.scanGeneration) this.events.onScanEnd();
  }
  async connect(device) {
    const previous = this.device;
    this.endSession(new Error('连接已关闭'));
    const session = { cancel: new Set(), closingPrevious: !!previous || this.nativeCloses.has(device.deviceId) };
    this.session = session;
    this.device = device;
    try {
      await this.withSession(session, () => this.stopScan());
      this.assertSession(session);
      if (previous) await this.withSession(session, () => this.closeNative(previous.deviceId));
      // A manual disconnect clears the JS session before native close finishes.
      // Reopening the same device must wait, or that old close can kill the new link.
      const closing = this.nativeCloses.get(device.deviceId);
      if (closing) await this.withSession(session, () => closing);
      session.closingPrevious = false;
      this.assertSession(session);
      await this.withSession(session, () => call('createBLEConnection', { deviceId: device.deviceId, timeout: 10000 }));
      this.assertSession(session);
      await this.withSession(session, () => sleep(250));
      this.assertSession(session);
      const services = await this.withSession(session, () => call('getBLEDeviceServices', { deviceId: device.deviceId }));
      this.assertSession(session);
      const service = (services.services || []).find(item => same(item.uuid, protocol.SERVICE_UUID));
      if (!service) throw new Error('这不是兼容的直流电机固件');
      this.serviceId = service.uuid;
      const result = await this.withSession(session, () => call('getBLEDeviceCharacteristics', { deviceId: device.deviceId, serviceId: this.serviceId }));
      this.assertSession(session);
      const write = (result.characteristics || []).find(item => same(item.uuid, protocol.WRITE_UUID) && item.properties.write);
      const status = (result.characteristics || []).find(item => same(item.uuid, protocol.STATUS_UUID) && item.properties.read && item.properties.notify);
      if (!write || !status) throw new Error('电机服务不完整，请重新烧录固件');
      this.writeId = write.uuid;
      this.statusId = status.uuid;
      await this.withSession(session, () => call('notifyBLECharacteristicValueChange', Object.assign(this.ids(this.statusId), { state: true })));
      this.assertSession(session);
      const initial = await this.readState(session);
      this.assertSession(session);
      this.ready = true;
      this.events.onConnection(true, device);
      return initial;
    } catch (error) {
      if (this.session === session) await this.disconnect();
      throw error;
    }
  }
  ids(characteristicId) {
    return { deviceId: this.device.deviceId, serviceId: this.serviceId, characteristicId };
  }
  waitForStatus(sequence, op, session = this.session) {
    const request = { sequence, op, session };
    request.promise = new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
    this.pending = request;
    return request;
  }
  rejectPending(error, session, request) {
    if (!this.pending || (session && this.pending.session !== session) || (request && this.pending !== request)) return;
    const pending = this.pending;
    this.pending = null;
    pending.reject(error);
  }
  onValue(event) {
    if (this.disposed || !this.device || (event.serviceId && !same(event.serviceId, this.serviceId)) || event.deviceId !== this.device.deviceId || !same(event.characteristicId, this.statusId || protocol.STATUS_UUID)) return;
    let status;
    try { status = protocol.decode(event.value); }
    catch (error) { this.rejectPending(error); return; }
    if (this.pending && (this.pending.sequence === null ? status.sequence === 0 : this.pending.sequence === status.sequence)) {
      const pending = this.pending;
      this.pending = null;
      if (pending.sequence !== null && status.op !== pending.op) pending.reject(new Error('开发板确认的指令不匹配，请重试'));
      else if (status.result) pending.reject(new Error(({ 1: '数据包格式错误', 2: 'PWM 或方向参数超出范围', 3: 'PWM 输出不可用，请检查配置并重启' })[status.result] || '开发板拒绝了指令'));
      else pending.resolve(status.state);
    }
    if (!status.result) {
      this.lastState = status.state;
      if (!status.state.targetSpeed || !status.state.pwmReady) this.clearHeartbeat();
      this.events.onState(status.state);
    }
  }
  async readState(session) {
    this.assertSession(session);
    const confirmed = await this.exchange(session, null, undefined, 'readBLECharacteristicValue', this.ids(this.statusId));
    this.assertSession(session);
    return confirmed;
  }
  async exchange(session, sequence, op, api, args) {
    const request = this.waitForStatus(sequence, op, session);
    try {
      // The deadline covers BOTH the native callback and the board ACK. An
      // early notification must not disable the callback timeout.
      const [state] = await this.withSession(session, () => Promise.all([request.promise, call(api, args)]), 3500);
      return state;
    } catch (error) {
      // Identify this request, not just its session: a late native failure
      // must never reject a newer command on the same BLE connection.
      this.rejectPending(error, session, request);
      throw error;
    }
  }
  enqueue(operation) {
    const session = this.session;
    if (this.queued >= MAX_QUEUED) return Promise.reject(new Error('待处理指令过多，请等待当前操作完成'));
    ++this.queued;
    const job = this.chain.catch(() => {}).then(() => {
      this.assertSession(session, true);
      return operation(session);
    });
    this.chain = job.then(() => { --this.queued; }, () => { --this.queued; });
    return job;
  }
  refresh() {
    if (this.refreshPending && this.refreshPending.session === this.session) return this.refreshPending.promise;
    const entry = { session: this.session, promise: this.enqueue(session => this.readState(session)) };
    this.refreshPending = entry;
    const clear = () => { if (this.refreshPending === entry) this.refreshPending = null; };
    entry.promise.then(clear, clear);
    return entry.promise;
  }
  run(speed, direction) {
    protocol.command(1, 1, speed, direction);
    const session = this.session;
    const generation = this.controlGeneration;
    return this.send(1, speed, direction, generation).then(state => {
      this.assertControl(session, generation);
      // A later timeout notification can arrive before a delayed write callback.
      // Never turn that old RUN ACK into permission to keep the motor alive.
      if (this.lastState && this.lastState.targetSpeed && this.lastState.pwmReady) this.scheduleHeartbeat(session, generation);
      return state;
    }).catch(error => {
      if (this.session === session && generation === this.controlGeneration) this.failSafe(error);
      throw error;
    });
  }
  async stop() {
    this.clearHeartbeat();
    const generation = ++this.controlGeneration;
    const session = this.session;
    this.assertSession(session, true);
    // A STOP must not wait behind a stalled write/read or queued RUN. Closing
    // the link also makes every old queued operation fail its session check.
    if (this.pending || this.queued) {
      const closing = this.disconnect();
      if (!this.disposed) this.events.onConnection(false);
      await closing;
      return null;
    }
    try { return await this.send(2, 0, 0, generation); }
    catch (error) {
      if (this.session === session) this.failSafe(error);
      throw error;
    }
  }
  assertControl(session, generation) {
    this.assertSession(session, true);
    if (generation !== this.controlGeneration) throw new Error('指令已取消，请重新操作');
  }
  clearHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
  scheduleHeartbeat(session, generation) {
    this.clearHeartbeat();
    if (!this.lastState || !this.lastState.targetSpeed) return;
    // Schedule only after the previous exchange completed: no accumulated
    // interval queue, even if the native BLE callback or ACK stalls.
    this.heartbeatTimer = setTimeout(async () => {
      this.heartbeatTimer = null;
      try {
        this.assertControl(session, generation);
        if (!this.lastState || !this.lastState.targetSpeed) return;
        await this.send(3, 0, 0, generation);
        this.assertControl(session, generation);
        this.scheduleHeartbeat(session, generation);
      } catch (error) {
        if (this.session === session && generation === this.controlGeneration) this.failSafe(error);
      }
    }, 400);
  }
  failSafe(error) {
    // JS state is invalidated synchronously; native close completes separately.
    this.disconnect();
    if (!this.disposed) {
      this.events.onConnection(false);
      if (this.events.onFault) this.events.onFault(error);
    }
  }
  send(op, speed = 0, direction = 0, generation = this.controlGeneration) {
    protocol.command(1, op, speed, direction);
    return this.enqueue(async session => {
      this.assertControl(session, generation);
      this.sequence = this.sequence % 255 + 1;
      const frame = protocol.command(this.sequence, op, speed, direction);
      const state = await this.exchange(session, this.sequence, op, 'writeBLECharacteristicValue',
        Object.assign(this.ids(this.writeId), { value: frame.buffer, writeType: 'write' }));
      this.assertControl(session, generation);
      return state;
    });
  }
  endSession(error) {
    this.clearHeartbeat();
    ++this.controlGeneration;
    this.lastState = null;
    this.ready = false;
    this.rejectPending(error);
    if (this.session) {
      for (const cancel of this.session.cancel) cancel(error);
      this.session.cancel.clear();
    }
    this.session = null;
    this.device = null;
  }
  async disconnect() {
    const previous = this.device;
    this.endSession(new Error('连接已关闭'));
    if (previous) await this.closeNative(previous.deviceId);
    else await Promise.allSettled(this.nativeCloses.values());
  }
  async destroy() {
    if (this.destroying) return this.destroying;
    this.disposed = true;
    ++this.scanGeneration;
    // Close the BLE link immediately so the board stops output, even when a
    // scan-stop callback is delayed. These independent cleanup calls may overlap.
    const disconnecting = this.disconnect();
    wx.offBluetoothDeviceFound(this.found);
    wx.offBLECharacteristicValueChange(this.value);
    wx.offBLEConnectionStateChange(this.connection);
    this.destroying = Promise.allSettled([disconnecting, this.stopScan()])
      .then(() => call('closeBluetoothAdapter', {}, 5000).catch(() => {}));
    return this.destroying;
  }
}
module.exports = { MotorClient, message };
