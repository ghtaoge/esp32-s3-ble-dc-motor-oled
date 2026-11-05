const SERVICE_UUID = 'e75b0001-4e42-4ea0-9b38-33c7bc713100';
const WRITE_UUID = 'e75b0002-4e42-4ea0-9b38-33c7bc713100';
const STATUS_UUID = 'e75b0003-4e42-4ea0-9b38-33c7bc713100';

function command(sequence, op, speed = 0, direction = 0) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 255) throw new Error('无效的指令编号');
  if (![1, 2, 3].includes(op)) throw new Error('无效的电机指令');
  if (!Number.isInteger(speed) || !Number.isInteger(direction) ||
      (op === 1 ? speed < 1 || speed > 100 || ![1, 2].includes(direction) : speed !== 0 || direction !== 0)) {
    throw new Error('运行需设置 1–100% PWM 和方向；停止及保活不带参数');
  }
  return Uint8Array.from([0xA5, 1, sequence, op, speed, direction]);
}

function decode(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 20) throw new Error('开发板状态数据长度不正确');
  const b = new Uint8Array(buffer);
  const word = offset => b[offset] | b[offset + 1] << 8;
  if (b[0] !== 0x5A || b[1] !== 1 || b[4] > 3 || (b[5] & ~31) ||
      (b[2] === 0 ? b[3] !== 0 || b[4] !== 0 : ![1, 2, 3].includes(b[3]))) {
    throw new Error('开发板状态协议不兼容');
  }
  const state = {
    oledReady: !!(b[5] & 1), pwmReady: !!(b[5] & 2), running: !!(b[5] & 4),
    transitioning: !!(b[5] & 8), encoderConfigured: !!(b[5] & 16),
    targetSpeed: b[6], outputSpeed: b[7], targetDir: b[8], outputDir: b[9],
    reason: b[10], encoderMode: b[11], pwmHz: word(12), leaseMs: word(14),
    rpm: word(16) === 65535 ? null : word(16), pulsesPerRev: word(18)
  };
  const directionValid = (speed, dir) => speed === 0 ? dir === 0 : dir === 1 || dir === 2;
  if (state.targetSpeed > 100 || state.outputSpeed > 100 || state.reason > 4 ||
      !directionValid(state.targetSpeed, state.targetDir) || !directionValid(state.outputSpeed, state.outputDir) ||
      state.running !== (state.outputSpeed > 0) ||
      state.transitioning !== (state.targetSpeed !== state.outputSpeed || state.targetDir !== state.outputDir) ||
      (!state.pwmReady && (state.targetSpeed || state.outputSpeed)) ||
      !state.pwmHz || !state.leaseMs || state.encoderMode > 1 ||
      state.encoderConfigured !== (state.encoderMode === 1) ||
      (state.encoderConfigured ? !state.pulsesPerRev : state.pulsesPerRev !== 0 || state.rpm !== null)) {
    throw new Error('开发板状态超出有效范围');
  }
  return { sequence: b[2], op: b[3], result: b[4], state };
}

module.exports = { SERVICE_UUID, WRITE_UUID, STATUS_UUID, command, decode };
