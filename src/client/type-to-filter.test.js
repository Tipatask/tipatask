import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEditableTarget, shouldTypeToFilter } from './type-to-filter.js';

const BASE_CTX = {
  activeElement: { tagName: 'BODY', isContentEditable: false },
  boardActive: true,
  hasSearchInput: true,
  overlayOpen: false,
  searchFocused: false,
  searchHasText: false,
};

function ctx(overrides = {}) {
  return { ...BASE_CTX, ...overrides };
}

function key(k, overrides = {}) {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, ...overrides };
}

// ── isEditableTarget ──

test('isEditableTarget: null/undefined is not editable', () => {
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(undefined), false);
});

test('isEditableTarget: INPUT/TEXTAREA/SELECT are editable', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'input' }), true); // case-insensitive
});

test('isEditableTarget: contenteditable is editable regardless of tag', () => {
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
});

test('isEditableTarget: plain BODY/DIV are not editable', () => {
  assert.equal(isEditableTarget({ tagName: 'BODY', isContentEditable: false }), false);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
});

// ── shouldTypeToFilter — accept cases ──

test('accepts a plain printable letter', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx()), true);
});

test('accepts Shift+letter (capitals must work)', () => {
  assert.equal(shouldTypeToFilter(key('A', { shiftKey: true }), ctx()), true);
});

test('accepts a digit', () => {
  assert.equal(shouldTypeToFilter(key('7'), ctx()), true);
});

test('accepts punctuation', () => {
  assert.equal(shouldTypeToFilter(key('-'), ctx()), true);
});

test('accepts space mid-query (search already has text)', () => {
  assert.equal(shouldTypeToFilter(key(' '), ctx({ searchHasText: true })), true);
});

// ── shouldTypeToFilter — reject: non-printable / navigation keys ──

for (const k of ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'F1', 'F5', 'Shift', 'Control', 'Meta', 'Alt']) {
  test(`rejects non-printable key: ${k}`, () => {
    assert.equal(shouldTypeToFilter(key(k), ctx()), false);
  });
}

// ── shouldTypeToFilter — reject: modifiers ──

test('rejects Ctrl+letter', () => {
  assert.equal(shouldTypeToFilter(key('a', { ctrlKey: true }), ctx()), false);
});

test('rejects Cmd/Meta+letter', () => {
  assert.equal(shouldTypeToFilter(key('k', { metaKey: true }), ctx()), false);
});

test('rejects Alt+letter', () => {
  assert.equal(shouldTypeToFilter(key('x', { altKey: true }), ctx()), false);
});

// ── shouldTypeToFilter — reject: IME composition ──

test('rejects while composing (isComposing)', () => {
  assert.equal(shouldTypeToFilter(key('a', { isComposing: true }), ctx()), false);
});

test('rejects the IME sentinel keyCode 229', () => {
  assert.equal(shouldTypeToFilter(key('a', { keyCode: 229 }), ctx()), false);
});

// ── shouldTypeToFilter — reject: focus / overlay / tab guards ──

test('rejects when activeElement is an INPUT', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ activeElement: { tagName: 'INPUT' } })), false);
});

test('rejects when activeElement is a TEXTAREA', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ activeElement: { tagName: 'TEXTAREA' } })), false);
});

test('rejects when activeElement is a SELECT', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ activeElement: { tagName: 'SELECT' } })), false);
});

test('rejects when activeElement is contenteditable', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ activeElement: { tagName: 'DIV', isContentEditable: true } })), false);
});

test('rejects when the search input is already focused', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ searchFocused: true })), false);
});

test('rejects when an overlay/modal is open', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ overlayOpen: true })), false);
});

test('rejects when the board tab is not active (e.g. Backlog/Objective/Create)', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ boardActive: false })), false);
});

test('rejects when the search input does not exist in the DOM', () => {
  assert.equal(shouldTypeToFilter(key('a'), ctx({ hasSearchInput: false })), false);
});

test('rejects a leading space when the search box is empty', () => {
  assert.equal(shouldTypeToFilter(key(' '), ctx({ searchHasText: false })), false);
});

test('rejects a missing event', () => {
  assert.equal(shouldTypeToFilter(null, ctx()), false);
  assert.equal(shouldTypeToFilter(undefined, ctx()), false);
});
