'use strict';

// (TPT354) node:test suite for exit-resolution.js — sanitizer, comment assembly, the
// self-authored-report check, and the turn-end wait. Fixtures are built from the two garbage
// samples in the bug report: Claude Code's animated OSC title bar + spinner/status redraws, and
// Codex's `Working…` / composer / model-footer chrome.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  stripStringSequences,
  isReadable,
  sanitizeTerminalTail,
  prepareFinalMessage,
  fenceBlock,
  buildExitResolutionComment,
  isTerminalTailExitComment,
  maxCommentId,
  hasSelfAuthoredResolution,
  waitForFinalMessage,
  selectFinalMessage,
} = require('./exit-resolution');
const { AGENT_EXIT_MARKER, isAgentLogTailComment } = require('./resolution-payload');

const ESC = '\x1b';
const BEL = '\x07';
const title = (t) => `${ESC}]0;${t}${BEL}`;

// ── Fixtures ──

// Raw PTY form: real OSC 0 title sequences, CSI cursor moves, spinner + counter redraws.
function claudeNoisyRaw() {
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const glyph = i % 2 ? '◑' : '◐';
    frames.push(`${title(`${glyph} Ahrefs 76→88 score gain attribution`)}${ESC}[2K${ESC}[1G✻ Sock-hopping…${ESC}[20G${i}\r\n`);
  }
  return [
    frames.join(''),
    `${ESC}[1m⏺${ESC}[22m Fixed the exit comment builder so it strips title sequences and posts the final message.\r\n`,
    `${title('◐ Ahrefs 76→88 score gain attribution')}`,
    '\r\n5 new messages (click) ↓\r\n',
    'Too many changed files to show diff\r\n',
    'Per-file diff is skipped above 500 files\r\n',
    '6161 files changed +1406939 -2355                                     ✕\r\n',
    `${title('◑ Ahrefs 18→25 Sep diff: attribute 76→88 score gain')}`,
  ].join('');
}

// The comment text exactly as it landed in the bug report: the OSC introducer/terminator already
// gone, only the bare `0;title` payloads, glued together, plus spinner/counter fragments.
const CLAUDE_STRIPPED_SAMPLE = [
  '0;◐ Ahrefs 76→88 score gain attribution0;◑ Ahrefs 76→88 score gain attribution0;◐ Ahrefs 76→88 score gain attribution0;◑ Ahrefs 76→88 score gain attribution',
  '',
  '5',
  '',
  '  0;◐ Ahrefs 76→88 score gain attribution0;◑ Ahrefs 76→88 score gain attribution0;◐ Ahrefs 76→88 score gain attribution',
  '',
  '✻                 7       38                                                                6161 files changed +1406939 -2355                                     ✕',
  '',
  '✽                         63',
  '',
  'Sock-hopping…             88',
  '',
  '  0;◐ Ahrefs 18→25 Sep diff: attribute 76→88 score gain',
  '',
  '825',
  '',
  '                   Too many changed files to show diff',
  '✻ Sock-hopping…           75                                                                               Per-file diff is skipped above 500 files',
  '',
  '⏺',
  '',
  '5 new messages (click) ↓',
  '  0;◐ Ahrefs 76→88 score gain attribution0;◑ Ahrefs 76→88 score gain attribution',
  'refs 76→88 score gain attribution0;◑ Ahrefs 76→88 score gain attribution0;◐ Ahrefs 76→88 score gain attribution',
].join('\n');

const CODEX_SAMPLE = [
  '',
  '',
  '◦ Working (8m 12s • esc to interrupt)',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-5.6-Sol medium · ~/Projects/Tipatask · Review system architecture                                                                    ⚠ 1 warning · f2 to view',
].join('\n');

// ── stripStringSequences ──

test('strips OSC terminated by BEL and by ST', () => {
  assert.equal(stripStringSequences(`a${ESC}]0;title${BEL}b${ESC}]8;;http://x${ESC}\\c`), 'abc');
});

test('drops an unterminated trailing OSC and a leading mid-OSC remnant', () => {
  assert.equal(stripStringSequences(`keep${ESC}]0;half a tit`), 'keep');
  assert.equal(stripStringSequences(`tail of a title${BEL}real text`), 'real text');
});

test('leaves a BEL-free first line alone', () => {
  assert.equal(stripStringSequences('plain first line\nsecond'), 'plain first line\nsecond');
});

