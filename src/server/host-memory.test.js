'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMacMemory, swapDelta, createCommandRunner, readHostMemory } = require('./host-memory');

function vm(pageSize = 16384, extra = '') {
  return `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free: 10.
File-backed pages: 20.
Pages inactive: 100.
Pages speculative: 100.
Pages purgeable: 100.
Pages occupied by compressor: 30.
Pages stored in compressor: 90.
Swapins: 4.
Swapouts: 5.
${extra}`;
}
const sys = pressure => `hw.memsize: 51539607552\nkern.memorystatus_vm_pressure_level: ${pressure}`;

for (const size of [4096, 16384]) test(`VM conversion uses ${size}-byte pages without overlapping reclaimable categories`, () => {
  const m = parseMacMemory(sys(1), vm(size));
  assert.equal(m.pageSizeBytes, size);
  assert.equal(m.reclaimableEstimateBytes, 30 * size);
  assert.equal(m.compressorBytes, 30 * size);
  assert.equal(m.compressedLogicalBytes, 90 * size);
  assert.equal(m.swapOutBytes, 5 * size);
  assert.equal(m.status, 'ok');
  assert.match(m.reclaimableLabel, /not exact available/);
});
for (const [value, expected] of [[1, 'normal'], [2, 'warning'], [4, 'critical'], [0, 'unknown'], [3, 'unknown'],
  [6, 'unknown'], [8, 'unknown'], [-1, 'unknown'], ['NaN', 'unknown'], ['', 'unknown']]) {
  test(`dispatch pressure ${value} -> ${expected}`, () => assert.equal(parseMacMemory(sys(value), vm()).pressure, expected));
}
test('missing, negative, unsafe and invalid quantities remain unknown; measured zero is valid', () => {
  assert.equal(parseMacMemory('', '').physicalBytes, null);
  assert.equal(parseMacMemory(sys(1), vm(0)).reclaimableEstimateBytes, null);
  assert.equal(parseMacMemory(sys(1), vm().replace('Pages free: 10.', 'Pages free: -10.')).reclaimableEstimateBytes, null);
  assert.equal(parseMacMemory(sys(1), vm(9007199254740991)).compressorBytes, null);
  const zero = parseMacMemory(sys(1), vm().replace(/: \d+\./g, ': 0.'));
  assert.equal(zero.reclaimableEstimateBytes, 0);
  assert.equal(zero.compressorBytes, 0);
  assert.equal(zero.swapOutBytes, 0);
});
test('swap deltas preserve zero, reset and discontinuity instead of inventing activity', () => {
  const a = { sampledAt: 1000, pageSizeBytes: 16384, swapInBytes: 50, swapOutBytes: 100 };
  const b = { ...a, sampledAt: 6000, swapInBytes: 60 };
  assert.equal(swapDelta(null, a).inBytes, null);
  assert.deepEqual(swapDelta(a, b), { inBytes: 10, outBytes: 0, intervalMs: 5000, status: 'ok' });
  assert.equal(swapDelta(b, { ...b, sampledAt: 11000, swapOutBytes: 0 }).status, 'reset');
  assert.equal(swapDelta(a, { ...b, sampledAt: 20000 }).status, 'discontinuous');
  assert.equal(swapDelta(a, { ...b, pageSizeBytes: 4096 }).inBytes, null);
  assert.equal(swapDelta(a, { ...b, swapInBytes: null }).status, 'unknown');
});
test('unsupported hosts and failed commands remain unknown', async () => {
  let calls = 0;
  assert.equal((await readHostMemory(async () => { calls++; }, 'win32')).status, 'unsupported');
  assert.equal(calls, 0);
  assert.equal((await readHostMemory(async () => null, 'darwin')).pressure, 'unknown');
});
test('runner bounds output, clears timer on success and handles throwing exec', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed = 0;
  const runner = createCommandRunner({ exec(file, args, opts, cb) {
    assert.equal(opts.maxBuffer, 2 * 1024 * 1024);
    assert.equal(opts.killSignal, 'SIGKILL');
    cb(null, 'ok');
    return { kill() { killed++; } };
  } });
  assert.equal(await runner.run('/test', []), 'ok');
  t.mock.timers.tick(5000);
  assert.equal(killed, 0);
  assert.equal(runner.pendingCount(), 0);
  runner.stop();
  assert.equal(await runner.run('/test', []), null);
  const failed = createCommandRunner({ exec() { throw Error('spawn'); } });
  assert.equal(await failed.run('/test', []), null);
  assert.equal(failed.pendingCount(), 0);
});
test('runner times out and stop cancels owned child without waiting for callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed = 0, callback;
  const runner = createCommandRunner({ timeoutMs: 100, exec(f, a, o, cb) {
    callback = cb;
    return { kill(signal) { assert.equal(signal, 'SIGKILL'); killed++; } };
  } });
  const pending = runner.run('/test', []);
  t.mock.timers.tick(100);
  assert.equal(await pending, null);
  callback(null, 'late');
  const pending2 = runner.run('/test', []);
  runner.stop();
  runner.stop();
  assert.equal(await pending2, null);
  assert.equal(killed, 2);
  assert.equal(runner.pendingCount(), 0);
});
