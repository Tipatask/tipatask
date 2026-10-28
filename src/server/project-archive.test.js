'use strict';

// (TPT9167) buildProjectArchive() / selectArchiveTasks(): closed tasks stay out, dependency
// keys survive verbatim, and the zip itself is well formed (read back with a minimal
// central-directory reader — the app ships a zip writer only).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, buildProjectArchive, selectArchiveTasks,
  collectKbFiles, archiveFileName,
} = require('./project-archive');

// Custom status names on purpose: closed-ness comes from the complete/canceled roles, never
// from the literal names 'completed'/'canceled'.
const STATUSES = [
  { id: 11, name: 'done', color: 'green', display_order: 3, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 1, is_workflow_canceled: 0, task_count: 4 },
  { id: 10, name: 'todo', color: 'overlay1', display_order: 0, is_workflow_start: 1, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 0, task_count: 2 },
  { id: 12, name: 'doing', color: 'blue', display_order: 1, is_workflow_start: 0, is_in_progress: 1, is_workflow_complete: 0, is_workflow_canceled: 0, task_count: 1 },
  { id: 13, name: 'blocked', color: 'red', display_order: 2, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 0, task_count: 1 },
  { id: 14, name: 'dropped', color: 'overlay0', display_order: 4, is_workflow_start: 0, is_in_progress: 0, is_workflow_complete: 0, is_workflow_canceled: 1, task_count: 1 },
];

const ACCOUNT_FIELDS = { assignee: 7, createdBy: 7, totalInputTokens: 900, totalCostUsd: 1.25, activeDevice: 'laptop', projectId: 3 };

const TASKS = [
  { id: 'DMP1', dbId: 101, parentDbId: null, title: 'First', description: 'one', category: 'CODING', status: 'todo', priority: 2, order: 0, dependencies: [], tags: ['tt-alpha', 'feature'], agentAssignee: 'codex', effort: 'high', ...ACCOUNT_FIELDS },
  { id: 'DMP2', dbId: 102, parentDbId: null, title: 'Closed', description: '', category: 'CODING', status: 'done', priority: 1, order: 0, dependencies: [], tags: ['closed-only'], ...ACCOUNT_FIELDS },
  { id: 'DMP3', dbId: 103, parentDbId: 105, title: 'Third', description: 'three', category: 'CODING', status: 'doing', priority: 3, order: 1, dependencies: ['DMP2', 'DMP1'], tags: ['feature'], ...ACCOUNT_FIELDS },
  { id: 'DMP4', dbId: 104, parentDbId: null, title: 'Dropped', description: '', category: 'HUMAN', status: 'dropped', priority: 4, order: 0, dependencies: ['DMP1'], tags: [], ...ACCOUNT_FIELDS },
  { id: 'DMP5', dbId: 105, parentDbId: null, title: 'Objective', description: '', category: 'CODING', status: 'blocked', priority: 3, order: 0, dependencies: [], tags: ['unregistered'], isObjective: true, ...ACCOUNT_FIELDS },
  { id: 'DMP6', dbId: 106, parentDbId: null, title: '', description: '', category: 'CODING', status: 'todo', priority: 2, order: 2, dependencies: [], tags: [], isReservation: true, ...ACCOUNT_FIELDS },
  { id: 'DMP7', dbId: 107, parentDbId: 102, title: 'Backlog child', description: '', category: 'HUMAN', status: 'todo', priority: 0, order: 0, dependencies: ['DMP4'], tags: [], due_date: '2026-11-01', ...ACCOUNT_FIELDS },
];

const SPRINTS = [
  { id: 1, project_id: 3, number: 3, name: 'Sprint 3', status: 'active', goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13', task_count: 2, created_at: '2026-10-01' },
  { id: 2, project_id: 3, number: 1, name: 'Sprint 1', status: 'closed', goal: null, start_date: null, end_date: null, task_count: 1 },
  { id: 3, project_id: 3, number: 2, name: 'Sprint 2', status: 'active', goal: null, start_date: null, end_date: null, task_count: 2 },
  { id: 4, project_id: 3, number: 9, name: 'Sprint 9', status: 'active', goal: null, start_date: null, end_date: null, task_count: 0 },
];

const TAGS = [
  { name: 'tt-alpha', description: 'Alpha module', knowledgeFileKey: 'ai/architecture/tt-alpha.md' },
  { name: 'feature', description: 'New behaviour', knowledgeFileKey: null },
  { name: 'closed-only', description: 'Only on closed tasks', knowledgeFileKey: null },
  { name: 'unused', description: 'On no task', knowledgeFileKey: null },
];

function fakeBackend(overrides = {}) {
  const calls = { statusOpts: [] };
  const backend = {
    calls,
    async getTasksUnfiltered() { return TASKS; },
    async getStatuses(opts) { calls.statusOpts.push(opts); return STATUSES; },
    async getSprints() { return SPRINTS; },
    async getTagsDetailed() { return TAGS; },
    async getProjectSettings() { return { name: 'Демо проєкт', language: 'uk', task_prefix: 'DMP' }; },
    ...overrides,
  };
  return backend;
}

// Minimal zip reader: end-of-central-directory -> central entries -> local data, inflated and
// CRC-checked. Enough to prove the archive opens and to read its entries in order.
function readZip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip has an end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory entry signature');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header signature for ${name}`);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(zlib.crc32(data), crc, `CRC of ${name}`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function scratchProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  return { root, write };
}

