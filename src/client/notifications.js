import { getLocale } from './i18n.js';
import { activateLocalNotification, dismissTaskCards, notificationProjectPath, removeLocalNotification, taskNotificationTags } from './notification-center.js';

const _lastNotifiedAt = new Map();
const DEBOUNCE_MS = 30000;
// (C1138) Web Notification API replaces an on-screen banner whenever a new one shares the same
// `tag` (spec behavior — unlike Electron's main-process Notification, which gets a fresh random
// `id` per `new Notification()` call regardless of `tag` and so never collides this way, see
// tt-notifications.md § C1138). A per-call-unique suffix on the *browser-facing* tag stops that
// replacement; `_lastNotifiedAt`/`_clickHandlers` stay keyed on the real (unsuffixed) tag below,
// since debounce/click-routing must still dedupe/route by task, not by individual banner.
let _notifySeq = 0;
const _notificationSession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const _desktopDelivery = () => typeof window !== 'undefined' && window.electronAPI?.notificationDelivery === 'desktop';
// (C1057) tag -> onClick, main-process transport only — Electron's Notification has no
// `onclick`/`tag` of its own, so the click bridge (notify:clicked IPC) needs somewhere to
// look the callback up by the tag we sent it.
const _clickHandlers = new Map();
// Retain browser instances and desktop callback identities until their surface closes.
const _deliveries = new Map();
function releaseDelivery(key) {
  _clickHandlers.delete(key);
  _deliveries.delete(key);
}

export function dismissTaskNotifications(taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) return;
  const projectPath = notificationProjectPath();
  const tags = taskNotificationTags(taskId);
  dismissTaskCards(taskId, projectPath);
  for (const [key, entry] of _deliveries) {
    if (entry.projectPath !== projectPath || !tags.has(entry.tag)) continue;
    releaseDelivery(key);
    if (entry.notification) {
      entry.notification.onclick = null;
      entry.notification.onclose = null;
      entry.notification.onerror = null;
      try { entry.notification.close(); } catch (_) {}
    }
  }
  // Invoke before a fresh completion send. Main scopes the removal to the sender's
  // bound project and removes all matching entries in one publish, including overflow.
  try {
    const result = window.electronAPI?.dismissTaskNotifications?.(taskId);
    Promise.resolve(result).catch((err) => debugNotifyLog('task notification dismissal failed', taskId, err));
  } catch (err) { debugNotifyLog('task notification dismissal failed', taskId, err); }
}
let _bridgeInstalled = false;

// Electron click/dismiss bridge from main's shared alert registry. Installed on the first
// notify() and at boot (index.js), so alerts that only exist as mirrored in-app cards (TPT484)
// still route their clicks and dismissals back to this window.
export function ensureNotificationBridge() {
  if (_bridgeInstalled || typeof window === 'undefined' || typeof window.electronAPI?.onNotificationClick !== 'function') return;
  _bridgeInstalled = true;
  window.electronAPI.onNotificationClick((payload = {}) => {
    const { tag: clickedTag, notificationId: clickedId, projectPath, cardSeq } = payload || {};
    // (C1069) Payload names the project that RAISED the notif. A mismatch means this
    // renderer got reloaded into a different project since the banner went up (e.g.
    // project:open target:'current') — acting on it would open a terminal on the wrong
    // board. Null on EITHER side is NOT a mismatch: a setup window adopted via
    // adoptProjectIntoWindow() has a project in main but no ?projectPath= in its URL.
    let mine = null;
    try { mine = window.electronAPI.getProjectPath?.() ?? null; } catch (_) { mine = null; }
    if (projectPath && mine && projectPath !== mine) return;
    const key = clickedId || clickedTag;
    const cb = key && _clickHandlers.get(key);
    if (clickedId) releaseDelivery(clickedId);
    // (TPT484) One alert, one action: the notify() callback when registered, otherwise the
    // mirrored in-app card's own onClick. Either way the local card goes too.
    const scope = [clickedTag, projectPath || notificationProjectPath(), { upTo: cardSeq ?? null }];
    if (cb) {
      removeLocalNotification(...scope);
      _dispatchNotificationClick(cb);
    } else {
      activateLocalNotification(...scope);
    }
  });
  window.electronAPI.onNotificationDismiss?.(({ notificationId: id, tag, projectPath, keepCard, cardSeq } = {}) => {
    if (id) releaseDelivery(id);
    // keepCard: a newer send replaced this callback identity, or the on-top setting was turned
    // off (cards fall back to this window's local list). Otherwise the alert is gone everywhere.
    if (!keepCard && tag) removeLocalNotification(tag, projectPath || notificationProjectPath(), { upTo: cardSeq ?? null });
  });
}

