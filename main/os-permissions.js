'use strict';

// (TPT9112) Startup OS permission requests (macOS). The desktop app used to ask for each
// permission lazily: notifications on the first native alert, the microphone on the first
// voice input, Desktop/Documents/Downloads on an agent's first read there. The first task on
// a fresh install could then stall mid-run on a system prompt. requestStartupPermissions()
// requests supported permissions right after the startup windows exist, behind a one-time
// explanation (the `permissions.*` strings in permissions-i18n.js, en/uk/zh/es). App Management
// has no public Electron authorization API: ensureStartupAppManagementPermission() offers
// Settings guidance. Computer use needs Screen Recording and Accessibility, which have no
// request API either: ensureComputerUsePermissions() reads both on every launch and shows one
// prompt naming the ones that are off, with a button to their System Settings pane.
//
// main.js passes the Electron objects in and the unit test (src/server/os-permissions.test.js)
// replaces every other dependency, so this module never requires electron and does no I/O at
// load (C1173). Outcomes are kept in <userData>/os-permissions.json:
//   { version, explainedAt, permissions: { <id>: { status, appVersion, execPath, checkedAt } } }
// id: 'notifications' | 'microphone' | 'folder:<absolute path>' | 'app-management' |
// 'screen-recording' | 'accessibility'.
// status: granted | denied | restricted (blocked by device policy) | not-granted (notifications
// not allowed within the probe window, or Screen Recording/Accessibility off: macOS reports a
// refusal and an unanswered request the same way) | missing (no such folder) | unsupported |
// unknown (no answer in time, or an unexpected error) | settings-guidance (App Management
// guidance was shown, NOT an OS authorization result) | skipped (the user chose Don't Ask Again
// for a computer-use item). settings-guidance and skipped are kept across app updates and
// executable moves. A granted entry is skipped on later launches (stillGranted()); Screen
// Recording and Accessibility are read live every launch instead. The explanation shows only
// while the file does not exist.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLocale, permissionStrings } = require('./permissions-i18n');

const MARKER_FILE = 'os-permissions.json';
const MARKER_VERSION = 1;
const APP_MANAGEMENT_ID = 'app-management';
const APP_MANAGEMENT_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles';
const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security';
// The macOS permissions computer use needs: agents take screenshots (Screen Recording) and click
// and type in apps (Accessibility). TCC attributes both to TipATask, the responsible app of every
// agent it spawns. Order matters: Open System Settings shows the first missing item's pane.
const COMPUTER_USE = [
  {
    id: 'screen-recording', name: 'permissions.screenRecording', line: 'permissions.screenRecordingItem',
    settings: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    status: screenRecordingStatus,
  },
  {
    id: 'accessibility', name: 'permissions.accessibility', line: 'permissions.accessibilityItem',
    settings: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    status: accessibilityStatus,
  },
];
// computerUseDialog() button indexes.
const OPEN_SETTINGS = 0;
const DONT_ASK_AGAIN = 2;
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
  return permissionStrings(locale);
}

// Substitutes {name} placeholders; an unknown one stays as written.
function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? params[key] : match));
}

