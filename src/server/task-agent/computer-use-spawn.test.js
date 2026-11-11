'use strict';

// (TPT9225) ClaudeAgent and computer use: detectComputerUse() asks the CLI bundle for its
// computer-use server, and getSpawnSpec() turns an available answer (opts.computerUse) into the
// CLI's per-project switch, --allowedTools for the launch mode, the plan-mode hook in --settings
// and the kickoff directive — never a `computer-use` entry in the derived MCP config (the CLI
// reserves that name). See ai/architecture/tt-task-agent.md § Computer Use.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The account store defaults to USER_DATA_ROOT; keep this file's writes in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cu-spawn-userdata-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));
const ClaudeAgent = require('./claude-agent');
const PiAgent = require('./pi-agent');
const { resolveComputerUse, claudePlanHookSettings, claudeAllowedTools, PLAN_TOOLS } = require('../computer-use');

const CLAUDE = '/opt/claude/bin/claude';
const AVAILABLE = resolveComputerUse('claude', 'darwin', { command: CLAUDE, serverSupported: true });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cu-spawn-')));
  const configDir = path.join(root, 'profile');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: 'https://api.test', API_PROJECT_ID: '2' }));
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {
    tipatask: { type: 'http', url: 'https://api.test/api/projects/2/mcp', headers: { Authorization: '' } },
    'tipatask-local': { command: '/bin/local' },
  } }));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ images: [], files: [] }) }));
  t.mock.method(ClaudeAgent, '_cliSupportsHeadersHelper', async () => true);
  t.mock.method(ClaudeAgent, '_cliPermissionCapabilities', async () => ({ autoMode: true, allowBypassFlag: true, choices: ['auto'] }));
  const agent = new ClaudeAgent();
  const spawn = (mode, computerUse) => agent.getSpawnSpec({
    CLAUDE_BIN: CLAUDE, SIMPLE_MODE: true, PROJECT_ROOT: projectRoot, USER_DATA_ROOT: root,
  }, 'Work on task TPT1.', 'TPT1', {
    projectPath: projectRoot,
    ...(mode !== undefined ? { permissionPolicy: agent.buildPermissionPolicy({ mode, source: 'task' }) } : {}),
    backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: null } }) },
    ...(computerUse !== undefined ? { computerUse } : {}),
  });
  const enabled = () => {
    try { return JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')).projects?.[projectRoot]?.enabledMcpServers || []; }
    catch { return []; }
  };
  return { root, configDir, projectRoot, agent, spawn, enabled };
}

const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const settingsOf = (spec) => {
  const values = flagValues(spec.args, '--settings');
  assert.ok(values.length <= 1, 'one --settings flag');
  return values.length ? JSON.parse(values[0]) : null;
};
const derivedServers = (spec) => JSON.parse(fs.readFileSync(flagValues(spec.args, '--mcp-config')[0], 'utf8')).mcpServers;
const count = (text, needle) => text.split(needle).length - 1;

test('Auto and Bypass: switch on, the whole server allowed, the plan hook merged into --settings, directive once', async (t) => {
  const { spawn, enabled } = fixture(t);
  for (const mode of ['auto', 'bypass']) {
    const spec = await spawn(mode, AVAILABLE);
    assert.deepEqual(flagValues(spec.args, '--allowedTools'), ['mcp__computer-use'], mode);
    assert.deepEqual(flagValues(spec.args, '--disallowedTools'), []);
    assert.deepEqual(settingsOf(spec), { ...claudePlanHookSettings(), preferredNotifChannel: 'terminal_bell' },
      'the hook and the attention bell share one --settings');
    assert.equal(count(spec.initialPrompt, 'Computer use:'), 1);
    assert.match(spec.initialPrompt, /`mcp__computer-use__\*`/);
    assert.match(spec.initialPrompt, /Never quit, restart or close the live TipATask app/);
    assert.doesNotMatch(spec.initialPrompt, /Plan mode the computer-use tools only look/, 'no Plan line outside planning');
  }
  assert.deepEqual(enabled(), ['computer-use'], 'the CLI switch, written once');
});

