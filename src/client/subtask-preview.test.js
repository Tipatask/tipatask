import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countPendingSubtaskCards, hasProposalCards } from './subtask-preview.js';

// (TPT257) Count math behind the "N subtasks will be created under <key>" summary line.

const card = (type = 'new') => ({ type, task: { id: `${type}-x`, title: 't' } });

test('countPendingSubtaskCards: counts accepted, unconfirmed `new` cards across all messages', () => {
  const messages = [
    { role: 'user', content: 'Split TPT1' },
    { role: 'assistant', cards: [card(), card(), card()], acceptedMask: [true, true, false], confirmedMask: [false, false, false] },
    { role: 'assistant', cards: [card()], acceptedMask: [true], confirmedMask: [false] },
  ];
  assert.equal(countPendingSubtaskCards(messages), 3);
});

test('countPendingSubtaskCards: ignores `modified` cards even when accepted', () => {
  const messages = [
    { role: 'assistant', cards: [card('modified'), card()], acceptedMask: [true, true], confirmedMask: [false, false] },
  ];
  assert.equal(countPendingSubtaskCards(messages), 1);
});

test('countPendingSubtaskCards: excludes cards already confirmed (saved)', () => {
  const messages = [
    { role: 'assistant', cards: [card(), card()], acceptedMask: [true, true], confirmedMask: [true, false] },
  ];
  assert.equal(countPendingSubtaskCards(messages), 1);
});

test('countPendingSubtaskCards: a discarded message (every unconfirmed mask entry false) contributes 0', () => {
  const messages = [
    { role: 'assistant', cards: [card(), card()], acceptedMask: [false, false], confirmedMask: [false, false], discarded: true },
  ];
  assert.equal(countPendingSubtaskCards(messages), 0);
});

test('countPendingSubtaskCards: 0 for no messages, no cards, missing masks, or bad input', () => {
  assert.equal(countPendingSubtaskCards([]), 0);
  assert.equal(countPendingSubtaskCards(undefined), 0);
  assert.equal(countPendingSubtaskCards([{ role: 'assistant', content: 'no json' }]), 0);
  // No acceptedMask at all → nothing is "accepted" → 0 (mirrors getUnsavedAcceptedCountForMsg).
  assert.equal(countPendingSubtaskCards([{ role: 'assistant', cards: [card()] }]), 0);
});

test('hasProposalCards: true only once some message carries at least one card', () => {
  assert.equal(hasProposalCards([]), false);
  assert.equal(hasProposalCards(undefined), false);
  assert.equal(hasProposalCards([{ role: 'user', content: 'x' }, { role: 'assistant', cards: [] }]), false);
  assert.equal(hasProposalCards([{ role: 'assistant', cards: [card()], acceptedMask: [false], confirmedMask: [false] }]), true);
});