// ── sanitizeTerminalTail: the garbage samples ──

test('raw Claude garbage: no title/spinner/status text survives, the real line does', () => {
  const out = sanitizeTerminalTail(claudeNoisyRaw());
  assert.match(out, /Fixed the exit comment builder/);
  assert.doesNotMatch(out, /Ahrefs/);
  assert.doesNotMatch(out, /0;[◐◑]/);
  assert.doesNotMatch(out, /Sock-hopping/);
  assert.doesNotMatch(out, /new messages/);
  assert.doesNotMatch(out, /Too many changed files/);
  assert.doesNotMatch(out, /files changed/);
  assert.doesNotMatch(out, /\x07|\x1b/);
});

test('bug-report Claude sample (bare 0;title remnants, no OSC bytes) → nothing readable', () => {
  assert.equal(sanitizeTerminalTail(CLAUDE_STRIPPED_SAMPLE), '');
});

test('bug-report Codex sample (Working / composer / model footer) → nothing readable', () => {
  assert.equal(sanitizeTerminalTail(CODEX_SAMPLE), '');
});

test('real content around the Claude sample survives, garbage does not', () => {
  const buf = `Built the sanitizer and wired it into the exit handler.\n${CLAUDE_STRIPPED_SAMPLE}\nAll relevant tests pass on Node 22 now.\n`;
  const out = sanitizeTerminalTail(buf);
  assert.match(out, /Built the sanitizer and wired it into the exit handler\./);
  assert.match(out, /All relevant tests pass on Node 22 now\./);
  assert.doesNotMatch(out, /Ahrefs|Sock-hopping|new messages/);
});

// ── sanitizeTerminalTail: rules ──

test('carriage-return spinner rewrite keeps only the final segment', () => {
  const out = sanitizeTerminalTail('Compiling the module graph...\rCompiling the module graph... done in 1.2 seconds\n');
  assert.equal(out, 'Compiling the module graph... done in 1.2 seconds');
});

test('redrawn frame rows collapse, keeping the LAST copy in order', () => {
  const row = (n) => `Row number ${n} of the diff panel is here`;
  const frame1 = [row(1), row(2), row(3), row(4)].join('\n');
  const frame2 = [row(1), row(2), row(3), row(5)].join('\n');
  const out = sanitizeTerminalTail(`${frame1}\n${frame2}\n`);
  assert.deepEqual(out.split('\n'), [row(4), row(1), row(2), row(3), row(5)]);
});

test('short lines may legitimately repeat; closing-bracket lines are not eaten', () => {
  const out = sanitizeTerminalTail('Here is the change I made to both helper functions:\nfunction makeThing(a, b) {\n  return build(a, b);\n}\nfunction other(a) {\n  return a;\n}\n');
  assert.equal(out.split('\n').filter(l => l === '}').length, 2);
});

test('a code-only tail with no prose line is not "readable" → header only', () => {
  assert.equal(sanitizeTerminalTail('function makeThing(a, b) {\n  return build(a, b);\n}\n'), '');
});

test('input-box side borders are peeled, content kept', () => {
  const out = sanitizeTerminalTail('│ Please review the exit comment change carefully │\n╭──────────────────╮\n╰──────────────────╯\n');
  assert.equal(out, 'Please review the exit comment change carefully');
});

test('CSI cursor-addressed rows are separated by reflow, not glued', () => {
  const out = sanitizeTerminalTail(`${ESC}[1;1HFirst readable line of the frame${ESC}[2;1HSecond readable line of the frame`);
  assert.deepEqual(out.split('\n'), ['First readable line of the frame', 'Second readable line of the frame']);
});

test('caps: at most 25 lines and 2000 chars, cut on a line boundary', () => {
  const many = Array.from({ length: 60 }, (_, i) => `Line ${String(i).padStart(2, '0')} carries some readable words here`).join('\n');
  const out = sanitizeTerminalTail(many);
  assert.equal(out.split('\n').length, 25);
  assert.match(out, /Line 59 carries/);
  const wide = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(2, '0') + ' ' + 'word '.repeat(30)).join('\n');
  const capped = sanitizeTerminalTail(wide);
  assert.ok(capped.length <= 2000);
  assert.ok(capped.split('\n').every(l => /^\d\d word/.test(l)), 'no partial first line');
});

