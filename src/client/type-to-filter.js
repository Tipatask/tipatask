// (C1502) Pure, DOM-free guard logic for "type to filter" — same idiom as board-filter-prefs.js /
// board-count-domain.js / voice-shortcut.js: the predicate is unit-testable under `node --test`
// with plain objects standing in for DOM nodes/events, and the caller (task-board.js) supplies
// everything that actually needs a live `document`.
//
// Root behavior: with the Project Board in view and nothing focused, typing a plain printable
// character should land in the board's search field and filter, same as if the field had been
// clicked first. Unlike voice-shortcut.js's matchesVoiceShortcut() — which matches on `e.code`
// so a combo is layout-independent — this matches on `e.key`, because the actual typed character
// (not the physical key) is what gets appended to the search box.

// True when `el` is (or behaves like) an editable form control — the caller is already typing
// there, so a global type-to-filter handler must stay out of the way. Covers native inputs,
// textareas, selects, and any contenteditable region (chat/objective composers, rich text
// fields) — and, incidentally, xterm's own `textarea.xterm-helper-textarea`, since that's a
// plain `<textarea>` too.
export function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

// ctx: {
//   activeElement,   // document.activeElement (or a stand-in with tagName/isContentEditable)
//   boardActive,     // state.activeTab === 'board'
//   hasSearchInput,  // the board filter bar's .search-input is actually rendered
//   overlayOpen,     // some modal/terminal/dropdown is open and should own all keystrokes
//   searchFocused,   // activeElement IS the search input already (let the browser handle it)
//   searchHasText,   // state.searchQuery (pre-keystroke) is non-empty
// }
export function shouldTypeToFilter(e, ctx = {}) {
  if (!e || !ctx.boardActive || !ctx.hasSearchInput || ctx.overlayOpen) return false;
  if (ctx.searchFocused || isEditableTarget(ctx.activeElement)) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing || e.keyCode === 229) return false; // IME composition in progress
  const key = e.key;
  if (typeof key !== 'string' || key.length !== 1) return false; // excludes Escape/Enter/Tab/
  // Backspace/Delete/Home/End/PageUp/PageDown/every Arrow*/F1-F12 — all report multi-char `key`.
  if (key === ' ' && !ctx.searchHasText) return false; // leading space is never a useful query
  return true;
}
