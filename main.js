'use strict';
const { app } = require('electron');

app.setName('TipATask');
app.name = 'TipATask';
// (C1125) Windows silently drops native toasts for an app with no AppUserModelID —
// same invisible-failure class as the macOS unsigned-bundle notification drop below.
if (process.platform === 'win32') app.setAppUserModelId('com.tipatask.app');

// Set packaged user data before requiring server config; otherwise its paths resolve
// inside read-only app.asar. Dev config intentionally stays rooted in the checkout.
if (app.isPackaged) process.env.TIPATASK_USER_DATA = app.getPath('userData');

// Pin main and forked server to the same port before config reads .env; otherwise
// the main-process voice prewarm request can silently target the wrong port.
process.env.PORT = String(process.env.PORT || 4455);

// Enable main-process compile cache before other requires. Packaged __dirname is
// read-only app.asar; app.getPath('userData') provides a writable shared cache.
try {
  process.env.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE
    || require('node:path').join(app.getPath('userData'), 'v8-compile-cache');
  require('node:module').enableCompileCache(process.env.NODE_COMPILE_CACHE);
} catch { /* non-fatal — cache is a perf optimization, never load-bearing */ }
// startServer() forks the server child with {...process.env}, so NODE_COMPILE_CACHE
// propagates there too — the child gets a writable cache dir instead of its in-asar
// default. Node keys cache entries on file content + V8 version, so it self-invalidates
// across app/Electron upgrades — no manual cache-bust needed.

// (C1173) Process creation time, for the startup timing log emitted once the splash
// paints (see createSplashWindow() below) — this is the only way to measure the part
// of startup that runs before any of our own JS executes.
const _processCreatedAt = (() => {
  try { return process.getCreationTime ? process.getCreationTime() : null; } catch { return null; }
})();

const { BrowserWindow, Menu, shell, dialog, ipcMain, session, Notification, systemPreferences } = require('electron');
const { fork, execFile } = require('child_process');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { createNotificationOriginRegistry } = require('./main/notification-origins');
const { loadWorkspace, saveWorkspace } = require('./src/server/workspace-state');
// (C1430) Pure startup-restore precedence — no fs/electron, safe as top-level
// require (does not violate the C1173 no-module-scope-I/O rule below).
const { shouldRestoreFromDevice, resolveStartupProjectPaths } = require('./src/server/window-session');
const { readProjectConfig, writeProjectMcpConfig, writeProjectSkillsConfig } = require('./src/server/project-config');
const { getApiCredentials, getAccountUserId } = require('./src/server/api-credentials');
const { normalizeBaseUrl, readAccount } = require('./src/server/account-store');
const recentProjectsModel = require('./src/server/recent-projects');
const { writeProjectCodexConfig } = require('./src/codex-mcp-config');
const { bindWindowToProject, getWindowState, dropWindow, reconfigureWindowBackend, setServerMessenger } = require('./main/window-state');
const { shouldOpenExternally } = require('./main/external-links');
const { installProjectRequestHeaders } = require('./main/project-request-headers');
const { registerExternalIpcHandlers } = require('./main/ipc/external');
// (C1388) One-window-per-project registry — see window-registry.js header for why this is
// a separate, electron-free module: it's the one piece of this invariant that's unit-testable.
const windowRegistry = require('./main/window-registry');
// (C1388) Native-menu/dialog string table — see menu-i18n.js header for scope + exceptions.
const { LOCALES, setMenuLocale, getMenuLocale, mt } = require('./main/menu-i18n');
// (C1532) About + Third-Party Licenses windows — see about-window.js header.
const { openAboutWindow, openNoticesWindow } = require('./main/about-window');
const { createProjectAccessGate, projectAccessDialog } = require('./main/project-access');
const { resolveAppVersion } = require('./src/server/app-version');
const { ensureBundleSignatureHealthy } = require('./src/server/bundle-signature');
// (C1355) Duplicate-LaunchServices-claimant self-heal — see ls-registration.js's header comment.
const { ensureLaunchServicesHealthy, reregisterBundle } = require('./src/server/ls-registration');
// (C1173) registerApiHandlers (./main/ipc/api-router) and fetchLastUsedOpenProjects/
// patchDeviceOpenProjects (./src/server/api-backend) NOT required here anymore — both
// drag in src/server/config.js, whose MODULE SCOPE runs migrateFromLegacy() + a sync
// .env parse (reads, and on drift, sync writes) against a guessed project root before
// any project is bound. That cost used to run before app.whenReady, ahead of the splash
// (C1006) even existing. Required lazily at each call site instead — see
// registerApiHandlers() in the whenReady chain below, and restoreFromLastUsedDevice()/
// _syncOpenProjectsNow() further down. See tt-electron-app.md § Lifecycle.

// One-time migration (C915): the TipΔTask → TipATask rename moves app.getPath('userData')
// (app.setName drives it). On first launch under the new name, copy the old dir's entries
// into the new one so recent projects, window session, first-run suppression, and the
// packaged .env survive. Per-entry copy → never clobbers files already in the new dir
// (idempotent + safe even if Chromium pre-created cache dirs there).
// (C1173) Runs from the app.whenReady chain, right after the splash paints — NOT at
// module load anymore. Tradeoff: by then Chromium may already have created its own
// entries (Cache/, Code Cache/, Local Storage/, Network/, Preferences) in the new dir,
// and the existsSync guard below skips the old dir's copies of those — so renderer
// localStorage could be lost on this one migration launch. Everything this migration
// actually exists for (workspace.json, session.json, recent-projects.json, .env,
// .tipatask/config.json) is written by this app, never by Chromium, so it still
// migrates intact. See tt-electron-app.md § Lifecycle / userData migration.
function migrateUserDataDir() {
  try {
    const newDir = app.getPath('userData');                        // …/TipATask
    const oldDir = path.join(app.getPath('appData'), 'TipΔTask'); // exact old app name (U+0394)
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const entry of fs.readdirSync(oldDir)) {
      const dest = path.join(newDir, entry);
      if (fs.existsSync(dest)) continue;                          // keep anything already present
      fs.cpSync(path.join(oldDir, entry), dest, { recursive: true });
    }
    console.log('[migrate-userdata] migrated', oldDir, '→', newDir);
  } catch (e) {
    console.warn('[migrate-userdata] failed (non-fatal):', e.message);
  }
}
// (C1173) Call moved into app.whenReady, after the splash paints — see the function's
// own header comment above and createSplashWindow()'s caller below.

const PORT = process.env.PORT || 4455;
const LOCAL_SECRET = crypto.randomBytes(32).toString('base64url');
let serverChild = null;
let handoffDialogOpen = false;
// webContentsId → absolute project directory path
const projectDirs = new Map();
// (C1388) projectPath → BrowserWindow bookkeeping now lives in ./main/window-registry —
// see that module's header. Local destructure so call sites below stay short.
const { claimProject, ownerOf, releaseProject, claimSetup, setupFor, releaseSetup, openProjectPaths } = windowRegistry;

// (C1069) Single impl of restore-before-focus seq (C964). Used by every path that surfaces an
// EXISTING window — was 6 hand-copied dupes before this.
//
// `steal` also activates whole app on macOS. MUST run BEFORE per-window calls.
// app.focus({steal:true}) → -[NSApplication activateIgnoringOtherApps:] → activates APP, AppKit
// picks key window from its OWN order. Called AFTER w.focus() (pre-C1069 both steal sites did
// this) it re-raises whatever window was key before, undoing the makeKeyAndOrderFront we just
// issued. That was the bug: 2 project windows open, click project B's notif while A frontmost →
// A stays on top. Fix: activate app first, key target window after.
function focusWindow(w, { steal = false } = {}) {
  if (!w || w.isDestroyed()) return false;
  if (steal && process.platform === 'darwin') {
    try { app.focus({ steal: true }); } catch { /* non-fatal */ }
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  // Belt-and-braces vs AppKit re-order after app-level activate above. Gated on `steal` so 4
  // menu/IPC sites keep pre-C1069 semantics byte-for-byte.
  if (steal) w.moveTop();
  return true;
}

// (C1069) tag + project path → notif origin. Main-process Notification carries no window identity of
// its own. Store PROJECT PATH (not just window) — survives `project:open target:'current'`,
// which reloads SAME webContents into DIFFERENT project. Values = plain ids/strings only, no
// BrowserWindow/WebContents retained → entry can never keep closed window alive.
const notifyOrigins = createNotificationOriginRegistry();

function rememberNotifyOrigin(tag, origin) {
  return notifyOrigins.remember(tag, origin);
}

// Prefer window that owns origin's project NOW; fall back to window that sent the IPC. Null if
// neither survives.
function resolveNotifyTarget(origin) {
  if (!origin) return null;
  const byProject = origin.projectPath ? ownerOf(origin.projectPath) : null;
  if (byProject) return byProject;
  const byId = origin.windowId != null ? BrowserWindow.fromId(origin.windowId) : null;
  return (byId && !byId.isDestroyed()) ? byId : null;
}

// (C1141/C1318) codesign --verify result for the running .app — see src/server/
// bundle-signature.js and ai/architecture/tt-notifications.md § C1141/§ C1318. Distinct from
// notify:show's pre-existing isCodeSigned() (only checks _CodeSignature EXISTS, not that the
// seal is still intact). null means "never actually checked" — see signatureStatus() below,
// which (C1318) stopped treating that the same as "verified healthy": a seal broken AFTER the
// one-time startup check (runBundleSignatureCheck, before the server forks) used to stay
// invisible for the rest of the session; refreshBundleSignatureState() below re-verifies on a
// TTL so a later break — e.g. a fresh stray write reappearing — is caught without a relaunch.
let _bundleSignatureState = null;
let _bundlePath = null; // set by runBundleSignatureCheck(), darwin+packaged only
let _lastSignatureCheckAt = 0;
const SIGNATURE_RECHECK_TTL_MS = 60000;

// (C1318) Direct "did macOS actually register this bundle with Notification Center" signal —
// would have caught all three notification regressions (C1125 unsigned, C1141 seal-broken-by-
// Contents/Resources-write, C1318 seal-broken-by-bundle-root-write) regardless of cause,
// since none of them are guessable in advance. Warning-only: null (unknown — `defaults`
// itself failed, or non-darwin/unpackaged) must never be treated as "not registered", and a
// genuinely fresh install legitimately has no entry yet until the FIRST successful send — so
// this never gates notify:show, only informs notify:status/Settings.
let _ncRegistrationState = null; // true | false | null

// (C1355) Duplicate-claimant self-heal result, folded in alongside the signature check below —
// `{ registered, conflicts, staleCount, installerVolumes, repaired, relaunchNeeded }` or `null`
// before the first check / outside darwin+packaged. See ls-registration.js.
let _lsRegistrationState = null;

async function checkNotificationCenterRegistration(bundleId) {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = execFile('defaults', ['read', 'com.apple.ncprefs'], { timeout: 5000 }, (err, stdout) => {
        if (err) { settle(null); return; } // e.g. no ncprefs at all yet — unknown, not "false"
        settle(String(stdout).includes(bundleId));
      });
    } catch { settle(null); return; }
    const backstop = setTimeout(() => { try { child?.kill(); } catch { /* best-effort */ } settle(null); }, 7000);
    if (typeof backstop.unref === 'function') backstop.unref();
  });
}

// (C1318) Shared by the one-time startup check and every later notify:status poll — TTL'd so
// a Settings-modal open (which calls notify:status) can't spam `codesign`/`defaults` on every
// click, but a seal that breaks mid-session is still caught within a minute instead of only at
// next relaunch. `ensureBundleSignatureHealthy` is safe to call repeatedly: cleanup/rescue are
// idempotent no-ops once nothing is stray, and the re-sign (repair) step stays gated to once
// per app version by its own marker file regardless of call count.
async function refreshBundleSignatureState({ force = false } = {}) {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    _bundleSignatureState = { valid: true, reason: null, relaunchNeeded: false };
    return _bundleSignatureState;
  }
  const now = Date.now();
  if (!force && _bundleSignatureState && (now - _lastSignatureCheckAt) < SIGNATURE_RECHECK_TTL_MS) {
    return _bundleSignatureState;
  }
  _lastSignatureCheckAt = now;
  try {
    _bundlePath = _bundlePath || path.resolve(process.resourcesPath, '..', '..'); // .../TipATask.app
    const [sig, ls] = await Promise.all([
      ensureBundleSignatureHealthy({
        bundlePath: _bundlePath,
        version: app.getVersion(),
        markerDir: app.getPath('userData'),
      }),
      // (C1355) Same TTL, same startup timing — a duplicate-claimant conflict is exactly as
      // invisible as a broken seal, and both need re-checking on the same cadence.
      ensureLaunchServicesHealthy({
        bundlePath: _bundlePath,
        bundleId: 'com.tipatask.app',
        version: app.getVersion(),
        markerDir: app.getPath('userData'),
      }),
      checkNotificationCenterRegistration('com.tipatask.app').then((r) => { _ncRegistrationState = r; }),
    ]);
    _bundleSignatureState = sig;
    _lsRegistrationState = ls;
  } catch (e) {
    console.warn('[bundle-signature] check failed (non-fatal):', e.message);
    // (C1355) `valid: null` ("unknown"), NOT `false` — a `false` here used to hard-block EVERY
    // notification for the rest of the session via notify:show's `signatureStatus().valid ===
    // false` gate below, with no way to recover short of reopening Settings (the only other
    // caller of this function). That directly contradicts this module's own C1318 design ("a
    // `null` state must pass through, never block a send") and reproduces the exact
    // "notifications just stopped" symptom this whole file exists to prevent — a single slow or
    // failed `codesign --verify`/`lsregister -dump` at boot (plausible on a bundle with tens of
    // thousands of sealed files) must not be worse than never having checked at all.
    _bundleSignatureState = { valid: null, reason: e.message || 'check-failed', relaunchNeeded: false };
  }
  return _bundleSignatureState;
}

// (C1141) Native Notification has no JS-side owner once new Notification(...) returns —
// nothing downstream closed over it (click/close/failed handlers close over tag/origin only).
// V8 can collect the wrapper before macOS decides show/failed, which would silently surface
// as the 1.5s not-delivered timeout with no real cause. Keep a live reference from creation
// until its terminal event, same plain-values-only + FIFO-backstop shape as notifyOrigins
// above so a leak can never hold a window/webContents alive either.
const _liveNotifications = new Map();     // seq -> Notification
const NOTIFY_LIVE_MAX = 200;
let _notifyLiveSeq = 0;

