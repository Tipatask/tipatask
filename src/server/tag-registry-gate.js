'use strict';

// C1439 — pure helpers for the objective-save / createTask tag-registration guard.
// Zero network here; api-backend.js owns all I/O (apiRequest) and calls into this
// module to parse responses and decide. Mirrors tag-doc-link.js's split: network stays
// in api-backend.js, decisions live in a plain, bare-node-testable module. See
// ai/architecture/tt-tag-system.md § C1439 and tt-api-backend.md for the full writeup.

// Normalize a tag name for comparison. Matches the tags table's collation
// (utf8mb4_uca1400_ai_ci — case-insensitive, no explicit COLLATE in migration
// 002_tags.js) and the API's trim-on-write (api/src/routes/tags.js:104). This check
// must never be STRICTER than the DB row it's protecting.
function foldTagName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Parse a raw GET /tags response into a row array, OR throw a distinguishable error
// when the registry could not actually be read. An empty array is a legitimate "this
// project has zero tags" state (a brand-new project) and must never be confused with
// "the read failed" — the pre-C1439 code did exactly that (apiRequest's {_notFound:true}
// 404 sentinel, or a raw string body from cli/http.js's JSON.parse-failure fallback,
// both collapsed to `data.tags || []`), which made every tag on the save read as
// unregistered with no diagnostic.
function parseTagRegistryResponse(data, projectId) {
  if (data && Array.isArray(data.tags)) return data.tags;
  const err = new Error(
    `Tag registry unreadable for project ${projectId ?? '?'} (GET /tags returned an unexpected shape) — ` +
    'cannot verify tag registration, refusing to write tasks. Check connectivity/credentials and retry.'
  );
  err.code = 'TAG_REGISTRY_UNREADABLE';
  throw err;
}

// rows: registry rows (string[] or {name,...}[]). extraKnown: additional names this
// same save is about to register (e.g. new_tags / tagRegistrations), same shapes
// accepted — a tag registered by THIS save counts as known even before a re-read.
// Returns a Map of foldedName -> canonical name (registry spelling wins over an
// extraKnown entry with the same folded name, since the registry is the source of
// truth once it exists).
function buildTagIndex(rows, extraKnown = []) {
  const index = new Map();
  for (const r of extraKnown) {
    const name = typeof r === 'string' ? r : r && r.name;
    // Trim (but keep case — the registry hasn't necessarily seen this name yet) so the
    // canonical value handed back is always clean, even before the registry confirms it.
    if (name) index.set(foldTagName(name), String(name).trim());
  }
  for (const r of rows || []) {
    const name = typeof r === 'string' ? r : r && r.name;
    if (name) index.set(foldTagName(name), name); // registry spelling wins, already trimmed on write
  }
  return index;
}

// wanted: task tag names as proposed by the caller. Returns { unknown, canonical } —
// unknown: names with no match in the index; canonical: Map<incomingName, dbName> for
// every match, so the caller can rewrite outgoing tags to the registry's own spelling.
// This rewrite matters: the API's resolveTagIds (api/src/routes/tasks.js:469-486) does
// a case-INSENSITIVE SQL `name IN (...)` lookup but then keys its result map by the
// DB's own spelling and filters with a case-SENSITIVE JS `foundMap[n]` check — so
// sending "config" against a DB row "Config" still 400s TAGS_UNREGISTERED downstream
// unless the client rewrites to the canonical spelling first.
function resolveTagNames(wanted, index) {
  const unknown = [];
  const canonical = new Map();
  for (const raw of new Set((wanted || []).filter(Boolean))) {
    const folded = foldTagName(raw);
    const dbName = index.get(folded);
    if (dbName === undefined) unknown.push(raw);
    else canonical.set(raw, dbName);
  }
  return { unknown, canonical };
}

function unregisteredTagError(unknown, { projectId, registrySize } = {}) {
  const sizeNote = registrySize != null ? ` (registry has ${registrySize} tag${registrySize === 1 ? '' : 's'})` : '';
  const err = new Error(
    `Unregistered tag(s) ${unknown.map(n => `"${n}"`).join(', ')} in project ${projectId ?? '?'}${sizeNote} — register each ` +
    'with a real one-line description first (MCP ensure_project_tag for plain tags, create_system_tag for tt-* tags), then retry.'
  );
  err.code = 'TAGS_UNREGISTERED';
  err.missing = [...unknown];
  return err;
}

// Pure selector mirroring overwriteRaw()'s write-loop skip rule — used to narrow the
// tag gate to only the tasks that will actually be PATCHed/created this save, not
// every task echoed back in the payload. C1439: a legacy carried-over task holding a
// since-deleted tag used to block an unrelated save (see objective-parent-task.js's
// `tags: []` workaround comment, which predates this fix). `tasksDiffer` is injected
// so this stays a pure function testable without importing api-backend.js.
function selectTasksToWrite(parsedById, liveById, newTaskIdSet, tasksDiffer) {
  const out = [];
  for (const [id, t] of parsedById) {
    const liveTask = liveById.get(id);
    const isNew = newTaskIdSet.has(id);
    if (!isNew && !tasksDiffer(t, liveTask)) continue; // carried over unchanged — nothing to persist or validate
    out.push([id, t]);
  }
  return out;
}

module.exports = {
  foldTagName,
  parseTagRegistryResponse,
  buildTagIndex,
  resolveTagNames,
  unregisteredTagError,
  selectTasksToWrite,
};
