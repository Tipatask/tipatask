'use strict';

// (TPT9168) validateProjectArchive() / importProjectArchive(): an archive written by
// buildProjectArchive() validates, then imports into a stub backend with every task on a new
// key and its dependencies remapped. Hand-built zips cover every validation code, path
// traversal included, and files already in the project survive unless overwrite is set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, ARCHIVE_ERROR_CODES, ProjectArchiveError,
  buildProjectArchive, validateProjectArchive, importProjectArchive,
} = require('./project-archive');

const ROLE_FLAGS = ['is_workflow_start', 'is_in_progress', 'is_workflow_complete', 'is_workflow_canceled'];

// ── Source project (exported with the real buildProjectArchive()) ──

const SOURCE_STATUSES = [
  { id: 1, name: 'backlog', color: 'overlay1', display_order: 0, is_workflow_start: 1, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 0 },
  { id: 2, name: 'doing', color: 'blue', display_order: 1, is_workflow_start: 0, is_in_progress: 1, is_workflow_complete: 0, is_workflow_canceled: 0 },
  { id: 3, name: 'review', color: 'yellow', display_order: 2, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 0 },
  { id: 4, name: 'done', color: 'green', display_order: 3, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 1, is_workflow_canceled: 0 },
  { id: 5, name: 'dropped', color: 'overlay0', display_order: 4, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 1 },
];

// Archive order puts SRC4 before the task it depends on (SRC3) and SRC3 before its parent
// (SRC5), so creating in archive order would reference keys that do not exist yet.
const SOURCE_TASKS = [
  { id: 'SRC4', dbId: 4, parentDbId: null, title: 'Ship it', description: 'four', category: 'CODING', status: 'backlog', priority: 4, order: 0, dependencies: ['SRC3'], tags: ['legacy'] },
  { id: 'SRC1', dbId: 1, parentDbId: null, title: 'Design schema', description: 'one', category: 'CODING', status: 'backlog', priority: 2, order: 1, dependencies: [], tags: ['tt-alpha', 'feature'], agentAssignee: 'codex', effort: 'high', agentPermissionMode: 'auto' },
  { id: 'SRC2', dbId: 2, parentDbId: null, title: 'Closed prerequisite', description: '', category: 'CODING', status: 'done', priority: 1, order: 0, dependencies: [], tags: [] },
  { id: 'SRC3', dbId: 3, parentDbId: 5, title: 'Build API', description: 'three', category: 'CODING', status: 'doing', priority: 3, order: 1, dependencies: ['SRC1', 'SRC2'], tags: ['feature'], claudeModel: 'opus' },
  { id: 'SRC5', dbId: 5, parentDbId: null, title: 'Objective', description: '', category: 'CODING', status: 'review', priority: 3, order: 0, dependencies: [], tags: ['unregistered'], isObjective: true },
  { id: 'SRC6', dbId: 6, parentDbId: null, title: 'Backlog note', description: '', category: 'HUMAN', status: 'backlog', priority: 0, order: 0, dependencies: ['SRC9'], tags: [], due_date: '2026-12-01' },
];

