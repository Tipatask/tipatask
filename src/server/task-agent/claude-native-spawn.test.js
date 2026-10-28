'use strict';

// (TPT9136) ClaudeAgent#getSpawnSpec() native permission flags: Auto launches Claude's native auto
// mode or falls back to acceptEdits, a Plan/Auto task whose project default is Bypass pre-enables
// bypass (with the CLI's acknowledgement recorded first), and the run's policy text and native
// record follow what was launched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeAgent = require('./claude-agent');

function fixture(t, { capabilities = { autoMode: true, allowBypassFlag: true, choices: ['auto'] } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-claude-spawn-'));
  const configDir = path.join(root, 'profile');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(ClaudeAgent, '_cliSupportsHeadersHelper', async () => false);
  t.mock.method(ClaudeAgent, '_cliPermissionCapabilities', async () => capabilities);
  const agent = new ClaudeAgent();
  const spawn = (mode, { source = 'task', projectDefault = null, backend } = {}) => agent.getSpawnSpec({
    CLAUDE_BIN: 'claude', SIMPLE_MODE: true, PROJECT_ROOT: projectRoot, USER_DATA_ROOT: root,
  }, 'Work on task TPT1.', 'TPT1', {
    projectPath: projectRoot,
    permissionPolicy: agent.buildPermissionPolicy({ mode, source }),
    backend: backend || { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: projectDefault } }) },
  });
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return { root, configDir, projectRoot, agent, spawn, read };
}

const flag = (spec) => spec.args[spec.args.indexOf('--permission-mode') + 1];

test('each launch mode gets its native flag, and Auto is native auto when the CLI offers it', async (t) => {
  const { spawn } = fixture(t);
  const expected = { plan: 'plan', auto: 'auto', bypass: 'bypassPermissions' };
  for (const mode of ['plan', 'auto', 'bypass']) {
    const spec = await spawn(mode);
    assert.equal(flag(spec), expected[mode], mode);
    assert.equal(spec.args.includes('--allow-dangerously-skip-permissions'), false, mode);
    assert.deepEqual(spec.nativePermission, {
      launch: expected[mode], auto: 'auto', autoReason: null, bypass: mode === 'bypass',
      bypassReason: mode === 'bypass' ? null : 'project', preEnableBypass: false,
    });
    assert.equal(spec.permissionPolicy.mode, mode);
    assert.equal(spec.permissionPolicy.nativeAuto, 'auto');
  }
  const auto = await spawn('auto');
  assert.match(auto.initialPrompt, /Permission policy for this run \(auto\):\nAuto mode: Claude Code's native auto mode is on/);
  assert.doesNotMatch(auto.initialPrompt, /allow \/ allow-all \/ deny/);
});

// One fixture (and one set of method mocks) per subtest: mocking the same method twice in one
// test would leave the first mock in place after the test.
test('Auto falls back to acceptEdits when the CLI lacks auto mode, settings disable it or the account gate is closed', async (t) => {
  await t.test('CLI without auto mode', async (t) => {
    const { spawn } = fixture(t, { capabilities: { autoMode: false, allowBypassFlag: true } });
    const spec = await spawn('auto');
    assert.equal(flag(spec), 'acceptEdits');
    assert.equal(spec.nativePermission.autoReason, 'cli');
    assert.match(spec.initialPrompt, /native allow \/ allow-all \/ deny permission dialog/);
    assert.equal(spec.permissionPolicy.nativeAuto, 'acceptEdits');
  });
  await t.test('project settings disable it', async (t) => {
    const { spawn, projectRoot } = fixture(t);
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }));
    const spec = await spawn('auto');
    assert.deepEqual([flag(spec), spec.nativePermission.autoReason], ['acceptEdits', 'settings']);
  });
  await t.test('the cached account gate is closed', async (t) => {
    const { spawn, configDir } = fixture(t);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: { tengu_auto_mode_config: { enabled: 'disabled' } } }));
    const spec = await spawn('auto');
    assert.deepEqual([flag(spec), spec.nativePermission.autoReason], ['acceptEdits', 'account']);
    // writeProjectClaudeTrust() keeps the cached gate while adding project trust.
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')).cachedGrowthBookFeatures.tengu_auto_mode_config.enabled, 'disabled');
  });
});

test('a Plan/Auto task in a Bypass-default project pre-enables bypass and records the acknowledgement first', async (t) => {
  const { spawn, configDir, read } = fixture(t);
  for (const mode of ['plan', 'auto']) {
    const spec = await spawn(mode, { projectDefault: 'bypass' });
    assert.equal(flag(spec), mode === 'plan' ? 'plan' : 'auto');
    assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 2], '--allow-dangerously-skip-permissions');
    assert.equal(spec.nativePermission.preEnableBypass, true);
    assert.equal(spec.nativePermission.bypass, true);
  }
  assert.equal(read(path.join(configDir, '.claude.json')).bypassPermissionsModeAccepted, true);
  assert.equal(read(path.join(configDir, 'settings.json')).skipDangerousModePermissionPrompt, true);
  // Planning launches and inherited non-Bypass defaults never pre-enable it.
  for (const [mode, opts] of [['plan', { source: 'planning', projectDefault: 'bypass' }], ['auto', { source: 'project', projectDefault: 'auto' }], ['auto', { projectDefault: 'plan' }]]) {
    const spec = await spawn(mode, opts);
    assert.equal(spec.args.includes('--allow-dangerously-skip-permissions'), false, JSON.stringify(opts));
  }
});

test('no acknowledgement, no pre-enabled bypass: a failed consent write keeps the flag off', async (t) => {
  const { spawn, configDir } = fixture(t);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), '{malformed');
  t.mock.method(console, 'warn', () => {});
  const spec = await spawn('auto', { projectDefault: 'bypass' });
  assert.equal(spec.args.includes('--allow-dangerously-skip-permissions'), false);
  assert.deepEqual([spec.nativePermission.bypass, spec.nativePermission.bypassReason], [false, 'consent']);
  assert.equal(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'), '{malformed', 'malformed user state is never replaced');
  assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
});

test('the help probe is shared by effort and permission capabilities and survives a missing binary', async () => {
  const missing = await ClaudeAgent._cliHelpText({ CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude-binary') });
  assert.equal(missing, null);
  assert.deepEqual(await ClaudeAgent._cliPermissionCapabilities({ CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude-binary') }),
    { choices: [], autoMode: false, allowBypassFlag: false });
  assert.equal(await ClaudeAgent._cliSupportsEffortFlag({ CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude-binary') }), false);
});
