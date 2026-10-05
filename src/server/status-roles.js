'use strict';

// ── C1184/C1187: workflow-role status resolution ──
// C1180/C1181 made task statuses per-project custom (project_task_statuses table,
// api/src/lib/task-statuses.js) with role flags: is_workflow_start, is_in_progress,
// is_workflow_complete, is_workflow_canceled (4th flag added C1187). Agents/server must
// resolve "the status that means X" through these roles, never a hardcoded literal name —
// a renamed status must not break task-start/completion detection or agent update_task
// calls.
//
// LEGACY_STATUSES below is the frozen fallback used when no registry is reachable
// (file backend, network hiccup, older API server) — mirrors api/src/lib/task-statuses.js
// DEFAULT_STATUSES exactly. Keep both copies in sync if either changes (same
// twin-copy discipline as reopen-closed-task.js's CLOSED_STATUSES).

const LEGACY_STATUSES = [
  { name: 'pending', color: 'overlay1', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'in_progress', color: 'blue', display_order: 1, is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'on_fire', color: 'red', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'completed', color: 'green', display_order: 3, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
  { name: 'canceled', color: 'overlay0', display_order: 4, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
];

const LEGACY_ROLE_NAMES = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };

const ROLE_COLUMN = { start: 'is_workflow_start', in_progress: 'is_in_progress', complete: 'is_workflow_complete', canceled: 'is_workflow_canceled' };

// rows -> { start, in_progress, complete } names. Any role with no holder in `rows`
// (never happens on a healthy registry, but a partial/corrupt list must not crash a
// spawn) falls back to its legacy name — map is ALWAYS fully populated.
function rolesFromStatuses(rows) {
  const roles = { ...LEGACY_ROLE_NAMES };
  if (!Array.isArray(rows)) return roles;
  for (const [role, col] of Object.entries(ROLE_COLUMN)) {
    const hit = rows.find(r => r && r[col]);
    if (hit && hit.name) roles[role] = hit.name;
  }
  return roles;
}

// Fail-open: never throws, never returns a partial map. `backend` must expose
// getStatuses() (api-backend.js does, C1184). `opts.refresh` is forwarded to a backend that
// supports it (api-backend.js) to bypass its cache.
async function fetchStatusRoles(backend, opts) {
  if (!backend || typeof backend.getStatuses !== 'function') return { ...LEGACY_ROLE_NAMES };
  try {
    const rows = await backend.getStatuses(opts);
    return rolesFromStatuses(rows);
  } catch {
    return { ...LEGACY_ROLE_NAMES };
  }
}

// Status names valid for this project — used by write-guards (ws-handlers.js,
// mcp/server.js) instead of a hardcoded literal array. Fail-soft to the legacy 5.
async function fetchStatusNames(backend, opts) {
  if (!backend || typeof backend.getStatuses !== 'function') return LEGACY_STATUSES.map(s => s.name);
  try {
    const rows = await backend.getStatuses(opts);
    const names = (rows || []).map(r => r && r.name).filter(Boolean);
    return names.length > 0 ? names : LEGACY_STATUSES.map(s => s.name);
  } catch {
    return LEGACY_STATUSES.map(s => s.name);
  }
}

// "Closed" test used where a task should no longer count as active work — the
// workflow_complete role OR the workflow_canceled role (C1187 — fully role-derivable,
// no more literal-name residue for 'canceled').
function isClosedName(name, roles) {
  return !!name && (name === roles.complete || name === roles.canceled);
}

// Objective proposals may only edit tasks that have not started or closed.
function isLockedTargetStatus(name, roles = LEGACY_ROLE_NAMES) {
  return !!name && (name === roles.in_progress || isClosedName(name, roles));
}

// This project's non-closed status names, e.g. for an "active tasks" filter. `names` is
// the project's full ordered name list (fetchStatusNames()); `roles` is fetchStatusRoles().
function activeNames(names, roles) {
  return (names || []).filter(n => !isClosedName(n, roles));
}

// C1187 — resolves the registry ONCE per call and returns everything a caller typically
// needs (names, roles, active/closed sets, a bound isClosed predicate) instead of making
// two separate fetchStatusRoles()/fetchStatusNames() calls that each hit getStatuses()
// (the second call is a cache hit on api-backend.js, but still a wasted async round-trip
// — see terminal-session.js's spawnTerminal(), which did exactly that double await before
// this helper existed). Fail-open like its siblings: never throws, always fully populated.
async function fetchStatusContext(backend, opts) {
  if (!backend || typeof backend.getStatuses !== 'function') {
    const roles = { ...LEGACY_ROLE_NAMES };
    const names = LEGACY_STATUSES.map(s => s.name);
    return { names, roles, active: new Set(activeNames(names, roles)), closed: new Set(names.filter(n => isClosedName(n, roles))), isClosed: (n) => isClosedName(n, roles) };
  }
  let rows;
  try {
    rows = await backend.getStatuses(opts);
  } catch {
    rows = null;
  }
  const roles = rolesFromStatuses(rows);
  const names = (Array.isArray(rows) && rows.length > 0)
    ? rows.map(r => r && r.name).filter(Boolean)
    : LEGACY_STATUSES.map(s => s.name);
  const namesFinal = names.length > 0 ? names : LEGACY_STATUSES.map(s => s.name);
  const active = new Set(activeNames(namesFinal, roles));
  const closed = new Set(namesFinal.filter(n => isClosedName(n, roles)));
  return { names: namesFinal, roles, active, closed, isClosed: (n) => isClosedName(n, roles) };
}

// Defense-in-depth for status names interpolated into pi-agent.js's kickoff prompt
// (echoed verbatim into Pi's TUI and scanned by task-agent/prompt-detect.js — see the
// HARD RULE comment there). The API already caps names at 64 non-empty chars
// (api/src/routes/statuses.js) — this strips control chars/newlines (which could
// otherwise land a hostile string on its own line, matching a bare "Plan ready."-style
// pattern) and caps length again as a second layer. Deliberately does NOT touch quote/
// backtick/pipe characters: the sanitized value is also the literal string an agent
// PATCHes back as the status, so it must stay byte-identical to the real status name for
// any name that doesn't contain a raw control character.
function sanitizeStatusName(name) {
  return String(name || '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 64);
}

module.exports = {
  LEGACY_STATUSES,
  LEGACY_ROLE_NAMES,
  ROLE_COLUMN,
  rolesFromStatuses,
  fetchStatusRoles,
  fetchStatusNames,
  fetchStatusContext,
  isClosedName,
  isLockedTargetStatus,
  activeNames,
  sanitizeStatusName,
};
