// (TPT9208) Sprint select-all: the round Select pill in a sprint's .tier-actions group selects
// every task card the sprint shows, and reads checked only while every one of them is selected.
// The pure rules take plain ids and a Set so they are node-testable; the DOM helpers below read
// the rendered tier and write the pill's checked state.

import state from './state.js';

// 'all' | 'some' | 'none' for `ids` against the selection Set. An empty sprint is 'none', so a
// sprint whose cards are all filtered out never reads checked.
export function tierSelectionState(ids, selected) {
  if (!ids.length) return 'none';
  let count = 0;
  for (const id of ids) if (selected.has(id)) count++;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'some';
}

// Applies one select-all click to `selected`: a fully selected sprint is cleared, any other
// sprint (none or some selected) is completed. Returns true when the sprint ends up selected.
export function toggleTierSelection(ids, selected) {
  if (tierSelectionState(ids, selected) === 'all') {
    for (const id of ids) selected.delete(id);
    return false;
  }
  for (const id of ids) selected.add(id);
  return ids.length > 0;
}

// The sprint's own selectable cards: direct cards of its .tier-cards that carry a Select pill
// and are not hidden by a search/tag/status/people filter (applySearchFilter() marks those
// .search-hidden). Inline subtask rows are not cards, so they never count.
export function tierSelectableCards(tierEl) {
  if (!tierEl) return [];
  return [...tierEl.querySelectorAll(':scope > .tier-cards > .card[data-id]')]
    .filter(card => !card.classList.contains('search-hidden') && card.querySelector('.btn-select-card'));
}

function writeTierSelectButton(btn, tierEl, selected) {
  const ids = tierSelectableCards(tierEl).map(card => card.dataset.id);
  const checked = tierSelectionState(ids, selected) === 'all';
  btn.classList.toggle('checked', checked);
  btn.setAttribute('aria-pressed', checked ? 'true' : 'false');
  btn.disabled = ids.length === 0;
}

// Re-derives every rendered sprint's select-all pill from the live selection. Called from
// updateBulkActionBar() (every selection change reaches it) and after each filter pass.
export function syncTierSelectAll(root = document, selected = state.selectedCardIds) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('.btn-tier-select').forEach(btn => {
    writeTierSelectButton(btn, btn.closest('.tier'), selected);
  });
}

// Handles one select-all click on `btn`: updates the Set and every affected card's markers.
// Returns the ids it acted on so the caller can refresh the bulk bar.
export function applyTierSelectAll(btn, selected = state.selectedCardIds) {
  const tierEl = btn.closest('.tier');
  const cards = tierSelectableCards(tierEl);
  const ids = cards.map(card => card.dataset.id);
  const on = toggleTierSelection(ids, selected);
  for (const card of cards) {
    card.classList.toggle('selected', on);
    card.querySelector('.btn-select-card')?.classList.toggle('checked', on);
  }
  writeTierSelectButton(btn, tierEl, selected);
  return ids;
}
