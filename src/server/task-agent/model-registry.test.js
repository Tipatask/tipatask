'use strict';

// (C1504) Pure-parser tests for model-registry.js — no I/O, no CLI spawns. Fixture text is
// modeled on the ACTUAL installed Claude CLI binary (2.1.263) and a real `codex debug models`
// response, both captured live during development (see tt-task-agent.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseClaudeModelTable,
  buildClaudeModelList,
  parseCodexCatalog,
  fallbackModels,
  versionTuple,
  compareVersions,
  CLAUDE_ALIASES,
} = require('./model-registry');

// A slice of real records as they appear (minified, comma-joined) in the installed binary,
// including a `mythos` row that must be dropped, and TWO opus versions (isLatest goes to the
// newer one only).
const CLAUDE_FIXTURE = [
  'id:"claude-3-5-haiku",family:"haiku",display_name:"Haiku 3.5"',
  'id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5"',
  'id:"claude-opus-4-8",family:"opus",display_name:"Opus 4.8",knowledge_cutoff:"January 2026"',
  'id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026"',
  'id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6"',
  'id:"claude-fable-5-1",family:"fable",display_name:"Fable 5.1"',
  'id:"claude-mythos-5",family:"mythos",display_name:"Mythos 5",knowledge_cutoff:"January 2026"',
].join(',');

test('parseClaudeModelTable: drops non-public families (mythos), keeps public ones', () => {
  const rows = parseClaudeModelTable(CLAUDE_FIXTURE);
  assert.ok(!rows.some(r => r.id.includes('mythos')), 'mythos must be filtered out');
  assert.strictEqual(rows.length, 6, 'the 6 public-family rows survive, the 1 mythos row does not');
  assert.ok(rows.some(r => r.id === 'claude-opus-5'));
});

test('parseClaudeModelTable: isLatest only on the newest id within a family', () => {
  const rows = parseClaudeModelTable(CLAUDE_FIXTURE);
  const opusRows = rows.filter(r => r.id === 'claude-opus-4-8' || r.id === 'claude-opus-5');
  assert.strictEqual(opusRows.length, 2);
  const latest = opusRows.find(r => r.id === 'claude-opus-5');
  const older = opusRows.find(r => r.id === 'claude-opus-4-8');
  assert.strictEqual(latest.isLatest, true, 'Opus 5 is newer than Opus 4.8');
  assert.strictEqual(older.isLatest, false);
});

test('parseClaudeModelTable: sorted newest-first within a family', () => {
  const rows = parseClaudeModelTable(CLAUDE_FIXTURE);
  const opusIds = rows.filter(r => r.id.startsWith('claude-opus')).map(r => r.id);
  assert.deepStrictEqual(opusIds, ['claude-opus-5', 'claude-opus-4-8']);
});

test('parseClaudeModelTable: de-dupes a record matched twice (chunk-boundary rescan)', () => {
  const doubled = CLAUDE_FIXTURE + ',' + CLAUDE_FIXTURE.split(',').slice(0, 3).join(',');
  const rows = parseClaudeModelTable(doubled);
  const ids = rows.map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('parseClaudeModelTable: empty/garbage input returns []', () => {
  assert.deepStrictEqual(parseClaudeModelTable(''), []);
  assert.deepStrictEqual(parseClaudeModelTable('not a model table at all'), []);
  assert.deepStrictEqual(parseClaudeModelTable(undefined), []);
});

test('buildClaudeModelList: aliases always present and isLatest, even with no scan text', () => {
  const list = buildClaudeModelList('');
  assert.deepStrictEqual(list, CLAUDE_ALIASES);
  assert.ok(list.every(m => m.isLatest));
  assert.ok(list.some(m => m.id === 'opusplan'), 'opusplan alias must always be present');
});

test('buildClaudeModelList: aliases precede scanned rows', () => {
  const list = buildClaudeModelList(CLAUDE_FIXTURE);
  assert.strictEqual(list[0].id, 'opusplan');
  assert.ok(list.length > CLAUDE_ALIASES.length);
});

test('versionTuple/compareVersions: multi-part versions compare correctly', () => {
  assert.deepStrictEqual(versionTuple('Opus 4.8'), [4, 8]);
  assert.deepStrictEqual(versionTuple('Opus 5'), [5]);
  assert.deepStrictEqual(versionTuple('Fable 5.1'), [5, 1]);
  assert.ok(compareVersions([5], [4, 8]) > 0, '5 > 4.8');
  assert.ok(compareVersions([4, 8], [4, 10]) < 0, '4.8 < 4.10');
  assert.strictEqual(compareVersions([5], [5]), 0);
});

// Real `codex debug models` shape (trimmed to the fields parseCodexCatalog reads).
const CODEX_FIXTURE = {
  models: [
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 6 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 7 },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 8 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
  ],
};

test('parseCodexCatalog: filters hidden models, sorts by priority, flags top as isLatest', () => {
  const models = parseCodexCatalog(CODEX_FIXTURE);
  assert.deepStrictEqual(models.map(m => m.id), ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']);
  assert.strictEqual(models[0].isLatest, true);
  assert.ok(models.slice(1).every(m => !m.isLatest));
  assert.strictEqual(models[0].label, 'GPT-5.6-Sol');
});

test('parseCodexCatalog: malformed input returns [] instead of throwing', () => {
  assert.deepStrictEqual(parseCodexCatalog(null), []);
  assert.deepStrictEqual(parseCodexCatalog({}), []);
  assert.deepStrictEqual(parseCodexCatalog({ models: 'not-an-array' }), []);
  assert.deepStrictEqual(parseCodexCatalog({ models: [{ slug: '', visibility: 'list' }] }), []);
});

test('fallbackModels: ids from config, label=id, first entry isLatest', () => {
  const config = { CLAUDE_MODELS: ['opusplan', 'claude-opus-5'], CODEX_MODELS: ['gpt-5.6-sol', 'gpt-5.5'] };
  const claude = fallbackModels('claude', config);
  assert.deepStrictEqual(claude, [
    { id: 'opusplan', label: 'opusplan', isLatest: true },
    { id: 'claude-opus-5', label: 'claude-opus-5', isLatest: false },
  ]);
  const codex = fallbackModels('codex', config);
  assert.strictEqual(codex[0].id, 'gpt-5.6-sol');
  assert.strictEqual(codex[0].isLatest, true);
  assert.deepStrictEqual(fallbackModels('pi', config), []);
});
