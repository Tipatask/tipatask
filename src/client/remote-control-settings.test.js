import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fa' });
for (const name of ['window', 'document', 'location', 'localStorage', 'sessionStorage']) {
  globalThis[name] = name === 'window' ? window : window[name];
}
const { initRemoteControlSettings, populateRemoteControlSettings } = await import('./remote-control-settings.js');
const { api } = await import('./api-client.js');
const browserSetRemoteControl = api.project.setRemoteControl;
const { LOCALES, setLocale } = await import('./i18n.js');
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const markup = html.slice(html.indexOf('<div id="settings-modal"'), html.indexOf('<!-- (C1388)'));
const projects = new Map();
let calls;
let failReads;
let failWrites;
let saveGate;
const toggle = () => document.getElementById('settings-remote-control-toggle');
const notice = () => document.getElementById('settings-remote-control-notice');
const configured = value => ({ API_BASE_URL: 'https://api.test', API_PROJECT_ID: '1', unrelated: 'keep', ...value });

beforeEach(() => {
  window.history.replaceState(null, '', '/?projectPath=%2Fa');
  document.body.innerHTML = markup;
  setLocale('en');
  calls = [];
  failReads = failWrites = false;
  saveGate = null;
  projects.clear();
  projects.set('/a', configured({}));
  projects.set('/b', configured({ REMOTE_CONTROL_ENABLED: true }));
  globalThis.fetch = async (_url, options = {}) => {
    const root = options.headers?.['x-tipatask-project'];
    calls.push({ root, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'POST' && saveGate) await saveGate;
    const failed = options.method === 'GET' ? failReads : failWrites;
    return {
      ok: !failed, status: failed ? 500 : 200,
      json: async () => {
        if (failed) return { error: 'unavailable' };
        if (options.method === 'GET') return { projectPath: root, config: { ...projects.get(root) }, remoteControl: { available: true, enabled: projects.get(root)?.REMOTE_CONTROL_ENABLED === true, context: 'scope', migrationRequired: projects.get(root)?.legacy === true } };
        projects.set(root, { ...projects.get(root), REMOTE_CONTROL_ENABLED: JSON.parse(options.body).enabled });
        return { ok: true, remoteControl: { context: 'scope' } };
      },
    };
  };
  api.project.setRemoteControl = async (enabled, context, projectPath) => {
    const reply = await fetch('/local-ipc-only', { method: 'POST', headers: { 'x-tipatask-project': projectPath }, body: JSON.stringify({ enabled, context }) });
    if (!reply.ok) throw new Error('unavailable');
    return reply.json();
  };
  initRemoteControlSettings();
});
after(async () => { await window.happyDOM.close(); });

async function settled() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

function change(value) {
  toggle().checked = value;
  toggle().dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('General contains an accessible device-scoped switch, disabled until its read succeeds', async () => {
  assert.ok(toggle().closest('[data-tab="general"]'));
  assert.equal(toggle().getAttribute('role'), 'switch');
  assert.ok(document.querySelector('label[for="settings-remote-control-toggle"]'));
  assert.equal(toggle().getAttribute('aria-describedby'), 'settings-remote-control-scope settings-remote-control-hint');
  assert.equal(toggle().disabled, true);
  await populateRemoteControlSettings();
  assert.equal(toggle().disabled, false);
  assert.equal(toggle().checked, false);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('only a literal saved true enables the switch; opening never writes', async () => {
  for (const value of [undefined, false, 'true', 1, true]) {
    projects.set('/a', configured({ REMOTE_CONTROL_ENABLED: value }));
    await populateRemoteControlSettings();
    assert.equal(toggle().checked, value === true);
  }
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('enable and disable persist only a boolean patch for the selected device project, including after reopen', async () => {
  await populateRemoteControlSettings();
  initRemoteControlSettings(); // repeated wiring must not send duplicate writes
  change(true);
  assert.equal(toggle().disabled, true);
  await settled();
  assert.equal(projects.get('/a').REMOTE_CONTROL_ENABLED, true);
  assert.equal(projects.get('/a').unrelated, 'keep');
  assert.equal(notice().textContent, LOCALES.en['settings.remoteControl.enabled']);
  await populateRemoteControlSettings();
  assert.equal(toggle().checked, true);
  change(false);
  await settled();
  assert.equal(projects.get('/a').REMOTE_CONTROL_ENABLED, false);
  assert.equal(projects.get('/b').REMOTE_CONTROL_ENABLED, true);
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => [c.root, c.body]), [
    ['/a', { enabled: true, context: 'scope' }], ['/a', { enabled: false, context: 'scope' }],
  ]);
});

test('a failed save restores the saved switch and offers another attempt', async () => {
  await populateRemoteControlSettings();
  failWrites = true;
  change(true);
  await settled();
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, false);
  assert.equal(projects.get('/a').REMOTE_CONTROL_ENABLED, undefined);
  assert.equal(notice().getAttribute('role'), 'alert');
  assert.equal(notice().textContent, LOCALES.en['settings.remoteControl.saveFailed']);
  failWrites = false;
  change(true);
  await settled();
  assert.equal(toggle().checked, true);
  assert.equal(projects.get('/a').REMOTE_CONTROL_ENABLED, true);
});

test('a focused switch keeps keyboard focus after its save completes', async () => {
  await populateRemoteControlSettings();
  toggle().focus();
  change(true);
  await settled();
  assert.equal(document.activeElement, toggle());
});

test('failed reads keep the switch disabled and recover on the next Settings open', async () => {
  failReads = true;
  await populateRemoteControlSettings();
  assert.equal(toggle().disabled, true);
  assert.equal(notice().getAttribute('role'), 'alert');
  failReads = false;
  await populateRemoteControlSettings();
  assert.equal(toggle().disabled, false);
  assert.equal(notice().hidden, true);
});

test('reopening waits for an in-flight save instead of rendering a stale off value', async () => {
  await populateRemoteControlSettings();
  let finish;
  saveGate = new Promise(resolve => { finish = resolve; });
  change(true);
  const reopening = populateRemoteControlSettings();
  assert.equal(toggle().disabled, true);
  finish();
  await reopening;
  assert.equal(toggle().checked, true);
  assert.equal(toggle().disabled, false);
});

test('a project switch reloads its own value and cannot save the previous project setting into it', async () => {
  await populateRemoteControlSettings();
  window.history.replaceState(null, '', '/?projectPath=%2Fb');
  change(true);
  await settled();
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(toggle().checked, true);
  change(false);
  await settled();
  assert.equal(projects.get('/b').REMOTE_CONTROL_ENABLED, false);
  assert.equal(projects.get('/a').REMOTE_CONTROL_ENABLED, undefined);
});

test('unconfigured projects cannot opt in, and every supported locale supplies the row and outcomes', async () => {
  projects.set('/a', {});
  await populateRemoteControlSettings();
  assert.equal(toggle().disabled, true);
  assert.equal(notice().textContent, LOCALES.en['settings.remoteControl.unavailable']);
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    for (const suffix of ['title', 'label', 'scope', 'hint', 'unavailable', 'loadFailed', 'saveFailed', 'enabled', 'disabled', 'confirmAgain', 'desktopRequired']) {
      assert.ok(LOCALES[locale][`settings.remoteControl.${suffix}`]);
    }
  }
});

test('failed HTTP saves reject instead of being treated as success', async () => {
  failWrites = true;
  await assert.rejects(api.project.mergeConfig({ REMOTE_CONTROL_ENABLED: true }, '/a'));
});

test('a copied legacy toggle shows localized reconfirmation while remaining off', async () => {
  projects.set('/a', configured({ legacy: true }));
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    setLocale(locale);
    await populateRemoteControlSettings();
    assert.equal(toggle().checked, false);
    assert.equal(notice().textContent, LOCALES[locale]['settings.remoteControl.confirmAgain']);
  }
});

test('browser context cannot submit local consent', async () => {
  await assert.rejects(browserSetRemoteControl(true, 'scope', '/a'), /local desktop consent/);
});
