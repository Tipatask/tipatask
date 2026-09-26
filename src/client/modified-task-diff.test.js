import assert from 'node:assert/strict';
import { test } from 'node:test';

const { diffWords, opsToRanges, highlightPlainText, normalizeRaw, summarizeMetadata, mapRenderedOffsetToRaw } =
  await import('./modified-task-diff.js');

// Reconstructs a side from ops — regression guard for the merge-adjacent-same-type
// logic in diffWords(): concatenating text pieces per side must always reproduce
// the original strings exactly, or the highlight would silently corrupt the render.
function reconstruct(ops, side) {
  return ops
    .filter(o => side === 'old' ? o.type !== 'added' : o.type !== 'removed')
    .map(o => o.text)
    .join('');
}

test('diffWords: identical text yields no changes', () => {
  const ops = diffWords('same text here', 'same text here');
  const { changed, changeCount } = opsToRanges(ops);
  assert.equal(changed, false);
  assert.equal(changeCount, 0);
  assert.equal(reconstruct(ops, 'old'), 'same text here');
  assert.equal(reconstruct(ops, 'new'), 'same text here');
});

test('diffWords: pure insertion', () => {
  const ops = diffWords('Fix the bug', 'Fix the annoying bug');
  assert.equal(reconstruct(ops, 'old'), 'Fix the bug');
  assert.equal(reconstruct(ops, 'new'), 'Fix the annoying bug');
  const { changed } = opsToRanges(ops);
  assert.equal(changed, true);
  assert.ok(ops.some(o => o.type === 'added' && o.text.includes('annoying')));
});

test('diffWords: pure deletion', () => {
  const ops = diffWords('Fix the annoying bug', 'Fix the bug');
  assert.equal(reconstruct(ops, 'old'), 'Fix the annoying bug');
  assert.equal(reconstruct(ops, 'new'), 'Fix the bug');
  assert.ok(ops.some(o => o.type === 'removed' && o.text.includes('annoying')));
});

test('diffWords: mid-sentence word replacement', () => {
  const ops = diffWords('Board caps at 20 rows.', 'Board caps at 50 rows.');
  assert.equal(reconstruct(ops, 'old'), 'Board caps at 20 rows.');
  assert.equal(reconstruct(ops, 'new'), 'Board caps at 50 rows.');
  assert.ok(ops.some(o => o.type === 'removed' && o.text === '20'));
  assert.ok(ops.some(o => o.type === 'added' && o.text === '50'));
  // unrelated shared words must stay marked same, not get caught up in the change
  assert.ok(ops.some(o => o.type === 'same' && o.text.includes('Board')));
});

test('diffWords: trims common prefix and suffix around a multi-line middle change', () => {
  const oldText = 'Line one\nLine two old\nLine three';
  const newText = 'Line one\nLine two new\nLine three';
  const ops = diffWords(oldText, newText);
  assert.equal(reconstruct(ops, 'old'), oldText);
  assert.equal(reconstruct(ops, 'new'), newText);
  assert.ok(ops.some(o => o.type === 'removed' && o.text === 'old'));
  assert.ok(ops.some(o => o.type === 'added' && o.text === 'new'));
});

test('diffWords: empty old to non-empty new', () => {
  const ops = diffWords('', 'Brand new content');
  assert.equal(reconstruct(ops, 'old'), '');
  assert.equal(reconstruct(ops, 'new'), 'Brand new content');
  const { changed } = opsToRanges(ops);
  assert.equal(changed, true);
});

test('diffWords: non-empty old to empty new', () => {
  const ops = diffWords('Old content here', '');
  assert.equal(reconstruct(ops, 'old'), 'Old content here');
  assert.equal(reconstruct(ops, 'new'), '');
  const { changed } = opsToRanges(ops);
  assert.equal(changed, true);
});

test('diffWords: both empty', () => {
  const ops = diffWords('', '');
  assert.deepEqual(ops, []);
  const { changed, changeCount } = opsToRanges(ops);
  assert.equal(changed, false);
  assert.equal(changeCount, 0);
});

test('opsToRanges: whitespace-only diffs produce no visible ranges', () => {
  const ops = diffWords('word1 word2', 'word1  word2'); // extra space only
  const { oldRanges, newRanges } = opsToRanges(ops);
  assert.deepEqual(oldRanges, []);
  assert.deepEqual(newRanges, []);
});

