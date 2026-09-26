import assert from 'node:assert/strict';
import { test } from 'node:test';

const { discardUnsavedProposals, isMessageFullyResolved, countUnresolvedCards } = await import('./chat-finalize.js');

function card(id, opts = {}) {
  return { task: { id, title: `Task ${id}` }, ...opts };
}

// ── discardUnsavedProposals ──

test('discardUnsavedProposals: flips unconfirmed acceptedMask false and marks message discarded', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      cards: [card('a'), card('b')],
      acceptedMask: [true, true],
      confirmedMask: [false, false],
      discarded: false,
    },
  ];
  const changed = discardUnsavedProposals(messages);
  assert.equal(changed, true);
  assert.deepEqual(messages[1].acceptedMask, [false, false]);
  assert.equal(messages[1].discarded, true);
});

test('discardUnsavedProposals: exceptIdx is left completely untouched', () => {
  const target = {
    cards: [card('a')],
    acceptedMask: [true],
    confirmedMask: [true],
    discarded: false,
  };
  const other = {
    cards: [card('b')],
    acceptedMask: [true],
    confirmedMask: [false],
    discarded: false,
  };
  const messages = [target, other];
  discardUnsavedProposals(messages, { exceptIdx: 0 });
  assert.deepEqual(target.acceptedMask, [true]); // untouched
  assert.equal(target.discarded, false); // untouched
  assert.equal(other.discarded, true); // swept
});

test('discardUnsavedProposals: already-confirmed cards are never touched', () => {
  const messages = [
    {
      cards: [card('a'), card('b')],
      acceptedMask: [true, true],
      confirmedMask: [true, false],
      discarded: false,
    },
  ];
  discardUnsavedProposals(messages);
  assert.deepEqual(messages[0].acceptedMask, [true, false]); // confirmed card untouched
  assert.equal(messages[0].discarded, true);
});

test('discardUnsavedProposals: already-discarded messages are skipped (no-op, no false "changed")', () => {
  const messages = [
    {
      cards: [card('a')],
      acceptedMask: [true],
      confirmedMask: [false],
      discarded: true,
    },
  ];
  const changed = discardUnsavedProposals(messages);
  assert.equal(changed, false);
  assert.deepEqual(messages[0].acceptedMask, [true]); // untouched
});

test('discardUnsavedProposals: messages with no cards are skipped', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'reply', cards: [] },
  ];
  const changed = discardUnsavedProposals(messages);
  assert.equal(changed, false);
});

test('discardUnsavedProposals: missing acceptedMask/confirmedMask arrays default safely', () => {
  const messages = [{ cards: [card('a')], discarded: false }];
  const changed = discardUnsavedProposals(messages);
  assert.equal(changed, true);
  assert.deepEqual(messages[0].acceptedMask, [false]);
  assert.equal(messages[0].discarded, true);
});

test('discardUnsavedProposals: keepEfficiencyHints leaves an unconfirmed hint card live and the message non-discarded', () => {
  const messages = [
    {
      cards: [card('a', { _efficiencyHint: true }), card('b')],
      acceptedMask: [true, true],
      confirmedMask: [false, false],
      discarded: false,
    },
  ];
  const changed = discardUnsavedProposals(messages, { keepEfficiencyHints: true });
  assert.equal(changed, true); // the non-hint card still got swept
  assert.deepEqual(messages[0].acceptedMask, [true, false]); // hint card untouched, other rejected
  assert.equal(messages[0].discarded, false); // message stays alive for a later save
});

test('discardUnsavedProposals: keepEfficiencyHints=false (default) sweeps hint cards too', () => {
  const messages = [
    {
      cards: [card('a', { _efficiencyHint: true })],
      acceptedMask: [true],
      confirmedMask: [false],
      discarded: false,
    },
  ];
  const changed = discardUnsavedProposals(messages);
  assert.equal(changed, true);
  assert.deepEqual(messages[0].acceptedMask, [false]);
  assert.equal(messages[0].discarded, true);
});

test('discardUnsavedProposals: a message with ONLY a confirmed hint card is discarded (no live hint remains)', () => {
  const messages = [
    {
      cards: [card('a', { _efficiencyHint: true })],
      acceptedMask: [true],
      confirmedMask: [true],
      discarded: false,
    },
  ];
  const changed = discardUnsavedProposals(messages, { keepEfficiencyHints: true });
  assert.equal(changed, true);
  assert.equal(messages[0].discarded, true);
});

test('discardUnsavedProposals: non-array input is a safe no-op', () => {
  assert.equal(discardUnsavedProposals(null), false);
  assert.equal(discardUnsavedProposals(undefined), false);
});

// ── isMessageFullyResolved ──

test('isMessageFullyResolved: true when every card is confirmed or rejected', () => {
  assert.equal(isMessageFullyResolved({
    cards: [card('a'), card('b')],
    acceptedMask: [true, false],
    confirmedMask: [true, false],
  }), true);
});

test('isMessageFullyResolved: false when a card is accepted but not yet confirmed', () => {
  assert.equal(isMessageFullyResolved({
    cards: [card('a')],
    acceptedMask: [true],
    confirmedMask: [false],
  }), false);
});

test('isMessageFullyResolved: a message with no cards is trivially resolved', () => {
  assert.equal(isMessageFullyResolved({ cards: [] }), true);
  assert.equal(isMessageFullyResolved({ role: 'user', content: 'hi' }), true);
});

test('isMessageFullyResolved: missing masks default to unresolved-accepted, not confirmed', () => {
  // No acceptedMask/confirmedMask at all — mask[i] is undefined, which is !== false, so the
  // card reads as still-live (matches checkAllCardsHandled()'s existing default reading).
  assert.equal(isMessageFullyResolved({ cards: [card('a')] }), false);
});

// ── countUnresolvedCards (TPT20) ──

test('countUnresolvedCards: 0 for no cards / missing cards key', () => {
  assert.equal(countUnresolvedCards({ cards: [] }), 0);
  assert.equal(countUnresolvedCards({ role: 'user', content: 'hi' }), 0);
  assert.equal(countUnresolvedCards(null), 0);
});

test('countUnresolvedCards: counts every accepted-but-unconfirmed card', () => {
  assert.equal(countUnresolvedCards({
    cards: [card('a'), card('b')],
    acceptedMask: [true, true],
    confirmedMask: [false, false],
  }), 2);
});

test('countUnresolvedCards: confirmed and explicitly-rejected cards do not count', () => {
  assert.equal(countUnresolvedCards({
    cards: [card('a'), card('b')],
    acceptedMask: [true, false],
    confirmedMask: [true, false],
  }), 0);
});

test('countUnresolvedCards: a card with absent masks counts as live (matches isMessageFullyResolved)', () => {
  assert.equal(countUnresolvedCards({ cards: [card('a')] }), 1);
});
