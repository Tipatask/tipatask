// Behavioral parity with the API mention parser plus client highlighting cases.
// When the API checkout exists, guard the shared boundary-regex source against drift;
// full-file equality is impossible because this ESM module has extra exports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_HANDLES, parseMentions, buildMentionCandidates, highlightMentionsInHtml } from './mention-highlight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1a. Behavioral parity — api/src/lib/mentions.test.js's MEMBERS + all 13 cases ──

const MEMBERS = [
  { user_id: 1, name: 'John', email: 'john@example.com' },
  { user_id: 2, name: 'John Smith', email: 'jsmith@example.com' },
  { user_id: 3, name: "O'Brien (PM)", email: 'obrien@example.com' },
  { user_id: 4, name: 'Anton Matiienko', email: 'anton@example.com' },
];

test('multi-word name wins over a shorter name it starts with', () => {
  const result = parseMentions('@John Smith please look', MEMBERS);
  assert.deepEqual(result, [{ userId: 2, name: 'John Smith' }]);
});

test('shorter name still matches on its own', () => {
  const result = parseMentions('@John can you check this', MEMBERS);
  assert.deepEqual(result, [{ userId: 1, name: 'John' }]);
});

test('a bare email address is never read as a mention', () => {
  assert.deepEqual(parseMentions('reach me at anton@gmail.com please', MEMBERS), []);
  assert.deepEqual(parseMentions('foo.bar@example.com', MEMBERS), []);
});

test('email local-part resolves the member', () => {
  const result = parseMentions('@jsmith take a look', MEMBERS);
  assert.deepEqual(result, [{ userId: 2, name: 'John Smith' }]);
});

test('duplicate mentions of the same person dedupe, kept in first-appearance order', () => {
  const result = parseMentions('@John Smith and again @John Smith and also @John', MEMBERS);
  assert.deepEqual(result, [
    { userId: 2, name: 'John Smith' },
    { userId: 1, name: 'John' },
  ]);
});

test('an unrecognized handle matches nothing', () => {
  assert.deepEqual(parseMentions('@nobody here', MEMBERS), []);
});

test('matching is case-insensitive', () => {
  const result = parseMentions('@JOHN SMITH please look', MEMBERS);
  assert.deepEqual(result, [{ userId: 2, name: 'John Smith' }]);
});

test('mention at the very start of the text matches', () => {
  assert.deepEqual(parseMentions('@John hello', MEMBERS), [{ userId: 1, name: 'John' }]);
});

test('mention right after a newline matches', () => {
  assert.deepEqual(parseMentions('hi\n@John please review', MEMBERS), [{ userId: 1, name: 'John' }]);
});

test('a member name containing regex metacharacters is matched literally', () => {
  const result = parseMentions("@O'Brien (PM) can you review", MEMBERS);
  assert.deepEqual(result, [{ userId: 3, name: "O'Brien (PM)" }]);
});

test('empty, null, and undefined text return no mentions', () => {
  assert.deepEqual(parseMentions('', MEMBERS), []);
  assert.deepEqual(parseMentions(null, MEMBERS), []);
  assert.deepEqual(parseMentions(undefined, MEMBERS), []);
});

test('no members configured returns no mentions', () => {
  assert.deepEqual(parseMentions('@John hello', []), []);
  assert.deepEqual(parseMentions('@John hello', undefined), []);
});

test('a member with no user id is never matched (e.g. a pending invite row)', () => {
  const withPending = [...MEMBERS, { user_id: null, name: 'Pending Invitee', email: 'pending@example.com' }];
  assert.deepEqual(parseMentions('@Pending Invitee hi', withPending), []);
});

// ── 1b. Highlight-specific coverage ──

test('buildMentionCandidates skips a handle containing "@" (nameless member backfilled from email)', () => {
  const candidates = buildMentionCandidates([{ user_id: 9, name: 'pending@example.com', email: 'pending@example.com' }], []);
  // Only the email local-part handle ("pending") survives; the full-address "name" handle is dropped.
  assert.ok(candidates.every((c) => !c.handle.includes('@')));
  assert.ok(candidates.some((c) => c.handle === 'pending'));
});

test('buildMentionCandidates emits both the raw and HTML-entity-escaped spelling of a name with metacharacters', () => {
  const candidates = buildMentionCandidates([{ user_id: 3, name: "O'Brien (PM)", email: 'obrien@example.com' }], []);
  assert.ok(candidates.some((c) => c.handle === "O'Brien (PM)"));
  assert.ok(candidates.some((c) => c.handle === 'O&#39;Brien (PM)'));
});

test('buildMentionCandidates includes agent handles with kind:"agent" and userId:null, sorted alongside members', () => {
  const candidates = buildMentionCandidates(MEMBERS, AGENT_HANDLES);
  const claude = candidates.find((c) => c.handle === 'claude');
  assert.deepEqual(claude, { handle: 'claude', userId: null, name: 'claude', kind: 'agent' });
});

