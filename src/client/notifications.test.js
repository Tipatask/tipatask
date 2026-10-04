import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock Notification API before module import so the module-level console.debug
// resolves the mock's static permission getter.
let mockPermission = 'default';
let constructorCount = 0;
let requestPermissionCount = 0;
let lastConstructorArgs = null;
let lastClickHandler = null;
let closeCount = 0;

globalThis.Notification = class MockNotification {
  constructor(title, options) {
    constructorCount++;
    lastConstructorArgs = { title, options };
  }
  close() { closeCount++; }
  set onclick(handler) { lastClickHandler = handler; }
  static get permission() { return mockPermission; }
  static requestPermission() {
    requestPermissionCount++;
    return Promise.resolve('granted');
  }
};

const {
  requestPermission, notify, clearDebounce, objectiveTag,
  getNotificationStatus, isNotifyEnabled, setNotifyEnabled, sendTestNotification,
  onNotifyFailed, refreshNotificationStatus,
} = await import('./notifications.js');

function makeLocalStorageMock() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

beforeEach(() => {
  constructorCount = 0;
  requestPermissionCount = 0;
  lastConstructorArgs = null;
  lastClickHandler = null;
  closeCount = 0;
  mockPermission = 'default';
  clearDebounce('tagX');
  clearDebounce('tagY');
});

// (a) requestPermission calls Notification.requestPermission only when permission==='default'
test('requestPermission calls requestPermission when default', () => {
  mockPermission = 'default';
  requestPermission();
  assert.equal(requestPermissionCount, 1);
});

test('requestPermission does not call requestPermission when granted', () => {
  mockPermission = 'granted';
  requestPermission();
  assert.equal(requestPermissionCount, 0);
});

// (b) notify returns early when permission !== 'granted'
test('notify does not construct when permission is denied', () => {
  mockPermission = 'denied';
  notify('title', 'body', 'tagX');
  assert.equal(constructorCount, 0);
});

test('notify constructs when permission is granted', () => {
  mockPermission = 'granted';
  notify('title', 'body', 'tagX');
  assert.equal(constructorCount, 1);
  // (C1138) The Web Notification's own `tag` is suffixed to a per-call-unique value so a later
  // banner for the same task doesn't silently replace this one on screen — see the dedicated
  // uniqueness test below. `body`/`requireInteraction` are untouched, and the suffix still
  // starts with the real tag so it stays recognizable.
  assert.equal(lastConstructorArgs.title, 'title');
  assert.equal(lastConstructorArgs.options.body, 'body');
  assert.equal(lastConstructorArgs.options.requireInteraction, true);
  assert.match(lastConstructorArgs.options.tag, /^tagX-\d+$/);
});

// (C1138) The actual regression this fix targets: a changed prompt on the same task clears the
// debounce and re-notifies with the same taskId/tag. Pre-fix, the Web Notification API's spec
// replace-by-tag behavior meant the second banner silently replaced the first on screen instead
// of both being visible — this asserts the two calls now reach the browser with distinct tags.
test('notify() web path: two banners for the same tag get distinct underlying tags, so neither replaces the other', () => {
  mockPermission = 'granted';
  notify('title', 'first prompt', 'tagRepeat');
  const firstTag = lastConstructorArgs.options.tag;
  clearDebounce('tagRepeat'); // simulates attention-ws.js's changed-promptText re-arm
  notify('title', 'second prompt', 'tagRepeat');
  const secondTag = lastConstructorArgs.options.tag;
  assert.notEqual(firstTag, secondTag);
  assert.match(firstTag, /^tagRepeat-\d+$/);
  assert.match(secondTag, /^tagRepeat-\d+$/);
  // clearDebounce/notify() itself still dedupe/route by the REAL tag, unaffected by the suffix.
  clearDebounce('tagRepeat');
});

test('notify click handler calls onClick without explicit close', () => {
  mockPermission = 'granted';
  let onClickCount = 0;
  notify('title', 'body', 'tagY', { onClick: () => { onClickCount++; } });
  assert.equal(typeof lastClickHandler, 'function');
  lastClickHandler();
  assert.equal(onClickCount, 1);
  assert.equal(closeCount, 0);
});

// (c) debounce suppresses same tag within 30s
test('debounce suppresses second notify for same tag within 30s', () => {
  mockPermission = 'granted';
  notify('title', 'body', 'tagX');
  notify('title', 'body', 'tagX');
  assert.equal(constructorCount, 1);
});

