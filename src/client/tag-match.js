// (C1517) Pure, DOM-free tag typeahead matching. No imports — shared by both Task App
// tag surfaces: the edit-modal `.modal-tag-input` (task-board.js, entries are
// `string | {name, description}`) and the New Task form's `#tag-input-field`
// (template.html, entries are plain strings resolved against `state.tagDescriptions`).
// See dep-graph.js / subtask-count.js for the same "extracted for node --test" pattern —
// task-board.js can't be imported under node --test (xterm comes in transitively via
// console-modal.js).

export function tagName(entry) {
  return typeof entry === 'string' ? entry : entry?.name;
}

// Mirrors the pre-C1517 inline ternary in task-board.js's renderDropdown(): an object
// entry's own `description` field wins (including an explicit empty/falsy value only
// falling through when the field itself is absent), else fall back to the shared
// `descriptions` Map (state.tagDescriptions) keyed by name.
export function tagDescription(entry, descriptions) {
  if (typeof entry !== 'string' && entry && entry.description != null) return entry.description;
  const name = tagName(entry);
  return name && descriptions ? descriptions.get(name) || null : null;
}

// Filters `tags` (string or {name, description} entries) against `query`, matching on
// name AND description (case-insensitive substring). Name hits rank above
// description-only hits; within each group, input order is preserved. `limit` (applied
// after ranking) caps the result so a description-only hit can never evict a name hit
// from a capped dropdown.
export function filterTagOptions(tags, query, opts = {}) {
  const { selected = [], descriptions = null, limit = 0, nameMatch = 'substring' } = opts;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const selectedSet = new Set(selected.map(s => String(s).toLowerCase()));
  const nameHits = [];
  const descHits = [];
  for (const entry of tags || []) {
    const name = tagName(entry);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (selectedSet.has(lower)) continue;
    const nameHit = nameMatch === 'prefix' ? lower.startsWith(q) : lower.includes(q);
    if (nameHit) {
      nameHits.push(entry);
      continue;
    }
    const desc = tagDescription(entry, descriptions);
    if (desc && String(desc).toLowerCase().includes(q)) descHits.push(entry);
  }
  const merged = nameHits.concat(descHits);
  return limit > 0 ? merged.slice(0, limit) : merged;
}