// "A and B" in the dialog's language; a plain comma list where Intl.ListFormat is unavailable.
function listNames(names, locale) {
  try {
    return new Intl.ListFormat(normalizeLocale(locale), { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
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

function appManagementDialog(locale) {
  const strings = stringsFor(locale);
  return {
    type: 'info',
    title: strings['permissions.title'],
    message: strings['permissions.appManagementMessage'],
    detail: strings['permissions.appManagementDetail'],
    buttons: [strings['permissions.openSettings'], strings['permissions.later']],
    defaultId: 1,
    cancelId: 1,
  };
}

// dialog.showMessageBox() options for the computer-use prompt, naming only the given ids, in
// COMPUTER_USE order. Enter opens System Settings and Escape is Later; only an explicit
// Don't Ask Again stops the named items from being asked about again.
function computerUseDialog(locale, ids) {
  const strings = stringsFor(locale);
  const items = COMPUTER_USE.filter((item) => ids.includes(item.id));
  return {
    type: 'info',
    title: strings['permissions.title'],
    message: fill(strings['permissions.computerUseMessage'], {
      names: listNames(items.map((item) => strings[item.name]), locale),
    }),
    detail: fill(strings['permissions.computerUseDetail'], {
      list: items.map((item) => strings[item.line]).join('\n'),
    }),
    buttons: [strings['permissions.openSettings'], strings['permissions.later'], strings['permissions.dontAskAgain']],
    defaultId: OPEN_SETTINGS,
    cancelId: 1,
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

// App Management (SystemPolicyAppBundles, macOS 13 / Darwin 22+) controls changes to other
// apps' bundles. It is distinct from Accessibility, Automation and Full Disk Access. Electron
// cannot query/request it. Never probe by modifying an installed app or reading the TCC DB.
// Fresh, granted and denied OS states are all unobservable here: offer the same optional
// guidance once and never label opening Settings as a grant. Windows UAC and Linux polkit
// authorize specific privileged operations; there is no startup grant to acquire there.
async function ensureStartupAppManagementPermission({
  platform = process.platform, release = os.release(), previous = null,
  dialog = null, shell = null, parentWindow = null, locale = 'en', record = () => {},
  timing: waits = {}, log = console,
} = {}) {
  const darwinMajor = Number(/^(\d+)\./.exec(release)?.[1]);
  if (platform !== 'darwin' || !Number.isFinite(darwinMajor) || darwinMajor < 22) return 'unsupported';
  if (previous?.status === 'settings-guidance') return 'settings-guidance';
  if (typeof dialog?.showMessageBox !== 'function') return 'unsupported';
  let guidanceShown = false;
  try {
    const parent = await whenShown(parentWindow, { ...TIMING, ...waits }.windowShowMs);
    const options = appManagementDialog(locale);
    const answer = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    // Persist before waiting: quitting with the dialog open must not repeat it next launch.
    record(APP_MANAGEMENT_ID, 'settings-guidance');
    guidanceShown = true;
    const { response } = await answer;
    if (response === 0 && typeof shell?.openExternal === 'function') {
      try {
        await shell.openExternal(APP_MANAGEMENT_SETTINGS);
      } catch {
        // Settings anchors vary by OS release; the dialog also gives the manual path.
        await shell.openExternal(PRIVACY_SETTINGS);
      }
    }
    return 'settings-guidance';
  } catch (err) {
    log.warn('[os-permissions] App Management guidance failed (non-fatal):', err?.message || err);
    return guidanceShown ? 'settings-guidance' : 'unknown';
  }
}

// getMediaAccessStatus('screen') reads CGPreflightScreenCaptureAccess(): 'granted', or 'denied'
// for a refusal and a never-asked app alike. It never prompts.
function screenRecordingStatus(systemPreferences) {
  if (typeof systemPreferences?.getMediaAccessStatus !== 'function') return 'unsupported';
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted' || status === 'restricted') return status;
    return status === 'denied' || status === 'not-determined' ? 'not-granted' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// isTrustedAccessibilityClient(false) only checks; true would raise macOS's own alert.
function accessibilityStatus(systemPreferences) {
  if (typeof systemPreferences?.isTrustedAccessibilityClient !== 'function') return 'unsupported';
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not-granted';
  } catch {
    return 'unknown';
  }
}

// Screen Recording and Accessibility for computer use. Both are read live on every launch,
// without an OS prompt, and recorded; then at most one dialog names the items that are off
// (computerUseDialog()). Open System Settings opens the first one's pane, falling back to
// Privacy & Security. Don't Ask Again records the named items as skipped: a skipped item is
// never read or named again, across app updates and executable moves. Later, Escape, Open
// System Settings or a failed dialog leave the items to the next launch's check. Resolves
// { <id>: status } and never rejects; outside macOS every item is unsupported and no
// dependency is touched.
async function ensureComputerUsePermissions({
  platform = process.platform, systemPreferences = null, previous = {},
  dialog = null, shell = null, parentWindow = null, locale = 'en', record = () => {},
  timing: waits = {}, log = console,
} = {}) {
  const statuses = {};
  if (platform !== 'darwin') {
    for (const { id } of COMPUTER_USE) statuses[id] = 'unsupported';
    return statuses;
  }
  for (const item of COMPUTER_USE) {
    statuses[item.id] = previous?.[item.id]?.status === 'skipped' ? 'skipped' : item.status(systemPreferences);
    record(item.id, statuses[item.id]);
  }
  const missing = COMPUTER_USE.filter((item) => statuses[item.id] === 'not-granted');
  if (!missing.length || typeof dialog?.showMessageBox !== 'function') return statuses;
  try {
    const parent = await whenShown(parentWindow, { ...TIMING, ...waits }.windowShowMs);
    const options = computerUseDialog(locale, missing.map((item) => item.id));
    const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    if (response === DONT_ASK_AGAIN) {
      for (const item of missing) {
        statuses[item.id] = 'skipped';
        record(item.id, 'skipped');
      }
    } else if (response === OPEN_SETTINGS && typeof shell?.openExternal === 'function') {
      try {
        await shell.openExternal(missing[0].settings);
      } catch {
        // Settings anchors vary by OS release; the dialog also gives each item's path.
        await shell.openExternal(PRIVACY_SETTINGS);
      }
    }
  } catch (err) {
    log.warn('[os-permissions] computer use prompt failed (non-fatal):', err?.message || err);
  }
  return statuses;
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

// Requests supported macOS permissions, offers App Management Settings guidance and asks once for
// the computer-use permissions that are off. main.js calls it once per launch. Never rejects for a
// refused or failed request; resolves { skipped: true } off macOS, else { skipped: false,
// explained, results: { <id>: status } } for the entries checked this launch.
async function requestStartupPermissions({
  projectPaths = [], userDataPath, parentWindow = null, localeFor = null,
  systemPreferences = null, Notification = null, dialog = null, shell = null,
  appVersion = '', execPath = process.execPath, platform = process.platform, home = os.homedir(),
  release = os.release(),
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
  record(APP_MANAGEMENT_ID, await ensureStartupAppManagementPermission({
    platform, release, previous: state.permissions[APP_MANAGEMENT_ID],
    dialog, shell, parentWindow, locale, record, timing, log,
  }));
  // Our own dialogs come first and the system prompts after them: the computer-use prompt is
  // answered before notifications, the microphone and folders start asking.
  await ensureComputerUsePermissions({
    platform, systemPreferences, previous: state.permissions,
    dialog, shell, parentWindow, locale, record, timing, log,
  });
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

module.exports = {
  requestStartupPermissions, ensureStartupAppManagementPermission, ensureComputerUsePermissions,
  permissionDialog, appManagementDialog, computerUseDialog, MARKER_FILE,
};
