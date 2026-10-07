'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isHistoryId, nativeStorageRef, locateNativeSession, filterHistory, publicHistoryRow,
  historyAvailability, cleanChatText, clipExcerpt, extractKeywords, buildSearchData, KEYWORD_COUNT, EXCERPT_CHARS,
} = require('./chat-history');
const { ASK_USER_REMINDER } = require('./task-chat-widgets');
const { claudeProjectDirName } = require('./task-agent/final-message');
const { piDefaultSessionDir } = require('./pi-custom-endpoint');

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-chat-history-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  return file;
}

function entryFor(provider, nativeSessionId, cwd, env) {
  return { historyId: 'h1', provider, nativeSessionId, cwd, storage: nativeStorageRef(provider, cwd, env) };
}

test('Claude: found under <config dir>/projects/<cwd dir>/<id>.jsonl, only from the recorded cwd and config dir', (t) => {
  const root = tempRoot(t);
  const cwd = path.join(root, 'checkout');
  fs.mkdirSync(cwd);
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const id = '2b7c1d3e-1111-4222-8333-444455556666';
  const file = writeFile(path.join(root, 'claude', 'projects', claudeProjectDirName(cwd), `${id}.jsonl`));
  const entry = entryFor('claude', id, cwd, env);
  assert.deepEqual(entry.storage, { claudeConfigDir: path.join(root, 'claude') });
  assert.equal(locateNativeSession(entry, { cwd, env }), file);
  assert.equal(locateNativeSession(entry, { cwd: path.join(root, 'other'), env }), null, 'another checkout cannot resume it');
  assert.equal(locateNativeSession(entry, { cwd, env: { CLAUDE_CONFIG_DIR: path.join(root, 'elsewhere') } }), null,
    'a spawn with another config dir would not find it');
  fs.rmSync(file);
  assert.equal(locateNativeSession(entry, { cwd, env }), null, 'deleted by the provider → unavailable');
});

test('Codex: rollout-<ts>-<thread id>.jsonl under the project CODEX_HOME sessions tree', (t) => {
  const cwd = tempRoot(t);
  const id = '019edf2f-cec1-75f3-9b06-15f126187e08';
  const file = writeFile(path.join(cwd, '.codex', 'sessions', '2026', '06', '19', `rollout-2026-06-19T12-21-52-${id}.jsonl`));
  writeFile(path.join(cwd, '.codex', 'sessions', '2026', '06', '20', 'rollout-2026-06-20T01-00-00-019ead40-ee28-7260-a990-7ff5b52f06bf.jsonl'));
  const entry = entryFor('codex', id, cwd, {});
  assert.deepEqual(entry.storage, { codexHome: path.join(cwd, '.codex') });
  const cache = new Map();
  assert.equal(locateNativeSession(entry, { cwd, env: {} }, cache), file);
  assert.equal(locateNativeSession({ ...entry, nativeSessionId: '019edf2f-0000-0000-0000-000000000000' }, { cwd, env: {} }, cache), null);
});

test('Pi: <iso>_<uuid>.jsonl in the session dir a spawn from this cwd would use', (t) => {
  const root = tempRoot(t);
  const cwd = path.join(root, 'checkout');
  fs.mkdirSync(cwd);
  const env = { PI_CODING_AGENT_DIR: path.join(root, 'pi-agent') };
  const id = 'a1b2c3d4-0000-4000-8000-000000000001';
  const dir = piDefaultSessionDir(cwd, env);
  const file = writeFile(path.join(dir, `2026-10-06T08-00-00-000Z_${id}.jsonl`));
  const entry = entryFor('pi', id, cwd, env);
  assert.deepEqual(entry.storage, { piSessionDir: dir });
  assert.equal(locateNativeSession(entry, { cwd, env }), file);
  const pinned = { ...env, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'pinned') };
  assert.equal(locateNativeSession(entry, { cwd, env: pinned }), null, 'an explicit other session dir would not find it');
});

