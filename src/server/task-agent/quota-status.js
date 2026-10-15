'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

// One rule for fresh and stale results: a reason, or no measured window, is unavailable.
function quotaStatus(windows, unavailableReason) {
  if (unavailableReason || !windows.some(w => w.usagePercent !== null)) return 'unavailable';
  return windows.some(w => w.exhausted) ? 'exhausted' : 'available';
}

function planOf(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : null;
}

// One window through the allowlist, as a list for flatMap: a provider's fresh window and a saved
// reading read back at boot pass the same rules.
function normalizeWindow(w) {
  if (!w || typeof w.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id)) return [];
  const usagePercent = typeof w.usagePercent === 'number' && Number.isFinite(w.usagePercent) && w.usagePercent >= 0
    ? w.usagePercent : null;
  const resetAt = isoTime(w.resetAt);
  return [{ id: w.id, usagePercent, resetAt,
    windowMinutes: Number.isFinite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null,
    exhausted: usagePercent === null ? null : usagePercent >= 100 }];
}

// (TPT689) Last good reading per `provider:credentialKey`. A reader that knows which account it
// read passes credentialKey, a 64-hex one-way hash (never a token); the key never crosses the HTTP
// boundary. A transient failure serves the reading marked `stale` instead of blanking the rows;
// any other outcome for that key is a definitive answer and drops it.
// (TPT699) Saved across restarts: loadQuotaSnapshots() at server boot (index.js, before the server
// listens) restores <USER_DATA_ROOT>/quota-snapshots.json and every later change is written back,
// synchronously, so a 429 hold right after launch still has a reading to serve. Until that load
// runs the map is memory only — unit tests, the probe and the Electron main process never touch disk.
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_FILE = 'quota-snapshots.json';
const MAX_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_KEY = /^[a-z0-9_-]{1,32}:[0-9a-f]{64}$/;
const TRANSIENT = new Set(['timeout', 'rate_limited', 'provider_error', 'credentials_expired']);
const snapshots = new Map();
let snapshotFile = null; // storage path; null = memory only
let saveError = null; // code of the last failed save, so a lasting failure warns once