const SOURCE_SPRINTS = [
  { id: 1, number: 1, name: 'Sprint 1', status: 'closed', goal: null, start_date: null, end_date: null },
  { id: 2, number: 2, name: 'Sprint 2', status: 'active', goal: null, start_date: null, end_date: null },
  { id: 3, number: 3, name: 'Sprint 3', status: 'active', goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13' },
  { id: 4, number: 4, name: 'Launch', status: 'active', goal: null, start_date: null, end_date: null },
];

const SOURCE_TAGS = [
  { name: 'tt-alpha', description: 'Alpha module', knowledgeFileKey: 'ai/architecture/tt-alpha.md' },
  { name: 'feature', description: 'New behaviour', knowledgeFileKey: null },
  { name: 'legacy', description: 'Auto-registered by createTask', knowledgeFileKey: null },
];

const SOURCE_KB = {
  'CLAUDE.md': '# Claude',
  'AGENTS.md': '# Agents',
  'ai/CONVENTIONS.md': '# Conventions',
  'ai/architecture/GENERAL.md': '# General',
  'ai/architecture/tt-alpha.md': '# Alpha — альфа',
};

function scratchDir(t, prefix = 'tpt-import-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function zipFile(t, buffer) {
  const file = path.join(scratchDir(t, 'tpt-import-zip-'), 'archive.zip');
  fs.writeFileSync(file, buffer);
  return file;
}

// The source project's archive, as Project ▸ Export writes it.
async function exportedArchive(t) {
  const sourceRoot = scratchDir(t, 'tpt-import-source-');
  writeTree(sourceRoot, SOURCE_KB);
  const sourceBackend = {
    async getTasksUnfiltered() { return SOURCE_TASKS; },
    async getStatuses() { return SOURCE_STATUSES; },
    async getSprints() { return SOURCE_SPRINTS; },
    async getTagsDetailed() { return SOURCE_TAGS; },
    async getProjectSettings() { return { name: 'Source Project', language: 'en', task_prefix: 'SRC' }; },
  };
  const { buffer } = await buildProjectArchive(sourceRoot, sourceBackend, { appVersion: '1.2.3' });
  return zipFile(t, buffer);
}

// Hand-built zip: stored entries, UTF-8 names, any CRC — for names and contents yazl refuses
// to write.
function rawZip(entries) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const extra = entry.extra || Buffer.alloc(0);
    const crc = entry.crc ?? zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    const record = Buffer.concat([local, name, extra, data]);
    records.push(record);
    directory.push(Buffer.concat([central, name, extra]));
    offset += record.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
}

// Info-ZIP Unicode Path extra field (0x7075): unzip tools — yauzl included — take the entry's
// name from it whenever its CRC matches the plain name.
function unicodePathField(plainName, realName) {
  const unicode = Buffer.from(realName, 'utf8');
  const field = Buffer.alloc(9 + unicode.length);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + unicode.length, 2);
  field.writeUInt8(1, 4);
  field.writeUInt32LE(zlib.crc32(Buffer.from(plainName, 'utf8')), 5);
  unicode.copy(field, 9);
  return field;
}

const MANIFEST = { format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, projectName: 'Hand made', language: 'en' };
const MINIMAL_TASKS = { formatVersion: ARCHIVE_FORMAT_VERSION, tasks: [], sprints: [], tags: [], statuses: [] };

function handArchive(t, extraEntries = [], { manifest = MANIFEST, tasks = MINIMAL_TASKS } = {}) {
  return zipFile(t, rawZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'tasks.json', data: JSON.stringify(tasks) },
    ...extraEntries,
  ]));
}

// ── Target project: an in-memory stand-in for an api-backend.js instance ──

// What a newly created API project starts with (api/src/lib/task-statuses.js).
const NEW_PROJECT_STATUSES = [
  { name: 'pending', color: 'overlay1', is_workflow_start: true },
  { name: 'in_progress', color: 'blue', is_in_progress: true },
  { name: 'on_fire', color: 'red' },
  { name: 'completed', color: 'green', is_workflow_complete: true },
  { name: 'canceled', color: 'overlay0', is_workflow_canceled: true },
];

