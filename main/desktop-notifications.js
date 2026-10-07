'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Compact page geometry shared by the always-on-top banner and the in-app panel (TPT480,
// TPT484). PAGE_SIZE mirrors DESKTOP_PAGE_SIZE in src/client/desktop-notifications-model.js (an
// ES module CJS main cannot import); the pixel sizes mirror src/client/notification-cards.css.
// Keep all three in sync.
const PAGE_SIZE = 5;
const PAD = 16, HEADER = 24, GAP = 8, CARD = 70, MORE = 24, WIDTH = 336;
// Blur → focus gap while the user switches between two Tipatask windows. The surface waits this
// long before re-deciding, so the banner never flashes up in between.
const SURFACE_SETTLE_MS = 120;
const CATEGORIES = ['attention', 'completed', 'objective', 'activity', 'merge'];
const THEME_KEYS = ['bg', 'text', 'muted', 'border', 'primary', 'warning', 'success', 'shadow'];
// Live native notifications retained until their terminal event (TPT487); FIFO backstop.
const NATIVE_MAX = 200;

// The banner's footer row (the "Show" toggle, plus Show More past one page) is always present
// (TPT505), so its height never depends on the overflow.
function pageHeight(count) {
  const shown = Math.min(Math.max(1, count), PAGE_SIZE);
  return PAD + HEADER + GAP + shown * CARD + (shown - 1) * GAP + GAP + MORE;
}

// Persisted app-level "Show on Top" preference: `{ desktopNotificationsEnabled: boolean }`.
// Missing or unreadable file = on (the pre-TPT480 behavior). Off routes sends to native OS
// notifications (TPT487); it never disables notifications.
function readEnabled(file) {
  if (!file) return true;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).desktopNotificationsEnabled !== false; }
  catch { return true; }
}

