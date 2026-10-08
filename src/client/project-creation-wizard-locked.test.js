import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT564) The wizard's locked first-run mode, driven in happy-dom with the real module.
// Same bundling harness as dialog-focus.test.js; electronAPI is stubbed per test.
async function withWizard(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-wizard-locked-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  window.electronAPI = electronAPI;
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ([]) }));
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as wizard from './src/client/project-creation-wizard.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'wizard.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { wizard } = await import(pathToFileURL(bundle).href);
    const flush = () => new Promise(resolve => setTimeout(resolve, 20));
    try { await run({ wizard, flush }); } finally { wizard.close(); }
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function escape() {
  const target = document.activeElement || document.body;
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

const overlay = () => document.querySelector('.wizard-modal');

test('locked: Escape keeps the wizard open, no ×, backdrop click does nothing, Cancel calls onCancel', async () => {
  await withWizard({}, async ({ wizard, flush }) => {
    let cancels = 0;
    wizard.open({ projectPath: '/tmp/p', locked: true, onCancel: () => { cancels += 1; } });
    await flush();
    assert.ok(overlay(), 'wizard rendered');
    assert.equal(overlay().querySelector('.setup-modal-close'), null, 'no × in locked mode');
    const e = escape();
    assert.equal(e.defaultPrevented, true);
    assert.ok(overlay(), 'Escape keeps the wizard');
    overlay().querySelector('.setup-modal-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(overlay(), 'backdrop click keeps the wizard');
    assert.equal(cancels, 0);
    overlay().querySelector('#wiz-cancel-btn').click();
    assert.equal(overlay(), null, 'Cancel closes the wizard');
    assert.equal(cancels, 1, 'Cancel hands control back through onCancel');
  });
});

test('locked: Escape on a later step (signed in, Create Project) keeps the wizard open', async () => {
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [],
  };
  await withWizard(electronAPI, async ({ wizard, flush }) => {
    let cancels = 0;
    wizard.open({ projectPath: '/tmp/p', locked: true, onCancel: () => { cancels += 1; } });
    await flush();
    assert.ok(overlay().querySelector('#wiz-proj-list'), 'stored account moved the wizard to step 2');
    escape();
    assert.ok(overlay(), 'Escape on step 2 keeps the wizard');
    assert.ok(overlay().querySelector('#wiz-proj-list'), 'still on step 2');
    assert.equal(overlay().querySelector('.setup-modal-close'), null, 'no × on later steps either');
    assert.equal(cancels, 0);
  });
});

test('unlocked: × is present and Escape closes the wizard through onCancel', async () => {
  await withWizard({}, async ({ wizard, flush }) => {
    let cancels = 0;
    wizard.open({ projectPath: '/tmp/p', onCancel: () => { cancels += 1; } });
    await flush();
    assert.ok(overlay().querySelector('.setup-modal-close'), '× shown for a bound window');
    escape();
    assert.equal(overlay(), null, 'Escape closes the wizard');
    assert.equal(cancels, 1);
  });
});
