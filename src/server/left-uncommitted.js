'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Registry of tasks the exit backstop flagged as left uncommitted
// (terminal-session.js flagTaskLeftUncommitted()): the server-side source every window rebuilds
// `state.leftUncommitted` from, through GET /api/sessions (`leftUncommitted`) and the
// `task-left-uncommitted` replay a connecting __attention__ / __board__ socket receives.
// Persisted (TPT670): load() at server boot (index.js, before the server listens) names
// <USER_DATA_ROOT>/left-uncommitted.json, restores what an earlier run saved there and writes every
// later change back, synchronously, so an app restart keeps the flags. Until load() runs the
// registry is memory-only — unit tests never touch disk. Requires only node:fs / node:path, so
// websocket.js can consult it without a cycle.
//
// Entries are keyed by `projectPath || ''` then task key. An entry is dropped when a new run of
// the task starts (terminal-session.js spawnTerminal()), when a task:updated carries a closed
// status (websocket.js emitTaskUpdated() → noteTaskUpdate(), judged against the closed role
// names stored at flag time, never a hardcoded literal), when GET /api/tasks/:key/finish-prompt
// answers a stale-flag 409, or when the first connect after a restart judges a restored entry
// stale with that same rule (ws-handlers.js validateRestoredLeftUncommitted()). Every drop is
// broadcast as a `cleared: true` `task-left-uncommitted` frame by the caller, so every window
// drops it too.

const FILE_NAME = 'left-uncommitted.json';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // a restored flag older than this is dropped at load
const MAX_FILE_BYTES = 1024 * 1024;

const _byProject = new Map(); // projectPath -> Map(taskKey -> entry)
let _file = null; // storage path; null = memory only

function _bucket(projectPath) {
  return _byProject.get(projectPath || '') || null;
}

// Public view of an entry — the wire shape of the live frame's extras. `closedNames` stays local.
function _publicEntry(entry) {
  return {
    exitId: entry.exitId,
    blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
    status: entry.status || '',
    agent: entry.agent || null,
    nudgeCount: entry.nudgeCount || 0,
    at: entry.at,
  };
}

// The stored shape, for a live record() and for an entry read back from disk alike.
function _normalize(taskKey, entry) {
  return {
    exitId: entry.exitId || `${taskKey}@${Date.now()}`,
    blockers: Array.isArray(entry.blockers) ? entry.blockers.map(b => ({ code: b && b.code, message: b && b.message })).filter(b => typeof b.code === 'string' && b.code) : [],
    status: typeof entry.status === 'string' ? entry.status : '',
    agent: typeof entry.agent === 'string' && entry.agent ? entry.agent : null,
    nudgeCount: Number(entry.nudgeCount) || 0,
    at: Number(entry.at) || Date.now(),
    closedNames: (Array.isArray(entry.closedNames) ? entry.closedNames : []).filter(n => typeof n === 'string' && n),
  };
}

