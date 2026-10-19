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

function harness(t, { realEnv = false } = {}) {
  // The spawned turn arms a 10-minute deadline + a ticker; mocked so they can't hold the process.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const spawned = [];
  let releaseLocalize;
  const localizeGate = new Promise(resolve => { releaseLocalize = resolve; });
  const filename = path.join(__dirname, 'codex-session.js');
  const realRequire = createRequire(filename);
  const mocks = {
    'node:child_process': { spawn(command, args, options) {
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
    '../codex-env': { ...realRequire('../codex-env'), buildCodexEnv: () => ({ env: { TIPATASK_API_TOKEN: 'fixture-token' } }) },
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
    }
  });
}