// The whole map, written to a temp file and renamed over the old one, so a crash mid-write never
// leaves partial JSON. Each field is picked, never spread: only the hashed key, plan, allowlisted
// windows and checkedAt reach the disk. A failed write keeps the map in memory and never throws
// (it runs inside normalizeQuota()).
function persistSnapshots() {
  if (!snapshotFile) return;
  const saved = {};
  for (const [key, s] of snapshots) saved[key] = { plan: s.plan, windows: s.windows.flatMap(normalizeWindow), checkedAt: s.checkedAt };
  const tmp = `${snapshotFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshots: saved }), { mode: 0o600 });
    fs.renameSync(tmp, snapshotFile);
    saveError = null;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    const code = err.code || err.message;
    if (code !== saveError) console.warn(`[agent-quota] could not save ${snapshotFile}: ${err.message}`);
    saveError = code;
  }
}

function dropSnapshot(key) {
  if (snapshots.delete(key)) persistSnapshots();
}

function rememberQuota(key, normalized) {
  if (!key || !normalized || normalized.stale || normalized.status === 'unavailable') return;
  const now = Date.now();
  for (const [k, s] of snapshots) if (!(now - Date.parse(s.checkedAt) <= SNAPSHOT_MAX_AGE_MS)) snapshots.delete(k);
  snapshots.set(key, { plan: normalized.plan, windows: normalized.windows.map(w => ({ ...w })), checkedAt: normalized.checkedAt });
  persistSnapshots();
}

function readSnapshotFile(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const saved = data && data.snapshots;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  } catch {
    return null; // missing, unreadable or corrupt: no readings, the next change replaces the file
  }
}

// Boot (index.js, before the server listens): adopt the readings an earlier run of this server
// saved under `root`, then save every later change there. An entry is dropped (and the file
// rewritten without it) when its key is not `provider:<64-hex>`, its checkedAt is unreadable, in
// the future or older than `maxAgeMs`, or none of its windows has a known usage; a kept one passes
// the same plan and window allowlist as a fresh read. An entry already in memory wins.
function loadQuotaSnapshots({ root, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  snapshotFile = root ? path.join(root, SNAPSHOT_FILE) : null;
  let restored = 0, dropped = 0;
  const saved = snapshotFile ? readSnapshotFile(snapshotFile) : null;
  for (const [key, raw] of Object.entries(saved || {})) {
    const readAt = raw && typeof raw.checkedAt === 'string' ? Date.parse(raw.checkedAt) : NaN;
    const windows = raw && Array.isArray(raw.windows) ? raw.windows.flatMap(normalizeWindow) : [];
    if (!SNAPSHOT_KEY.test(key) || !(readAt <= now && now - readAt <= maxAgeMs)
      || quotaStatus(windows, null) === 'unavailable') { dropped++; continue; }
    if (snapshots.has(key)) continue;
    snapshots.set(key, { plan: planOf(raw.plan), windows, checkedAt: new Date(readAt).toISOString() });
    restored++;
  }
  if (dropped) persistSnapshots();
  return { restored, dropped };
}

// The reading remembered for `key`, or null once it is older than maxAgeMs. A window that has
// reset since (its resetAt passed, or its whole windowMinutes elapsed after the reading) no longer
// has that usage, so it comes back unknown; with nothing known left the entry is dropped.
function staleQuota(key, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  const snapshot = snapshots.get(key);
  if (!snapshot) return null;
  const now = Date.now(), readAt = Date.parse(snapshot.checkedAt);
  if (!(now - readAt <= maxAgeMs)) { dropSnapshot(key); return null; }
  const windows = snapshot.windows.map(w => {
    const rolledOver = Date.parse(w.resetAt) <= now || (w.windowMinutes > 0 && readAt + w.windowMinutes * 60000 <= now);
    return rolledOver ? { ...w, usagePercent: null, resetAt: null, exhausted: null } : { ...w };
  });
  const status = quotaStatus(windows, null);
  if (status === 'unavailable') { dropSnapshot(key); return null; }
  return { plan: snapshot.plan, windows, status, checkedAt: snapshot.checkedAt };
}

// Test seam: forget every remembered reading and stop saving (memory only until the next load).
function clearQuotaSnapshots() {
  snapshots.clear();
  snapshotFile = null;
  saveError = null;
}

// Only these fields cross the HTTP boundary. Never spread provider replies/errors here.
function normalizeQuota(provider, projectRoot, raw = {}) {
  const connectionState = ['connected', 'signed_out', 'unsupported', 'unknown'].includes(raw.connectionState)
    ? raw.connectionState : 'unknown';
  const unavailableReason = REASONS.has(raw.unavailableReason) ? raw.unavailableReason : null;
  const plan = planOf(raw.plan);
  // Only a 64-hex hash can key a snapshot, so no raw credential ever becomes a map key.
  const key = typeof raw.credentialKey === 'string' && /^[0-9a-f]{64}$/.test(raw.credentialKey)
    ? `${provider}:${raw.credentialKey}` : null;
  const stale = key && TRANSIENT.has(unavailableReason) ? staleQuota(key) : null;
  if (stale) {
    return { provider, projectRoot, connectionState, plan: plan || stale.plan, status: stale.status,
      windows: stale.windows, unavailableReason, stale: true, checkedAt: stale.checkedAt };
  }
  const windows = (Array.isArray(raw.windows) ? raw.windows : []).flatMap(normalizeWindow);
  const known = windows.some(w => w.usagePercent !== null);
  const result = {
    provider, projectRoot, connectionState, plan,
    status: quotaStatus(windows, unavailableReason),
    windows,
    unavailableReason: unavailableReason || (known ? null : 'quota_unavailable'),
    stale: false,
    checkedAt: new Date().toISOString(),
  };
  if (key && result.status !== 'unavailable') rememberQuota(key, result);
  else if (key && !TRANSIENT.has(result.unavailableReason)) dropSnapshot(key);
  return result;
}

// Coalesce only simultaneous reads of the same credential snapshot; retain no completed
// quota results here (the stale snapshot above is keyed per account, not per request), so
// logout/login and project switches cannot serve an old account's cache.
const inFlight = new Map();
function coalesceQuota(key, read) {
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = Promise.resolve().then(read).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

module.exports = { quotaError, reasonFor, isoTime, normalizeQuota, coalesceQuota,
  rememberQuota, staleQuota, clearQuotaSnapshots, loadQuotaSnapshots, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_FILE };
