'use strict';

// Shared task-key format contract (C1482). Every seeded/agent-created task key must be
// prefix+number — reserve_task_keys output, never a hand-typed descriptive slug (the
// bug this closes: create_task with task_key "C-kb-dev-scripts" used to sail through).
// H is already covered by [A-Z]{1,6} but kept explicit — HUMAN tasks always start with
// H regardless of a project's derived CODING prefix (see api/src/lib/task-prefix.js,
// C1480). Hand-synced twin, mirroring the existing normalizeTaskKey pattern across the
// api/ <-> ai/todo/server/ repo boundary: api/src/lib/task-key-format.js. Keep both in
// sync — api/src/routes/mcp.test.js (C1534) asserts they carry the same regex literal.
const TASK_KEY_RE = /^(H|[A-Z]{1,6})[0-9]+$/;

function isValidTaskKey(key) {
  return typeof key === 'string' && TASK_KEY_RE.test(key);
}

// TPT394: null for a valid key, else a clear message. Seeders call this before any write
// so a descriptive slug (e.g. "C-kb-docs-site") fails loudly instead of being created.
function taskKeyFormatError(key) {
  if (isValidTaskKey(key)) return null;
  return `Invalid task key ${JSON.stringify(key)}: seeded task keys must match ${TASK_KEY_RE.source} (reserve_task_keys output), never a descriptive slug.`;
}

// ── C1483 — client/Task-App side of the prefix-aware key contract ──
// Brings this twin to parity with api/src/lib/task-key-format.js's parseTaskKey/
// isTaskKeyLike/maxNumbersByPrefix, so the Task App server (id-remap.js, ws-handlers.js
// nextIdHint, mcp/server.js list_task_id_meta) and client (task-card.js isRealKey) no
// longer hardcode C/H/S/B — see ai/architecture/tt-api-backend.md § Task Key Prefix
// Contract.
const HUMAN_TASK_PREFIX = 'H';

// generateEpicKey() (api/src/routes/tasks.js) mints a dash-separated key derived from
// the project name (e.g. "TIPA-1") — never matches TASK_KEY_RE. Mirrors the API twin's
// EPIC_KEY_RE exactly.
const EPIC_KEY_RE = /^[A-Z]{1,8}-[0-9]+$/;

// Splits an already-shape-valid key into { prefix, number }. Returns null on a key that
// doesn't match TASK_KEY_RE (callers should isValidTaskKey() first).
function parseTaskKey(key) {
  if (typeof key !== 'string') return null;
  const m = TASK_KEY_RE.exec(key);
  if (!m) return null;
  return { prefix: m[1], number: key.slice(m[1].length) };
}

// "Is this string shaped like a real task key" (prefix+number OR dashed epic form), vs
// a session id / synthetic client id ("new-<ts>-<seq>", "obj-<ts>", "specChat:C123") /
// descriptive slug. No prefix-membership check — this repo boundary has no `req.project`
// to check an allowlist against; that enforcement lives API-side (C1481).
function isTaskKeyLike(key) {
  return typeof key === 'string' && (TASK_KEY_RE.test(key) || EPIC_KEY_RE.test(key));
}

// Legacy descriptive slug keys ("C-kb-docs-site") minted by an older setup flow. They
// fail isValidTaskKey() so create-time stays strict, but rows already exist in the API
// and must stay completable. Safe charset only: the key ends up in `task/<key>` git ref
// names, so no "/", "..", whitespace or leading dash. Strict/epic keys are NOT legacy.
const LEGACY_TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isLegacyTaskKey(key) {
  return typeof key === 'string' && !isTaskKeyLike(key) && !key.includes('..') && LEGACY_TASK_KEY_RE.test(key);
}

// Per-prefix max numeric suffix across a list of keys (or task rows/`.id` strings).
// Non-key-shaped entries are silently skipped. Returns Map<prefix, maxNumber> — callers
// default a missing prefix to 0 (`map.get(p) ?? 0`).
function maxNumbersByPrefix(keys) {
  const out = new Map();
  for (const raw of keys) {
    const key = typeof raw === 'string' ? raw : (raw && raw.id);
    const parsed = parseTaskKey(key);
    if (!parsed) continue;
    const n = Number(parsed.number);
    if (!Number.isFinite(n)) continue;
    const prev = out.get(parsed.prefix) ?? 0;
    if (n > prev) out.set(parsed.prefix, n);
  }
  return out;
}

// This project's own CODING prefix, degraded to the legacy global 'C' when the value
// isn't a real derived prefix (e.g. a project row still on the raw DB column default —
// see api/src/lib/task-prefix.js's isValidTaskPrefix, C1480). Never throws.
function resolveCodingPrefix(taskPrefix) {
  return typeof taskPrefix === 'string' && /^[A-Z]{2,8}$/.test(taskPrefix) ? taskPrefix : 'C';
}

module.exports = {
  TASK_KEY_RE,
  isValidTaskKey,
  taskKeyFormatError,
  HUMAN_TASK_PREFIX,
  EPIC_KEY_RE,
  parseTaskKey,
  isTaskKeyLike,
  isLegacyTaskKey,
  maxNumbersByPrefix,
  resolveCodingPrefix,
};
