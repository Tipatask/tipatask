'use strict';

// TPT349 — derived spawn-time MCP config (headersHelper for the remote `tipatask` server) and the
// helper script it points at.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildHeadersHelperCommand, writeSpawnMcpConfig, writeScopedMcpConfig, HELPER_SCRIPT } = require('./mcp-spawn-config');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (prefix.startsWith('tt-mcp')) {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    fs.writeFileSync(path.join(dir, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '2' }));
  }
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
  assert.equal(derived.mcpServers.tipatask.headers.Authorization, '');
  assert.equal(derived.mcpServers.tipatask.url, 'https://selected.test/api/projects/2/mcp');
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

test('auth-header-helper: prints the account-store token (config.json holds only the project target)', (t) => {
  const root = tmp(t, 'tt-helper-store-');
  const userData = tmp(t, 'tt-helper-store-ud-');
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: 'https://Helper.example.test/', API_PROJECT_ID: '2' }));
  const { writeAccountToken, clearAccountToken } = require('./account-store');
  writeAccountToken('https://helper.example.test', 'store.token.value', { userDataRoot: userData });

  // --user-data wins; TIPATASK_USER_DATA is the fallback the MCP/agent env supplies.
  let r = runHelper(['--project-root', root, '--user-data', userData], { env: { ...process.env, TIPATASK_USER_DATA: '' } });
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer store.token.value' });
  assert.strictEqual(r.stderr, '');
  r = runHelper(['--project-root', root], { env: { ...process.env, TIPATASK_USER_DATA: userData } });
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer store.token.value' });

  // A refresh / re-auth rewrites the store: the very next run (an MCP reconnect) sees it.
  writeAccountToken('https://helper.example.test', 'second.token.value', { userDataRoot: userData });
  r = runHelper(['--project-root', root, '--user-data', userData]);
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer second.token.value' });

  // The store beats a stale inline config.json token; another server's account is never used.
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: 'https://helper.example.test', API_PROJECT_ID: '2', API_TOKEN: 'stale.inline.token' }));
  r = runHelper(['--project-root', root, '--user-data', userData]);
  assert.deepStrictEqual(JSON.parse(r.stdout), { Authorization: 'Bearer second.token.value' });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: 'https://other.example.test', API_PROJECT_ID: '2' }));
  r = runHelper(['--project-root', root, '--user-data', userData]);
  assert.strictEqual(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { Authorization: '' });

  // Signed out: nothing to print.
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: 'https://helper.example.test', API_PROJECT_ID: '2' }));
  clearAccountToken('https://helper.example.test', { userDataRoot: userData });
  r = runHelper(['--project-root', root, '--user-data', userData]);
  assert.strictEqual(r.status, 0);
});

test('buildHeadersHelperCommand: userDataRoot adds --user-data (quoted) so the helper finds the account store', () => {
  const posix = buildHeadersHelperCommand({ execPath: '/n', scriptPath: '/s.js', projectRoot: '/p', userDataRoot: "/Users/me/Library/Application Support/Tip'a", electron: false, platform: 'darwin' });
  assert.strictEqual(posix, "'/n' '/s.js' --project-root '/p' --user-data '/Users/me/Library/Application Support/Tip'\\''a'");
  const win = buildHeadersHelperCommand({ execPath: 'C:\\a.exe', scriptPath: 'C:\\h.js', projectRoot: 'D:\\p', userDataRoot: 'C:\\Users\\me\\AppData', electron: false, platform: 'win32' });
  assert.strictEqual(win, '"C:\\a.exe" "C:\\h.js" --project-root "D:\\p" --user-data "C:\\Users\\me\\AppData"');
  assert.strictEqual(buildHeadersHelperCommand({ execPath: 'a', scriptPath: 'b', projectRoot: 'c', userDataRoot: 'd"e', electron: false, platform: 'win32' }), null);
});

