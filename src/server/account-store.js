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
// A server root inside an app.asar is read-only, so it is skipped in favour of the default.
function userDataRoot(opts) {
  if (opts && opts.userDataRoot) return opts.userDataRoot;
  if (process.env.TIPATASK_USER_DATA) return path.resolve(process.env.TIPATASK_USER_DATA);
  const serverRoot = process.env.TIPATASK_SERVER_ROOT;
  if (serverRoot && !/\.asar([\\/]|$)/.test(serverRoot)) return path.resolve(serverRoot);
  return path.resolve(__dirname, '../..');
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
    console.warn(`[account-store] read failed: ${e.message}`);
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

// Every stored account, for UIs that list who is signed in where.
function listAccounts(opts) {
  return Object.values(readStore(opts).accounts).filter((a) => a && a.token);
}

function writeAccountToken(baseUrl, token, opts) {
  const key = normalizeBaseUrl(baseUrl);
  const value = typeof token === 'string' ? token.trim() : '';
  if (!key) throw new Error('account store needs an API base URL');
  if (!value) throw new Error('account store needs a token');
  const payload = decodeTokenPayload(value) || {};
  const store = readStore(opts);
  const next = {
    version: STORE_VERSION,
    accounts: {
      ...store.accounts,
      [key]: {
        token: value,
        userId: payload.id != null ? payload.id : null,
        email: typeof payload.email === 'string' ? payload.email : '',
        apiBaseUrl: key,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeStore(next, opts);
  return next.accounts[key];
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
  normalizeBaseUrl,
  decodeTokenPayload,
  readAccount,
  listAccounts,
  writeAccountToken,
  clearAccountToken,
};
