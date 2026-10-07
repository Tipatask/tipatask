'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const toml = require('toml');

// Credential-writing fixtures must never use the live desktop account store.
const originalUserData = process.env.TIPATASK_USER_DATA;
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-env-account-'));
process.env.TIPATASK_USER_DATA = testUserData;
test.after(() => {
  if (originalUserData === undefined) delete process.env.TIPATASK_USER_DATA;
  else process.env.TIPATASK_USER_DATA = originalUserData;
  fs.rmSync(testUserData, { recursive: true, force: true });
});

const config = require('./config');
const CodexAgent = require('./task-agent/codex-agent');
const { buildCodexArgs } = require('./providers/codex-session');
const { CODEX_REASONING_EFFORT, buildCodexEnv, codexEffortArgs, codexTerminalEffortArgs, codexTerminalLaunchOptions, terminalDaemonFallback, toCodexEffort } = require('./codex-env');
const { writeProjectConfig: writeLiveProjectConfig } = require('./project-config');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-codex-env-'));
}

function checkDaemon(home, env) {
  const reason = terminalDaemonFallback(home, env, toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')));
  return { args: reason ? ['--no-daemon'] : [], mode: reason ? 'embedded' : 'shared', reason };
}

test('codexEffortArgs pins the Codex config override to high', () => {
  assert.equal(CODEX_REASONING_EFFORT, 'high');
  assert.deepEqual(codexEffortArgs(), ['-c', 'model_reasoning_effort="high"']);
});

test('toCodexEffort maps max to xhigh and leaves other effort names unchanged', () => {
  assert.equal(toCodexEffort('max'), 'xhigh');
  for (const level of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(toCodexEffort(level), level);
  }
});

test('buildCodexEnv exposes inherited global MCP servers through project CODEX_HOME', () => {
  const dir = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const globalCodexHome = path.join(dir, 'user-codex');
    const projectRoot = path.join(dir, 'project');
    fs.mkdirSync(globalCodexHome, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), [
      '[mcp_servers.playwright]',
      'command = "/usr/bin/true"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: 'test-token',
    }), 'utf8');
    process.env.CODEX_HOME = globalCodexHome;

    const terminal = buildCodexEnv({ projectRoot, taskId: 'TPT94', term: 'xterm-256color' }).env;
    const objective = buildCodexEnv({ projectRoot, taskId: 'TPT94' }).env;

    assert.equal(terminal.CODEX_HOME, path.join(projectRoot, '.codex'));
    assert.equal(objective.CODEX_HOME, terminal.CODEX_HOME);
    assert.equal(terminal.TERM, 'xterm-256color');
    assert.equal(objective.TERM, 'dumb');
    assert.equal(terminal.TIPATASK_API_TOKEN, 'test-token');
    assert.equal(objective.TIPATASK_API_TOKEN, 'test-token');
    const generated = fs.readFileSync(path.join(terminal.CODEX_HOME, 'config.toml'), 'utf8');
    const generatedServers = toml.parse(generated).mcp_servers;
    assert.equal(generatedServers.tipatask.transport, undefined);
    assert.equal(generatedServers['tipatask-local'].transport, undefined);
    assert.equal(generatedServers.tipatask.url, 'http://127.0.0.1:4454/api/projects/2/mcp');
    assert.ok(generatedServers['tipatask-local'].command);
    assert.match(generated, /\[mcp_servers\.playwright\][\s\S]*command = "\/usr\/bin\/true"/);
    assert.match(generated, /bearer_token_env_var = "TIPATASK_API_TOKEN"/);
    assert.doesNotMatch(generated, /test-token|Authorization|Bearer/);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCodexEnv live-reads token rotation and clears an inherited token when project token is blank', () => {
  const dir = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  const previousTipataskToken = process.env.TIPATASK_API_TOKEN;
  try {
    const globalCodexHome = path.join(dir, 'user-codex');
    const projectRoot = path.join(dir, 'project');
    fs.mkdirSync(globalCodexHome, { recursive: true });
    fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), '', 'utf8');
    process.env.CODEX_HOME = globalCodexHome;
    process.env.TIPATASK_API_TOKEN = 'stale-parent-token';

    writeLiveProjectConfig(projectRoot, {
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: 'token-one',
    });
    const first = buildCodexEnv({ projectRoot }).env;
    assert.equal(first.TIPATASK_API_TOKEN, 'token-one');

    writeLiveProjectConfig(projectRoot, {
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: 'token-two',
    });
    const second = buildCodexEnv({ projectRoot }).env;
    assert.equal(second.TIPATASK_API_TOKEN, 'token-two');

    const generated = fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8');
    assert.match(generated, /bearer_token_env_var = "TIPATASK_API_TOKEN"/);
    assert.doesNotMatch(generated, /token-one|token-two|stale-parent-token|Authorization|Bearer/);

    writeLiveProjectConfig(projectRoot, {
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: '',
    });
    const blank = buildCodexEnv({ projectRoot }).env;
    assert.equal('TIPATASK_API_TOKEN' in blank, false);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousTipataskToken === undefined) delete process.env.TIPATASK_API_TOKEN;
    else process.env.TIPATASK_API_TOKEN = previousTipataskToken;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal environments remove task-local state and app capabilities without losing project credentials', t => {
  const root = makeTempDir();
  const keys = ['CODEX_HOME', 'TIPATASK_USER_DATA', 'TIPATASK_TASK_ID', 'TIPATASK_TRACK_DIR', 'TIPATASK_OBJECTIVE_TASK_ID', 'TIPATASK_LOCAL_SECRET', 'API_TOKEN'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const user = path.join(root, 'user');
  fs.mkdirSync(user);
  fs.writeFileSync(path.join(user, 'config.toml'), '');
  Object.assign(process.env, { CODEX_HOME: user, TIPATASK_USER_DATA: root, TIPATASK_TASK_ID: 'OLD',
    TIPATASK_TRACK_DIR: '/old', TIPATASK_OBJECTIVE_TASK_ID: 'OLD-OBJECTIVE', TIPATASK_LOCAL_SECRET: 'app-secret', API_TOKEN: 'old-token' });
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  writeLiveProjectConfig(first, { API_BASE_URL: 'https://first.test', API_PROJECT_ID: '1', API_TOKEN: 'first-token', MCP_BROWSER_TOOLS: [] });
  writeLiveProjectConfig(second, { API_BASE_URL: 'https://second.test', API_PROJECT_ID: '2', API_TOKEN: '', MCP_BROWSER_TOOLS: [] });
  const a = buildCodexEnv({ projectRoot: first, taskId: 'TPT1', term: 'xterm-256color' }).env;
  process.env.TIPATASK_LOCAL_SECRET = 'new-app-secret';
  const b = buildCodexEnv({ projectRoot: first, taskId: 'TPT2', term: 'xterm-256color' }).env;
  assert.deepEqual(a, b, 'different tasks and a rotated app capability must not change daemon env');
  for (const key of keys.slice(2, -1)) assert.equal(a[key], undefined, key);
  assert.equal(a.API_TOKEN, 'first-token');
  assert.equal(a.TIPATASK_API_TOKEN, 'first-token');
  const other = buildCodexEnv({ projectRoot: second, taskId: 'TPT3', term: 'xterm-256color' }).env;
  assert.notEqual(other.CODEX_HOME, a.CODEX_HOME);
  assert.equal(other.API_TOKEN, undefined);
  assert.equal(other.TIPATASK_API_TOKEN, undefined);
  assert.equal(other.API_PROJECT_ID, '2');
  const chat = buildCodexEnv({ projectRoot: first, taskId: 'TPT4' }).env;
  assert.equal(chat.TIPATASK_TASK_ID, 'TPT4');
  assert.equal(chat.TIPATASK_OBJECTIVE_TASK_ID, undefined);
  assert.equal(chat.TIPATASK_LOCAL_SECRET, undefined);
});