test('diffWords: single-newline (<br>-equivalent) text does not fuse words', () => {
  // This is the raw-text side of the fix — collectTextSegments (DOM half) is what
  // actually guards against .textContent fusion at render time; here we just verify
  // the pure diff treats the newline as a real token boundary.
  const oldText = 'Para one line A\nline B old';
  const newText = 'Para one line A\nline B new';
  const ops = diffWords(oldText, newText);
  assert.equal(reconstruct(ops, 'old'), oldText);
  assert.equal(reconstruct(ops, 'new'), newText);
  assert.ok(ops.some(o => o.type === 'removed' && o.text === 'old'));
  assert.ok(ops.some(o => o.type === 'added' && o.text === 'new'));
  // "line B " must stay marked same — only "old"/"new" differ, the shared words
  // around the single newline must not get swallowed into the change.
  assert.ok(ops.some(o => o.type === 'same' && o.text.includes('line B')));
});

test('diffWords: two consecutive changed lines are paired positionally, not mismatched', () => {
  // Regression for a real bug caught in manual browser testing (C1095): when 2+
  // consecutive lines change, the line-level LCS emits all removed lines then all
  // added lines (never interleaved), so a naive "pair with whatever comes next"
  // heuristic pairs UNRELATED lines and word-diffs them — producing highlight
  // ranges that cross line boundaries mid-word (observed: "rows.\nLin" as one span).
  const oldText = 'Line one intro text.\nBoard caps at 20 rows.\nLine three closing text.';
  const newText = 'Line one intro text.\nBoard caps at 50 rows, add a Load more button.\nLine three closing text. Extra new sentence appended.';
  const ops = diffWords(oldText, newText);
  assert.equal(reconstruct(ops, 'old'), oldText);
  assert.equal(reconstruct(ops, 'new'), newText);
  const { oldRanges } = opsToRanges(ops);
  // No removed range may span a '\n' in the old text — that's the literal symptom
  // of two unrelated lines getting merged into one diffLineWords() call.
  for (const [start, end] of oldRanges) {
    assert.ok(!oldText.slice(start, end).includes('\n'), `range ${start}-${end} ("${oldText.slice(start, end)}") crosses a line boundary`);
  }
  // "20" must be isolated on line 2, not fused with "Line" from line 3.
  assert.ok(ops.some(o => o.type === 'removed' && o.text === '20'));
  assert.ok(!ops.some(o => o.type === 'removed' && o.text.includes('rows.') && o.text.includes('Line')));
  // Line 3 ("Line three closing text.") is unchanged text with a pure suffix
  // addition — it must stay marked 'same', not get pulled into line 2's diff.
  assert.ok(ops.some(o => o.type === 'same' && o.text.includes('Line three closing text.')));
});

test('diffWords: large text bails to a coarse removed/added pair, not a hang', () => {
  const bigOld = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
  const bigNew = Array.from({ length: 3000 }, (_, i) => `x${i}`).join(' ');
  const ops = diffWords(bigOld, bigNew);
  assert.equal(reconstruct(ops, 'old'), bigOld);
  assert.equal(reconstruct(ops, 'new'), bigNew);
  assert.ok(ops.length <= 4, `expected a coarse bail (few ops), got ${ops.length}`);
});

test('highlightPlainText: escapes HTML and wraps ranges', () => {
  const html = highlightPlainText('a <b> & c', [[2, 5]], 'diff-added');
  assert.equal(html, 'a <span class="diff-added">&lt;b&gt;</span> &amp; c');
});

test('highlightPlainText: no ranges returns plain escaped text', () => {
  assert.equal(highlightPlainText('<script>', [], 'x'), '&lt;script&gt;');
});

test('normalizeRaw: unescapes tilde-escaping from objective-chat proposals', () => {
  assert.equal(normalizeRaw('path \\~/x and \\~200ms'), 'path ~/x and ~200ms');
  assert.equal(normalizeRaw(undefined), '');
});

test('summarizeMetadata: tag add + remove', () => {
  const summary = summarizeMetadata(
    { tags: ['a', 'b'] },
    { tags: ['b', 'c'] },
  );
  assert.deepEqual(summary.tags.added, ['c']);
  assert.deepEqual(summary.tags.removed, ['a']);
  assert.equal(summary.changed, true);
});

