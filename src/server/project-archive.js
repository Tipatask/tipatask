'use strict';

// (TPT9167) Project ▸ Export: one portable .zip holding a project's knowledge base plus every
// task that is not closed, with the sprints, tags and statuses those tasks use. Built in
// memory by buildProjectArchive(); the Electron main process (main/project-export.js) owns the
// save dialog and the file write. Layout (ARCHIVE_FORMAT_VERSION 1):
//   manifest.json   format marker + version, source project name, language, task prefix,
//                   export time, app version, entry counts
//   tasks.json      { formatVersion, tasks, sprints, tags, statuses }
//   kb/<file key>   CLAUDE.md, AGENTS.md, ai/CONVENTIONS.md and ai/architecture/*.md at their
//                   project-relative paths (the same keys knowledge sync uses)
// Task rows keep the Task App task shape (api-backend.js fromApi()) and their source keys, so
// an importer remaps `id`, `dependencies` and `parentId` to newly allocated keys.
//
// (TPT9168) The import side reads the same layout with yauzl: validateProjectArchive()
// checks an archive and summarizes it without writing anything, importProjectArchive()
// rebuilds it into a project folder and the API project its backend is bound to.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { rolesFromStatuses, isClosedName } = require('./status-roles');
const { transliterate } = require('./transliteration');
const { isKbFileKey } = require('../cli/knowledge-sync');
const { isPlaceholderDescription } = require('../mcp/tag-description');

const ARCHIVE_FORMAT = 'tipatask-project-archive';
const ARCHIVE_FORMAT_VERSION = 1;
const MANIFEST_ENTRY = 'manifest.json';
const TASKS_ENTRY = 'tasks.json';
const KB_PREFIX = 'kb/';

// Root KB files (knowledge-sync.js SYNC_FILES minus GENERAL.md, which the directory scan below
// picks up with every other ai/architecture/*.md).
const KB_ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', 'ai/CONVENTIONS.md'];
const KB_ARCH_DIR = 'ai/architecture';

// Portable task fields. Account- and project-bound fields (assignee, author, token usage,
// devices, row ids) are left out; parentId is added as the parent's task key.
const TASK_FIELDS = [
  'id', 'title', 'description', 'category', 'status', 'priority', 'order', 'dependencies', 'tags',
  'isObjective', 'agentAssignee', 'claudeModel', 'codexModel', 'piModel', 'effort',
  'agentPermissionMode', 'claudeDesignMode', 'cowboyMode', 'due_date',
];
const SPRINT_FIELDS = ['number', 'name', 'status', 'goal', 'start_date', 'end_date'];
const STATUS_FLAGS = ['is_workflow_start', 'is_in_progress', 'is_workflow_complete', 'is_workflow_canceled'];

function pick(row, fields) {
  const out = {};
  for (const field of fields) if (row[field] !== undefined) out[field] = row[field];
  return out;
}

function exportTask(task, keyByDbId) {
  const row = pick(task, TASK_FIELDS);
  row.dependencies = Array.isArray(task.dependencies) ? task.dependencies.map(String) : [];
  row.tags = Array.isArray(task.tags) ? task.tags.map(String) : [];
  row.parentId = task.parentDbId != null ? keyByDbId.get(task.parentDbId) || null : null;
  return row;
}

function exportStatus(row) {
  const out = { name: row.name, color: row.color ?? null, display_order: Number(row.display_order) || 0 };
  for (const flag of STATUS_FLAGS) out[flag] = !!row[flag];
  return out;
}

