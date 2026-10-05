#!/usr/bin/env node
'use strict';

// ── Remote-MCP headersHelper probe (TPT349) ──
// Confirms, against the REAL installed Claude CLI, the assumption the token-refresh work rests
// on: a `--mcp-config <derived file> --strict-mcp-config` whose `tipatask` http entry carries a
// `headersHelper` gets its Authorization header from the helper (the CURRENT token in
// account store), not from the static `Bearer ${API_TOKEN}` expanded out of the
// launch-time environment. The env deliberately holds a STALE token and the store a FRESH
// one — the exact shape of an expired-then-re-authed session.
//
// The "MCP server" is a local stub on an ephemeral 127.0.0.1 port that only records the
// Authorization header of the first request and answers 401. The CLI is killed as soon as that
// request is seen (or after a timeout), so no model inference is spent. Token values are
// sentinel strings; nothing real is read or sent. Never touches port 4455 or the running app.
//
// Exit codes: 0 = helper output used (FRESH seen) · 2 = static/stale header used (helper not
// run — e.g. trust-gated scope; the Task App then keeps working, but a session needs a restart
// to pick up a new token) · 3 = no MCP request observed · 4 = claude not found.
//
// Usage: npm run probe:mcp-headers-helper

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { resolveBin } = require('../src/server/spawn-utils');
const { buildHeadersHelperCommand, writeSpawnMcpConfig } = require('../src/server/mcp-spawn-config');

const STALE = 'STALE.stale.token';
const FRESH = 'FRESH.fresh.token';
const WAIT_MS = 45000;

function label(authHeader) {
  const value = String(authHeader || '');
  if (value.includes(FRESH)) return 'FRESH (helper output)';
  if (value.includes(STALE)) return 'STALE (static header from launch env)';
  return value ? 'OTHER' : 'none';
}

async function main() {
  const bin = resolveBin('claude');
  if (!bin) { console.error('claude CLI not found on PATH'); process.exit(4); }

  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"Unauthorized"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-probe-hh-proj-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-probe-hh-data-'));
  let child;
  const cleanup = () => {
    try { if (child && !child.killed) child.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  };

  try {
    fs.mkdirSync(path.join(root, '.tipatask'));
    fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ API_BASE_URL: baseUrl, API_PROJECT_ID: '2' }));
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { tipatask: { type: 'http', url: '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } } },
    }));
    require('../src/server/account-store').writeAccountToken(baseUrl, FRESH, { userDataRoot: userData });
    const helperCommand = buildHeadersHelperCommand({ projectRoot: root, userDataRoot: userData, electron: false });
    const derived = writeSpawnMcpConfig({ projectRoot: root, userDataRoot: userData, helperCommand });
    if (!derived) throw new Error('could not derive spawn MCP config');

    console.log(`claude: ${bin}`);
    console.log(`derived config: ${derived}`);
    child = spawn(bin, ['--mcp-config', derived, '--strict-mcp-config', '-p', 'reply with the word ok', '--output-format', 'stream-json', '--verbose'], {
      cwd: root,
      env: { ...process.env, API_BASE_URL: baseUrl, API_PROJECT_ID: '2', API_TOKEN: STALE, TIPATASK_TASK_ID: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });

    const deadline = Date.now() + WAIT_MS;
    while (!seen.length && Date.now() < deadline && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500)); // let a retry/second request land

    if (!seen.length) {
      console.log('RESULT: no MCP request observed within the wait window');
      console.log(out.slice(0, 1500).replace(new RegExp(`${STALE}|${FRESH}`, 'g'), '<sentinel>'));
      cleanup();
      process.exit(3);
    }
    const first = label(seen[0].auth);
    console.log(`requests seen: ${seen.length}; first Authorization: ${first}`);
    const rejected = /HEADERS_HELPER_AUTH_REJECTED|AUTH_HEADER_REJECTED/.exec(out);
    if (rejected) console.log(`CLI error code in output: ${rejected[0]}`);
    cleanup();
    if (first.startsWith('FRESH')) { console.log('RESULT: PASS — headersHelper output overrides the launch-time static header'); process.exit(0); }
    console.log('RESULT: helper NOT applied — static header was sent (scope trust-gated or CLI ignores headersHelper here)');
    process.exit(2);
  } catch (err) {
    cleanup();
    console.error(`probe error: ${err.message}`);
    process.exit(1);
  }
}

main();
