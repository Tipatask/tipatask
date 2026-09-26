'use strict';

// Silent API_TOKEN renewal. A project-scoped JWT that is still valid can be exchanged for a
// fresh 7-day one through POST /api/auth/project-token (same-project tokens are accepted by
// requireAuth), so a task launch — or the mid-session expiry watch in terminal-session.js —
// can keep a session's credentials alive without sending the user back through sign-in.
// An already-expired token cannot be renewed here; that path stays interactive.
//
// The new token is persisted in the same two places a re-auth writes: the project's
// .tipatask/config.json (read live by getApiCredentials(), projectEnvExtras() and the
// headers helper that feeds the remote MCP server) and the `env` copy in
// .claude/settings.local.json. Token values are never logged.

const fs = require('node:fs');
const path = require('node:path');
const { tokenExpiryMs } = require('./auth-guard');
const { writeProjectConfig, writeProjectClaudeMcpApproval } = require('./project-config');

const CONFIG_REL = path.join('.tipatask', 'config.json');
const DEFAULT_TIMEOUT_MS = 5000;

// projectRoot -> Promise. A second caller for the same project (launch preflight racing the
// expiry watch, or two tasks starting together) joins the request already in flight.
const _inflight = new Map();

// Raw parse, deliberately not readProjectConfig(): that one injects theme/language defaults
// which must not be persisted back as if the user had chosen them.
function readRawConfig(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, CONFIG_REL), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function requestFreshToken({ baseUrl, token, projectId, fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/project-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: Number(projectId) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const code = (err && err.cause && err.cause.code) || (err && err.name === 'TimeoutError' ? 'timeout' : '');
    throw new Error(`token refresh request failed${code ? ` (${code})` : ''}`);
  }
  if (!res.ok) throw new Error(`token refresh rejected (HTTP ${res.status})`);
  let body;
  try { body = await res.json(); } catch { throw new Error('token refresh returned an unreadable response'); }
  const fresh = body && typeof body.token === 'string' ? body.token : '';
  if (tokenExpiryMs(fresh) == null) throw new Error('token refresh returned no usable token');
  return fresh;
}

async function doRefresh({ projectRoot, baseUrl, token, projectId, fetchImpl, timeoutMs }) {
  const fresh = await requestFreshToken({ baseUrl, token, projectId, fetchImpl, timeoutMs });
  const cfg = readRawConfig(projectRoot);
  if (!cfg) throw new Error('.tipatask/config.json is unreadable');
  // Re-auth (or another window's refresh) may have replaced the token while the request was in
  // flight — including the deliberate blank a re-auth writes. Never clobber that.
  if (cfg.API_TOKEN !== token) return { token: cfg.API_TOKEN || '', rotated: true };
  cfg.API_TOKEN = fresh;
  writeProjectConfig(projectRoot, cfg);
  try {
    writeProjectClaudeMcpApproval(projectRoot);
  } catch (err) {
    console.warn(`[token-refresh] settings.local.json env update failed: ${err.message}`);
  }
  return { token: fresh, rotated: false };
}

// Resolves { token, rotated } once the replacement is on disk; rejects with a short,
// token-free message on any failure. `fetchImpl`/`timeoutMs` exist for tests.
function refreshProjectToken({ projectRoot, baseUrl, token, projectId, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!projectRoot || !baseUrl || !token || !projectId) {
    return Promise.reject(new Error('token refresh needs projectRoot, baseUrl, token and projectId'));
  }
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') return Promise.reject(new Error('fetch is unavailable'));
  const existing = _inflight.get(projectRoot);
  if (existing) return existing;
  const run = doRefresh({
    projectRoot,
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    token,
    projectId,
    fetchImpl: impl,
    timeoutMs,
  }).finally(() => { _inflight.delete(projectRoot); });
  _inflight.set(projectRoot, run);
  return run;
}

module.exports = { refreshProjectToken };
