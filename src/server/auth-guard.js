'use strict';

// (C1383) Fail-closed auth guard — pure, no network. Detects a known-dead API_TOKEN
// (missing, malformed, or locally decodable as expired) BEFORE a request is sent or an
// agent process is spawned. Deliberately permissive on anything it cannot judge (opaque
// tokens, tokens with no `exp` claim) — this module's job is to catch a *known*-dead
// token, not to act as a second authority. The API's own 401/403 response remains the
// only ground truth for "this token no longer works."

const { getApiCredentials } = require('./api-credentials');

// Reason codes the factory (task-backend.js) will pre-latch a backend for. `missing` is
// deliberately excluded — an unconfigured project must still open far enough to reach
// the setup wizard; api-backend.js's init() already calls _markUnauthorized() for that
// case via the existing missingCredentials path.
const SEALING_REASONS = new Set(['expired', 'malformed']);

class AuthCorruptedError extends Error {
  constructor(message, { reasonCode = null, statusCode = null } = {}) {
    super(message);
    this.name = 'AuthCorruptedError';
    this.code = 'EAUTH';
    this.reasonCode = reasonCode;
    if (statusCode != null) this.statusCode = statusCode;
    // Back-compat: init() (api-backend.js) and main/window-state.js's backend.init()
    // catch already branch on err.authError — keep this error recognized by both.
    this.authError = true;
  }
}

function base64UrlDecode(seg) {
  const padded = seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(seg.length + ((4 - (seg.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

// Decodes a JWT's payload segment with no signature verification — the client cannot
// verify a signature (no secret), and the API remains the authority on validity. Used
// only to read the `exp` claim for a local, best-effort expiry pre-check.
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

// { ok, reason, reasonCode }. Permissive by design — see file header.
function inspectToken(token, { now = Date.now(), skewMs = 0 } = {}) {
  if (!token) {
    return { ok: false, reason: 'API_TOKEN missing', reasonCode: 'missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    // Opaque (non-JWT) token — nothing to inspect locally, let the API decide.
    return { ok: true, reason: null, reasonCode: 'undecodable' };
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return { ok: false, reason: 'API_TOKEN is malformed', reasonCode: 'malformed' };
  }
  if (payload.exp == null) {
    return { ok: true, reason: null, reasonCode: 'no-exp' };
  }
  const expMs = Number(payload.exp) * 1000;
  if (!Number.isFinite(expMs)) {
    return { ok: true, reason: null, reasonCode: 'no-exp' };
  }
  if (expMs < now - skewMs) {
    return { ok: false, reason: 'API_TOKEN expired', reasonCode: 'expired' };
  }
  return { ok: true, reason: null, reasonCode: 'ok' };
}

// Sync, never throws. Resolves the live token for `projectRoot` and inspects it.
function validateCredentials(projectRoot, opts = {}) {
  let token;
  try {
    ({ token } = getApiCredentials(projectRoot));
  } catch (err) {
    if (err && err.missingCredentials) {
      return { ok: false, reason: err.message, reasonCode: 'missing' };
    }
    // Unexpected read failure — don't seal on something this module can't name.
    return { ok: true, reason: null, reasonCode: 'unreadable' };
  }
  return inspectToken(token, opts);
}

// A project JWT lives 7 days and is frozen into a spawned agent's environment at launch, so
// a session that starts with little life left loses its remote MCP mid-task. Below the
// REFRESH margin the gate tries to swap in a fresh token before the spawn; below the
// MIN_LAUNCH floor a token that could not be refreshed blocks the launch outright.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const MIN_LAUNCH_MS = 30 * 60 * 1000;

// Expiry of a JWT in epoch ms, or null when it has none / is not decodable — the same
// "can't judge" cases inspectToken() lets through.
function tokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || payload.exp == null) return null;
  const ms = Number(payload.exp) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

// Local wall-clock rendering for user-facing messages: "HH:MM" when the moment falls on the
// same calendar day as `now`, otherwise "YYYY-MM-DD HH:MM".
function formatTokenExpiry(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const pad = (v) => String(v).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// Async pre-spawn gate. Throws AuthCorruptedError when the credentials are locally
// known-dead, or when the backend is already latched 'unauthorized' from a prior 401/403.
// Reads the token via backend.getCredentials() (existing public method, api-backend.js)
// rather than re-resolving projectRoot — keeps this gate backend-shaped, not path-shaped.
//
// `opts.refresh({ baseUrl, token, projectId })` (optional) → Promise<{ token }> mints and
// persists a replacement; called only for a decodable JWT with under REFRESH_MARGIN_MS left.
// Resolves `{ refreshed, expiresAt, previousExpiresAt?, warning? }` (expiresAt in epoch ms,
// null when the token carries no `exp`). Callers that ignore the result keep the old contract.
async function assertCredentialsUsable(backend, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (backend && typeof backend.getConnectionState === 'function' && backend.getConnectionState() === 'unauthorized') {
    throw new AuthCorruptedError('Authentication expired or invalid — sign in again.', { reasonCode: 'unauthorized' });
  }
  let creds;
  try {
    creds = backend.getCredentials();
  } catch (err) {
    if (err && err.missingCredentials) {
      throw new AuthCorruptedError(err.message, { reasonCode: 'missing' });
    }
    // Unexpected read failure — not this gate's call to make; let the spawn proceed
    // and fail at the real request layer instead of blocking on an unrelated error.
    return { refreshed: false, expiresAt: null };
  }
  const { baseUrl, token, projectId } = creds;
  const verdict = inspectToken(token, { now });
  const expMs = tokenExpiryMs(token);
  if (!verdict.ok) {
    if (verdict.reasonCode === 'expired' && expMs != null) {
      throw new AuthCorruptedError(`API token expired at ${formatTokenExpiry(expMs, now)} — sign in again.`, { reasonCode: 'expired' });
    }
    throw new AuthCorruptedError(verdict.reason || 'Authentication invalid', { reasonCode: verdict.reasonCode });
  }
  if (expMs == null) return { refreshed: false, expiresAt: null }; // opaque / no-exp: nothing to judge
  const remaining = expMs - now;
  if (remaining >= REFRESH_MARGIN_MS) return { refreshed: false, expiresAt: expMs };

  let failure = null;
  if (typeof opts.refresh === 'function') {
    try {
      const result = await opts.refresh({ baseUrl, token, projectId });
      const newExpMs = tokenExpiryMs(result && result.token);
      if (newExpMs != null && newExpMs > expMs) {
        return { refreshed: true, expiresAt: newExpMs, previousExpiresAt: expMs };
      }
      failure = new Error('refresh returned no newer token');
    } catch (err) {
      failure = err;
    }
  }

  const when = formatTokenExpiry(expMs, now);
  const why = failure ? ` and could not be refreshed (${(failure && failure.message) || 'unknown error'})` : '';
  if (remaining < MIN_LAUNCH_MS) {
    throw new AuthCorruptedError(`API token expires at ${when}${why} — sign in again.`, { reasonCode: 'expiring' });
  }
  return {
    refreshed: false,
    expiresAt: expMs,
    warning: failure ? `API token expires at ${when}${why}. Task tools stop then.` : null,
  };
}

module.exports = {
  AuthCorruptedError,
  SEALING_REASONS,
  REFRESH_MARGIN_MS,
  MIN_LAUNCH_MS,
  decodeJwtPayload,
  tokenExpiryMs,
  formatTokenExpiry,
  inspectToken,
  validateCredentials,
  assertCredentialsUsable,
};
