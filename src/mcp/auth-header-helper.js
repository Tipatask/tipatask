#!/usr/bin/env node
'use strict';

// Claude Code `headersHelper` for the remote `tipatask` MCP server. Claude runs this command
// on every connect and reconnect of the server and merges the JSON it prints over the static
// `headers` of the .mcp.json entry, so the bearer token is read from the project's current
// .tipatask/config.json each time instead of being expanded from the launch-time
// environment (where it stays frozen for the life of the process).
//
// Contract (Claude Code): print one JSON object of string header values on stdout and exit 0.
// Any failure — exit 1 with empty stdout — makes Claude keep the static headers, which is the
// pre-helper behavior. Dependency-free on purpose: it runs under a bare node or under the
// packaged Electron binary with ELECTRON_RUN_AS_NODE=1, and must start fast. The token is
// only ever written to stdout — never to stderr, never to a log.

const fs = require('node:fs');
const path = require('node:path');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

function main() {
  const root = argValue('--project-root') || process.env.TIPATASK_PROJECT_ROOT || process.cwd();
  let token = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
    token = cfg && typeof cfg.API_TOKEN === 'string' ? cfg.API_TOKEN.trim() : '';
  } catch {
    process.exit(1);
  }
  if (!token) process.exit(1);
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
}

main();
