'use strict';

// Silent API_TOKEN renewal. A project-scoped JWT that is still valid can be exchanged for a
// fresh 7-day one through POST /api/auth/project-token (same-project tokens are accepted by
// requireAuth), so a task launch — or the mid-session expiry watch in terminal-session.js —
// can keep a session's credentials alive without sending the user back through sign-in.
// An already-expired token cannot be renewed here; that path stays interactive.
//
// The new token is persisted in the app-level account store (account-store.js, read live by
// getApiCredentials(), projectEnvExtras() and the headers helper that feeds the remote MCP
// server) and mirrored into the `env` copy in .claude/settings.local.json. It is never
// written to the project's config.json. Because the token is account-wide (TPT449), one
// renewal serves every project on that API server, so in-flight requests are joined per
// server, not per project. Token values are never logged.

const { tokenExpiryMs } = require('./auth-guard');
const { writeProjectClaudeMcpApproval } = require('./project-config');
const { readAccount, writeAccountToken, normalizeBaseUrl } = require('./account-store');

const DEFAULT_TIMEOUT_MS = 5000;

// normalized API base URL -> Promise. A second caller on the same server (launch preflight
// racing the expiry watch, two tasks starting together, or two projects of one account)
// joins the request already in flight.
const _inflight = new Map();

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
  // Re-auth (or another window's refresh) may have replaced the token while the request was in
  // flight — including a sign-out that cleared it. Never clobber that.
  const current = readAccount(baseUrl);
  if (!current || current.token !== token) return { token: current ? current.token : '', rotated: true };
  writeAccountToken(baseUrl, fresh);
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
  const flightKey = normalizeBaseUrl(baseUrl);
  const existing = _inflight.get(flightKey);
  if (existing) return existing;
  const run = doRefresh({
    projectRoot,
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    token,
    projectId,
    fetchImpl: impl,
    timeoutMs,
  }).finally(() => { _inflight.delete(flightKey); });
  _inflight.set(flightKey, run);
  return run;
}

module.exports = { refreshProjectToken };
