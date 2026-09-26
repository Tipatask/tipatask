// Client role registry for custom per-project statuses. Keep this module
// importable under plain Node tests without browser-only dependencies at load.

import { t, LOCALES } from './i18n.js';
import { api } from './api-client.js';

// Mirrors src/server/status-roles.js's LEGACY_STATUSES exactly (kept in sync manually —
// same twin-copy discipline that file's own header comment documents), plus the C1187
// is_workflow_canceled column.
const LEGACY_STATUSES = [
  { name: 'pending', color: 'overlay1', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'in_progress', color: 'blue', display_order: 1, is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'on_fire', color: 'red', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'completed', color: 'green', display_order: 3, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
  { name: 'canceled', color: 'overlay0', display_order: 4, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
];

const LEGACY_ROLE_NAMES = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };

const ROLE_COLUMN = { start: 'is_workflow_start', in_progress: 'is_in_progress', complete: 'is_workflow_complete', canceled: 'is_workflow_canceled' };

// Board-sort order (NOT the registry's own display_order — a different concept that
// happens to share a name). Used only as the fallback for statusOrder() below; today
// nothing actually reads statusOrder() (STATUS_ORDER had zero live readers pre-C1187
// either), kept as a forward-compat export.
const LEGACY_STATUS_ORDER = { on_fire: 0, in_progress: 1, pending: 2, completed: 3, canceled: 4 };

// Swatch hexes match api/web's Catppuccin Mocha `--c-<name>` values (styles.css) — this
// app's own theme system has no per-token color variables (19 named themes, semantic
// --c-success/-danger/etc. only), so status colors resolve through this literal table
// instead of a CSS var. Canonical copy — task-board.js's Settings Workflow tab imports
// this instead of keeping its own.
export const WORKFLOW_COLOR_SWATCHES = {
  rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
  red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af',
  green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', blue: '#89b4fa', lavender: '#b4befe',
  overlay0: '#6c7086', overlay1: '#7f849c',
};

// ── Module state ──
let _rows = LEGACY_STATUSES.map(s => ({ ...s })); // last-known-good, never empty/null
let _roles = rolesFromStatuses(_rows);
let _order = new Map(_rows.map(s => [s.name, s.display_order]));
let _inflight = null;   // single-flight in-progress loadStatuses() promise
let _fetchedAt = 0;     // ms timestamp of last successful (or attempted) refresh

function _apply(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false; // never adopt an empty/invalid registry
  _rows = rows;
  _roles = rolesFromStatuses(_rows);
  _order = new Map(_rows.map(s => [s.name, s.display_order]));
  return true;
}

// ── Pure: rows -> { start, in_progress, complete, canceled } names. Exact twin of
// src/server/status-roles.js's rolesFromStatuses() plus the canceled role. Any role with
// no holder in `rows` falls back to its legacy name — map is ALWAYS fully populated. ──
export function rolesFromStatuses(rows) {
  const roles = { ...LEGACY_ROLE_NAMES };
  if (!Array.isArray(rows)) return roles;
  for (const [role, col] of Object.entries(ROLE_COLUMN)) {
    const hit = rows.find(r => r && r[col]);
    if (hit && hit.name) roles[role] = hit.name;
  }
  return roles;
}

// ── Async: resolve the registry ──

// Single-flight memoized fetch. Returns the (possibly still-legacy) cached rows
// immediately if a fetch is already in flight or has already completed once. Never
// throws — api.statuses.list() failures are swallowed and the last-known-good rows
// (legacy seed, on first call) are kept.
export async function loadStatuses() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const rows = await api.statuses.list();
      _apply(rows);
    } catch {
      // keep last-known-good — never revert to legacy on a transient failure
    } finally {
      _fetchedAt = Date.now();
      _inflight = null;
    }
    return _rows;
  })();
  return _inflight;
}

// Always re-fetches (bypasses the single-flight memo), still fail-soft. Use when the
// caller knows the registry just changed (e.g. right after this session's own write) or
// wants a guaranteed-fresh read.
export async function refreshStatuses() {
  _inflight = null;
  return loadStatuses();
}

// Fire-and-forget staleness check for hot render loops (e.g. loadAndRender(), which runs
// on every WS frame / poll tick) — never awaited by the caller, never adds a round-trip to
// a render that doesn't need one.
export function refreshStatusesIfStale(ttlMs = 30_000) {
  if (Date.now() - _fetchedAt < ttlMs) return;
  void refreshStatuses();
}