test('buildCodexEnv refreshes managed browser presets before a Codex spawn', () => {
  const dir = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const globalCodexHome = path.join(dir, 'user-codex');
    const projectRoot = path.join(dir, 'project');
    const projectCodexHome = path.join(projectRoot, '.codex');
    fs.mkdirSync(globalCodexHome, { recursive: true });
    fs.mkdirSync(projectCodexHome, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), '', 'utf8');
    fs.writeFileSync(path.join(projectCodexHome, 'config.toml'), [
      '[mcp_servers.playwright]',
      '# tipatask-managed-preset',
      'command = "npx"',
      'args = ["@playwright/mcp@latest"]',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: 'test-token',
      MCP_BROWSER_TOOLS: ['playwright'],
    }), 'utf8');
    process.env.CODEX_HOME = globalCodexHome;

    const spawnEnv = buildCodexEnv({ projectRoot, taskId: 'TPT128', term: 'xterm-256color' }).env;
    const parsed = toml.parse(fs.readFileSync(path.join(projectCodexHome, 'config.toml'), 'utf8'));
    const playwright = parsed.mcp_servers.playwright;

    assert.equal(spawnEnv.CODEX_HOME, projectCodexHome);
    assert.equal(path.isAbsolute(playwright.command), true);
    assert.equal(path.basename(playwright.command), process.platform === 'win32' ? 'npx.cmd' : 'npx');
    assert.deepEqual(playwright.args, ['-y', '@playwright/mcp@latest']);
    assert.equal(playwright.startup_timeout_sec, 60);
    assert.equal(playwright.env.PATH.split(path.delimiter)[0], path.dirname(playwright.command));
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal agent and objective provider both delegate Codex environment setup to buildCodexEnv', () => {
  const terminalSource = fs.readFileSync(path.join(__dirname, 'task-agent', 'codex-agent.js'), 'utf8');
  const objectiveSource = fs.readFileSync(path.join(__dirname, 'providers', 'codex-session.js'), 'utf8');

  assert.match(terminalSource, /buildCodexEnv\(\{ projectRoot, taskId, term: 'xterm-256color' \}\)/);
  assert.match(objectiveSource, /buildCodexEnv\(\{ projectRoot: session\.projectPath \|\| config\.PROJECT_ROOT, taskId[:, }]/);
});