test('selectArchiveTasks keeps only tasks whose status is not closed (complete or canceled role)', () => {
  const out = selectArchiveTasks({ tasks: TASKS, statuses: STATUSES, sprints: SPRINTS, tags: TAGS });
  assert.deepEqual(out.tasks.map((t) => t.id), ['DMP1', 'DMP3', 'DMP5', 'DMP7']);
  assert.ok(!out.tasks.some((t) => t.status === 'done' || t.status === 'dropped'));
});

test('selectArchiveTasks leaves out unfinalized reservation placeholders', () => {
  const out = selectArchiveTasks({ tasks: TASKS, statuses: STATUSES, sprints: SPRINTS, tags: TAGS });
  assert.ok(!out.tasks.some((t) => t.id === 'DMP6'));
});

test('selectArchiveTasks keeps dependency keys verbatim, including keys of closed tasks', () => {
  const out = selectArchiveTasks({ tasks: TASKS, statuses: STATUSES, sprints: SPRINTS, tags: TAGS });
  const byId = Object.fromEntries(out.tasks.map((t) => [t.id, t]));
  assert.deepEqual(byId.DMP3.dependencies, ['DMP2', 'DMP1']);
  assert.deepEqual(byId.DMP7.dependencies, ['DMP4']);
  assert.deepEqual(byId.DMP1.dependencies, []);
});

test('selectArchiveTasks names the parent by task key and drops account-bound fields', () => {
  const out = selectArchiveTasks({ tasks: TASKS, statuses: STATUSES, sprints: SPRINTS, tags: TAGS });
  const byId = Object.fromEntries(out.tasks.map((t) => [t.id, t]));
  assert.equal(byId.DMP3.parentId, 'DMP5');
  assert.equal(byId.DMP7.parentId, 'DMP2', 'a closed parent is still named; the importer decides');
  assert.equal(byId.DMP1.parentId, null);
  assert.equal(byId.DMP5.isObjective, true);
  assert.equal(byId.DMP7.due_date, '2026-11-01');
  assert.equal(byId.DMP1.agentAssignee, 'codex');
  for (const task of out.tasks) {
    for (const field of ['assignee', 'createdBy', 'totalInputTokens', 'totalCostUsd', 'activeDevice', 'projectId', 'dbId', 'parentDbId', 'isReservation']) {
      assert.ok(!(field in task), `${task.id} must not carry ${field}`);
    }
  }
});

test('selectArchiveTasks carries only the sprints, tags and the full status list the tasks use', () => {
  const out = selectArchiveTasks({ tasks: TASKS, statuses: STATUSES, sprints: SPRINTS, tags: TAGS });
  assert.deepEqual(out.sprints, [
    { number: 2, name: 'Sprint 2', status: 'active', goal: null, start_date: null, end_date: null },
    { number: 3, name: 'Sprint 3', status: 'active', goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13' },
  ]);
  assert.deepEqual(out.tags, [
    { name: 'feature', description: 'New behaviour', fileKey: null },
    { name: 'tt-alpha', description: 'Alpha module', fileKey: 'ai/architecture/tt-alpha.md' },
    { name: 'unregistered', description: null, fileKey: null },
  ]);
  assert.deepEqual(out.statuses.map((s) => s.name), ['todo', 'doing', 'blocked', 'done', 'dropped']);
  assert.deepEqual(out.statuses[3], {
    name: 'done', color: 'green', display_order: 3,
    is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false,
  });
});

test('collectKbFiles takes CLAUDE.md, AGENTS.md, ai/CONVENTIONS.md and ai/architecture/*.md only', (t) => {
  const { root, write } = scratchProject(t);
  write('CLAUDE.md', '# Claude');
  write('ai/CONVENTIONS.md', '# Conventions');
  write('ai/architecture/GENERAL.md', '# General');
  write('ai/architecture/tt-alpha.md', '# Alpha');
  write('ai/architecture/_index.json', '[]');
  write('ai/architecture/nested/tt-deep.md', '# not top level');
  write('README.md', '# not KB');
  fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt-archive-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'ai', 'architecture', 'tt-leak.md'));

  const files = collectKbFiles(root);
  assert.deepEqual(files.map((f) => f.key), [
    'CLAUDE.md', 'AGENTS.md', 'ai/CONVENTIONS.md', 'ai/architecture/GENERAL.md', 'ai/architecture/tt-alpha.md',
  ]);
  assert.equal(files[1].data.toString(), '# Claude', 'an in-project symlink is followed');
});