test('Plan: only the observation tools are allowed, the hook holds the rest, the kickoff says so', async (t) => {
  const { spawn, enabled } = fixture(t);
  for (const mode of ['plan', null]) {
    const spec = await spawn(mode, AVAILABLE);
    const [allowed] = flagValues(spec.args, '--allowedTools');
    assert.deepEqual(allowed.split(','), PLAN_TOOLS.map((tool) => `mcp__computer-use__${tool}`), String(mode));
    assert.equal(allowed, claudeAllowedTools(mode).join(','));
    assert.ok(!allowed.split(',').includes('mcp__computer-use__left_click'));
    assert.deepEqual(settingsOf(spec).hooks, claudePlanHookSettings().hooks);
    assert.equal(count(spec.initialPrompt, 'Computer use:'), 1);
    assert.match(spec.initialPrompt, /While this run is in Plan mode the computer-use tools only look: take screenshots/);
  }
  assert.deepEqual(enabled(), ['computer-use']);
});

test('the derived MCP config never carries a computer-use entry: the CLI reserves that name', async (t) => {
  const { spawn, root } = fixture(t);
  const spec = await spawn('bypass', AVAILABLE);
  const mcpConfig = flagValues(spec.args, '--mcp-config')[0];
  assert.ok(mcpConfig.startsWith(path.join(root, 'mcp-spawn') + path.sep), 'the derived config is in use');
  assert.ok(spec.args.includes('--strict-mcp-config'));
  assert.deepEqual(Object.keys(derivedServers(spec)).sort(), ['tipatask', 'tipatask-local']);
  assert.ok(!spec.args.some((a) => a.includes('--computer-use-mcp')), 'the server itself is never on the command line');
});

test('no answer, or an unavailable one: the spawn is unchanged and nothing is switched on', async (t) => {
  const { spawn, enabled } = fixture(t);
  const baseline = await spawn('bypass');
  for (const computerUse of [undefined, null, resolveComputerUse('claude', 'linux'),
    resolveComputerUse('claude', 'darwin', { command: CLAUDE, serverSupported: false })]) {
    const spec = await spawn('bypass', computerUse);
    assert.deepEqual(spec.args, baseline.args, JSON.stringify(computerUse));
    assert.deepEqual(settingsOf(spec), { preferredNotifChannel: 'terminal_bell' });
    assert.doesNotMatch(spec.initialPrompt, /Computer use:|computer-use/);
  }
  assert.deepEqual(enabled(), []);
});

test('Plan with hooks turned off in settings: the server is denied for the run and the kickoff says nothing', async (t) => {
  const { spawn, enabled, projectRoot } = fixture(t);
  fs.mkdirSync(path.join(projectRoot, '.claude'));
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  const plan = await spawn('plan', AVAILABLE);
  assert.deepEqual(flagValues(plan.args, '--disallowedTools'), ['mcp__computer-use']);
  assert.deepEqual(flagValues(plan.args, '--allowedTools'), []);
  assert.deepEqual(settingsOf(plan), { preferredNotifChannel: 'terminal_bell' });
  assert.doesNotMatch(plan.initialPrompt, /Computer use:/);
  assert.deepEqual(enabled(), [], 'not switched on for a run that cannot use it');
  // Bypass never runs in plan mode, so the same settings leave it alone.
  const bypass = await spawn('bypass', AVAILABLE);
  assert.deepEqual(flagValues(bypass.args, '--allowedTools'), ['mcp__computer-use']);
  assert.match(bypass.initialPrompt, /Computer use:/);
});

test('a switch that cannot be written starts the run without computer use', async (t) => {
  const { spawn, configDir } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), '{malformed');
  const spec = await spawn('bypass', AVAILABLE);
  assert.deepEqual(flagValues(spec.args, '--allowedTools'), []);
  assert.deepEqual(settingsOf(spec), { preferredNotifChannel: 'terminal_bell' });
  assert.doesNotMatch(spec.initialPrompt, /Computer use:/);
  assert.equal(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'), '{malformed');
});

// ── detectComputerUse() ──