// Applies the API rules the importer depends on — role hand-off, keyless creates, statuses
// and tags that must exist — and, to prove the dependency order, refuses a dependency or
// parent that names a task not created yet.
function stubBackend({ failOnCreate = 0 } = {}) {
  const calls = [];
  const statuses = NEW_PROJECT_STATUSES.map((s, i) => ({
    id: i + 1, name: s.name, color: s.color, display_order: i,
    ...Object.fromEntries(ROLE_FLAGS.map((flag) => [flag, !!s[flag]])),
  }));
  const tags = new Map();
  const sprints = [];
  const tasks = new Map();
  let nextStatusId = 10;
  const sorted = () => [...statuses].sort((a, b) => a.display_order - b.display_order).map((s) => ({ ...s }));
  const takeRole = (row, fields) => {
    for (const flag of ROLE_FLAGS) {
      if (fields[flag] !== true) continue;
      for (const s of statuses) s[flag] = false;
      for (const other of ROLE_FLAGS) row[other] = false;
      row[flag] = true;
    }
  };
  return {
    calls, statuses, tags, sprints, tasks,
    async getStatuses(opts) { calls.push(['getStatuses', opts]); return sorted(); },
    async createStatus(fields) {
      calls.push(['createStatus', fields]);
      const row = { id: nextStatusId++, name: fields.name, color: fields.color ?? null, display_order: statuses.length, ...Object.fromEntries(ROLE_FLAGS.map((flag) => [flag, false])) };
      takeRole(row, fields);
      statuses.push(row);
      return { ...row };
    },
    async updateStatus(id, fields) {
      calls.push(['updateStatus', id, fields]);
      const row = statuses.find((s) => s.id === id);
      if (fields.name !== undefined) row.name = fields.name;
      if (fields.color !== undefined) row.color = fields.color;
      takeRole(row, fields);
      return { ...row };
    },
    async reorderStatuses(ids) {
      calls.push(['reorderStatuses', ids]);
      assert.deepEqual([...ids].sort((a, b) => a - b), statuses.map((s) => s.id).sort((a, b) => a - b), 'reorder names every status once');
      ids.forEach((id, i) => { statuses.find((s) => s.id === id).display_order = i; });
      return sorted();
    },
    async ensureTag(name, description) { calls.push(['ensureTag', name, description]); tags.set(name, description); },
    async getTags() { return [...tags.keys()]; },
    async createSprint(name, number, extra) {
      calls.push(['createSprint', name, number, extra]);
      if (sprints.some((s) => s.number === number)) return null;
      sprints.push({ name, number, ...extra });
      return { name, number, ...extra };
    },
    async createTask(task, opts) {
      calls.push(['createTask', task, opts]);
      if (failOnCreate === tasks.size + 1) {
        const err = new Error('API unreachable at http://127.0.0.1:9');
        err.networkError = true;
        throw err;
      }
      assert.equal(task.id, undefined, 'creates are keyless');
      assert.ok(statuses.some((s) => s.name === task.status), `status ${task.status} exists`);
      for (const tag of task.tags) assert.ok(tags.has(tag), `tag ${tag} is registered`);
      for (const dep of task.dependencies) assert.ok(tasks.has(dep), `dependency ${dep} exists before "${task.title}"`);
      if (task.parentId) assert.ok(tasks.has(task.parentId), `parent ${task.parentId} exists before "${task.title}"`);
      const row = { ...task, id: `NEW${tasks.size + 1}` };
      tasks.set(row.id, row);
      return { ...row };
    },
    async updateTask(id, fields, opts) {
      calls.push(['updateTask', id, fields, opts]);
      Object.assign(tasks.get(id), fields);
      return { ...tasks.get(id) };
    },
  };
}

function callsOf(backend, name) {
  return backend.calls.filter((call) => call[0] === name).map((call) => call.slice(1));
}

// ── validateProjectArchive ──

