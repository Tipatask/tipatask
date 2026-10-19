'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeProjectClaudeTrust, writeProjectMcpConfig } = require('../project-config');
const ClaudeAgent = require('./claude-agent');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-claude-trust-'));
  const configDir = path.join(root, 'profile');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, projectRoot, configDir, configPath: path.join(configDir, '.claude.json') };
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('folder trust creates the configured profile and uses an absolute project key', t => {
  const { projectRoot, configPath } = fixture(t);
  assert.equal(writeProjectClaudeTrust(path.relative(process.cwd(), projectRoot)), true);
  assert.deepEqual(read(configPath), { projects: { [projectRoot]: { hasTrustDialogAccepted: true } } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('folder trust defaults to ~/.claude.json when CLAUDE_CONFIG_DIR is unset', t => {
  const { root, projectRoot, configPath } = fixture(t);
  const home = path.join(root, 'home');
  t.mock.method(os, 'homedir', () => home);
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(writeProjectClaudeTrust(projectRoot), true);
  assert.equal(read(path.join(home, '.claude.json')).projects[projectRoot].hasTrustDialogAccepted, true);
  assert.equal(fs.existsSync(configPath), false);
});

test('folder trust preserves other settings, projects, project fields and file permissions', t => {
  const { projectRoot, configPath } = fixture(t);
  const original = {
    theme: 'dark', oauthAccount: { emailAddress: 'person@example.test' },
    projects: {
      elsewhere: { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
      [projectRoot]: { hasTrustDialogAccepted: false, allowedTools: ['Edit'], mcpServers: { other: {} } },
    },
  };
  put(configPath, JSON.stringify(original));
  fs.chmodSync(configPath, 0o660);
  assert.equal(writeProjectClaudeTrust(projectRoot), true);
  original.projects[projectRoot].hasTrustDialogAccepted = true;
  assert.deepEqual(read(configPath), original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o660);
});

test('already accepted folder trust leaves file bytes and modification time unchanged', t => {
  const { projectRoot, configPath } = fixture(t);
  const content = JSON.stringify({ projects: { [projectRoot]: { hasTrustDialogAccepted: true, allowedTools: [] } } });
  put(configPath, content);
  fs.utimesSync(configPath, 1234567890, 1234567890);
  const mtime = fs.statSync(configPath).mtimeMs;
  assert.equal(writeProjectClaudeTrust(projectRoot), true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), content);
  assert.equal(fs.statSync(configPath).mtimeMs, mtime);
});

test('malformed folder trust config is preserved and reported without exposing its content', t => {
  const { projectRoot, configDir, configPath } = fixture(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  const cases = ['{"sentinel-secret":', 'null', '[]', '{"projects":[]}',
    JSON.stringify({ projects: { [projectRoot]: null } })];
  for (const content of cases) {
    put(configPath, content);
    assert.equal(writeProjectClaudeTrust(projectRoot), false);
    assert.equal(fs.readFileSync(configPath, 'utf8'), content);
    assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
  }
  assert.equal(warnings.mock.callCount(), cases.length);
  assert.ok(warnings.mock.calls.every(call => !call.arguments.join(' ').includes('sentinel-secret')));
});

test('failed atomic trust replacement keeps original config and removes its temporary file', t => {
  const { projectRoot, configDir, configPath } = fixture(t);
  const content = '{"theme":"dark"}';
  put(configPath, content);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === configPath) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return rename(from, to);
  });
  t.mock.method(console, 'warn', () => {});
  assert.equal(writeProjectClaudeTrust(projectRoot), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
});

test('MCP setup accepts folder trust even when its MCP registration is already current', t => {
  const { root, projectRoot, configPath } = fixture(t);
  writeProjectMcpConfig(projectRoot, path.join(root, 'server'));
  assert.equal(read(configPath).projects[projectRoot].hasTrustDialogAccepted, true);
  const mcpPath = path.join(projectRoot, '.mcp.json');
  fs.utimesSync(mcpPath, 1234567890, 1234567890);
  const mtime = fs.statSync(mcpPath).mtimeMs;
  put(configPath, '{}');
  writeProjectMcpConfig(projectRoot, path.join(root, 'server'));
  assert.equal(read(configPath).projects[projectRoot].hasTrustDialogAccepted, true);
  assert.equal(fs.statSync(mcpPath).mtimeMs, mtime);
});

async function spawnSpec(t, projectRoot, opts = {}) {
  t.mock.method(ClaudeAgent, '_cliSupportsHeadersHelper', async () => false);
  return new ClaudeAgent().getSpawnSpec({
    CLAUDE_BIN: 'claude', SIMPLE_MODE: true, PROJECT_ROOT: projectRoot, USER_DATA_ROOT: path.dirname(projectRoot),
  }, 'Review this task.', null, opts);
}

test('Claude spawn accepts the bound project without a project-open refresh and preserves accepted entries', async t => {
  const { root, projectRoot, configPath } = fixture(t);
  const spec = await spawnSpec(t, path.join(root, 'fallback'), { projectPath: projectRoot });
  assert.equal(spec.cwd, projectRoot);
  assert.deepEqual(Object.keys(read(configPath).projects), [projectRoot]);
  const content = fs.readFileSync(configPath, 'utf8');
  fs.utimesSync(configPath, 1234567890, 1234567890);
  await spawnSpec(t, projectRoot);
  assert.equal(fs.readFileSync(configPath, 'utf8'), content);
  assert.equal(fs.statSync(configPath).mtimeMs, 1234567890000);
});

test('Claude spawn falls back to config.PROJECT_ROOT and continues when trust config is invalid', async t => {
  const { projectRoot, configPath } = fixture(t);
  await spawnSpec(t, projectRoot);
  assert.equal(read(configPath).projects[projectRoot].hasTrustDialogAccepted, true);
  put(configPath, '{invalid');
  t.mock.method(console, 'warn', () => {});
  const spec = await spawnSpec(t, projectRoot);
  assert.equal(spec.cwd, projectRoot);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{invalid');
});