test('auth-header-helper: TIPATASK_PROJECT_ROOT / cwd fallbacks, --project-root wins', (t) => {
  const a = tmp(t, 'tt-helper-a-');
  const b = tmp(t, 'tt-helper-b-');
  for (const [dir, tok] of [[a, 'aaa.aaa.aaa'], [b, 'bbb.bbb.bbb']]) {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: `https://${tok}.test`, API_PROJECT_ID: '1' }));
    require('./account-store').writeAccountToken(`https://${tok}.test`, tok);
  }
  assert.match(runHelper([], { env: { ...process.env, TIPATASK_PROJECT_ROOT: a } }).stdout, /aaa\.aaa\.aaa/);
  assert.match(runHelper([], { cwd: b, env: { ...process.env, TIPATASK_PROJECT_ROOT: '' } }).stdout, /bbb\.bbb\.bbb/);
  assert.match(runHelper(['--project-root', b], { env: { ...process.env, TIPATASK_PROJECT_ROOT: a } }).stdout, /bbb\.bbb\.bbb/);
});

test('auth-header-helper: missing credentials clear the header instead of reusing stale authorization', (t) => {
  const root = tmp(t, 'tt-helper-');
  let r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { Authorization: '' });
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_TOKEN: '   ' }));
  r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { Authorization: '' });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), '{ broken');
  r = runHelper(['--project-root', root]);
  assert.strictEqual(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { Authorization: '' });
});

// ── writeScopedMcpConfig ──

test('writeScopedMcpConfig: keeps only the named servers, verbatim, in its own file', (t) => {
  const projectRoot = tmp(t, 'tt-mcp-scoped-proj-');
  const userDataRoot = tmp(t, 'tt-mcp-scoped-data-');
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify(MCP_JSON));
  const out = writeScopedMcpConfig({ projectRoot, userDataRoot, servers: ['tipatask', 'tipatask-local'], label: 'taskChat' });
  assert.ok(out.startsWith(path.join(userDataRoot, 'mcp-spawn') + path.sep), out);
  assert.match(path.basename(out), /^[0-9a-f]{12}\.taskChat\.json$/);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(Object.keys(written.mcpServers), ['tipatask', 'tipatask-local']);
  assert.equal(written.mcpServers.tipatask.headers.Authorization, '');
  assert.equal(written.mcpServers.tipatask.url, 'https://selected.test/api/projects/2/mcp');
  assert.equal(written.mcpServers['tipatask-local'].env.TIPATASK_PROJECT_ROOT, projectRoot);
  assert.equal(written.mcpServers['tipatask-local'].env.TIPATASK_USER_DATA, userDataRoot);
  // The project's own file is never touched, and the full derived config keeps its own name.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')), MCP_JSON);
  const full = writeSpawnMcpConfig({ projectRoot, userDataRoot, helperCommand: 'helper' });
  assert.notStrictEqual(full, out);
  // Unchanged content is not rewritten.
  const before = fs.statSync(out).mtimeMs;
  assert.strictEqual(writeScopedMcpConfig({ projectRoot, userDataRoot, servers: ['tipatask', 'tipatask-local'], label: 'taskChat' }), out);
  assert.strictEqual(fs.statSync(out).mtimeMs, before);
});

test('writeScopedMcpConfig: null when there is nothing to scope to', (t) => {
  const projectRoot = tmp(t, 'tt-mcp-scoped-none-');
  const userDataRoot = tmp(t, 'tt-mcp-scoped-none-data-');
  const args = { projectRoot, userDataRoot, servers: ['tipatask'], label: 'taskChat' };
  assert.strictEqual(writeScopedMcpConfig(args), null, 'no .mcp.json');
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), '{not json');
  assert.strictEqual(writeScopedMcpConfig(args), null, 'invalid .mcp.json');
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'x' } } }));
  assert.strictEqual(writeScopedMcpConfig(args), null, 'none of the named servers is registered');
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify(MCP_JSON));
  assert.strictEqual(writeScopedMcpConfig({ ...args, label: '' }), null);
  assert.strictEqual(writeScopedMcpConfig({ ...args, servers: null }), null);
  assert.strictEqual(fs.existsSync(path.join(userDataRoot, 'mcp-spawn')), false);
});