// Every category supplies its destination through onClick. Completion provides the terminal
// action; attention, activity, objective, and test banners retain their own destinations.
function _dispatchNotificationClick(onClick, focusWindow = false) {
  if (focusWindow) { try { window.focus(); } catch (_) {} }
  if (typeof onClick === 'function') { try { onClick(); } catch (_) {} }
}

// (C1058) Per-category user preference — terminal-prompt and Objective-Chat-completion
// notifications are gated independently, since a user may want one without the other.
// localStorage value is 'on' | 'off'; unset (or an unknown category) defaults to 'on'.
export const NOTIFY_PREF_KEYS = {
  attention: 'tipatask-notify-attention',
  objective: 'tipatask-notify-objective',
  // (C1355) Task-completion notifications — see completion-notifications.js. No Settings
  // toggle exists for this category either (same as attention/objective post-C1177), so it
  // joins the one-time cleanup below rather than risking a stale 'off' muting it forever.
  completed: 'tipatask-notify-completed',
  // (TPT12) Someone-else-changed-this-task notifications — see activity-notifications.js.
  // Deliberately NOT added to the C1177 cleanup below: that block exists to purge a stale
  // 'off' left behind by a Settings toggle that was removed. This key is brand new and has
  // never had a toggle, so it has no stale value to purge — adding it there would instead
  // silently wipe a future toggle's 'off' choice on every module load.
  activity: 'tipatask-notify-activity',
};
// Tag used by the Settings-modal "Test" button — never gated by a category pref, always
// re-armable so repeated presses keep firing.
export const TEST_TAG = 'tipatask-test';

// (C1177) The Settings-modal category toggles that wrote these keys were removed — the pref API
// (isNotifyEnabled/setNotifyEnabled) and notify()'s category gate stay, in case a future UI wants
// them back, but with no toggle left a stale 'off' from before this change would mute a category
// forever with no way to undo it. One-time cleanup at module load so nobody stays silently muted.
try {
  if (_hasLocalStorage()) {
    localStorage.removeItem(NOTIFY_PREF_KEYS.attention);
    localStorage.removeItem(NOTIFY_PREF_KEYS.objective);
    localStorage.removeItem(NOTIFY_PREF_KEYS.completed);
  }
} catch (_) { /* ignore */ }

// (C1073) Tag for Objective-Chat completion notifications. The Electron click bridge can only look
// an onClick up BY TAG (_clickHandlers below), so an untagged objective notification had no click
// target at all there — clicking it foregrounded the window but never routed to the finished
// session's sub-tab. Tab-scoped: two completions in the same tab within 30s dedup (desired — same
// session, same destination), different tabs stay independent. Null for a falsy tabId, since an
// untagged notification degrades to today's (broken-on-Electron, fine-on-Web) behavior rather than
// every tab sharing one 'objective-undefined' tag.
export function objectiveTag(tabId) {
  return tabId ? `objective-${tabId}` : null;
}

// (C1058) Most recent failure reported by the Electron main-process transport (e.g.
// Notification.isSupported() === false on this OS) — surfaced in the Settings modal instead of
// failing silently, since that silence is exactly what made "zero notifications ever" invisible
// (see ai/architecture/tt-notifications.md § Permission, preferences, and denial surfacing).
// null once a send succeeds, or before any attempt has been made.
let _lastTransportError = null;