test('validateProjectArchive accepts an exported archive and summarizes it', async (t) => {
  const zipPath = await exportedArchive(t);
  const result = await validateProjectArchive(zipPath);
  assert.deepEqual(result, {
    ok: true,
    summary: {
      projectName: 'Source Project',
      language: 'en',
      taskPrefix: 'SRC',
      exportedAt: result.summary.exportedAt,
      appVersion: '1.2.3',
      formatVersion: ARCHIVE_FORMAT_VERSION,
      kbFileCount: 5,
      taskCount: 5,
      sprintCount: 3,
      tagCount: 4,
      statusCount: 5,
      kbFiles: ['CLAUDE.md', 'AGENTS.md', 'ai/CONVENTIONS.md', 'ai/architecture/GENERAL.md', 'ai/architecture/tt-alpha.md'],
    },
  });
  assert.match(result.summary.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('validateProjectArchive reports missing_manifest when manifest.json is absent', async (t) => {
  const withoutManifest = zipFile(t, rawZip([
    { name: 'tasks.json', data: JSON.stringify(MINIMAL_TASKS) },
    { name: 'kb/CLAUDE.md', data: '# Claude' },
  ]));
  assert.deepEqual(await validateProjectArchive(withoutManifest), { ok: false, code: 'missing_manifest', detail: null });
  const empty = zipFile(t, rawZip([]));
  assert.equal((await validateProjectArchive(empty)).code, 'missing_manifest');
});

test('validateProjectArchive rejects every entry name that escapes the archive folder', async (t) => {
  const names = [
    '../evil.md',
    'kb/../../evil.md',
    'kb/ai/../../../evil.md',
    '/etc/evil.md',
    'kb\\..\\..\\evil.md',
    'C:/Windows/evil.md',
    'kb/ai/architecture/tt-x.md:stream',
  ];
  for (const name of names) {
    const zipPath = handArchive(t, [{ name, data: 'PWNED' }]);
    const result = await validateProjectArchive(zipPath);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, 'unsafe_path', name);
  }
  // A harmless plain name whose Unicode Path field (the name unzip tools actually use) climbs out.
  const disguised = handArchive(t, [
    { name: 'kb/CLAUDE.md', data: 'PWNED', extra: unicodePathField('kb/CLAUDE.md', '../../evil.md') },
  ]);
  assert.deepEqual(await validateProjectArchive(disguised), { ok: false, code: 'unsafe_path', detail: '../../evil.md' });
});

test('validateProjectArchive maps each kind of bad archive to its own code', async (t) => {
  const dir = scratchDir(t);
  const notZip = path.join(dir, 'notes.zip');
  fs.writeFileSync(notZip, 'just text, no zip records');
  const valid = await exportedArchive(t);
  const tasksWith = (patch) => ({ ...MINIMAL_TASKS, ...patch });
  const cases = [
    ['unreadable', path.join(dir, 'missing.zip')],
    ['unreadable', dir],
    ['not_zip', notZip],
    ['too_large', valid, { limits: { kbFileBytes: 4 } }],
    ['too_large', valid, { limits: { archiveBytes: 100 } }],
    ['too_large', valid, { limits: { entries: 3 } }],
    ['unsafe_path', handArchive(t, [{ name: 'kb/../x.md', data: 'x' }])],
    ['unexpected_entry', handArchive(t, [{ name: 'kb/.claude/settings.json', data: '{}' }])],
    ['unexpected_entry', handArchive(t, [{ name: 'kb/.git/hooks/pre-commit', data: '#!/bin/sh' }])],
    ['unexpected_entry', handArchive(t, [{ name: 'notes.txt', data: 'x' }])],
    ['duplicate_entry', handArchive(t, [{ name: 'kb/ai/architecture/tt-a.md', data: 'a' }, { name: 'kb/ai/architecture/TT-A.md', data: 'b' }])],
    ['corrupt', handArchive(t, [{ name: 'kb/CLAUDE.md', data: '# Claude', crc: 12345 }])],
    ['missing_manifest', zipFile(t, rawZip([{ name: 'tasks.json', data: JSON.stringify(MINIMAL_TASKS) }]))],
    ['invalid_manifest', handArchive(t, [], { manifest: { ...MANIFEST, format: 'something-else' } })],
    ['invalid_manifest', zipFile(t, rawZip([{ name: 'manifest.json', data: '{ not json' }]))],
    ['unsupported_version', handArchive(t, [], { manifest: { ...MANIFEST, formatVersion: ARCHIVE_FORMAT_VERSION + 1 } })],
    ['missing_tasks', zipFile(t, rawZip([{ name: 'manifest.json', data: JSON.stringify(MANIFEST) }]))],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ tasks: [{ id: 'A1', title: '' }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ tasks: [{ id: 'A1', title: 'a' }, { id: 'A1', title: 'b' }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ tasks: [{ id: 'A1', title: 'a', dependencies: 'A2' }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ statuses: [{ name: 'x', is_workflow_start: true, is_workflow_complete: true }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ statuses: [{ name: 'a', is_workflow_start: true }, { name: 'b', is_workflow_start: true }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: tasksWith({ sprints: [{ number: 2, name: 'S', start_date: '2026-11-05', end_date: '2026-11-01' }] }) })],
    ['invalid_tasks', handArchive(t, [], { tasks: { formatVersion: ARCHIVE_FORMAT_VERSION } })],
  ];
  const seen = new Set();
  for (const [code, zipPath, opts] of cases) {
    const result = await validateProjectArchive(zipPath, opts);
    assert.equal(result.ok, false, `${code}: ${zipPath}`);
    assert.equal(result.code, code, `${code}: ${zipPath} (${result.detail})`);
    seen.add(result.code);
  }
  assert.deepEqual([...seen].sort(), [...ARCHIVE_ERROR_CODES].sort(), 'every documented code is reachable');
});

test('validateProjectArchive ignores folder entries and macOS Archive Utility metadata', async (t) => {
  const zipPath = handArchive(t, [
    { name: 'kb/', data: '' },
    { name: 'kb/ai/architecture/', data: '' },
    { name: 'kb/ai/architecture/tt-a.md', data: '# A' },
    { name: '__MACOSX/kb/._CLAUDE.md', data: 'resource fork' },
    { name: 'kb/.DS_Store', data: 'finder' },
  ]);
  const result = await validateProjectArchive(zipPath);
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.summary.kbFiles, ['ai/architecture/tt-a.md']);
});

// ── importProjectArchive ──

test('importProjectArchive rebuilds the archive with new keys, remapped dependencies and kept sprints', async (t) => {
  const zipPath = await exportedArchive(t);
  const projectRoot = scratchDir(t);
  const backend = stubBackend();
  const progress = [];
  const result = await importProjectArchive(zipPath, { projectRoot, backend, onProgress: (p) => progress.push(p) });

  // Created in dependency order: SRC1 and the parent SRC5 before SRC3, SRC3 before SRC4.
  assert.deepEqual(result.tasks, {
    created: 5,
    keyMap: { SRC1: 'NEW1', SRC5: 'NEW2', SRC3: 'NEW3', SRC4: 'NEW4', SRC6: 'NEW5' },
  });
  const created = Object.fromEntries([...backend.tasks.values()].map((task) => [task.title, task]));
  assert.deepEqual(created['Build API'].dependencies, ['NEW1'], 'SRC1 -> NEW1; the closed SRC2 is dropped');
  assert.equal(created['Build API'].parentId, 'NEW2', 'the parent is remapped too');
  assert.deepEqual(created['Ship it'].dependencies, ['NEW3']);
  assert.deepEqual(created['Backlog note'].dependencies, [], 'a key the archive never had is dropped');
  assert.deepEqual(result.dropped, { dependencies: 2, parents: 0, tags: 2 });
  for (const call of callsOf(backend, 'createTask')) assert.deepEqual(call[1], { queueOffline: false });
  assert.equal(callsOf(backend, 'updateTask').length, 0, 'no cycle, so nothing is patched afterwards');

  // Each task keeps its sprint, status and settings.
  assert.deepEqual(
    Object.values(created).map((task) => [task.title, task.priority, task.status]),
    [['Design schema', 2, 'backlog'], ['Objective', 3, 'review'], ['Build API', 3, 'doing'], ['Ship it', 4, 'backlog'], ['Backlog note', 0, 'backlog']],
  );
  assert.equal(created['Design schema'].agentAssignee, 'codex');
  assert.equal(created['Design schema'].effort, 'high');
  assert.equal(created['Design schema'].agentPermissionMode, 'auto');
  assert.equal(created['Design schema'].order, 1);
  assert.equal(created['Build API'].claudeModel, 'opus');
  assert.equal(created.Objective.isObjective, true);
  assert.equal(created['Backlog note'].category, 'HUMAN');
  assert.equal(created['Backlog note'].due_date, '2026-12-01');

  // Sprints in their original order, with goal and dates.
  assert.deepEqual(callsOf(backend, 'createSprint'), [
    ['Sprint 2', 2, {}],
    ['Sprint 3', 3, { goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13' }],
    ['Launch', 4, {}],
  ]);
  assert.deepEqual(result.sprints, { created: [2, 3, 4], existing: [] });

  // Tags with their exported descriptions; a missing or placeholder description is not sent,
  // and the tag is dropped from its task.
  assert.deepEqual(callsOf(backend, 'ensureTag'), [['feature', 'New behaviour'], ['tt-alpha', 'Alpha module']]);
  assert.deepEqual(result.tags, { registered: ['feature', 'tt-alpha'], skipped: ['legacy', 'unregistered'] });
  assert.deepEqual(created['Design schema'].tags, ['tt-alpha', 'feature']);
  assert.deepEqual(created['Ship it'].tags, []);
  assert.deepEqual(created.Objective.tags, []);

  // The new project's defaults take the exported workflow: role holders renamed, the custom
  // status created, the order restored, on_fire kept at the end.
  assert.deepEqual(result.statuses, { created: ['review'], updated: ['backlog', 'doing', 'done', 'dropped'] });
  const finalStatuses = [...backend.statuses].sort((a, b) => a.display_order - b.display_order);
  assert.deepEqual(
    finalStatuses.map((s) => [s.name, ROLE_FLAGS.find((flag) => s[flag]) || null, s.color]),
    [
      ['backlog', 'is_workflow_start', 'overlay1'],
      ['doing', 'is_in_progress', 'blue'],
      ['review', null, 'yellow'],
      ['done', 'is_workflow_complete', 'green'],
      ['dropped', 'is_workflow_canceled', 'overlay0'],
      ['on_fire', null, 'red'],
    ],
  );
  assert.ok(callsOf(backend, 'getStatuses').every(([opts]) => opts && opts.strict === true), 'statuses are read strictly');

  // KB files land byte for byte.
  assert.deepEqual(result.kb, { written: Object.keys(SOURCE_KB), skipped: [] });
  for (const [key, text] of Object.entries(SOURCE_KB)) {
    assert.equal(fs.readFileSync(path.join(projectRoot, ...key.split('/')), 'utf8'), text, key);
  }

  assert.equal(result.ok, true);
  assert.equal(result.projectName, 'Source Project');
  assert.deepEqual([...new Set(progress.map((p) => p.step))], ['kb', 'statuses', 'tags', 'sprints', 'tasks']);
  assert.deepEqual(progress.at(-1), { step: 'tasks', done: 5, total: 5 });
});

test('importProjectArchive never overwrites an existing project file without the overwrite flag', async (t) => {
  const zipPath = await exportedArchive(t);
  const mine = { 'CLAUDE.md': 'my own instructions', 'ai/architecture/tt-alpha.md': 'my alpha notes' };

  const keepRoot = scratchDir(t);
  writeTree(keepRoot, mine);
  const kept = await importProjectArchive(zipPath, { projectRoot: keepRoot, backend: stubBackend() });
  assert.deepEqual(kept.kb, {
    written: ['AGENTS.md', 'ai/CONVENTIONS.md', 'ai/architecture/GENERAL.md'],
    skipped: ['CLAUDE.md', 'ai/architecture/tt-alpha.md'],
  });
  for (const [key, text] of Object.entries(mine)) {
    assert.equal(fs.readFileSync(path.join(keepRoot, ...key.split('/')), 'utf8'), text, `${key} is untouched`);
  }
  assert.equal(fs.readFileSync(path.join(keepRoot, 'AGENTS.md'), 'utf8'), '# Agents');

  const replaceRoot = scratchDir(t);
  writeTree(replaceRoot, mine);
  fs.mkdirSync(path.join(replaceRoot, 'AGENTS.md'));
  const replaced = await importProjectArchive(zipPath, { projectRoot: replaceRoot, backend: stubBackend(), overwrite: true });
  assert.deepEqual(replaced.kb.skipped, ['AGENTS.md'], 'a folder in the way is never replaced');
  assert.equal(fs.readFileSync(path.join(replaceRoot, 'CLAUDE.md'), 'utf8'), '# Claude');
  assert.equal(fs.readFileSync(path.join(replaceRoot, 'ai', 'architecture', 'tt-alpha.md'), 'utf8'), '# Alpha — альфа');
  assert.deepEqual(fs.readdirSync(replaceRoot).filter((name) => name.endsWith('.tmp')), []);
});

test('importProjectArchive never writes through a symlink that leads out of the project', async (t) => {
  const zipPath = await exportedArchive(t);
  const projectRoot = scratchDir(t);
  const outside = scratchDir(t, 'tpt-import-outside-');
  fs.symlinkSync(outside, path.join(projectRoot, 'ai'));
  fs.symlinkSync(path.join(outside, 'agents.md'), path.join(projectRoot, 'AGENTS.md'));

  const result = await importProjectArchive(zipPath, { projectRoot, backend: stubBackend(), overwrite: true });
  assert.deepEqual(result.kb.skipped, ['ai/CONVENTIONS.md', 'ai/architecture/GENERAL.md', 'ai/architecture/tt-alpha.md']);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the project');
  assert.ok(!fs.lstatSync(path.join(projectRoot, 'AGENTS.md')).isSymbolicLink(), 'the dangling link was replaced, not followed');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8'), '# Agents');
});

test('importProjectArchive patches dependency and parent cycles in once every task exists', async (t) => {
  const zipPath = handArchive(t, [], {
    tasks: {
      ...MINIMAL_TASKS,
      tasks: [
        { id: 'A', title: 'A', dependencies: ['B'] },
        { id: 'B', title: 'B', dependencies: ['A'] },
        { id: 'P', title: 'P', dependencies: ['K'] },
        { id: 'K', title: 'K', parentId: 'P' },
      ],
    },
  });
  const backend = stubBackend();
  const result = await importProjectArchive(zipPath, { projectRoot: scratchDir(t), backend });
  assert.deepEqual(result.tasks.keyMap, { B: 'NEW1', A: 'NEW2', K: 'NEW3', P: 'NEW4' });
  assert.deepEqual(callsOf(backend, 'updateTask'), [
    ['NEW1', { dependencies: ['NEW2'] }, { queueOffline: false }],
    ['NEW3', { parentId: 'NEW4' }, { queueOffline: false }],
  ]);
  assert.deepEqual(backend.tasks.get('NEW2').dependencies, ['NEW1']);
  assert.deepEqual(backend.tasks.get('NEW4').dependencies, ['NEW3']);
  assert.equal(backend.tasks.get('NEW2').status, 'pending', 'no status in the archive: the workflow-start status');
});

test('importProjectArchive writes nothing for an invalid archive', async (t) => {
  const zipPath = handArchive(t, [{ name: 'kb/../../evil.md', data: 'PWNED' }]);
  const projectRoot = scratchDir(t);
  const backend = stubBackend();
  await assert.rejects(importProjectArchive(zipPath, { projectRoot, backend }), (err) => {
    assert.ok(err instanceof ProjectArchiveError);
    assert.equal(err.code, 'unsafe_path');
    return true;
  });
  assert.deepEqual(fs.readdirSync(projectRoot), []);
  assert.deepEqual(backend.calls, []);
});

test('importProjectArchive reports the failed step and the progress so far', async (t) => {
  const zipPath = await exportedArchive(t);
  const backend = stubBackend({ failOnCreate: 2 });
  await assert.rejects(importProjectArchive(zipPath, { projectRoot: scratchDir(t), backend }), (err) => {
    assert.equal(err.networkError, true, 'the original error is rethrown');
    assert.equal(err.importStep, 'tasks');
    assert.equal(err.imported.tasks.created, 1);
    assert.deepEqual(err.imported.tasks.keyMap, { SRC1: 'NEW1' });
    assert.deepEqual(err.imported.sprints.created, [2, 3, 4]);
    return true;
  });
});
