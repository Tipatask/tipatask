'use strict';

// Spawn-time MCP config for Claude sessions. The project's .mcp.json registers the remote
// `tipatask` server with `Authorization: Bearer ${API_TOKEN}`, which Claude Code expands from
// its own process environment once, at launch — so a token that expires (7-day JWT) or is
// replaced by a re-auth mid-session keeps being re-sent stale, even across /mcp reconnects.
//
// When the installed CLI supports `headersHelper`, the Task App points Claude at a derived
// copy of .mcp.json (under USER_DATA_ROOT, never inside the project) whose `tipatask` entry
// also carries a headersHelper command. Claude runs that command on every connect/reconnect
// and its output overrides the static Authorization header, so /mcp → Reconnect picks up the
// current token in .tipatask/config.json. The project's own .mcp.json is never modified; the
// static header stays as the fallback if the helper fails.

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
  if (platform === 'win32') {
    if ([execPath, scriptPath, projectRoot, userDataRoot || ''].some((p) => String(p).includes('"'))) return null;
    const prefix = electron ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : '';
    const userData = userDataRoot ? ` --user-data "${userDataRoot}"` : '';
    return `${prefix}"${execPath}" "${scriptPath}" --project-root "${projectRoot}"${userData}`;
  }
  const prefix = electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  const userData = userDataRoot ? ` --user-data ${shQuote(userDataRoot)}` : '';
  return `${prefix}${shQuote(execPath)} ${shQuote(scriptPath)} --project-root ${shQuote(projectRoot)}${userData}`;
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
// them — the caller then spawns without the flag and relies on its tool allowlist alone.
function writeScopedMcpConfig({ projectRoot, userDataRoot, servers, label }) {
  if (!projectRoot || !userDataRoot || !Array.isArray(servers) || !label) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
  } catch {
    return null;
  }
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