test('empty / non-string input → empty string', () => {
  assert.equal(sanitizeTerminalTail(''), '');
  assert.equal(sanitizeTerminalTail(null), '');
  assert.equal(sanitizeTerminalTail(undefined), '');
});

// ── isReadable ──

test('isReadable needs a real sentence-ish line', () => {
  assert.equal(isReadable('Fixed the builder and all tests pass'), true);
  assert.equal(isReadable('ok'), false);
  assert.equal(isReadable('a b c d e f'), false);
  assert.equal(isReadable(''), false);
});

// ── prepareFinalMessage ──

test('final message: trimmed, control chars removed, blank → empty', () => {
  assert.equal(prepareFinalMessage('  Done.\r\nAll good.\x00  '), 'Done.\nAll good.');
  assert.equal(prepareFinalMessage('   \n  '), '');
  assert.equal(prepareFinalMessage('12345'), '');
  assert.equal(prepareFinalMessage(null), '');
});

test('final message: unbalanced fence is closed', () => {
  assert.equal(prepareFinalMessage('Run this:\n```bash\nnpm test'), 'Run this:\n```bash\nnpm test\n```');
});

test('final message: balanced fences untouched', () => {
  const s = 'Before\n```js\nconst a = 1;\n```\nAfter';
  assert.equal(prepareFinalMessage(s), s);
});

test('final message: over-long text truncated, fence closed BEFORE the truncation note', () => {
  const long = '```\n' + 'x'.repeat(6000);
  const out = prepareFinalMessage(long);
  assert.ok(out.length < 4100);
  assert.match(out, /\n```\n\n…\[truncated\]$/);
});

test('final message: raw HTML comment opener is neutralised', () => {
  const out = prepareFinalMessage('See <!-- this is unterminated and would hide the rest');
  assert.doesNotMatch(out, /<!--/);
  assert.match(out, /&lt;!--/);
});

// ── fenceBlock ──

test('fenceBlock lengthens the fence past any backtick run inside', () => {
  assert.equal(fenceBlock('plain'), '```\nplain\n```');
  assert.equal(fenceBlock('has ``` inside'), '````\nhas ``` inside\n````');
});

// ── buildExitResolutionComment ──

test('final message wins over the tail; shape is header, body, marker', () => {
  const { content, source } = buildExitResolutionComment({
    reason: 'completed',
    finalMessage: 'TPT352 completed. **MailSenderTest.php** now skips sibling-file checks.',
    buffer: claudeNoisyRaw(),
  });
  assert.equal(source, 'final-message');
  assert.equal(content, `Agent completed the task\n\nTPT352 completed. **MailSenderTest.php** now skips sibling-file checks.\n\n${AGENT_EXIT_MARKER}`);
  assert.equal(isAgentLogTailComment(content), true);
});

test('all three headers', () => {
  const h = (reason, exitCode) => buildExitResolutionComment({ reason, exitCode, finalMessage: 'Some readable final words here' }).content.split('\n')[0];
  assert.equal(h('completed'), 'Agent completed the task');
  assert.equal(h('user-terminated'), 'Agent session terminated by user');
  assert.equal(h(undefined, 137), 'Agent session ended (exit code 137)');
});

test('(TPT357) watchdog kill header carries the reason text and still reads as an auto exit comment', () => {
  const build = (reasonText) => buildExitResolutionComment({ reason: 'runaway-killed', reasonText, exitCode: 143, finalMessage: 'Some readable final words here' }).content;
  const withText = build('127 descendants (threshold 50)');
  assert.equal(withText.split('\n')[0], 'Agent session killed by the descendant-process watchdog — 127 descendants (threshold 50)');
  assert.equal(isAgentLogTailComment(withText), true);
  const bare = build(undefined);
  assert.equal(bare.split('\n')[0], 'Agent session killed by the descendant-process watchdog');
  assert.equal(isAgentLogTailComment(bare), true);
});

test('noisy title-bar session with no final message → concise fenced readable tail', () => {
  const { content, source } = buildExitResolutionComment({ reason: 'completed', buffer: claudeNoisyRaw() });
  assert.equal(source, 'tail');
  assert.match(content, /^Agent completed the task\n\n```\n/);
  assert.match(content, /Fixed the exit comment builder/);
  assert.doesNotMatch(content, /Ahrefs|Sock-hopping/);
  assert.ok(content.length < 400, `comment should be concise, got ${content.length} chars`);
  assert.equal(isAgentLogTailComment(content), true);
});

