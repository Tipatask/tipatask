'use strict';

// Agents choose tags from DB descriptions. Fetch missing descriptions for
// task tags and add a backfill directive; never rewrite architecture H1s here.
// Placeholder descriptions remain a Knowledge Base reindex concern.

// Pure. null/undefined/non-string/''/whitespace-only -> true. Deliberately NOT wired to
// mcp/tag-description.js's isPlaceholderDescription() — placeholder text is out of scope
// here by the user's explicit decision (see header above).
function isBlankDescription(desc) {
  if (typeof desc !== 'string') return true;
  return desc.trim().length === 0;
}

// Same discipline as status-roles.js's sanitizeStatusName() — tag names are DB-sourced
// and get interpolated into Pi's prompt, which Pi echoes verbatim into its own TUI where
// prompt-detect.js scans every line for dialog patterns.
function sanitizeTagName(name) {
  return String(name || '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 100);
}

// Fail-open: never throws, never returns undefined. null means "unknown" (fetch failed,
// no tags to check, or backend can't answer) — callers must treat that as "emit nothing",
// never as "everything is blank". `backend` must expose getTagsDetailed() (api-backend.js
// does; { name, description, knowledgeFileKey }[]).
async function fetchTagDescriptions(backend, taskTags) {
  if (!Array.isArray(taskTags) || taskTags.length === 0) return null;
  if (!backend || typeof backend.getTagsDetailed !== 'function') return null;
  try {
    const rows = await backend.getTagsDetailed();
    const map = {};
    for (const row of (rows || [])) {
      if (!row || typeof row.name !== 'string') continue;
      // tags.name is case-insensitive under the DB's default collation (see
      // tt-tag-system.md § C1439) — fold keys so a case-drifted taskTags entry still
      // matches its registry row.
      map[row.name.trim().toLowerCase()] = row.description ?? null;
    }
    return map;
  } catch {
    return null;
  }
}

// Pure. [] when tagDescriptions is null (unknown != blank — never emit a directive on a
// failed fetch) or taskTags is empty. A tag absent from the registry map is skipped too —
// that's an unregistered-tag error, already surfaced elsewhere (TAGS_UNREGISTERED).
function selectTagsNeedingDescription(taskTags, tagDescriptions) {
  if (!tagDescriptions || !Array.isArray(taskTags)) return [];
  const out = [];
  for (const tag of taskTags) {
    if (typeof tag !== 'string' || !tag.trim()) continue;
    const key = tag.trim().toLowerCase();
    if (!(key in tagDescriptions)) continue; // unregistered — not this directive's job
    if (isBlankDescription(tagDescriptions[key])) out.push(tag.trim());
  }
  return out;
}

const MAX_LISTED_TAGS = 12; // mirrors pi-agent.js's buildTipataskRestRecipe() status-name cap

// Pure sync prompt renderer. '' when nothing needs backfilling — the byte-identical
// default that keeps every pre-C1513 prompt unchanged and every existing test green.
// opts.compact selects Pi's no-MCP/REST wording (Pi has no tipatask MCP server at all).
function buildTagDescriptionDirective(taskTags, tagDescriptions, opts = {}) {
  const needing = selectTagsNeedingDescription(taskTags, tagDescriptions);
  if (needing.length === 0) return '';
  const compact = !!opts.compact;
  const names = needing.map(sanitizeTagName);
  const shown = names.length > MAX_LISTED_TAGS
    ? `${names.slice(0, MAX_LISTED_TAGS).join(', ')} … (${names.length - MAX_LISTED_TAGS} more)`
    : names.join(', ');

  if (compact) {
    return [
      `Blank tag description(s) on this task: ${shown}. Study the module each covers, then`,
      `fix it with \`PUT /tags/<name>\` body {"description": "<one-line summary>"} before`,
      'marking this task complete. Never write "Auto-registered..." text — the API rejects it.',
    ].join(' ');
  }

  return [
    `Blank tag description(s) on this task: ${shown}. Before marking this task complete,`,
    'study the module/feature each tag actually covers and give it a real one-line',
    'description via `ensure_project_tag(tag_name, description)` — use this for both plain',
    'and tt-* tags (create_system_tag only creates a NEW tt-* tag/stub; it is a no-op on an',
    'existing one, so it will not fix this). Never write "Auto-registered..." text — the',
    'API rejects it.',
  ].join(' ');
}

module.exports = {
  isBlankDescription,
  sanitizeTagName,
  fetchTagDescriptions,
  selectTagsNeedingDescription,
  buildTagDescriptionDirective,
};
