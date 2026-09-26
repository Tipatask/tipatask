'use strict';

// TPT349 — derived spawn-time MCP config (headersHelper for the remote `tipatask` server) and the
// helper script it points at.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildHeadersHelperCommand, writeSpawnMcpConfig, HELPER_SCRIPT } = require('./mcp-spawn-config');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MCP_JSON = {
  mcpServers: {
    tipatask: {
      type: 'http',
      url: '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp',
      headers: { Authorization: 'Bearer ${API_TOKEN}', 'X-Tipatask-Session-Task': '${TIPATASK_TASK_ID:-}' },
    },
    'tipatask-local': { command: '/bin/local', args: ['x'], env: { TIPATASK_MCP_LOCAL_ONLY: '1' } },
    other: { type: 'http', url: 'https://example.test/mcp' },
  },
};

// ── buildHeadersHelperCommand ──

test('buildHeadersHelperCommand: posix quotes every path; electron adds ELECTRON_RUN_AS_NODE', () => {
  const plain = buildHeadersHelperCommand({ execPath: '/usr/bin/node', scriptPath: '/srv/app/auth-header-helper.js', projectRoot: '/work/my proj', electron: false, platform: 'darwin' });
  assert.strictEqual(plain, "'/usr/bin/node' '/srv/app/auth-header-helper.js' --project-root '/work/my proj'");
  const electron = buildHeadersHelperCommand({ execPath: '/Applications/TipATask.app/Contents/MacOS/TipATask', scriptPath: '/a/app.asar/src/mcp/auth-header-helper.js', projectRoot: '/w', electron: true, platform: 'darwin' });
  assert.ok(electron.startsWith('ELECTRON_RUN_AS_NODE=1 '), electron);
});

test('buildHeadersHelperCommand: a single quote in a path cannot break out of the quoting', () => {
  const cmd = buildHeadersHelperCommand({ execPath: '/n', scriptPath: '/s.js', projectRoot: "/it's/here", electron: false, platform: 'linux' });
  assert.strictEqual(cmd, `'/n' '/s.js' --project-root '/it'\\''s/here'`);
  const shell = spawnSync('/bin/sh', ['-c', `printf '%s' ${cmd.replace("'/n' '/s.js' --project-root ", '')}`], { encoding: 'utf8' });
  assert.strictEqual(shell.stdout, "/it's/here");
});

test('buildHeadersHelperCommand: win32 uses set + double quotes; refuses a path with a double quote', () => {
  const cmd = buildHeadersHelperCommand({ execPath: 'C:\\App\\TipATask.exe', scriptPath: 'C:\\App\\h.js', projectRoot: 'D:\\p q', electron: true, platform: 'win32' });
  assert.strictEqual(cmd, 'set "ELECTRON_RUN_AS_NODE=1" && "C:\\App\\TipATask.exe" "C:\\App\\h.js" --project-root "D:\\p q"');
  assert.strictEqual(buildHeadersHelperCommand({ execPath: 'a', scriptPath: 'b"c', projectRoot: 'd', electron: false, platform: 'win32' }), null);
});

test('buildHeadersHelperCommand: missing inputs → null', () => {
  assert.strictEqual(buildHeadersHelperCommand({ projectRoot: '' }), null);
});

// ── writeSpawnMcpConfig ──

test('writeSpawnMcpConfig: adds headersHelper to the tipatask http entry only; project .mcp.json untouched', (t) => {
  const project = tmp(t, 'tt-mcpcfg-proj-');
  const userData = tmp(t, 'tt-mcpcfg-data-');
  const original = JSON.stringify(MCP_JSON, null, 2) + '\n';
  fs.writeFileSync(path.join(project, '.mcp.json'), original);

  const out = writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: 'HELPER CMD' });

  assert.ok(out && out.startsWith(path.join(userData, 'mcp-spawn') + path.sep), out);
  const derived = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(derived.mcpServers.tipatask.headersHelper, 'HELPER CMD');
  assert.deepStrictEqual(derived.mcpServers.tipatask.headers, MCP_JSON.mcpServers.tipatask.headers, 'static header stays as the fallback');
  assert.deepStrictEqual(derived.mcpServers['tipatask-local'], MCP_JSON.mcpServers['tipatask-local']);
  assert.deepStrictEqual(derived.mcpServers.other, MCP_JSON.mcpServers.other);
  assert.strictEqual(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'), original);
});

