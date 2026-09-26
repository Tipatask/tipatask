'use strict';

// TPT294 — a Codex turn must never be spawned for a chat that was torn down (closed) or restarted
// while the turn was still being prepared. spawnCodexTurn() awaits attachment localization before
// it spawns, which is exactly the window a kill / socket close / Restart can land in.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const throttle = require('../objective-throttle');

function harness(t) {
  // The spawned turn arms a 10-minute deadline + a ticker; mocked so they can't hold the process.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const spawned = [];
  let releaseLocalize;
  const localizeGate = new Promise(resolve => { releaseLocalize = resolve; });
  const filename = path.join(__dirname, 'codex-session.js');
  const realRequire = createRequire(filename);
  const mocks = {
    'node:child_process': { spawn() {
      const proc = new EventEmitter();
      proc.pid = 97000 + spawned.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      spawned.push(proc);
      return proc;
    } },
    '../codex-env': { buildCodexEnv: () => ({ env: {} }), codexEffortArgs: () => [], toCodexEffort: level => level },
    '../claude-session': { normalizeProposals: x => x },
    './transcript': { buildTurnPrompt: () => ({ prompt: 'plan it', mode: 'fresh' }), buildNudgeMessage: () => 'nudge' },
    '../task-agent/attachments': { localizeAttachments: async ({ prompt }) => { await localizeGate; return { prompt }; } },
    '../context-manager': { shouldTrimContext: () => false, trimContext: () => false },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log() {}, warn() {}, error() {} },
    process: { env: {}, kill() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer,
  }, { filename });
  const session = { type: 'objective', providerType: 'codex', tabId: 'obj-codex', ws: null,
    messages: [{ role: 'user', content: 'plan it' }], turnBuffer: '', turnRawSse: '', timingMilestones: {} };
  return { codex: module.exports, session, spawned, releaseLocalize };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('control: an undisturbed Codex turn spawns once localization resolves', async t => {
  const h = harness(t);
  h.codex.spawnCodexTurn(h.session, 'obj-codex-control');
  assert.equal(h.session._spawning, true);
  h.releaseLocalize();
  await settle(); await settle();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.session._spawning, false);
});

test('a closed session spawns nothing and frees the slot its throttle drain granted', t => {
  const h = harness(t);
  h.session._closed = true;
  try {
    throttle.requestTurn('obj-codex-closed', () => h.codex.spawnCodexTurn(h.session, 'obj-codex-closed'));
    assert.equal(h.spawned.length, 0);
    assert.notEqual(h.session._spawning, true);
    assert.equal(throttle.getStatus().active, 0);
  } finally {
    throttle.recordAbort('obj-codex-closed');
  }
});

test('a teardown/restart during localization never spawns the stale turn and leaves _spawning alone', async t => {
  const h = harness(t);
  h.codex.spawnCodexTurn(h.session, 'obj-codex-epoch');
  // teardownObjectiveSession() bumps the epoch; clearContext() re-opens the session and the
  // restart's own new spawn now owns _spawning.
  Object.assign(h.session, { _epoch: 1, _aborted: false, _closed: false, _spawning: 'restart-spawn' });
  h.releaseLocalize();
  await settle(); await settle();
  assert.equal(h.spawned.length, 0, 'stale turn never spawned');
  assert.equal(h.session._spawning, 'restart-spawn', 'the newer spawn keeps ownership');
});
