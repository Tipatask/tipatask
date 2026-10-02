#!/usr/bin/env node
'use strict';

// Claude Code `headersHelper` for the remote `tipatask` MCP server. Claude runs this command
// on every connect and reconnect of the server and merges the JSON it prints over the static
// `headers` of the .mcp.json entry, so the bearer token is read from the project's current
// account store each time (the signed-in account's token, app-level under the user-data
// dir — see server/account-store.js) instead of being expanded from the launch-time
// environment (where it stays frozen for the life of the process). The project's
// .tipatask/config.json supplies only API_BASE_URL, which keys the store; a legacy inline
// config.json API_TOKEN is the fallback for a project not yet migrated.
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

// Must match account-store.js normalizeBaseUrl() — this script cannot require it.
function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

// Must match account-store.js userDataRoot(): --user-data, else TIPATASK_USER_DATA, else the
// server root (TIPATASK_SERVER_ROOT unless inside an asar, else this checkout).
function userDataRoot() {
  const explicit = argValue('--user-data') || process.env.TIPATASK_USER_DATA;
  if (explicit) return path.resolve(explicit);
  const serverRoot = process.env.TIPATASK_SERVER_ROOT;
  if (serverRoot && !/\.asar([\\/]|$)/.test(serverRoot)) return path.resolve(serverRoot);
  return path.resolve(__dirname, '..', '..');
}

function readAccountToken(baseUrl) {
  const key = normalizeBaseUrl(baseUrl);
  if (!key) return '';
  try {
    const store = JSON.parse(fs.readFileSync(path.join(userDataRoot(), '.tipatask-account.json'), 'utf8'));
    const entry = store && store.accounts && store.accounts[key];
    return entry && typeof entry.token === 'string' ? entry.token.trim() : '';
  } catch {
    return '';
  }
}

function main() {
  const root = argValue('--project-root') || process.env.TIPATASK_PROJECT_ROOT || process.cwd();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
  } catch {
    process.exit(1);
  }
  const legacy = cfg && typeof cfg.API_TOKEN === 'string' ? cfg.API_TOKEN.trim() : '';
  const token = readAccountToken(cfg && cfg.API_BASE_URL) || legacy;
  if (!token) process.exit(1);
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
}

main();
