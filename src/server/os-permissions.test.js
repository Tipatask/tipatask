'use strict';

// (TPT9112) Tests ../../main/os-permissions.js from here for the same reason as
// window-registry.test.js: npm test only discovers src/**/*.test.js. Every Electron object
// and the folder reads are fakes, so no real prompt, notification or protected read happens.
// Screen Recording and Accessibility default to granted, so only the tests that turn them off
// see the computer-use prompt.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  requestStartupPermissions, ensureStartupAppManagementPermission, ensureComputerUsePermissions,
  permissionDialog, appManagementDialog, computerUseDialog, MARKER_FILE,
} = require('../../main/os-permissions');
const { LOCALES, permissionStrings } = require('../../main/permissions-i18n');
const MENU = require('../../main/menu-i18n');

const HOME = path.resolve('/Users/tester');
const EXEC = '/Applications/TipATask.app/Contents/MacOS/TipATask';
const at = (...parts) => path.join(HOME, ...parts);
const WORK = path.resolve('/work/app');
const PROJECTS = [WORK, at('Documents', 'app')];
const FOLDERS = [at('Desktop'), at('Documents'), at('Downloads'), ...PROJECTS];
const FAST = { windowShowMs: 20, notificationRetryMs: [0, 0, 0], notificationAttemptMs: 20, folderMs: 40 };

function harness(t, {
  userDataPath = null, micStatus = 'not-determined', micAnswer = true, notificationAnswers = ['show'],
  notificationsSupported = true, folderErrors = {}, hangingFolders = [],
  appManagementResponse = 1, settingsError = null,
  screenStatus = 'granted', accessibilityTrusted = true, computerUseResponse = 1,
} = {}) {
  const dir = userDataPath || fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-os-permissions-'));
  if (!userDataPath) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const probes = [];
  const dialogCalls = [];
  const settingsUrls = [];
  class FakeNotification extends EventEmitter {
    static isSupported() {
      events.push('notifications:isSupported');
      return notificationsSupported;
    }
    constructor(options) {
      super();
      this.options = options;
      this.closed = false;
      probes.push(this);
    }
    show() {
      events.push('notifications:probe');
      const answer = notificationAnswers[Math.min(probes.length, notificationAnswers.length) - 1];
      setImmediate(() => this.emit(answer));
    }
    close() { this.closed = true; }
  }
  const systemPreferences = {
    getMediaAccessStatus: (type) => {
      if (type === 'screen') { events.push('screen:status'); return screenStatus; }
      events.push(`microphone:status:${type}`);
      return micStatus;
    },
    askForMediaAccess: async (type) => { events.push(`microphone:ask:${type}`); return micAnswer; },
    isTrustedAccessibilityClient: (prompt) => { events.push(`accessibility:trusted:${prompt}`); return accessibilityTrusted; },
  };
  // The explanation has one button, the App Management guidance two, the computer-use prompt three.
  const responses = { 1: 0, 2: appManagementResponse, 3: computerUseResponse };
  const dialog = {
    showMessageBox: async (...args) => {
      events.push(`dialog:${args.at(-1).buttons.length}`);
      dialogCalls.push(args);
      return { response: responses[args.at(-1).buttons.length] };
    },
  };
  const shell = { openExternal: async (url) => { settingsUrls.push(url); if (settingsError) throw settingsError; } };
  const opendir = async (folder) => {
    events.push(`folder:${folder}`);
    if (hangingFolders.includes(folder)) return new Promise(() => {});
    if (folderErrors[folder]) throw Object.assign(new Error(folderErrors[folder]), { code: folderErrors[folder] });
    return { read: async () => null, close: async () => {} };
  };
  const options = (extra = {}) => ({
    projectPaths: PROJECTS, userDataPath: dir, systemPreferences, Notification: FakeNotification, dialog, shell,
    platform: 'darwin', appVersion: '1.0.0', execPath: EXEC, home: HOME, opendir, timing: FAST,
    release: '22.0.0',
    log: { warn: (...args) => events.push(`warn:${args.join(' ')}`) }, now: () => '2026-10-24T12:00:00.000Z',
    ...extra,
  });
  const marker = () => JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
  return { dir, events, probes, dialogCalls, settingsUrls, options, marker };
}