let workspaceState = null;
const SESSION_FILE = 'session.json';
const RECENT_PROJECTS_FILE = 'recent-projects.json';

let _confirmingQuit = false;
let _quitConfirmed = false;
// Prevent concurrent browser-OAuth flows (authenticate() opens a system browser tab).
let _forceReauthInFlight = false;
// (C1429) Windows cleared to close without another confirmWindowClose() prompt — set
// right before the code that already asked (project:close/project:remove handlers,
// or a Cancel-free confirmWindowClose pass) calls w.close(). A window can only be
// closed once, so no explicit cleanup needed.
const _closeConfirmed = new WeakSet();

// Access must be checked before binding a backend (which starts task/KB requests).
const ensureProjectAccess = createProjectAccessGate({
  readConfig: (dir) => readProjectConfig(dir)
    || require('./src/server/project-config').migrateFromLegacy(dir),
  getCredentials: getApiCredentials,
  request: (...args) => require('./src/cli/http').request(...args),
  reauthenticate: async (baseUrl) => {
    if (_forceReauthInFlight) throw new Error('Sign-in already in progress');
    _forceReauthInFlight = true;
    try {
      await require('./src/cli/auth').authenticateAndStore(baseUrl);
    } finally {
      _forceReauthInFlight = false;
    }
  },
  prompt: async (config, dir, kind) => {
    closeSplash();
    const { response } = await dialog.showMessageBox(projectAccessDialog(config, dir, kind));
    return response === 0;
  },
  showError: async (config, dir, kind) => {
    closeSplash();
    await dialog.showMessageBox(projectAccessDialog(config, dir, kind));
  },
  onAccountChanged: () => {
    if (app.isReady()) createMenu();
    reconcileRecentProjectsWithAccounts();
  },
});

// ── Recent projects menu state ────────────────────────────────────────────────
function getRecentProjectsPath() {
  return path.join(app.getPath('userData'), RECENT_PROJECTS_FILE);
}