test('nothing readable anywhere → header + marker only', () => {
  for (const buffer of [CLAUDE_STRIPPED_SAMPLE, CODEX_SAMPLE, '', undefined]) {
    const { content, source } = buildExitResolutionComment({ reason: 'completed', buffer });
    assert.equal(source, 'header-only');
    assert.equal(content, `Agent completed the task\n\n${AGENT_EXIT_MARKER}`);
    assert.equal(isAgentLogTailComment(content), true);
  }
});

test('a tail containing backtick runs cannot close its own fence early', () => {
  const { content } = buildExitResolutionComment({ reason: 'completed', buffer: 'Here is a fenced block: ``` and more words to read here' });
  assert.match(content, /^Agent completed the task\n\n````\n/);
});

// ── maxCommentId / hasSelfAuthoredResolution ──

test('maxCommentId: max, 0 for empty, null when unavailable', () => {
  assert.equal(maxCommentId([{ id: 3 }, { id: 9 }, { id: '5' }]), 9);
  assert.equal(maxCommentId([]), 0);
  assert.equal(maxCommentId(null), null);
  assert.equal(maxCommentId(undefined), null);
});

const report = (id, extra = {}) => ({ id, comment_type: 'resolution', content: 'Changed the builder to read the final message. Files: ws-handlers.js. Verify: npm test. Follow-ups: none.', ...extra });

test('self-authored report newer than the baseline suppresses the auto comment', () => {
  assert.equal(hasSelfAuthoredResolution([report(11)], 10), true);
  assert.equal(hasSelfAuthoredResolution([report(11)], 0), true);
});

test('report at or below the baseline (a previous run) does not', () => {
  assert.equal(hasSelfAuthoredResolution([report(10)], 10), false);
  assert.equal(hasSelfAuthoredResolution([report(4)], 10), false);
});

test('auto-posted exit comments and non-resolution comments do not count', () => {
  const auto = report(12, { content: `Agent completed the task\n\n${AGENT_EXIT_MARKER}` });
  const legacy = report(13, { content: 'Agent completed the task\n\n```\nlog\n```' });
  assert.equal(hasSelfAuthoredResolution([auto, legacy], 10), false);
  assert.equal(hasSelfAuthoredResolution([{ id: 14, comment_type: 'comment', content: 'thoughts' }], 10), false);
});

test('unknown baseline or unusable list never suppresses', () => {
  assert.equal(hasSelfAuthoredResolution([report(11)], null), false);
  assert.equal(hasSelfAuthoredResolution([report(11)], undefined), false);
  assert.equal(hasSelfAuthoredResolution(null, 5), false);
});

// ── waitForFinalMessage ──

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('wait: returns immediately when the turn has ended', async () => {
  let reads = 0;
  const r = await waitForFinalMessage(async () => { reads++; return { text: 'done', turnEnded: true }; }, { needTurnEnd: true, ...fakeClock() });
  assert.deepEqual(r, { text: 'done', turnEnded: true });
  assert.equal(reads, 1);
});

test('wait: needTurnEnd false never retries', async () => {
  let reads = 0;
  const r = await waitForFinalMessage(async () => { reads++; return { text: 'mid', turnEnded: false }; }, { needTurnEnd: false, ...fakeClock() });
  assert.equal(r.text, 'mid');
  assert.equal(reads, 1);
});

test('wait: re-reads until the turn ends', async () => {
  const seq = [{ text: 'let me check', turnEnded: false }, { text: 'let me check', turnEnded: false }, { text: 'All done.', turnEnded: true }];
  let i = 0;
  const r = await waitForFinalMessage(async () => seq[i++], { needTurnEnd: true, ...fakeClock() });
  assert.equal(r.text, 'All done.');
  assert.equal(i, 3);
});

test('wait: gives up at the timeout and returns the newest text it saw', async () => {
  let reads = 0;
  const r = await waitForFinalMessage(async () => { reads++; return { text: `partial ${reads}`, turnEnded: false }; }, { needTurnEnd: true, timeoutMs: 20_000, intervalMs: 5_000, ...fakeClock() });
  assert.match(r.text, /^partial \d+$/);
  assert.ok(reads >= 4 && reads <= 6, `reads=${reads}`);
});