// Pure. Splits the project's task list into the rows the archive carries: every task whose
// status is not closed (status-roles.js isClosedName(): the complete or canceled role), minus
// unfinalized key-reservation placeholders, with the sprints their priorities point at, the
// tags they use (descriptions from the registry, null when a tag is not registered) and the
// whole status list. Dependency keys are kept as-is, including keys of closed tasks.
function selectArchiveTasks({ tasks, statuses, sprints, tags }) {
  const statusRows = Array.isArray(statuses) ? statuses.filter((s) => s && s.name) : [];
  const roles = rolesFromStatuses(statusRows);
  const all = Array.isArray(tasks) ? tasks.filter((t) => t && t.id) : [];
  const keyByDbId = new Map(all.filter((t) => t.dbId != null).map((t) => [t.dbId, String(t.id)]));
  const open = all.filter((t) => !t.isReservation && !isClosedName(t.status, roles));

  const sprintNumbers = new Set(open.map((t) => Number(t.priority)).filter((n) => Number.isFinite(n) && n > 0));
  const sprintRows = (Array.isArray(sprints) ? sprints : [])
    .filter((s) => s && sprintNumbers.has(Number(s.number)))
    .map((s) => pick(s, SPRINT_FIELDS))
    .sort((a, b) => Number(a.number) - Number(b.number));

  const registry = new Map((Array.isArray(tags) ? tags : []).filter((t) => t && t.name).map((t) => [t.name, t]));
  const tagNames = [...new Set(open.flatMap((t) => (Array.isArray(t.tags) ? t.tags.map(String) : [])))].sort();
  const tagRows = tagNames.map((name) => ({
    name,
    description: registry.get(name)?.description ?? null,
    fileKey: registry.get(name)?.knowledgeFileKey ?? null,
  }));

  return {
    tasks: open.map((t) => exportTask(t, keyByDbId)),
    sprints: sprintRows,
    tags: tagRows,
    statuses: statusRows
      .map(exportStatus)
      .sort((a, b) => a.display_order - b.display_order),
  };
}

// Reads a KB file as bytes. Symlinks are followed only when they resolve inside the project
// (AGENTS.md -> CLAUDE.md is common), so a link to a file elsewhere on disk is never exported.
function readKbFile(projectRoot, rootReal, key) {
  try {
    const real = fs.realpathSync(path.join(projectRoot, ...key.split('/')));
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return fs.readFileSync(real);
  } catch {
    return null;
  }
}

// The project's KB files as [{ key, data }], keys in '/' form. Missing files are skipped.
function collectKbFiles(projectRoot) {
  let rootReal;
  try { rootReal = fs.realpathSync(projectRoot); } catch { return []; }
  let archNames = [];
  try {
    archNames = fs.readdirSync(path.join(projectRoot, ...KB_ARCH_DIR.split('/')), { withFileTypes: true })
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch { /* no ai/architecture directory */ }
  const keys = [...KB_ROOT_FILES, ...archNames.map((name) => `${KB_ARCH_DIR}/${name}`)];
  const files = [];
  for (const key of keys) {
    const data = readKbFile(projectRoot, rootReal, key);
    if (data) files.push({ key, data });
  }
  return files;
}

function appVersion() {
  try { return require('../../package.json').version || null; } catch { return null; }
}

// Same word-joining as the API's projectSlug() (api/src/lib/project-slug.js).
function projectSlug(name) {
  return transliterate(name)
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// Default save-dialog file name: <project-slug>-export.zip.
function archiveFileName(projectName) {
  return `${projectSlug(projectName) || 'project'}-export.zip`;
}

function zipBuffer(entries, mtime) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.on('error', reject);
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      for (const { name, data } of entries) zip.addBuffer(data, name, { mtime, mode: 0o100644 });
      zip.end();
    } catch (err) {
      reject(err);
    }
  });
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Builds the archive for `projectRoot` from `backend` (an api-backend.js instance bound to
// that project). Returns { buffer, manifest }; nothing is written to disk. The status list is
// read strictly — a fallback registry could misjudge which statuses are closed — so an
// unreachable API fails the export instead of producing a wrong one.
async function buildProjectArchive(projectRoot, backend, opts = {}) {
  if (!projectRoot) throw new Error('buildProjectArchive: projectRoot is required');
  if (!backend) throw new Error('buildProjectArchive: backend is required');
  const now = opts.now instanceof Date ? opts.now : new Date();

  const [tasks, statuses, sprints, tags, project] = await Promise.all([
    backend.getTasksUnfiltered(),
    backend.getStatuses({ strict: true }),
    backend.getSprints(),
    backend.getTagsDetailed(),
    typeof backend.getProjectSettings === 'function' ? backend.getProjectSettings().catch(() => null) : null,
  ]);
  const selected = selectArchiveTasks({ tasks, statuses, sprints, tags });
  const kbFiles = collectKbFiles(projectRoot);

  let localName = null;
  let localLanguage = null;
  try {
    const projectConfig = require('./project-config');
    localName = projectConfig.readProjectMeta(projectRoot)?.name || null;
    localLanguage = projectConfig.readProjectLanguage(projectRoot) || null;
  } catch { /* fall back to the folder name and English */ }

  const manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    appVersion: opts.appVersion || appVersion(),
    projectName: project?.name || localName || path.basename(projectRoot),
    language: project?.language || localLanguage || 'en',
    taskPrefix: project?.task_prefix || null,
    counts: {
      kbFiles: kbFiles.length,
      tasks: selected.tasks.length,
      sprints: selected.sprints.length,
      tags: selected.tags.length,
      statuses: selected.statuses.length,
    },
  };

  const buffer = await zipBuffer([
    { name: MANIFEST_ENTRY, data: jsonBytes(manifest) },
    { name: TASKS_ENTRY, data: jsonBytes({ formatVersion: ARCHIVE_FORMAT_VERSION, ...selected }) },
    ...kbFiles.map(({ key, data }) => ({ name: `${KB_PREFIX}${key}`, data })),
  ], now);
  return { buffer, manifest };
}