// (C1125/C1141) main.js's notify:status result, folded in once at module load below — a
// distinct, more specific condition than a generic lastError, surfaced separately in
// getNotificationStatus() so the Settings hint can name the actual cause. `signed` is whether
// the bundle was ever code-signed at all (C1125); `valid` is whether that signature's seal is
// still intact right now (C1141 — a signed bundle that later wrote a file inside itself breaks
// its own seal, which macOS treats identically to unsigned: no Notification Center
// registration). Both null until the one-shot notifyStatus() call below resolves.
let _bundleSignature = { signed: null, valid: null, reason: null };

// (C1355) Duplicate-LaunchServices-claimant info, folded in alongside `_bundleSignature` below —
// `conflicts` is a count (null = unknown/not darwin+packaged), `installerVolumes` names any live
// conflict under `/Volumes` (the actionable case: a mounted installer DMG). Purely informational
// — never gates delivery, only enriches the `not-registered` Settings hint with the actual cause.
let _lsConflicts = { conflicts: null, installerVolumes: [] };

// (C1125) A send that the OS silently dropped must not leave attention-notifications.js's
// prompt-signature ledger thinking the user was told — see notify()'s Electron `.then()` below.
// The tag IS the taskId on the attention path, which is the only caller that needs this.
const _failureListeners = new Set();
export function onNotifyFailed(cb) {
  _failureListeners.add(cb);
  return () => _failureListeners.delete(cb);
}

// (C1125) Permanent (not throwaway) stage-by-stage logger for the attention→notification path,
// gated behind a localStorage flag so it costs nothing by default. Replaces the task's own
// suggestion of temporary console.debug statements — those get deleted after one debug session
// and the next regression starts the investigation from zero again; this stays in the tree.
export function debugNotifyLog(...args) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('tipatask-debug-notify') === 'on') {
      console.debug('[notify-debug]', ...args);
    }
  } catch (_) { /* no localStorage (e.g. node --test) */ }
}

function _hasLocalStorage() {
  try { return typeof localStorage !== 'undefined'; } catch (_) { return false; }
}

export function isNotifyEnabled(category) {
  const key = NOTIFY_PREF_KEYS[category];
  if (!key || !_hasLocalStorage()) return true;
  try { return localStorage.getItem(key) !== 'off'; } catch (_) { return true; }
}

export function setNotifyEnabled(category, on) {
  const key = NOTIFY_PREF_KEYS[category];
  if (!key || !_hasLocalStorage()) return;
  try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (_) { /* ignore */ }
}

// (C1057) Electron main-process Notification, wired via preload.js/main.js. Bypasses the
// renderer permission model entirely — no dependence on setPermissionRequestHandler/
// setPermissionCheckHandler behaving as expected, and works for an unpackaged dev run too.
// Returns null outside Electron (or before the preload bridge exists), in which case notify()
// falls back to the Web Notification API below, unchanged from before this task.
function _electronNotify() {
  return (typeof window !== 'undefined' && typeof window.electronAPI?.notify === 'function')
    ? window.electronAPI.notify
    : null;
}

// (C1318) Registration state read from main.js's `notify:status` (`defaults read
// com.apple.ncprefs`) — the direct "is this bundle actually connected to usernoted right
// now" signal, would have caught all three notification regressions regardless of cause.
// true | false | null (unknown — non-Electron, non-darwin, `defaults` itself failed, or
// never checked). A fresh install legitimately has no entry until the FIRST successful send,
// so `false` here is a HINT surfaced in Settings, never something notify()/canDeliver hard-fails
// on by itself — see getNotificationStatus() below, which only escalates it to `canDeliver:
// false` once `signed`/`valid` are otherwise healthy (so it doesn't outrank a real cause).
let _ncRegistered = null;

// (TPT487) Delivery main reported on the last notify:status read: 'native' while "Show on Top"
// is off (transient OS notifications, so bundle health matters again), otherwise desktop.
let _statusDelivery = null;