// Raw entries as stored: { path, userId, apiBaseUrl } (legacy files hold bare path strings).
function loadRecentEntries() {
  try {
    const raw = fs.readFileSync(getRecentProjectsPath(), 'utf8');
    return recentProjectsModel.normalizeRecentEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

function saveRecentEntries(entries) {
  const filePath = getRecentProjectsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(recentProjectsModel.normalizeRecentEntries(entries), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// (TPT451) Paths the CURRENTLY signed-in account may see: each entry is matched against the
// account-store user id of its own API server. Signed out -> empty list.
function loadRecentProjects() {
  return recentProjectsModel.visibleRecentPaths(loadRecentEntries(), (base) => getAccountUserId(base));
}

function updateRecentProjects(projectPath) {
  if (!projectPath) return;
  try {
    const apiBaseUrl = normalizeBaseUrl(readProjectConfig(projectPath)?.API_BASE_URL);
    const entry = { path: projectPath, userId: apiBaseUrl ? getAccountUserId(apiBaseUrl) : null, apiBaseUrl };
    saveRecentEntries(recentProjectsModel.upsertRecentEntry(loadRecentEntries(), entry));
  } catch (e) {
    console.warn('[recent-projects] save failed', e.message);
  }
}

// (TPT451) Pre-per-user entries carry no owner. Once the signed-in user's own project list is
// fetched, keep the ones whose project that user can access (stamping them) and drop the rest.
// Best-effort: offline/failed fetches leave legacy entries on disk (hidden) for the next run.
async function reconcileRecentProjectsWithAccounts() {
  try {
    let entries = loadRecentEntries();
    const bases = new Set();
    const infoCache = new Map();
    const projectInfoFor = (p) => {
      if (!infoCache.has(p)) {
        const cfg = readProjectConfig(p);
        const apiBaseUrl = normalizeBaseUrl(cfg?.API_BASE_URL);
        infoCache.set(p, cfg && apiBaseUrl && cfg.API_PROJECT_ID != null ? { apiBaseUrl, projectId: cfg.API_PROJECT_ID } : null);
      }
      return infoCache.get(p);
    };
    for (const e of entries) {
      if (e.userId != null) continue;
      const info = projectInfoFor(e.path);
      if (info) bases.add(info.apiBaseUrl);
    }
    let changed = false;
    for (const apiBaseUrl of bases) {
      const account = readAccount(apiBaseUrl);
      const userId = getAccountUserId(apiBaseUrl);
      if (!account || userId == null) continue;
      const res = await fetch(`${apiBaseUrl}/api/projects`, { headers: { Authorization: `Bearer ${account.token}` } });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data?.projects || data?.data || []);
      entries = recentProjectsModel.reconcileLegacyEntries(entries, {
        apiBaseUrl, userId, projectIds: list.map((p) => p.id), projectInfoFor,
      });
      changed = true;
    }
    if (changed) {
      saveRecentEntries(entries);
      if (app.isReady()) createMenu();
    }
  } catch (e) {
    console.warn('[recent-projects] reconcile failed', e.message);
  }
}

function rememberRecentProject(projectPath) {
  if (!projectPath) return;
  updateRecentProjects(projectPath);
  if (app.isReady()) createMenu();
}

async function confirmAndQuit() {
  if (_confirmingQuit || _quitConfirmed) return;
  _confirmingQuit = true;
  try {
    const { response } = await dialog.showMessageBox(null, {
      type: 'question',
      buttons: mt('confirm.quitButtons'),
      defaultId: 0,
      cancelId: 1,
      title: mt('confirm.quitTitle'),
      message: mt('confirm.quitMessage'),
      detail: mt('confirm.quitDetail'),
    });
    if (response === 0) {
      _quitConfirmed = true;
      _confirmingQuit = true;
      app.quit();
      return;
    }
  } catch (e) {
    console.warn('[quit] confirmation failed', e?.message || e);
  } finally {
    if (!_quitConfirmed) _confirmingQuit = false;
  }
}

function quitWithoutConfirmation() {
  _quitConfirmed = true;
  app.quit();
}

// (C1429) Backstop for close paths that never reach the renderer's project:menu
// 'close' handler. C1428 routes Ctrl+W through that guarded path on every platform
// (see the Window submenu comment above — no role:'close' left to bypass it), but the
// OS title-bar close button/X still calls BrowserWindow.close() directly, as would any
// future direct w.close() call this file adds. Probes renderer state over
// executeJavaScript (same pattern as showVoiceShortcutDiagnostics) and fails open — a
// broken/unloaded renderer must never trap a window shut.
async function confirmWindowClose(w) {
  let info = null;
  try {
    info = await w.webContents.executeJavaScript(
      'window.TipTask && window.TipTask.taskBoard && typeof window.TipTask.taskBoard.closeGuardState === "function"'
      + ' ? window.TipTask.taskBoard.closeGuardState() : null'
    );
  } catch (e) {
    console.warn('[close-guard] state probe failed', e?.message || e);
    return true;
  }
  // (C1485) sessions-only — a prior activeTasks (board-status) count removed, it warned
  // even with zero sessions ever started. See task-board.js closeGuardState().
  if (!info || !info.sessions) return true;
  const detail = mt('confirm.closeProjectDetailSessions').replace('{n}', info.sessions);
  try {
    const { response } = await dialog.showMessageBox(w, {
      type: 'question',
      buttons: mt('confirm.closeProjectButtons'),
      defaultId: 1,
      cancelId: 1,
      title: mt('confirm.closeProjectTitle'),
      message: mt('confirm.closeProjectMessage'),
      detail,
    });
    return response === 0;
  } catch (e) {
    console.warn('[close-guard] confirm dialog failed', e?.message || e);
    return true;
  }
}

// (C1388/C1429) Shared close-guard wiring, extracted so createSetupWindow can carry it
// too — a setup window that adopts a project (project:open-existing) BECOMES a real
// project window with live agent sessions behind an unguarded title-bar X, which was a
// gap in the original C1429 guard (only createProjectWindow had it).
function attachCloseGuard(w) {
  w.on('close', (e) => {
    if (_closeConfirmed.has(w) || _quitConfirmed || _confirmingQuit) return;
    e.preventDefault();
    void (async () => {
      if (!(await confirmWindowClose(w))) return;
      if (w.isDestroyed()) return;
      _closeConfirmed.add(w);
      w.close();
    })();
  });
}

// ── Startup workspace validation ──────────────────────────────────────────────
function isValidProjectPath(projectPath) {
  if (!projectPath) return false;
  if (!fs.existsSync(projectPath)) return false;
  const projectJsonPath = path.join(projectPath, '.tipatask', 'project.json');
  if (!fs.existsSync(projectJsonPath)) return true;
  try {
    const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
    if (projectJson.apiProjectId != null) {
      const config = readProjectConfig(projectPath);
      if (config && String(config.API_PROJECT_ID) !== String(projectJson.apiProjectId)) return false;
    }
  } catch { return false; }
  return true;
}

function filterValidWorkspaceProjects(state) {
  const valid = (state.openProjects || []).filter(entry => {
    if (!entry || !entry.path) return false;
    return isValidProjectPath(entry.path);
  });
  const activeSurvived = valid.some(e => e.path === state.activeProjectPath);
  return {
    openProjects: valid,
    activeProjectPath: activeSurvived ? state.activeProjectPath : null,
  };
}

// ── Window session restore ───────────────────────────────────────────────────
function getSessionPath() {
  return path.join(app.getPath('userData'), SESSION_FILE);
}

function getOpenProjectPaths() {
  // (C1388) Delegates to the registry — feeds saveWindowSession() below AND the
  // cross-device open_project_ids PATCH (_syncOpenProjectsNow()), so a corrupted
  // registry entry used to silently break both. See window-registry.js.
  return openProjectPaths();
}

function saveWindowSession() {
  try {
    const sessionPath = getSessionPath();
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const tmp = `${sessionPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(getOpenProjectPaths(), null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sessionPath);
  } catch (e) {
    console.warn('[session] save failed', e.message);
  }
}

// (C1430) Return-value contract feeds window-session.js's resolveStartupProjectPaths():
//   null → file missing/unreadable/non-JSON-array (no record — first launch, or lost file).
//   []   → file present, valid JSON array, but empty OR every entry failed isValidProjectPath.
//          Treated as an explicit "nothing was open" signal, same as a real empty session.
//          Deliberate: falling back to workspace.json here would be worse, since
//          restoreFromLastUsedDevice()/workspace paths are never re-validated before being
//          handed to createProjectWindow() — a dead directory would just re-fail there,
//          landing the user in the setup wizard instead of a blank window.
//   [...]→ the restored window set, verbatim.
function loadWindowSession() {
  try {
    const raw = fs.readFileSync(getSessionPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set();
    const paths = [];
    for (const projectPath of parsed) {
      if (typeof projectPath !== 'string' || !projectPath || seen.has(projectPath)) continue;
      if (!isValidProjectPath(projectPath)) continue;
      seen.add(projectPath);
      paths.push(projectPath);
    }
    if (parsed.length > 0 && paths.length === 0) {
      // Every persisted path failed validation (unmounted volume, not-yet-materialized
      // cloud-sync dir, deleted project). Diagnosable in logs instead of silently
      // indistinguishable from a real "closed everything" empty session.
      console.warn('[session] all persisted project paths failed validation — treating as empty');
    }
    return paths;
  } catch {
    return null;
  }
}

// ── Workspace mutation helpers ────────────────────────────────────────────────
function addToWorkspace(dir, name) {
  if (!workspaceState) return;
  workspaceState.openProjects = workspaceState.openProjects.filter(p => p.path !== dir);
  workspaceState.openProjects.push({ path: dir, name, lastOpened: new Date().toISOString() });
  workspaceState.activeProjectPath = dir;
  persistWorkspace();
}
function removeFromWorkspace(dir) {
  if (!workspaceState) return;
  workspaceState.openProjects = workspaceState.openProjects.filter(p => p.path !== dir);
  if (workspaceState.activeProjectPath === dir) {
    workspaceState.activeProjectPath = workspaceState.openProjects.at(-1)?.path || null;
  }
  persistWorkspace();
}
function persistWorkspace() {
  try { saveWorkspace(app.getPath('userData'), workspaceState); } catch (e) { console.warn('[workspace] save failed', e.message); }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('workspace-loaded', workspaceState);
  }
}

// ── Project meta helpers ──────────────────────────────────────────────────────
const META_REL = path.join('.tipatask', 'project.json');

function readProjectMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META_REL), 'utf8'));
  } catch {
    return { name: path.basename(dir), apiProjectId: null };
  }
}

function writeProjectMeta(dir, meta) {
  const metaDir = path.join(dir, '.tipatask');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(dir, META_REL), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// Persist + return the stable machine-local device UUID (shared across all projects on this machine).
function getOrCreateMachineId() {
  const crypto = require('node:crypto');
  const os = require('node:os');
  const DEVICE_ID_DIR = path.join(os.homedir(), '.tipatask');
  const DEVICE_ID_PATH = path.join(DEVICE_ID_DIR, 'device_id');
  try {
    return fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
  } catch {
    const id = crypto.randomUUID();
    fs.mkdirSync(DEVICE_ID_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_PATH, id, 'utf8');
    return id;
  }
}

// Adopt an already-configured project into the sender's window in-place (no page reload
// of the SENDER — see the owner-healing branch below, which may reload a DIFFERENT window).
// Mirrors the project:open 'current' bookkeeping. Call AFTER writeProjectMeta so that
// getDisplayName returns the API name rather than the folder basename.
//
// (C1388) Returns a result object instead of nothing, because this can now REFUSE to
// adopt: if another live window already owns projectRoot (e.g. the sender is a setup
// window that just finished a wizard for a path someone else opened moments ago), a
// second owner in windowRegistry would orphan the first — see window-registry.js and
// tt-electron-app.md § One window per project. Callers must handle both shapes:
//   { adopted: true }                                    — sender adopted normally
//   { adopted: false, focused: true, healed, reloaded }  — refused; owner focused instead
//   { adopted: false, focused: false, reason: 'sender-gone' }
async function adoptProjectIntoWindow(senderWebContents, projectRoot) {
  if (!await ensureProjectAccess(projectRoot)) return { adopted: false, focused: false, reason: 'access-denied' };
  const w = BrowserWindow.fromWebContents(senderWebContents);
  if (!w || w.isDestroyed()) return { adopted: false, focused: false, reason: 'sender-gone' };

  // Project-level bookkeeping runs on BOTH branches below — it's about the PROJECT, not
  // the window, and project:switch (main.js) requires workspace membership to work at
  // all. Skipping this on refusal would leave a now-fully-configured project unreachable
  // from Recent Projects / the workspace list.
  addToWorkspace(projectRoot, getDisplayName(projectRoot));
  rememberRecentProject(projectRoot);

  const owner = ownerOf(projectRoot);
  if (owner && owner !== w) {
    // Someone already owns this path. HEAL that window instead of just focusing it —
    // the realistic trigger is the owner sitting in the C1352 null-backend state with
    // the config we just finished writing here, so a bare focus would hand the user a
    // dead board next to a stale wizard.
    const oc = owner.webContents.id;
    const before = getWindowState(oc);
    dropWindow(oc);
    bindWindowToProject(oc, projectRoot);
    const after = getWindowState(oc);
    projectDirs.set(oc, projectRoot);
    owner.setTitle(getWindowTitle(getDisplayName(projectRoot)));
    // project:changed alone won't re-render here: template.html's handler early-returns
    // when dir === the value it seeded from its own ?projectPath= at boot, which is
    // true for the owner. Reload only when something actually changed for it — the
    // codebase already avoids reloading windows with live sessions where avoidable.
    const needsReload = !before.backend
      || String(before.config?.API_PROJECT_ID ?? null) !== String(after.config?.API_PROJECT_ID ?? null);
    if (needsReload) {
      owner.webContents.reload();
    } else {
      owner.webContents.send('project:changed', projectRoot, getDisplayName(projectRoot));
    }
    scheduleOpenProjectsSync();
    focusWindow(owner);
    return { adopted: false, focused: true, healed: true, reloaded: needsReload };
  }

  const wcId = senderWebContents.id;
  const oldDir = projectDirs.get(wcId);
  releaseProject(oldDir, w);
  releaseSetup(w);
  dropWindow(wcId);
  projectDirs.set(wcId, projectRoot);
  claimProject(projectRoot, w);
  bindWindowToProject(wcId, projectRoot);
  w.setTitle(getWindowTitle(getDisplayName(projectRoot)));
  scheduleOpenProjectsSync();
  senderWebContents.send('project:changed', projectRoot, getDisplayName(projectRoot));
  return { adopted: true };
}

function getDisplayName(dir) {
  if (!dir) return 'TipΔTask';
  const meta = readProjectMeta(dir);
  return meta.name || path.basename(dir);
}

// Canonical window title: "<projectName> — TipΔTask", or bare brand when no project.
function getWindowTitle(projectName) {
  const name = String(projectName || '').trim();
  if (!name || name === 'TipΔTask') return 'TipΔTask';
  return `${name} — TipΔTask`;
}

async function renameApiProject(projectRoot, apiProjectId, name) {
  let credentials;
  try {
    credentials = getApiCredentials(projectRoot);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const { baseUrl, token } = credentials;
  const res = await fetch(`${baseUrl}/api/projects/${apiProjectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return { ok: false, error: `API returned ${res.status}` };
  return { ok: true };
}

// ── Open-project sync helpers ─────────────────────────────────────────────────

// Build apiProjectId (number) → local path index from workspace + recent projects.
function buildProjectIdToPathIndex() {
  const index = new Map();
  const paths = new Set();
  for (const entry of workspaceState?.openProjects || []) {
    if (entry?.path) paths.add(entry.path);
  }
  for (const p of loadRecentProjects()) paths.add(p);
  for (const projectPath of paths) {
    const meta = readProjectMeta(projectPath);
    if (meta.apiProjectId != null) index.set(Number(meta.apiProjectId), projectPath);
  }
  return index;
}

// (C1389) Web→Task App handoff — like buildProjectIdToPathIndex() above (same candidate
// paths: workspaceState.openProjects + recent-projects.json), but returns EVERY local path
// bound to apiProjectId instead of collapsing to one via a Map — two separate checkouts of
// the same project is a real case /open-objective's picker page needs to offer, not silently
// resolve to whichever one iterated last.
function resolveLocalPathsForApiProjectId(apiProjectId) {
  const paths = new Set();
  for (const entry of workspaceState?.openProjects || []) {
    if (entry?.path) paths.add(entry.path);
  }
  for (const p of loadRecentProjects()) paths.add(p);
  const target = String(apiProjectId);
  const matches = [];
  for (const projectPath of paths) {
    const meta = readProjectMeta(projectPath);
    if (meta.apiProjectId != null && String(meta.apiProjectId) === target) matches.push(projectPath);
  }
  return matches;
}

// Fetch open_project_ids from the user's most recently active other device and
// resolve them to local paths. Returns [] on any error or if nothing is resolvable.
async function restoreFromLastUsedDevice() {
  const candidates = new Set();
  for (const entry of workspaceState?.openProjects || []) {
    if (entry?.path) candidates.add(entry.path);
  }
  for (const projectPath of loadRecentProjects()) candidates.add(projectPath);

  let context = null;
  for (const projectPath of candidates) {
    const cfg = readProjectConfig(projectPath);
    if (!cfg?.DEVICE_ID) continue;
    try {
      context = { ...getApiCredentials(projectPath), deviceId: cfg.DEVICE_ID };
      break;
    } catch { /* try next known project */ }
  }
  if (!context) return [];
  const { baseUrl: apiBaseUrl, token: apiToken, deviceId } = context;
  try {
    // (C1173) Lazy require — see the top-of-file note by the deleted top-level
    // require for why (drags in src/server/config.js's module-scope I/O).
    const { fetchLastUsedOpenProjects } = require('./src/server/api-backend');
    const result = await fetchLastUsedOpenProjects({
      apiBaseUrl, apiToken, excludeDeviceId: Number(deviceId),
    });
    if (!result || !Array.isArray(result.open_project_ids) || result.open_project_ids.length === 0) return [];
    const index = buildProjectIdToPathIndex();
    return result.open_project_ids.map(id => index.get(Number(id))).filter(Boolean);
  } catch (e) {
    console.warn('[open-projects] restore failed:', e.message);
    return [];
  }
}

// Debounced PATCH to keep device.open_project_ids in sync with open windows.
let _syncTimer = null;
function scheduleOpenProjectsSync() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { _syncOpenProjectsNow().catch(() => {}); }, 500);
}
async function _syncOpenProjectsNow() {
  const openProjectPaths = getOpenProjectPaths();
  let syncConfig = null;
  for (const projectPath of openProjectPaths) {
    const cfg = readProjectConfig(projectPath);
    if (!cfg?.DEVICE_ID) continue;
    try {
      const credentials = getApiCredentials(projectPath);
      syncConfig = {
        API_BASE_URL: credentials.baseUrl,
        API_TOKEN: credentials.token,
        DEVICE_ID: cfg.DEVICE_ID,
      };
      break;
    } catch { /* try next open project */ }
  }
  const { API_BASE_URL: apiBaseUrl, API_TOKEN: apiToken, DEVICE_ID: deviceId } = syncConfig || {};
  if (!apiBaseUrl || !apiToken || !deviceId) return;
  const ids = openProjectPaths
    .map(p => { const m = readProjectMeta(p); return m.apiProjectId != null ? Number(m.apiProjectId) : null; })
    .filter(id => id != null);
  // (C1173) Lazy require — same reasoning as restoreFromLastUsedDevice() above.
  const { patchDeviceOpenProjects } = require('./src/server/api-backend');
  await patchDeviceOpenProjects({ apiBaseUrl, apiToken, deviceId: Number(deviceId), openProjectIds: [...new Set(ids)] });
}


function getIconPath() {
  const ext = process.platform === 'darwin' ? '.icns' : process.platform === 'win32' ? '.ico' : '.png';
  return path.join(__dirname, 'assets', 'icon' + ext);
}

function getDockIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function registerIpcHandlers() {
  registerExternalIpcHandlers({
    ipcMain, shell, BrowserWindow, projectDirs, app,
    appOrigin: `http://localhost:${PORT}`,
  });
  const safeSend = (sender, channel, ...args) => {
    if (!sender.isDestroyed()) sender.send(channel, ...args);
  };

  ipcMain.handle('project:open', async (event, { dir, target }) => {
    if (target !== 'current') {
      await createProjectWindow(dir);
      return;
    }
    if (!await ensureProjectAccess(dir)) return;
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isDestroyed()) return;
    addToWorkspace(dir, getDisplayName(dir));
    rememberRecentProject(dir);

    // Another window already owns this project — focus it, leave caller intact.
    const owner = ownerOf(dir);
    if (owner && owner !== w) {
      if (focusWindow(owner)) return;
    }

    const wcId = w.webContents.id;
    const oldDir = projectDirs.get(wcId);
    releaseProject(oldDir, w);
    releaseSetup(w);

    dropWindow(wcId);
    projectDirs.set(wcId, dir);
    claimProject(dir, w);
    scheduleOpenProjectsSync();
    bindWindowToProject(wcId, dir);
    w.setTitle(getWindowTitle(getDisplayName(dir)));

    w.webContents.once('did-finish-load', () => {
      if (w.isDestroyed()) return;
      w.webContents.send('workspace-loaded', workspaceState);
      w.webContents.send('project:changed', dir, getDisplayName(dir));
    });
    w.loadURL(`http://127.0.0.1:${PORT}/todo.html${dir ? '?projectPath=' + encodeURIComponent(dir) : ''}`);
  });

  ipcMain.handle('project:get-current', (event) => {
    return projectDirs.get(event.sender.id) || null;
  });

  ipcMain.handle('project:open-dialog', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(w, {
      properties: ['openDirectory'],
      title: mt('dialog.selectProjectDirectory'),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // open-project — pick dir + read its .tipatask/config.json.
  // Returns null (cancelled), { path, needsSetup: true } (no config), or { path, config }.
  ipcMain.handle('open-project', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(w, {
      // (C1388) createDirectory added — the unified Open/Create flow (B) picks a
      // folder BEFORE knowing whether it'll be a fresh project, so the picker must
      // support making a new one. Without this flag macOS hides NSOpenPanel's New
      // Folder button entirely.
      properties: ['openDirectory', 'createDirectory'],
      title: mt('dialog.openProjectDirectory'),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const picked = result.filePaths[0];
    let cfg = readProjectConfig(picked);
    if (!cfg) {
      // Auto-migrate legacy .env if present — avoids wizard for existing projects.
      const { migrateFromLegacy } = require('./src/server/project-config');
      cfg = migrateFromLegacy(picked);
    }
    if (!cfg) return { path: picked, needsSetup: true };
    try { writeProjectMcpConfig(picked, __dirname); } catch (e) {
      console.warn('[mcp-config] open-project .mcp.json write failed:', e.message);
    }
    try { writeProjectSkillsConfig(picked, __dirname); } catch (e) {
      console.warn('[skills-config] open-project write failed:', e.message);
    }
    try { writeProjectCodexConfig(picked, __dirname); } catch (e) {
      console.warn('[codex-config] open-project write failed:', e.message);
    }
    const { rendererProjectConfig } = require('./src/server/project-config');
    return { path: picked, config: rendererProjectConfig(cfg) };
  });

  ipcMain.handle('project:close', (event) => {
    // Each project owns its window — "close project" means close this window.
    const w = BrowserWindow.fromWebContents(event.sender);
    // (C1429, caller narrowed in C1486) The Close Project menu item no longer calls this —
    // it closes the window directly so it hits confirmWindowClose()'s dialog like the
    // title-bar X. This handler's only remaining caller is the setup-wizard cancel flow
    // (setup-modal.js), which intentionally skips the confirm dialog.
    if (w && !w.isDestroyed()) { _closeConfirmed.add(w); w.close(); }
  });

  ipcMain.handle('load-workspace', () => workspaceState);

  ipcMain.handle('save-workspace', (_, state) => {
    workspaceState = state;
    saveWorkspace(app.getPath('userData'), state);
    return { ok: true };
  });

  ipcMain.handle('project:switch', async (_event, projectPath) => {
    if (!workspaceState?.openProjects?.some(p => p.path === projectPath)) return { ok: false, error: 'Not in workspace' };
    // The shared opener checks access before focusing or creating the owner window.
    if (!await createProjectWindow(projectPath)) return { ok: false, canceled: true };
    workspaceState.activeProjectPath = projectPath;
    persistWorkspace();
    return { ok: true };
  });

  // (C1388) Deliberately project-window-only — do NOT fold in setupFor() here.
  // switchProject()/focusProjectWindow() (client) and the notification-click router
  // both share this channel; "focus a setup window" is meaningless for either. The
  // unified open flow's setup-window dedupe lives in project:open-setup-window instead.
  ipcMain.handle('project:focus-window', async (_event, projectPath) => {
    if (!ownerOf(projectPath)) return { ok: false };
    if (!await ensureProjectAccess(projectPath)) return { ok: false, canceled: true };
    return { ok: focusWindow(ownerOf(projectPath)) };
  });

  ipcMain.handle('window:focus-self', (event) => {
    return { ok: focusWindow(BrowserWindow.fromWebContents(event.sender), { steal: true }) };
  });

  // (C1388) Native menu locale — the menu is app-global on macOS (one menu bar for
  // every window), so it must follow whichever project's language the FOCUSED window
  // last pushed, not whichever window happened to push last. Pushed from
  // applyProjectLanguage() (boot + project switch) and writeProjectLanguage() (client
  // task-board.js) via preload's setAppLocale(). See main/menu-i18n.js for scope.
  ipcMain.handle('app:set-locale', (_event, lang) => {
    if (getMenuLocale() === (LOCALES[lang] ? lang : 'en')) return { ok: true, changed: false };
    setMenuLocale(lang);
    if (app.isReady()) createMenu();
    return { ok: true, changed: true };
  });

  // (C1125) macOS's usernoted keys notification delivery off the app's code signature — an
  // ad-hoc-or-unsigned bundle (electron-builder skips signing unless `build.mac.identity` is
  // set — see package.json) never gets a Notification Center registration at all, and every
  // `n.show()` below then silently drops with no error of any kind. `Contents/_CodeSignature`
  // is what `codesign` writes for a real signature (even ad-hoc `--sign -`) and is absent when
  // signing was skipped entirely — cheaper and more direct than shelling out to `codesign -dv`.
  // Cached: the answer can't change without a relaunch. Always true outside darwin/packaged,
  // where this failure mode doesn't apply (dev runs execute unsigned `electron .` directly and
  // still notify fine — see tt-notifications.md's macOS bundle-identifier caveat).
  let _codeSigned = null;
  function isCodeSigned() {
    if (_codeSigned !== null) return _codeSigned;
    if (process.platform !== 'darwin' || !app.isPackaged) { _codeSigned = true; return true; }
    try {
      _codeSigned = fs.existsSync(path.join(process.resourcesPath, '..', '_CodeSignature'));
    } catch { _codeSigned = false; }
    return _codeSigned;
  }

  // (C1141) signed ≠ valid — isCodeSigned() above only proves Contents/_CodeSignature EXISTS
  // (true at build time even for a bundle whose seal has since been broken by a stray write
  // inside it). _bundleSignatureState is the actual `codesign --verify` result.
  // (C1318) No longer fails open: a `null` state (check literally never ran) used to read back
  // as `{valid: true}` — a check that never happened was indistinguishable from a healthy one.
  // Now reported honestly as `valid: null` ("unknown"); notify:show's gate below treats that
  // as pass-through (never blocks a send on an inconclusive check) while notify:status/the
  // Settings badge can still tell "never checked" apart from "verified good".
  function signatureStatus() {
    return _bundleSignatureState || { valid: null, reason: 'not-checked', relaunchNeeded: false };
  }

  // (C1125) Lets notifications.js#getNotificationStatus() surface the unsigned-bundle condition
  // in the Settings badge/warning-dot even before any notify:show attempt has happened.
  // (C1141) valid/reason/relaunchNeeded added alongside signed.
  // (C1318) Async now — re-verifies (TTL'd, see refreshBundleSignatureState) instead of only
  // ever reporting the one-time startup snapshot, and adds `registered` (the direct "is this
  // bundle actually connected to usernoted right now" signal — see checkNotificationCenterRegistration).
  // (C1355) `conflicts`/`installerVolumes` added — the duplicate-LaunchServices-claimant self
  // heal check, same TTL as the signature check above (see refreshBundleSignatureState).
  ipcMain.handle('notify:status', async () => {
    await refreshBundleSignatureState();
    return {
      signed: isCodeSigned(),
      ...signatureStatus(),
      registered: _ncRegistrationState,
      conflicts: _lsRegistrationState?.conflicts ?? null,
      installerVolumes: _lsRegistrationState?.installerVolumes ?? [],
    };
  });

  // (C1355) On-demand repair from the Settings "Repair" button — re-registers the RUNNING
  // bundle with LaunchServices so it becomes the freshest claimant of com.tipatask.app. Never
  // rebuilds the whole LaunchServices database (out of scope for an automatic action — see
  // ai/architecture/tt-notifications.md § C1355's user-run remediation for that). A relaunch is
  // still required afterward: usernoted only decides Notification Center registration at
  // process launch, same as the C1318 seal-repair path above.
  ipcMain.handle('notify:repair-registration', async () => {
    if (process.platform !== 'darwin' || !app.isPackaged) return { ok: true, relaunchNeeded: false };
    try {
      _bundlePath = _bundlePath || path.resolve(process.resourcesPath, '..', '..');
      const result = await reregisterBundle(_bundlePath);
      if (result.ok) await refreshBundleSignatureState({ force: true });
      return { ok: result.ok, reason: result.reason, relaunchNeeded: result.ok };
    } catch (e) {
      return { ok: false, reason: e.message || 'failed', relaunchNeeded: false };
    }
  });

  // (C1202) macOS mic access. `systemPreferences.getMediaAccessStatus`/`askForMediaAccess`
  // are the OS/TCC layer — separate from and upstream of the Chromium `setPermissionRequestHandler`
  // grant above, which only covers the in-page getUserMedia() permission prompt. A hardened-
  // runtime build missing the `com.apple.security.device.audio-input` entitlement (see
  // build/entitlements.mac.plist) never even reaches TCC: capture silently returns a
  // muted/empty track with no error, no prompt, nothing to check() against. This pair exists so
  // the client can tell "blocked" apart from "no speech" instead of guessing — see
  // audio-recorder.js's mic-access gate and voice-report.js's chooseNothingProducedMessage().
  // Non-macOS: always 'granted' — Windows/Linux gate at the Chromium prompt only.
  ipcMain.handle('voice:mic-access-status', () => {
    if (process.platform !== 'darwin') return 'granted';
    try { return systemPreferences.getMediaAccessStatus('microphone'); } catch { return 'unknown'; }
  });
  // Triggers the actual OS prompt (only fires once per install — see notes above the
  // Settings > Voice UI). Called from the renderer right before the FIRST getUserMedia() of a
  // session, never at boot, so a user who never touches voice input is never prompted.
  ipcMain.handle('voice:request-mic-access', async () => {
    if (process.platform !== 'darwin') return true;
    try { return await systemPreferences.askForMediaAccess('microphone'); } catch { return false; }
  });

  // How long to wait for a 'show'/'failed' event before assuming the send is a bust. Electron
  // documents 'failed' as Windows-only, so on macOS this timeout — not 'failed' — is what
  // catches a delivery that neither the isCodeSigned() check nor 'show' itself flags.
  const NOTIFY_SHOW_TIMEOUT_MS = 1500;

  // (C1057) Native main-process notification — bypasses the renderer Web Notification
  // permission model entirely (see the setPermissionRequestHandler/setPermissionCheckHandler
  // pair below, which is the fallback path for when this transport is unavailable). Works in
  // an unpackaged dev run too, unlike a renderer Notification that depends on the app bundle
  // identity. (C1069) Click focuses the window that CURRENTLY owns the originating project
  // (`notifyOrigins`/`resolveNotifyTarget`), activating the app BEFORE keying the window on
  // macOS — see focusWindow() — then hands off to the renderer via 'notify:clicked' so
  // notifications.js's registered onClick (e.g. open the task's terminal) still runs — see
  // src/client/notifications.js and preload.js.
  // (C1125) Now async and truthful — previously returned `{ok:true}` unconditionally right
  // after `n.show()`, before the OS had decided anything, which is exactly how the unsigned-
  // bundle drop above stayed invisible through the whole C1058/C1060/C1069 notification work.
  ipcMain.handle('notify:show', (event, payload = {}) => {
    if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };
    if (!isCodeSigned()) return { ok: false, reason: 'unsigned' };
    // (C1141) signed ≠ valid — see signatureStatus() above. (C1318) Explicit `=== false` —
    // `null` (never checked / inconclusive) must pass through, not block every send.
    if (signatureStatus().valid === false) return { ok: false, reason: 'seal-broken' };
    const { title, body, tag, taskId } = payload || {};
    // (C1069) Capture calling window UP FRONT — click callback below must not depend on
    // whatever had focus when banner clicked. That dependence was the bug.
    const originWin = BrowserWindow.fromWebContents(event.sender);
    const origin = rememberNotifyOrigin(tag, {
      windowId: originWin && !originWin.isDestroyed() ? originWin.id : null,
      wcId: event.sender.id,
      projectPath: projectDirs.get(event.sender.id) || null,
    });
    // (C1137) timeoutType:'never' keeps the toast on-screen until dismissed on Windows/Linux.
    // Electron docs this as Windows-only, but Linux notification daemons (libnotify) generally
    // honor it too since it maps to the freedesktop 'urgency'/'expire-timeout' hints. No effect
    // on macOS: Electron's Notification is UNUserNotificationCenter-backed there (verified
    // against the shipped framework binary — 0 hits NSUserNotificationCenter, 4 hits
    // UNUserNotificationCenter), and Banner-vs-Alert (auto-dismiss vs stays-until-dismissed) is
    // a user preference in System Settings › Notifications with no app-facing override — see
    // ai/architecture/tt-notifications.md § In-app notification stack for the macOS-side answer
    // (an in-app card stack, notification-center.js) and the Settings deep link this drives to.
    const n = new Notification({ title: String(title || 'TipATask'), body: String(body || ''), silent: false, timeoutType: 'never' });
    // (C1141) Retain — see _liveNotifications above. FIFO backstop so a leak (an event that
    // never fires for some reason) can never grow this unbounded.
    const liveKey = ++_notifyLiveSeq;
    _liveNotifications.set(liveKey, n);
    while (_liveNotifications.size > NOTIFY_LIVE_MAX) {
      _liveNotifications.delete(_liveNotifications.keys().next().value);
    }
    const release = () => { _liveNotifications.delete(liveKey); };
    n.on('click', () => {
      // Registry first (survives this closure's own origin going stale), fall back to the
      // origin captured above if the registry entry was already cleaned up.
      const src = notifyOrigins.get(tag, origin.projectPath) || origin;
      notifyOrigins.forget(tag, origin.projectPath);
      const w = resolveNotifyTarget(src);
      if (!w) return;
      focusWindow(w, { steal: true });
      // projectPath sent is the ORIGIN's project, not necessarily the resolved window's —
      // deliberate: lets renderer detect "reloaded into different project since banner raised"
      // and decline to act (see notifications.js).
      if (!w.webContents.isDestroyed()) {
        w.webContents.send('notify:clicked', { taskId, tag, windowId: src.windowId, projectPath: src.projectPath });
      }
    });
    // Identity-guarded cleanup: a late 'close' from a superseded banner must not delete a
    // fresher entry re-registered for same tag after notifications.js's 30s debounce expired.
    const forget = () => notifyOrigins.forget(tag, origin.projectPath, origin);
    n.on('close', () => { forget(); release(); });
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      // (C1141) settle() only used to flip `settled` and resolve — the setTimeout below kept
      // firing regardless (harmless for the result, but the timer never went away). Clear it
      // on whichever path settles first.
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      n.on('failed', () => { forget(); release(); settle({ ok: false, reason: 'failed' }); });
      // release() deliberately NOT called on 'show' or on the not-delivered timeout below — a
      // banner the user can still click (or that macOS is about to deliver late) must stay
      // referenced past this IPC promise settling. Only 'close'/'failed' (the notification's own
      // terminal events, above/below) release it; NOTIFY_LIVE_MAX is the backstop if neither
      // ever fires.
      n.on('show', () => settle({ ok: true }));
      n.show();
      timer = setTimeout(() => settle({ ok: false, reason: 'not-delivered' }), NOTIFY_SHOW_TIMEOUT_MS);
    });
  });

  ipcMain.handle('project:remove', (_event, projectPath) => {
    removeFromWorkspace(projectPath);
    const w = ownerOf(projectPath);
    // (C1429) removeFromWorkspace() already mutated workspace state — a
    // confirmWindowClose() Cancel here would strand a removed project with a live
    // window. Preserve pre-existing unguarded behavior.
    if (w && !w.isDestroyed()) { _closeConfirmed.add(w); w.close(); }
    return { ok: true, state: workspaceState };
  });

  ipcMain.handle('dialog:selectFolder', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(w, {
      properties: ['openDirectory', 'createDirectory'],
      title: mt('dialog.selectOrCreateProjectFolder'),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Open a dedicated setup window for an unconfigured project directory.
  // The renderer sends this when the user picks a folder without config.
  // On wizard completion project:open-existing adopts this window in-place.
  // On cancel the renderer calls closeCurrentProject() → this window closes.
  // (C1388) Deduped both ways — a real project window OR an already-open setup window
  // for this exact path gets focused instead of a second window spawning.
  ipcMain.handle('project:open-setup-window', (_event, projectPath) => {
    if (!projectPath) return { ok: false, error: 'No project path provided' };
    const owner = ownerOf(projectPath);
    if (owner) { focusWindow(owner); return { ok: true, focused: true, target: 'project' }; }
    const pending = setupFor(projectPath);
    if (pending) { focusWindow(pending); return { ok: true, focused: true, target: 'setup' }; }
    createSetupWindow(projectPath);
    return { ok: true, created: true, target: 'setup' };
  });

  // (C1388) No live renderer caller today — kept for API symmetry with
  // project:open-existing. Same adopt-refusal handling applied for consistency should
  // a future caller reappear.
  ipcMain.handle('save-project-config', async (event, { projectRoot, config }) => {
    const { writeProjectConfig } = require('./src/server/project-config');
    writeProjectConfig(projectRoot, config);
    try { writeProjectMcpConfig(projectRoot, __dirname); } catch (e) {
      console.warn('[mcp-config] save-project-config .mcp.json write failed:', e.message);
    }
    try { writeProjectSkillsConfig(projectRoot, __dirname); } catch (e) {
      console.warn('[skills-config] save-project-config write failed:', e.message);
    }
    try { writeProjectCodexConfig(projectRoot, __dirname); } catch (e) {
      console.warn('[codex-config] save-project-config write failed:', e.message);
    }

    const r = await adoptProjectIntoWindow(event.sender, projectRoot);
    return { ok: r.adopted || r.focused, adopted: r.adopted, focusedExisting: !!r.focused };
  });

  // Full open-existing-project setup: device register + associate + token exchange +
  // config.json + project.json + KB templates. Replaces the slim saveProjectConfig path
  // for the non-reauth open-existing flow so the window title, board, and KB all work.
  ipcMain.handle('project:open-existing', async (event, detail) => {
    const { projectPath, apiBaseUrl, userToken, apiProject, deviceName, taskAgent: detailTaskAgent, availableAgents: detailAvailableAgents, piModels: detailPiModels } = detail;
    try {
      const os = require('node:os');
      const machineId = getOrCreateMachineId();
      const { registerDevice, associateDeviceProject } = require('./src/cli/setup');
      const { exchangeProjectToken } = require('./src/cli/auth');

      // 1. Register this machine. (TPT161) deviceName comes from the setup-modal.js
      // wizard's own Device name step, mirroring project:create-from-wizard's handling —
      // os.hostname() is only a fallback for a caller that omits it. Note registerDevice()
      // returns the EXISTING record unchanged when this machine already has one, so a
      // typed name only takes effect on this machine's first-ever registration.
      const device = await registerDevice({ apiBaseUrl, token: userToken, machineId, name: deviceName || os.hostname() });

      // 2. Associate device ↔ project
      await associateDeviceProject({ apiBaseUrl, token: userToken, deviceId: device.id, projectId: apiProject.id });

      // 3. Project-scoped token
      const scopedToken = await exchangeProjectToken(apiBaseUrl, userToken, apiProject.id);

      // 4. Agent preference from renderer (fallback: auto-detect)
      let TASK_AGENT = detailTaskAgent || '';
      let AVAILABLE_AGENTS = Array.isArray(detailAvailableAgents) ? detailAvailableAgents.join(',') : (detailAvailableAgents || '');
      if (!TASK_AGENT) {
        TASK_AGENT = 'claude';
        AVAILABLE_AGENTS = 'claude';
        try {
          const { listAvailableTaskAgents } = require('./src/server/task-agent');
          const config = require('./src/server/config');
          const agents = await listAvailableTaskAgents(config);
          if (agents.length > 0) { AVAILABLE_AGENTS = agents.map(a => a.id).join(','); TASK_AGENT = agents[0].id; }
        } catch { /* non-fatal */ }
      }

      // 5. Write .tipatask/config.json (full parity with wizard-created projects).
      //    This handler rewrites the whole file, so an already-configured project's
      //    PI_MODELS (set by a prior wizard/re-auth pass) must be carried forward when
      //    Other Model is left unchecked this time — never blanked (C1101, extended to
      //    the array in C1122). New non-empty rows from this payload win outright
      //    (whole-array replace, not a per-row merge — the setup-modal payload always
      //    carries every configured row, not just changed ones).
      const { readProjectConfig, writeProjectConfig, sanitizePiModels, readPiEntries } = require('./src/server/project-config');
      const existingCfg = readProjectConfig(projectPath) || {};
      const piModels = Array.isArray(detailPiModels) && detailPiModels.length
        ? sanitizePiModels({ piModels: detailPiModels })
        : readPiEntries(existingCfg);
      // Legacy flat pair — pre-C1121 projects only carry-forward here; still-fresh legacy
      // values from this payload's TASK_AGENT/AVAILABLE_AGENTS flow have no flat piModel/
      // piApiKey source anymore (setup-modal.js is fully array-based as of C1122).
      const legacyPiModel = existingCfg.PI_MODEL || '';
      const legacyPiApiKey = existingCfg.OPENROUTER_API_KEY || '';
      writeProjectConfig(projectPath, {
        TASK_BACKEND: 'api',
        API_BASE_URL: apiBaseUrl,
        API_TOKEN: scopedToken,
        API_PROJECT_ID: String(apiProject.id),
        DEVICE_ID: String(device.id),
        DEVICE_NAME: device.name,
        TASK_AGENT,
        AVAILABLE_AGENTS,
        projectName: apiProject.name,
        ...(piModels.length ? { PI_MODELS: piModels } : {}),
        // Only surfaces for a pre-C1121 project with no PI_MODELS array at all — keeps
        // Pi spawning for it until it's re-configured through the new wizard/setup-modal.
        ...(!piModels.length && legacyPiModel ? { PI_MODEL: legacyPiModel } : {}),
        ...(!piModels.length && legacyPiApiKey ? { OPENROUTER_API_KEY: legacyPiApiKey } : {}),
        // C1131 — carry forward the project's implicit "last agent+model actually
        // launched" default, same rationale as the PI_MODELS carry-forward above: this
        // handler rewrites the whole file, so an already-recorded LAST_AGENT would
        // otherwise be silently dropped every time this open-existing flow re-runs.
        ...(existingCfg.LAST_AGENT ? { LAST_AGENT: existingCfg.LAST_AGENT } : {}),
      });

      // 6. First-adoption guard: write project.json + KB templates only when absent.
      //    project.json must exist BEFORE adoptProjectIntoWindow so getDisplayName returns
      //    the API name, not the folder basename.
      const metaPath = path.join(projectPath, '.tipatask', 'project.json');
      if (!fs.existsSync(metaPath)) {
        writeProjectMeta(projectPath, {
          name: apiProject.name,
          apiProjectId: apiProject.id,
          updatedAt: new Date().toISOString(),
        });
        try {
          const { copyTemplates } = require('./src/server/project-seeder');
          copyTemplates('existing-code', projectPath, null);
        } catch (err) {
          console.warn('[open-existing] templates copy failed:', err.message);
        }
      }

      // 7. Write .mcp.json + skills (non-fatal)
      try { writeProjectMcpConfig(projectPath, __dirname); } catch (e) {
        console.warn('[mcp-config] open-existing .mcp.json write failed:', e.message);
      }
      try { writeProjectSkillsConfig(projectPath, __dirname); } catch (e) {
        console.warn('[skills-config] open-existing write failed:', e.message);
      }
      try { writeProjectCodexConfig(projectPath, __dirname); } catch (e) {
        console.warn('[codex-config] open-existing write failed:', e.message);
      }

      // 8. Adopt the setup window into the project (project.json written above → correct title)
      // (C1388) Adopt can be refused if someone else already owns projectPath (a race:
      // this path was opened elsewhere while this wizard ran). setup-modal.js sets
      // _completed=true on res.ok and its close() then SKIPS closeCurrentProject() —
      // without this, a refused sender would stay open forever with no backend and no
      // way to self-close. Only close it if it really was a dedicated setup window
      // (setupFor() check, not a heuristic) — a config-refresh replay from a real
      // project window must never be closed here.
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      const wasSetupWindow = senderWin && setupFor(projectPath) === senderWin;
      const r = await adoptProjectIntoWindow(event.sender, projectPath);
      if (!r.adopted && r.focused && wasSetupWindow) {
        // Deferred: closing event.sender's window inside this handler would destroy
        // the webContents this reply is addressed to before it flushes.
        setTimeout(() => {
          if (senderWin && !senderWin.isDestroyed()) { _closeConfirmed.add(senderWin); senderWin.close(); }
        }, 0);
      }

      return { ok: r.adopted || r.focused, projectPath, adopted: r.adopted, focusedExisting: !!r.focused };
    } catch (err) {
      console.error('[open-existing] project:open-existing failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // chooseAccount: set by the Project ▸ Re-authenticate / Change Account flow (and the wizard's
  // "Use a different account" button) — makes the web sign-in page offer an account chooser
  // instead of auto-handing back the browser's existing session. See authenticate()'s docblock.
  ipcMain.handle('setup:auth-web', async (_event, { apiBaseUrl, chooseAccount }) => {
    const { authenticate } = require('./src/cli/auth');
    return await authenticate(apiBaseUrl, { chooseAccount: !!chooseAccount });
  });

  ipcMain.handle('setup:list-projects', async (_event, { apiBaseUrl, userToken }) => {
    const res = await fetch(`${apiBaseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    // API returns { projects: [...] } — unwrap so renderer always receives a bare array.
    return Array.isArray(data) ? data : (data?.projects || data?.data || []);
  });

  ipcMain.handle('setup:get-device-name', async (_event, { apiBaseUrl, userToken }) => {
    const os = require('node:os');
    const deviceIdPath = path.join(os.homedir(), '.tipatask', 'device_id');
    let deviceId;
    try { deviceId = fs.readFileSync(deviceIdPath, 'utf8').trim(); } catch { return null; }
    if (!deviceId) return null;
    try {
      const res = await fetch(`${String(apiBaseUrl).replace(/\/+$/, '')}/api/devices`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const devices = Array.isArray(data) ? data : (data?.devices || data?.data || []);
      return devices.find(d => d.machine_id === deviceId)?.name || null;
    } catch { return null; }
  });

  ipcMain.handle('setup:exchange-project-token', async (_event, { apiBaseUrl, userToken, projectId }) => {
    const { exchangeProjectToken } = require('./src/cli/auth');
    return await exchangeProjectToken(apiBaseUrl, userToken, projectId);
  });

  // List all agents (available + unavailable) so the renderer can render the agent picker.
  // Pass force=true (Re-Check button) to bust stale caches and await a fresh probe.
  ipcMain.handle('setup:get-available-agents', async (_event, force = false) => {
    try {
      const { listTaskAgentStatuses } = require('./src/server/task-agent');
      const config = require('./src/server/config');
      if (force) {
        // Bust resolveBin's permanent null-cache so a just-installed agent is found.
        // config.*_BIN are lazy getters over resolveBin, so this also refreshes
        // the binary paths used by the login probes. Must run BEFORE force detect.
        const { clearBinCache } = require('./src/server/spawn-utils');
        clearBinCache();
      }
      return (await listTaskAgentStatuses(config, { force }))
        .map(a => ({ id: a.id, label: a.label, available: !!a.available, reason: a.reason || null }));
    } catch {
      // No fake-claude: report all three unavailable so the empty state shows.
      return [
        { id: 'claude', label: 'Claude Code', available: false, reason: 'Agent detection failed' },
        { id: 'codex',  label: 'Codex',       available: false, reason: 'Agent detection failed' },
        { id: 'pi',     label: 'Pi',          available: false, reason: 'Agent detection failed' },
      ];
    }
  });

  // One-shot re-auth: OAuth + project-token exchange + config write + backend re-probe.
  // Skips the renderer-driven multi-step modal and the project-pick step entirely.
  // Returns { ok, state?, error? }.
  ipcMain.handle('setup:force-reauth', async (event, projectPath) => {
    if (_forceReauthInFlight) return { ok: false, error: 'Re-authentication already in progress' };
    if (!projectPath) return { ok: false, error: 'No project path provided' };
    _forceReauthInFlight = true;
    try {
      const cfg = readProjectConfig(projectPath);
      if (!cfg || !cfg.API_BASE_URL || !cfg.API_PROJECT_ID) {
        return { ok: false, error: 'Project not configured for API access (missing API_BASE_URL or API_PROJECT_ID)' };
      }
      const apiBaseUrl = String(cfg.API_BASE_URL).replace(/\/+$/, '');
      const { authenticate, exchangeProjectToken } = require('./src/cli/auth');
      const { token: userToken } = await authenticate(apiBaseUrl);
      const scopedToken = await exchangeProjectToken(apiBaseUrl, userToken, cfg.API_PROJECT_ID);
      const newConfig = { ...cfg, API_TOKEN: scopedToken };
      // Refresh projectName from the API so re-auth heals a stale cached name (e.g. after rename).
      try {
        const { request } = require('./src/cli/http');
        const { status: pStatus, data: pData } = await request(
          `${apiBaseUrl}/api/projects/${cfg.API_PROJECT_ID}`,
          { method: 'GET', headers: { Authorization: `Bearer ${scopedToken}` }, timeoutMs: 5000 }
        );
        if (pStatus === 200 && pData && pData.project && pData.project.name) {
          newConfig.projectName = pData.project.name;
        }
      } catch (e) {
        console.warn('[force-reauth] project name refresh failed (non-fatal):', e.message);
      }
      // reconfigureWindowBackend writes config.json atomically, then clears the
      // 'unauthorized' latch and re-probes GET /api/projects/{id}/tasks.
      const state = await reconfigureWindowBackend(event.sender.id, newConfig);
      try { writeProjectMcpConfig(projectPath, __dirname); } catch (e) {
        console.warn('[mcp-config] force-reauth .mcp.json write failed:', e.message);
      }
      try { writeProjectSkillsConfig(projectPath, __dirname); } catch (e) {
        console.warn('[skills-config] force-reauth write failed:', e.message);
      }
      try { writeProjectCodexConfig(projectPath, __dirname); } catch (e) {
        console.warn('[codex-config] force-reauth write failed:', e.message);
      }
      try {
        const { runCavemanPluginStep } = require('./src/cli/plugin-install');
        await runCavemanPluginStep(projectPath);
      } catch (e) {
        console.warn('[caveman-plugin] force-reauth install failed:', e.message);
      }
      // (TPT451) Account may have changed: re-filter Recent Projects for the new user.
      if (app.isReady()) createMenu();
      reconcileRecentProjectsWithAccounts();
      return { ok: state === 'connected', state };
    } catch (err) {
      console.error('[force-reauth] failed:', err.message);
      return { ok: false, error: err.message };
    } finally {
      _forceReauthInFlight = false;
    }
  });

  ipcMain.handle('project:rename', async (event, { name }) => {
    const dir = projectDirs.get(event.sender.id);
    if (!dir) return { ok: false, error: 'No project loaded' };
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, error: 'Name required' };

    const meta = readProjectMeta(dir);
    meta.name = trimmed;
    meta.updatedAt = new Date().toISOString();

    let apiResult = null;
    if (meta.apiProjectId) {
      apiResult = await renameApiProject(dir, meta.apiProjectId, trimmed)
        .catch(err => ({ ok: false, error: err.message }));
    }
    writeProjectMeta(dir, meta);
    const _wsEntry = workspaceState?.openProjects?.find(p => p.path === dir);
    if (_wsEntry) _wsEntry.name = trimmed;
    if (!event.sender.isDestroyed()) {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (w && !w.isDestroyed()) w.setTitle(getWindowTitle(trimmed));
      event.sender.send('project:changed', dir, trimmed);
    }
    persistWorkspace();
    createMenu(); // rebuild native menu so Recent Projects shows the new name immediately
    return { ok: true, name: trimmed, apiResult };
  });

  ipcMain.handle('project:create-from-wizard', async (_event, detail) => {
    const {
      projectPath, apiBaseUrl, userToken,
      apiProject, deviceName, preset, presetDescription,
    } = detail;
    try {
      // 1. Machine ID
      const machineId = getOrCreateMachineId();

      const { registerDevice, createApiProject, associateDeviceProject } = require('./src/cli/setup');
      const { exchangeProjectToken } = require('./src/cli/auth');

      // 2. Project ID
      let projectId;
      if (apiProject.isNew) {
        const proj = await createApiProject({ apiBaseUrl, token: userToken, name: apiProject.name, description: apiProject.description });
        projectId = proj.id;
      } else {
        projectId = apiProject.id;
      }

      // 3. Register device
      const device = await registerDevice({ apiBaseUrl, token: userToken, machineId, name: deviceName });

      // 4. Associate device ↔ project
      await associateDeviceProject({ apiBaseUrl, token: userToken, deviceId: device.id, projectId });

      // 5. Project-scoped token
      const scopedToken = await exchangeProjectToken(apiBaseUrl, userToken, projectId);

      // 6. Agent preference from renderer (fallback: auto-detect)
      let TASK_AGENT = detail?.agentPreference?.taskAgent || '';
      let AVAILABLE_AGENTS = Array.isArray(detail?.agentPreference?.availableAgents)
        ? detail.agentPreference.availableAgents.join(',')
        : (detail?.agentPreference?.availableAgents || '');
      if (!TASK_AGENT) {
        TASK_AGENT = 'claude';
        AVAILABLE_AGENTS = 'claude';
        try {
          const { listAvailableTaskAgents } = require('./src/server/task-agent');
          const config = require('./src/server/config');
          const agents = await listAvailableTaskAgents(config);
          if (agents.length > 0) { AVAILABLE_AGENTS = agents.map(a => a.id).join(','); TASK_AGENT = agents[0].id; }
        } catch { /* non-fatal */ }
      }

      // 7. Write .tipatask/config.json — carries the "Other Model" (pi) rows when Other
      //    Model was picked (C1099 UI → C1101 single-model persistence → C1121 multi-model).
      //    PI_MODELS is the ONLY Pi config key now — the old flat PI_MODEL/OPENROUTER_API_KEY
      //    entries are retired; each row owns its own model + key. sanitizePiModels() also
      //    accepts the legacy {piModel,piApiKey} shape, so an older renderer payload still
      //    produces a one-row PI_MODELS. Only written when non-empty so an unchecked Other
      //    Model never writes an empty array (no case here since this is a brand-new config,
      //    but keeps parity with open-existing's carry-forward behavior).
      const { writeProjectConfig, sanitizePiModels } = require('./src/server/project-config');
      const piModels = sanitizePiModels(detail?.agentPreference);
      writeProjectConfig(projectPath, {
        TASK_BACKEND: 'api',
        API_BASE_URL: apiBaseUrl,
        API_TOKEN: scopedToken,
        API_PROJECT_ID: String(projectId),
        DEVICE_ID: String(device.id),
        DEVICE_NAME: device.name,
        TASK_AGENT,
        AVAILABLE_AGENTS,
        projectName: apiProject.name,
        ...(piModels.length ? { PI_MODELS: piModels } : {}),
      });

      // 8. Write .tipatask/project.json for window title + cross-device sync
      writeProjectMeta(projectPath, { name: apiProject.name, apiProjectId: projectId, updatedAt: new Date().toISOString() });

      // 9. Seed templates + tasks (non-fatal). The seed outcome is returned to the renderer
      //    (TPT203) so a partial seed is reported instead of looking like a clean success.
      let presetSeed = null;
      try {
        const { copyTemplates, callSeedPresetTasks } = require('./src/server/project-seeder');
        copyTemplates(preset.value, projectPath, presetDescription || null);
        presetSeed = await callSeedPresetTasks(preset.value, { apiBaseUrl, token: scopedToken, projectId, presetDescription: presetDescription || null });
      } catch (err) {
        console.warn('[wizard] seeding failed:', err.message);
        presetSeed = { seeded: 0, failed: null, error: err.message };
      }

      // 10. Push base KB (CLAUDE.md, AGENTS.md, GENERAL.md + any tt-*.md) to the API so
      //     project_knowledge_files is populated for the new project (C882). Non-fatal.
      try {
        const { pushAll, pushArchitectureDocs } = require('./src/cli/knowledge-sync');
        await pushAll(apiBaseUrl, projectId, scopedToken, projectPath);
        await pushArchitectureDocs(apiBaseUrl, projectId, scopedToken, projectPath);
      } catch (err) {
        console.warn('[wizard] KB push failed:', err.message);
      }

      // 11. Write absolute-path .mcp.json + skills so MCP + Claude skills resolve
      //     from the shared install for this external project (non-fatal).
      try { writeProjectMcpConfig(projectPath, __dirname); } catch (e) {
        console.warn('[mcp-config] wizard .mcp.json write failed:', e.message);
      }
      try { writeProjectSkillsConfig(projectPath, __dirname); } catch (e) {
        console.warn('[skills-config] wizard write failed:', e.message);
      }
      try { writeProjectCodexConfig(projectPath, __dirname); } catch (e) {
        console.warn('[codex-config] wizard write failed:', e.message);
      }

      return { ok: true, projectPath, presetSeed };
    } catch (err) {
      console.error('[wizard] project:create-from-wizard failed:', err.message);
      return { ok: false, error: err.message };
    }
  });
}

function resolveServerPaths() {
  // __dirname resolves into app.asar when packaged (Electron patches fs/fork
  // to read transparently from the asar archive). Using process.resourcesPath
  // + 'app' was wrong: with asar:true there is no Resources/app/ directory.
  const serverScript = path.join(__dirname, 'todo-server.js');

  if (!app.isPackaged) {
    return { serverScript, extraEnv: {} };
  }

  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });

  const envDest = path.join(userDataDir, '.env');
  if (!fs.existsSync(envDest)) {
    // .env.example lives inside the asar alongside main.js — use __dirname.
    const envSrc = path.join(__dirname, '.env.example');
    try { fs.copyFileSync(envSrc, envDest); } catch {}
  }

  return { serverScript, extraEnv: { TIPATASK_USER_DATA: userDataDir } };
}

// (C1141/C1318) Runs once, BEFORE the server child (which writes TODO.md/recipes) forks — see
// startServer() below and config.js's resolveDataRoot(). darwin+packaged only: self-heals an
// already-installed bundle whose seal a pre-fix version broke (removes/rescues the known
// stray files — both the Contents/Resources ones (C1141) and the bundle-root ones (C1318) —
// re-verifies, and — only if still broken — re-signs once per app version, guarded by a
// marker in userData so a persistently-broken bundle can never re-attempt every launch).
// usernoted decides Notification Center registration at process launch, so a fix made here
// still needs one relaunch before banners actually resume — callers surface that via
// _bundleSignatureState.relaunchNeeded. Thin wrapper now — see refreshBundleSignatureState()
// above, which this also sets up for later TTL'd re-checks from notify:status.
async function runBundleSignatureCheck() {
  await refreshBundleSignatureState({ force: true });
}

function startServer() {
  const { serverScript, extraEnv } = resolveServerPaths();
  return new Promise((resolve, reject) => {
    let ready = false;
    let settled = false;
    const stderrTail = [];
    const MAX_STDERR_LINES = 20;

    serverChild = fork(serverScript, [], {
      // C1075: stderr piped (not 'inherit') so a boot failure in a Finder/Dock launch
      // (no terminal attached) can still be captured for the startup-failed dialog below.
      // Still teed to this process's stderr so `npm run electron` terminal output is
      // unchanged.
      stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
      // TIPATASK_ELECTRON_HOST tells the server it is the desktop app's embedded server (the
      // startup banner otherwise flags a standalone `node todo-server.js` as browser/debug mode).
      env: { ...process.env, PORT: String(PORT), ...extraEnv, TIPATASK_LOCAL_SECRET: LOCAL_SECRET, TIPATASK_ELECTRON_HOST: '1' },
    });

    serverChild.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      const lines = chunk.toString().split('\n').filter(Boolean);
      stderrTail.push(...lines);
      if (stderrTail.length > MAX_STDERR_LINES) stderrTail.splice(0, stderrTail.length - MAX_STDERR_LINES);
    });

    serverChild.on('message', (msg) => {
      if (msg === 'ready') {
        ready = true;
        if (!settled) { settled = true; resolve(); }
        return;
      }
      // C1075: typed fatal message from src/server/index.js (e.g. EADDRINUSE) — reject so
      // the whenReady .catch shows dialog.showErrorBox instead of a silent quit.
      if (msg && msg.type === 'fatal' && !settled) {
        settled = true;
        reject(new Error(msg.message || `Task server failed to start (${msg.code || 'unknown error'}).`));
      }
      // (C1389) Web→Task App handoff — the child's /open-objective route asks THIS
      // process to resolve apiProjectId → local path (only main holds workspaceState/
      // recent-projects.json) and, once the child has fully validated project+account+
      // task itself, tells us to focus the window and seed the chat. See
      // resolveLocalPathsForApiProjectId()/focusAndSeedObjective() below and
      // ai/architecture/tt-electron-app.md § Web→Task App handoff IPC (C1389).
      if (msg && msg.type === 'resolve-project-path' && msg.requestId) {
        const candidates = resolveLocalPathsForApiProjectId(msg.apiProjectId);
        try { serverChild.send({ type: 'resolve-project-path-reply', requestId: msg.requestId, candidates }); } catch {}
        return;
      }
      if (msg && msg.type === 'confirm-start-task' && msg.requestId) {
        // A web navigation cannot carry a local capability. Only a native, explicit
        // confirmation lets the child inspect project data or dispatch agent work.
        if (handoffDialogOpen) {
          try { serverChild?.send({ type: 'confirm-start-task-reply', requestId: msg.requestId, approved: false }); } catch {}
          return;
        }
        handoffDialogOpen = true;
        dialog.showMessageBox({
          type: 'question',
          buttons: ['Cancel', 'Open task'],
          defaultId: 0,
          cancelId: 0,
          message: `Open ${String(msg.taskKey || 'task')} in TipATask?`,
          detail: `Project ${String(msg.projectId || '')}. Continue only if you requested this from the TipATask website.`,
        }).then(({ response }) => {
          handoffDialogOpen = false;
          try { serverChild?.send({ type: 'confirm-start-task-reply', requestId: msg.requestId, approved: response === 1 }); } catch {}
        }, () => {
          handoffDialogOpen = false;
          try { serverChild?.send({ type: 'confirm-start-task-reply', requestId: msg.requestId, approved: false }); } catch {}
        });
        return;
      }
      if (msg && msg.type === 'open-objective' && msg.projectPath && msg.taskKey) {
        // (TPT16) title/description forwarded so the renderer can seed the composer
        // without its own GET /api/tasks/:id round trip.
        focusAndSeedObjective(msg.projectPath, msg.taskKey, { warning: !!msg.warning, originTaskKey: msg.originTaskKey || null, title: msg.title || null, description: msg.description || null });
        return;
      }
      // (C1559) Sibling of 'open-objective' above for the /start-task route's other 2
      // dispatch branches — an is_objective task WITH children (msg.children carries the
      // fetched child list) or a regular task (msg.children empty).
      if (msg && msg.type === 'start-task' && msg.projectPath && msg.taskKey) {
        focusAndStartTask(msg.projectPath, msg.taskKey, { children: Array.isArray(msg.children) ? msg.children : [] });
        return;
      }
    });

    serverChild.once('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    // C1075: previously this only ever called quitWithoutConfirmation() on a nonzero
    // exit and NEVER rejected the promise — any child death before 'ready' (port in
    // use, node-pty ABI mismatch, backend.init() failure, ...) quit the app with the
    // splash still on screen and no error dialog. Now: reject before ready, keep the
    // original silent-quit behavior for a child that dies after it was already up.
    serverChild.once('exit', (code, signal) => {
      if (ready) {
        // C1124 — this used to be a silent app-wide quit with no diagnostic at all (the
        // "changing Coding Agent crashes" bug: an unhandled rejection in the forked server
        // killed the child, and this listener just vanished every window). index.js's new
        // process.on('unhandledRejection') guard + ws-handlers.js try/catches should make a
        // config-write failure impossible to reach this path now — this dialog is for the
        // remaining, genuine "the server process died" case, so it's diagnosable instead of
        // a silent disappearance.
        if (code !== 0 && code !== null) {
          try {
            dialog.showErrorBox(
              'TipΔTask server stopped',
              `The task server exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''}).` +
              (stderrTail.length ? `\n\n${stderrTail.join('\n')}` : '')
            );
          } catch { /* best-effort — never let the dialog itself block the quit below */ }
          quitWithoutConfirmation();
        }
        return;
      }
      if (settled) return; // already rejected via a 'fatal' IPC message or 'error' event
      settled = true;
      const tail = stderrTail.length ? `\n\n${stderrTail.join('\n')}` : '';
      reject(new Error(`Task server exited before starting (code ${code}${signal ? `, signal ${signal}` : ''}).${tail}`));
    });
  });
}

// Use a visible app-menu accelerator for voice input. OS keyboard-source
// shortcuts can consume renderer keydowns; globalShortcut would instead steal
// the combo while this app is unfocused.
function sendVoiceShortcut(win) {
  const target = (win && !win.isDestroyed()) ? win : BrowserWindow.getFocusedWindow();
  if (!target || target.isDestroyed()) return;
  if (target === splashWindow) return; // splash has no preload and never loads the client bundle
  target.webContents.send('voice:shortcut');
}

// (C1210) Diagnostic-only tracer for "the shortcut still does nothing" reports — never acts on
// the key, only logs/reports whether it arrived. Two reasons it must stay inert: (1) the menu
// accelerator above normally consumes the key before the renderer's own keydown listener ever
// fires, so acting here would double-toggle in the working case; (2) its only job is answering
// one question nothing else can — did the key reach the render process at all (AppKit/Chromium
// ate it before before-input-event) or not (the OS ate it before Electron, same as the original
// C1210 report). Armed LAZILY (only when the diagnostics dialog below is opened), never at boot —
// a permanently-attached listener forces a main-process round trip on every keystroke, and this
// app hosts full xterm/node-pty terminal sessions where the user types continuously.
const _voiceKeySeen = new Map(); // webContents.id -> { count, lastAt }
const _voiceDiagArmed = new Set(); // webContents.id
function armVoiceKeyDiagnostics(win) {
  const wc = win.webContents;
  if (_voiceDiagArmed.has(wc.id)) return false;
  _voiceDiagArmed.add(wc.id);
  _voiceKeySeen.set(wc.id, { count: 0, lastAt: 0 });
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.code !== 'KeyD') return;
    if (!(input.meta || input.control) || !input.shift || input.alt) return;
    const seen = _voiceKeySeen.get(wc.id);
    if (seen) { seen.count += 1; seen.lastAt = Date.now(); }
    console.log('[voice] before-input-event saw the shortcut — key DID reach the renderer process');
  });
  wc.once('destroyed', () => { _voiceDiagArmed.delete(wc.id); _voiceKeySeen.delete(wc.id); });
  return true;
}

async function showVoiceShortcutDiagnostics(win) {
  const target = (win && !win.isDestroyed()) ? win : BrowserWindow.getFocusedWindow();
  if (!target || target.isDestroyed() || target === splashWindow) return;
  const armedNow = armVoiceKeyDiagnostics(target);
  let domBound;
  try {
    domBound = await target.webContents.executeJavaScript(
      'window.TipTask && window.TipTask.chatUI && typeof window.TipTask.chatUI.isVoiceShortcutBound === "function"'
      + ' ? window.TipTask.chatUI.isVoiceShortcutBound() : null'
    );
  } catch (err) { domBound = `error: ${err.message}`; }
  const seen = _voiceKeySeen.get(target.webContents.id) || { count: 0, lastAt: 0 };
  dialog.showMessageBox(target, {
    type: 'info',
    buttons: ['OK'],
    title: 'Voice Shortcut Diagnostics',
    message: process.platform === 'darwin' ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
    detail: [
      'App-menu accelerator: registered (Edit → Start / Stop Voice Input) — always active.',
      `In-page listener bound: ${domBound === null ? 'unknown — client bundle not loaded yet' : domBound}`,
      `Key reached this window's renderer: ${seen.count}×${seen.count ? ` (last ${new Date(seen.lastAt).toLocaleTimeString()})` : ''}`,
      armedNow
        ? '\nKey tracing just enabled for this window. Press the shortcut now, then reopen this dialog to see the count update.'
        : '',
    ].filter(Boolean).join('\n'),
  });
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  const recentProjectItems = loadRecentProjects().map(projectPath => ({
    label: getDisplayName(projectPath),
    toolTip: projectPath,
    click: () => createProjectWindow(projectPath),
  }));
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        // (C1532) macOS gets the native About panel via the role above (its
        // `credits` field carries the Pi attribution — see setAboutPanelOptions
        // below); the full notices text still needs its own window since the
        // native panel has no room for it.
        { label: mt('menu.thirdPartyLicenses'), click: () => openNoticesWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: mt('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: confirmAndQuit },
      ],
    }] : []),
    {
      label: mt('menu.project'),
      submenu: [
        {
          // (C1388) Renamed from "Open Project…" — this is now the single entry point
          // for both opening a configured project AND starting setup/create for an
          // unconfigured one (renderer's openOrCreateProject(), template.html).
          label: mt('menu.openOrCreateProject'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'open'); },
        },
        {
          label: mt('menu.recentProjects'),
          submenu: recentProjectItems.length > 0
            ? recentProjectItems
            : [{ label: mt('menu.noRecentProjects'), enabled: false }],
        },
        { type: 'separator' },
        {
          label: mt('menu.closeProject'),
          accelerator: 'CmdOrCtrl+W',
          // (C1486) Close the window itself, NOT project:menu 'close' — this is what makes
          // Cmd+W and the title-bar X share attachCloseGuard()/confirmWindowClose()'s native
          // dialog instead of the renderer's own (now-removed) in-app close path. Do not
          // reintroduce a project:menu round trip here.
          click: (mi, window) => { if (window && !window.isDestroyed()) window.close(); },
        },
        { type: 'separator' },
        {
          label: mt('menu.renameProject'),
          click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'rename'); },
        },
        {
          label: mt('menu.settings'),
          accelerator: 'CmdOrCtrl+,',
          click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'settings'); },
        },
        {
          // (TPT345) Opens the "Merge task branches" panel (src/client/merge-branches-modal.js).
          label: mt('menu.mergeTaskBranches'),
          click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'merge-branches'); },
        },
        { type: 'separator' },
        {
          label: mt('menu.knowledgeBase'),
          submenu: [
            {
              label: mt('menu.kbSync'),
              click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'sync-kb'); },
            },
            {
              // C1040 — Opus-generated tag/description backfill, sibling of Sync above.
              label: mt('menu.kbReindex'),
              click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('project:menu', 'reindex-kb'); },
            },
          ],
        },
        { type: 'separator' },
        {
          label: mt('menu.reauthenticate'),
          click: (mi, window) => { if (window && !window.isDestroyed()) window.webContents.send('force-reauth'); },
        },
        { type: 'separator' },
        { label: mt('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: confirmAndQuit },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
        { type: 'separator' },
        // (C1210) Global voice-input shortcut, owned here rather than left as a renderer DOM
        // listener — see sendVoiceShortcut()'s doc comment above for why. Default combo is
        // Cmd/Ctrl+Shift+D ("dictate"), matching src/client/voice-shortcut.js's
        // DEFAULT_VOICE_SHORTCUT; kept in sync manually since main.js (CJS) doesn't share an
        // import graph with the browser-bundled client — if that default ever changes, update
        // both. Visible (not hidden): the rendered accelerator glyph is itself proof the
        // shortcut is registered, and the click path works with zero keypress.
        { label: mt('menu.startStopVoice'), accelerator: 'CmdOrCtrl+Shift+D', click: (mi, window) => sendVoiceShortcut(window) },
        { label: mt('menu.voiceDiagnostics'), click: (mi, window) => showVoiceShortcutDiagnostics(window) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        // No `{ role: 'close' }` on win/linux: its default Ctrl+W would double-bind against
        // Project ▸ Close Project (C1428) and, worse, closes the window raw — skipping the
        // renderer's active-agent-session guard in template.html. Closing a window IS closing
        // its project here, so the one guarded route in the Project menu owns Ctrl+W.
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
          : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: mt('menu.learnMore'), click: async () => { await shell.openExternal('https://tipatask.app'); } },
        // (C1532) macOS already has About via the native app-menu `{ role: 'about' }`
        // panel above — Windows/Linux have no native About surface at all, so this
        // window is their only one. Third-Party Licenses is on every platform: it's
        // the one MIT-required attribution surface (C1531), not a nice-to-have.
        ...(isMac ? [] : [{ label: mt('menu.about'), click: () => openAboutWindow() }]),
        { label: mt('menu.thirdPartyLicenses'), click: () => openNoticesWindow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Splash window (C1006) ─────────────────────────────────────────────────────
// A GUI launch has ~2-10 s of dead air before the first board paints:
// captureLoginShellPath() (synchronous shell probe, 2×5 s worst case), the
// todo-server fork (ensureCavemanPlugin → backend.init → agent probes), and
// detectCli() all block the main process. The splash is created and *painted*
// before any of that so a Dock/Finder click has instant feedback.
// The banner is deliberately STATIC (no CSS animation) — the main process is
// blocked for most of the splash's lifetime, and no startup animation is wanted.
let splashWindow = null;
let splashTimer = null;
// False until the startup chain has created the first real window. Guards
// window-all-closed / activate so closing the splash while it is the ONLY
// window can never be read as "the app has no windows left".
let _initialWindowsCreated = false;

// C1171 asset is 1600x657. Height is DERIVED from width below so the ratio can never drift.
const SPLASH_ASPECT = 1600 / 657;         // ≈ 2.43531
const SPLASH_MIN_W = 560;
const SPLASH_MAX_W = 960;
const SPLASH_WIDTH_FRACTION = 0.40;       // of the target display's work-area width
const SPLASH_MAX_HEIGHT_FRACTION = 0.35;  // never eat more than a third of a short/rotated display

// (C1172) Computes size + position from the display under the cursor (falls back to
// primary) instead of a fixed 640x263 + center:true. `center:true` on macOS maps to
// [NSWindow center], which AppKit documents as placing the window ABOVE true vertical
// middle (more slack below than above) — that was the "slightly too high" symptom this
// replaces. workArea.x/.y are non-zero on macOS (menu bar) and on secondary displays, so
// they're added explicitly rather than assumed 0.
function computeSplashBounds() {
  const { screen } = require('electron'); // required lazily — screen must not be touched before app 'ready'
  let wa;
  try {
    const pt = screen.getCursorScreenPoint();
    wa = (screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay()).workArea;
  } catch {
    wa = screen.getPrimaryDisplay().workArea; // headless/odd platforms
  }
  let width = Math.round(
    Math.min(SPLASH_MAX_W, Math.max(SPLASH_MIN_W, wa.width * SPLASH_WIDTH_FRACTION))
  );
  let height = Math.round(width / SPLASH_ASPECT);
  const maxH = Math.round(wa.height * SPLASH_MAX_HEIGHT_FRACTION);
  if (height > maxH) { height = maxH; width = Math.round(height * SPLASH_ASPECT); } // short-display guard, ratio preserved
  return {
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
  };
}

function createSplashWindow() {
  // C1172: geometry (size + true center) comes from computeSplashBounds() above, sized off
  // the cursor's display work area. Aspect ratio (splash-bg.webp is 1600x657 ≈ 2.4353:1) is
  // still load-bearing — background-size:cover crops the artwork if width/height ever drift
  // off that ratio, so computeSplashBounds() derives height from width, never sets them independently.
  splashWindow = new BrowserWindow({
    ...computeSplashBounds(),
    show: false,                // shown on ready-to-show → first frame is the finished banner
    frame: false,
    resizable: false,
    movable: false,             // no drag region in splash.html; nothing to drag with
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,          // no taskbar/alt-tab entry for a few-second window
    title: 'TipΔTask',
    backgroundColor: '#f1f1ef', // == splash.html body bg (C1171 paper tone); no dark pre-paint rect
    icon: getIconPath(),
    webPreferences: {
      // No preload on purpose — preload.js exposes the whole project/task API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // assets/** ships inside app.asar (package.json build.files) and loadFile reads
  // through Electron's asar shim, so this resolves in dev and packaged builds.
  // TPT398: version travels as a `?v=` query (the splash has no preload). resolveAppVersion()
  // never throws; '' → no query → splash renders the copyright alone.
  const splashVersion = resolveAppVersion({
    getVersion: () => app.getVersion(),
    readPackageVersion: () => require('./package.json').version,
  });
  splashWindow.loadFile(
    path.join(__dirname, 'assets', 'splash.html'),
    splashVersion ? { query: { v: splashVersion } } : undefined
  );
  splashWindow.on('closed', () => { splashWindow = null; });

  // Safety net: the splash is frameless with no close button. Never strand it if
  // the first project window never reaches did-finish-load (server hang, crash).
  splashTimer = setTimeout(() => {
    console.warn('[splash] safety timeout — closing splash');
    closeSplash();
  }, 60_000);

  return new Promise((resolve) => {
    let settled = false;
    const paintGuard = setTimeout(() => finish(), 1500); // never gate startup on the splash
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(paintGuard);
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
      // (C1173) Splash-paint timing log — measures the part of startup that runs
      // BEFORE any of our own JS executes (process creation → first frame shown),
      // which is exactly what module-load deferrals (compile cache, lazy requires,
      // migrateUserDataDir moved off module scope) are meant to shrink. Kept
      // permanently, not just for this task's verification.
      if (_processCreatedAt != null) {
        console.log('[startup] splash painted +%dms', Date.now() - _processCreatedAt);
      }
      resolve();
    }
    splashWindow.once('ready-to-show', finish);
  });
}

function closeSplash() {
  clearTimeout(splashTimer);
  splashTimer = null;
  const w = splashWindow;
  splashWindow = null;                       // null first → re-entrant calls are no-ops
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch {} }
}

function attachExternalLinkPolicy(w) {
  const appOrigin = `http://127.0.0.1:${PORT}`;
  const openIfExternal = (url) => {
    if (!shouldOpenExternally(url, appOrigin)) return;
    shell.openExternal(url).catch((err) => {
      console.warn('[external-link] Failed to open URL:', err.message);
    });
  };

  w.webContents.setWindowOpenHandler(({ url }) => {
    openIfExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openIfExternal(url);
  });
}

// ── Setup window (unconfigured folder picked via Project → Open / Create Project) ─
// Blank window that immediately shows the setup wizard for projectPath.
// On wizard completion project:open-existing adopts it as the project window.
// On cancel the renderer calls closeCurrentProject() → closes this window.
// (C1388) Registered in the window-registry's setup map so a second pick of the same
// unconfigured path focuses this window instead of spawning a duplicate (see
// project:open-setup-window above) — this window used to be invisible to that check.
function createSetupWindow(projectPath) {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: getWindowTitle(null),
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // (C1356) This window keeps a live background WS (__attention__) whose reconnect/
      // ping timers must keep firing when occluded/minimized — Chromium's default renderer
      // timer throttling can clamp them to ~once/minute, delaying reconnection by minutes
      // exactly while the user is away and most likely to miss a needs-attention prompt.
      backgroundThrottling: false,
    },
  });
  attachExternalLinkPolicy(w);
  // Main process is sole title authority.
  w.webContents.on('page-title-updated', (e) => e.preventDefault());
  claimSetup(projectPath, w);
  attachCloseGuard(w);
  const wcId = w.webContents.id;
  projectDirs.set(wcId, null);
  bindWindowToProject(wcId, null);
  w.loadURL(`http://127.0.0.1:${PORT}/todo.html`);
  w.webContents.on('did-finish-load', () => {
    if (w.isDestroyed()) return;
    w.webContents.send('workspace-loaded', workspaceState);
    // Tell the renderer to open the setup wizard for this path.
    w.webContents.send('setup:open-for-path', projectPath);
  });
  w.on('closed', () => {
    // projectDirs[wcId] stays null unless project:open-existing adopted the window
    // (which already releaseSetup()'d it — this is then a harmless no-op scan).
    const dir = projectDirs.get(wcId) || null;
    projectDirs.delete(wcId);
    dropWindow(wcId);
    releaseSetup(w);
    if (dir && releaseProject(dir, w)) scheduleOpenProjectsSync();
  });
  return w;
}

async function createProjectWindow(projectDir, { deferShow = false } = {}) {
  if (!await ensureProjectAccess(projectDir)) return null;
  if (projectDir) addToWorkspace(projectDir, getDisplayName(projectDir));
  rememberRecentProject(projectDir);

  // Focus existing window rather than opening a duplicate. ownerOf() purges a
  // destroyed entry as a side effect, so a stale map row can never block re-creation.
  const existing = ownerOf(projectDir);
  if (existing && focusWindow(existing)) return existing;

  // Self-heal: regenerate .mcp.json with absolute paths for external projects so the
  // tipatask MCP server can launch from the shared install. Idempotent — skips write
  // when already up-to-date, and no-ops for the Tipatask repo itself.
  if (projectDir && readProjectConfig(projectDir)) {
    try { writeProjectMcpConfig(projectDir, __dirname); } catch (e) {
      console.warn('[mcp-config] .mcp.json write failed:', e.message);
    }
    try { writeProjectSkillsConfig(projectDir, __dirname); } catch (e) {
      console.warn('[skills-config] .claude/skills write failed:', e.message);
    }
    try { writeProjectCodexConfig(projectDir, __dirname); } catch (e) {
      console.warn('[codex-config] createProjectWindow write failed:', e.message);
    }
  }

  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !deferShow,           // C1006: startup windows stay hidden until the board is up
    title: getWindowTitle(getDisplayName(projectDir)),
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // (C1356) This window keeps a live background WS (__attention__) whose reconnect/
      // ping timers must keep firing when occluded/minimized — Chromium's default renderer
      // timer throttling can clamp them to ~once/minute, delaying reconnection by minutes
      // exactly while the user is away and most likely to miss a needs-attention prompt.
      backgroundThrottling: false,
    },
  });
  attachExternalLinkPolicy(w);
  // Main process is the sole title authority; block renderer document.title from overriding.
  w.webContents.on('page-title-updated', (e) => e.preventDefault());
  if (projectDir) {
    w.setTitle(getWindowTitle(getDisplayName(projectDir)));
    claimProject(projectDir, w);
    scheduleOpenProjectsSync();
  }
  const wcId = w.webContents.id;
  projectDirs.set(wcId, projectDir || null);
  bindWindowToProject(wcId, projectDir || null);
  w.loadURL(`http://127.0.0.1:${PORT}/todo.html${projectDir ? '?projectPath=' + encodeURIComponent(projectDir) : ''}`);
  w.webContents.on('did-finish-load', () => {
    if (w.isDestroyed()) return;
    const currentProjectDir = projectDirs.get(wcId) || null;
    if (currentProjectDir) w.setTitle(getWindowTitle(getDisplayName(currentProjectDir)));
    w.webContents.send('workspace-loaded', workspaceState);
    if (currentProjectDir) w.webContents.send('project:changed', currentProjectDir, getDisplayName(currentProjectDir));
    // No project loaded — prompt user to create or open one.
    if (!currentProjectDir) w.webContents.send('project:menu', 'choose');
    // (C1352) A project dir was passed but has no readable .tipatask/config.json — e.g. a
    // stale workspace/recent-projects entry whose config was deleted. bindWindowToProject
    // (window-state.js) now leaves this window with backend:null rather than silently handing
    // it a retired file backend, so surface the setup wizard instead of a blank board. Mirrors
    // open-project's needsSetup check ('open-project' handler above): try migrateFromLegacy
    // first so an existing legacy-.env project doesn't get a spurious wizard.
    if (currentProjectDir && !readProjectConfig(currentProjectDir)) {
      let migrated = null;
      try {
        const { migrateFromLegacy } = require('./src/server/project-config');
        migrated = migrateFromLegacy(currentProjectDir);
      } catch (e) {
        console.warn('[main] migrateFromLegacy failed for', currentProjectDir, e.message);
      }
      if (migrated) {
        bindWindowToProject(wcId, currentProjectDir);
      } else {
        w.webContents.send('setup:open-for-path', currentProjectDir);
      }
    }
    // C1006: board is up — hand off. Show first, close splash second, so the
    // screen is never empty and the user never sees an unpainted window.
    if (!w.isVisible()) w.show();
    closeSplash();
  });
  if (deferShow) {
    // Safety net: a hidden startup window must never stay hidden if the board
    // fails to load — show it (and drop the splash) so the user sees the error
    // state instead of a silently stuck splash.
    w.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || w.isDestroyed()) return;
      w.show();
      closeSplash();
    });
  }
  // (C1429) Guards close paths the renderer never sees — the OS title-bar close
  // button/X, and any future direct w.close() call. project:close/project:remove/quit
  // already asked (or intentionally don't) and mark _closeConfirmed before calling
  // w.close(), so this only fires for those bypass paths.
  attachCloseGuard(w);
  w.on('closed', () => {
    // (C1388) Read the window's CURRENT dir, not the closure's projectDir — a window
    // that later adopted a different path (in-place rebind, or C1352 heal) must only
    // ever release ITS OWN current entry. releaseProject() is identity-checked, so
    // even a stale `dir` here can never delete another live window's registration.
    const dir = projectDirs.get(wcId) || null;
    projectDirs.delete(wcId);
    dropWindow(wcId);
    releaseSetup(w);
    if (dir && releaseProject(dir, w)) {
      scheduleOpenProjectsSync();
    }
  });
  return w;
}