test('wait: a null read (no transcript) returns at once instead of burning the timeout', async () => {
  let reads = 0;
  const r = await waitForFinalMessage(async () => { reads++; return null; }, { needTurnEnd: true, ...fakeClock() });
  assert.equal(r, null);
  assert.equal(reads, 1);
});

test('wait: a throwing reader is treated as no transcript', async () => {
  const r = await waitForFinalMessage(async () => { throw new Error('boom'); }, { needTurnEnd: true, ...fakeClock() });
  assert.equal(r, null);
});

test('wait: empty-text results keep waiting but never become the answer', async () => {
  const seq = [{ text: '', turnEnded: false }, { text: 'Finished the work.', turnEnded: true }];
  let i = 0;
  const r = await waitForFinalMessage(async () => seq[i++], { needTurnEnd: true, ...fakeClock() });
  assert.equal(r.text, 'Finished the work.');
});

// ── selectFinalMessage ──

test('select: a finished turn is used for every reason', () => {
  const r = { text: 'All done.', turnEnded: true };
  for (const reason of ['completed', 'user-terminated', undefined]) assert.equal(selectFinalMessage(r, reason), 'All done.');
});

test('select: mid-turn text is dropped on completed, kept on terminate/exit', () => {
  const r = { text: 'Let me check the tests.', turnEnded: false };
  assert.equal(selectFinalMessage(r, 'completed'), '');
  assert.equal(selectFinalMessage(r, 'user-terminated'), 'Let me check the tests.');
  assert.equal(selectFinalMessage(r, undefined), 'Let me check the tests.');
});

test('select: null / empty results give empty string', () => {
  assert.equal(selectFinalMessage(null, 'completed'), '');
  assert.equal(selectFinalMessage({ text: '  ', turnEnded: true }, 'completed'), '');
});

// ── isTerminalTailExitComment (kickoff prompts must not embed a prior run's screen text) ──

test('tail-exit: the real builder\'s tail-form comment is recognised, for every exit reason', () => {
  for (const reason of ['user-terminated', 'completed', undefined]) {
    const { content, source } = buildExitResolutionComment({
      reason, exitCode: 0, finalMessage: '', buffer: claudeNoisyRaw(),
    });
    assert.equal(source, 'tail', `fixture must produce the tail form (${reason})`);
    assert.equal(isTerminalTailExitComment(content), true, String(reason));
  }
});

test('tail-exit: the legacy pre-TPT354 shape (no marker) is recognised', () => {
  const legacy = 'Agent completed the task\n\n```\n✳ S   2\n0;◐ some-title\u0007\n```';
  assert.equal(isAgentLogTailComment(legacy), true);
  assert.equal(isTerminalTailExitComment(legacy), true);
});

test('tail-exit: an exit comment carrying the agent\'s final message is NOT a tail comment', () => {
  const { content, source } = buildExitResolutionComment({
    reason: 'user-terminated',
    finalMessage: 'I split the work into two steps and finished the first one.',
    buffer: claudeNoisyRaw(),
  });
  assert.equal(source, 'final-message');
  assert.equal(isAgentLogTailComment(content), true, 'still an auto-posted exit comment');
  assert.equal(isTerminalTailExitComment(content), false);
});

test('tail-exit: a final message that merely contains a fenced block is still kept', () => {
  const { content } = buildExitResolutionComment({
    reason: 'user-terminated',
    finalMessage: 'Run this next:\n\n```\nnpm test\n```\n\nThen review the diff.',
    buffer: '',
  });
  assert.equal(isTerminalTailExitComment(content), false);
});

test('tail-exit: the header-only exit comment carries no screen text and is kept', () => {
  const { content, source } = buildExitResolutionComment({ reason: 'user-terminated', finalMessage: '', buffer: '' });
  assert.equal(source, 'header-only');
  assert.equal(isTerminalTailExitComment(content), false);
});

test('tail-exit: ordinary, self-authored and spec comments are never tail comments', () => {
  for (const c of [
    'Plain discussion comment.',
    '## What changed and why\n\nSelf-authored resolution report.\n\n```\nnpm test\n```',
    'Agent session terminated by user',                       // header line alone, no body/marker
    'Agent session terminated by user\n\nlooks like a header but the body is prose',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isTerminalTailExitComment(c), false, JSON.stringify(c));
  }
});
