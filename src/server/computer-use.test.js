'use strict';

// (TPT9225) computer-use.js: the shared resolver for every provider and platform, and the Claude
// side — the CLI's per-project switch, its project key, the hook that holds Plan to screenshots and
// one launch's flags. See ai/architecture/tt-task-agent.md § Computer Use.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  SERVER_NAME, PLAN_TOOLS, REASONS, PLAN_DENY_REASON,
  resolveComputerUse, claudeUserConfigPath, claudeProjectKey, enableClaudeComputerUse,
  claudePlanHookCommand, claudePlanHookSettings, claudeAllowedTools, claudeHooksBlocked, claudeComputerUseLaunch,
} = require('./computer-use');

const CLAUDE = '/Users/someone/.local/bin/claude';

function scratch(t, prefix = 'tt-cu-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A private Claude profile + managed-settings dir, so nothing reads or writes the real ones.
function claudeHome(t) {
  const root = scratch(t, 'tt-cu-home-');
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'profile') };
  return { root, env, managedDir: path.join(root, 'managed'), configFile: path.join(root, 'profile', '.claude.json') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ── resolveComputerUse ──

test('Claude built-in remains available; standalone Codex/Pi registrations are rejected', () => {
  assert.equal(resolveComputerUse('claude', 'darwin', { command: CLAUDE, serverSupported: true }).available, true);
  for (const provider of ['codex', 'pi']) {
    const result = resolveComputerUse(provider, 'darwin', { command: CLAUDE, serverSupported: true });
    assert.equal(result.available, false);
    assert.equal(result.reasonCode, 'session');
    assert.match(result.reason, /no session-bound app permissions/);
  }
});

test('resolveComputerUse: win32 and linux are unavailable for every provider, whatever the CLI', () => {
  for (const platform of ['win32', 'linux']) {
    for (const provider of ['claude', 'codex', 'pi']) {
      const cu = resolveComputerUse(provider, platform, { command: CLAUDE, serverSupported: true });
      assert.deepEqual(cu, { available: false, provider, reasonCode: 'platform', reason: REASONS.platform }, `${provider} on ${platform}`);
    }
  }
});

test('resolveComputerUse: no CLI, a relative command or a CLI without the server is unavailable', () => {
  for (const facts of [{}, { command: CLAUDE }, { command: CLAUDE, serverSupported: false }, { command: 'claude', serverSupported: true },
    { command: null, serverSupported: true }, { command: CLAUDE, serverSupported: 'yes' }]) {
    const cu = resolveComputerUse('claude', 'darwin', facts);
    assert.equal(cu.available, false, JSON.stringify(facts));
    assert.equal(cu.reasonCode, 'server');
    assert.match(cu.reason, /claude --computer-use-mcp/);
  }
  assert.equal(resolveComputerUse('claude', 'darwin').reasonCode, 'server');
});

test('resolveComputerUse: an unknown provider is unavailable before anything else is looked at', () => {
  assert.deepEqual(resolveComputerUse('gemini', 'darwin', { command: CLAUDE, serverSupported: true }),
    { available: false, provider: 'gemini', reasonCode: 'provider', reason: REASONS.provider });
  assert.equal(resolveComputerUse(undefined, 'win32').reasonCode, 'provider');
  assert.equal(resolveComputerUse(undefined, 'win32').provider, null);
});

test('resolveComputerUse: answers are frozen', () => {
  const cu = resolveComputerUse('claude', 'darwin', { command: CLAUDE, serverSupported: true });
  assert.ok(Object.isFrozen(cu) && Object.isFrozen(cu.server) && Object.isFrozen(cu.server.args) && Object.isFrozen(cu.planTools));
  assert.ok(Object.isFrozen(resolveComputerUse('claude', 'linux')));
});

// ── Claude: project key and switch ──

test('claudeUserConfigPath: $CLAUDE_CONFIG_DIR, else the home dir', () => {
  assert.equal(claudeUserConfigPath({ CLAUDE_CONFIG_DIR: '/x/profile' }), path.join('/x/profile', '.claude.json'));
  assert.equal(claudeUserConfigPath({}), path.join(os.homedir(), '.claude.json'));
});

test('claudeProjectKey: canonical git root, a linked worktree maps to its main repository, else the resolved dir', (t) => {
  const root = fs.realpathSync(scratch(t));
  const plain = path.join(root, 'plain', 'nested');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(claudeProjectKey(plain), plain, 'no git repository: the dir itself');

  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(claudeProjectKey(repo), repo);
  assert.equal(claudeProjectKey(path.join(repo, 'src', 'deep')), repo, 'a subdirectory files under its repository root');
  assert.equal(claudeProjectKey(path.join(repo, 'src', '..')), repo, 'resolved before the walk');

  const worktree = path.join(root, 'checkouts', 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  assert.equal(claudeProjectKey(worktree), repo, 'a linked worktree shares its main repository\'s key');

  const submodule = path.join(repo, 'vendor', 'mod');
  fs.mkdirSync(path.join(repo, '.git', 'modules', 'mod'), { recursive: true });
  fs.mkdirSync(submodule, { recursive: true });
  fs.writeFileSync(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/mod\n');
  assert.equal(claudeProjectKey(submodule), submodule, 'a submodule (no commondir) is its own root');

  const broken = path.join(root, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'not a pointer');
  assert.equal(claudeProjectKey(broken), broken);
});

test('enableClaudeComputerUse: adds the server to the project entry, keeps the rest, writes once', (t) => {
  const { env, configFile } = claudeHome(t);
  const project = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const before = {
    numStartups: 7,
    projects: {
      '/other': { enabledMcpServers: ['x'] },
      [project]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'], enabledMcpServers: ['pencil'] },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(before), { mode: 0o640 });
  fs.chmodSync(configFile, 0o640);

  assert.equal(enableClaudeComputerUse(project, { env }), true);
  const after = readJson(configFile);
  assert.deepEqual(after.projects[project], { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'], enabledMcpServers: ['pencil', SERVER_NAME] });
  assert.deepEqual(after.projects['/other'], before.projects['/other']);
  assert.equal(after.numStartups, 7);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o640, 'the file keeps its mode');

  const written = fs.readFileSync(configFile, 'utf8');
  const mtime = fs.statSync(configFile).mtimeMs;
  assert.equal(enableClaudeComputerUse(project, { env }), true, 'already on');
  assert.equal(fs.readFileSync(configFile, 'utf8'), written);
  assert.equal(fs.statSync(configFile).mtimeMs, mtime, 'no write when the switch is already on');
  assert.deepEqual(fs.readdirSync(path.dirname(configFile)), ['.claude.json'], 'no temp file left behind');
});

test('enableClaudeComputerUse: a missing file or project entry is created under the canonical key', (t) => {
  const { env, configFile } = claudeHome(t);
  const repo = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'app'));
  assert.equal(enableClaudeComputerUse(path.join(repo, 'app'), { env }), true);
  assert.deepEqual(readJson(configFile), { projects: { [repo]: { enabledMcpServers: [SERVER_NAME] } } });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test('enableClaudeComputerUse: malformed state is never replaced', (t) => {
  const project = fs.realpathSync(scratch(t));
  t.mock.method(console, 'warn', () => {});
  for (const content of ['{malformed', '[]', JSON.stringify({ projects: [] }), JSON.stringify({ projects: { [project]: 'x' } }),
    JSON.stringify({ projects: { [project]: { enabledMcpServers: 'computer-use' } } })]) {
    const { env, configFile } = claudeHome(t);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, content);
    assert.equal(enableClaudeComputerUse(project, { env }), false, content);
    assert.equal(fs.readFileSync(configFile, 'utf8'), content);
  }
  assert.ok(console.warn.mock.callCount() > 0);
});

// ── Claude: allowed tools and the plan hook ──

test('claudeAllowedTools: the whole server in Auto and Bypass, the observation tools when planning', () => {
  assert.deepEqual(claudeAllowedTools('auto'), ['mcp__computer-use']);
  assert.deepEqual(claudeAllowedTools('bypass'), ['mcp__computer-use']);
  const plan = PLAN_TOOLS.map((tool) => `mcp__computer-use__${tool}`);
  assert.deepEqual(claudeAllowedTools('plan'), plan);
  assert.deepEqual(claudeAllowedTools(null), plan, 'a legacy run without a mode plans first');
  assert.ok(plan.includes('mcp__computer-use__screenshot'));
  for (const action of ['left_click', 'type', 'key', 'open_application', 'computer_batch']) {
    assert.ok(!PLAN_TOOLS.includes(action), `${action} is not a Plan tool`);
  }
});

test('claudePlanHookSettings: one PreToolUse matcher for every computer-use tool', () => {
  const settings = claudePlanHookSettings();
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  const [entry] = settings.hooks.PreToolUse;
  assert.equal(entry.matcher, 'mcp__computer-use__.*');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: claudePlanHookCommand(), timeout: 10 }]);
  assert.doesNotMatch(PLAN_DENY_REASON, /'/, 'the reason sits inside a single-quoted shell word');
});

const hookInput = (mode, tool, input = {}, space) => JSON.stringify({
  session_id: 's', transcript_path: '/t.jsonl', cwd: '/p', permission_mode: mode,
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1',
}, null, space);
const runHook = (input) => execFileSync('/bin/sh', ['-c', claudePlanHookCommand()], { input, encoding: 'utf8' });
const deniedBy = (output) => {
  if (!output) return null;
  const decision = JSON.parse(output).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  return decision.permissionDecision === 'deny' ? decision.permissionDecisionReason : null;
};

test('plan hook: in plan mode it denies every computer-use tool but the observation ones', { skip: process.platform === 'win32' }, () => {
  for (const tool of ['left_click', 'type', 'key', 'scroll', 'open_application', 'computer_batch', 'app_click', 'write_clipboard', 'some_future_tool']) {
    assert.equal(deniedBy(runHook(hookInput('plan', `mcp__computer-use__${tool}`))), PLAN_DENY_REASON, tool);
  }
  for (const tool of PLAN_TOOLS) {
    assert.equal(runHook(hookInput('plan', `mcp__computer-use__${tool}`)), '', tool);
  }
  // Pretty-printed input matches too.
  assert.equal(deniedBy(runHook(hookInput('plan', 'mcp__computer-use__left_click', {}, 2))), PLAN_DENY_REASON);
  assert.equal(runHook(hookInput('plan', 'mcp__computer-use__screenshot', {}, 2)), '');
});

test('plan hook: any other mode, and text that only quotes plan mode, pass untouched', { skip: process.platform === 'win32' }, () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']) {
    assert.equal(runHook(hookInput(mode, 'mcp__computer-use__left_click')), '', mode);
  }
  // Typed text is a JSON string: its quotes are escaped, so it cannot pass for either field.
  assert.equal(runHook(hookInput('auto', 'mcp__computer-use__type', { text: '"permission_mode":"plan"' })), '');
  assert.equal(deniedBy(runHook(hookInput('plan', 'mcp__computer-use__type', { text: '"tool_name":"mcp__computer-use__screenshot"' }))),
    PLAN_DENY_REASON, 'a quoted tool name cannot exempt a call');
  assert.equal(runHook(''), '');
  assert.equal(runHook('not json'), '');
});

// ── Claude: one launch ──

function launchFixture(t) {
  const home = claudeHome(t);
  const project = fs.realpathSync(scratch(t));
  const available = resolveComputerUse('claude', 'darwin', { command: CLAUDE, serverSupported: true });
  const launch = (mode, computerUse = available) => claudeComputerUseLaunch(computerUse, { mode, projectRoot: project, env: home.env, platform: 'darwin', managedDir: home.managedDir });
  const enabled = () => {
    try { return readJson(home.configFile).projects?.[project]?.enabledMcpServers || []; } catch { return []; }
  };
  return { ...home, project, available, launch, enabled };
}

test('claudeComputerUseLaunch: turns the switch on, allows by mode, and always adds the plan hook', (t) => {
  const f = launchFixture(t);
  for (const mode of ['auto', 'bypass', 'plan', null]) {
    const out = f.launch(mode);
    assert.equal(out.computerUse, f.available, String(mode));
    assert.deepEqual(out.args, ['--allowedTools', claudeAllowedTools(mode).join(',')]);
    assert.deepEqual(out.settings, claudePlanHookSettings());
  }
  assert.deepEqual(f.enabled(), [SERVER_NAME]);
});

test('claudeComputerUseLaunch: nothing for an unavailable answer, another provider or none', (t) => {
  const f = launchFixture(t);
  const linux = resolveComputerUse('claude', 'linux');
  assert.deepEqual(f.launch('bypass', linux), { computerUse: linux, args: [], settings: null });
  const pi = resolveComputerUse('pi', 'darwin', { command: CLAUDE, serverSupported: true });
  assert.deepEqual(f.launch('bypass', pi), { computerUse: pi, args: [], settings: null });
  assert.deepEqual(f.launch('bypass', null), { computerUse: null, args: [], settings: null });
  assert.deepEqual(claudeComputerUseLaunch(undefined, { mode: 'bypass', projectRoot: f.project, env: f.env }), { computerUse: null, args: [], settings: null });
  assert.deepEqual(f.enabled(), [], 'the switch stays off');
});

test('claudeComputerUseLaunch: a planning launch with hooks off is held closed for the whole run', (t) => {
  for (const [where, settings] of [['user', { disableAllHooks: true }], ['project', { allowManagedHooksOnly: true }], ['managed', { disableAllHooks: true }]]) {
    const f = launchFixture(t);
    const file = { user: path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), project: path.join(f.project, '.claude', 'settings.local.json'),
      managed: path.join(f.managedDir, 'managed-settings.json') }[where];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.equal(claudeHooksBlocked(f.project, { env: f.env, platform: 'darwin', managedDir: f.managedDir }), true, where);
    for (const mode of ['plan', null]) {
      const out = f.launch(mode);
      assert.equal(out.computerUse.available, false);
      assert.equal(out.computerUse.reasonCode, 'hooks');
      assert.deepEqual(out.args, ['--disallowedTools', 'mcp__computer-use'], 'even a server the user turned on stays off');
      assert.equal(out.settings, null);
    }
    assert.deepEqual(f.enabled(), [], 'the switch is not turned on for a run that cannot use it');
    // Auto and Bypass never run in plan mode: hooks off changes nothing for them.
    assert.equal(f.launch('auto').computerUse, f.available);
    assert.equal(f.launch('bypass').computerUse, f.available);
  }
});

test('claudeHooksBlocked: hooks on, or an unreadable settings file, do not block', (t) => {
  const f = launchFixture(t);
  assert.equal(claudeHooksBlocked(f.project, { env: f.env, platform: 'darwin', managedDir: f.managedDir }), false);
  fs.mkdirSync(f.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{oops');
  fs.mkdirSync(path.join(f.project, '.claude'));
  fs.writeFileSync(path.join(f.project, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: false, hooks: {} }));
  assert.equal(claudeHooksBlocked(f.project, { env: f.env, platform: 'darwin', managedDir: f.managedDir }), false);
});

test('claudeComputerUseLaunch: a switch that cannot be set leaves the run without computer use', (t) => {
  const f = launchFixture(t);
  t.mock.method(console, 'warn', () => {});
  fs.mkdirSync(path.dirname(f.configFile), { recursive: true });
  fs.writeFileSync(f.configFile, '{malformed');
  const out = f.launch('bypass');
  assert.equal(out.computerUse.available, false);
  assert.equal(out.computerUse.reasonCode, 'switch');
  assert.deepEqual(out.args, []);
  assert.equal(out.settings, null);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), '{malformed');
});
