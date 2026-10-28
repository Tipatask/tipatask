'use strict';

// (TPT9112) Tests ../../main/os-permissions.js from here for the same reason as
// window-registry.test.js: npm test only discovers src/**/*.test.js. Every Electron object
// and the folder reads are fakes, so no real prompt, notification or protected read happens.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { requestStartupPermissions, permissionDialog, MARKER_FILE } = require('../../main/os-permissions');
const { LOCALES } = require('../../main/menu-i18n');

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
} = {}) {
  const dir = userDataPath || fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-os-permissions-'));
  if (!userDataPath) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const probes = [];
  const dialogCalls = [];
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
    getMediaAccessStatus: (type) => { events.push(`microphone:status:${type}`); return micStatus; },
    askForMediaAccess: async (type) => { events.push(`microphone:ask:${type}`); return micAnswer; },
  };
  const dialog = {
    showMessageBox: async (...args) => { events.push('dialog'); dialogCalls.push(args); return { response: 0 }; },
  };
  const opendir = async (folder) => {
    events.push(`folder:${folder}`);
    if (hangingFolders.includes(folder)) return new Promise(() => {});
    if (folderErrors[folder]) throw Object.assign(new Error(folderErrors[folder]), { code: folderErrors[folder] });
    return { read: async () => null, close: async () => {} };
  };
  const options = (extra = {}) => ({
    projectPaths: PROJECTS, userDataPath: dir, systemPreferences, Notification: FakeNotification, dialog,
    platform: 'darwin', appVersion: '1.0.0', execPath: EXEC, home: HOME, opendir, timing: FAST,
    log: { warn: (...args) => events.push(`warn:${args.join(' ')}`) }, now: () => '2026-10-24T12:00:00.000Z',
    ...extra,
  });
  const marker = () => JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
  return { dir, events, probes, dialogCalls, options, marker };
}

const folderEvents = (events) => events.filter((e) => e.startsWith('folder:'));

test('Windows and Linux are skipped: no explanation, no prompt, no marker file', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const h = harness(t);
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
    microphone: 'granted',
    [`folder:${at('Desktop')}`]: 'granted',
    [`folder:${at('Documents')}`]: 'granted',
    [`folder:${at('Downloads')}`]: 'denied',
    [`folder:${WORK}`]: 'missing',
    [`folder:${at('Documents', 'app')}`]: 'granted',
    notifications: 'granted',
  });
  // The explanation comes before every request; folders are read one at a time, in order.
  assert.equal(h.events[0], 'dialog');
  assert.ok(h.events.indexOf('notifications:isSupported') > 0);
  assert.ok(h.events.indexOf('microphone:ask:microphone') > 0);
  assert.deepEqual(folderEvents(h.events), FOLDERS.map((dir) => `folder:${dir}`));
  assert.deepEqual(h.dialogCalls, [[permissionDialog('en')]], 'no parent window: a standalone dialog');

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
    'microphone:status:microphone', // live status, no prompt
    `folder:${at('Downloads')}`, // denied last time: read again (macOS does not prompt twice)
  ]);
  assert.deepEqual(outcome.results, { microphone: 'granted', [`folder:${at('Downloads')}`]: 'granted' });
  assert.equal(second.marker().permissions[`folder:${at('Downloads')}`].status, 'granted');

  // Everything granted now: the third launch only reads the live microphone status.
  const third = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  const before = fs.readFileSync(path.join(first.dir, MARKER_FILE), 'utf8');
  assert.deepEqual((await requestStartupPermissions(third.options())).results, { microphone: 'granted' });
  assert.deepEqual(third.events, ['microphone:status:microphone']);
  assert.equal(fs.readFileSync(path.join(first.dir, MARKER_FILE), 'utf8'), before, 'nothing changed, nothing written');
});

test('an app update asks for TCC grants again but keeps the notification grant; another executable asks for both', async (t) => {
  const first = harness(t);
  await requestStartupPermissions(first.options());

  const updated = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  await requestStartupPermissions(updated.options({ appVersion: '1.0.1' }));
  assert.ok(!updated.events.includes('dialog'));
  assert.ok(!updated.events.includes('notifications:isSupported'), 'notification authorization survives updates');
  assert.deepEqual(folderEvents(updated.events), FOLDERS.map((dir) => `folder:${dir}`));

  const dev = harness(t, { userDataPath: first.dir, micStatus: 'granted' });
  await requestStartupPermissions(dev.options({ appVersion: '1.0.1', execPath: '/dev/Electron.app/Contents/MacOS/Electron' }));
  assert.ok(dev.events.includes('notifications:isSupported'));
  assert.equal(folderEvents(dev.events).length, FOLDERS.length);
});

test('the explanation is not shown again once os-permissions.json exists, even unreadable', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, MARKER_FILE), '{ not json');
  const outcome = await requestStartupPermissions(h.options());
  assert.equal(outcome.explained, false);
  assert.ok(!h.events.includes('dialog'));
  assert.equal(folderEvents(h.events).length, FOLDERS.length, 'nothing is known: every folder is read');
  assert.equal(h.marker().permissions.notifications.status, 'granted');
});

test('the explanation renders in the first project\'s language, falling back to English', async (t) => {
  for (const locale of ['en', 'uk']) {
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
  assert.notEqual(LOCALES.uk['permissions.detail'], LOCALES.en['permissions.detail']);
  assert.deepEqual(permissionDialog('xx'), permissionDialog('en'));

  const asked = [];
  const h = harness(t);
  await requestStartupPermissions(h.options({ localeFor: (dir) => { asked.push(dir); return 'uk'; } }));
  assert.deepEqual(asked, [PROJECTS[0]]);
  assert.deepEqual(h.dialogCalls, [[permissionDialog('uk')]]);
  assert.equal(h.probes[0].options.title, LOCALES.uk['permissions.probeTitle']);

  const broken = harness(t);
  await requestStartupPermissions(broken.options({ localeFor: () => { throw new Error('unreadable config'); } }));
  assert.deepEqual(broken.dialogCalls, [[permissionDialog('en')]]);
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
  assert.deepEqual(h.dialogCalls, [[win, permissionDialog('en')]]);
  assert.equal(win.listenerCount('show') + win.listenerCount('closed'), 0);

  const hidden = new EventEmitter();
  hidden.isDestroyed = () => false;
  hidden.isVisible = () => false;
  const late = harness(t);
  await requestStartupPermissions(late.options({ parentWindow: hidden }));
  assert.deepEqual(late.dialogCalls, [[permissionDialog('en')]]);
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