// (C1058) What the Settings-modal status row reads. (C1155: the nav-hamburger warning
// dot that used to read this too was removed along with the hamburger button itself.)
// `canDeliver` answers "can the OS receive a notification at all right now" — independent of
// whether the user has switched a category off, which is a deliberate choice, not a fault.
export function getNotificationStatus() {
  const electron = Boolean(_electronNotify());
  const hasWebApi = typeof Notification !== 'undefined';
  const transport = electron ? 'electron' : (hasWebApi ? 'web' : 'unsupported');
  const permission = electron ? 'granted' : (hasWebApi ? Notification.permission : 'unsupported');
  // (C1141) valid===false (seal broken by a stray write inside the bundle) is exactly as fatal
  // to delivery as signed===false (never signed at all) — both mean usernoted refuses to
  // register the app with Notification Center. (C1318) `_ncRegistered === false` is the same
  // fatal outcome by direct observation rather than inferred cause — folded in at the same
  // rank, but only once signed/valid aren't already explaining it (see lastError below).
  const native = _desktopDelivery() && _statusDelivery === 'native';
  if (_desktopDelivery() && !native) return { transport: 'electron', delivery: 'desktop', permission: 'granted',
    canDeliver: !_lastTransportError, lastError: _lastTransportError,
    enabled: Object.fromEntries(Object.keys(NOTIFY_PREF_KEYS).map((key) => [key, isNotifyEnabled(key)])),
    conflicts: null, installerVolumes: [] };
  const signatureBroken = _bundleSignature.signed === false || _bundleSignature.valid === false;
  const notRegistered = _ncRegistered === false;
  const canDeliver = electron ? (!_lastTransportError && !signatureBroken && !notRegistered) : permission === 'granted';
  let lastError = _lastTransportError;
  if (_bundleSignature.signed === false) lastError = 'unsigned';
  else if (_bundleSignature.valid === false) lastError = 'seal-broken';
  else if (notRegistered) lastError = 'not-registered';
  return {
    transport,
    ...(native ? { delivery: 'native' } : {}),
    permission,
    canDeliver,
    enabled: { attention: isNotifyEnabled('attention'), objective: isNotifyEnabled('objective'), completed: isNotifyEnabled('completed'), activity: isNotifyEnabled('activity') },
    lastError,
    // (C1355) Enriches the 'not-registered' case with the actual cause — never changes lastError
    // itself, since 'not-registered' is already correctly ranked below unsigned/seal-broken.
    conflicts: _lsConflicts.conflicts,
    installerVolumes: _lsConflicts.installerVolumes,
  };
}

// (C1318) Shared by the module-load fire-and-forget call below and the new
// refreshNotificationStatus() export — folds a raw `notify:status` IPC result into module
// state. Pulled out so a LATER refresh (Test button, Settings reopen) can update the same
// state a stale boot-time snapshot populated, instead of that snapshot being permanent for
// the renderer's whole lifetime.
function _foldSignatureStatus(status) {
  _statusDelivery = (status && status.delivery) || null;
  _bundleSignature = {
    signed: status ? status.signed !== false : null,
    valid: status && status.valid !== undefined ? status.valid !== false : null,
    reason: (status && status.reason) || null,
  };
  _ncRegistered = status && status.registered !== undefined ? status.registered : null;
  // (C1355)
  _lsConflicts = {
    conflicts: status && status.conflicts !== undefined ? status.conflicts : null,
    installerVolumes: (status && status.installerVolumes) || [],
  };
}

// (C1318) Re-queries main.js's `notify:status` (which itself re-verifies the seal + the
// Notification Center registration on a TTL — see main.js's refreshBundleSignatureState) and
// re-folds the result, so a status read AFTER boot (Test button, reopening Settings) reflects
// current reality instead of the one-shot snapshot taken at module load. No-op (resolves
// immediately) outside Electron — the web transport has no bundle-signature concept at all.
export async function refreshNotificationStatus() {
  if (typeof window === 'undefined' || typeof window.electronAPI?.notifyStatus !== 'function') return;
  try {
    _foldSignatureStatus(await window.electronAPI.notifyStatus());
  } catch (_) { /* leave prior state — a failed refresh must not blank out a known-good read */ }
}

