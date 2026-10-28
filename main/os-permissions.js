'use strict';

// (TPT9112) Startup OS permission requests (macOS). The desktop app used to ask for each
// permission lazily: notifications on the first native alert, the microphone on the first
// voice input, Desktop/Documents/Downloads on an agent's first read there. The first task on
// a fresh install could then stall mid-run on a system prompt. requestStartupPermissions()
// asks for all of them once, right after the startup windows exist, behind a one-time
// explanation (the `permissions.*` strings in menu-i18n.js).
//
// main.js passes the Electron objects in and the unit test (src/server/os-permissions.test.js)
// replaces every other dependency, so this module never requires electron and does no I/O at
// load (C1173). Outcomes are kept in <userData>/os-permissions.json:
//   { version, explainedAt, permissions: { <id>: { status, appVersion, execPath, checkedAt } } }
// id: 'notifications' | 'microphone' | 'folder:<absolute path>'.
// status: granted | denied | restricted (microphone blocked by device policy) | not-granted
// (notifications not allowed within the probe window: macOS reports a refusal and an
// unanswered request the same way) | missing (no such folder) | unsupported | unknown (no
// answer in time, or an unexpected error).
// A granted entry is skipped on later launches (stillGranted()). The explanation shows only
// while the file does not exist.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LOCALES } = require('./menu-i18n');

const MARKER_FILE = 'os-permissions.json';
const MARKER_VERSION = 1;
// Protected folders agents commonly read. The open project folders are added per launch.
const STANDARD_FOLDERS = ['Desktop', 'Documents', 'Downloads'];
// Notification authorization belongs to the bundle id, so it survives app updates. TCC ties an
// ad-hoc-signed build's microphone and folder grants to that build's signature, so those are
// asked again after an update (tt-electron-app.md § Packaging, TCC scoping caveat).
const SURVIVES_UPDATE = new Set(['notifications']);

// Waits, in milliseconds.
const TIMING = {
  // How long the explanation waits for the first project window to come on screen (startup
  // windows are created hidden, C1006) before it opens as a standalone dialog instead of a sheet.
  windowShowMs: 30_000,
  // Gap before each notification probe, about two minutes in all while the user answers the alert.
  notificationRetryMs: [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000],
  // How long one probe waits for macOS to deliver or fail it.
  notificationAttemptMs: 5000,
  // A Files & Folders prompt holds its read until answered; past this the folder is unknown.
  folderMs: 180_000,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with `fallback` when `promise` has not settled within `ms`.
function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stringsFor(locale) {
  return LOCALES[locale] || LOCALES.en;
}

// dialog.showMessageBox() options for the one-time explanation, in the given locale.
function permissionDialog(locale) {
  const strings = stringsFor(locale);
  return {
    type: 'info',
    title: strings['permissions.title'],
    message: strings['permissions.message'],
    detail: strings['permissions.detail'],
    buttons: [strings['permissions.continue']],
    defaultId: 0,
    cancelId: 0,
  };
}

function readMarker(file, fsApi) {
  let text;
  try {
    text = fsApi.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? null : { permissions: {} };
  }
  try {
    const data = JSON.parse(text);
    const permissions = data?.permissions;
    if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) return data;
  } catch { /* unreadable: everything is asked again, the explanation is not shown again */ }
  return { permissions: {} };
}

function writeMarker(file, data, fsApi) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fsApi.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fsApi.renameSync(tmp, file);
}

function stillGranted(entry, id, appVersion, execPath) {
  return entry?.status === 'granted' && entry.execPath === execPath
    && (SURVIVES_UPDATE.has(id) || entry.appVersion === appVersion);
}

// Standard folders first, then each project folder not already listed.
function folderTargets(projectPaths, home) {
  const dirs = [...STANDARD_FOLDERS.map((name) => path.join(home || '', name)), ...projectPaths];
  return [...new Set(dirs.filter((dir) => typeof dir === 'string' && path.isAbsolute(dir))
    .map((dir) => path.resolve(dir)))];
}

// The explanation opens as a sheet on the first project window once the splash has handed off
// to it. A window that does not come on screen in time, or closes, leaves a standalone dialog.
function whenShown(win, ms) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  if (win.isVisible()) return Promise.resolve(win);
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      win.removeListener('show', settle);
      win.removeListener('closed', settle);
      resolve(!win.isDestroyed() && win.isVisible() ? win : null);
    };
    const timer = setTimeout(settle, ms);
    win.once('show', settle);
    win.once('closed', settle);
  });
}

async function explain({ dialog, parentWindow, locale, timing, log }) {
  if (typeof dialog?.showMessageBox !== 'function') return;
  const options = permissionDialog(locale);
  const parent = await whenShown(parentWindow, timing.windowShowMs);
  try {
    await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  } catch (err) {
    log.warn('[os-permissions] explanation dialog failed (non-fatal):', err?.message || err);
  }
}

