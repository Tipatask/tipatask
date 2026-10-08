import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT508) Every overlay opened over the task workspace (TPT466) must own a dialog-focus layer,
// or the workspace layer leaves it painted on top but inert. Real client modules in happy-dom;
// only the network is stubbed. Each call bundles a fresh copy, so layer state never leaks.
async function withClient(run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-dialog-focus-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('WebSocket', class { static OPEN = 1; send() {} close() {} });
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as board from './src/client/task-board.js';
        export * as dialogFocus from './src/client/dialog-focus.js';
        export * as actionConfirm from './src/client/action-confirm.js';
        export * as wizard from './src/client/project-creation-wizard.js';
        export * as setupModal from './src/client/setup-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal { loadAddon() {} open() {} dispose() {} }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    const flush = () => new Promise(resolve => setTimeout(resolve, 10)); // MutationObserver inerting
    await run({ ...api, window, flush });
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Stand-in for the open task workspace: same element id, its own layer, a focused control.
function openWorkspace(dialogFocus) {
  document.body.insertAdjacentHTML('beforeend',
    '<div id="task-edit-modal"><div class="task-edit-overlay"><input class="modal-title-input"></div></div>');
  const workspace = document.getElementById('task-edit-modal');
  const handle = dialogFocus.activateDialogFocus({ root: workspace, initialFocus: '.modal-title-input' });
  return { workspace, handle, title: workspace.querySelector('.modal-title-input') };
}

function escape() {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

test('closing a lower layer keeps the top layer interactive and focused', async () => {
  await withClient(async ({ dialogFocus, flush }) => {
    document.body.innerHTML = '<div id="a"><button>a</button></div><div id="b"><button>b</button></div>'
      + '<div id="c"><button>c</button></div><div id="bg"><button>bg</button></div>';
    const [a, b, c, bg] = ['a', 'b', 'c', 'bg'].map(id => document.getElementById(id));
    const la = dialogFocus.activateDialogFocus({ root: a });
    const lb = dialogFocus.activateDialogFocus({ root: b });
    const lc = dialogFocus.activateDialogFocus({ root: c });
    await flush();
    assert.equal(document.activeElement, c.querySelector('button'));
    lb.close();
    await flush();
    assert.equal(lc.isTop(), true);
    assert.notEqual(c.inert, true, 'top layer stays interactive');
    assert.equal(a.inert, true);
    assert.equal(bg.inert, true);
    assert.equal(document.activeElement, c.querySelector('button'), 'focus stays in the top layer');
    lc.close();
    await flush();
    assert.equal(la.isTop(), true);
    assert.notEqual(a.inert, true);
    assert.ok(a.contains(document.activeElement), 'focus returns into the remaining layer');
    la.close();
    await flush();
    assert.notEqual(bg.inert, true, 'no layers left: background restored');
  });
});

test('status-change confirm is interactive over the workspace and every dismiss path releases it', async () => {
  await withClient(async ({ board, dialogFocus, flush }) => {
    document.body.innerHTML = '';
    const { workspace, handle, title } = openWorkspace(dialogFocus);
    let workspaceEscapes = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') workspaceEscapes++; }); // template.html's closer

    for (const dismiss of ['cancel', 'backdrop', 'escape']) {
      title.focus();
      board.showConfirmModal('T508', 'pending', 'in_progress', null);
      await flush();
      const overlay = document.querySelector('.modal-overlay');
      assert.ok(overlay.classList.contains('modal-overlay--over-modal'), 'stacks above .task-edit-overlay');
      assert.equal(overlay.querySelector('[role="alertdialog"]')?.getAttribute('aria-modal'), 'true');
      assert.notEqual(overlay.inert, true, `${dismiss}: confirm must not be inerted by the workspace layer`);
      assert.equal(workspace.inert, true);
      assert.equal(document.activeElement, overlay.querySelector('.btn-cancel'));
      if (dismiss === 'cancel') overlay.querySelector('.btn-cancel').click();
      else if (dismiss === 'backdrop') overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      else escape();
      await flush();
      assert.equal(document.querySelector('.modal-overlay'), null, `${dismiss} removes the confirm`);
      assert.notEqual(workspace.inert, true, `${dismiss}: workspace interactive again`);
      assert.equal(handle.isTop(), true);
      assert.equal(document.activeElement, title, `${dismiss}: focus returns to the workspace`);
    }
    assert.equal(workspaceEscapes, 0, 'Escape on the confirm never reaches the workspace closer');
  });
});

test('status-change confirm without a workspace uses the board tier', async () => {
  await withClient(async ({ board, flush }) => {
    document.body.innerHTML = '<button id="card-btn">card</button>';
    board.showConfirmModal('T508', 'pending', 'in_progress', null);
    await flush();
    const overlay = document.querySelector('.modal-overlay');
    assert.ok(overlay.classList.contains('modal-overlay--over-board'));
    assert.equal(document.getElementById('card-btn').inert, true);
    overlay.querySelector('.btn-cancel').click();
    await flush();
    assert.notEqual(document.getElementById('card-btn').inert, true);
  });
});

test('Settings is interactive over the workspace and closing it restores the workspace', async () => {
  await withClient(async ({ board, dialogFocus, actionConfirm, flush }) => {
    document.body.innerHTML = '';
    const { workspace, handle, title } = openWorkspace(dialogFocus);
    document.body.insertAdjacentHTML('beforeend', `<div id="settings-modal" role="dialog" aria-modal="true">
      <div class="settings-panel"><button class="settings-close" type="button">x</button>
        <div class="modal-tabs"><button class="modal-tab-btn active" data-tab="general">General</button>
          <button class="modal-tab-btn" data-tab="voice">Voice</button></div>
        <div class="settings-body modal-tab-panel" data-tab="general"><select id="settings-theme-select"></select></div>
        <div class="settings-body modal-tab-panel" data-tab="voice" hidden></div></div></div>`);
    let workspaceEscapes = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') workspaceEscapes++; });
    board.initSettingsModal();
    const modal = document.getElementById('settings-modal');

    for (const dismiss of ['close', 'escape', 'backdrop']) {
      title.focus();
      board.openSettingsModal();
      board.openSettingsModal(); // a repeated ⌘, must not stack a second layer
      await flush();
      assert.ok(modal.classList.contains('settings-modal--over-modal'), 'stacks above .task-edit-overlay');
      assert.notEqual(modal.inert, true, `${dismiss}: Settings must not be inerted by the workspace layer`);
      assert.equal(workspace.inert, true);
      assert.equal(document.activeElement, modal.querySelector('.modal-tab-btn.active'));
      modal.querySelector('.modal-tab-btn[data-tab="voice"]').click();
      assert.equal(modal.querySelector('.modal-tab-panel[data-tab="voice"]').hidden, false, 'tabs respond');
      modal.querySelector('.modal-tab-btn[data-tab="general"]').click();
      if (dismiss === 'close') modal.querySelector('.settings-close').click();
      else if (dismiss === 'backdrop') modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      else escape();
      await flush();
      assert.equal(modal.classList.contains('open'), false, `${dismiss} closes Settings`);
      assert.equal(modal.classList.contains('settings-modal--over-modal'), false);
      assert.notEqual(workspace.inert, true, `${dismiss}: one close releases the single layer`);
      assert.equal(handle.isTop(), true);
      assert.equal(document.activeElement, title, `${dismiss}: focus returns to the workspace`);
    }
    assert.equal(workspaceEscapes, 0, 'Escape on Settings never reaches the workspace closer');

    // A confirm opened from Settings takes Escape first; Settings stays open beneath it.
    board.openSettingsModal();
    await flush();
    const pending = actionConfirm.showActionConfirm({ message: 'Delete?' });
    await flush();
    assert.equal(modal.inert, true, 'Settings yields to the confirm above it');
    escape();
    assert.equal(await pending, false);
    await flush();
    assert.equal(modal.classList.contains('open'), true, 'Escape closed only the confirm');
    assert.notEqual(modal.inert, true);
    board.closeSettingsModal();
    await flush();
    assert.notEqual(workspace.inert, true);
  });
});

test('generic action confirm is interactive over the workspace on every resolve path', async () => {
  await withClient(async ({ actionConfirm, dialogFocus, flush }) => {
    document.body.innerHTML = '';
    const { workspace, handle, title } = openWorkspace(dialogFocus);
    for (const [dismiss, expected] of [['cancel', false], ['confirm', true], ['backdrop', false], ['escape', false]]) {
      title.focus();
      const result = actionConfirm.showActionConfirm({ message: 'Discard?', overlayClass: 'modal-overlay--over-modal' });
      await flush();
      const overlay = document.querySelector('.modal-overlay--over-modal');
      assert.notEqual(overlay.inert, true);
      assert.equal(workspace.inert, true);
      if (dismiss === 'cancel') overlay.querySelector('.btn-cancel').click();
      else if (dismiss === 'confirm') overlay.querySelector('.btn-confirm').click();
      else if (dismiss === 'backdrop') overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      else escape();
      assert.equal(await result, expected, dismiss);
      await flush();
      assert.notEqual(workspace.inert, true, `${dismiss}: layer released`);
      assert.equal(handle.isTop(), true);
      assert.equal(document.activeElement, title);
    }
  });
});

// (TPT561) Project ▸ Open / Create Project… on an unconfigured folder while a task is open.
test('project creation wizard is interactive over the workspace on every step', async () => {
  await withClient(async ({ wizard, dialogFocus, window, flush }) => {
    document.body.innerHTML = '';
    const { workspace, handle, title } = openWorkspace(dialogFocus);
    let workspaceEscapes = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') workspaceEscapes++; });
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Sign-in step (no stored account): the Sign in button responds.
    window.electronAPI = {};
    title.focus();
    wizard.open({ projectPath: '/tmp/new-project' });
    await flush();
    const root = document.querySelector('.wizard-modal');
    assert.notEqual(root.inert, true, 'wizard must not be inerted by the workspace layer');
    assert.equal(workspace.inert, true);
    assert.ok(root.contains(document.activeElement), 'focus moves into the wizard');
    root.querySelector('#wiz-signin-btn').click();
    await flush();
    assert.notEqual(root.querySelector('#wiz-auth-msg').textContent, '', 'Sign in click handled');
    escape();
    await flush();
    assert.equal(document.querySelector('.wizard-modal'), null, 'Escape closes the wizard');
    assert.notEqual(workspace.inert, true);
    assert.equal(handle.isTop(), true);
    assert.equal(document.activeElement, title, 'focus returns to the workspace');

    // Signed-in run: step changes repaint the same root, which stays interactive.
    window.electronAPI = {
      setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@example.com' } }),
      setupListProjects: async () => [{ id: 7, name: 'Seven' }],
    };
    wizard.open({ projectPath: '/tmp/new-project' });
    await wait(30);
    const root2 = document.querySelector('.wizard-modal');
    const card = root2.querySelector('.setup-modal-project-card[data-id="7"]');
    assert.ok(card, 'step 2 project list rendered');
    card.click();
    const next = root2.querySelector('#wiz-next-btn');
    assert.equal(next.disabled, false, 'project card click enables Next');
    next.click();
    await flush();
    assert.equal(document.querySelector('.wizard-modal'), root2, 'repaint keeps one overlay root');
    assert.notEqual(root2.inert, true, 'step 3 still interactive');
    const device = root2.querySelector('#wiz-device-input');
    device.value = 'Laptop';
    device.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(root2.querySelector('#wiz-next-btn').disabled, false, 'input responds');
    root2.querySelector('#wiz-back-btn').click();
    await wait(30);
    assert.ok(root2.querySelector('.setup-modal-project-card'), 'Back returns to step 2');
    assert.notEqual(root2.inert, true);
    assert.equal(workspace.inert, true);
    root2.querySelector('.setup-modal-close').click();
    await flush();
    assert.equal(document.querySelector('.wizard-modal'), null);
    assert.notEqual(workspace.inert, true, 'close releases the wizard layer');
    assert.equal(handle.isTop(), true);
    assert.equal(workspaceEscapes, 0, 'Escape on the wizard never reaches the workspace closer');
  });
});

test('setup / re-auth modal is interactive over the workspace and every dismiss path releases it', async () => {
  await withClient(async ({ setupModal, dialogFocus, window, flush }) => {
    document.body.innerHTML = '';
    const { workspace, handle, title } = openWorkspace(dialogFocus);
    let workspaceEscapes = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') workspaceEscapes++; });
    window.electronAPI = {
      setupAuthWeb: async () => ({ token: 'tok', user: { email: 'a@example.com' } }),
      setupListProjects: async () => [{ id: 1, name: 'One' }],
      setupGetAvailableAgents: async () => [{ id: 'claude', name: 'Claude Code', available: true }],
    };
    for (const dismiss of ['cancel', 'escape', 'close']) {
      title.focus();
      let cancelled = 0;
      setupModal.openReauth({
        projectPath: '/tmp/project', existingConfig: { API_PROJECT_ID: '1' },
        onComplete: () => {}, onCancel: () => { cancelled++; },
      });
      await flush();
      const root = document.querySelector('.setup-modal');
      assert.notEqual(root.inert, true, `${dismiss}: re-auth must not be inerted by the workspace layer`);
      assert.equal(workspace.inert, true);
      assert.ok(root.contains(document.activeElement));
      if (dismiss === 'cancel') root.querySelector('#setup-cancel-btn').click();
      else if (dismiss === 'escape') escape();
      else {
        // Sign in → skips the known project → Agent step, repainted on the same root.
        root.querySelector('#setup-signin-btn').click();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(document.querySelector('.setup-modal'), root, 'repaint keeps one overlay root');
        assert.ok(root.querySelector('#setup-agent-select'), 'Sign in advanced to the Agent step');
        assert.notEqual(root.inert, true);
        root.querySelector('.setup-modal-close').click();
      }
      await flush();
      assert.equal(document.querySelector('.setup-modal'), null, `${dismiss} removes the modal`);
      assert.equal(cancelled, 1, `${dismiss}: onCancel fired`);
      assert.notEqual(workspace.inert, true, `${dismiss}: workspace interactive again`);
      assert.equal(handle.isTop(), true);
      assert.equal(document.activeElement, title, `${dismiss}: focus returns to the workspace`);
    }
    assert.equal(workspaceEscapes, 0, 'Escape on the modal never reaches the workspace closer');
  });
});

test('task-board.js overlays reachable over the workspace own a dialog-focus layer', () => {
  const src = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
  const body = (name) => {
    const start = src.indexOf(`export function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    const end = src.indexOf('\nexport ', start + 10);
    return src.slice(start, end === -1 ? src.length : end);
  };
  assert.match(body('openSettingsModal'), /activateDialogFocus\(/);
  assert.match(body('closeSettingsModal'), /_settingsFocus\?\.close\(\)/);
  assert.match(body('showConfirmModal'), /activateDialogFocus\(/);
  assert.match(body('showConfirmModal'), /focusHandle\.close\(\)/);
});