test('unsupported providers and unsafe ids are never looked up', (t) => {
  const cwd = tempRoot(t);
  assert.equal(locateNativeSession(entryFor('gemini', 'abc', cwd, {}), { cwd, env: {} }), null);
  assert.equal(locateNativeSession({ ...entryFor('claude', '../../etc/passwd', cwd, {}) }, { cwd, env: {} }), null);
  assert.equal(locateNativeSession(null, { cwd }), null);
  assert.equal(isHistoryId('2b7c1d3e-1111-4222-8333-444455556666'), true);
  assert.equal(isHistoryId('../x'), false);
  assert.equal(isHistoryId(42), false);
});

test('filterHistory scopes to project, task or kind, searches metadata, newest first; public rows hide internals', () => {
  const entries = [
    { historyId: 'p1', kind: 'project', projectId: '2', title: 'Sprint review', provider: 'claude', model: 'opus', lastActivityAt: 10 },
    { historyId: 't1', kind: 'task', projectId: '2', taskKey: 'TPT1', title: 'Fix login', provider: 'codex', model: 'gpt', lastActivityAt: 30 },
    { historyId: 't2', kind: 'task', projectId: '2', taskKey: 'TPT2', title: 'Other', provider: 'pi', model: 'm', lastActivityAt: 20 },
    { historyId: 'x1', kind: 'project', projectId: '9', title: 'Foreign', provider: 'claude', lastActivityAt: 40 },
  ];
  assert.deepEqual(filterHistory(entries, { projectId: '2' }).map(e => e.historyId), ['t1', 't2', 'p1']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', taskKey: 'tpt1' }).map(e => e.historyId), ['t1']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', kind: 'project' }).map(e => e.historyId), ['p1']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', q: 'CODEX' }).map(e => e.historyId), ['t1']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', limit: '1' }).map(e => e.historyId), ['t1']);
  const row = publicHistoryRow({ ...entries[1], nativeSessionId: 'secret', cwd: '/x', storage: { codexHome: '/x/.codex' } }, '/x/file');
  assert.deepEqual(row, {
    historyId: 't1', kind: 'task', taskKey: 'TPT1', title: 'Fix login', provider: 'codex', model: 'gpt',
    createdAt: null, lastActivityAt: 30, endedAt: null, available: true,
    unavailableReason: null, keywords: [], excerpts: { first: '', latest: '' },
  });
});

test('historyAvailability names why an entry cannot resume: provider, checkout or missing', (t) => {
  const root = tempRoot(t);
  const cwd = path.join(root, 'checkout');
  fs.mkdirSync(cwd);
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const id = '2b7c1d3e-1111-4222-8333-444455556666';
  const file = writeFile(path.join(root, 'claude', 'projects', claudeProjectDirName(cwd), `${id}.jsonl`));
  const entry = entryFor('claude', id, cwd, env);
  assert.deepEqual(historyAvailability(entry, { cwd, env }), { available: true, reason: null, file });
  assert.equal(historyAvailability({ ...entry, provider: 'gemini' }, { cwd, env }).reason, 'provider');
  assert.equal(historyAvailability(entry, { cwd: path.join(root, 'other'), env }).reason, 'checkout');
  assert.equal(historyAvailability(entry, { cwd, env: { CLAUDE_CONFIG_DIR: path.join(root, 'x') } }).reason, 'checkout');
  fs.rmSync(file);
  assert.deepEqual(historyAvailability(entry, { cwd, env }), { available: false, reason: 'missing', file: null });
  const row = publicHistoryRow({ ...entry, kind: 'task', title: 'T' }, historyAvailability(entry, { cwd, env }));
  assert.equal(row.available, false);
  assert.equal(row.unavailableReason, 'missing');
  assert.equal(JSON.stringify(row).includes(id), false, 'the native id stays on the server');
});