test('writeSpawnMcpConfig: stable path per project, idempotent, refreshes when the command changes', (t) => {
  const project = tmp(t, 'tt-mcpcfg-proj-');
  const userData = tmp(t, 'tt-mcpcfg-data-');
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify(MCP_JSON));
  const a = writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: 'one' });
  const mtime = fs.statSync(a).mtimeMs;
  const b = writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: 'one' });
  assert.strictEqual(a, b);
  assert.strictEqual(fs.statSync(b).mtimeMs, mtime, 'unchanged content is not rewritten');
  const c = writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: 'two' });
  assert.strictEqual(c, a);
  assert.strictEqual(JSON.parse(fs.readFileSync(c, 'utf8')).mcpServers.tipatask.headersHelper, 'two');
  const other = tmp(t, 'tt-mcpcfg-proj2-');
  fs.writeFileSync(path.join(other, '.mcp.json'), JSON.stringify(MCP_JSON));
  assert.notStrictEqual(writeSpawnMcpConfig({ projectRoot: other, userDataRoot: userData, helperCommand: 'one' }), a);
});

test('writeSpawnMcpConfig: nothing to derive → null (missing/invalid file, no tipatask entry, non-http entry)', (t) => {
  const project = tmp(t, 'tt-mcpcfg-proj-');
  const userData = tmp(t, 'tt-mcpcfg-data-');
  const call = () => writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: 'x' });
  assert.strictEqual(call(), null, 'no .mcp.json');
  fs.writeFileSync(path.join(project, '.mcp.json'), '{ not json');
  assert.strictEqual(call(), null, 'invalid json');
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'u' } } }));
  assert.strictEqual(call(), null, 'no tipatask entry');
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { tipatask: { command: 'x' } } }));
  assert.strictEqual(call(), null, 'stdio tipatask entry');
  assert.strictEqual(writeSpawnMcpConfig({ projectRoot: project, userDataRoot: userData, helperCommand: '' }), null);
});

// ── auth-header-helper.js ──

function runHelper(args, opts = {}) {
  return spawnSync(process.execPath, [HELPER_SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

test('auth-header-helper: prints the live config token as an Authorization header', (t) => {
  const root = tmp(t, 'tt-helper-');
  fs.mkdirSync(path.join(root, '.tipatask'));
  const cfgPath = path.join(root, '.tipatask', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ API_TOKEN: 'first.token.value' }));
  let r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer first.token.value' });
  assert.strictEqual(r.stderr, '');
  // Re-auth / refresh replaces the token: the very next run (an MCP reconnect) sees it.
  fs.writeFileSync(cfgPath, JSON.stringify({ API_TOKEN: 'second.token.value' }));
  r = runHelper(['--project-root', root]);
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer second.token.value' });
});

test('auth-header-helper: TIPATASK_PROJECT_ROOT / cwd fallbacks, --project-root wins', (t) => {
  const a = tmp(t, 'tt-helper-a-');
  const b = tmp(t, 'tt-helper-b-');
  for (const [dir, tok] of [[a, 'aaa.aaa.aaa'], [b, 'bbb.bbb.bbb']]) {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({ API_TOKEN: tok }));
  }
  assert.match(runHelper([], { env: { ...process.env, TIPATASK_PROJECT_ROOT: a } }).stdout, /aaa\.aaa\.aaa/);
  assert.match(runHelper([], { cwd: b, env: { ...process.env, TIPATASK_PROJECT_ROOT: '' } }).stdout, /bbb\.bbb\.bbb/);
  assert.match(runHelper(['--project-root', b], { env: { ...process.env, TIPATASK_PROJECT_ROOT: a } }).stdout, /bbb\.bbb\.bbb/);
});

test('auth-header-helper: no token / unreadable config → exit 1 with empty stdout (Claude keeps static headers)', (t) => {
  const root = tmp(t, 'tt-helper-');
  let r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_TOKEN: '   ' }));
  r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), '{ broken');
  r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
});
