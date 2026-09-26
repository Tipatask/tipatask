// ── Objective-chat save payload: new_tags attachment (C1439) ──
// Extracted so this pure filter is importable under a plain Node test — chat-task-preview.js
// itself transitively pulls in browser-only modules (xterm via console-modal.js) that fail
// to load under `node --test`. No imports here, deliberately — this module needs nothing.
//
// Why this exists: overwriteRaw() (api-backend.js) registers `data.new_tags` before
// writing tasks — it's the ONLY way a save can carry a real description for a tag the
// live registry doesn't have yet (see tag-registry-gate.js / C1038). The bulk "Save
// Tasks" button already attached a filtered `msg.newTags` this way; the per-card ✓
// Accept path (chat-task-preview.js's saveTaskChange()) never did, so every solo Accept
// silently dropped its own tag registrations and depended on the tag already existing.

// Match a tag name the same way the server-side gate does — trim + case-fold — so a
// card whose tag name drifted in case (e.g. planner emitted "Config" on the card but
// "config" in new_tags, or vice versa) doesn't silently lose its registration entry.
function _fold(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// newTags: the full new_tags array from the LLM proposal (msg.newTags). cards: the
// task change objects actually being saved this call (accepted cards for a bulk save,
// or a single-element array for a per-card Accept) — each shaped like
// { task: { tags: [...] } } (an objective-chat `change`/card object). Returns only the
// new_tags entries whose name matches a tag present on at least one of these cards,
// deduped by folded name (first occurrence wins) — a save must never register a tag
// nobody on THIS save is actually using.
function selectNewTagsForCards(newTags, cards) {
  if (!Array.isArray(newTags) || newTags.length === 0) return [];
  const cardTagNames = new Set();
  for (const c of cards || []) {
    const tags = c && c.task && Array.isArray(c.task.tags) ? c.task.tags : [];
    for (const t of tags) cardTagNames.add(_fold(t));
  }
  if (cardTagNames.size === 0) return [];

  const seen = new Set();
  const out = [];
  for (const t of newTags) {
    if (!t || !t.name) continue;
    const folded = _fold(t.name);
    if (!cardTagNames.has(folded) || seen.has(folded)) continue;
    seen.add(folded);
    out.push(t);
  }
  return out;
}

// Mutates `data` in place (matches attachOriginalSpecPayload's convention) — sets
// data.new_tags only when there's something to attach, so an unrelated save (no
// newTags on the message, or none of them apply to these cards) never sends an empty
// array where the previous shape sent nothing at all.
function attachNewTagsPayload(data, newTags, cards) {
  const selected = selectNewTagsForCards(newTags, cards);
  if (selected.length > 0) {
    data.new_tags = [...(Array.isArray(data.new_tags) ? data.new_tags : []), ...selected];
  }
}

export { selectNewTagsForCards, attachNewTagsPayload };