const folderEvents = (events) => events.filter((e) => e.startsWith('folder:'));
const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security';
const GRANTED_COMPUTER_USE = { 'screen-recording': 'granted', accessibility: 'granted' };
// The live computer-use checks every macOS launch makes; neither raises a prompt.
const COMPUTER_USE_CHECKS = ['screen:status', 'accessibility:trusted:false'];
// The computer-use prompts a run showed (the only three-button dialog).
const computerUsePrompts = (h) => h.dialogCalls.filter((args) => args.at(-1).buttons.length === 3);

test('Windows and Linux are skipped: no explanation, no prompt, no marker file', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const h = harness(t, { screenStatus: 'denied', accessibilityTrusted: false });
    assert.deepEqual(await requestStartupPermissions(h.options({ platform })), { skipped: true });
    assert.deepEqual(h.events, [], platform);
    assert.equal(fs.existsSync(path.join(h.dir, MARKER_FILE)), false, platform);
  }
});

test('first macOS launch explains once, then asks for notifications, the microphone and every folder', async (t) => {
  const h = harness(t, { folderErrors: { [at('Downloads')]: 'EPERM', [WORK]: 'ENOENT' } });
  const outcome = await requestStartupPermissions(h.options());

  assert.equal(outcome.skipped, false);
  assert.equal(outcome.explained, true);
  assert.deepEqual(outcome.results, {
    'app-management': 'settings-guidance',
    ...GRANTED_COMPUTER_USE,
    microphone: 'granted',
    [`folder:${at('Desktop')}`]: 'granted',
    [`folder:${at('Documents')}`]: 'granted',
    [`folder:${at('Downloads')}`]: 'denied',
    [`folder:${WORK}`]: 'missing',
    [`folder:${at('Documents', 'app')}`]: 'granted',
    notifications: 'granted',
  });
  // The explanation comes before every request; folders are read one at a time, in order.
  assert.equal(h.events[0], 'dialog:1');
  assert.ok(h.events.indexOf('notifications:isSupported') > 0);
  assert.ok(h.events.indexOf('microphone:ask:microphone') > 0);
  assert.deepEqual(folderEvents(h.events), FOLDERS.map((dir) => `folder:${dir}`));
  assert.deepEqual(h.dialogCalls, [[permissionDialog('en')], [appManagementDialog('en')]], 'no parent window: standalone dialogs');

  const [probe] = h.probes;
  assert.equal(probe.options.silent, true);
  assert.equal(probe.options.title, LOCALES.en['permissions.probeTitle']);
  assert.equal(probe.closed, true, 'a delivered probe is closed straight away');

  const saved = h.marker();
  assert.equal(saved.explainedAt, '2026-10-24T12:00:00.000Z');
  assert.deepEqual(saved.permissions.microphone,
    { status: 'granted', appVersion: '1.0.0', execPath: EXEC, checkedAt: '2026-10-24T12:00:00.000Z' });
  assert.equal(saved.permissions[`folder:${at('Downloads')}`].status, 'denied');
  assert.equal(saved.permissions.notifications.status, 'granted');
});

test('a later launch skips granted entries, asks the rest again and never repeats the explanation', async (t) => {
  const first = harness(t, { folderErrors: { [at('Downloads')]: 'EPERM' } });
  await requestStartupPermissions(first.options());

  const second = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  const outcome = await requestStartupPermissions(second.options());

  assert.equal(outcome.explained, false);
  assert.deepEqual(second.events, [
    ...COMPUTER_USE_CHECKS, // live status, no prompt
    'microphone:status:microphone', // live status, no prompt
    `folder:${at('Downloads')}`, // denied last time: read again (macOS does not prompt twice)
  ]);
  assert.deepEqual(outcome.results, {
    'app-management': 'settings-guidance', ...GRANTED_COMPUTER_USE, microphone: 'granted',
    [`folder:${at('Downloads')}`]: 'granted',
  });
  assert.equal(second.marker().permissions[`folder:${at('Downloads')}`].status, 'granted');

  // Everything granted now: the third launch only reads the live computer-use and microphone status.
  const third = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  const before = fs.readFileSync(path.join(first.dir, MARKER_FILE), 'utf8');
  assert.deepEqual((await requestStartupPermissions(third.options())).results,
    { 'app-management': 'settings-guidance', ...GRANTED_COMPUTER_USE, microphone: 'granted' });
  assert.deepEqual(third.events, [...COMPUTER_USE_CHECKS, 'microphone:status:microphone']);
  assert.equal(fs.readFileSync(path.join(first.dir, MARKER_FILE), 'utf8'), before, 'nothing changed, nothing written');
});

