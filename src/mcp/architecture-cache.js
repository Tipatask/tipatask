'use strict';

const fs = require('fs');
const path = require('path');

// Resolve architecture docs from explicit project root, then project env, then
// local checkout fallback. Cache state per resolved directory so concurrent
// projects never share taxonomy, watchers, or stale docs.
function _resolveArchitectureDir(projectRoot) {
  // Highest priority: explicit project root threaded by the caller.
  // Unconditional — no statSync check — so a fresh project with no ai/architecture/ yet
  // still resolves there and doesn't silently fall back to the app bundle.
  if (projectRoot) {
    return path.join(path.resolve(projectRoot), 'ai', 'architecture');
  }
  // Next: explicit project root injected into MCP env.
  if (process.env.TIPATASK_PROJECT_ROOT) {
    return path.join(process.env.TIPATASK_PROJECT_ROOT, 'ai', 'architecture');
  }
  const candidates = [
    // Claude Code / Codex spawn MCP servers with cwd = the project root. Never derived from
    // this checkout's location — the Task App is a standalone repo.
    path.join(process.cwd(), 'ai', 'architecture'),
    // packaged: Contents/Resources/ai/architecture/
    process.resourcesPath && path.join(process.resourcesPath, 'ai', 'architecture'),
    // spawned MCP (ELECTRON_RUN_AS_NODE): TIPATASK_SERVER_ROOT = <Resources>/app.asar
    process.env.TIPATASK_SERVER_ROOT && path.join(path.dirname(process.env.TIPATASK_SERVER_ROOT), 'ai', 'architecture'),
  ].filter(Boolean);
  for (const d of candidates) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch (_) {}
  }
  return candidates[0]; // fallback — reads will fail gracefully (ENOENT caught in callers)
}

// Default directory (env / fallback resolution). Preserves the historical ARCHITECTURE_DIR
// export and is what the spawned MCP server uses (its env supplies the project root).
const ARCHITECTURE_DIR = _resolveArchitectureDir();
const TTL_MS = 10 * 60 * 1000;
const WATCHER_DEBOUNCE_MS = 200;

// Aggregate (process-wide) telemetry — not per-project.
const stats = { hits: 0, mtimeRevalidations: 0, contentReads: 0, dirRescans: 0, invalidations: 0, misses: 0 };
function getStats() { return { ...stats }; }
function resetStats() { for (const k of Object.keys(stats)) stats[k] = 0; }

// One state object per resolved architecture directory.
//   files: Map<tagName, { content, mtimeMs, loadedAt, description }>
const _states = new Map(); // archDir → state

function _newState(dir) {
  return {
    dir,
    indexFile: path.join(dir, '_index.json'),
    files: new Map(),
    tagList: [],            // sorted [{ tag, description, file }]
    dirMtimeMs: 0,
    dirScannedAt: 0,
    lastIndexSig: null,
    watcher: null,
    watcherActive: false,
    watcherDebounce: null,
  };
}

function _getState(projectRoot) {
  const dir = _resolveArchitectureDir(projectRoot);
  let state = _states.get(dir);
  if (!state) {
    state = _newState(dir);
    _states.set(dir, state);
  }
  return state;
}

function parseDescription(content) {
  const m = content.match(/^#[^#].+$/m);
  if (!m) return '';
  const parts = m[0].replace(/^#\s*/, '').split(' — ');
  return parts.length > 1 ? parts.slice(1).join(' — ').trim() : parts[0].trim();
}

function _writeIndexIfChanged(state) {
  const payload = JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), tags: state.tagList });
  if (payload === state.lastIndexSig) return;
  const tmp = state.indexFile + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, state.indexFile);
    state.lastIndexSig = payload;
  } catch (err) {
    process.stderr.write(`[arch-cache] index write failed: ${err.message}\n`);
  }
}

function _clearWatcherDebounce(state) {
  if (state.watcherDebounce) {
    clearTimeout(state.watcherDebounce);
    state.watcherDebounce = null;
  }
}

function _disableWatcher(state, err) {
  _clearWatcherDebounce(state);
  if (state.watcher) {
    try { state.watcher.close(); } catch (_) {}
  }
  state.watcher = null;
  state.watcherActive = false;
  state.dirScannedAt = 0; // force stat-based validation on next read
  if (err) {
    process.stderr.write(`[arch-cache] watcher disabled; falling back to stat-on-read: ${err.message}\n`);
  }
}

function _startWatcher(state) {
  if (state.watcher) return;
  try {
    const watcher = fs.watch(state.dir, { persistent: false }, () => {
      _clearWatcherDebounce(state);
      state.watcherDebounce = setTimeout(() => {
        state.watcherDebounce = null;
        state.dirScannedAt = 0;
      }, WATCHER_DEBOUNCE_MS);
      if (state.watcherDebounce.unref) state.watcherDebounce.unref();
    });
    watcher.on('error', (err) => _disableWatcher(state, err));
    watcher.on('close', () => {
      if (state.watcher === watcher) {
        state.watcher = null;
        state.watcherActive = false;
      }
    });
    state.watcher = watcher;
    state.watcherActive = true;
  } catch (err) {
    // fall back to stat-on-read
    _disableWatcher(state, err);
  }
}