test('cleanChatText drops widget blocks, the resume reminder, attachments and URLs; clipExcerpt bounds length', () => {
  const text = '```task_edits\n{"note":"x"}\n```\n\nLook at ![img](http://h/api/projects/2/images/7) and '
    + '[spec.pdf](http://h/api/projects/2/files/3) per [docs](https://example.com/a) ```js\nconst fooBar = 1;\n```'
    + `\n\n${ASK_USER_REMINDER}`;
  assert.equal(cleanChatText(text), 'Look at and per docs');
  assert.equal(cleanChatText(text, { keepCode: true }), 'Look at and per docs const fooBar = 1;');
  assert.equal(cleanChatText('Pick one\n```ask_user\n{"question":"q"}\n```'), 'Pick one');
  const clipped = clipExcerpt('word '.repeat(100));
  assert.ok(clipped.length <= EXCERPT_CHARS && clipped.endsWith('…'));
  assert.equal(clipExcerpt('short'), 'short');
});

test('extractKeywords keeps task keys and identifiers, drops en/uk stopwords and numbers, is bounded and folds prior terms', () => {
  const kw = extractKeywords([
    'The fix for TPT539 touches recordChatHistory in chat-history.js and snake_case_name; the the the and 2026 42',
    'Що це за пошук історії? Пошук має працювати і для задачі.',
  ]);
  for (const k of ['tpt539', 'recordchathistory', 'chat-history.js', 'snake_case_name', 'пошук', 'історії']) assert.ok(kw.includes(k), k);
  for (const k of ['the', 'and', 'for', 'що', 'це', 'для', '2026', '42']) assert.ok(!kw.includes(k), k);
  assert.equal(kw[0], 'tpt539', 'identifiers weigh more than plain words');
  assert.equal(new Set(kw).size, kw.length);
  const many = extractKeywords(Array.from({ length: 200 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}x${i}`).join(' '));
  assert.equal(many.length, KEYWORD_COUNT);
  const merged = extractKeywords(['fresh words only'], { prior: ['Pelican', 'fresh'] });
  assert.ok(merged.includes('pelican'), 'a resumed chat keeps its stored keywords');
  assert.equal(merged[0], 'fresh', 'a term in both the text and the prior ranks first');
});

test('buildSearchData skips the seed and resume marker, keeps the first excerpt of a resumed entry', () => {
  const messages = [
    { role: 'user', content: 'SEED_MARKER task json', seed: true },
    { role: 'assistant', content: 'Hello there' },
    { role: 'user', content: 'First question about flamingo' },
    { role: 'assistant', content: 'An answer' },
    { role: 'user', content: '', seed: true, resumed: true },
    { role: 'user', content: `Latest question\n\n${ASK_USER_REMINDER}` },
  ];
  const data = buildSearchData(messages);
  assert.deepEqual(data.excerpts, { first: 'First question about flamingo', latest: 'Latest question' });
  assert.ok(data.keywords.includes('flamingo'));
  assert.ok(!data.keywords.includes('seed_marker'));
  const resumed = buildSearchData(messages, { keywords: ['pelican'], first: 'Original opening', latest: 'old' });
  assert.equal(resumed.excerpts.first, 'Original opening');
  assert.equal(resumed.excerpts.latest, 'Latest question');
  assert.ok(resumed.keywords.includes('pelican'));
  assert.deepEqual(buildSearchData([], { keywords: [], first: '', latest: 'kept' }).excerpts, { first: '', latest: 'kept' });
});

test('filterHistory q matches keywords and excerpts too', () => {
  const entries = [
    { historyId: 'a', projectId: '2', kind: 'task', title: 'One', provider: 'claude', keywords: ['flamingo', 'chat-history.js'], lastActivityAt: 2 },
    { historyId: 'b', projectId: '2', kind: 'task', title: 'Two', provider: 'claude', excerpts: { first: 'Discuss the Pelican plan', latest: '' }, lastActivityAt: 1 },
  ];
  assert.deepEqual(filterHistory(entries, { projectId: '2', q: 'FLAMING' }).map(e => e.historyId), ['a']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', q: 'history.js' }).map(e => e.historyId), ['a']);
  assert.deepEqual(filterHistory(entries, { projectId: '2', q: 'pelican plan' }).map(e => e.historyId), ['b']);
});
