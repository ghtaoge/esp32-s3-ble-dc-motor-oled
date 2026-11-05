const { MotorClient, message } = require('../../utils/ble');
const directions = ['停止', '正转指令', '反转指令'];
const reasons = ['就绪 / 运行', '手动停止', '蓝牙连接变化，输出已停', '保活超时，输出已停', 'PWM 初始化失败'];

Page({
  data: {
    connected: false, scanning: false, connectingId: '', devices: [], deviceName: '',
    speed: 30, direction: 1, targetSpeed: 0, outputSpeed: 0, targetDir: 0, outputDir: 0,
    targetDirectionText: '停止', outputDirectionText: '停止', reasonText: '等待连接',
    oledReady: false, pwmReady: false, running: false, transitioning: false,
    encoderConfigured: false, encoderMode: 0, rpm: null, rpmText: '未接测速编码器', pulsesPerRev: 0,
    pwmHz: 20000, leaseMs: 1500, sending: false, stopping: false, syncText: '', errorText: '',
    showPrivacy: false, privacyAgreePending: false, privacyName: '《用户隐私保护指引》'
  },
  onLoad() {
    this.privacyResolvers = new Set();
    this.scanAttempt = 0;
    this.operation = 0;
    this.client = new MotorClient({
      onDevice: device => {
        if (this.unloaded || this.hidden || !this.data.scanning || this.data.connected || this.data.connectingId) return;
        const devices = this.data.devices.slice();
        const index = devices.findIndex(item => item.deviceId === device.deviceId);
        const item = { deviceId: device.deviceId, name: device.name, RSSI: Number.isFinite(device.RSSI) ? device.RSSI : null };
        if (index >= 0 && devices[index].name === item.name && devices[index].RSSI === item.RSSI) return;
        if (index < 0) devices.push(item); else devices[index] = item;
        devices.sort((a, b) => (typeof b.RSSI === 'number' ? b.RSSI : -127) - (typeof a.RSSI === 'number' ? a.RSSI : -127));
        this.update({ devices });
      },
      onScanEnd: () => this.update({ scanning: false }),
      onState: state => this.showState(state),
      onConnection: (connected, device) => {
        if (this.unloaded || this.hidden) {
          if (connected) this.client.disconnect();
          return;
        }
        if (!connected) { ++this.operation; this.cancelPreview(); this.latestState = null; }
        this.update({ connected, connectingId: '', deviceName: device ? device.name : '',
          sending: false, stopping: false, syncText: '',
          errorText: connected ? '' : '连接已断开。输出停止后需重新连接并手动启动。' });
      },
      onFault: error => this.update({ errorText: `${message(error)}；已断开连接，请检查后重新连接并手动启动。` })
    });
    if (wx.onNeedPrivacyAuthorization) {
      this.privacyHandler = resolve => {
        if (typeof resolve !== 'function' || this.unloaded) return;
        this.privacyResolvers.add(resolve);
        const alreadyShown = this.data.showPrivacy;
        this.update({ showPrivacy: true });
        if (!alreadyShown && wx.getPrivacySetting) wx.getPrivacySetting({ success: result => {
          if (!this.unloaded && this.data.showPrivacy) this.update({ privacyName: result.privacyContractName || this.data.privacyName });
        }});
      };
      wx.onNeedPrivacyAuthorization(this.privacyHandler);
    }
  },
  update(patch) {
    if (this.unloaded) return;
    const changed = {};
    Object.keys(patch).forEach(key => { if (!Object.is(this.data[key], patch[key])) changed[key] = patch[key]; });
    if (Object.keys(changed).length) this.setData(changed);
  },
  showState(state) {
    if (this.unloaded || this.hidden) return;
    this.latestState = state;
    this.update({ ...state,
      targetDirectionText: directions[state.targetDir], outputDirectionText: directions[state.outputDir],
      reasonText: reasons[state.reason],
      rpmText: !state.encoderConfigured ? '未接测速编码器' : state.rpm === null ? '等待采样' : `${state.rpm} RPM`
    });
  },
  onShow() { this.hidden = false; },
  onHide() {
    this.hidden = true;
    ++this.operation;
    ++this.scanAttempt;
    this.cancelPreview();
    this.latestState = null;
    this.update({ connected: false, scanning: false, connectingId: '', deviceName: '',
      sending: false, stopping: false, syncText: '已关闭连接，返回后请重新连接并手动启动。', errorText: '' });
    if (this.client) {
      // Cancel a pending RUN synchronously; STOP queued behind that RUN is unsafe.
      this.client.disconnect();
      this.client.stopScan();
    }
    this.settlePrivacy('disagree');
  },
  onUnload() {
    this.unloaded = true;
    ++this.operation;
    ++this.scanAttempt;
    this.cancelPreview();
    this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    if (this.client) this.client.destroy();
  },
  async search() {
    if (this.unloaded || this.hidden || this.data.scanning || this.data.connectingId || this.data.connected) return;
    const attempt = ++this.scanAttempt;
    this.update({ scanning: true, devices: [], errorText: '' });
    try { await this.client.scan(); }
    catch (error) {
      if (!this.unloaded && !this.hidden && attempt === this.scanAttempt && !this.data.connected && !this.data.connectingId) {
        this.update({ scanning: false, errorText: message(error) });
      }
    }
  },
  async connect(event) {
    if (this.unloaded || this.hidden || this.data.connectingId || this.data.connected) return;
    const device = this.data.devices.find(item => item.deviceId === event.currentTarget.dataset.id);
    if (!device) return;
    const operation = ++this.operation;
    ++this.scanAttempt;
    this.update({ connectingId: device.deviceId, scanning: false, errorText: '', syncText: '' });
    try { await this.client.connect(device); }
    catch (error) {
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ connectingId: '', connected: false, errorText: message(error) });
    }
  },
  async disconnect() {
    ++this.operation;
    ++this.scanAttempt;
    this.cancelPreview();
    this.latestState = null;
    this.update({ connected: false, connectingId: '', deviceName: '', sending: false, stopping: false,
      syncText: '已关闭连接。再次连接不会自动启动。', errorText: '' });
    await this.client.disconnect();
  },
  cancelPreview() { clearTimeout(this.previewTimer); this.previewTimer = null; },
  previewSpeed(event) {
    if (this.unloaded || this.hidden || this.data.sending || this.data.stopping) return;
    const speed = event.detail.value;
    if (!Number.isInteger(speed) || speed < 1 || speed > 100) return;
    this.previewValue = speed;
    if (!this.previewTimer) this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (!this.unloaded && !this.hidden) this.update({ speed: this.previewValue, syncText: '' });
    }, 40);
  },
  changeSpeed(event) {
    this.cancelPreview();
    if (this.unloaded || this.hidden || this.data.sending || this.data.stopping) return;
    const speed = event.detail.value;
    if (Number.isInteger(speed) && speed >= 1 && speed <= 100) this.update({ speed, syncText: '' });
  },
  selectDirection(event) {
    if (this.unloaded || this.hidden || this.data.sending || this.data.stopping) return;
    const direction = Number(event.currentTarget.dataset.direction);
    if (direction === 1 || direction === 2) this.update({ direction, syncText: '' });
  },
  async run() {
    if (this.unloaded || this.hidden || !this.data.connected || !this.data.pwmReady || this.data.sending || this.data.stopping) return;
    this.cancelPreview();
    const operation = ++this.operation;
    const speed = this.data.speed, direction = this.data.direction;
    this.update({ sending: true, syncText: '', errorText: '' });
    try {
      await this.client.run(speed, direction);
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ syncText: `开发板已接收 ${speed}% ${directions[direction]}。` });
    } catch (error) {
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ errorText: message(error) });
    } finally {
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ sending: false });
    }
  },
  async stop() {
    // Available while a RUN is waiting for its ACK, regardless of sending.
    if (this.unloaded || this.hidden || !this.data.connected || this.data.stopping) return;
    const operation = ++this.operation;
    this.cancelPreview();
    this.update({ stopping: true, sending: false, syncText: '', errorText: '' });
    try {
      const state = await this.client.stop();
      if (!this.unloaded && !this.hidden && operation === this.operation && state) {
        this.update({ syncText: '开发板已确认停止输出。电机轴会按负载惯性滑行。' });
      }
    } catch (error) {
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ errorText: message(error) });
    } finally {
      if (!this.unloaded && !this.hidden && operation === this.operation) this.update({ stopping: false });
    }
  },
  openSettings() { wx.openSetting({}); },
  openPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请先在小程序后台配置隐私指引', icon: 'none' }) });
  },
  preparePrivacyAgree() {
    if (this.unloaded || !this.data.showPrivacy || this.data.privacyAgreePending) return;
    this.update({ privacyAgreePending: true });
    this.privacyTimer = setTimeout(() => {
      this.settlePrivacy('disagree', '微信未完成隐私授权，请重新搜索后再试；开发工具中请使用手机预览测试。');
    }, 3000);
  },
  settlePrivacy(event, reason = '') {
    clearTimeout(this.privacyTimer);
    const resolvers = Array.from(this.privacyResolvers);
    this.privacyResolvers.clear();
    let failed = false;
    resolvers.forEach(resolve => {
      try { resolve(event === 'agree' ? { event, buttonId: 'agree-privacy' } : { event }); }
      catch (error) { failed = true; console.warn('Privacy authorization could not complete:', error); }
    });
    const patch = { showPrivacy: this.privacyResolvers.size > 0, privacyAgreePending: false };
    if ((event !== 'agree' || failed) && (resolvers.length || reason)) {
      ++this.scanAttempt;
      patch.scanning = false;
      patch.errorText = reason || (failed ? '隐私授权未完成，请重新搜索后再试。' : '已取消连接，点击搜索可以重试。');
    }
    this.update(patch);
  },
  agreePrivacy() { this.settlePrivacy('agree'); },
  rejectPrivacy() { this.settlePrivacy('disagree'); },
  ignorePrivacyTap() {}
});