test('highlightMentionsInHtml wraps a real member handle in <mark class="mention">, in a plain text node', () => {
  const candidates = buildMentionCandidates(MEMBERS, []);
  const html = highlightMentionsInHtml('<p>ping @John please</p>', candidates);
  assert.equal(html, '<p>ping <mark class="mention">@John</mark> please</p>');
});

test('highlightMentionsInHtml wraps an agent handle in <mark class="mention mention--agent">', () => {
  const candidates = buildMentionCandidates([], AGENT_HANDLES);
  const html = highlightMentionsInHtml('<p>cc @claude</p>', candidates);
  assert.equal(html, '<p>cc <mark class="mention mention--agent">@claude</mark></p>');
});

test('highlightMentionsInHtml leaves an unrecognized handle (no catch-all) unwrapped', () => {
  const candidates = buildMentionCandidates(MEMBERS, AGENT_HANDLES);
  const html = highlightMentionsInHtml('<p>ping @nobody</p>', candidates);
  assert.equal(html, '<p>ping @nobody</p>');
});

test('highlightMentionsInHtml leaves a whole <span class="file-ref"> wrapper untouched, even when the handle text would otherwise match', () => {
  const candidates = buildMentionCandidates([{ user_id: 5, name: 'ai', email: 'ai@example.com' }], []);
  const html = '<p>see <span class="file-ref">@ai/todo/server/src/client/task-board.js</span></p>';
  assert.equal(highlightMentionsInHtml(html, candidates), html);
});

test('highlightMentionsInHtml matches the HTML-entity-escaped spelling marked.parse() produces for a name with an apostrophe', () => {
  const candidates = buildMentionCandidates([{ user_id: 3, name: "O'Brien (PM)", email: 'obrien@example.com' }], []);
  // marked.parse() escapes ' to &#39; in its HTML output — the raw member name never
  // appears verbatim in rendered comment/description HTML for a name like this one.
  const html = highlightMentionsInHtml('<p>ping @O&#39;Brien (PM) please</p>', candidates);
  assert.equal(html, '<p>ping <mark class="mention">@O&#39;Brien (PM)</mark> please</p>');
});

test('highlightMentionsInHtml never touches markup — only text-node content', () => {
  const candidates = buildMentionCandidates(MEMBERS, []);
  const html = highlightMentionsInHtml('<a href="/user/John">@John</a>', candidates);
  assert.equal(html, '<a href="/user/John"><mark class="mention">@John</mark></a>');
});

test('highlightMentionsInHtml with no candidates returns the input unchanged', () => {
  assert.equal(highlightMentionsInHtml('<p>@John</p>', []), '<p>@John</p>');
  assert.equal(highlightMentionsInHtml('<p>@John</p>', null), '<p>@John</p>');
});

// ── 2. Source-text drift guard (skips when api/ isn't checked out) ──
//
// api/ belongs to the enclosing Tipatask monorepo, not to this (ai/todo/server) repo — a
// standalone clone of this repo on its own remote, or the packaged app built from one,
// never has an api/ directory alongside it. Absent is a normal state, not a failure, same
// skip-when-absent technique as transliteration.test.js's check in the opposite direction.
const SOURCE_OF_TRUTH_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'api', 'src', 'lib', 'mentions.js');
const hasSourceOfTruth = fs.existsSync(SOURCE_OF_TRUTH_PATH);
const NEEDS_SOURCE = {
  skip: hasSourceOfTruth
    ? false
    : 'api/src/lib/mentions.js is not checked out here (belongs to the enclosing Tipatask monorepo, not this repo) — hand-sync parity is only checkable when both are checked out together.',
};

// The one line that MUST stay byte-identical: if the API's boundary regex ever changes,
// a highlighted @name here can silently stop meaning "the API will notify this person".
const BOUNDARY_REGEX_SOURCE = '(^|[^\\\\w.@-])@(${alternation})(?![\\\\w-])';

test('the API boundary-regex source string is unchanged in api/src/lib/mentions.js', NEEDS_SOURCE, () => {
  const sourceOfTruth = fs.readFileSync(SOURCE_OF_TRUTH_PATH, 'utf8');
  assert.ok(
    sourceOfTruth.includes(BOUNDARY_REGEX_SOURCE),
    'api/src/lib/mentions.js\'s boundary-regex source string has changed. ai/todo/server cannot ' +
      'require across the gitlink into api/, so parseMentions()/highlightMentionsInHtml() in ' +
      'mention-highlight.js are kept in sync by hand: copy the new regex across in both ' +
      'directions of this diff. If you touched neither file, your api/ checkout is probably ' +
      'stale — it is a sibling repo and does not move with this one.'
  );
});