function writeEnabled(file, enabled) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ desktopNotificationsEnabled: enabled }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Card colors forwarded from the in-app host so the banner matches the project palette.
// Only plain color values pass; anything else falls back to the banner's own defaults.
function sanitizeTheme(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const out = {};
  for (const key of THEME_KEYS) {
    const value = typeof tokens[key] === 'string' ? tokens[key].trim() : '';
    if (value && value.length <= 64 && /^[#\w\s(),.%-]+$/.test(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

const keyOf = (projectPath, tag) => (tag ? JSON.stringify([projectPath || null, String(tag)]) : null);

// One alert registry for both surfaces (TPT484). An alert is identified by (project, tag); a
// repeat send updates it in place. Entries survive navigation, reloads and elapsed time;
// completion explicitly removes that task's entries within its originating project.
function createDesktopNotifications({ BrowserWindow, screen, ipcMain, onClick, onDismiss, Notification = null,
  onShowMore = () => null, onSetOnTop = () => null, isTrustedProjectSender = () => false, settingsFile = null,
  focusedProjectWindow = () => null, projectWindows = () => [], settleMs = SURFACE_SETTLE_MS,
  platform = process.platform }) {
  const entries = new Map();
  const keys = new Map();
  let sequence = 0;
  let window = null;
  let loading = null;
  let disposed = false;
  let displayId = null;
  let enabled = readEnabled(settingsFile);
  let theme = null;
  // Project window showing the in-app panel (focused Tipatask project window), else null.
  let host = null;
  let settleTimer = null;
  // Last surface state sent per project webContents, so idle windows aren't re-sent each change.
  const sentState = new Map();
  // Project window that owns the full list ("Show More"): { win, wc, opened, detach }.
  // `opened` turns true once notify:desktop-list-open was actually sent to a loaded page.
  let panel = null;
  // A banner Show More whose target is still being resolved (async onShowMore).
  let showMorePending = false;
  // (TPT505) Banner dismissed with Hide: stays hidden, entries kept, until a new or changed
  // alert arrives (upsert) or Show on Top is toggled. The in-app panel is unaffected.
  let bannerHidden = false;
  // (TPT487) "Show on Top" off: one transient OS notification per alert, keyed like entries.
  // Referenced until click/close/failed so V8 can't collect one before the OS shows it.
  const natives = new Map();

  const snapshot = () => [...entries.values()].reverse()
    .map(({ origin, key, ...entry }) => ({ ...entry, projectPath: origin?.projectPath || null }));
  const trusted = (event) => window && !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const panelLive = () => panel && !panel.win.isDestroyed() && !panel.wc.isDestroyed();
  const live = (w) => !!w && !w.isDestroyed() && !w.webContents.isDestroyed();
  const hostLive = () => live(host) ? host : (host = null);

  function layout() {
    if (!window || window.isDestroyed()) return;
    const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(WIDTH, area.width);
    const height = Math.min(pageHeight(entries.size), Math.floor(area.height * 0.75));
    window.setBounds({ x: area.x + area.width - width, y: area.y + area.height - height, width, height });
  }

  // Live updates for the open list. Never precedes the open itself.
  function sendList() {
    if (panelLive() && panel.opened) panel.wc.send('notify:desktop-list', snapshot());
  }

  // Sends the owner its list. A page that is still loading has no listener yet and would lose
  // the message, so that case waits for the owner's did-finish-load (attachPanel()), which
  // passes `loaded` — isLoadingMainFrame() still reports true inside that event.
  function openList({ loaded = false } = {}) {
    if (!panelLive() || (!loaded && panel.wc.isLoadingMainFrame?.())) return;
    panel.opened = true;
    panel.wc.send('notify:desktop-list-open', snapshot());
  }

  // Exactly one surface holds the alerts: the in-app panel of the focused project window, or
  // the always-on-top banner while another app is focused. Never focuses or raises anything.
  function renderSurface() {
    const list = snapshot();
    const current = hostLive();
    for (const w of projectWindows()) {
      if (!live(w)) continue;
      const active = enabled && w === current;
      const state = `${enabled}:${active}`;
      if (!active && sentState.get(w.webContents.id) === state) continue;
      sentState.set(w.webContents.id, state);
      w.webContents.send('notify:surface', { shared: enabled, active, entries: active ? list : [] });
    }
    if (!window || window.isDestroyed() || loading) return;
    layout();
    window.webContents.send('notify:desktop-state', { entries: list, theme });
    if (list.length && enabled && !current && !bannerHidden) window.showInactive();
    else window.hide();
  }

  function publish() {
    sendList();
    renderSurface();
  }

  // Re-decides the host after app focus changes. Waits out the blur → focus gap of a window
  // switch; `immediate` is for callers that know focus already settled (window closed, load).
  function syncNotificationSurface({ immediate = false } = {}) {
    if (disposed) return;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    const apply = () => {
      settleTimer = null;
      if (disposed) return;
      const next = focusedProjectWindow();
      host = next !== window && live(next) ? next : null;
      publish();
    };
    if (immediate) apply();
    else settleTimer = setTimeout(apply, settleMs);
  }

  // Read-back for a (re)loaded project renderer. Settles focus first unless a switch is pending.
  function surfaceFor(w) {
    if (!settleTimer && !disposed) {
      const next = focusedProjectWindow();
      host = next !== window && live(next) ? next : null;
    }
    const active = enabled && !!w && w === hostLive();
    return { shared: enabled, active, entries: active ? snapshot() : [] };
  }

  function entryFields(payload) {
    return { tag: payload.tag, taskId: payload.taskId,
      title: String(payload.title || 'TipATask').slice(0, 500),
      body: String(payload.body || '').slice(0, 4000),
      category: CATEGORIES.includes(payload.category) ? payload.category : null,
      locale: payload.locale === 'uk' ? 'uk' : 'en' };
  }

  // Closes one native and releases its callback identity; the renderer keeps its in-app card.
  function closeNative(slot) {
    const record = natives.get(slot);
    if (!record) return null;
    natives.delete(slot);
    try { record.notification.close(); } catch {}
    onDismiss(record.entry, { keepCard: true });
    return record.entry;
  }

  function closeNatives(match = () => true) {
    let closed = 0;
    for (const [slot, record] of [...natives]) if (match(record.entry) && closeNative(slot)) closed += 1;
    return closed;
  }

  // Placement and duration follow the OS settings. A repeat send for the same (project, tag)
  // replaces the previous native, so one alert never shows twice.
  function showNative(payload, origin) {
    if (!Notification || (typeof Notification.isSupported === 'function' && !Notification.isSupported())) {
      return { ok: false, reason: 'unsupported' };
    }
    const id = String(++sequence);
    const key = keyOf(origin?.projectPath, payload.tag);
    const slot = key || `#${id}`;
    const entry = { ...entryFields(payload), id, key, origin, cardSeq: null, notificationId: payload.notificationId || null };
    closeNative(slot);
    let notification;
    try { notification = new Notification({ title: entry.title, body: entry.body, silent: false }); }
    catch { return { ok: false, reason: 'failed' }; }
    const record = { notification, entry };
    const settle = () => natives.get(slot) === record && natives.delete(slot);
    notification.on('click', () => { if (settle()) onClick(entry); });
    const gone = () => { if (settle()) onDismiss(entry, { keepCard: true }); };
    notification.on('close', gone);
    notification.on('failed', gone);
    natives.set(slot, record);
    while (natives.size > NATIVE_MAX) closeNative(natives.keys().next().value);
    try { notification.show(); }
    catch { settle(); return { ok: false, reason: 'failed' }; }
    return { ok: true, id, delivery: 'native' };
  }

  function remove(entry) {
    entries.delete(entry.id);
    if (entry.key && keys.get(entry.key) === entry.id) keys.delete(entry.key);
  }

  // Upsert by (project, tag): same id, moved to newest. Returns { entry, created, released }.
  // `reveal` (the default for real sends) clears bannerHidden; a mirrored card clears it only when
  // it is new or its text changed, so a renderer re-mirror never brings a hidden banner back.
  function upsert(payload, origin, notificationId, { reveal = true } = {}) {
    const key = keyOf(origin?.projectPath, payload.tag);
    const prev = key && keys.has(key) ? entries.get(keys.get(key)) : null;
    const id = prev ? prev.id : String(++sequence);
    if (prev) entries.delete(id);
    const cardSeq = Number.isFinite(payload.cardSeq) ? payload.cardSeq : (prev?.cardSeq ?? null);
    const entry = { ...entryFields(payload), id, key, origin, cardSeq,
      notificationId: notificationId || prev?.notificationId || null, taskId: payload.taskId ?? prev?.taskId };
    if (reveal || !prev || ['title', 'body', 'category'].some((field) => prev[field] !== entry[field])) bannerHidden = false;
    entries.set(id, entry);
    if (key) keys.set(key, id);
    // A newer send replaces the callback identity; release the older one (card stays).
    const released = prev?.notificationId && notificationId && prev.notificationId !== notificationId
      ? { ...prev } : null;
    return { entry, created: !prev, released };
  }

  function detachPanel() {
    if (!panel) return;
    const { detach } = panel;
    panel = null;
    detach();
  }

  function attachPanel(win) {
    if (disposed || !live(win)) return;
    if (panel && panel.win !== win) {
      if (panelLive()) panel.wc.send('notify:desktop-list-close');
      detachPanel();
    }
    if (!panel) {
      const wc = win.webContents;
      const owner = { win, wc, opened: false, detach: null };
      const onGone = () => { if (panel === owner) { detachPanel(); publish(); } };
      // A renderer reload drops the panel DOM; stop treating that window as its owner. The
      // first navigation of a window that is still loading is not a reload: ownership stays.
      const onNavigate = () => { if (owner.opened) onGone(); };
      const onLoaded = () => { if (panel === owner && !owner.opened) openList({ loaded: true }); };
      // -3 (ERR_ABORTED): this load was replaced by another one, which reports on its own.
      const onFailed = (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3 && !owner.opened) onGone();
      };
      win.on('closed', onGone);
      wc.on('did-navigate', onNavigate);
      wc.on('did-finish-load', onLoaded);
      wc.on('did-fail-load', onFailed);
      owner.detach = () => {
        win.removeListener('closed', onGone);
        if (wc.isDestroyed()) return;
        wc.removeListener('did-navigate', onNavigate);
        wc.removeListener('did-finish-load', onLoaded);
        wc.removeListener('did-fail-load', onFailed);
      };
      panel = owner;
    }
    openList();
    publish();
  }

  function dismissAll({ keepCard = false } = {}) {
    const removed = [...entries.values()];
    entries.clear();
    keys.clear();
    publish();
    for (const entry of removed) onDismiss(entry, { keepCard });
  }

  // (TPT505) Banner Hide: the banner steps aside without touching the registry or any project
  // window — no onClick/onShowMore, no focus()/show(). The banner is a non-activating panel
  // (ensureWindow()), so the click itself never brings Tipatask forward either.
  function hideBanner() {
    if (!entries.size) return;
    bannerHidden = true;
    if (window && !window.isDestroyed()) window.hide();
  }

  function perform(id, action, { from = null } = {}) {
    if (action === 'clear-all') return dismissAll();
    if (action === 'hide') return hideBanner();
    if (action === 'on-top-off') return void onSetOnTop(false);
    if (action === 'show-more') {
      // From the in-app panel: open the full list right there, without moving focus.
      if (from) return attachPanel(from);
      const newest = [...entries.values()].at(-1);
      if (!newest || showMorePending) return;
      // onShowMore picks, raises and returns the window for the list. It may answer later (a
      // verified raise, a reopened project window); no window means nothing changes here.
      const target = onShowMore(newest);
      if (typeof target?.then !== 'function') return attachPanel(target);
      showMorePending = true;
      target.then(attachPanel).catch(() => {}).finally(() => { showMorePending = false; });
      return;
    }
    const entry = entries.get(id);
    if (!entry) return;
    remove(entry);
    publish();
    // Remove first: opening a task may itself produce another alert.
    if (action === 'click') onClick(entry);
    else onDismiss(entry, { keepCard: false });
  }

  async function ensureWindow(origin) {
    if (disposed) throw new Error('closed');
    if (loading) return loading;
    if (window && !window.isDestroyed()) return;
    const source = origin?.windowId != null ? BrowserWindow.fromId(origin.windowId) : null;
    displayId = source && !source.isDestroyed() ? screen.getDisplayMatching(source.getBounds()).id : screen.getPrimaryDisplay().id;
    const w = window = new BrowserWindow({
      // hasShadow: false — macOS traces a window shadow around a transparent window's opaque
      // pixels, drawing a jagged second outline around every card (TPT498); cards carry their own.
      // (TPT505) Clicking the banner must not activate Tipatask: on macOS an activated app makes
      // its next window key once the banner hides, raising a project window. A 'panel' is a
      // non-activating NSPanel; Windows gets the same from focusable: false (WS_EX_NOACTIVATE).
      ...(platform === 'darwin' ? { type: 'panel' } : platform === 'win32' ? { focusable: false } : {}),
      width: WIDTH, height: pageHeight(1), show: false, frame: false, transparent: true, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, title: 'TipATask',
      webPreferences: { preload: path.join(__dirname, 'desktop-notifications-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    w.setMenu(null);
    w.setAlwaysOnTop(true, 'floating');
    // macOS: without skipTransformProcessType, visibleOnFullScreen turns the whole app into a
    // UIElement — Dock icon, menu bar and Cmd+Tab entry vanish and are never restored.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (event) => event.preventDefault());
    w.webContents.on('did-finish-load', publish);
    w.on('close', (event) => { if (!disposed) event.preventDefault(); });
    w.on('closed', () => { if (window === w) { window = null; loading = null; } });
    loading = w.loadFile(path.join(__dirname, 'desktop-notifications.html'));
    try { await loading; } catch (error) { w.destroy(); throw error; }
    finally { loading = null; }
  }

  function releaseAfterPublish(released) {
    if (released) onDismiss(released, { keepCard: true });
  }

  // The banner offers Hide and the "Show" toggle instead of Clear All (TPT505); the in-app
  // panel keeps Clear All.
  const BANNER_ACTIONS = ['click', 'close', 'hide', 'show-more', 'on-top-off'];
  const ACTIONS = ['click', 'close', 'clear-all', 'show-more'];
  ipcMain.on('notify:desktop-action', (event, { id, action } = {}) => {
    if (!trusted(event) || !BANNER_ACTIONS.includes(action)) return;
    perform(id, action);
  });
  // The project window showing the full list. Only its current owner may act on it; card
  // clicks share the banner path, so another project's card focuses that project's window.
  ipcMain.on('notify:desktop-list-action', (event, { id, action } = {}) => {
    if (!panelLive() || event.sender !== panel.wc || !isTrustedProjectSender(event)) return;
    if (action === 'panel-closed') { detachPanel(); publish(); return; }
    if (['click', 'close', 'clear-all'].includes(action)) perform(id, action);
  });
  // The in-app panel. Only the current host acts; clicks share the banner routing.
  ipcMain.on('notify:surface-action', (event, { id, action } = {}) => {
    const current = hostLive();
    if (!current || event.sender !== current.webContents || !isTrustedProjectSender(event)) return;
    if (!ACTIONS.includes(action)) return;
    perform(id, action, { from: action === 'show-more' ? current : null });
  });
  ipcMain.on('notify:theme', (event, tokens) => {
    const current = hostLive();
    if (!current || event.sender !== current.webContents || !isTrustedProjectSender(event)) return;
    const next = sanitizeTheme(tokens);
    if (JSON.stringify(next) === JSON.stringify(theme)) return;
    theme = next;
    renderSurface();
  });
  screen.on('display-metrics-changed', layout);
  screen.on('display-removed', layout);

  return {
    dismissTask(taskId, projectPath) {
      if (typeof taskId !== 'string' || !taskId.trim() || !projectPath) return 0;
      const tags = new Set([taskId, `activity-${taskId}`, `completed-${taskId}`]);
      // keepCard: the renderer clears its own cards first and may already hold a fresh one.
      const closed = closeNatives((entry) => entry.origin.projectPath === projectPath && tags.has(entry.tag));
      const removed = [];
      for (const entry of [...entries.values()]) {
        if (entry.origin.projectPath !== projectPath || !tags.has(entry.tag)) continue;
        remove(entry);
        removed.push(entry);
      }
      if (removed.length) publish();
      for (const entry of removed) onDismiss(entry, { keepCard: false });
      return removed.length + closed;
    },
    // Programmatic removal of one alert (resolved prompt, opened objective, ...) from the
    // sender's own project. Releases the callback identity; never runs a click action.
    dismissKey(tag, projectPath) {
      const key = keyOf(projectPath, tag);
      const closed = key && closeNative(key) ? 1 : 0;
      const entry = key && keys.has(key) ? entries.get(keys.get(key)) : null;
      if (!entry) return closed;
      remove(entry);
      publish();
      onDismiss(entry, { keepCard: false });
      return 1;
    },
    // In-app card mirrored from a project renderer's pushNotification(). Same identity as the
    // banner send for that tag; no callback identity of its own (the renderer keeps onClick).
    upsertCard(payload, origin) {
      if (disposed || !enabled) return { ok: true, delivery: 'disabled' };
      if (!payload?.tag) return { ok: false, reason: 'invalid_tag' };
      const { entry, released } = upsert({ ...payload, cardSeq: Number(payload.seq) }, origin, null, { reveal: false });
      publish();
      releaseAfterPublish(released);
      // The banner window is only needed once another app takes focus; create it lazily.
      ensureWindow(origin).then(publish, () => {});
      return { ok: true, id: entry.id, delivery: 'shared' };
    },
    async show(payload, origin) {
      // "Show on Top" off: no shared registry and no banner window — a transient OS
      // notification instead. Renderers keep their own in-app cards (notify:surface { shared:false }).
      if (!enabled) return disposed ? { ok: false, reason: 'closed' } : showNative(payload, origin);
      const { entry, created, released } = upsert(payload, origin, payload.notificationId);
      publish();
      releaseAfterPublish(released);
      try { await ensureWindow(origin); publish(); return { ok: true, id: entry.id, delivery: 'desktop' }; }
      catch (error) {
        if (created && entries.get(entry.id) === entry) { remove(entry); publish(); }
        return { ok: false, reason: 'desktop-unavailable' };
      }
    },
    syncNotificationSurface,
    surfaceFor,
    snapshot,
    owns: (w) => w === window,
    isEnabled: () => enabled,
    // Applies immediately and persists for the next launch. Off clears the shared registry and
    // hides the banner but keeps every in-app card (renderers fall back to their local list);
    // later sends go native. On closes open natives and re-shares the cards.
    // A failed write keeps the in-memory choice and reports ok:false.
    setEnabled(on) {
      enabled = !!on;
      bannerHidden = false;
      sentState.clear();
      if (!enabled) dismissAll({ keepCard: true });
      else { closeNatives(); publish(); }
      try { writeEnabled(settingsFile, enabled); return { ok: true, enabled }; }
      catch (error) { return { ok: false, enabled, reason: error.message }; }
    },
    dispose() {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      const open = [...natives.values()];
      natives.clear();
      for (const { notification } of open) { try { notification.close(); } catch {} }
      entries.clear();
      keys.clear();
      detachPanel();
      screen.removeListener('display-metrics-changed', layout);
      screen.removeListener('display-removed', layout);
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}

module.exports = { createDesktopNotifications, PAGE_SIZE, pageHeight, SURFACE_SETTLE_MS };
