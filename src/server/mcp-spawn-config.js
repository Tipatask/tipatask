'use strict';

// Derived Claude registrations bind the selected project URL and live account-store
// helper. An empty static header prevents reuse of stale launch-time credentials.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REMOTE_SERVER_NAME = 'tipatask';
const HELPER_SCRIPT = path.join(__dirname, '..', 'mcp', 'auth-header-helper.js');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Claude executes the helper through a shell (sh on posix, cmd on win32). `electron` marks a
// process whose execPath is the Electron binary, which needs ELECTRON_RUN_AS_NODE=1 to act as
// plain Node. `userDataRoot` (optional) tells the helper where the account store lives. Returns null for input it cannot quote safely (a double quote in a Windows
// path is not a legal filename character anyway).
function buildHeadersHelperCommand({
  execPath = process.execPath,
  scriptPath = HELPER_SCRIPT,
  projectRoot,
  userDataRoot,
  electron = !!process.versions.electron,
  platform = process.platform,
} = {}) {
  if (!execPath || !scriptPath || !projectRoot) return null;
  // Bind helper output to the URL this MCP registration actually connects to.
  // A project re-targeted on disk must not send its new server's token to the old URL.
  let target = null;
  try { target = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tipatask/config.json'), 'utf8')); } catch { /* unconfigured */ }
  const binding = target?.API_BASE_URL && target?.API_PROJECT_ID
    ? ['--api-base-url', String(target.API_BASE_URL), '--project-id', String(target.API_PROJECT_ID)] : [];
  if (platform === 'win32') {
    if ([execPath, scriptPath, projectRoot, userDataRoot || '', ...binding].some((p) => /["%\r\n]/.test(String(p)))) return null;
    const prefix = electron ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : '';
    const userData = userDataRoot ? ` --user-data "${userDataRoot}"` : '';
    return `${prefix}"${execPath}" "${scriptPath}" --project-root "${projectRoot}"${userData}${binding.length ? ' ' + binding.map(v => `"${v}"`).join(' ') : ''}`;
  }
  const prefix = electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  const userData = userDataRoot ? ` --user-data ${shQuote(userDataRoot)}` : '';
  return `${prefix}${shQuote(execPath)} ${shQuote(scriptPath)} --project-root ${shQuote(projectRoot)}${userData}${binding.length ? ' ' + binding.map(shQuote).join(' ') : ''}`;
}

// Writes the derived config and returns its path, or null when there is nothing to derive
// (no/invalid .mcp.json, or no `tipatask` http entry) — the caller then keeps the project's
// own .mcp.json. Only the `tipatask` entry is touched; every other server is copied verbatim.
function writeSpawnMcpConfig({ projectRoot, userDataRoot, helperCommand }) {
  if (!projectRoot || !userDataRoot || !helperCommand) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
  } catch {
    return null;
  }
  const entry = parsed && parsed.mcpServers && parsed.mcpServers[REMOTE_SERVER_NAME];
  if (!entry || typeof entry !== 'object' || entry.type !== 'http') return null;
  const target = require('./project-config').readProjectConfig(projectRoot);
  if (!target?.API_BASE_URL || !target?.API_PROJECT_ID) return null;
  entry.url = `${String(target.API_BASE_URL).replace(/\/+$/, '')}/api/projects/${encodeURIComponent(target.API_PROJECT_ID)}/mcp`;
  entry.headers = { ...entry.headers, Authorization: '' };
  entry.headersHelper = helperCommand;

  const dir = path.join(userDataRoot, 'mcp-spawn');
  const id = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  const outPath = path.join(dir, `${id}.json`);
  const content = JSON.stringify(parsed, null, 2) + '\n';
  try {
    let unchanged = false;
    try { unchanged = fs.readFileSync(outPath, 'utf8') === content; } catch { /* absent */ }
    if (!unchanged) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${outPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, outPath);
    }
  } catch (err) {
    console.warn(`[mcp-spawn-config] could not write derived MCP config: ${err.message}`);
    return null;
  }
  return outPath;
}

// Writes a copy of the project's .mcp.json holding only the named servers and returns its
// path, for a spawn that pairs it with --strict-mcp-config so no other MCP server (project or
// user-level) is reachable. Returns null when .mcp.json is missing/invalid or defines none of
// them — headless callers use an empty strict config in that case.
function writeScopedMcpConfig({ projectRoot, userDataRoot, servers, label }) {
  if (!projectRoot || !userDataRoot || !Array.isArray(servers) || !label) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
  } catch {
    return null;
  }
  // Refresh managed URL/helper/roots before scoping; user servers are never carried
  // into a headless chat. The shared writer preserves their project registration.
  const target = require('./project-config').readProjectConfig(projectRoot);
  if (target?.API_BASE_URL && target?.API_PROJECT_ID && parsed?.mcpServers?.tipatask?.type === 'http') {
    const entry = parsed.mcpServers.tipatask;
    entry.url = `${String(target.API_BASE_URL).replace(/\/+$/, '')}/api/projects/${encodeURIComponent(target.API_PROJECT_ID)}/mcp`;
    entry.headers = { ...entry.headers, Authorization: '' };
    entry.headersHelper = buildHeadersHelperCommand({ projectRoot, userDataRoot });
  }
  const local = parsed?.mcpServers?.['tipatask-local'];
  if (local) local.env = { ...local.env, TIPATASK_PROJECT_ROOT: path.resolve(projectRoot), TIPATASK_USER_DATA: userDataRoot,
    TIPATASK_SERVER_ROOT: path.resolve(__dirname, '../..'), TIPATASK_MCP_LOCAL_ONLY: '1' };
  const all = parsed && parsed.mcpServers;
  if (!all || typeof all !== 'object') return null;
  const mcpServers = {};
  for (const name of servers) {
    if (all[name] && typeof all[name] === 'object') mcpServers[name] = all[name];
  }
  if (Object.keys(mcpServers).length === 0) return null;

  const dir = path.join(userDataRoot, 'mcp-spawn');
  const id = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  const outPath = path.join(dir, `${id}.${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const content = JSON.stringify({ mcpServers }, null, 2) + '\n';
  try {
    let unchanged = false;
    try { unchanged = fs.readFileSync(outPath, 'utf8') === content; } catch { /* absent */ }
    if (!unchanged) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${outPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, outPath);
    }
  } catch (err) {
    console.warn(`[mcp-spawn-config] could not write scoped MCP config: ${err.message}`);
    return null;
  }
  return outPath;
}

module.exports = { REMOTE_SERVER_NAME, HELPER_SCRIPT, buildHeadersHelperCommand, writeSpawnMcpConfig, writeScopedMcpConfig };