test('Codex terminal spawn pins high effort ahead of inherited config', async () => {
  const dir = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const projectRoot = path.join(dir, 'project');
    const globalCodexHome = path.join(dir, 'user-codex');
    fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
    fs.mkdirSync(globalCodexHome, { recursive: true });
    fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), 'model_reasoning_effort = "xhigh"\n');
    fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
      API_BASE_URL: 'http://127.0.0.1:4454',
      API_PROJECT_ID: '2',
      API_TOKEN: 'test-token',
    }), 'utf8');
    process.env.CODEX_HOME = globalCodexHome;

    const agent = new CodexAgent();
    const spec = await agent.getSpawnSpec({
      CODEX_BIN: 'codex',
      PROJECT_ROOT: projectRoot,
      USER_DATA_ROOT: dir,
    }, 'Work on task TPT99.', '', { projectPath: projectRoot });

    assert.ok(!spec.args.includes('-c'));
    assert.equal(toml.parse(fs.readFileSync(path.join(spec.env.CODEX_HOME, 'config.toml'), 'utf8')).model_reasoning_effort, 'high');
    assert.match(
      fs.readFileSync(path.join(projectRoot, '.codex', 'tipatask-terminal.toml'), 'utf8'),
      /model_reasoning_effort = "xhigh"/,
      'inherited default remains saved separately from the console setting'
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal and SIMPLE_MODE terminal launches share config effort without sharing task overrides', async t => {
  const dir = makeTempDir();
  const previousHome = process.env.CODEX_HOME;
  const previousSimple = config.SIMPLE_MODE;
  const home = path.join(dir, 'user');
  fs.mkdirSync(home);
  const preferences = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[features]\nunified_exec = true\n';
  fs.writeFileSync(path.join(home, 'config.toml'), preferences);
  process.env.CODEX_HOME = home;
  t.after(() => {
    config.SIMPLE_MODE = previousSimple;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const agent = new CodexAgent();
  t.mock.method(agent, 'localizeSpawnPrompt', async (_cfg, prompt, _id, opts) => ({ prompt, opts }));
  for (const simple of [false, true]) {
    config.SIMPLE_MODE = simple;
    const root = path.join(dir, simple ? 'simple' : 'normal');
    fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({
      API_BASE_URL: 'https://terminal-launch.test', API_PROJECT_ID: simple ? '32' : '31',
      API_TOKEN: simple ? 'simple-token' : 'normal-token', CODEX_MODEL: 'project-model', MCP_BROWSER_TOOLS: [],
    }));
    const cfg = { CODEX_BIN: 'codex', PROJECT_ROOT: '/wrong-root' };
    const prompt = 'Work on task TPT497.';
    const spawn = (opts, taskId = 'TPT497') => agent.getSpawnSpec(cfg, `Work on task ${taskId}.`, taskId, { projectPath: root, ...opts });
    const [normal, low, max] = await Promise.all([
      spawn({}), spawn({ task: { effort: 'low' }, model: 'task-model' }), spawn({ task: { effort: 'max' } }),
    ]);
    assert.equal(normal.cwd, root);
    assert.equal(path.dirname(path.dirname(normal.env.CODEX_HOME)), path.join(root, '.codex'));
    assert.equal(normal.env.TIPATASK_API_TOKEN, simple ? 'simple-token' : 'normal-token');
    assert.deepEqual(normal.args.slice(0, 3), ['--model', 'project-model', '--no-alt-screen']);
    assert.equal(normal.args.some(arg => ['-c', '--config', '--profile', '--no-daemon', '--enable', '--disable', '--search'].includes(arg)), false);
    assert.deepEqual(low.args.slice(0, 2), ['--model', 'task-model']);
    for (const spec of [normal, low, max]) {
      assert.equal(spec.args.some(arg => ['-c', '--config', '--profile', '--enable', '--disable', '--search'].includes(arg)), false);
    }
    const content = fs.readFileSync(path.join(normal.env.CODEX_HOME, 'config.toml'), 'utf8');
    const parsed = toml.parse(content);
    assert.equal(parsed.model_reasoning_effort, 'high');
    assert.equal(parsed.approval_policy, 'on-request');
    assert.equal(parsed.sandbox_mode, 'workspace-write');
    assert.equal(parsed.features.unified_exec, true);
    assert.equal(parsed.mcp_servers.tipatask.url, `https://terminal-launch.test/api/projects/${simple ? '32' : '31'}/mcp`);
    assert.equal(parsed.mcp_servers.tipatask.bearer_token_env_var, 'TIPATASK_API_TOKEN');
    assert.equal(parsed.mcp_servers['tipatask-local'].env.TIPATASK_PROJECT_ROOT, root);
    assert.doesNotMatch(content, /simple-token|normal-token/);
    assert.notEqual(low.env.CODEX_HOME, normal.env.CODEX_HOME);
    assert.notEqual(max.env.CODEX_HOME, normal.env.CODEX_HOME);
    assert.equal(toml.parse(fs.readFileSync(path.join(low.env.CODEX_HOME, 'config.toml'), 'utf8')).model_reasoning_effort, 'low');
    assert.equal(toml.parse(fs.readFileSync(path.join(max.env.CODEX_HOME, 'config.toml'), 'utf8')).model_reasoning_effort, 'xhigh');
    assert.equal(toml.parse(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')).model_reasoning_effort, undefined);
    const peers = await Promise.all(['TPT498', 'TPT499'].map(id => spawn({}, id)));
    for (const peer of peers) {
      assert.deepEqual(peer.env, normal.env, 'different tasks must have the same daemon environment');
      assert.deepEqual(peer.args.slice(0, -1), normal.args.slice(0, -1));
      assert.match(peer.args.at(-1), /Work on task TPT49[89]\./);
    }
    const again = await spawn({}, 'TPT500');
    assert.deepEqual(again.args.slice(0, -1), normal.args.slice(0, -1));
    assert.match(again.args.at(-1), /Work on task TPT500\./);
    assert.equal(fs.readFileSync(path.join(normal.env.CODEX_HOME, 'config.toml'), 'utf8'), content);
    if (simple) assert.equal(normal.args.at(-1), prompt);
    else {
      assert.match(normal.args.at(-1), /Do not implement, edit files, or run mutating commands until the user approves the plan/);
      assert.match(normal.args.at(-1), /Plan ready\./);
    }
  }
});

test('terminal effort preserves defaults and isolates ancestor config without CLI overrides', t => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const home = path.join(root, '.codex');
  fs.mkdirSync(home);
  const file = path.join(home, 'config.toml');
  const content = '# custom\nmodel_reasoning_effort = "low"\n';
  fs.writeFileSync(file, content);
  assert.deepEqual(codexTerminalEffortArgs(root, home, 'low'), []);
  assert.deepEqual(codexTerminalEffortArgs(root, home), []);
  assert.equal(fs.readFileSync(path.join(home, 'tipatask-terminal.toml'), 'utf8'), 'model_reasoning_effort = "low"\n');
  assert.match(fs.readFileSync(file, 'utf8'), /# custom/);
  const nested = path.join(root, 'nested');
  const nestedHome = path.join(nested, '.codex');
  fs.mkdirSync(nestedHome, { recursive: true });
  fs.writeFileSync(path.join(nestedHome, 'config.toml'), 'model_reasoning_effort = "high"\n');
  assert.deepEqual(codexTerminalEffortArgs(nested, nestedHome), []);
  fs.writeFileSync(file, 'invalid = [');
  assert.throws(() => codexTerminalEffortArgs(root, home));
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid = [');
});

test('terminal daemon reuse survives module reload, preserves credentials and rejects unknown identity', t => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const home = path.join(root, '.codex');
  const daemonDir = path.join(home, 'app-server-daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  const file = path.join(home, 'config.toml');
  const marker = path.join(daemonDir, 'daemon.pid');
  const record = path.join(home, 'tipatask-daemon.json');
  fs.writeFileSync(file, 'model_reasoning_effort = "high"\n');
  const env = { CODEX_HOME: home, TIPATASK_API_TOKEN: 'first-secret' };
  const launch = (extra = {}) => checkDaemon(home, { ...env, ...extra });
  const daemon = { pid: process.pid, processIdentity: { startSeconds: Math.floor(Date.now() / 1000) } };
  fs.writeFileSync(marker, JSON.stringify(daemon));
  assert.equal(launch().reason, 'daemon-unrecognized');
  assert.deepEqual(launch().args, ['--no-daemon'], 'isolation must not manufacture an effort override');
  fs.unlinkSync(marker);
  assert.deepEqual(launch().args, [], 'first compatible launch may start a daemon');
  assert.deepEqual(launch().args, [], 'concurrent compatible launch may join the pending daemon');
  assert.equal(launch({ TIPATASK_API_TOKEN: 'rotated' }).reason, 'daemon-start-pending');
  daemon.processIdentity.startSeconds = Math.floor(Date.now() / 1000);
  fs.writeFileSync(marker, JSON.stringify(daemon));
  assert.deepEqual(launch().args, [], 'same project environment may reuse the identified daemon');
  assert.doesNotMatch(fs.readFileSync(record, 'utf8'), /first-secret|TIPATASK_API_TOKEN/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  const modulePath = require.resolve('./codex-env');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  try {
    const reloaded = require('./codex-env');
    assert.equal(reloaded.terminalDaemonFallback(home, env, toml.parse(fs.readFileSync(file, 'utf8'))), null, 'fresh module must recognize persisted identity');
  } finally { require.cache[modulePath] = originalModule; }
  fs.appendFileSync(file, '\n# Native TUI bookkeeping\n[tui]\nscreen_reader_detection_done = true\n');
  assert.deepEqual(launch().args, [], 'TUI counters and formatting do not change daemon configuration');
  assert.equal(launch({ TIPATASK_API_TOKEN: 'rotated' }).reason, 'daemon-settings-changed');
  fs.writeFileSync(file, 'sandbox_mode = "read-only"\n' + fs.readFileSync(file, 'utf8'));
  assert.equal(launch().reason, 'daemon-settings-changed');
  fs.unlinkSync(marker);
  assert.deepEqual(launch({ TIPATASK_API_TOKEN: 'rotated' }).args, [], 'a stopped daemon permits a new environment');
  fs.writeFileSync(marker, 'broken');
  assert.equal(launch({ TIPATASK_API_TOKEN: 'rotated' }).reason, 'daemon-identity-invalid');
});

test('daemon metadata fails closed for contention, stale identities and copied project records', t => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const home = path.join(root, '.codex');
  fs.mkdirSync(path.join(home, 'app-server-daemon'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_reasoning_effort = "high"\n');
  const record = path.join(home, 'tipatask-daemon.json');
  const marker = path.join(home, 'app-server-daemon/daemon.pid');
  const launch = () => checkDaemon(home, { CODEX_HOME: home });
  fs.writeFileSync(`${record}.lock`, String(process.pid));
  assert.equal(launch().reason, 'daemon-record-busy');
  fs.unlinkSync(`${record}.lock`);
  assert.equal(launch().mode, 'shared');
  const initial = fs.readFileSync(record, 'utf8');
  const daemon = { pid: process.pid, processIdentity: { startSeconds: Math.floor(Date.now() / 1000) - 60 } };
  fs.writeFileSync(marker, JSON.stringify(daemon));
  assert.equal(launch().reason, 'daemon-unrecognized', 'a pending launch cannot adopt an older daemon');
  daemon.processIdentity.startSeconds = Math.floor(Date.now() / 1000);
  fs.writeFileSync(marker, JSON.stringify(daemon));
  assert.equal(launch().mode, 'shared');
  daemon.processIdentity.startSeconds++;
  fs.writeFileSync(marker, JSON.stringify(daemon));
  assert.equal(launch().reason, 'daemon-identity-changed');
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(initial), home: '/other/project/.codex' }));
  assert.equal(launch().reason, 'daemon-record-invalid');
  fs.writeFileSync(record, 'bad json');
  assert.equal(launch().reason, 'daemon-record-invalid');
});

test('an abandoned daemon start expires without adopting an unidentified control socket', t => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const home = path.join(root, '.codex');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_reasoning_effort = "high"\n');
  const record = path.join(home, 'tipatask-daemon.json');
  const launch = token => checkDaemon(home, { CODEX_HOME: home, TIPATASK_API_TOKEN: token });
  assert.equal(launch('old').mode, 'shared');
  assert.equal(launch('new').reason, 'daemon-start-pending');
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record)), startedAt: Date.now() - 121000 }));
  assert.equal(launch('new').mode, 'shared');
  fs.mkdirSync(path.join(home, 'app-server-control'));
  fs.writeFileSync(path.join(home, 'app-server-control/app-server-control.sock'), 'fixture');
  assert.equal(launch('new').reason, 'daemon-identity-unavailable');
});