test('an app update asks for TCC grants again but keeps the notification grant; another executable asks for both', async (t) => {
  const first = harness(t);
  await requestStartupPermissions(first.options());

  const updated = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  await requestStartupPermissions(updated.options({ appVersion: '1.0.1' }));
  assert.ok(!updated.events.some((e) => e.startsWith('dialog')));
  assert.ok(!updated.events.includes('notifications:isSupported'), 'notification authorization survives updates');
  assert.deepEqual(folderEvents(updated.events), FOLDERS.map((dir) => `folder:${dir}`));

  const dev = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  await requestStartupPermissions(dev.options({ appVersion: '1.0.1', execPath: '/dev/Electron.app/Contents/MacOS/Electron' }));
  assert.ok(dev.events.includes('notifications:isSupported'));
  assert.equal(folderEvents(dev.events).length, FOLDERS.length);
});

test('an unreadable marker suppresses the general explanation and still offers App Management guidance', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, MARKER_FILE), '{ not json');
  const outcome = await requestStartupPermissions(h.options());
  assert.equal(outcome.explained, false);
  assert.deepEqual(h.dialogCalls, [[appManagementDialog('en')]]);
  assert.equal(folderEvents(h.events).length, FOLDERS.length, 'nothing is known: every folder is read');
  assert.equal(h.marker().permissions.notifications.status, 'granted');
});

test('the explanation renders in the first project\'s language, falling back to English', async (t) => {
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    const options = permissionDialog(locale);
    const strings = LOCALES[locale];
    assert.equal(options.message, strings['permissions.message'], locale);
    assert.equal(options.detail, strings['permissions.detail'], locale);
    assert.deepEqual(options.buttons, [strings['permissions.continue']], locale);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    for (const key of ['title', 'message', 'detail', 'continue', 'probeTitle', 'probeBody']) {
      assert.ok(strings[`permissions.${key}`]?.trim(), `${locale} permissions.${key}`);
    }
  }
  for (const locale of ['uk', 'zh', 'es']) assert.notEqual(LOCALES[locale]['permissions.detail'], LOCALES.en['permissions.detail']);
  // The explanation lists every startup permission, the computer-use ones included.
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    const strings = LOCALES[locale];
    for (const key of ['permissions.screenRecording', 'permissions.accessibility']) {
      assert.ok(strings['permissions.detail'].includes(strings[key]), `${locale} explanation names ${key}`);
    }
  }
  assert.deepEqual(permissionDialog('xx'), permissionDialog('en'));

  const asked = [];
  const h = harness(t);
  await requestStartupPermissions(h.options({ localeFor: (dir) => { asked.push(dir); return 'uk'; } }));
  assert.deepEqual(asked, [PROJECTS[0]]);
  assert.deepEqual(h.dialogCalls, [[permissionDialog('uk')], [appManagementDialog('uk')]]);
  assert.equal(h.probes[0].options.title, LOCALES.uk['permissions.probeTitle']);

  const broken = harness(t);
  await requestStartupPermissions(broken.options({ localeFor: () => { throw new Error('unreadable config'); } }));
  assert.deepEqual(broken.dialogCalls, [[permissionDialog('en')], [appManagementDialog('en')]]);
});