test('buildProjectArchive writes manifest.json first, then tasks.json and kb/ copies', async (t) => {
  const { root, write } = scratchProject(t);
  write('CLAUDE.md', '# Claude');
  write('AGENTS.md', '# Agents');
  write('ai/architecture/GENERAL.md', '# General');
  write('ai/architecture/tt-alpha.md', '# Alpha — альфа');
  const backend = fakeBackend();
  const now = new Date('2026-10-28T09:30:00.000Z');

  const { buffer, manifest } = await buildProjectArchive(root, backend, { now, appVersion: '9.9.9' });
  const entries = readZip(buffer);
  assert.deepEqual(entries.map((e) => e.name), [
    'manifest.json', 'tasks.json',
    'kb/CLAUDE.md', 'kb/AGENTS.md', 'kb/ai/architecture/GENERAL.md', 'kb/ai/architecture/tt-alpha.md',
  ]);

  const saved = JSON.parse(entries[0].data.toString('utf8'));
  assert.deepEqual(saved, manifest);
  assert.deepEqual(saved, {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: '2026-10-28T09:30:00.000Z',
    appVersion: '9.9.9',
    projectName: 'Демо проєкт',
    language: 'uk',
    taskPrefix: 'DMP',
    counts: { kbFiles: 4, tasks: 4, sprints: 2, tags: 3, statuses: 5 },
  });

  const tasksDoc = JSON.parse(entries[1].data.toString('utf8'));
  assert.equal(tasksDoc.formatVersion, ARCHIVE_FORMAT_VERSION);
  assert.deepEqual(tasksDoc.tasks.map((task) => task.id), ['DMP1', 'DMP3', 'DMP5', 'DMP7']);
  assert.deepEqual(tasksDoc.tasks.find((task) => task.id === 'DMP3').dependencies, ['DMP2', 'DMP1']);
  assert.deepEqual(tasksDoc.sprints.map((s) => s.number), [2, 3]);
  assert.equal(entries[5].data.toString('utf8'), '# Alpha — альфа');
  assert.deepEqual(backend.calls.statusOpts, [{ strict: true }], 'statuses are read strictly');
});

test('buildProjectArchive fails instead of guessing closed statuses when the registry is unreachable', async (t) => {
  const { root } = scratchProject(t);
  const backend = fakeBackend({ async getStatuses() { throw new Error('Project statuses unavailable'); } });
  await assert.rejects(buildProjectArchive(root, backend), /Project statuses unavailable/);
});

test('buildProjectArchive falls back to local project metadata when the project row is unavailable', async (t) => {
  const { root, write } = scratchProject(t);
  write('.tipatask/project.json', JSON.stringify({ name: 'Local Name' }));
  const backend = fakeBackend({ async getProjectSettings() { return null; } });
  const { manifest } = await buildProjectArchive(root, backend);
  assert.equal(manifest.projectName, 'Local Name');
  assert.equal(manifest.taskPrefix, null);
  assert.equal(typeof manifest.language, 'string');
  assert.equal(manifest.counts.kbFiles, 0);
});

test('archiveFileName builds <project-slug>-export.zip', () => {
  assert.equal(archiveFileName('Tipatask'), 'tipatask-export.zip');
  assert.equal(archiveFileName('My  Big — Project!'), 'my-big-project-export.zip');
  assert.equal(archiveFileName('Демо проєкт'), 'demo-proiekt-export.zip');
  assert.equal(archiveFileName(''), 'project-export.zip');
  assert.equal(archiveFileName('!!!'), 'project-export.zip');
});
