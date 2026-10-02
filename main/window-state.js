'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');
const { readProjectConfig, writeProjectConfig, writeProjectMcpConfig, writeProjectSkillsConfig, readProjectMeta, writeProjectMeta } = require('../src/server/project-config');
const { writeProjectCodexConfig } = require('../src/codex-mcp-config');
const { createPerProjectBackend } = require('../src/server/task-backend');

// Map<webContentsId, { projectPath, config, backend, unsubscribe }>
const _windows = new Map();

// Map<projectPath, { backend, sig, cfg }> — reuse same backend across windows.
// sig = JSON fingerprint of config fields that determine the remote target; on mismatch
// the cached backend is reconfigured in-place (same TASK_BACKEND) or rebuilt (type changed).
const _backendCache = new Map();

function _sig(cfg) {
  // The token is the signed-in account's, held in the app-level account store rather than in
  // the project's config.json; fingerprint it so a re-auth still invalidates the cached backend.
  let token = cfg?.API_TOKEN;
  try { token = require('../src/server/account-store').readAccount(cfg?.API_BASE_URL)?.token || token; } catch { /* store unreadable */ }
  return JSON.stringify([cfg?.TASK_BACKEND, cfg?.API_BASE_URL, cfg?.API_PROJECT_ID, token]);
}