// (C1073) objectiveTag(tabId) — Electron click bridge is tag-keyed, so an objective completion
// notification needs a stable, unique, truthy tag derived from its tab.
test('objectiveTag builds a stable per-tab tag, and degrades to null for a falsy tabId', () => {
  assert.equal(objectiveTag('obj-1'), 'objective-obj-1');
  assert.equal(objectiveTag('obj-1'), objectiveTag('obj-1'));
  assert.equal(objectiveTag(undefined), null);
  assert.equal(objectiveTag(''), null);
  assert.equal(objectiveTag(null), null);
});

// (d) clearDebounce re-arms the next notify call
test('clearDebounce re-arms notify for the tag', () => {
  mockPermission = 'granted';
  notify('title', 'body', 'tagX');
  clearDebounce('tagX');
  notify('title', 'body', 'tagX');
  assert.equal(constructorCount, 2);
});

// ── Electron main-process transport (C1057) ──
// window is undefined in this plain node:test environment unless a test sets it. The
// onNotificationClick *subscription* inside notify() is a one-time module-level bridge
// (mirrors the real IPC listener lifecycle — one bridge per app, not one per notify() call),
// so every assertion about it has to share the single window/electronAPI mock installed
// before the first Electron-path notify() call in this file. Kept as one consolidated test
// rather than several independent ones for exactly that reason — including the (C1069)
// projectPath-guard assertions below, since a second test file-local electronAPI swap would
// never re-subscribe the bridge.
test('Electron transport: routes through window.electronAPI.notify, bypasses Notification, keeps its debounce, and bridges clicks by tag', () => {
  mockPermission = 'denied'; // must not matter for this transport at all
  const sent = [];
  let clickHandler = null;
  let currentProjectPath = '/proj/A';
  globalThis.window = {
    electronAPI: {
      notify: (p) => sent.push(p),
      onNotificationClick: (cb) => { clickHandler = cb; },
      getProjectPath: () => currentProjectPath,
    },
  };
  try {
    // requestPermission() needs no renderer permission at all through this transport.
    requestPermission();
    assert.equal(requestPermissionCount, 0);

    let onClickCount = 0;
    notify('title', 'body', 'tagElectron', { onClick: () => { onClickCount++; } });
    assert.equal(constructorCount, 0); // never constructs a Web Notification
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { title: 'title', body: 'body', tag: 'tagElectron', taskId: 'tagElectron' });

    // 30s per-tag debounce still applies on this transport.
    notify('title', 'body', 'tagElectron', { onClick: () => { onClickCount++; } });
    assert.equal(sent.length, 1);

    // Click bridge: fires the onClick registered for the matching tag, not for another tag.
    assert.equal(typeof clickHandler, 'function');
    clickHandler({ tag: 'tagElectron' });
    assert.equal(onClickCount, 1);
    clickHandler({ tag: 'someOtherTag' });
    assert.equal(onClickCount, 1);

    // (C1069) projectPath guard — main.js sends the ORIGINATING project's path; a renderer
    // whose current project disagrees must not run the click handler (stale window handle
    // after project:open target:'current' reloaded it into a different project).
    clickHandler({ tag: 'tagElectron', projectPath: '/proj/A' }); // matches → fires
    assert.equal(onClickCount, 2);
    clickHandler({ tag: 'tagElectron', projectPath: '/proj/B' }); // mismatch → ignored
    assert.equal(onClickCount, 2);
    clickHandler({ tag: 'tagElectron' }); // no projectPath at all → back-compat, fires
    assert.equal(onClickCount, 3);
    currentProjectPath = null; // adopted setup window: project in main, none in this renderer yet
    clickHandler({ tag: 'tagElectron', projectPath: '/proj/A' }); // null-vs-set is not a mismatch
    assert.equal(onClickCount, 4);

    // (C1073) An objectiveTag()-derived tag is a normal truthy tag — same registration/lookup
    // path as any other, unlike the old `undefined` tag that never registered a click handler.
    currentProjectPath = '/proj/A';
    let objectiveClickCount = 0;
    const oTag = objectiveTag('obj-1');
    notify('Objective complete', '1 task suggestion(s) ready', oTag, { onClick: () => { objectiveClickCount++; } });
    assert.equal(sent[sent.length - 1].tag, 'objective-obj-1');
    clickHandler({ tag: oTag, projectPath: '/proj/A' });
    assert.equal(objectiveClickCount, 1);
  } finally {
    delete globalThis.window;
    clearDebounce('tagElectron');
    clearDebounce(objectiveTag('obj-1'));
  }
});