test('summarizeMetadata: dependency add + remove', () => {
  const summary = summarizeMetadata(
    { dependencies: ['C1'] },
    { dependencies: ['C2'] },
  );
  assert.deepEqual(summary.dependencies.added, ['C2']);
  assert.deepEqual(summary.dependencies.removed, ['C1']);
});

test('summarizeMetadata: priority change reported, unchanged fields null', () => {
  const summary = summarizeMetadata({ priority: 3 }, { priority: 5 });
  assert.deepEqual(summary.priority, { from: 3, to: 5 });
  assert.equal(summary.category, null);
  assert.equal(summary.assignee, null);
});

test('summarizeMetadata: no changes at all', () => {
  const summary = summarizeMetadata(
    { tags: ['a'], dependencies: [], priority: 2, category: 'CODING', assignee: 7 },
    { tags: ['a'], dependencies: [], priority: 2, category: 'CODING', assignee: 7 },
  );
  assert.equal(summary.changed, false);
});

test('summarizeMetadata: status is never part of the output (C1072 — never a real diff)', () => {
  const summary = summarizeMetadata({ status: 'in_progress' }, { status: 'pending' });
  assert.equal('status' in summary, false);
});

// ── mapRenderedOffsetToRaw (C1470 — click-to-edit caret sync) ──

test('mapRenderedOffsetToRaw: plain single-paragraph click lands mid-word', () => {
  const raw = 'Run the build step first.';
  // renderMarkdown('Run the build step first.') → one text node, same text.
  const nodeTexts = ['Run the build step first.'];
  const off = mapRenderedOffsetToRaw(nodeTexts, 0, 8, raw); // click inside "build"
  assert.equal(off, 8);
  assert.equal(raw.slice(off, off + 4), 'buil');
});

test('mapRenderedOffsetToRaw: repeated word resolves to the matching occurrence, not the first', () => {
  const raw = 'the cat sat on the mat';
  const nodeTexts = ['the cat sat on ', 'the mat'];
  const off = mapRenderedOffsetToRaw(nodeTexts, 1, 0, raw);
  assert.equal(off, raw.indexOf('the mat')); // second "the", not offset 0
});

test('mapRenderedOffsetToRaw: markdown syntax stripped in rendered text still maps', () => {
  const raw = 'Run `npm ci` then the **build** step.';
  // marked strips backticks/asterisks — rendered text has none.
  const nodeTexts = ['Run ', 'npm ci', ' then the ', 'build', ' step.'];
  const off = mapRenderedOffsetToRaw(nodeTexts, 4, 1, raw); // click inside " step."
  assert.equal(raw.slice(off, off + 5), 'step.'.slice(0, 5));
});

test('mapRenderedOffsetToRaw: \\~ escape divergence (raw "\\~" renders as "~") resolves via re-escape retry', () => {
  const raw = 'a \\~b\\~ tilde-escaped run of text long enough to need the anchor fallback here';
  const nodeTexts = ['a ~b~ tilde-escaped run of text long enough to need the anchor fallback here'];
  const off = mapRenderedOffsetToRaw(nodeTexts, 0, 0, raw);
  assert.equal(off, 0);
});

test('mapRenderedOffsetToRaw: caret offset after an escaped tilde accounts for the extra backslash', () => {
  const raw = 'response time is roughly \\~30ms end-to-end';
  const nodeText = 'response time is roughly ~30ms end-to-end';
  const clickOffset = nodeText.indexOf('end-to-end'); // click after the escaped tilde run
  const off = mapRenderedOffsetToRaw([nodeText], 0, clickOffset, raw);
  assert.equal(raw.slice(off, off + 10), 'end-to-end');
});

test('mapRenderedOffsetToRaw: node text absent from raw entirely → null', () => {
  const raw = 'completely different content';
  const nodeTexts = ['nothing in common whatsoever here'];
  const off = mapRenderedOffsetToRaw(nodeTexts, 0, 3, raw);
  assert.equal(off, null);
});

test('mapRenderedOffsetToRaw: empty raw → null', () => {
  const off = mapRenderedOffsetToRaw(['hello'], 0, 2, '');
  assert.equal(off, null);
});

test('mapRenderedOffsetToRaw: hitOffset clamped to node text length', () => {
  const raw = 'short text here';
  const off = mapRenderedOffsetToRaw(['short'], 0, 999, raw);
  assert.equal(off, 5); // clamped to nodeText.length, i.e. end of "short"
});