function _safeSend(webContentsId, channel, payload) {
  const wc = BrowserWindow.getAllWindows()
    .map(w => w.webContents)
    .find(c => c && c.id === webContentsId);
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

function _getOrCreateBackend(projectPath, projectCfg) {
  const newSig = _sig(projectCfg);
  if (_backendCache.has(projectPath)) {
    const cached = _backendCache.get(projectPath);
    if (cached.sig === newSig) return cached.backend;
    // Config changed. Reconfigure in-place when the backend supports it. (C1353) Only one
    // backend type is reachable now (the file backend is retired, C1352) — every cached
    // backend is always the same type as a freshly-created one, so there is no more type
    // change to detect here; only reconfigureAndProbe's own availability gates this.
    if (cached.backend && typeof cached.backend.reconfigureAndProbe === 'function') {
      cached.backend.reconfigureAndProbe(projectCfg, projectPath).catch(() => {});
      cached.sig = newSig;
      cached.cfg = projectCfg;
      return cached.backend;
    }
    // reconfigureAndProbe unavailable — rebuild.
  }
  const backend = createPerProjectBackend(projectCfg, projectPath);
  _backendCache.set(projectPath, { backend, sig: newSig, cfg: projectCfg });
  backend.init().catch(err => {
    if (err && (err.authError || err.missingCredentials)) return;
    console.warn(`[window-state] backend.init failed for ${projectPath}:`, err.message);
  });
  return backend;
}

// C1218 — set once by main.js right after the forked server is up (setServerMessenger),
// used to delegate the auto-reindex run to that process instead of running it here. See
// the comment on _fireKbSync below for why main never runs reindexKnowledge itself.
let _sendToServer = null;
function setServerMessenger(fn) {
  _sendToServer = fn;
}

// TEST SEAM (C1323) — lets src/server/window-state-kb-sync.test.js observe *that* a bind
// scheduled a sync, for which root, and how many times — without real HTTP. No production
// call site sets this; passing null/undefined restores the real _fireKbSync below.
let _kbSyncScheduler = null;
function setKbSyncScheduler(fn) {
  _kbSyncScheduler = typeof fn === 'function' ? fn : null;
}

// Electron has no board WS sync trigger, so bind each window's project to a KB
// pull. Defer work past splash startup; server handles reindex and broadcasts
// its existing progress frames to the window.
function _fireKbSync(projectPath) {
  if (!projectPath) return;
  setImmediate(() => {
    try {
      require('../src/cli/knowledge-sync')
        // C1337 — {push:true}: this bind is Electron's ONLY automatic sync point for a
        // project window (the __board__ WS close-push never fires here — that socket is
        // opened lazily, only by an image paste or a Sync-KB/Re-Index click, see
        // tt-knowledge-sync.md § Sync Flow). Without the push half, a project opened,
        // browsed, and closed without ever hitting either of those pushed nothing —
        // exactly the "bunches of files to sync" backlog this task exists to close.
        .syncProjectKb(projectPath, 'window-bind', { push: true })
        .then(res => {
          if (res?.status === 'synced' && res.pulledCount > 0) {
            console.log(`[kb-sync:window-bind] pulled ${res.pulledCount} file(s) for ${projectPath}`);
          }
          if (res?.status === 'synced' && res.pushed && res.pushed.length > 0) {
            console.log(`[kb-sync:window-bind] pushed ${res.pushed.length} file(s) for ${projectPath}`);
          }
          if (res && !res.ok) {
            console.warn(`[kb-sync:window-bind] ${projectPath}: ${res.message}`);
          }
          if (res?.status === 'skipped-no-root' || res?.status === 'skipped-no-backend' || res?.status === 'skipped-no-creds') return;
          if (_sendToServer) {
            console.log(`[kb-reindex:window-bind] delegating stale-description check to task server for ${projectPath}`);
            try { _sendToServer({ type: 'kb:auto-reindex', projectPath }); } catch (err) { console.warn(`[kb-reindex:window-bind] delegate failed: ${err.message}`); }
          } else {
            console.warn(`[kb-reindex:window-bind] no server messenger wired yet — skipping auto-reindex check for ${projectPath}`);
          }
        }, () => {});
    } catch (err) {
      console.warn(`[kb-sync:window-bind] skipped: ${err.message}`);
    }
  });
}

function bindWindowToProject(webContentsId, projectPath) {
  if (!projectPath) {
    _windows.set(webContentsId, { projectPath: null, config: null, backend: null, unsubscribe: null });
    return;
  }

  const cfg = readProjectConfig(projectPath);
  if (!cfg) {
    // (C1352) No readable .tipatask/config.json — used to silently fall back to a file
    // backend ({ TASK_BACKEND: 'file' }), now retired. Reuse the same null-backend state as
    // the no-projectPath branch above; main.js's createProjectWindow detects this state and
    // sends setup:open-for-path so the renderer shows the setup wizard instead of an
    // unexplained empty board.
    _windows.set(webContentsId, { projectPath: null, config: null, backend: null, unsubscribe: null });
    return;
  }

  const backend = _getOrCreateBackend(projectPath, cfg);

  let unsubscribe = null;
  if (backend && typeof backend.onConnectionStateChange === 'function') {
    unsubscribe = backend.onConnectionStateChange((state, message) => {
      _safeSend(webContentsId, 'api:connection:changed', { state, message, projectPath });
    });
    // Push current state once so a freshly-loaded renderer can react.
    if (typeof backend.getConnectionState === 'function') {
      const cur = backend.getConnectionState();
      if (cur) setImmediate(() => _safeSend(webContentsId, 'api:connection:changed', { state: cur, message: null, projectPath }));
    }
  }

  _windows.set(webContentsId, { projectPath, config: cfg, backend, unsubscribe });
  (_kbSyncScheduler || _fireKbSync)(projectPath);
}

function getWindowState(webContentsId) {
  return _windows.get(webContentsId) || { projectPath: null, config: null, backend: null, unsubscribe: null };
}

function dropWindow(webContentsId) {
  const entry = _windows.get(webContentsId);
  if (entry && typeof entry.unsubscribe === 'function') {
    try { entry.unsubscribe(); } catch {}
  }
  _windows.delete(webContentsId);
}

function _updateCacheSig(projectPath, newConfig) {
  const cached = _backendCache.get(projectPath);
  if (cached) { cached.sig = _sig(newConfig); cached.cfg = newConfig; }
}

async function reconfigureWindowBackend(webContentsId, newConfig) {
  const entry = _windows.get(webContentsId);
  if (!entry || !entry.projectPath) throw new Error('No project bound to this window');
  writeProjectConfig(entry.projectPath, newConfig);

  // Sync project.json `name` when projectName changed (e.g. API-side rename detected on re-auth).
  if (newConfig.projectName) {
    try {
      const existingMeta = readProjectMeta(entry.projectPath);
      if (existingMeta.name !== newConfig.projectName) {
        writeProjectMeta(entry.projectPath, {
          ...existingMeta,
          name: newConfig.projectName,
          updatedAt: new Date().toISOString(),
        });
        // Refresh OS window title and send project:changed so the renderer updates name labels.
        try {
          const wc = BrowserWindow.getAllWindows()
            .map(w => w.webContents)
            .find(c => c && c.id === webContentsId);
          if (wc && !wc.isDestroyed()) {
            const win = BrowserWindow.fromWebContents(wc);
            if (win && !win.isDestroyed()) {
              win.setTitle(`${newConfig.projectName} — TipΔTask`);
            }
          }
          _safeSend(webContentsId, 'project:changed', entry.projectPath, newConfig.projectName);
        } catch (e) {
          console.warn('[window-state] title refresh failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[window-state] writeProjectMeta failed:', e.message);
    }
  }

  try {
    writeProjectMcpConfig(entry.projectPath, path.join(__dirname, '..'));
  } catch (e) {
    console.warn('[window-state] writeProjectMcpConfig failed:', e.message);
  }
  try {
    writeProjectSkillsConfig(entry.projectPath, path.join(__dirname, '..'));
  } catch (e) {
    console.warn('[window-state] writeProjectSkillsConfig failed:', e.message);
  }
  try {
    writeProjectCodexConfig(entry.projectPath, path.join(__dirname, '..'));
  } catch (e) {
    console.warn('[window-state] writeProjectCodexConfig failed:', e.message);
  }
  entry.config = newConfig;
  _updateCacheSig(entry.projectPath, newConfig);
  const backend = entry.backend;
  if (backend && typeof backend.reconfigureAndProbe === 'function') {
    return await backend.reconfigureAndProbe(newConfig, entry.projectPath);
  }
  if (backend && typeof backend.configure === 'function') {
    backend.configure(newConfig, entry.projectPath);
    if (typeof backend.init === 'function') await backend.init();
  }
  return backend && typeof backend.getConnectionState === 'function' ? backend.getConnectionState() : null;
}

module.exports = { bindWindowToProject, getWindowState, dropWindow, reconfigureWindowBackend, setServerMessenger, setKbSyncScheduler };