test('Without window.electronAPI, notify() falls back to the Web Notification path unchanged', () => {
  mockPermission = 'granted';
  notify('title', 'body', 'tagFallback');
  assert.equal(constructorCount, 1);
  clearDebounce('tagFallback');
});

// ── getNotificationStatus() (C1058) ──

test('getNotificationStatus reports web+granted as deliverable', () => {
  mockPermission = 'granted';
  const status = getNotificationStatus();
  assert.equal(status.transport, 'web');
  assert.equal(status.permission, 'granted');
  assert.equal(status.canDeliver, true);
});

test('getNotificationStatus reports web+denied and web+default as not deliverable', () => {
  mockPermission = 'denied';
  assert.equal(getNotificationStatus().canDeliver, false);
  mockPermission = 'default';
  assert.equal(getNotificationStatus().canDeliver, false);
});

test('getNotificationStatus reports unsupported when Notification is absent', () => {
  const saved = globalThis.Notification;
  delete globalThis.Notification;
  try {
    const status = getNotificationStatus();
    assert.equal(status.transport, 'unsupported');
    assert.equal(status.permission, 'unsupported');
    assert.equal(status.canDeliver, false);
  } finally {
    globalThis.Notification = saved;
  }
});

test('getNotificationStatus reports the electron transport as granted with no lastError', () => {
  globalThis.window = { electronAPI: { notify: () => Promise.resolve({ ok: true }), onNotificationClick: () => {} } };
  try {
    const status = getNotificationStatus();
    assert.equal(status.transport, 'electron');
    assert.equal(status.permission, 'granted');
    assert.equal(status.canDeliver, true);
  } finally {
    delete globalThis.window;
  }
});

// ── C1318: refreshNotificationStatus() / registered signal ──
// (C1318) config.js's DATA_ROOT bug is what actually broke banners this time, but the client-
// visible half of the fix is here: the module-load notifyStatus() call is fire-and-forget and
// permanent for the renderer's whole lifetime, so a status change AFTER boot (seal breaks,
// gets repaired, or the registration probe flips) never reached the Settings badge/Test button
// until now.

test('(C1318) refreshNotificationStatus() re-folds a CHANGED status after module load — a stale boot-time snapshot must not persist for the renderer lifetime', async () => {
  let liveStatus = { signed: true, valid: true, reason: null, registered: true };
  globalThis.window = {
    electronAPI: {
      notify: () => Promise.resolve({ ok: true }),
      onNotificationClick: () => {},
      notifyStatus: () => Promise.resolve(liveStatus),
    },
  };
  try {
    await refreshNotificationStatus();
    assert.equal(getNotificationStatus().canDeliver, true);
    // Seal breaks mid-session — main.js's own TTL'd re-verify would eventually catch this too,
    // but the client must reflect it as soon as it asks, not just at the next app launch.
    liveStatus = { signed: true, valid: false, reason: 'file added', registered: true };
    await refreshNotificationStatus();
    const after = getNotificationStatus();
    assert.equal(after.canDeliver, false);
    assert.equal(after.lastError, 'seal-broken');
  } finally {
    delete globalThis.window;
  }
});

test('(C1318) registered:false folds into canDeliver:false / lastError:"not-registered" when signed+valid are otherwise healthy', async () => {
  globalThis.window = { electronAPI: { notifyStatus: () => Promise.resolve({ signed: true, valid: true, reason: null, registered: false }) } };
  try {
    await refreshNotificationStatus();
    const status = getNotificationStatus();
    assert.equal(status.canDeliver, false);
    assert.equal(status.lastError, 'not-registered');
  } finally {
    delete globalThis.window;
  }
});

test('(C1318) "not-registered" never outranks a real signed/valid failure — unsigned and seal-broken still take priority in lastError', async () => {
  globalThis.window = { electronAPI: { notifyStatus: () => Promise.resolve({ signed: false, valid: false, reason: 'x', registered: false }) } };
  try {
    await refreshNotificationStatus();
    assert.equal(getNotificationStatus().lastError, 'unsigned');
  } finally {
    delete globalThis.window;
  }

  globalThis.window = { electronAPI: { notifyStatus: () => Promise.resolve({ signed: true, valid: false, reason: 'x', registered: false }) } };
  try {
    await refreshNotificationStatus();
    assert.equal(getNotificationStatus().lastError, 'seal-broken');
  } finally {
    delete globalThis.window;
  }
});

