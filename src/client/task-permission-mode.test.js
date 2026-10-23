import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { t, setLocale } from './i18n.js';
import * as modes from './permission-mode.js';

const source = readFileSync(new URL('./task-permission-mode.js', import.meta.url), 'utf8');
const escapeAttr = v => String(v ?? '').replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
function harness(tc) {
  const window = new Window();
  tc.after(() => { window.happyDOM.close(); setLocale('en'); });
  window.document.body.innerHTML = '<div id="app"><div class="card" data-id="TPT1"><div class="controls-row"></div></div><div class="card card--preview" data-id="TPT2"><div class="controls-row"></div></div></div>';
  const store = { projectMode: 'auto' };
  const env = { document: window.document, t, escapeAttr, projectPermissionMode: () => store.projectMode, ...modes };
  vm.createContext(env);
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), env);
  const app = window.document.getElementById('app');
  app.querySelectorAll('.card').forEach(card => {
    card.querySelector('.controls-row').innerHTML = env.permissionButtonHtml({ id: card.dataset.id, agentPermissionMode: null });
  });
  return { env, store, app };
}

test('card shows each effective shield with inherited or explicit mode tooltip', tc => {
  const { env, store } = harness(tc);
  for (const mode of modes.AGENT_PERMISSION_MODES) {
    store.projectMode = mode;
    const inherited = env.permissionButtonHtml({ id: 'TPT1', agentPermissionMode: null });
    assert.ok(inherited.includes(modes.permissionModeIcon(mode)));
    assert.ok(inherited.includes(escapeAttr(modes.permissionModeTip({}, mode, t))));
    assert.doesNotMatch(inherited, / title=/, 'card uses its tooltip layer');
    const override = env.permissionButtonHtml({ id: 'TPT1', agent_permission_mode: mode });
    assert.ok(override.includes(modes.permissionModeIcon(mode)));
    assert.match(override, /card-permission-btn--override/);
  }
  store.projectMode = null;
  assert.ok(env.permissionButtonHtml({ id: 'TPT1' }).includes(modes.permissionModeIcon(null)));
});

test('sync updates shields after override/default edits, preserves omitted fields and skips previews', tc => {
  const { env, app, store } = harness(tc);
  const card = app.querySelector('.card');
  const button = card.querySelector('button');
  env.syncPermissionModeButton(card, { agentPermissionMode: 'bypass' });
  assert.equal(button.dataset.permissionMode, 'bypass');
  assert.equal(button.dataset.tip, 'Permission mode: Bypass');
  assert.ok(button.querySelector('.permission-mode-icon--bypass'));
  store.projectMode = 'plan';
  env.syncPermissionModeButton(card, { title: 'changed' });
  assert.ok(button.querySelector('.permission-mode-icon--bypass'));
  env.syncPermissionModeButton(card, { agentPermissionMode: null });
  assert.equal(button.dataset.permissionMode, '');
  assert.ok(button.querySelector('.permission-mode-icon--plan'));
  assert.equal(button.classList.contains('card-permission-btn--override'), false);
  store.projectMode = 'auto';
  env.syncAllPermissionButtons(app);
  assert.ok(button.querySelector('.permission-mode-icon--auto'));
  const preview = app.querySelector('.card--preview');
  const before = preview.innerHTML;
  env.syncPermissionModeButton(preview, { agentPermissionMode: 'bypass' });
  assert.equal(preview.innerHTML, before);
  setLocale('uk');
  env.syncAllPermissionButtons(app);
  assert.equal(button.getAttribute('aria-label'), modes.permissionModeTip({}, 'auto', t));
});

test('delegated shield click opens task settings once and skips disabled, discussing and preview cards', tc => {
  const { env, app } = harness(tc);
  const opened = [];
  const open = key => opened.push(key);
  env.initializeTaskPermissionMode(app, open);
  env.initializeTaskPermissionMode(app, open);
  const card = app.querySelector('.card');
  const button = card.querySelector('button');
  button.querySelector('path').dispatchEvent(new app.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, ['TPT1']);
  button.disabled = true;
  button.click();
  button.disabled = false;
  card.classList.add('card--discussing');
  button.click();
  app.querySelector('.card--preview button').click();
  assert.deepEqual(opened, ['TPT1']);
  assert.equal(env.openPermissionModeDialog, undefined);
  assert.doesNotMatch(source, /permission-mode-dialog|permission-mode-overlay|api\.project|api\.tasks/);
});
