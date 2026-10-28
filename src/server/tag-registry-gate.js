'use strict';

// C1439 — pure helpers for the objective-save / createTask tag-registration guard.
// Zero network here; api-backend.js owns all I/O (apiRequest) and calls into this
// module to parse responses and decide. Mirrors tag-doc-link.js's split: network stays
// in api-backend.js, decisions live in a plain, bare-node-testable module. See
// ai/architecture/tt-tag-system.md § C1439 and tt-api-backend.md for the full writeup.

const { isPlaceholderDescription } = require('../mcp/tag-description');

// Longest description an automatic registration keeps (tags.description is TEXT, but a
// tag description is a one-line summary read by planners/agents to pick tags).
const AUTO_DESCRIPTION_MAX_CHARS = 200;

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

// note: optional extra sentence appended to the message (e.g. why automatic registration
// could not describe these names — TPT623).
function unregisteredTagError(unknown, { projectId, registrySize, note } = {}) {
  const sizeNote = registrySize != null ? ` (registry has ${registrySize} tag${registrySize === 1 ? '' : 's'})` : '';
  const err = new Error(
    `Unregistered tag(s) ${unknown.map(n => `"${n}"`).join(', ')} in project ${projectId ?? '?'}${sizeNote} — register each ` +
    'with a real one-line description first (MCP ensure_project_tag for plain tags, create_system_tag for tt-* tags), then retry.' +
    (note ? ` ${note}` : '')
  );
  err.code = 'TAGS_UNREGISTERED';
  err.missing = [...unknown];
  return err;
}

// Return full new rows and base-relative patches for explicitly edited existing
// rows. Live differences alone never establish write intent: the payload includes
// untouched snapshot rows that other processes may have changed since the read.
// The tag gate consumes these same patches, so untouched tags need no validation.
function selectTasksToWrite(parsedById, liveById, newTaskIdSet, changedFields, { writeTaskIds, taskBases = [] } = {}) {
  const out = [];
  const writes = new Set(writeTaskIds || []);
  const bases = new Map(taskBases.map(t => [String(t.id), t]));
  for (const [id, t] of parsedById) {
    const liveTask = liveById.get(id);
    const isNew = newTaskIdSet.has(id);
    if (isNew) {
      out.push([id, t]);
      continue;
    }
    // Preserve legacy direct-create/IPC callers without granting them permission
    // to overwrite existing rows. Current clients name every intended write.
    if (!writes.has(id) && (writeTaskIds !== undefined || liveTask)) continue;
    const base = bases.get(id);
    if (!liveTask) {
      if (base) throw Object.assign(new Error(`Modified task ${id} no longer exists`), { statusCode: 404 });
      out.push([id, t]);
      continue;
    }
    if (!base) {
      throw Object.assign(new Error(`Missing snapshot base for modified task ${id}`), {
        code: 'TODO_PAYLOAD_INVALID', saveStep: 'parse-payload',
      });
    }
    const patch = changedFields(t, base);
    if (Object.keys(patch).length) out.push([id, patch]);
  }
  return out;
}

// TPT623 — Task App UI saves may register unknown tags with an LLM-written description
// (tag-auto-register.js). missing: names the gate could not resolve. described:
// Map<name, description> (or a plain object) from the model. Returns
// { registrations: [{name, description}], undescribed: [name] } — a registration only for a
// name with a real one-line description (quotes stripped, whitespace collapsed, capped,
// never empty or C1038 placeholder text). tt-* names are never auto-registered: they need an
// architecture doc via create_system_tag, so they always land in `undescribed` and keep the gate error.
function buildAutoRegistrations(missing, described) {
  const lookup = described instanceof Map ? described : new Map(Object.entries(described || {}));
  const byFolded = new Map();
  for (const [name, desc] of lookup) byFolded.set(foldTagName(name), desc);
  const registrations = [];
  const undescribed = [];
  for (const raw of new Set((missing || []).filter(Boolean))) {
    const name = String(raw).trim();
    if (!name || /^tt-/i.test(name)) { undescribed.push(raw); continue; }
    const desc = sanitizeAutoDescription(lookup.has(raw) ? lookup.get(raw) : byFolded.get(foldTagName(raw)));
    if (!desc || isPlaceholderDescription(desc)) { undescribed.push(raw); continue; }
    registrations.push({ name, description: desc });
  }
  return { registrations, undescribed };
}

function sanitizeAutoDescription(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, AUTO_DESCRIPTION_MAX_CHARS).trim();
}

module.exports = {
  foldTagName,
  parseTagRegistryResponse,
  buildTagIndex,
  resolveTagNames,
  unregisteredTagError,
  selectTasksToWrite,
  buildAutoRegistrations,
  sanitizeAutoDescription,
};