// Live TCC status, read on every launch: only 'not-determined' can still raise a prompt.
async function requestMicrophone(systemPreferences) {
  if (typeof systemPreferences?.getMediaAccessStatus !== 'function') return 'unsupported';
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status !== 'not-determined') return status;
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

// Notification.isSupported() creates Electron's macOS notification presenter, which requests
// authorization: that raises the "allow notifications" alert. The answer is not exposed, so
// silent probe notifications find it out. macOS delivers a probe ('show', closed straight away)
// only once notifications are allowed and fails it otherwise.
async function probeNotifications(Notification, locale, timing) {
  try {
    if (typeof Notification?.isSupported !== 'function' || !Notification.isSupported()) return 'unsupported';
  } catch {
    return 'unsupported';
  }
  const strings = stringsFor(locale);
  for (const gap of timing.notificationRetryMs) {
    await delay(gap);
    if (await showProbe(Notification, strings, timing.notificationAttemptMs)) return 'granted';
  }
  return 'not-granted';
}

function showProbe(Notification, strings, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (shown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(shown);
    };
    try {
      const probe = new Notification({
        title: strings['permissions.probeTitle'], body: strings['permissions.probeBody'], silent: true,
      });
      // A probe delivered after its wait still closes itself.
      probe.once('show', () => {
        try { probe.close(); } catch { /* already gone */ }
        settle(true);
      });
      probe.once('failed', () => settle(false));
      timer = setTimeout(settle, ms, false);
      probe.show();
    } catch {
      settle(false);
    }
  });
}

// Bounded readdir: opens the folder and reads at most one entry. Reading a protected folder is
// what makes macOS raise its Files & Folders prompt, and the read waits until it is answered.
async function probeFolder(dir, opendir) {
  try {
    const handle = await opendir(dir);
    try {
      await handle.read();
    } finally {
      await handle.close().catch(() => {});
    }
    return 'granted';
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') return 'denied';
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
    return 'unknown';
  }
}

// Asks macOS for every permission an agent run can need, once. Never rejects for a refused or
// failed request; resolves { skipped: true } off macOS, else { skipped: false, explained,
// results: { <id>: status } } for the entries checked this launch.
async function requestStartupPermissions({
  projectPaths = [], userDataPath, parentWindow = null, localeFor = null,
  systemPreferences = null, Notification = null, dialog = null,
  appVersion = '', execPath = process.execPath, platform = process.platform, home = os.homedir(),
  fsApi = fs, opendir = (dir) => fs.promises.opendir(dir, { bufferSize: 1 }),
  timing: waits = {}, log = console, now = () => new Date().toISOString(),
} = {}) {
  if (platform !== 'darwin') return { skipped: true };
  const projects = Array.isArray(projectPaths) ? projectPaths : [];
  const timing = { ...TIMING, ...waits };
  const file = path.join(userDataPath, MARKER_FILE);
  const marker = readMarker(file, fsApi);
  const state = { version: MARKER_VERSION, explainedAt: marker?.explainedAt ?? null,
    permissions: { ...marker?.permissions } };
  const results = {};
  const save = () => {
    try { writeMarker(file, state, fsApi); } catch (err) {
      log.warn('[os-permissions] could not save', file, '(non-fatal):', err?.message || err);
    }
  };
  const record = (id, status) => {
    results[id] = status;
    const prev = state.permissions[id];
    if (prev?.status === status && prev.appVersion === appVersion && prev.execPath === execPath) return;
    state.permissions[id] = { status, appVersion, execPath, checkedAt: now() };
    save();
  };
  const pending = (id) => !stillGranted(state.permissions[id], id, appVersion, execPath);
  // The explanation and the probe notification speak the first project's language.
  let locale = 'en';
  try { if (projects[0] && localeFor) locale = localeFor(projects[0]); } catch { /* en */ }

  if (!marker) {
    await explain({ dialog, parentWindow, locale, timing, log });
    state.explainedAt = now();
    save();
  }
  // The notification alert is answered on the user's own time, so it is probed beside the TCC
  // prompts rather than ahead of them.
  const notifications = pending('notifications')
    ? probeNotifications(Notification, locale, timing).then((status) => record('notifications', status))
    : null;
  record('microphone', await requestMicrophone(systemPreferences));
  // One folder at a time: an unanswered prompt keeps its read blocked on a libuv worker thread,
  // so a folder that does not settle in time ends this launch's folder pass.
  for (const dir of folderTargets(projects, home)) {
    const id = `folder:${dir}`;
    if (!pending(id)) continue;
    const status = await within(probeFolder(dir, opendir), timing.folderMs, null);
    record(id, status || 'unknown');
    if (!status) break;
  }
  await notifications;
  return { skipped: false, explained: !marker, results };
}

module.exports = { requestStartupPermissions, permissionDialog, MARKER_FILE };
