'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { writeLastExit, readLastExitSince } = require('./last-exit');
const { installCrashGuard } = require('./crash-guard');
const { installShutdownReaper } = require('./shutdown-reaper');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-last-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const registry = () => new Map([
  ['task\0/project-a', { alive: true }],
  ['task\0/project-b', { _starting: true }],
  ['exited', { alive: false }],
]);

test('records live sessions across projects and reads only a strictly newer valid exit', t => {
  const root = scratch(t);
  assert.equal(writeLastExit({ reason: 'signal:SIGTERM', sessions: registry(), root }), true);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'last-exit.json')));
  assert.equal(record.liveSessionCount, 2);
  assert.equal(record.stack, null);
  const at = Date.parse(record.at);
  assert.deepEqual(readLastExitSince(at - 1, root), { at: record.at, reason: record.reason });
  for (const start of [at, at + 1, '', null, undefined, 'bad', -1, Infinity]) {
    assert.equal(readLastExitSince(start, root), null);
  }
  for (const content of ['{', 'null', JSON.stringify({ at: 'bad', reason: record.reason }),
    JSON.stringify({ at: new Date(Date.now() + 60000).toISOString(), reason: record.reason }),
    JSON.stringify({ at: record.at, reason: 'unknown' })]) {
    fs.writeFileSync(path.join(root, 'last-exit.json'), content);
    assert.equal(readLastExitSince(at - 1, root), null);
  }
  assert.equal(readLastExitSince(at - 1, path.join(root, 'missing')), null);
  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, '');
  assert.equal(writeLastExit({ reason: 'signal:SIGTERM', root: file }), false);
});

test('fatal throw writes a real scratch record before exiting 1', t => {
  const root = scratch(t);
  const script = `
    const { installCrashGuard } = require(${JSON.stringify(require.resolve('./crash-guard'))});
    installCrashGuard({ sessions: new Map([['a', { alive: false }], ['b', { alive: false }]]) });
    setImmediate(() => { throw new TypeError('scratch crash'); });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TIPATASK_USER_DATA: root }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 1, child.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'last-exit.json')));
  assert.equal(record.reason, 'uncaught-exception');
  assert.match(record.stack, /TypeError: scratch crash/);
  assert.equal(record.liveSessionCount, 0);
  assert.ok(Number.isFinite(Date.parse(record.at)));
});

for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) {
  test(`real child ${event} writes shutdown cause before exit`, { timeout: 15000 }, async t => {
    const root = scratch(t);
    const filename = path.join(root, 'child.cjs');
    fs.writeFileSync(filename, `
      const { installShutdownReaper } = require(${JSON.stringify(require.resolve('./shutdown-reaper'))});
      installShutdownReaper({ sessions: new Map([['a', { type: 'terminal', alive: true }]]),
        claude: { killAllPrewarms: () => [] }, headless: { killAllHeadlessProcs: () => [] } });
      setInterval(() => {}, 1000);
      process.send('ready');
    `);
    const child = fork(filename, [], { env: { ...process.env, TIPATASK_USER_DATA: root }, silent: true });
    t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    await once(child, 'message');
    if (event === 'disconnect') child.disconnect();
    else child.kill(event);
    assert.deepEqual(await exited, [0, null]);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'last-exit.json')));
    assert.equal(record.reason, event === 'disconnect' ? 'ipc-disconnect' : `signal:${event}`);
    assert.equal(record.liveSessionCount, 1);
    assert.equal(record.stack, null);
  });
}

test('recording failures cannot block fatal exit or shutdown', () => {
  for (const fatal of [true, false]) {
    const proc = new EventEmitter();
    const exits = [];
    const opts = { proc, sessions: new Map(), recordExit() { throw new Error('disk unavailable'); },
      exit: code => exits.push(code), log: { error() {} },
      claude: { killAllPrewarms: () => [] }, headless: { killAllHeadlessProcs: () => [] } };
    if (fatal) installCrashGuard(opts);
    else installShutdownReaper(opts);
    proc.emit(fatal ? 'uncaughtException' : 'SIGTERM', new Error('boom'));
    assert.deepEqual(exits, [fatal ? 1 : 0]);
  }
});

test('survived errors never replace the last exit and fatal cause is recorded once', () => {
  const proc = new EventEmitter();
  const records = [];
  const sessions = registry();
  installCrashGuard({ proc, sessions, recordExit: r => records.push(r), exit() {}, log: { error() {} } });
  proc.emit('uncaughtException', Object.assign(new Error('network'), { code: 'ECONNRESET' }));
  proc.emit('unhandledRejection', new Error('background'));
  proc.emit('uncaughtException', new TypeError('survived with live sessions'));
  assert.equal(records.length, 0);
  sessions.clear();
  proc.emit('uncaughtException', new Error('first'));
  proc.emit('uncaughtException', new Error('second'));
  assert.equal(records.length, 1);
  assert.match(records[0].stack, /first/);
});