// (C1389, opts widened C1559) Web→Task App handoff — by the time this runs, the server
// child's /start-task route has already fully validated project + account + task; this
// only focuses (or creates) the window and pushes the seed. createProjectWindow() itself
// already focuses an existing owner instead of duplicating (C1269/C1388), so the only
// new concern here is timing: a brand-new window hasn't finished loading todo.html yet,
// so 'open-objective' would arrive before the renderer's listener is registered. Guard
// with isLoading() (true only for the fresh-window path — an existing focused window is
// already loaded) and defer to 'did-finish-load' in that case.
async function focusAndSeedObjective(projectPath, taskKey, { warning, originTaskKey, title, description } = {}) {
  const w = await createProjectWindow(projectPath);
  if (!w || w.isDestroyed()) return;
  const send = () => {
    if (w.isDestroyed()) return;
    w.webContents.send('open-objective', { taskKey, warning, originTaskKey: originTaskKey || null, title: title || null, description: description || null });
  };
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// (C1559) Sibling of focusAndSeedObjective() for the /start-task route's other 2
// dispatch branches. Same validation-already-done, same isLoading()/did-finish-load
// timing guard. `children` is the fetched child-task list (empty for a regular task);
// the renderer picks which one to start (see template.html's 'start-task' listener →
// startTaskById()) because it alone holds the live board status map isDepsBlocked()
// needs — this function and the server route are deliberately status-map-free.
async function focusAndStartTask(projectPath, taskKey, { children } = {}) {
  const w = await createProjectWindow(projectPath);
  if (!w || w.isDestroyed()) return;
  const send = () => {
    if (w.isDestroyed()) return;
    w.webContents.send('start-task', { taskKey, children: Array.isArray(children) ? children : [] });
  };
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// (C1430) Sentinel contract on projectPaths: non-array (null/undefined) → workspace.json
// fallback below (reachable only from whenReady's missing-session-file branch); [] → the
// projects.length===0 branch fires → exactly one blank unbound window; non-empty array →
// one window per path. No live caller passes a non-array after this task — kept as a
// defensive default, not because anything currently relies on it.
async function createInitialWindows(projectPaths = null, opts = {}) {
  const projects = Array.isArray(projectPaths)
    ? projectPaths
    : (workspaceState?.openProjects || []).map(entry => entry.path);
  if (projects.length === 0) {
    await createProjectWindow(null, opts);
  } else {
    let opened = false;
    for (const projectPath of projects) {
      if (await createProjectWindow(projectPath, opts)) opened = true;
    }
    if (!opened) await createProjectWindow(null, opts);
  }
}

app.whenReady()
  .then(async () => {
    // C1006: splash first, awaited until its first frame is painted — the
    // captureLoginShellPath() call below blocks the main process for up to 10 s,
    // so anything created after it (or not yet painted) would show as an empty rect.
    await createSplashWindow();

    // (C1173) Moved here from module load — splash is already painted (log above
    // proves it), so this userData copy I/O no longer sits in the dead-air window
    // before the user sees anything. See migrateUserDataDir()'s own header comment.
    console.time('[migrate-userdata] elapsed');
    migrateUserDataDir();
    console.timeEnd('[migrate-userdata] elapsed');

    // Capture the user's login-shell PATH before forking the server.
    // A GUI-launched Electron app (Finder, dock) inherits only the minimal
    // launchd PATH, so claude/codex installed in ~/.local/bin, ~/.codex/bin,
    // /opt/homebrew/bin, etc. would otherwise be invisible to resolveBin().
    // Injecting the full PATH here propagates it to:
    //   • the forked todo-server.js child (via {...process.env} in startServer)
    //   • spawn-utils.js AUGMENTED_PATH computed at module load in the child
    //   • listAvailableTaskAgents() called in-process by the project wizard
    try {
      const { captureLoginShellPath } = require('./src/server/spawn-utils');
      const shellPath = captureLoginShellPath();
      if (shellPath) process.env.PATH = shellPath;
    } catch { /* non-fatal; resolveBin probe dirs still cover common locations */ }

    // (C1141) Before the server child forks (startServer, next .then) — see
    // runBundleSignatureCheck() above.
    await runBundleSignatureCheck();

    // (C1057) 'notifications' added — this used to deny it outright, which is why the
    // fallback Web Notification path in src/client/notifications.js never worked (the primary
    // path is the native 'notify:show' IPC handler above, unaffected by this). `media`
    // semantics unchanged.
    const ALLOWED_NOTIFICATION_PERMISSIONS = new Set(['media', 'notifications']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(ALLOWED_NOTIFICATION_PERMISSIONS.has(permission));
    });
    // Electron's synchronous `Notification.permission` getter in the renderer consults the
    // CHECK handler, not the request handler above — without this, the renderer kept
    // reporting 'denied' even after a request-handler grant, since only the request handler
    // existed before this task.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_NOTIFICATION_PERMISSIONS.has(permission));
    // Route local HTTP and WebSocket requests to the bound project with a signed
    // capability. The callback strips these headers from every other target,
    // including redirected requests.
    installProjectRequestHeaders(session.defaultSession, {
      projectDirs, port: PORT, secret: LOCAL_SECRET,
      getProjectPath: (id) => getWindowState(id).projectPath || '',
    });
  })
  .then(startServer)
  .then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(getDockIconPath());
    workspaceState = loadWorkspace(app.getPath('userData'));
    workspaceState = filterValidWorkspaceProjects(workspaceState);
    try { saveWorkspace(app.getPath('userData'), workspaceState); } catch {}
    // C1218 — wire window-state.js's KB auto-reindex window-bind trigger to the forked
    // server over the existing fork IPC channel (delegates the run to the process that
    // has the correct PROJECT_ROOT/cwd and the arch-cache agents actually read from —
    // see ai/architecture/tt-knowledge-sync.md § Auto-Trigger on Sync for why main never
    // runs the reindex itself). serverChild is guaranteed alive here — startServer()
    // already resolved.
    setServerMessenger((msg) => { try { serverChild?.send(msg); } catch {} });
    // (C1318) One more forced re-verify now that the server child has actually started (and,
    // per its own DATA_ROOT resolution, may have just written TODO.md/recipes for the first
    // time this launch) — the pre-fork check above can't see a seal this same launch goes on
    // to break moments later. Fire-and-forget: registerIpcHandlers() below must not wait on it.
    refreshBundleSignatureState({ force: true }).catch(() => {});
    registerIpcHandlers();
    // (C1173) Lazy require — see the top-of-file note by the deleted top-level require
    // for why (drags in src/server/config.js's module-scope migration/config I/O).
    require('./main/ipc/api-router').registerApiHandlers();
    // Warm CLI detection once PATH is fully augmented (captureLoginShellPath ran above).
    // resolveBin() memoizes, so this also pre-warms path resolution for agent spawning.
    try { global.cliPaths = require('./src/cli/detect').detectCli(); } catch {}
    app.setAboutPanelOptions({
      applicationName: app.getName(),       // 'TipATask'
      applicationVersion: app.getVersion(), // package.json "version"
      version: app.getVersion(),            // macOS build string (parens line)
      // (C1532) macOS-only field — Pi Coding Agent MIT attribution (C1531). The full
      // notices text lives in the "Third-Party Licenses" item added to this same
      // app-menu submenu, not here (the native panel has no room for 30KB of text).
      credits: mt('about.credit'),
    });
    createMenu();
    reconcileRecentProjectsWithAccounts(); // (TPT451) fire-and-forget; rebuilds the menu when done
    // (C1430) session.json === [] (user closed every project window before quitting) must
    // NOT trigger cross-device restore — only a missing/unreadable file (null) does. See
    // loadWindowSession()'s contract comment and window-session.js.
    const sessionPaths = loadWindowSession();
    const restoredPaths = shouldRestoreFromDevice(sessionPaths) ? await restoreFromLastUsedDevice() : [];
    await createInitialWindows(resolveStartupProjectPaths(sessionPaths, restoredPaths), { deferShow: true });
    _initialWindowsCreated = true; // C1006: real windows exist; quit guards released
  })
  .catch((err) => {
    // Surface any unhandled startup failure instead of silently producing a
    // blank no-op (the app.whenReady chain has no implicit error sink).
    closeSplash(); // C1006: never leave the splash over the startup error dialog
    console.error('[startup] fatal:', err);
    dialog.showErrorBox('TipΔTask — startup failed', err?.message || String(err));
    quitWithoutConfirmation();
  });

