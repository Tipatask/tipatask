'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tt-crash-guard-'));
process.env.TIPATASK_USER_DATA = scratch;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { installCrashGuard, isNetworkError, networkErrorCode } = require('./crash-guard');

const netErr = (code, message = 'socket hang up') => Object.assign(new Error(message), { code });

function harness(opts = {}) {
  const proc = new EventEmitter();
  const lines = [];
  const exits = [];
  installCrashGuard({ proc, exit: (code) => exits.push(code), log: { error: (line) => lines.push(line) }, ...opts });
  return { proc, lines, exits };
}

test('network-class codes are recognised, directly or through a cause chain', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    assert.equal(isNetworkError(netErr(code)), true, code);
  }
  const wrapped = new Error('API unreachable', { cause: new Error('Request failed', { cause: netErr('ECONNRESET') }) });
  assert.equal(networkErrorCode(wrapped), 'ECONNRESET');
});

test('non-network values are not classified as network errors', () => {
  for (const v of [new TypeError('x'), netErr('EPIPE'), netErr('ENOENT'), 'ECONNRESET', null, undefined, 42]) {
    assert.equal(isNetworkError(v), false, String(v));
  }
});

test('uncaught ECONNRESET is logged and the process is kept alive', () => {
  const { proc, lines, exits } = harness();
  proc.emit('uncaughtException', netErr('ECONNRESET'));
  assert.deepEqual(exits, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /uncaught network error ECONNRESET \(kept alive\)/);
  assert.match(lines[0], /socket hang up/);
});

test('uncaught ETIMEDOUT and a wrapped-cause ECONNRESET are also survived', () => {
  const { proc, lines, exits } = harness();
  proc.emit('uncaughtException', netErr('ETIMEDOUT', 'timed out'));
  proc.emit('uncaughtException', new Error('API unreachable', { cause: netErr('ECONNRESET') }));
  assert.deepEqual(exits, []);
  assert.equal(lines.length, 2);
});

test('any other uncaught exception is fatal: logged, then exit(1)', () => {
  const { proc, lines, exits } = harness();
  proc.emit('uncaughtException', new TypeError('boom'));
  assert.deepEqual(exits, [1]);
  assert.match(lines[0], /fatal uncaught exception/);
  assert.match(lines[0], /boom/);
});

test('EPIPE stays fatal with no live sessions', () => {
  const { proc, exits } = harness();
  proc.emit('uncaughtException', netErr('EPIPE', 'write EPIPE'));
  assert.deepEqual(exits, [1]);
});

test('live-session callback preserves sessions for all error classes and rechecks before exit', () => {
  let live = true;
  const records = [];
  const { proc, lines, exits } = harness({ hasLiveSessions: () => live, recordExit: r => records.push(r) });
  for (const err of [new TypeError('bad poll'), netErr('EPIPE'), netErr('ENOENT'), netErr('ECONNRESET')]) {
    proc.emit('uncaughtException', err);
    assert.ok(lines.at(-1).includes(err.stack));
  }
  assert.deepEqual(exits, []);
  assert.deepEqual(records, []);
  live = false;
  proc.emit('uncaughtException', new Error('no sessions left'));
  assert.deepEqual(exits, [1]);
  assert.equal(records.length, 1);
});

test('registry fallback checks alive === true across projects, not starting or retained sessions', () => {
  const sessions = new Map([['a/project-a', { alive: false }], ['b/project-b', { alive: true }]]);
  const { proc, exits } = harness({ sessions, recordExit() {} });
  proc.emit('uncaughtException', new Error('preserve project-b'));
  assert.deepEqual(exits, []);
  sessions.get('b/project-b').alive = false;
  sessions.set('starting', { _starting: true });
  proc.emit('uncaughtException', new Error('no live sessions'));
  assert.deepEqual(exits, [1]);
});

test('a throwing registry check or logger cannot turn recovery into termination', () => {
  const { proc, exits } = harness({
    hasLiveSessions() { throw new Error('registry unavailable'); },
    log: { error() { throw new Error('stderr closed'); } },
  });
  assert.doesNotThrow(() => proc.emit('uncaughtException', netErr('EPIPE')));
  assert.deepEqual(exits, []);
});

test('once fatal, later exceptions do not re-report or re-exit', () => {
  const { proc, lines, exits } = harness();
  proc.emit('uncaughtException', new Error('first'));
  proc.emit('uncaughtException', new Error('second'));
  assert.deepEqual(exits, [1]);
  assert.equal(lines.length, 1);
});

test('unhandled rejections never exit, network ones are tagged', () => {
  const { proc, lines, exits } = harness();
  proc.emit('unhandledRejection', netErr('ECONNRESET'));
  proc.emit('unhandledRejection', new Error('plain'));
  proc.emit('unhandledRejection', 'a string reason');
  assert.deepEqual(exits, []);
  assert.match(lines[0], /unhandled network rejection ECONNRESET \(kept alive\)/);
  assert.match(lines[1], /unhandled rejection \(kept alive\): .*plain/s);
  assert.match(lines[2], /a string reason/);
});

test('a throwing logger cannot break the handler', () => {
  const proc = new EventEmitter();
  const exits = [];
  installCrashGuard({ proc, exit: (code) => exits.push(code), log: { error: () => { throw new Error('stderr closed'); } } });
  assert.doesNotThrow(() => proc.emit('uncaughtException', netErr('ECONNRESET')));
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('fatal')));
  assert.deepEqual(exits, [1]);
});

// ── Real processes: the guard against Node's actual default crash behaviour ──

function runChild(body, guardOptions = '', aliveAfter = 80) {
  const script = `
    const { installCrashGuard } = require(${JSON.stringify(require.resolve('./crash-guard'))});
    const { EventEmitter } = require('node:events');
    installCrashGuard(${guardOptions});
    ${body}
    setTimeout(() => console.log('alive'), ${aliveAfter});
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
}

test('process: a listener-less ECONNRESET "error" emit — the production crash shape — is survived', () => {
  const r = runChild(`
    const req = new EventEmitter();
    setImmediate(() => req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /uncaught network error ECONNRESET \(kept alive\)/);
});

test('process: a non-network error thrown by a 10s timer preserves a live session', () => {
  const r = runChild(`
    const poll = setInterval(() => {
      clearInterval(poll);
      throw new TypeError('10s poll failed');
    }, 10000);
  `, '{ hasLiveSessions: () => true }', 10080);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /kept alive to preserve live sessions/);
  assert.match(r.stderr, /TypeError: 10s poll failed/);
});

test('process: an async polling error is an unhandled rejection and preserves live sessions', () => {
  const r = runChild(`setImmediate(async () => { throw new TypeError('async poll failed'); });`,
    '{ hasLiveSessions: () => true }');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /unhandled rejection.*async poll failed/s);
});

test('process: a thrown ETIMEDOUT is survived', () => {
  const r = runChild(`setImmediate(() => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); });`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /ETIMEDOUT/);
});

test('process: an unhandled ECONNRESET rejection is survived', () => {
  const r = runChild(`Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /unhandled network rejection ECONNRESET/);
});

test('process: a non-network throw still exits 1 with the error on stderr', () => {
  const r = runChild(`setImmediate(() => { throw new TypeError('kaboom'); });`);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /alive/);
  assert.match(r.stderr, /fatal uncaught exception/);
  assert.match(r.stderr, /kaboom/);
});
