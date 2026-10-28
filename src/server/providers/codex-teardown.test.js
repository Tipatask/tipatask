'use strict';

// TPT294 — a Codex turn must never be spawned for a chat that was torn down (closed) or restarted
// while the turn was still being prepared. spawnCodexTurn() awaits attachment localization before
// it spawns, which is exactly the window a kill / socket close / Restart can land in.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const throttle = require('../objective-throttle');

function harness(t, { realEnv = false, envError = false, spawnError = false } = {}) {
  // The spawned turn arms a 10-minute deadline + a ticker; mocked so they can't hold the process.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const spawned = [];
  let releaseLocalize;
  const localizeGate = new Promise(resolve => { releaseLocalize = resolve; });
  const filename = path.join(__dirname, 'codex-session.js');
  const realRequire = createRequire(filename);
  const mocks = {
    'node:child_process': { spawn(command, args, options) {
      if (spawnError) throw new Error('spawn fixture failed');
      const proc = new EventEmitter();
      proc.pid = 97000 + spawned.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.spawnArgs = { command, args, options };
      proc.stdinText = '';
      proc.stdin = { write(text) { proc.stdinText += text; }, end() {} };
      spawned.push(proc);
      return proc;
    } },
    '../codex-env': { ...realRequire('../codex-env'), buildCodexEnv: () => {
      if (envError) throw new Error('env fixture failed');
      return { env: { TIPATASK_API_TOKEN: 'fixture-token' } };
    } },
    '../../codex-mcp-config': { buildScopedCodexMcpOverride: () => 'mcp_servers={}' },
    '../claude-session': { normalizeProposals: x => x },
    './transcript': { buildTurnPrompt: (_session, opts) => ({ prompt: 'plan it', mode: opts.hasProviderSession ? 'resume' : 'fresh' }), buildNudgeMessage: () => 'nudge' },
    '../task-agent/attachments': { localizeAttachments: async ({ prompt }) => { await localizeGate; return { prompt }; } },
    '../context-manager': { shouldTrimContext: () => false, trimContext: () => false },
  };
  if (realEnv) delete mocks['../codex-env'];
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

function taskChat(h) {
  const frames = [];
  Object.assign(h.session, { type: 'taskChat', toolProfile: 'taskChat', taskKey: 'TPT1',
    codexSessionId: 'retained-thread', totalTokens: { input: 0, output: 0 },
    ws: { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) } });
  return frames;
}

const output = (proc, ...events) => proc.stdout.emit('data', Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));