// Project-switch invalidation: drop back to the legacy seed so no frame of the
// newly-switched-to project can render with the previous project's custom names, and
// clear the fetch timestamp so the next loadStatuses()/refreshStatusesIfStale() re-fetches.
export function resetStatuses() {
  _rows = LEGACY_STATUSES.map(s => ({ ...s }));
  _roles = rolesFromStatuses(_rows);
  _order = new Map(_rows.map(s => [s.name, s.display_order]));
  _inflight = null;
  _fetchedAt = 0;
}

// Push already-fetched rows in with no HTTP round-trip — used by task-board.js's Settings
// Workflow tab, which already round-trips through its own `_workflowStatuses` (task_count +
// optimistic drag state the board render must not see) and just needs to inform this
// module's caches after each successful server response.
export function seedStatuses(rows) {
  _apply(rows);
  _fetchedAt = Date.now();
}

// ── Sync: read the cached registry ──

// A copy of the cached rows — never hand out the mutable internal array.
export function getStatuses() {
  return _rows.slice();
}

export function statusNames() {
  return _rows.map(s => s.name);
}

export function statusRoles() {
  return { ..._roles };
}

export function startName() { return _roles.start; }
export function inProgressName() { return _roles.in_progress; }
export function completeName() { return _roles.complete; }
export function canceledName() { return _roles.canceled; }

export function isStartName(name) { return !!name && name === _roles.start; }
export function isInProgressName(name) { return !!name && name === _roles.in_progress; }
export function isCompleteName(name) { return !!name && name === _roles.complete; }
export function isCanceledName(name) { return !!name && name === _roles.canceled; }

// "Closed" — the complete role OR the canceled role (C1187: fully role-derivable, no
// literal-name residue). `roles` defaults to the live cached map; pass an explicit map
// (e.g. from rolesFromStatuses() against a caller-held row set) to test against a
// specific registry instead of the module's own cache.
export function isClosedName(name, roles = _roles) {
  return !!name && (name === roles.complete || name === roles.canceled);
}

// This project's non-closed status names — "on_fire needs no role of its own" lives
// here: active is simply "not closed".
export function isActiveName(name, roles = _roles) {
  return !!name && !isClosedName(name, roles);
}

export function activeNames(names = statusNames(), roles = _roles) {
  return (names || []).filter(n => isActiveName(n, roles));
}

// "qa_review" -> "Qa Review". For the legacy 5 names, delegates to t('status.<name>') so
// existing en/uk translations (and locale-liveness — this is a function, re-evaluated at
// render time) keep working; i18n.js's t() falls through to returning the raw key string
// on a miss, so a naive t('status.'+name) would render the literal text "status.qa_review"
// for a custom status — probe LOCALES.en first (the same fallback chain t() itself uses)
// and humanize on a miss instead.
export function statusLabel(name) {
  const n = String(name || '');
  if (!n) return '';
  const key = `status.${n}`;
  if (LOCALES.en[key] !== undefined) return t(key);
  return n.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Registry display_order (project-configured board/list order), falling back to the
// legacy board-sort order for a legacy name absent from the registry, else a sane tail
// value. NOTE: this is NOT the same ordering concept as the registry's display_order for
// an unrecognized/not-yet-loaded name — see LEGACY_STATUS_ORDER's own comment above.
export function statusOrder(name) {
  const fromRegistry = _order.get(name);
  if (fromRegistry !== undefined) return fromRegistry;
  return LEGACY_STATUS_ORDER[name] ?? 999;
}

// Catppuccin token -> literal hex for this status's chip/pill color. Falls back to the
// 'overlay1' swatch for an unknown/missing color.
export function statusColor(name) {
  const row = _rows.find(s => s.name === name);
  const token = row && row.color;
  return WORKFLOW_COLOR_SWATCHES[token] || WORKFLOW_COLOR_SWATCHES.overlay1;
}

// The role token to stamp onto `data-status-role` for CSS to key off instead of the raw
// (possibly custom) status name — see styles.css's [data-status-role] selectors.
export function statusRoleToken(name) {
  if (isCompleteName(name)) return 'complete';
  if (isCanceledName(name)) return 'canceled';
  if (isInProgressName(name)) return 'in-progress';
  if (isStartName(name)) return 'start';
  return 'other';
}

export { LEGACY_STATUSES, LEGACY_ROLE_NAMES, ROLE_COLUMN };