test('(C1318) refreshNotificationStatus() is a no-op outside Electron (no notifyStatus bridge) — resolves without throwing', async () => {
  await assert.doesNotReject(refreshNotificationStatus());
});

test('(C1318) refreshNotificationStatus() leaves prior state intact when the IPC call itself rejects — a failed refresh must not blank out a known-good read', async () => {
  globalThis.window = { electronAPI: { notifyStatus: () => Promise.resolve({ signed: true, valid: false, reason: 'x', registered: null }) } };
  try {
    await refreshNotificationStatus();
    assert.equal(getNotificationStatus().lastError, 'seal-broken');
  } finally { delete globalThis.window; }

  globalThis.window = { electronAPI: { notifyStatus: () => Promise.reject(new Error('ipc down')) } };
  try {
    await refreshNotificationStatus(); // must not throw
    assert.equal(getNotificationStatus().lastError, 'seal-broken'); // unchanged from before
  } finally { delete globalThis.window; }
});

test('(C1318) sendTestNotification() refreshes status before sending, so a Test press reports CURRENT reality rather than the boot-time snapshot', async () => {
  let notifyStatusCalls = 0;
  // Boot-time snapshot said broken; reality healed before the user pressed Test.
  let liveStatus = { signed: true, valid: true, reason: null, registered: true };
  globalThis.window = {
    electronAPI: {
      notify: () => Promise.resolve({ ok: true }),
      onNotificationClick: () => {},
      notifyStatus: () => { notifyStatusCalls++; return Promise.resolve(liveStatus); },
    },
  };
  try {
    const res = await sendTestNotification('t', 'b');
    assert.equal(notifyStatusCalls, 1);
    assert.deepEqual(res, { ok: true });
    assert.equal(getNotificationStatus().canDeliver, true);
  } finally {
    delete globalThis.window;
  }
});

// ── Per-category preferences (C1058) ──

test('isNotifyEnabled defaults to true with no localStorage available (Node test env)', () => {
  assert.equal(isNotifyEnabled('attention'), true);
  assert.equal(isNotifyEnabled('objective'), true);
  assert.equal(isNotifyEnabled('not-a-real-category'), true);
});

test('setNotifyEnabled/isNotifyEnabled round-trip, and each category gates notify() independently', () => {
  mockPermission = 'granted';
  globalThis.localStorage = makeLocalStorageMock();
  try {
    setNotifyEnabled('attention', false);
    assert.equal(isNotifyEnabled('attention'), false);
    assert.equal(isNotifyEnabled('objective'), true);

    // Disabled category: notify() returns false and must NOT consume the tag's debounce slot —
    // the gate check runs before the debounce check.
    assert.equal(notify('t', 'b', 'tagPref', { category: 'attention' }), false);
    assert.equal(constructorCount, 0);

    // A different category on the very same tag still fires, proving the debounce slot was
    // never touched by the disabled attempt above.
    assert.equal(notify('t', 'b', 'tagPref', { category: 'objective' }), true);
    assert.equal(constructorCount, 1);

    setNotifyEnabled('attention', true);
    assert.equal(isNotifyEnabled('attention'), true);

    const status = getNotificationStatus();
    assert.deepEqual(status.enabled, { attention: true, objective: true, completed: true, activity: true });
  } finally {
    delete globalThis.localStorage;
    clearDebounce('tagPref');
  }
});

test('notify() return value: true when sent, false when suppressed by the debounce', () => {
  mockPermission = 'granted';
  assert.equal(notify('t', 'b', 'tagRet'), true);
  assert.equal(notify('t', 'b', 'tagRet'), false);
  clearDebounce('tagRet');
});

// ── sendTestNotification() (C1058) ──

test('sendTestNotification surfaces an Electron transport failure instead of failing silently', async () => {
  globalThis.window = {
    electronAPI: {
      notify: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      onNotificationClick: () => {},
    },
  };
  try {
    const res = await sendTestNotification('Test title', 'Test body');
    assert.deepEqual(res, { ok: false, reason: 'unsupported' });
    assert.equal(getNotificationStatus().lastError, 'unsupported');
  } finally {
    delete globalThis.window;
  }
});