// ── Import (TPT9168) ──

// Reading limits: far above a real knowledge base and task list, low enough that a hostile
// archive cannot exhaust memory. Each entry is checked against its cap from the central
// directory before it is read, and yauzl fails a read that inflates past the declared size.
const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 100 * 1024 * 1024, // the .zip file itself
  entries: 5000,                   // central-directory records, folder entries included
  manifestBytes: 1024 * 1024,
  tasksBytes: 50 * 1024 * 1024,
  kbFileBytes: 10 * 1024 * 1024,   // each kb/ file
  totalBytes: 200 * 1024 * 1024,   // every entry, uncompressed
});

// Every `code` validateProjectArchive() reports and importProjectArchive() throws.
const ARCHIVE_ERROR_CODES = Object.freeze([
  'unreadable', 'not_zip', 'too_large', 'unsafe_path', 'unexpected_entry', 'duplicate_entry',
  'corrupt', 'missing_manifest', 'invalid_manifest', 'unsupported_version', 'missing_tasks',
  'invalid_tasks',
]);

class ProjectArchiveError extends Error {
  constructor(code, detail) {
    super(detail ? `Project archive ${code}: ${detail}` : `Project archive ${code}`);
    this.name = 'ProjectArchiveError';
    this.code = code;
    this.detail = detail || null;
  }
}

function fail(code, detail) {
  throw new ProjectArchiveError(code, detail);
}

// zlib.crc32 arrived in Node 20.15 / 22.2. Without it entries are read unchecked: yauzl
// itself never verifies a CRC.
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

