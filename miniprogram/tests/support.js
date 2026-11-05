// Construct the wire representation independently of the production encoder.
function status(patch = {}) {
  const s = { magic: 0x5A, version: 1, sequence: 0, op: 0, result: 0,
    oledReady: true, pwmReady: true, targetSpeed: 0, outputSpeed: 0, targetDir: 0, outputDir: 0,
    reason: 0, encoderMode: 0, pwmHz: 20000, leaseMs: 1500, rpm: 65535, pulsesPerRev: 0, ...patch };
  const flags = (s.oledReady ? 1 : 0) | (s.pwmReady ? 2 : 0) | (s.outputSpeed ? 4 : 0) |
    (s.targetSpeed !== s.outputSpeed || s.targetDir !== s.outputDir ? 8 : 0) | (s.encoderMode === 1 ? 16 : 0);
  const b = Uint8Array.from([s.magic, s.version, s.sequence, s.op, s.result, s.flags === undefined ? flags : s.flags,
    s.targetSpeed, s.outputSpeed, s.targetDir, s.outputDir, s.reason, s.encoderMode, 0, 0, 0, 0, 0, 0, 0, 0]);
  const v = new DataView(b.buffer);
  v.setUint16(12, s.pwmHz, true); v.setUint16(14, s.leaseMs, true);
  v.setUint16(16, s.rpm, true); v.setUint16(18, s.pulsesPerRev, true);
  return b.buffer;
}
module.exports = { status };