// (C1355) Settings-modal "Repair" button (shown only when lastError === 'not-registered' and
// conflicts > 0) — re-registers the running bundle with LaunchServices via main.js's
// notify:repair-registration, then refreshes status so the UI reflects the new state. No-op
// (resolves `{ok:true, relaunchNeeded:false}`) outside Electron — there is nothing to repair on
// the web transport. `relaunchNeeded:true` on success: usernoted only decides Notification
// Center registration at process launch, same as the C1318 seal-repair path.
export async function repairNotificationRegistration() {
  if (typeof window === 'undefined' || typeof window.electronAPI?.notifyRepairRegistration !== 'function') {
    return { ok: true, relaunchNeeded: false };
  }
  try {
    const result = await window.electronAPI.notifyRepairRegistration();
    await refreshNotificationStatus();
    return result;
  } catch (err) {
    return { ok: false, reason: err?.message || 'failed', relaunchNeeded: false };
  }
}

// (C1125/C1141/C1318) Fire-and-forget, same pattern as requestPermission()'s init-time call in
// index.js — checks once whether this bundle is code-signed, whether that signature's seal is
// still valid, and whether the bundle is actually registered with Notification Center, so the
// Settings badge/warning dot can read `blocked`/`unsigned`/`seal-broken`/`not-registered` from
// app start instead of only after a first failed notify() attempt. No-op outside Electron (no
// `notifyStatus` bridge method exists there).
if (typeof window !== 'undefined' && typeof window.electronAPI?.notifyStatus === 'function') {
  Promise.resolve(window.electronAPI.notifyStatus())
    .then(_foldSignatureStatus)
    .catch(() => {});
}

console.debug('[notifications] status:', getNotificationStatus());

// Resolves to the permission that resulted: 'granted' | 'denied' | 'default' | 'unsupported'.
// No-op under Electron (the main-process transport needs no renderer permission at all) and
// only actually prompts when permission is still 'default' — re-requesting after 'denied' is
// impossible per spec, which is exactly what the Settings modal's hint text explains instead.
export async function requestPermission() {
  if (_electronNotify()) return 'granted';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); } catch (_) { return Notification.permission; }
  }
  return Notification.permission;
}

