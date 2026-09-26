import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_BASIS, estimateTextWidth, idBadgeWidth, cardVariant, cardMaxWidthPx,
} from './card-width.js';

test('estimateTextWidth is null-safe for empty/non-string input', () => {
  assert.equal(estimateTextWidth('', 7), 0);
  assert.equal(estimateTextWidth(null, 7), 0);
  assert.equal(estimateTextWidth(undefined, 7), 0);
});

test('estimateTextWidth scales with character count', () => {
  assert.equal(estimateTextWidth('abcd', 7), 28);
});

test('idBadgeWidth is safe for a missing task key', () => {
  assert.equal(idBadgeWidth(undefined), 16);
  assert.equal(idBadgeWidth(''), 16);
});

test('idBadgeWidth grows with a longer task key', () => {
  assert.ok(idBadgeWidth('C123456') > idBadgeWidth('C1'));
});

test('cardVariant thresholds match the pre-C1580 description-length rule', () => {
  assert.equal(cardVariant(0), 'base');
  assert.equal(cardVariant(1000), 'base');
  assert.equal(cardVariant(1001), 'medium');
  assert.equal(cardVariant(1500), 'medium');
  assert.equal(cardVariant(1501), 'wide');
});

test('short title never shrinks the card below its variant basis', () => {
  for (const variant of ['base', 'medium', 'wide']) {
    const px = cardMaxWidthPx({ title: 'Fix', taskKey: 'C1', variant });
    assert.equal(px, CARD_BASIS[variant]);
  }
});

test('a long title grows the ceiling past the base variant basis', () => {
  const longTitle = 'API: verify Cloudflare Turnstile token on email/password login';
  const px = cardMaxWidthPx({ title: longTitle, taskKey: 'C1492', variant: 'base' });
  assert.ok(px > CARD_BASIS.base, `expected ${px} > ${CARD_BASIS.base}`);
});

test('medium/wide variants never fall below their own basis even with an empty title', () => {
  assert.equal(cardMaxWidthPx({ title: '', taskKey: '', variant: 'medium' }), CARD_BASIS.medium);
  assert.equal(cardMaxWidthPx({ title: '', taskKey: '', variant: 'wide' }), CARD_BASIS.wide);
});

test('an injected measurer overrides the default character estimator', () => {
  const measureTitle = (text) => (text ? text.length * 100 : 0);
  const px = cardMaxWidthPx({ title: 'Fix', taskKey: 'C1', variant: 'base', measureTitle });
  // 3 chars * 100 + idBadgeWidth('C1') + CARD_CHROME_PX, well past the 252px basis.
  assert.ok(px > 300, `expected injected measurer to dominate, got ${px}`);
});

test('missing title/taskKey/variant are all handled without throwing', () => {
  assert.equal(cardMaxWidthPx({}), CARD_BASIS.base);
  assert.equal(cardMaxWidthPx(), CARD_BASIS.base);
});