for (const failure of ['capacity', 'process-error', 'exit', 'signal', 'deadline', 'idle']) {
  test(`Codex task chat ${failure} settles once and a retry owns its process`, async t => {
    const h = harness(t);
    const config = require('../config');
    if (failure === 'deadline') {
      const idleMs = config.OBJECTIVE_CODEX_STREAM_IDLE_MS;
      config.OBJECTIVE_CODEX_STREAM_IDLE_MS = config.OBJECTIVE_TURN_MAX_MS + 1;
      t.after(() => { config.OBJECTIVE_CODEX_STREAM_IDLE_MS = idleMs; });
    }
    const frames = taskChat(h);
    h.session.messages.push({ role: 'assistant', content: 'Prior reply' }, { role: 'user', content: 'Continue' });
    const history = [...h.session.messages];
    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
    h.releaseLocalize();
    await settle();
    const failed = h.spawned[0];
    const liveTurn = h.session._codexTurn;
    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
    assert.equal(h.session._codexTurn, liveTurn, 'a concurrent spawn cannot replace a live owner');
    if (failure === 'capacity') output(failed,
      { type: 'error', message: 'Model is at capacity' },
      { type: 'turn.failed', error: { message: 'Model is at capacity' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Must be ignored' } });
    else if (failure === 'process-error') failed.emit('error', new Error('ENOENT'));
    else if (failure === 'exit' || failure === 'signal') {
      failed.exitCode = failure === 'exit' ? 1 : null;
      failed.signalCode = failure === 'signal' ? 'SIGTERM' : null;
      failed.emit('close', failed.exitCode);
    } else {
      t.mock.timers.tick(failure === 'deadline' ? config.OBJECTIVE_TURN_MAX_MS : config.OBJECTIVE_CODEX_STREAM_IDLE_MS);
    }
    assert.equal(h.session.proc, null);
    assert.equal(liveTurn.proc, null, 'settled ownership does not retain the retired child');
    assert.equal(h.session._spawning, false);
    assert.equal(h.session._turnDeadlineTimer, null);
    assert.equal(h.session._idleWatchdogTimer, null);
    assert.equal(h.session._workingTicker, null);
    assert.deepEqual(h.session.messages, history, 'failed turn keeps conversation and user submission');
    assert.equal(h.session.codexSessionId, 'retained-thread');
    assert.deepEqual(frames.filter(f => ['objective-error', 'chat-ready', 'objective-result'].includes(f.type)).map(f => f.type),
      ['objective-error', 'chat-ready']);
    assert.equal(frames.find(f => f.type === 'objective-error').chatContinues, true);
    if (failure === 'deadline' || failure === 'idle') {
      assert.equal(frames.find(f => f.type === 'objective-error').reason,
        failure === 'deadline' ? 'turn-deadline' : 'stream-idle-timeout');
    }

    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
    const replacement = h.session._codexTurn;
    assert.equal(h.codex.finishFailedTaskChatTurn(h.session, { ...replacement }, () => assert.fail('not the owner')), false);
    failed.emit('close', 1);
    failed.emit('error', new Error('late error'));
    await settle();
    const retry = h.spawned[1];
    assert.equal(h.session.proc, retry, 'old close/error cannot clear the retry');
    assert.ok(h.session._turnDeadlineTimer);
    assert.equal(frames.filter(f => f.type === 'chat-ready').length, 1);
    output(retry, { type: 'item.completed', item: { type: 'agent_message', text: 'Recovered' } });
    retry.emit('close', 0);
    retry.emit('close', 0);
    assert.equal(h.session.proc, null);
    assert.equal(h.session.messages.at(-1).content, 'Recovered');
    assert.equal(replacement.proc, null);
    assert.equal(frames.filter(f => f.type === 'objective-result').length, 1);
    assert.equal(frames.filter(f => f.type === 'chat-ready').length, 2);
  });
}

// TPT9179 — 'close' waits for every stdio pipe; a descendant of the CLI can keep one open after
// the CLI exited. The exit alone must still end the turn, after a short grace.
for (const code of [0, 1]) {
  test(`Codex task chat ends its turn after an exit (${code}) whose pipes never close`, async t => {
    const h = harness(t);
    const frames = taskChat(h);
    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
    h.releaseLocalize();
    await settle();
    const proc = h.spawned[0];
    if (code === 0) output(proc, { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } }, { type: 'turn.completed', usage: {} });
    proc.exitCode = code;
    proc.emit('exit', code, null);
    t.mock.timers.tick(1999);
    assert.equal(h.session.proc, proc, 'a fresh exit still waits for close to drain stdout');
    t.mock.timers.tick(1);
    assert.equal(h.session.proc, null);
    assert.equal(h.session._spawning, false);
    assert.equal(h.session._idleWatchdogTimer, null, 'no idle timeout is left to fire later');
    const ends = () => frames.filter(f => ['objective-error', 'objective-result', 'chat-ready'].includes(f.type)).map(f => f.type);
    assert.deepEqual(ends(), code === 0 ? ['objective-result', 'chat-ready'] : ['objective-error', 'chat-ready']);
    if (code === 0) assert.equal(h.session.messages.at(-1).content, 'Answer');
    else assert.equal(frames.find(f => f.type === 'objective-error').reason, 'exit-code-1');
    proc.emit('close', code);
    assert.deepEqual(ends(), code === 0 ? ['objective-result', 'chat-ready'] : ['objective-error', 'chat-ready'], 'the late close settles nothing twice');
  });
}

test('Codex task chat: a close right after the exit settles the turn once', async t => {
  const h = harness(t);
  const frames = taskChat(h);
  h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
  h.releaseLocalize();
  await settle();
  const proc = h.spawned[0];
  output(proc, { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } });
  proc.emit('exit', 0, null);
  proc.emit('close', 0);
  t.mock.timers.tick(5000);
  assert.equal(frames.filter(f => f.type === 'objective-result').length, 1);
  assert.equal(frames.filter(f => f.type === 'chat-ready').length, 1);
});

for (const stage of ['envError', 'spawnError']) {
  test(`Codex task chat releases preparation after ${stage}`, async t => {
    const h = harness(t, { [stage]: true });
    const frames = taskChat(h);
    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
    h.releaseLocalize();
    await settle();
    assert.equal(h.session._spawning, false);
    assert.equal(h.session.proc, null);
    assert.deepEqual(frames.map(f => f.type), ['objective-error', 'chat-ready']);
  });
}

test('Stop during Codex task chat preparation invalidates the old continuation without touching a new one', async t => {
  const h = harness(t);
  taskChat(h);
  h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
  const stopped = h.session._codexTurn;
  h.session._aborted = true;
  assert.equal(h.codex.finishFailedTaskChatTurn(h.session, stopped, () => {}), true);
  h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
  assert.equal(h.codex.finishFailedTaskChatTurn(h.session, stopped, () => assert.fail('stale Stop')), false);
  assert.equal(h.session._spawning, true);
  h.releaseLocalize();
  await settle();
  assert.equal(h.spawned.length, 1, 'only the replacement reaches spawn');
  assert.equal(h.session.proc, h.spawned[0]);
});

test('Codex task chat can recover while detached without adding a successful reply', async t => {
  const h = harness(t);
  taskChat(h);
  h.session.ws = null;
  h.codex.spawnCodexTurn(h.session, 'taskChat:TPT1');
  h.releaseLocalize();
  await settle();
  output(h.spawned[0], { type: 'turn.failed', error: { message: 'Model is at capacity' } });
  h.spawned[0].emit('close', 1);
  assert.equal(h.session.proc, null);
  assert.equal(h.session._spawning, false);
  assert.equal(h.session.messages.length, 1);
  assert.equal(h.session.pendingResult, null);
  assert.equal(h.session.codexSessionId, 'retained-thread');
});

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

for (const resumed of [false, true]) {
  test(`Codex task chat spawn retains effort, credentials and tool policy (${resumed ? 'resume' : 'fresh'})`, async t => {
    const config = require('../config');
    const effort = config.OBJECTIVE_EFFORT;
    config.OBJECTIVE_EFFORT = 'max';
    t.after(() => { config.OBJECTIVE_EFFORT = effort; });
    const h = harness(t);
    Object.assign(h.session, { type: 'taskChat', toolProfile: 'taskChat', taskKey: 'TPT497',
      projectPath: '/fixture/project', codexSessionId: resumed ? 'fixture-thread' : null });
    h.codex.spawnCodexTurn(h.session, 'taskChat:TPT497');
    h.releaseLocalize();
    await settle(); await settle();
    assert.equal(h.spawned.length, 1);
    const { args, options } = h.spawned[0].spawnArgs;
    assert.equal(options.cwd, '/fixture/project');
    assert.equal(options.env.TIPATASK_API_TOKEN, 'fixture-token');
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(args.includes('mcp_servers.tipatask-local.enabled_tools=["batch_grep_tags"]'));
    assert.ok(args.includes('mcp_servers={}'));
    assert.ok(args.some(a => a.startsWith('mcp_servers.tipatask.disabled_tools=')));
    if (resumed) {
      assert.equal(args[1], 'resume');
      assert.equal(args[2], 'fixture-thread');
      assert.ok(args.includes('sandbox_mode="read-only"'));
    } else {
      assert.equal(args[args.indexOf('-s') + 1], 'read-only');
      assert.match(h.spawned[0].stdinText, /plan it/);
    }
  });
}

for (const code of ['EPERM', 'EINVAL']) {
  test(`Codex task and fresh/resumed chat reach launch with copied auth after ${code}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-auth-launch-'));
    const projectRoot = path.join(root, 'project');
    const globalHome = path.join(root, 'user-codex');
    const previous = process.env.CODEX_HOME;
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(globalHome);
    fs.writeFileSync(path.join(globalHome, 'config.toml'), '');
    const auth = '{"token":"synthetic-codex-auth"}';
    fs.writeFileSync(path.join(globalHome, 'auth.json'), auth);
    process.env.CODEX_HOME = globalHome;
    const symlink = fs.symlinkSync;
    t.mock.method(fs, 'symlinkSync', (source, target, ...args) => {
      if (path.basename(target) === 'auth.json') throw Object.assign(new Error('auth symlink denied'), { code });
      return symlink(source, target, ...args);
    });

    const CodexAgent = require('../task-agent/codex-agent');
    const spec = await new CodexAgent().getSpawnSpec({ CODEX_BIN: 'codex', PROJECT_ROOT: projectRoot, USER_DATA_ROOT: root },
      'Work on task AUTH-PROBE.', '', { projectPath: projectRoot });
    const terminalAuth = path.join(spec.env.CODEX_HOME, 'auth.json');
    assert.equal(fs.lstatSync(terminalAuth).isFile(), true);
    assert.equal(fs.readFileSync(terminalAuth, 'utf8'), auth);

    const h = harness(t, { realEnv: true });
    Object.assign(h.session, { type: 'taskChat', toolProfile: 'taskChat', projectPath: projectRoot });
    for (const resumed of [false, true]) {
      h.session.codexSessionId = resumed ? 'fixture-thread' : null;
      h.codex.spawnCodexTurn(h.session, `taskChat:auth-${code}-${resumed}`);
      h.releaseLocalize();
      await settle(); await settle();
      assert.equal(h.spawned.length, resumed ? 2 : 1, 'chat reaches process spawn without an auth error');
      const { options } = h.spawned.at(-1).spawnArgs;
      const chatAuth = path.join(options.env.CODEX_HOME, 'auth.json');
      assert.equal(fs.lstatSync(chatAuth).isFile(), true);
      assert.equal(fs.readFileSync(chatAuth, 'utf8'), auth);
      assert.equal(h.session._spawning, false);
      h.spawned.at(-1).emit('close', 0);
    }
  });
}