function loadAll(projectRoot) {
  const state = _getState(projectRoot);
  const t0 = Date.now();
  let dirStat;
  try {
    dirStat = fs.statSync(state.dir);
  } catch (err) {
    return { count: 0, ms: Date.now() - t0, error: err.message };
  }

  const dirFiles = fs.readdirSync(state.dir).sort();
  const built = [];

  for (const file of dirFiles) {
    if (!file.startsWith('tt-') || !file.endsWith('.md')) continue;
    const tagName = file.slice(0, -3);
    const filePath = path.join(state.dir, file);
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { continue; }
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
    const description = parseDescription(content);
    state.files.set(tagName, { content, mtimeMs: stat.mtimeMs, loadedAt: Date.now(), description });
    built.push({ tag: tagName, description, file });
  }

  state.tagList = built;
  state.dirMtimeMs = dirStat.mtimeMs;
  state.dirScannedAt = Date.now();

  _startWatcher(state);
  _writeIndexIfChanged(state);
  return { count: built.length, ms: Date.now() - t0 };
}

function _rescan(state) {
  if (state.watcherActive && state.dirScannedAt > 0 && Date.now() - state.dirScannedAt < TTL_MS) return;

  let dirStat;
  try { dirStat = fs.statSync(state.dir); } catch (_) { return; }

  if (dirStat.mtimeMs === state.dirMtimeMs && Date.now() - state.dirScannedAt < TTL_MS) return;

  stats.dirRescans++;

  // Tier 1: read taxonomy from pre-built index if it's at least as fresh as the dir
  let indexStat;
  try { indexStat = fs.statSync(state.indexFile); } catch (_) {}
  if (indexStat && indexStat.mtimeMs >= dirStat.mtimeMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(state.indexFile, 'utf8'));
      if (Array.isArray(parsed.tags) && parsed.tags.length > 0) {
        state.tagList = parsed.tags;
        state.dirMtimeMs = dirStat.mtimeMs;
        state.dirScannedAt = Date.now();
        _startWatcher(state);
        return;
      }
    } catch (_) {}
  }

  // Tier 2: partial read — extract H1 description only, do not load full content
  let dirFiles;
  try { dirFiles = fs.readdirSync(state.dir).sort(); } catch (_) { return; }

  const seen = new Set();
  const built = [];

  for (const file of dirFiles) {
    if (!file.startsWith('tt-') || !file.endsWith('.md')) continue;
    const tagName = file.slice(0, -3);
    seen.add(tagName);

    const existing = state.files.get(tagName);
    if (existing) {
      built.push({ tag: tagName, description: existing.description, file });
      continue;
    }

    // Read only first 1 KB — enough for the H1 description line
    let description = '';
    let fd;
    try {
      fd = fs.openSync(path.join(state.dir, file), 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      description = parseDescription(buf.slice(0, n).toString('utf8'));
    } catch (_) {
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
    built.push({ tag: tagName, description, file });
  }

  // remove deleted tags from content cache
  for (const k of state.files.keys()) {
    if (!seen.has(k)) state.files.delete(k);
  }

  state.tagList = built;
  state.dirMtimeMs = dirStat.mtimeMs;
  state.dirScannedAt = Date.now();
  _startWatcher(state);
  _writeIndexIfChanged(state);
}

function listSystemTags(projectRoot) {
  const state = _getState(projectRoot);
  _rescan(state);
  return state.tagList;
}

function getTagArchitecture(tagName, projectRoot) {
  const state = _getState(projectRoot);
  const filePath = path.join(state.dir, `${tagName}.md`);
  const existing = state.files.get(tagName);

  if (existing && Date.now() - existing.loadedAt < TTL_MS) {
    stats.hits++;
    return existing.content;
  }

  if (existing && state.watcherActive) {
    existing.loadedAt = Date.now();
    stats.hits++;
    return existing.content;
  }

  let stat;
  try { stat = fs.statSync(filePath); } catch (err) {
    if (err.code === 'ENOENT') { state.files.delete(tagName); stats.misses++; return null; }
    throw err;
  }

  if (existing && existing.mtimeMs === stat.mtimeMs) {
    existing.loadedAt = Date.now();
    stats.mtimeRevalidations++;
    return existing.content;
  }

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') { state.files.delete(tagName); stats.misses++; return null; }
    throw err;
  }
  const description = parseDescription(content);
  state.files.set(tagName, { content, mtimeMs: stat.mtimeMs, loadedAt: Date.now(), description });
  stats.contentReads++;
  return content;
}

function invalidate(tagName, projectRoot) {
  const state = _getState(projectRoot);
  state.files.delete(tagName);
  state.dirScannedAt = 0; // force rescan of list on next listSystemTags
  stats.invalidations++;
}

// Invalidate cache entries for a batch of file keys returned by KB-sync pull
// operations. Only processes keys that match 'ai/architecture/tt-*.md'; all
// other keys (e.g. CLAUDE.md) are silently ignored. Safe to call with an empty
// or null array — no-op in that case.
function invalidateArchForKeys(keys, projectRoot) {
  if (!keys || !keys.length) return;
  for (const key of keys) {
    if (typeof key === 'string'
        && key.startsWith('ai/architecture/tt-')
        && key.endsWith('.md')) {
      invalidate(path.basename(key, '.md'), projectRoot);
    }
  }
}

module.exports = {
  ARCHITECTURE_DIR,
  resolveArchitectureDir: _resolveArchitectureDir,
  loadAll,
  listSystemTags,
  getTagArchitecture,
  invalidate,
  invalidateArchForKeys,
  getStats,
  resetStats,
};