test('detectComputerUse: off macOS it answers without reading the CLI', async (t) => {
  const probe = t.mock.method(ClaudeAgent, '_cliSupportsComputerUse', async () => { throw new Error('must not probe'); });
  for (const platform of ['linux', 'win32']) {
    const cu = await new ClaudeAgent().detectComputerUse({ CLAUDE_BIN: CLAUDE }, { platform });
    assert.equal(cu.available, false);
    assert.equal(cu.reasonCode, 'platform');
  }
  assert.equal(probe.mock.callCount(), 0);
});

test('detectComputerUse: on macOS the bundle probe decides', async (t) => {
  await t.test('server present', async (t) => {
    t.mock.method(ClaudeAgent, '_cliSupportsComputerUse', async () => true);
    assert.deepEqual(await new ClaudeAgent().detectComputerUse({ CLAUDE_BIN: CLAUDE }, { platform: 'darwin' }), AVAILABLE);
  });
  await t.test('server absent', async (t) => {
    t.mock.method(ClaudeAgent, '_cliSupportsComputerUse', async () => false);
    const cu = await new ClaudeAgent().detectComputerUse({ CLAUDE_BIN: CLAUDE }, { platform: 'darwin' });
    assert.deepEqual([cu.available, cu.reasonCode], [false, 'server']);
  });
});

test('Pi detection uses the same native runtime as Codex', async t => {
  const runtime = require('../computer-use-runtime');
  const capability = { available: false, reasonCode: 'runtime' };
  t.mock.method(runtime, 'detectDesktop', async () => capability);
  assert.equal(await new PiAgent().detectComputerUse({}), capability);
});

// ── CLI bundle probe ──

test('_scanFileForStrings: finds every needle, across chunk boundaries, and stops at the first full match', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cu-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.bin');
  // `--computer-use-mcp` straddles the first 4MB chunk boundary; `headersHelper` sits in the second chunk.
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 7, 0x61), Buffer.from('--computer-use-mcp'),
    Buffer.alloc(1024, 0x62), Buffer.from('headersHelper'), Buffer.alloc(1024, 0x63)]));
  assert.deepEqual([...await ClaudeAgent._scanFileForStrings(file, ['headersHelper', '--computer-use-mcp'])].sort(), ['--computer-use-mcp', 'headersHelper']);
  assert.deepEqual([...await ClaudeAgent._scanFileForStrings(file, ['headersHelper', 'absent-needle'])], ['headersHelper']);
  assert.equal(await ClaudeAgent._scanFileForString(file, '--computer-use-mcp'), true);
});

test('_cliBundleFeatures: one scan answers both capabilities; a failed scan reads as neither and is retried', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cu-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const both = path.join(dir, 'both.bin');
  const older = path.join(dir, 'older.bin');
  fs.writeFileSync(both, 'xx headersHelper xx --computer-use-mcp xx');
  fs.writeFileSync(older, 'xx headersHelper only, a longer file xx');
  const scan = t.mock.method(ClaudeAgent, '_scanFileForStrings');
  assert.deepEqual(await ClaudeAgent._cliBundleFeatures({ CLAUDE_BIN: both }), { headersHelper: true, computerUse: true });
  assert.equal(await ClaudeAgent._cliSupportsComputerUse({ CLAUDE_BIN: both }), true);
  assert.equal(await ClaudeAgent._cliSupportsHeadersHelper({ CLAUDE_BIN: both }), true);
  assert.equal(scan.mock.callCount(), 1, 'memoized per binary');
  assert.deepEqual(await ClaudeAgent._cliBundleFeatures({ CLAUDE_BIN: older }), { headersHelper: true, computerUse: false });
  t.mock.method(console, 'log', () => {});
  const missing = path.join(dir, 'missing.bin');
  assert.deepEqual(await ClaudeAgent._cliBundleFeatures({ CLAUDE_BIN: missing }), { headersHelper: false, computerUse: false });
  const calls = scan.mock.callCount();
  await ClaudeAgent._cliBundleFeatures({ CLAUDE_BIN: missing });
  assert.equal(scan.mock.callCount(), calls + 1, 'a failure is not cached');
});
