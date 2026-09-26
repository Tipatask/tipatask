'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const toml = require('toml');

const config = require('./config');
const CodexAgent = require('./task-agent/codex-agent');
const { buildCodexArgs } = require('./providers/codex-session');
const { CODEX_REASONING_EFFORT, buildCodexEnv, codexEffortArgs, toCodexEffort } = require('./codex-env');
const { writeProjectConfig: writeLiveProjectConfig } = require('./project-config');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-codex-env-'));
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
  assert.match(objectiveSource, /buildCodexEnv\(\{ projectRoot: session\.projectPath \|\| config\.PROJECT_ROOT, taskId \}\)/);
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

    assert.deepEqual(spec.args.slice(0, 2), codexEffortArgs());
    assert.match(
      fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8'),
      /model_reasoning_effort = "xhigh"/,
      'fixture must prove the spawn override wins without rewriting inherited config'
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const refreshedGlobalLocal = toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).mcp_servers['tipatask-local'];
  assert.equal(refreshedGlobalLocal.transport, undefined);
  assert.equal(refreshedGlobalLocal.command, '/custom/local-mcp');
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
