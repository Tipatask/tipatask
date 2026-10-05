'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Teardown guards in the non-Claude objective providers (TPT294): a torn-down chat (_closed, set by
// teardownObjectiveSession) never spawns a turn and frees any throttle slot a queue drain granted
// the call; Codex's async pre-spawn work and nudge never outlive a teardown/restart (_epoch bump).
// Each provider module runs in a vm sandbox with fake child processes and a spy throttle.
function loadProvider(file, { localize } = {}) {
  const spawned = [];
  const aborts = [];
  const filename = path.join(__dirname, file);
  const realRequire = createRequire(filename);
  const config = { ...require('../config'), OBJECTIVE_TIMING_ENABLED: false, OBJECTIVE_MAX_NUDGES: 2 };
  const mocks = {
    '../config': config,
    '../objective-throttle': {
      recordAbort: id => aborts.push(id),
      recordTimeout() {},
      recordSuccess() {},
      watchTurn: () => () => {},
    },
    '../claude-session': { normalizeProposals: x => x },
    '../../codex-mcp-config': { buildScopedCodexMcpOverride: () => 'mcp_servers={}' },
    '../codex-env': { buildCodexEnv: () => ({ env: {} }), codexEffortArgs: () => [], toCodexEffort: level => level },
    '../context-manager': { shouldTrimContext: () => false, trimContext() {} },
    '../task-agent/attachments': {
      localizeAttachments: localize || (async ({ prompt }) => ({ prompt })),
    },
    './transcript': {
      buildTurnPrompt: () => ({ prompt: 'PROMPT', mode: 'fresh' }),
      buildNudgeMessage: () => 'NUDGE',
    },
    'node:child_process': { spawn() {
      const proc = new EventEmitter();
      proc.pid = 92000 + spawned.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      spawned.push(proc);
      return proc;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log() {}, warn() {}, error() {} },
    process: Object.create(process, { kill: { value() {} } }),
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer, JSON,
  }, { filename });
  return { mod: module.exports, spawned, aborts };
}

function makeSession(extra = {}) {
  return {
    tabId: 'obj-tpt294', type: 'objective', projectPath: path.join(__dirname, '..', '..', '..'),
    messages: [{ role: 'user', content: 'Plan', timestamp: 0 }],
    timingMilestones: {}, totalTokens: { input: 0, output: 0 }, ws: null,
    _closed: false, _epoch: 0, ...extra,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

for (const [file, fn] of [
  ['codex-session.js', 'spawnCodexTurn'],
  ['gemini-session.js', 'spawnGeminiTurn'],
  ['pi-session.js', 'spawnPiTurn'],
]) {
  test(`${fn} on a closed session spawns nothing and frees its throttle slot`, async () => {
    const h = loadProvider(file);
    const session = makeSession({ _closed: true });
    h.mod[fn](session, 'obj-tpt294', () => {});
    await flush();
    assert.equal(h.spawned.length, 0, 'no CLI proc for a torn-down chat');
    assert.deepEqual(h.aborts, ['obj-tpt294'], 'the slot a drain granted this call is released once');
    assert.equal(session._spawning, undefined, 'a closed session is not marked spawning');
  });
}

test('codex: a teardown during the attachment-localize await never spawns the stale turn', async () => {
  let release;
  const h = loadProvider('codex-session.js', {
    localize: ({ prompt }) => new Promise(resolve => { release = () => resolve({ prompt }); }),
  });
  const session = makeSession();
  h.mod.spawnCodexTurn(session, 'obj-tpt294');
  assert.equal(session._spawning, true, 'in-flight guard is set before the await');

  // teardownObjectiveSession: closes, bumps the epoch and resets _spawning itself.
  session._closed = true;
  session._epoch += 1;
  session._spawning = false;
  release();
  await flush();

  assert.equal(h.spawned.length, 0, 'the stale turn is never spawned');
  assert.deepEqual(h.aborts, [], 'teardown owns the throttle slot — the stale continuation must not touch it');
  assert.equal(session._spawning, false);
});

test('codex: a restart during the localize await leaves the replacement turn\'s _spawning alone', async () => {
  let release;
  const h = loadProvider('codex-session.js', {
    localize: ({ prompt }) => new Promise(resolve => { release = () => resolve({ prompt }); }),
  });
  const session = makeSession();
  h.mod.spawnCodexTurn(session, 'obj-tpt294');
  session._epoch += 1;       // clearContext() for a restart — session stays open
  session._spawning = true;  // the restart's own spawn is now underway
  release();
  await flush();
  assert.equal(h.spawned.length, 0);
  assert.equal(session._spawning, true, 'the restart\'s in-flight flag is not cleared by the stale turn');
});

test('codex: a nudge scheduled before a teardown never spawns', async () => {
  const h = loadProvider('codex-session.js');
  const session = makeSession();
  h.mod.spawnCodexTurn(session, 'obj-tpt294');
  await flush();
  assert.equal(h.spawned.length, 1);

  const proc = h.spawned[0];
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Prose only, no json block.' } });
  proc.stdout.emit('data', Buffer.from(`${line}\n`));
  proc.emit('close', 0); // prose-only answer → finalize schedules a nudge via setImmediate
  assert.equal(session._nudgeAttempt, 1, 'the nudge was scheduled');

  session._closed = true;
  session._epoch += 1;
  await flush();
  await flush();
  assert.equal(h.spawned.length, 1, 'the nudge bails on the epoch change');
});

test('codex: a nudge with no teardown in between still spawns (guard is epoch-scoped)', async () => {
  const h = loadProvider('codex-session.js');
  const session = makeSession();
  h.mod.spawnCodexTurn(session, 'obj-tpt294');
  await flush();
  const proc = h.spawned[0];
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Prose only.' } });
  proc.stdout.emit('data', Buffer.from(`${line}\n`));
  proc.emit('close', 0);
  await flush();
  await flush();
  assert.equal(h.spawned.length, 2, 'the nudge turn spawns');
  // Leave no live timers behind: close the nudge proc too.
  h.spawned[1].emit('close', 1);
});
