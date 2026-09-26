// ── (TPT257) Subtask preview stack — pure helpers, DOM-free ──
// Backs the "N subtasks will be created under <parentKey>" summary line that
// chat-ui.js's renderObjectiveContent() renders under the subtask-context banner, and
// that chat-task-preview.js's updateSaveBar() → refreshSubtaskSummary() keeps current
// after a per-card Accept/Reject or a Discard without a full reload.
//
// Same extraction rationale as subtask-count.js: chat-task-preview.js / chat-ui.js pull in
// DOM-only imports and can't be loaded under `node --test`, so the count math lives here.

// Cards that WILL be saved as children on the next Save/Accept: the save bar's own
// accepted-and-not-yet-confirmed predicate (chat-ui.js getUnsavedAcceptedCountForMsg),
// restricted to `type:'new'` — only new cards receive the Phase 2.7 parentId stamp;
// a `modified` card edits an existing task in place and never becomes a subtask.
// A discarded message already has every unconfirmed mask entry flipped to false, so it
// contributes 0 without special-casing. Efficiency-hint cards are `type:'new'` too and
// get stamped like any other, so they count.
export function countPendingSubtaskCards(messages) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    const cards = msg && Array.isArray(msg.cards) ? msg.cards : [];
    if (cards.length === 0) continue;
    const mask = Array.isArray(msg.acceptedMask) ? msg.acceptedMask : [];
    const confirmed = Array.isArray(msg.confirmedMask) ? msg.confirmedMask : [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!card || card.type !== 'new') continue;
      if (mask[i] && !confirmed[i]) count++;
    }
  }
  return count;
}

// Whether the planner has produced any proposal cards at all — gates the summary line so
// a fresh split tab (seeded composer, no turn yet) never shows "0 subtasks".
export function hasProposalCards(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(msg => msg && Array.isArray(msg.cards) && msg.cards.length > 0);
}
