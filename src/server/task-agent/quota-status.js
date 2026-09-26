'use strict';

const REASONS = new Set(['unsupported_provider', 'unsupported_auth', 'signed_out',
  'cli_missing', 'credentials_unavailable', 'credentials_expired', 'access_denied',
  'rate_limited', 'timeout', 'provider_error', 'invalid_response', 'quota_unavailable']);

function quotaError(reason) {
  return Object.assign(new Error(reason), { quotaReason: reason });
}

function reasonFor(error) {
  if (REASONS.has(error?.quotaReason)) return error.quotaReason;
  if (error?.code === 'ENOENT') return 'cli_missing';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.killed) return 'timeout';
  return 'provider_error';
}

function isoTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

// Only these fields cross the HTTP boundary. Never spread provider replies/errors here.
function normalizeQuota(provider, projectRoot, raw = {}) {
  const connectionState = ['connected', 'signed_out', 'unsupported', 'unknown'].includes(raw.connectionState)
    ? raw.connectionState : 'unknown';
  const unavailableReason = REASONS.has(raw.unavailableReason) ? raw.unavailableReason : null;
  const windows = (Array.isArray(raw.windows) ? raw.windows : []).flatMap(w => {
    if (!w || typeof w.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id)) return [];
    const usagePercent = typeof w.usagePercent === 'number' && Number.isFinite(w.usagePercent) && w.usagePercent >= 0
      ? w.usagePercent : null;
    const resetAt = isoTime(w.resetAt);
    return [{ id: w.id, usagePercent, resetAt,
      windowMinutes: Number.isFinite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null,
      exhausted: usagePercent === null ? null : usagePercent >= 100 }];
  });
  const known = windows.some(w => w.usagePercent !== null);
  return {
    provider, projectRoot, connectionState,
    plan: typeof raw.plan === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.plan) ? raw.plan : null,
    status: unavailableReason || !known ? 'unavailable' : windows.some(w => w.exhausted) ? 'exhausted' : 'available',
    windows,
    unavailableReason: unavailableReason || (known ? null : 'quota_unavailable'),
    checkedAt: new Date().toISOString(),
  };
}

// Coalesce only simultaneous reads of the same credential snapshot; retain no completed
// quota results, so logout/login and project switches cannot serve an old account's cache.
const inFlight = new Map();
function coalesceQuota(key, read) {
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = Promise.resolve().then(read).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

module.exports = { quotaError, reasonFor, isoTime, normalizeQuota, coalesceQuota };
