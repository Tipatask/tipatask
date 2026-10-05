'use strict';

// App-level account store. The Tipatask API issues one account-wide desktop token per
// signed-in user (TPT449: `purpose: 'desktop'`, no project_id claim), so the Task App keeps
// it here, under USER_DATA_ROOT, instead of copying it into every project's
// .tipatask/config.json. A project's config.json only says WHERE it lives (API_BASE_URL +
// API_PROJECT_ID); WHO is signed in is app metadata.
//
// One entry per API server, keyed by the normalized base URL: a machine can hold a
// production project and a self-hosted one at once, each with its own signed-in account.
//
// Dependency-light on purpose (fs/path only, never config.js): project-config.js,
// api-credentials.js and token-refresh.js all load this module, and config.js itself loads
// project-config.js at startup.
// Token values are never logged.

const fs = require('node:fs');
const path = require('node:path');

const STORE_FILE = '.tipatask-account.json';
const STORE_VERSION = 1;

// Mirrors config.js USER_DATA_ROOT without loading it (config.js builds the forked server's
// static singleton, which Electron's main process must not initialize just to read a
// token): TIPATASK_USER_DATA, else the server root — TIPATASK_SERVER_ROOT, else this checkout.
// A packaged app.asar needs an explicit writable user-data location; never guess one.
function userDataRoot(opts) {
  if (opts && opts.userDataRoot) return opts.userDataRoot;
  if (process.env.TIPATASK_USER_DATA) return path.resolve(process.env.TIPATASK_USER_DATA);
  const serverRoot = opts?.serverRoot || process.env.TIPATASK_SERVER_ROOT || path.resolve(__dirname, '../..');
  if (/\.asar([\\/]|$)/.test(serverRoot)) {
    const err = new Error('TIPATASK_USER_DATA is missing for the packaged runtime; refresh the agent harness.');
    err.missingCredentials = true;
    throw err;
  }
  return path.resolve(serverRoot);
}

function accountStorePath(opts) {
  return path.join(userDataRoot(opts), STORE_FILE);
}

// "https://web.tipatask.com/" and "HTTPS://Web.Tipatask.com" are the same server.
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

// Unverified payload decode — only used to label the stored account with the user's id and
// email. Trust decisions stay with the API, which verifies the signature on every request.
function decodeTokenPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

// path -> { mtimeMs, value }. getApiCredentials() runs on every request, so avoid a
// read+parse unless the file actually changed (same discipline as readProjectConfig()).
const _cache = new Map();

function readStore(opts) {
  const file = accountStorePath(opts);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    _cache.delete(file);
    if (e.code !== 'ENOENT') console.warn(`[account-store] stat failed: ${e.message}`);
    return { version: STORE_VERSION, accounts: {} };
  }
  const cached = _cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  let value = { version: STORE_VERSION, accounts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
      value = { version: STORE_VERSION, accounts: parsed.accounts };
    }
  } catch (e) {
    // JSON parse errors can quote the input, including a bearer token.
    console.warn('[account-store] unreadable account store — sign in again or repair the user-data path');
  }
  _cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function writeStore(store, opts) {
  const file = accountStorePath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  // 0600: this file holds a bearer token.
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  _cache.delete(file);
}

// -> { token, userId, email, apiBaseUrl, updatedAt } or null
function readAccount(baseUrl, opts) {
  const key = normalizeBaseUrl(baseUrl);
  if (!key) return null;
  const entry = readStore(opts).accounts[key];
  if (!entry || typeof entry.token !== 'string' || !entry.token) return null;
  return entry;
}

// A legacy project JWT remains usable only for that project. This is a local
// scope check, not signature verification (the API remains authoritative).
function assertTokenProject(token, projectId) {
  const payload = decodeTokenPayload(token);
  if (payload?.project_id != null && String(payload.project_id) !== String(projectId)) {
    const err = new Error('Stored token is scoped to another project — sign in again to obtain an account token.');
    err.authError = true;
    err.reasonCode = 'project-scope';
    throw err;
  }
}

// Every stored account, for UIs that list who is signed in where.
function listAccounts(opts) {
  return Object.values(readStore(opts).accounts).filter((a) => a && a.token);
}

// The one per-API-server write. userId/email come from the caller when it has the hydrated
// account (GET /api/auth/me after sign-in), else from the token payload.
function saveAccountForServer(baseUrl, { token, userId, email } = {}, opts) {
  const key = normalizeBaseUrl(baseUrl);
  const value = typeof token === 'string' ? token.trim() : '';
  if (!key) throw new Error('account store needs an API base URL');
  if (!value) throw new Error('account store needs a token');
  const payload = decodeTokenPayload(value) || {};
  const id = userId != null ? userId : payload.id;
  const mail = typeof email === 'string' && email ? email : payload.email;
  const store = readStore(opts);
  const next = {
    version: STORE_VERSION,
    accounts: {
      ...store.accounts,
      [key]: {
        token: value,
        userId: id != null ? id : null,
        email: typeof mail === 'string' ? mail : '',
        apiBaseUrl: key,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeStore(next, opts);
  return next.accounts[key];
}

function writeAccountToken(baseUrl, token, opts) {
  return saveAccountForServer(baseUrl, { token }, opts);
}

// The API server of the most recently signed-in account, or '' when nobody is signed in.
// Default target for an account-level sign-in started without a project.
function defaultAccountServer(opts) {
  let best = null;
  for (const a of listAccounts(opts)) {
    if (!a.apiBaseUrl) continue;
    if (!best || String(a.updatedAt || '') > String(best.updatedAt || '')) best = a;
  }
  return best ? best.apiBaseUrl : '';
}

// Sign out of one server. No-op (and no file write) when nothing is stored for it.
function clearAccountToken(baseUrl, opts) {
  const key = normalizeBaseUrl(baseUrl);
  if (!key) return false;
  const store = readStore(opts);
  if (!store.accounts[key]) return false;
  const accounts = { ...store.accounts };
  delete accounts[key];
  writeStore({ version: STORE_VERSION, accounts }, opts);
  return true;
}

module.exports = {
  STORE_FILE,
  accountStorePath,
  userDataRoot,
  assertTokenProject,
  normalizeBaseUrl,
  decodeTokenPayload,
  readAccount,
  listAccounts,
  defaultAccountServer,
  saveAccountForServer,
  writeAccountToken,
  clearAccountToken,
};