// The whole registry, written to a temp file and renamed over the old one, so a crash mid-write
// never leaves partial JSON. A failed write leaves the in-memory registry as it is and never
// throws: noteTaskUpdate() runs inside websocket.emitTaskUpdated().
function _persist() {
  if (!_file) return;
  const projects = Object.fromEntries([..._byProject]
    .filter(([, bucket]) => bucket.size)
    .map(([projectPath, bucket]) => [projectPath, Object.fromEntries([...bucket]
      .map(([taskKey, entry]) => [taskKey, { ..._publicEntry(entry), closedNames: entry.closedNames }]))]));
  const tmp = `${_file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
    fs.renameSync(tmp, _file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    console.warn(`[exit-backstop] could not save ${_file}: ${err.message}`);
  }
}

function _readFile(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const projects = data && data.projects;
    return projects && typeof projects === 'object' && !Array.isArray(projects) ? projects : null;
  } catch {
    return null; // missing, unreadable or corrupt: start empty, the next change replaces it
  }
}

// Boot (index.js, before the server listens): adopt the flags an earlier run of this server saved
// under `root`, then save every later change there. Entries older than `maxAgeMs` or without an
// exit id / timestamp are dropped (and the file rewritten without them); an entry already in
// memory wins. Restored entries wait for one check against the live task — takeRestored().
function load({ root, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  _file = root ? path.join(root, FILE_NAME) : null;
  let restored = 0, dropped = 0;
  const projects = _file ? _readFile(_file) : null;
  for (const [projectPath, tasks] of Object.entries(projects || {})) {
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) continue;
    for (const [taskKey, raw] of Object.entries(tasks)) {
      const at = raw && Number(raw.at);
      if (!taskKey || !raw || typeof raw.exitId !== 'string' || !raw.exitId
        || !Number.isFinite(at) || at <= 0 || now - at > maxAgeMs) { dropped++; continue; }
      let bucket = _byProject.get(projectPath);
      if (!bucket) { bucket = new Map(); _byProject.set(projectPath, bucket); }
      if (bucket.has(taskKey)) continue;
      bucket.set(taskKey, { ..._normalize(taskKey, raw), restored: true });
      restored++;
    }
  }
  if (dropped) _persist();
  return { restored, dropped };
}

function record(projectPath, taskKey, entry = {}) {
  if (!taskKey) return null;
  const key = projectPath || '';
  let bucket = _byProject.get(key);
  if (!bucket) { bucket = new Map(); _byProject.set(key, bucket); }
  const stored = _normalize(taskKey, entry);
  bucket.set(taskKey, stored);
  _persist();
  return _publicEntry(stored);
}

// `{ [taskKey]: entry }` for one project; an empty projectPath lists every project merged (the
// GET /api/sessions "no x-tipatask-project header → include all" rule).
function list(projectPath) {
  const out = {};
  if (projectPath) {
    const bucket = _bucket(projectPath);
    if (bucket) for (const [taskKey, entry] of bucket) out[taskKey] = _publicEntry(entry);
    return out;
  }
  for (const bucket of _byProject.values()) {
    for (const [taskKey, entry] of bucket) out[taskKey] = _publicEntry(entry);
  }
  return out;
}

function get(projectPath, taskKey) {
  const bucket = _bucket(projectPath);
  const entry = bucket && bucket.get(taskKey);
  return entry ? _publicEntry(entry) : null;
}

// Removes the task's entry; returns the removed public entry (the caller broadcasts the cleared
// frame only then) or null. An empty projectPath clears the key in every project. With `exitId`
// only an entry of that exit is removed, so a newer flag of the task survives.
function clear(projectPath, taskKey, { exitId } = {}) {
  if (!taskKey) return null;
  let removed = null;
  const buckets = projectPath ? [_bucket(projectPath)].filter(Boolean) : [..._byProject.values()];
  for (const bucket of buckets) {
    const entry = bucket.get(taskKey);
    if (!entry || (exitId && entry.exitId !== exitId)) continue;
    bucket.delete(taskKey);
    if (!removed) removed = _publicEntry(entry);
  }
  if (removed) _persist();
  return removed;
}

// A task:updated passing through websocket.js: drop the entry once the task reached one of the
// closed role names recorded at flag time. Returns the removed entry or null.
function noteTaskUpdate(task, projectPath) {
  const taskKey = task && task.id;
  if (!taskKey || !task.status) return null;
  const buckets = projectPath ? [_bucket(projectPath)].filter(Boolean) : [..._byProject.values()];
  for (const bucket of buckets) {
    const entry = bucket.get(taskKey);
    if (entry && entry.closedNames.includes(task.status)) return clear(projectPath, taskKey);
  }
  return null;
}

// The entries load() restored into this exact project bucket that no connect has judged yet, as
// [{ taskKey, exitId }]. Each is handed out once: the first __attention__ / __board__ connect of
// the project checks it against the live task (ws-handlers.js validateRestoredLeftUncommitted()).
function takeRestored(projectPath) {
  const out = [];
  const bucket = _bucket(projectPath);
  if (!bucket) return out;
  for (const [taskKey, entry] of bucket) {
    if (!entry.restored) continue;
    entry.restored = false;
    out.push({ taskKey, exitId: entry.exitId });
  }
  return out;
}

// test-only
function _reset() {
  _byProject.clear();
  _file = null;
}

module.exports = { record, list, get, clear, noteTaskUpdate, load, takeRestored, FILE_NAME, MAX_AGE_MS, _reset };