// Returns true when the notification was handed to a transport, false on every early return
// (category disabled / no permission / still inside the 30s per-tag debounce).
export function notify(title, body, tag, options = {}) {
  if (options.category && !isNotifyEnabled(options.category)) return false;
  const send = _electronNotify();
  if (!send && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) return false;
  if (tag) {
    const last = _lastNotifiedAt.get(tag) || 0;
    if (Date.now() - last < DEBOUNCE_MS) return false;
    _lastNotifiedAt.set(tag, Date.now());
  }
  if (send) {
    const notificationId = _desktopDelivery() ? `${_notificationSession}-${++_notifySeq}` : null;
    const handlerKey = notificationId || tag;
    ensureNotificationBridge();
    if (handlerKey && options.onClick) _clickHandlers.set(handlerKey, options.onClick);
    if (handlerKey) _deliveries.set(handlerKey, { tag, projectPath: notificationProjectPath() });
    // (C1125) A send the OS drops must not stay "handed to a transport" forever from the
    // caller's point of view: re-arm the tag's debounce so a retry isn't blocked for 30s, and
    // tell any registered failure listener (attention-notifications.js un-records its
    // prompt-signature ledger entry) so the same prompt can notify again instead of being
    // silenced indefinitely by a send nobody ever saw.
    const onFailed = (reason) => {
      if (handlerKey && !_deliveries.has(handlerKey)) return;
      _lastTransportError = reason || 'failed';
      if (handlerKey) releaseDelivery(handlerKey);
      if (tag) {
        _lastNotifiedAt.delete(tag);
        for (const cb of _failureListeners) { try { cb(tag); } catch (_) {} }
      }
    };
    try {
      // (C1058) Capture the IPC result instead of dropping it — it's how a Notification.
      // isSupported() === false failure on this OS reaches getNotificationStatus().lastError
      // rather than vanishing silently.
      Promise.resolve(send({ title, body, tag, taskId: tag, ...(notificationId ? { notificationId, category: options.category, locale: getLocale() } : {}) }))
        .then((result) => {
          // (C1141) This IPC result was never logged before — the single most useful line
          // missing when diagnosing a banner that never appeared (was it ok:true and macOS
          // dropped it, or did main.js already know why it wouldn't deliver?).
          debugNotifyLog('notify:show resolved', tag, result);
          if (result && result.ok === false) onFailed(result.reason);
          // (TPT480) Desktop banners turned off in the Settings menu: a deliberate no-op, not a
          // transport failure. No banner exists to click, so drop its handler.
          else if (result && result.delivery === 'disabled') { if (handlerKey) releaseDelivery(handlerKey); }
          else _lastTransportError = null;
        })
        .catch(() => onFailed('failed'));
    } catch (_) { onFailed('failed'); }
    return true;
  }
  try {
    // (C1138) Suffixed tag so a second banner for the same task (changed promptText re-notify,
    // debounce already cleared) doesn't silently replace the first on screen — see module note.
    const n = new Notification(title, { body, tag: tag ? `${tag}-${++_notifySeq}` : undefined, requireInteraction: true });
    const key = n;
    _deliveries.set(key, { tag, projectPath: notificationProjectPath(), notification: n });
    if (options.onClick) _clickHandlers.set(key, options.onClick);
    n.onclick = () => _dispatchNotificationClick(_clickHandlers.get(key), true);
    n.onclose = n.onerror = () => {
      releaseDelivery(key);
      n.onclick = n.onclose = n.onerror = null;
    };
  } catch (_) { return false; }
  return true;
}

export function clearDebounce(tag) {
  if (!tag) return;
  _lastNotifiedAt.delete(tag);
  _clickHandlers.delete(tag);
}

// (C1058) Settings-modal "Test" button. Deliberately bypasses notify()'s category gate (a test
// notification must always fire so it can prove the transport works), prompts for permission
// first when it's still 'default', and awaits the real transport result so the button can
// report *why* it failed instead of doing nothing — the exact failure mode this task fixes.
export async function sendTestNotification(title, body) {
  clearDebounce(TEST_TAG);
  const send = _electronNotify();
  if (!send) {
    if (typeof Notification === 'undefined') return { ok: false, reason: 'unsupported' };
    if (Notification.permission === 'default') await requestPermission();
    if (Notification.permission !== 'granted') return { ok: false, reason: Notification.permission };
    try {
      // (C1138) Suffixed same as notify()'s web path — repeated Test-button presses must not
      // replace each other's banner.
      const n = new Notification(title, { body, tag: `${TEST_TAG}-${++_notifySeq}`, requireInteraction: true });
      n.onclick = () => { try { window.focus(); } catch (_) {} };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err?.message || 'failed' };
    }
  }
  // (C1318) A Test press must report CURRENT reality, not whatever the boot-time snapshot
  // said — a seal broken (or repaired) since app launch would otherwise report a stale
  // reason. main.js's own notify:status re-verifies on the same call (TTL'd there too).
  await refreshNotificationStatus();
  try {
    const result = await send({ title, body, tag: TEST_TAG, taskId: TEST_TAG, ...(_desktopDelivery() ? { notificationId: `${_notificationSession}-${++_notifySeq}`, locale: getLocale() } : {}) });
    // (TPT480) Setting off — report it so the Test button explains why nothing appeared.
    if (result && result.delivery === 'disabled') return { ok: false, reason: 'desktop-disabled' };
    _lastTransportError = (result && result.ok === false) ? (result.reason || 'failed') : null;
    return (result && result.ok === false) ? { ok: false, reason: result.reason || 'failed' } : { ok: true };
  } catch (err) {
    _lastTransportError = 'failed';
    return { ok: false, reason: err?.message || 'failed' };
  }
}
