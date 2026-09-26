// ── Objective chat: proposal-card finalization helpers (TPT19) ──
// Pure, no DOM/network — same idiom as objective-parent-task.js/subtask-count.js — so it's
// unit-testable in isolation. Extracted from the inline auto-discard loop that used to live
// only in chat-task-preview.js's bulk ".chat-save-btn" handler, so the same sweep logic can
// also run from the per-card ✓ Accept handler (see tt-objective-chat-persistence.md § Delete
// triggers for the full purge contract these feed into).

// ── Mark every OTHER message's still-live proposal cards as rejected/discarded ──
// Skips `messages[exceptIdx]` (the message just resolved by the caller), any message with no
// cards, and any message already `discarded`. For each unconfirmed card in a swept message:
// by default flips `acceptedMask[j] = false`; when `keepEfficiencyHints` is true, an
// unconfirmed `_efficiencyHint` card is left untouched instead (same C369 exemption the old
// inline loop had), and the message is left non-discarded so its save bar survives for a
// later turn. Returns whether anything actually changed, so callers can skip a redundant
// repaint/save when nothing did.
export function discardUnsavedProposals(messages, { exceptIdx = -1, keepEfficiencyHints = false } = {}) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    if (i === exceptIdx) continue;
    const m = messages[i];
    if (!m || !m.cards || m.cards.length === 0 || m.discarded) continue;
    // Assign back (not just `|| []`) so a message that predates acceptedMask/confirmedMask
    // being set gets a real array mutations actually stick to, instead of writing into a
    // throwaway local that's discarded when this function returns.
    const confirmed = m.confirmedMask || (m.confirmedMask = []);
    const mask = m.acceptedMask || (m.acceptedMask = []);
    let hasUnconfirmedEfficiency = false;
    for (let j = 0; j < m.cards.length; j++) {
      if (confirmed[j]) continue;
      if (keepEfficiencyHints && m.cards[j]?._efficiencyHint) {
        hasUnconfirmedEfficiency = true;
      } else if (mask[j] !== false) {
        mask[j] = false;
        changed = true;
      }
    }
    if (!hasUnconfirmedEfficiency) {
      m.discarded = true;
      changed = true;
    }
  }
  return changed;
}

// ── How many of this message's cards are still live? ──
// Live = neither confirmed (saved) nor rejected (acceptedMask === false). Mirrors
// checkAllCardsHandled()'s per-message rule (chat-task-preview.js) exactly; a message with no
// cards contributes 0. (TPT20) Extracted from isMessageFullyResolved() below so the
// objective-tab close confirm can say HOW MANY suggestions it is about to delete without
// re-deriving — and therefore risking disagreeing with — the same rule.
export function countUnresolvedCards(msg) {
  if (!msg || !msg.cards || msg.cards.length === 0) return 0;
  const confirmed = msg.confirmedMask || [];
  const mask = msg.acceptedMask || [];
  let n = 0;
  for (let i = 0; i < msg.cards.length; i++) {
    if (!confirmed[i] && mask[i] !== false) n++;
  }
  return n;
}

// ── Is every card on this message confirmed or rejected? ──
// Mirrors checkAllCardsHandled()'s per-message check (chat-task-preview.js) exactly. A
// message with no cards counts as resolved (nothing to handle).
export function isMessageFullyResolved(msg) {
  return countUnresolvedCards(msg) === 0;
}