test('the explanation waits for the startup window and opens as a sheet on it; a window that never shows gets a standalone dialog', async (t) => {
  const win = new EventEmitter();
  let visible = false;
  win.isDestroyed = () => false;
  win.isVisible = () => visible;
  const h = harness(t);
  const run = requestStartupPermissions(h.options({ parentWindow: win, timing: { ...FAST, windowShowMs: 1000 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.dialogCalls, [], 'nothing is asked while the window is still hidden');
  visible = true;
  win.emit('show');
  await run;
  assert.deepEqual(h.dialogCalls, [[win, permissionDialog('en')], [win, appManagementDialog('en')]]);
  assert.equal(win.listenerCount('show') + win.listenerCount('closed'), 0);

  const hidden = new EventEmitter();
  hidden.isDestroyed = () => false;
  hidden.isVisible = () => false;
  const late = harness(t);
  await requestStartupPermissions(late.options({ parentWindow: hidden }));
  assert.deepEqual(late.dialogCalls, [[permissionDialog('en')], [appManagementDialog('en')]]);
});

test('notification probe: retries until macOS delivers one, else records not-granted or unsupported', async (t) => {
  const allowedLater = harness(t, { notificationAnswers: ['failed', 'failed', 'show'] });
  await requestStartupPermissions(allowedLater.options());
  assert.equal(allowedLater.marker().permissions.notifications.status, 'granted');
  assert.deepEqual(allowedLater.probes.map((p) => p.closed), [false, false, true]);

  const refused = harness(t, { notificationAnswers: ['failed'] });
  await requestStartupPermissions(refused.options());
  assert.equal(refused.probes.length, FAST.notificationRetryMs.length);
  assert.equal(refused.marker().permissions.notifications.status, 'not-granted');

  const unsupported = harness(t, { notificationsSupported: false });
  await requestStartupPermissions(unsupported.options());
  assert.equal(unsupported.probes.length, 0);
  assert.equal(unsupported.marker().permissions.notifications.status, 'unsupported');
});

test('microphone: only a not-determined status prompts; a refusal is recorded', async (t) => {
  for (const status of ['denied', 'restricted']) {
    const h = harness(t, { micStatus: status });
    await requestStartupPermissions(h.options());
    assert.ok(!h.events.includes('microphone:ask:microphone'), status);
    assert.equal(h.marker().permissions.microphone.status, status);
  }
  const refused = harness(t, { micAnswer: false });
  await requestStartupPermissions(refused.options());
  assert.equal(refused.marker().permissions.microphone.status, 'denied');
});

test('a folder prompt left unanswered ends the folder pass for this launch', async (t) => {
  const h = harness(t, { hangingFolders: [at('Documents')] });
  const outcome = await requestStartupPermissions(h.options());
  assert.equal(outcome.results[`folder:${at('Documents')}`], 'unknown');
  assert.deepEqual(folderEvents(h.events), [`folder:${at('Desktop')}`, `folder:${at('Documents')}`]);
  assert.equal(h.marker().permissions[`folder:${at('Downloads')}`], undefined);
});

test('App Management guidance is localized, optional, and explains manual recovery', () => {
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    const options = appManagementDialog(locale);
    const strings = LOCALES[locale];
    for (const key of ['appManagementMessage', 'appManagementDetail', 'openSettings', 'later']) {
      assert.ok(strings[`permissions.${key}`]?.trim(), `${locale} permissions.${key}`);
      if (locale !== 'en') assert.notEqual(strings[`permissions.${key}`], LOCALES.en[`permissions.${key}`]);
    }
    assert.equal(options.message, strings['permissions.appManagementMessage']);
    assert.equal(options.detail, strings['permissions.appManagementDetail']);
    assert.deepEqual(options.buttons, [strings['permissions.openSettings'], strings['permissions.later']]);
    assert.equal(options.defaultId, 1, 'Enter leaves Settings closed');
    assert.equal(options.cancelId, 1, 'Escape leaves Settings closed');
    assert.match(options.detail, /TipATask/);
    assert.match(options.detail, /\+/);
  }
  assert.deepEqual(appManagementDialog('unknown'), appManagementDialog('en'));
});

test('App Management opens Settings only by explicit choice and never records an OS grant', async (t) => {
  for (const response of [0, 1]) {
    const h = harness(t, { appManagementResponse: response });
    await requestStartupPermissions(h.options());
    assert.deepEqual(h.settingsUrls, response === 0
      ? ['x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'] : []);
    assert.equal(h.marker().permissions['app-management'].status, 'settings-guidance');

    // Opening Settings cannot reveal whether access was granted, denied or left unchanged.
    // All three cases must skip the guidance on the next launch, even after an app update/move.
    for (const appVersion of ['1.0.0', '1.0.1', '1.0.2']) {
      const again = harness(t, { userDataPath: h.dir, micStatus: 'granted' });
      await requestStartupPermissions(again.options({ appVersion, execPath: `${EXEC}-${appVersion}` }));
      assert.deepEqual(again.dialogCalls, []);
      assert.deepEqual(again.settingsUrls, []);
      assert.equal(again.marker().permissions['app-management'].status, 'settings-guidance');
    }
  }
});

test('existing installations receive guidance once; pre-Ventura and unsupported checks skip cleanly', async (t) => {
  const old = harness(t);
  await requestStartupPermissions(old.options({ release: '21.6.0' }));
  assert.deepEqual(old.dialogCalls, [[permissionDialog('en')]]);
  assert.equal(old.marker().permissions['app-management'].status, 'unsupported');

  const upgraded = harness(t, { userDataPath: old.dir, micStatus: 'granted' });
  await requestStartupPermissions(upgraded.options({ release: '22.0.0' }));
  assert.deepEqual(upgraded.dialogCalls, [[appManagementDialog('en')]]);

  const unexpected = () => assert.fail('unsupported platforms must not request permissions or elevation');
  for (const [platform, release] of [
    ['win32', '22.0.0'], ['linux', '22.0.0'], ['freebsd', '22.0.0'],
    ['darwin', '21.6.0'], ['darwin', 'unknown'], ['darwin', ''],
  ]) {
    assert.equal(await ensureStartupAppManagementPermission({
      platform, release, dialog: { showMessageBox: unexpected }, shell: { openExternal: unexpected }, record: unexpected,
    }), 'unsupported', `${platform} ${release}`);
  }
  assert.equal(await ensureStartupAppManagementPermission({ platform: 'darwin', release: '22.0.0' }), 'unsupported');
});

test('Settings failures are nonfatal, fall back to Privacy settings and do not repeat guidance', async (t) => {
  const h = harness(t, { appManagementResponse: 0, settingsError: new Error('Settings unavailable') });
  const outcome = await requestStartupPermissions(h.options());
  assert.deepEqual(h.settingsUrls, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles',
    'x-apple.systempreferences:com.apple.preference.security',
  ]);
  assert.equal(outcome.results['app-management'], 'settings-guidance');
  assert.equal(outcome.results.microphone, 'granted', 'other startup permissions still run');
  assert.ok(h.events.some((event) => event.includes('Settings unavailable')));
  const again = harness(t, { userDataPath: h.dir, micStatus: 'granted' });
  await requestStartupPermissions(again.options());
  assert.deepEqual(again.dialogCalls, []);

  const fallback = harness(t, { appManagementResponse: 0 });
  await requestStartupPermissions(fallback.options({ shell: { openExternal: async (url) => {
    fallback.settingsUrls.push(url);
    if (fallback.settingsUrls.length === 1) throw new Error('anchor unavailable');
  } } }));
  assert.equal(fallback.settingsUrls.length, 2);
  assert.ok(!fallback.events.some((event) => event.startsWith('warn:')));
});

test('an unanswered or rejected guidance dialog is recorded before waiting and never repeats', async (t) => {
  const h = harness(t);
  // A real startup calls requestStartupPermissions without awaiting it. Even with the guidance
  // unanswered, its marker is saved and the caller can continue creating/showing its UI.
  let answer;
  const pending = requestStartupPermissions(h.options({ dialog: { showMessageBox: (options) => {
    h.dialogCalls.push(options);
    return options.buttons.length === 2 ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ response: 0 });
  } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.marker().permissions['app-management'].status, 'settings-guidance');
  const next = harness(t, { userDataPath: h.dir, micStatus: 'granted' });
  await requestStartupPermissions(next.options());
  assert.deepEqual(next.dialogCalls, []);
  answer({ response: 1 });
  await pending;

  const rejected = harness(t);
  await requestStartupPermissions(rejected.options({ dialog: { showMessageBox: async (options) => {
    if (options.buttons.length === 2) throw new Error('dialog closed');
    return { response: 0 };
  } } }));
  assert.equal(rejected.marker().permissions['app-management'].status, 'settings-guidance');
  assert.equal(rejected.marker().permissions.microphone.status, 'granted');
});

// ── Screen Recording and Accessibility (computer use) ───────────────────────────────────────

test('computer use: granted items are read live every launch, recorded, and never prompt', async (t) => {
  const h = harness(t);
  const outcome = await requestStartupPermissions(h.options());
  assert.equal(outcome.results['screen-recording'], 'granted');
  assert.equal(outcome.results.accessibility, 'granted');
  assert.deepEqual(computerUsePrompts(h), []);
  assert.ok(!h.events.includes('accessibility:trusted:true'), 'the check never raises macOS\'s own Accessibility alert');
  assert.deepEqual(h.marker().permissions['screen-recording'],
    { status: 'granted', appVersion: '1.0.0', execPath: EXEC, checkedAt: '2026-10-24T12:00:00.000Z' });
  assert.equal(h.marker().permissions.accessibility.status, 'granted');

  // A grant is not trusted from the marker: a revoked one is noticed and asked about.
  const revoked = harness(t, { userDataPath: h.dir, micStatus: 'granted', accessibilityTrusted: false });
  const again = await requestStartupPermissions(revoked.options());
  assert.equal(again.results.accessibility, 'not-granted');
  assert.equal(computerUsePrompts(revoked).length, 1);
});

test('computer use: one prompt names only the missing item and opens its System Settings pane', async (t) => {
  for (const [off, pane] of [
    [{ screenStatus: 'denied' }, SCREEN_PANE], [{ accessibilityTrusted: false }, ACCESSIBILITY_PANE],
  ]) {
    const h = harness(t, { ...off, computerUseResponse: 0 });
    const outcome = await requestStartupPermissions(h.options());
    const missing = off.screenStatus ? 'screen-recording' : 'accessibility';
    const present = off.screenStatus ? 'accessibility' : 'screen-recording';
    const prompts = computerUsePrompts(h);
    assert.equal(prompts.length, 1, missing);
    assert.deepEqual(prompts[0], [computerUseDialog('en', [missing])]);
    const strings = LOCALES.en;
    const name = { 'screen-recording': 'permissions.screenRecording', accessibility: 'permissions.accessibility' };
    assert.ok(prompts[0][0].message.includes(strings[name[missing]]), `${missing}: the prompt names the missing item`);
    assert.ok(!prompts[0][0].message.includes(strings[name[present]]), `${missing}: the granted item is not named`);
    assert.ok(!prompts[0][0].detail.includes(strings[`${name[present]}Item`]), `${missing}: no line for the granted item`);
    assert.deepEqual(h.settingsUrls, [pane]);
    // Opening Settings proves nothing: the item stays off until the next launch reads it.
    assert.equal(outcome.results[missing], 'not-granted');
    assert.equal(outcome.results[present], 'granted');
    assert.equal(h.marker().permissions[missing].status, 'not-granted');
  }
});

test('computer use: both items off get one prompt naming both; Settings opens the first item\'s pane', async (t) => {
  const h = harness(t, { screenStatus: 'denied', accessibilityTrusted: false, computerUseResponse: 0 });
  const outcome = await requestStartupPermissions(h.options());
  assert.deepEqual(computerUsePrompts(h), [[computerUseDialog('en', ['screen-recording', 'accessibility'])]]);
  assert.equal(computerUsePrompts(h)[0][0].message, 'Turn on Screen Recording and Accessibility for TipΔTask');
  assert.deepEqual(h.settingsUrls, [SCREEN_PANE]);
  assert.equal(outcome.results['screen-recording'], 'not-granted');
  assert.equal(outcome.results.accessibility, 'not-granted');
  // The prompt comes after App Management guidance and before the system prompts start.
  const prompt = h.events.indexOf('dialog:3');
  assert.ok(prompt > h.events.indexOf('dialog:2'));
  assert.ok(prompt < h.events.indexOf('notifications:isSupported'));
  assert.ok(prompt < h.events.indexOf('microphone:status:microphone'));
  assert.ok(prompt < h.events.indexOf(`folder:${at('Desktop')}`));
});

test('computer use: Later asks again at the next launch, at most once per launch, until the items are on', async (t) => {
  const first = harness(t, { screenStatus: 'denied', accessibilityTrusted: false });
  await requestStartupPermissions(first.options());
  assert.equal(computerUsePrompts(first).length, 1);
  assert.deepEqual(first.settingsUrls, [], 'Later never opens Settings');
  assert.equal(first.marker().permissions['screen-recording'].status, 'not-granted');

  const second = harness(t, { userDataPath: first.dir, micStatus: 'granted', screenStatus: 'denied', accessibilityTrusted: false });
  await requestStartupPermissions(second.options());
  assert.equal(computerUsePrompts(second).length, 1, 'one prompt per launch');
  assert.deepEqual(second.dialogCalls, computerUsePrompts(second), 'no other dialog on a later launch');

  // Screen Recording turned on in Settings: the next prompt names Accessibility only.
  const third = harness(t, { userDataPath: first.dir, micStatus: 'granted', accessibilityTrusted: false });
  const outcome = await requestStartupPermissions(third.options());
  assert.deepEqual(computerUsePrompts(third), [[computerUseDialog('en', ['accessibility'])]]);
  assert.equal(outcome.results['screen-recording'], 'granted');

  const done = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  await requestStartupPermissions(done.options());
  assert.deepEqual(done.dialogCalls, []);
});

test('computer use: Don\'t Ask Again skips the named items for good, even across updates and moves', async (t) => {
  const h = harness(t, { screenStatus: 'denied', accessibilityTrusted: false, computerUseResponse: 2 });
  const outcome = await requestStartupPermissions(h.options());
  assert.equal(outcome.results['screen-recording'], 'skipped');
  assert.equal(outcome.results.accessibility, 'skipped');
  assert.deepEqual(h.settingsUrls, []);
  assert.equal(h.marker().permissions['screen-recording'].status, 'skipped');
  assert.equal(h.marker().permissions.accessibility.status, 'skipped');

  for (const [appVersion, execPath] of [['1.0.0', EXEC], ['1.0.1', EXEC], ['1.0.1', '/dev/Electron.app/Contents/MacOS/Electron']]) {
    const again = harness(t, { userDataPath: h.dir, micStatus: 'granted', screenStatus: 'denied', accessibilityTrusted: false });
    const next = await requestStartupPermissions(again.options({ appVersion, execPath }));
    assert.deepEqual(again.dialogCalls, [], `${appVersion} ${execPath}: never asked again`);
    assert.ok(!again.events.some((e) => e === 'screen:status' || e.startsWith('accessibility:')), 'a skipped item is not even read');
    assert.equal(next.results['screen-recording'], 'skipped');
    assert.equal(next.results.accessibility, 'skipped');
  }
});

test('computer use: skipping one item leaves the other to be asked about on its own', async (t) => {
  const h = harness(t, { screenStatus: 'denied', computerUseResponse: 2 });
  await requestStartupPermissions(h.options());
  assert.equal(h.marker().permissions['screen-recording'].status, 'skipped');
  assert.equal(h.marker().permissions.accessibility.status, 'granted');

  // Accessibility is revoked later: the prompt names it alone, never the skipped item.
  const later = harness(t, { userDataPath: h.dir, micStatus: 'granted', screenStatus: 'denied', accessibilityTrusted: false });
  const outcome = await requestStartupPermissions(later.options());
  assert.deepEqual(computerUsePrompts(later), [[computerUseDialog('en', ['accessibility'])]]);
  assert.equal(outcome.results['screen-recording'], 'skipped');
  assert.equal(outcome.results.accessibility, 'not-granted');
});

test('computer use: restricted, unsupported and unknown statuses never prompt', async (t) => {
  const restricted = harness(t, { screenStatus: 'restricted' });
  await requestStartupPermissions(restricted.options());
  assert.deepEqual(computerUsePrompts(restricted), []);
  assert.equal(restricted.marker().permissions['screen-recording'].status, 'restricted');

  for (const [systemPreferences, expected] of [
    [{}, { 'screen-recording': 'unsupported', accessibility: 'unsupported' }],
    [{
      getMediaAccessStatus: () => { throw new Error('no TCC'); },
      isTrustedAccessibilityClient: () => { throw new Error('no AX'); },
    }, { 'screen-recording': 'unknown', accessibility: 'unknown' }],
    [{ getMediaAccessStatus: () => 'unknown', isTrustedAccessibilityClient: () => true },
      { 'screen-recording': 'unknown', accessibility: 'granted' }],
    [{ getMediaAccessStatus: () => 'not-determined', isTrustedAccessibilityClient: () => true },
      { 'screen-recording': 'not-granted', accessibility: 'granted' }],
  ]) {
    const recorded = {};
    const shown = [];
    const statuses = await ensureComputerUsePermissions({
      platform: 'darwin', systemPreferences, record: (id, status) => { recorded[id] = status; },
      dialog: { showMessageBox: async (options) => { shown.push(options); return { response: 1 }; } },
      timing: FAST,
    });
    assert.deepEqual(statuses, expected);
    assert.deepEqual(recorded, expected, 'every status is recorded');
    assert.equal(shown.length, expected['screen-recording'] === 'not-granted' ? 1 : 0);
  }
});

test('computer use: Windows and Linux are a no-op that touches no dependency', async () => {
  const unexpected = () => assert.fail('computer use must not check, prompt or record off macOS');
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(await ensureComputerUsePermissions({
      platform,
      systemPreferences: { getMediaAccessStatus: unexpected, isTrustedAccessibilityClient: unexpected },
      dialog: { showMessageBox: unexpected }, shell: { openExternal: unexpected }, record: unexpected,
    }), { 'screen-recording': 'unsupported', accessibility: 'unsupported' }, platform);
  }
});

test('computer use: a failed prompt is non-fatal, a rejected pane falls back to Privacy & Security', async (t) => {
  const failed = harness(t, { screenStatus: 'denied' });
  const outcome = await requestStartupPermissions(failed.options({ dialog: { showMessageBox: async (options) => {
    if (options.buttons.length === 3) throw new Error('prompt closed');
    return { response: options.buttons.length === 2 ? 1 : 0 };
  } } }));
  assert.equal(outcome.results['screen-recording'], 'not-granted');
  assert.equal(outcome.results.microphone, 'granted', 'the rest of startup still runs');
  assert.ok(failed.events.some((e) => e.startsWith('warn:') && e.includes('prompt closed')));

  const fallback = harness(t, { accessibilityTrusted: false, computerUseResponse: 0 });
  await requestStartupPermissions(fallback.options({ shell: { openExternal: async (url) => {
    fallback.settingsUrls.push(url);
    if (url === ACCESSIBILITY_PANE) throw new Error('anchor unavailable');
  } } }));
  assert.deepEqual(fallback.settingsUrls, [ACCESSIBILITY_PANE, PRIVACY_PANE]);
  assert.ok(!fallback.events.some((e) => e.startsWith('warn:')));
});

test('computer use: the prompt waits for the startup window and opens as a sheet on it', async (t) => {
  const win = new EventEmitter();
  let visible = false;
  win.isDestroyed = () => false;
  win.isVisible = () => visible;
  const h = harness(t, { screenStatus: 'denied', accessibilityTrusted: false });
  const run = requestStartupPermissions(h.options({ parentWindow: win, timing: { ...FAST, windowShowMs: 1000 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.dialogCalls, [], 'nothing is asked while the window is still hidden');
  visible = true;
  win.emit('show');
  await run;
  assert.deepEqual(h.dialogCalls, [
    [win, permissionDialog('en')], [win, appManagementDialog('en')],
    [win, computerUseDialog('en', ['screen-recording', 'accessibility'])],
  ]);
  assert.equal(win.listenerCount('show') + win.listenerCount('closed'), 0);
});

test('computer use: the prompt speaks the project language in en, uk, zh and es', async (t) => {
  const both = ['screen-recording', 'accessibility'];
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    const strings = LOCALES[locale];
    const options = computerUseDialog(locale, both);
    const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
      .format([strings['permissions.screenRecording'], strings['permissions.accessibility']]);
    assert.equal(options.message, strings['permissions.computerUseMessage'].replace('{names}', names), locale);
    assert.equal(options.detail, strings['permissions.computerUseDetail'].replace('{list}',
      `${strings['permissions.screenRecordingItem']}\n${strings['permissions.accessibilityItem']}`), locale);
    assert.ok(!/\{\w+\}/.test(options.message + options.detail), `${locale}: every placeholder is filled`);
    assert.deepEqual(options.buttons,
      [strings['permissions.openSettings'], strings['permissions.later'], strings['permissions.dontAskAgain']], locale);
    assert.equal(options.title, strings['permissions.title']);
    assert.equal(options.defaultId, 0, 'Enter opens System Settings');
    assert.equal(options.cancelId, 1, 'Escape is Later, never Don\'t Ask Again');
    assert.match(options.detail, /TipATask/);
    assert.match(options.detail, /\+/);
  }
  // Ids name items in a fixed order, and an unknown language is English.
  assert.deepEqual(computerUseDialog('en', ['accessibility', 'screen-recording']), computerUseDialog('en', both));
  assert.deepEqual(computerUseDialog('xx', both), computerUseDialog('en', both));
  assert.deepEqual(computerUseDialog(undefined, ['accessibility']), computerUseDialog('en', ['accessibility']));

  const h = harness(t, { screenStatus: 'denied' });
  await requestStartupPermissions(h.options({ localeFor: () => 'zh' }));
  assert.deepEqual(computerUsePrompts(h), [[computerUseDialog('zh', ['screen-recording'])]]);
  assert.equal(computerUsePrompts(h)[0][0].message, '为 TipΔTask 开启录屏');
});

test('permission copy: every locale defines exactly the English keys, translated, with the same placeholders', () => {
  const enKeys = Object.keys(LOCALES.en);
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(LOCALES).sort(), ['en', 'es', 'uk', 'zh']);
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(table).sort(), [...enKeys].sort(), `${locale} key set`);
    for (const key of enKeys) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${locale}.${key} is a non-empty string`);
      assert.deepEqual(placeholders(table[key]), placeholders(LOCALES.en[key]), `${locale}.${key} placeholders`);
      if (locale !== 'en') assert.notEqual(table[key], LOCALES.en[key], `${locale}.${key} is translated`);
    }
  }
  assert.deepEqual(permissionStrings('zh'), LOCALES.zh);
  assert.deepEqual(permissionStrings('constructor'), LOCALES.en);
  // The startup permission copy lives here only, not in the en/uk native-menu table.
  for (const table of Object.values(MENU.LOCALES)) {
    assert.deepEqual(Object.keys(table).filter((key) => key.startsWith('permissions.')), []);
  }
});