test('Codex objective argv maps max effort to xhigh for fresh and resumed turns', t => {
  const previousEffort = config.OBJECTIVE_EFFORT;
  config.OBJECTIVE_EFFORT = 'max';
  t.after(() => { config.OBJECTIVE_EFFORT = previousEffort; });

  const fresh = buildCodexArgs({}, {
    cwd: '/workspace/project',
    model: 'gpt-test',
    imagePaths: [],
  });
  const resumed = buildCodexArgs({ codexSessionId: 'thread-1' }, {
    cwd: '/workspace/project',
    model: 'gpt-test',
    imagePaths: [],
  });

  const expected = codexEffortArgs('xhigh');
  assert.deepEqual(fresh.slice(1, 3), expected);
  assert.deepEqual(resumed.slice(3, 5), expected);
});

test('existing-project upgrade reaches both Codex launch environments with new global preferences', t => {
  const dir = makeTempDir();
  const oldHome = process.env.CODEX_HOME;
  const home = path.join(dir, 'user');
  const root = path.join(dir, 'project');
  fs.mkdirSync(home);
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "user-model"\n');
  writeLiveProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'first-token', MCP_BROWSER_TOOLS: [] });
  buildCodexEnv({ projectRoot: root });
  const projectConfigPath = path.join(root, '.codex/config.toml');
  const legacyConfig = fs.readFileSync(projectConfigPath, 'utf8')
    .replace('[mcp_servers.tipatask]\n', '[mcp_servers.tipatask]\ntransport = "streamable_http"\n')
    .replace('[mcp_servers.tipatask-local]\n', '[mcp_servers.tipatask-local]\ntransport = "stdio"\n');
  fs.writeFileSync(projectConfigPath, legacyConfig);
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "changed-global"',
    'personality = "pragmatic"',
    '[features]',
    'unified_exec = true',
    '[mcp_servers.tipatask-local]',
    'transport = "stdio"',
    'command = "/custom/local-mcp"',
    '',
  ].join('\n'));
  writeLiveProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'rotated-token', MCP_BROWSER_TOOLS: [] });
  const terminal = buildCodexEnv({ projectRoot: root, taskId: 'TPT258', term: 'xterm-256color' }).env;
  const afterTerminal = fs.readFileSync(projectConfigPath, 'utf8');
  assert.equal(toml.parse(afterTerminal).mcp_servers.tipatask.transport, undefined);
  assert.equal(toml.parse(afterTerminal).mcp_servers['tipatask-local'].transport, undefined);
  const refreshedGlobalLocal = toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).mcp_servers?.['tipatask-local'];
  assert.equal(refreshedGlobalLocal, undefined);
  fs.writeFileSync(projectConfigPath, legacyConfig);
  const objective = buildCodexEnv({ projectRoot: root, taskId: 'TPT258' }).env;
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), afterTerminal);
  const parsed = toml.parse(afterTerminal);
  assert.equal(parsed.model, 'user-model', 'existing preference remains project-owned');
  assert.equal(parsed.personality, 'pragmatic');
  assert.equal(parsed.features.unified_exec, true);
  assert.equal(parsed.mcp_servers.playwright, undefined);
  assert.equal(terminal.TIPATASK_API_TOKEN, 'rotated-token');
  assert.equal(objective.TIPATASK_API_TOKEN, terminal.TIPATASK_API_TOKEN);
  assert.equal(objective.CODEX_HOME, terminal.CODEX_HOME);
  assert.doesNotMatch(afterTerminal, /first-token|rotated-token/);
});