const TAG_DESCRIPTION_MAX = 500; // POST /tags limit
const STATUS_NAME_MAX = 64;      // POST /statuses limits
const STATUS_COLOR_MAX = 16;
const TASK_TITLE_MAX = 255;      // POST /tasks limit
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Control characters and the characters Windows rejects in file names (':' would also open
// an NTFS alternate data stream).
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;

// A plain relative path: no absolute or drive prefix and no '..' segment
// (yauzl.validateFileName()), no '.' or empty segment, no unsafe character. Backslashes are
// already '/' here (getFileNameLowLevel()), so 'kb\..\x' is caught as a '..' segment.
function isSafeEntryName(name) {
  if (!name || UNSAFE_NAME_CHARS.test(name) || yauzl.validateFileName(name) !== null) return false;
  const body = name.endsWith('/') ? name.slice(0, -1) : name;
  return body.split('/').every((segment) => segment !== '' && segment !== '.');
}

// Folder entries, and the metadata macOS Archive Utility adds when an extracted archive is
// zipped again.
function isIgnoredEntry(name) {
  return name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
}

// kb/ entries must be knowledge-sync file keys (CLAUDE.md, AGENTS.md, ai/**/*.md), so an
// archive can never place .git/hooks, .claude/settings.json or similar into a project.
function entryKind(name) {
  if (name === MANIFEST_ENTRY) return 'manifest';
  if (name === TASKS_ENTRY) return 'tasks';
  if (name.startsWith(KB_PREFIX) && isKbFileKey(name.slice(KB_PREFIX.length))) return 'kb';
  return null;
}

async function readEntryBytes(zipfile, entry, name) {
  if (entry.isEncrypted() || !entry.canDecodeFileData()) fail('corrupt', name);
  const chunks = [];
  let crc = 0;
  try {
    const stream = await zipfile.openReadStreamPromise(entry);
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (crc32) crc = crc32(chunk, crc);
    }
  } catch {
    fail('corrupt', name);
  }
  if (crc32 && crc !== entry.crc32) fail('corrupt', name);
  return Buffer.concat(chunks);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalDate(value) {
  return value === undefined || value === null || (typeof value === 'string' && DATE_ONLY.test(value));
}

function isTextList(value) {
  return value === undefined || (Array.isArray(value) && value.every(isText));
}

function fold(name) {
  return String(name).trim().toLowerCase();
}

function textOrNull(value) {
  return isText(value) ? value.trim() : null;
}

function parseJson(buffer, code) {
  try {
    return JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch {
    return fail(code);
  }
}

function parseManifest(buffer) {
  const manifest = parseJson(buffer, 'invalid_manifest');
  if (!isObject(manifest) || manifest.format !== ARCHIVE_FORMAT) fail('invalid_manifest', 'format');
  const version = manifest.formatVersion;
  if (!Number.isInteger(version) || version < 1) fail('invalid_manifest', 'formatVersion');
  if (version > ARCHIVE_FORMAT_VERSION) fail('unsupported_version', String(version));
  return manifest;
}

function checkTasks(tasks) {
  const ids = new Set();
  tasks.forEach((task, i) => {
    const where = `tasks[${i}]`;
    if (!isObject(task) || !isText(task.id) || !isText(task.title) || task.title.trim().length > TASK_TITLE_MAX
      || !isOptionalString(task.description) || !isOptionalString(task.status) || !isOptionalString(task.parentId)
      || (task.priority != null && !Number.isFinite(task.priority))
      || !isTextList(task.dependencies) || !isTextList(task.tags)) {
      fail('invalid_tasks', where);
    }
    if (ids.has(task.id)) fail('invalid_tasks', `${where}.id`);
    ids.add(task.id);
  });
}

function checkSprints(sprints) {
  const numbers = new Set();
  sprints.forEach((sprint, i) => {
    const where = `sprints[${i}]`;
    if (!isObject(sprint) || !Number.isInteger(sprint.number) || sprint.number < 0 || !isText(sprint.name)
      || !isOptionalString(sprint.goal) || !isOptionalDate(sprint.start_date) || !isOptionalDate(sprint.end_date)
      || (sprint.start_date && sprint.end_date && sprint.end_date < sprint.start_date)) {
      fail('invalid_tasks', where);
    }
    if (numbers.has(sprint.number)) fail('invalid_tasks', `${where}.number`);
    numbers.add(sprint.number);
  });
}

function checkTags(tags) {
  const names = new Set();
  tags.forEach((tag, i) => {
    const where = `tags[${i}]`;
    if (!isObject(tag) || !isText(tag.name) || !isOptionalString(tag.description) || !isOptionalString(tag.fileKey)) {
      fail('invalid_tasks', where);
    }
    if (names.has(fold(tag.name))) fail('invalid_tasks', `${where}.name`);
    names.add(fold(tag.name));
  });
}

// Statuses also keep the API's role rule: a status holds at most one workflow role and a
// role belongs to at most one status.
function checkStatuses(statuses) {
  const names = new Set();
  const held = new Set();
  statuses.forEach((status, i) => {
    const where = `statuses[${i}]`;
    if (!isObject(status) || !isText(status.name) || status.name.trim().length > STATUS_NAME_MAX
      || !isOptionalString(status.color) || (typeof status.color === 'string' && status.color.length > STATUS_COLOR_MAX)
      || STATUS_FLAGS.some((flag) => status[flag] !== undefined && typeof status[flag] !== 'boolean')) {
      fail('invalid_tasks', where);
    }
    const roles = STATUS_FLAGS.filter((flag) => status[flag]);
    if (roles.length > 1 || roles.some((role) => held.has(role))) fail('invalid_tasks', where);
    roles.forEach((role) => held.add(role));
    if (names.has(fold(status.name))) fail('invalid_tasks', `${where}.name`);
    names.add(fold(status.name));
  });
}

// tasks.json: every field the importer reads must have the type it expects, and keys and
// names must be unique. `sprints`, `tags` and `statuses` default to [].
function parseTasksDocument(buffer, formatVersion) {
  const doc = parseJson(buffer, 'invalid_tasks');
  if (!isObject(doc)) fail('invalid_tasks');
  if (doc.formatVersion !== undefined && doc.formatVersion !== formatVersion) fail('invalid_tasks', 'formatVersion');
  const list = (field, required = false) => {
    if (doc[field] === undefined && !required) return [];
    if (!Array.isArray(doc[field])) fail('invalid_tasks', field);
    return doc[field];
  };
  const out = { tasks: list('tasks', true), sprints: list('sprints'), tags: list('tags'), statuses: list('statuses') };
  checkTasks(out.tasks);
  checkSprints(out.sprints);
  checkTags(out.tags);
  checkStatuses(out.statuses);
  return out;
}

function summarize(manifest, doc, kbFiles) {
  return {
    projectName: textOrNull(manifest.projectName),
    language: textOrNull(manifest.language),
    taskPrefix: textOrNull(manifest.taskPrefix),
    exportedAt: textOrNull(manifest.exportedAt),
    appVersion: textOrNull(manifest.appVersion),
    formatVersion: manifest.formatVersion,
    kbFileCount: kbFiles.length,
    taskCount: doc.tasks.length,
    sprintCount: doc.sprints.length,
    tagCount: doc.tags.length,
    statusCount: doc.statuses.length,
    kbFiles: kbFiles.map((file) => file.key),
  };
}

// Reads and checks the whole archive: every entry name, size and CRC, then manifest.json and
// tasks.json. Returns { manifest, data, kbFiles, summary }. kb/ contents are kept only with
// keepKb (the importer); otherwise each file is read, checked and dropped.
// Throws ProjectArchiveError.
async function readArchive(zipPath, { limits, keepKb = false } = {}) {
  const max = { ...ARCHIVE_LIMITS, ...limits };
  let stat;
  try {
    stat = fs.statSync(zipPath);
  } catch {
    fail('unreadable');
  }
  if (!stat.isFile()) fail('unreadable');
  if (stat.size > max.archiveBytes) fail('too_large', 'archive');

  let zipfile;
  try {
    // decodeStrings:false so a bad name is reported below as unsafe_path rather than as a
    // yauzl error; getFileNameLowLevel() decodes it exactly as yauzl would, the Info-ZIP
    // Unicode Path field included.
    zipfile = await yauzl.openPromise(zipPath, { decodeStrings: false, validateEntrySizes: true, autoClose: false });
  } catch (err) {
    fail(['EACCES', 'EPERM', 'ENOENT'].includes(err && err.code) ? 'unreadable' : 'not_zip');
  }
  try {
    if (zipfile.entryCount > max.entries) fail('too_large', 'entries');
    let manifest = null;
    let tasksBytes = null;
    const kbFiles = [];
    const seen = new Set();
    let total = 0;
    const entries = zipfile.eachEntry();
    for (;;) {
      let next;
      try {
        next = await entries.next();
      } catch {
        fail('corrupt');
      }
      if (next.done) break;
      const entry = next.value;
      const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
      if (!isSafeEntryName(name)) fail('unsafe_path', name);
      if (isIgnoredEntry(name)) continue;
      const kind = entryKind(name);
      if (!kind) fail('unexpected_entry', name);
      // Case-folded: two names that differ only in case land on one file on macOS/Windows.
      if (seen.has(name.toLowerCase())) fail('duplicate_entry', name);
      seen.add(name.toLowerCase());
      const cap = kind === 'manifest' ? max.manifestBytes : kind === 'tasks' ? max.tasksBytes : max.kbFileBytes;
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > cap || total > max.totalBytes) fail('too_large', name);
      const bytes = await readEntryBytes(zipfile, entry, name);
      if (kind === 'manifest') manifest = parseManifest(bytes);
      else if (kind === 'tasks') tasksBytes = bytes; // parsed once the manifest's version is known
      else kbFiles.push({ key: name.slice(KB_PREFIX.length), data: keepKb ? bytes : null });
    }
    if (!manifest) fail('missing_manifest');
    if (!tasksBytes) fail('missing_tasks');
    const data = parseTasksDocument(tasksBytes, manifest.formatVersion);
    return { manifest, data, kbFiles, summary: summarize(manifest, data, kbFiles) };
  } finally {
    zipfile.close();
  }
}

// Checks a Project ▸ Export archive and writes nothing. Resolves to { ok: true, summary } or
// { ok: false, code, detail }, never rejects. `code` is one of ARCHIVE_ERROR_CODES; `detail`
// (the entry name or tasks.json field at fault, or null) is for logs.
// opts.limits overrides ARCHIVE_LIMITS fields.
async function validateProjectArchive(zipPath, opts = {}) {
  try {
    const { summary } = await readArchive(zipPath, { limits: opts.limits });
    return { ok: true, summary };
  } catch (err) {
    if (err instanceof ProjectArchiveError) return { ok: false, code: err.code, detail: err.detail };
    return { ok: false, code: 'unreadable', detail: String((err && err.message) || err).split('\n')[0] };
  }
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

function isInside(rootReal, target) {
  return target === rootReal || target.startsWith(rootReal + path.sep);
}

// Writes one kb/ file under the project. Returns false, writing nothing, when the path is
// taken (always by a folder; by anything else unless `overwrite`) or a parent folder is not
// a folder inside the project (a symlink leading out of it, a file in the way). Without
// `overwrite` the file is created exclusively, so a file that appears meanwhile is never
// replaced; with it the data goes to a temp file that is renamed over the target, which
// replaces a symlink instead of writing through it.
function writeKbFile(rootReal, key, data, overwrite) {
  const segments = key.split('/');
  let dir = rootReal;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    let stat = lstatOrNull(dir);
    if (!stat) {
      try { fs.mkdirSync(dir); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      stat = fs.lstatSync(dir);
    }
    if (stat.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(dir); } catch { return false; }
      if (!isInside(rootReal, real) || !fs.statSync(real).isDirectory()) return false;
      dir = real;
    } else if (!stat.isDirectory()) {
      return false;
    }
  }
  const dest = path.join(dir, segments[segments.length - 1]);
  const existing = lstatOrNull(dest);
  if (existing && (!overwrite || existing.isDirectory())) return false;
  if (!existing) {
    try {
      fs.writeFileSync(dest, data, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!overwrite) return false;
    }
  }
  const tmp = `${dest}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  return true;
}

function writeKbFiles(projectRoot, kbFiles, overwrite, out) {
  fs.mkdirSync(projectRoot, { recursive: true });
  const rootReal = fs.realpathSync(projectRoot);
  for (const { key, data } of kbFiles) {
    (writeKbFile(rootReal, key, data, overwrite) ? out.written : out.skipped).push(key);
  }
}

function statusRole(status) {
  return STATUS_FLAGS.find((flag) => status[flag]) || null;
}

function byDisplayOrder(a, b) {
  return (Number(a.display_order) || 0) - (Number(b.display_order) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0);
}

// Recreates the archive's status list. An archived status matches the project status of the
// same name, else, when it holds a workflow role, the project status holding that role,
// which is renamed to it, so a new project's default statuses become the exported workflow
// instead of sitting beside it. Unmatched statuses are created. A matched status takes the
// archived color and role (a role is only ever moved onto a status, never cleared). Then the
// list is reordered: archived statuses in archive order, followed by any status the project
// keeps. Nothing is deleted. Returns the project's final status rows.
async function importStatuses(backend, statuses, out) {
  let rows = await backend.getStatuses({ strict: true });
  if (statuses.length === 0) return rows;
  const matches = new Map();
  const used = new Set();
  statuses.forEach((status, i) => {
    const row = rows.find((r) => !used.has(r.id) && fold(r.name) === fold(status.name));
    if (row) { matches.set(i, row); used.add(row.id); }
  });
  statuses.forEach((status, i) => {
    const role = statusRole(status);
    if (matches.has(i) || !role) return;
    const row = rows.find((r) => !used.has(r.id) && r[role]);
    if (row) { matches.set(i, row); used.add(row.id); }
  });

  for (const [i, status] of statuses.entries()) {
    const name = status.name.trim();
    const role = statusRole(status);
    const row = matches.get(i);
    const fields = {};
    if (!row || row.name !== name) fields.name = name;
    if (status.color !== undefined && (!row || (row.color ?? null) !== status.color)) fields.color = status.color;
    if (role && (!row || !row[role])) fields[role] = true;
    if (!row) {
      await backend.createStatus(fields);
      out.created.push(name);
    } else if (Object.keys(fields).length > 0) {
      await backend.updateStatus(row.id, fields);
      out.updated.push(name);
    }
  }

  rows = await backend.getStatuses({ strict: true });
  const current = [...rows].sort(byDisplayOrder).map((row) => row.id);
  const wanted = [];
  for (const status of statuses) {
    const row = rows.find((r) => fold(r.name) === fold(status.name));
    if (row && !wanted.includes(row.id)) wanted.push(row.id);
  }
  for (const id of current) if (!wanted.includes(id)) wanted.push(id);
  if (wanted.join() !== current.join()) rows = (await backend.reorderStatuses(wanted)) || rows;
  return rows;
}

function usableTagDescription(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= TAG_DESCRIPTION_MAX && !isPlaceholderDescription(text) ? text : null;
}

// Registers every archived tag that has a usable description (the API rejects a missing or
// placeholder one, C1038) and returns the project's registered tag names, case-folded. The
// tag's KB-file link is not sent: the kb/ files are only on disk until pushed, and the API
// refuses a link to a file it does not hold.
async function importTags(backend, tags, out) {
  for (const tag of tags) {
    const name = tag.name.trim();
    const description = usableTagDescription(tag.description);
    if (!description) {
      out.skipped.push(name);
      continue;
    }
    await backend.ensureTag(name, description);
    out.registered.push(name);
  }
  return new Set((await backend.getTags()).map(fold));
}

// Creates the archived sprints in ascending number order (the archive's own order) with
// their names, goals and dates. A number the project already has stays as it is. Sprint
// status is not restored: a new sprint is active.
async function importSprints(backend, sprints, out) {
  for (const sprint of [...sprints].sort((a, b) => a.number - b.number)) {
    const extra = {};
    if (isText(sprint.goal)) extra.goal = sprint.goal;
    if (sprint.start_date) extra.start_date = sprint.start_date;
    if (sprint.end_date) extra.end_date = sprint.end_date;
    const created = await backend.createSprint(sprint.name.trim(), sprint.number, extra);
    (created ? out.created : out.existing).push(sprint.number);
  }
}

// Creation order: archive order, except that a task comes after the archived tasks it
// depends on and after its archived parent. An edge that closes a cycle cannot be honored:
// the task is created without it and importTasks() patches it in afterwards.
function planTaskOrder(tasks) {
  const index = new Map(tasks.map((task, i) => [task.id, i]));
  const before = tasks.map((task) => {
    const keys = [...(task.dependencies || []), ...(task.parentId ? [task.parentId] : [])];
    const positions = keys.filter((key) => key !== task.id && index.has(key)).map((key) => index.get(key));
    return [...new Set(positions)].sort((a, b) => a - b);
  });
  const state = new Uint8Array(tasks.length); // 0 not visited, 1 on the stack, 2 placed
  const order = [];
  for (let root = 0; root < tasks.length; root++) {
    if (state[root]) continue;
    state[root] = 1;
    const stack = [[root, 0]];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [node, next] = frame;
      if (next < before[node].length) {
        frame[1] = next + 1;
        const dep = before[node][next];
        if (state[dep] === 0) {
          state[dep] = 1;
          stack.push([dep, 0]);
        }
      } else {
        state[node] = 2;
        order.push(node);
        stack.pop();
      }
    }
  }
  return order;
}

// The createTask() fields of one archived task. Account- and project-bound fields were
// never exported; the API assigns the key and the importing user becomes the assignee.
function taskFields(task, { status, dependencies, parentId, tags }) {
  const fields = {
    title: task.title.trim(),
    description: typeof task.description === 'string' ? task.description : '',
    category: task.category === 'HUMAN' ? 'HUMAN' : 'CODING',
    priority: Number.isFinite(task.priority) ? task.priority : 0,
    order: Number.isInteger(task.order) && task.order >= 0 ? task.order : 0,
    dependencies,
    tags,
    isObjective: task.isObjective === true,
    claudeDesignMode: task.claudeDesignMode === true,
    due_date: typeof task.due_date === 'string' && DATE_ONLY.test(task.due_date) ? task.due_date : null,
  };
  if (status) fields.status = status;
  if (parentId) fields.parentId = parentId;
  for (const field of ['agentAssignee', 'claudeModel', 'codexModel', 'piModel', 'effort']) {
    if (isText(task[field])) fields[field] = task[field];
  }
  if (task.agentPermissionMode === null || typeof task.agentPermissionMode === 'string') {
    fields.agentPermissionMode = task.agentPermissionMode;
  }
  if (typeof task.cowboyMode === 'boolean') fields.cowboyMode = task.cowboyMode;
  return fields;
}

// Creates the archived tasks in planTaskOrder() order, keeping each one's status (matched
// by name, else the workflow-start status), sprint (priority), order, tags and agent
// settings. Key remap: the API allocates every new key and keyMap records old -> new, so a
// dependency or parent created earlier is written with its new key. A dependency or parent
// the archive does not carry is dropped; one not created yet (a cycle) is patched in once
// every task exists. Tags the project has not registered are dropped.
async function importTasks(backend, tasks, { statusRows, knownTags, result, report }) {
  const ids = new Set(tasks.map((task) => task.id));
  const statusByName = new Map(statusRows.map((row) => [fold(row.name), row.name]));
  const startStatus = (statusRows.find((row) => row.is_workflow_start) || statusRows[0] || {}).name;
  const keyMap = new Map();
  const patches = [];
  for (const i of planTaskOrder(tasks)) {
    const task = tasks[i];
    const deps = [...new Set(task.dependencies || [])].filter((key) => key !== task.id);
    const archived = deps.filter((key) => ids.has(key));
    result.dropped.dependencies += deps.length - archived.length;
    let parentId = task.parentId && task.parentId !== task.id ? task.parentId : null;
    if (parentId && !ids.has(parentId)) {
      result.dropped.parents += 1;
      parentId = null;
    }
    const tagNames = [...new Set(task.tags || [])];
    const tags = tagNames.filter((name) => knownTags.has(fold(name)));
    result.dropped.tags += tagNames.length - tags.length;

    const depsLater = archived.some((key) => !keyMap.has(key));
    const parentLater = Boolean(parentId) && !keyMap.has(parentId);
    const created = await backend.createTask(taskFields(task, {
      status: statusByName.get(fold(task.status || '')) || startStatus,
      dependencies: archived.filter((key) => keyMap.has(key)).map((key) => keyMap.get(key)),
      parentId: parentId && !parentLater ? keyMap.get(parentId) : null,
      tags,
    }), { queueOffline: false });
    if (!created || !isText(created.id) || created._tmpId) {
      throw new Error(`createTask returned no API task key for ${task.id}`);
    }
    keyMap.set(task.id, created.id);
    result.tasks.keyMap[task.id] = created.id;
    result.tasks.created += 1;
    if (depsLater || parentLater) {
      patches.push({ id: task.id, dependencies: depsLater ? archived : null, parentId: parentLater ? parentId : null });
    }
    report('tasks', result.tasks.created, tasks.length);
  }
  for (const patch of patches) {
    const fields = {};
    if (patch.dependencies) fields.dependencies = patch.dependencies.map((key) => keyMap.get(key));
    if (patch.parentId) fields.parentId = keyMap.get(patch.parentId);
    await backend.updateTask(keyMap.get(patch.id), fields, { queueOffline: false });
  }
}

// Rebuilds an archive into `projectRoot` and the API project `backend` (an api-backend.js
// instance) is bound to — meant for a newly created project. Steps, in order: kb/ files,
// statuses, tags, sprints, tasks. Not resumable: a retry recreates the tasks already made.
// opts: overwrite (replace existing kb/ files; default false keeps them),
// onProgress({ step, done, total }), limits (ARCHIVE_LIMITS overrides).
// Resolves to { ok: true, projectName, kb, statuses, tags, sprints, tasks, dropped }.
// An invalid archive rejects with a ProjectArchiveError before anything is written; any later
// failure rejects with the original error plus err.importStep and err.imported (the result
// so far).
async function importProjectArchive(zipPath, opts = {}) {
  const { projectRoot, backend } = opts;
  if (!projectRoot) throw new Error('importProjectArchive: projectRoot is required');
  if (!backend) throw new Error('importProjectArchive: backend is required');
  const archive = await readArchive(zipPath, { limits: opts.limits, keepKb: true });
  const { tasks, sprints, tags, statuses } = archive.data;

  const result = {
    projectName: archive.summary.projectName,
    kb: { written: [], skipped: [] },
    statuses: { created: [], updated: [] },
    tags: { registered: [], skipped: [] },
    sprints: { created: [], existing: [] },
    tasks: { created: 0, keyMap: {} },
    dropped: { dependencies: 0, parents: 0, tags: 0 },
  };
  const report = (step, done, total) => {
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress({ step, done, total }); } catch { /* a listener never fails the import */ }
  };
  const step = async (name, total, run) => {
    report(name, 0, total);
    try {
      return await run();
    } catch (err) {
      if (err && typeof err === 'object') {
        err.importStep = name;
        err.imported = result;
      }
      throw err;
    }
  };

  await step('kb', archive.kbFiles.length, () => writeKbFiles(projectRoot, archive.kbFiles, opts.overwrite === true, result.kb));
  const statusRows = await step('statuses', statuses.length, () => importStatuses(backend, statuses, result.statuses));
  const knownTags = await step('tags', tags.length, () => importTags(backend, tags, result.tags));
  await step('sprints', sprints.length, () => importSprints(backend, sprints, result.sprints));
  await step('tasks', tasks.length, () => importTasks(backend, tasks, { statusRows, knownTags, result, report }));
  return { ok: true, ...result };
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_ENTRY,
  TASKS_ENTRY,
  KB_PREFIX,
  ARCHIVE_LIMITS,
  ARCHIVE_ERROR_CODES,
  ProjectArchiveError,
  buildProjectArchive,
  selectArchiveTasks,
  collectKbFiles,
  archiveFileName,
  projectSlug,
  validateProjectArchive,
  importProjectArchive,
};