let _quitting = false;
app.on('before-quit', (event) => {
  if (!_quitConfirmed) {
    event.preventDefault();
    confirmAndQuit();
    return;
  }
  saveWindowSession();
  if (!_quitting) {
    _quitting = true;
    event.preventDefault();
    const timeout = new Promise(r => setTimeout(r, 1500));
    Promise.race([_syncOpenProjectsNow(), timeout])
      .catch(() => {})
      .finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  // C1006: during startup the splash may be the only window; closing it (safety
  // timeout, or Cmd+W on the frameless splash — Electron's default menu is live
  // until createMenu() runs late in startup) must not be read as "app is done".
  if (!_initialWindowsCreated) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // C1006: Dock click during startup → raise the splash, don't spawn a window
  // against a server that may not be listening yet.
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.show();
    splashWindow.focus();
    return;
  }
  if (!_initialWindowsCreated) return;
  // (C1430) Explicit [] here, not the no-arg workspace fallback: session.json is stale at
  // this point (only written on before-quit) and workspace.json is a "projects I know
  // about" list, not a "what was open" signal — reopening every workspace project on a
  // Dock click after the user closed everything was the live repro of "opens ALL OF THE
  // PROJECTS". One blank window instead.
  if (BrowserWindow.getAllWindows().length === 0) createInitialWindows([]);
});

app.on('quit', () => {
  try { if (serverChild) serverChild.kill(); } catch {}
});

// (C1388) The native menu is one shared app-level object on macOS — switching focus
// between two windows on projects with different languages must re-derive the menu
// locale from whichever window just became frontmost, independent of the renderer's
// own app:set-locale pushes (which only fire on boot/explicit switch, not on focus).
// Read straight off disk via projectDirs — cheap (sync JSON read of a config already
// this small) and avoids adding a third locale-tracking map.
app.on('browser-window-focus', (_event, w) => {
  try {
    if (!w || w.isDestroyed() || w === splashWindow) return;
    const dir = projectDirs.get(w.webContents.id) || null;
    if (!dir) return;
    const cfg = readProjectConfig(dir);
    const lang = cfg?.language || 'en';
    if (getMenuLocale() === (LOCALES[lang] ? lang : 'en')) return;
    setMenuLocale(lang);
    if (app.isReady()) createMenu();
  } catch (e) {
    console.warn('[menu-i18n] browser-window-focus locale sync failed (non-fatal):', e.message);
  }
});
