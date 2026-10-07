'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-context-'));
process.env.TIPATASK_USER_DATA = path.join(sandbox, 'data');
process.env.CODEX_HOME = path.join(sandbox, 'codex-home');
const { writeAccountToken, readAccount, clearAccountToken } = require('./account-store');
const { writeProjectConfig, writeProjectMcpConfig, readProjectConfig } = require('./project-config');
const { getApiCredentials } = require('./api-credentials');
const { projectEnvExtras, augmentPathEnv } = require('./spawn-utils');
const { buildHeadersHelperCommand } = require('./mcp-spawn-config');
const helper = path.resolve(__dirname, '../mcp/auth-header-helper.js');
const server = path.resolve(__dirname, '../..');
const jwt = claims => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.s`;
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function project(name, base = 'https://one.test', id = 1) {
  const root = path.join(sandbox, name);
  writeProjectConfig(root, { API_BASE_URL: base, API_PROJECT_ID: id });
  return root;
}

test('two projects share current account, other servers remain isolated, absent values clear inherited credentials', () => {
  const a = project('a');
  const b = project('b', 'https://one.test', 2);
  const c = project('c', 'https://two.test', 3);
  writeAccountToken('https://one.test', jwt({ id: 10 }));
  writeAccountToken('https://two.test', jwt({ id: 20 }));
  assert.equal(getApiCredentials(a).token, getApiCredentials(b).token);
  assert.notEqual(getApiCredentials(b).token, getApiCredentials(c).token);
  writeAccountToken('https://one.test', jwt({ id: 11 }));
  assert.equal(getApiCredentials(a).token, jwt({ id: 11 }));
  assert.equal(getApiCredentials(c).token, jwt({ id: 20 }));
  const prior = process.env.API_TOKEN;
  process.env.API_TOKEN = 'wrong-inherited-account';
  try {
    clearAccountToken('https://one.test');
    const env = augmentPathEnv(projectEnvExtras(a));
    assert.equal(env.API_TOKEN, '');
    assert.equal(env.TIPATASK_API_TOKEN, '');
    assert.equal(env.TIPATASK_PROJECT_ROOT, a);
    assert.equal(env.TIPATASK_USER_DATA, process.env.TIPATASK_USER_DATA);
    assert.throws(() => getApiCredentials(a), err => err.missingCredentials && /TIPATASK_USER_DATA/.test(err.message) && !/expired/.test(err.message));
    const empty = augmentPathEnv(projectEnvExtras(path.join(sandbox, 'missing')));
    for (const key of ['API_TOKEN', 'API_PROJECT_ID', 'API_BASE_URL', 'TIPATASK_API_TOKEN']) assert.equal(empty[key], '');
  } finally { if (prior === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = prior; }
});

test('legacy migration never replaces signed-in identity and scoped tokens cannot cross projects', () => {
  const a = project('legacy-a', 'https://legacy.test', 1);
  const b = project('legacy-b', 'https://legacy.test', 2);
  const account = jwt({ id: 20 });
  writeAccountToken('https://legacy.test', account);
  fs.writeFileSync(path.join(a, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: 'https://legacy.test', API_PROJECT_ID: 1, API_TOKEN: jwt({ id: 99, exp: 9999999999, project_id: 1 }) }));
  assert.equal(getApiCredentials(a).token, account);
  assert.equal(getApiCredentials(b).token, account);
  assert.equal(readAccount('https://legacy.test').token, account);
  assert.ok(!fs.readFileSync(path.join(a, '.tipatask/config.json'), 'utf8').includes('API_TOKEN'));
  writeAccountToken('https://legacy.test', jwt({ id: 20, project_id: 1 }));
  assert.ok(getApiCredentials(a).token);
  assert.throws(() => getApiCredentials(b), err => err.reasonCode === 'project-scope');
  assert.equal(projectEnvExtras(b).API_TOKEN, '');
});

test('generated Claude shell config is secret-free, helper rotates and clears credentials, retargeting fails closed', () => {
  const root = project('helper', 'https://headers.test', 5);
  const token = jwt({ id: 3 });
  writeAccountToken('https://headers.test', token);
  writeProjectMcpConfig(root, server);
  const file = path.join(root, '.mcp.json');
  const content = fs.readFileSync(file, 'utf8');
  const mcp = JSON.parse(content).mcpServers;
  assert.equal(mcp.tipatask.url, 'https://headers.test/api/projects/5/mcp');
  assert.equal(mcp['tipatask-local'].env.TIPATASK_PROJECT_ROOT, root);
  assert.equal(mcp['tipatask-local'].env.TIPATASK_SERVER_ROOT, server);
  assert.equal(mcp['tipatask-local'].env.TIPATASK_USER_DATA, process.env.TIPATASK_USER_DATA);
  assert.ok(mcp.tipatask.headersHelper.includes('--user-data'));
  assert.ok(!content.includes(token));
  assert.ok(!fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8').includes(token));
  const command = buildHeadersHelperCommand({ projectRoot: root, userDataRoot: process.env.TIPATASK_USER_DATA, execPath: process.execPath, scriptPath: helper, electron: false });
  const read = () => {
    const result = spawnSync(command, { shell: true, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes(token));
    return JSON.parse(result.stdout).Authorization;
  };
  assert.equal(read(), `Bearer ${token}`);
  writeAccountToken('https://headers.test', 'rotated-opaque-token');
  assert.equal(read(), 'Bearer rotated-opaque-token');
  clearAccountToken('https://headers.test');
  assert.equal(read(), '');
  writeProjectConfig(root, { API_BASE_URL: 'https://other.test', API_PROJECT_ID: 9, API_TOKEN: 'other-server-token' });
  assert.equal(read(), '');
});

test('missing credentials take precedence over an old unauthorized latch', async () => {
  const { assertCredentialsUsable } = require('./auth-guard');
  const error = Object.assign(new Error('Account store missing at selected user-data path'), { missingCredentials: true });
  await assert.rejects(assertCredentialsUsable({ getConnectionState: () => 'unauthorized', getCredentials() { throw error; } }), err => err.reasonCode === 'missing' && !/expired/.test(err.message));
});

test('Pi live REST credentials rotate, reject identity/target changes and never accept another server', () => {
  const { liveCredentials } = require('./providers/pi-ext/live-credentials.cjs');
  const root = project('pi', 'https://pi.test', 4);
  const first = jwt({ id: 5 });
  writeAccountToken('https://pi.test', first);
  const env = projectEnvExtras(root);
  const fresh = jwt({ id: 5, exp: 9999999999 });
  writeAccountToken('https://pi.test', fresh);
  assert.equal(liveCredentials(env).API_TOKEN, fresh);
  writeAccountToken('https://pi.test', jwt({ id: 6 }));
  assert.throws(() => liveCredentials(env), /Restart this chat/);
  writeProjectConfig(root, { API_BASE_URL: 'https://other.test', API_PROJECT_ID: 4 });
  assert.throws(() => liveCredentials(env), /Restart this chat/);
});

test('Gemini settings restrict tools and continuation targets the exact session', () => {
  const { prepareGeminiSettings } = require('./providers/gemini-config');
  const { buildGeminiArgs } = require('./providers/gemini-session');
  const file = prepareGeminiSettings(process.env.TIPATASK_USER_DATA);
  const settings = JSON.parse(fs.readFileSync(file));
  assert.equal(settings.admin.mcp.enabled, false);
  assert.equal(settings.admin.extensions.enabled, false);
  assert.equal(settings.security.disableYoloMode, true);
  assert.ok(!settings.tools.core.includes('run_shell_command'));
  const args = buildGeminiArgs({ geminiSessionId: 'session-for-this-chat' });
  assert.equal(args[args.indexOf('--resume') + 1], 'session-for-this-chat');
  assert.ok(!args.includes('latest') && !args.includes('--yolo'));
});

test('REST recovery pins target, supplies auth internally, and redacts a server echo', async () => {
  const root = project('rest', 'https://rest.test', 7);
  writeAccountToken('https://rest.test', 'sentinel-bearer');
  const before = process.env.TIPATASK_PROJECT_ROOT;
  process.env.TIPATASK_PROJECT_ROOT = root;
  const { run } = require('../cli/task-tools');
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200, json: async () => ({ echo: 'sentinel-bearer' }) }; };
  try {
    const response = await run(['PATCH', '/tasks/TPT1'], { input: '{"title":"Updated"}', fetchImpl });
    assert.equal(calls[0].url, 'https://rest.test/api/projects/7/tasks/TPT1');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer sentinel-bearer');
    assert.equal(response.body.echo, '[redacted]');
    await assert.rejects(run(['GET', '/../projects/8/tasks'], { fetchImpl }), /dot segments/);
    assert.equal(calls.length, 1);
  } finally { if (before === undefined) delete process.env.TIPATASK_PROJECT_ROOT; else process.env.TIPATASK_PROJECT_ROOT = before; }
});


test('packaged registration uses Electron and external user data, and refuses a missing store path', () => {
  const root = project('packaged', 'https://packaged.test', 2);
  const asar = path.join(sandbox, 'TipATask.app/Contents/Resources/app.asar');
  writeProjectMcpConfig(root, asar);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'))).mcpServers;
  assert.equal(mcp['tipatask-local'].command, process.execPath);
  assert.equal(mcp['tipatask-local'].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(mcp['tipatask-local'].env.TIPATASK_SERVER_ROOT, asar);
  assert.equal(mcp['tipatask-local'].env.TIPATASK_USER_DATA, process.env.TIPATASK_USER_DATA);
  assert.match(mcp.tipatask.headersHelper, /ELECTRON_RUN_AS_NODE=1/);
  const before = process.env.TIPATASK_USER_DATA;
  try {
    delete process.env.TIPATASK_USER_DATA;
    assert.throws(() => require('./account-store').userDataRoot({ serverRoot: asar }), /TIPATASK_USER_DATA is missing/);
  } finally { process.env.TIPATASK_USER_DATA = before; }
});

test('chat histories separate checkout, server, project and account but survive token renewal', async () => {
  const root = project('history', 'https://history.test', 1);
  const { createChatPersistence } = require('./chat-persistence');
  const store = createChatPersistence({ userDataRoot: process.env.TIPATASK_USER_DATA });
  writeAccountToken('https://history.test', jwt({ id: 10 }));
  await store.writeChatDraft([{ role: 'user', content: 'private project one' }], 'obj-one', {}, root);
  assert.ok(await store.readChatDraft(root));
  assert.equal(await store.readChatDraft(project('history-other', 'https://history.test', 1)), null);
  writeAccountToken('https://history.test', jwt({ id: 10, exp: 9999999999 }));
  assert.ok(await store.readChatDraft(root));
  writeProjectConfig(root, { ...readProjectConfig(root), API_PROJECT_ID: 2 });
  assert.equal(await store.readChatDraft(root), null);
  writeProjectConfig(root, { ...readProjectConfig(root), API_PROJECT_ID: 1 });
  assert.ok(await store.readChatDraft(root), 'restoring the original target restores only its own history');
  writeAccountToken('https://history.test', jwt({ id: 20 }));
  assert.equal(await store.readChatDraft(root), null);
  writeProjectConfig(root, { ...readProjectConfig(root), API_BASE_URL: 'https://other-history.test' });
  writeAccountToken('https://other-history.test', jwt({ id: 10 }));
  assert.equal(await store.readChatDraft(root), null);
});

test('shell launcher binds all supported agents and refreshes Codex environment without credential argv', t => {
  const root = project('launch', 'https://launch.test', 8);
  const token = jwt({ id: 1 });
  writeAccountToken('https://launch.test', token);
  writeProjectMcpConfig(root, server);
  const envBefore = { ...process.env };
  const spawnUtils = require('./spawn-utils');
  t.mock.method(spawnUtils, 'resolveBin', name => `/fake/${name}`);
  t.mock.method(spawnUtils, 'resolvePiLaunch', () => ({ command: '/fake/pi', argsPrefix: [], env: {} }));
  try {
    const { launch } = require('../cli/launch-agent');
    for (const provider of ['claude', 'codex', 'pi']) {
      process.env.CODEX_HOME = path.join(sandbox, 'codex-home');
      let call;
      launch([provider, '--project-root', root], (command, args, opts) => {
        call = { command, args, opts }; return new (require('node:events').EventEmitter)();
      });
      assert.equal(call.opts.cwd, root);
      assert.ok(call.opts.env.API_TOKEN === token, 'selected account injected');
      assert.equal(call.opts.env.TIPATASK_USER_DATA, envBefore.TIPATASK_USER_DATA);
      assert.ok(!JSON.stringify(call.args).includes(token), 'argv is credential-free');
      if (provider === 'codex') {
        assert.equal(path.dirname(path.dirname(call.opts.env.CODEX_HOME)), path.join(root, '.codex'));
        assert.ok(!call.args.some(arg => ['-c', '--config', '--profile', '--enable', '--disable', '--search'].includes(arg)));
        assert.ok(call.opts.env.TIPATASK_API_TOKEN === token);
      }
    }
    assert.throws(() => launch(['gemini', '--project-root', root]), /only in objective chat/);
    clearAccountToken('https://launch.test');
    assert.throws(() => launch(['claude', '--project-root', root]), /No signed-in account token/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  }
});

test('malformed generated settings leave user edits intact and never quote their contents', () => {
  const root = project('malformed', 'https://malformed.test', 1);
  const contents = '{"API_TOKEN":"sentinel-secret-never-log", BROKEN';
  fs.writeFileSync(path.join(root, '.mcp.json'), contents);
  assert.throws(() => writeProjectMcpConfig(root, server), err => /Invalid agent configuration/.test(err.message) && !err.message.includes('sentinel-secret'));
  assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), contents);
});


test('all provider continuations reject account or target changes before spawning', () => {
  const root = project('continuation', 'https://continuation.test', 1);
  writeAccountToken('https://continuation.test', jwt({ id: 1 }));
  const old = require('./api-credentials').projectContextIdentity(root);
  writeProjectConfig(root, { ...readProjectConfig(root), API_PROJECT_ID: 2 });
  for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
    const frames = [];
    const session = { projectPath: root, _agentContextIdentity: old, providerType: provider,
      claudeSessionId: 'c', codexSessionId: 'x', geminiSessionId: 'g', piSessionId: 'p',
      ws: { readyState: 1, send(raw) { frames.push(JSON.parse(raw)); } } };
    require('./providers/dispatch').spawnTurn(session, 'obj-test');
    assert.equal(frames[0].reason, 'project-context-changed');
    for (const name of ['claudeSessionId', 'codexSessionId', 'geminiSessionId', 'piSessionId']) assert.equal(session[name], null);
  }
});


test('Codex headless MCP map omits every unrelated server without editing user configuration', () => {
  const root = project('codex-map', 'https://codex-map.test', 4);
  const dir = path.join(root, '.codex');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'config.toml');
  const original = '[mcp_servers.tipatask]\nurl="https://codex-map.test/api/projects/4/mcp"\nbearer_token_env_var="TIPATASK_API_TOKEN"\n[mcp_servers.tipatask-local]\ncommand="node"\n[mcp_servers."has space.with.dots"]\ncommand="third-party"\n[mcp_servers.legacy]\ntransport="invalid"\n';
  fs.writeFileSync(file, original);
  const { CODEX_OBJECTIVE_PROFILE } = require('./providers/tool-profiles');
  const value = require('../codex-mcp-config').buildScopedCodexMcpOverride(root, CODEX_OBJECTIVE_PROFILE);
  const parsed = require('toml').parse(value).mcp_servers;
  assert.deepEqual(Object.keys(parsed), ['tipatask', 'tipatask-local']);
  assert.ok(parsed.tipatask.disabled_tools.includes('update_task'));
  assert.deepEqual(parsed['tipatask-local'].enabled_tools, ['batch_grep_tags']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});


test('backend credential watchers invalidate caches on same-token retarget and sign-out', () => {
  const root = project('watch-context', 'https://watch.test', 1);
  writeAccountToken('https://watch.test', jwt({ id: 1 }));
  let resets = 0;
  const watch = require('./api-credentials').createTokenWatch(() => { resets++; });
  getApiCredentials(root, { watch });
  assert.equal(resets, 0);
  writeProjectConfig(root, { ...readProjectConfig(root), API_PROJECT_ID: 2 });
  getApiCredentials(root, { watch });
  assert.equal(resets, 1);
  clearAccountToken('https://watch.test');
  assert.throws(() => getApiCredentials(root, { watch }), /No signed-in account token/);
  assert.equal(resets, 2);
});


test('legacy .env setup and harness refresh cannot replace the shared signed-in account', () => {
  const base = 'https://legacy-env.test';
  const token = jwt({ id: 7 });
  writeAccountToken(base, token);
  const root = path.join(sandbox, 'legacy-env');
  fs.mkdirSync(path.join(root, 'ai/todo/server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ai/todo/server/.env'), `API_BASE_URL=${base}\nAPI_PROJECT_ID=1\nAPI_TOKEN=stale-legacy-token\n`);
  require('./project-config').migrateFromLegacy(root);
  assert.ok(getApiCredentials(root).token === token);
  assert.ok(!fs.readFileSync(path.join(root, '.tipatask/config.json'), 'utf8').includes('API_TOKEN'));
  const first = path.join(sandbox, 'legacy-shell');
  fs.mkdirSync(path.join(first, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(first, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: 'https://legacy-shell.test', API_PROJECT_ID: 3, API_TOKEN: token }));
  writeProjectMcpConfig(first, server);
  assert.ok(readAccount('https://legacy-shell.test').token === token, 'refresh migrates before installing a read-only helper');
  assert.ok(!Object.hasOwn(readProjectConfig(first), 'API_TOKEN'));
});