test('sendTestNotification succeeds on the Web Notification path when permission is granted', async () => {
  mockPermission = 'granted';
  const res = await sendTestNotification('Test title', 'Test body');
  assert.deepEqual(res, { ok: true });
  assert.equal(constructorCount, 1);
});

test('sendTestNotification reports a denied permission instead of silently no-op', async () => {
  mockPermission = 'denied';
  const res = await sendTestNotification('Test title', 'Test body');
  assert.deepEqual(res, { ok: false, reason: 'denied' });
  assert.equal(constructorCount, 0);
});

// ── Electron send failure handling (C1125) ──
// A send the OS silently drops (e.g. main.js's notify:show reporting {ok:false,reason:'unsigned'}
// for an unsigned bundle) must not look identical to a real send from notify()'s caller's point
// of view: the debounce has to re-arm (so a retry isn't blocked for 30s) and lastError has to
// surface it, instead of the failure vanishing into a resolved promise nobody awaited.

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('notify() Electron failure re-arms the debounce and reports lastError', async () => {
  let sendCount = 0;
  globalThis.window = {
    electronAPI: {
      notify: () => { sendCount++; return Promise.resolve({ ok: false, reason: 'unsigned' }); },
      onNotificationClick: () => {},
    },
  };
  try {
    assert.equal(notify('t', 'b', 'tagFail'), true); // handed to the transport, not suppressed
    await flushMicrotasks();
    assert.equal(getNotificationStatus().lastError, 'unsigned');
    // Debounce was re-armed by the failure — an immediate retry is NOT blocked for 30s.
    assert.equal(notify('t', 'b', 'tagFail'), true);
    assert.equal(sendCount, 2);
  } finally {
    delete globalThis.window;
    clearDebounce('tagFail');
  }
});

test('notify() failure listeners fire with the tag (attention-notifications.js un-records its ledger on this)', async () => {
  globalThis.window = {
    electronAPI: {
      notify: () => Promise.resolve({ ok: false, reason: 'unsigned' }),
      onNotificationClick: () => {},
    },
  };
  const seen = [];
  const unsubscribe = onNotifyFailed((tag) => seen.push(tag));
  try {
    notify('t', 'b', 'tagListener');
    await flushMicrotasks();
    assert.deepEqual(seen, ['tagListener']);
  } finally {
    unsubscribe();
    delete globalThis.window;
    clearDebounce('tagListener');
  }
});

test('notify() success clears a prior lastError', async () => {
  let ok = false;
  globalThis.window = {
    electronAPI: {
      notify: () => Promise.resolve(ok ? { ok: true } : { ok: false, reason: 'unsigned' }),
      onNotificationClick: () => {},
    },
  };
  try {
    notify('t', 'b', 'tagRecover');
    await flushMicrotasks();
    assert.equal(getNotificationStatus().lastError, 'unsigned');
    ok = true;
    notify('t', 'b', 'tagRecover'); // debounce was re-armed by the failure above, so this sends
    await flushMicrotasks();
    assert.equal(getNotificationStatus().lastError, null);
  } finally {
    delete globalThis.window;
    clearDebounce('tagRecover');
  }
});

test('(TPT487) Show on Top off: status reports native delivery with bundle health, and Test succeeds', async () => {
  let live = { delivery: 'native', available: true, valid: true, reason: null, registered: false };
  const sent = [];
  globalThis.window = { electronAPI: {
    notificationDelivery: 'desktop',
    notify: (payload) => { sent.push(payload); return Promise.resolve({ ok: true, id: '1', delivery: 'native' }); },
    notifyStatus: () => Promise.resolve(live),
  } };
  try {
    await refreshNotificationStatus();
    let status = getNotificationStatus();
    assert.equal(status.delivery, 'native');
    assert.equal(status.transport, 'electron');
    assert.equal(status.lastError, 'not-registered', 'native delivery surfaces Notification Center health again');
    const result = await sendTestNotification('t', 'b');
    assert.deepEqual(result, { ok: true });
    assert.equal(typeof sent.at(-1).notificationId, 'string', 'native sends keep a callback identity for click routing');
    live = { delivery: 'desktop', available: true };
    await refreshNotificationStatus();
    status = getNotificationStatus();
    assert.equal(status.delivery, 'desktop');
    assert.equal(status.lastError, null);
  } finally {
    delete globalThis.window;
  }
});
