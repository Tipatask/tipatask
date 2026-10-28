import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9169) setup-modal.js import mode (Project ▸ Import…) driven in happy-dom with the real
// module, the real i18n tables and the real dialog-focus layer; only electronAPI is stubbed.
// Covers the step walk and what reaches main, keyboard use (initial focus per step, Enter, Tab
// staying inside the dialog, Escape), that every way of cancelling creates nothing, and that
// both locales render. Same bundling harness as setup-modal-agent.test.js.
async function withModal(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-setup-modal-import-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  window.electronAPI = electronAPI;
  // dialog-focus.js only cycles through elements that have a layout box.
  window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 10, height: 10 }] : []; };
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ([]) }));
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as modal from './src/client/setup-modal.js'; export * as i18n from './src/client/i18n.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'setup-modal.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { modal, i18n } = await import(pathToFileURL(bundle).href);
    const flush = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
    try { await run({ modal, i18n, flush }); } finally { modal.close(); i18n.setLocale('en'); }
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const overlay = () => document.querySelector('.setup-modal');
const $ = (sel) => overlay()?.querySelector(sel) || null;
const key = (k, opts = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: false, reason: 'pi not found' },
];

const SUMMARY = {
  projectName: 'Acme', exportedAt: '2026-10-28T09:00:00.000Z', taskCount: 12, sprintCount: 3, kbFileCount: 5,
  kbFiles: ['CLAUDE.md', 'ai/architecture/GENERAL.md'],
};

// electronAPI with a stored account, two agents and a folder that already has KB files.
function stubApi(overrides = {}) {
  const log = { checks: [], runs: [], cancels: [], progress: null };
  const api = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'dev@example.test' } }),
    setupGetAvailableAgents: async () => AGENTS,
    selectFolder: async () => '/work/acme',
    checkImportFolder: async (importId, folder) => {
      log.checks.push([importId, folder]);
      return { ok: true, folder, blocked: null, architectureFiles: 3, existingKbFiles: ['CLAUDE.md'] };
    },
    onProjectImportProgress: (cb) => { log.progress = cb; return () => { log.progress = null; }; },
    importProjectFromWizard: async (detail) => {
      log.runs.push(detail);
      log.progress?.({ importId: detail.importId, step: 'tasks', done: 4, total: 12 });
      return { ok: true, projectPath: detail.projectPath, projectId: 9, opened: 'new', report: { tasks: 12, sprints: 3, kbWritten: 4 } };
    },
    cancelProjectImport: async (importId) => { log.cancels.push(importId); return true; },
    ...overrides,
  };
  return { api, log };
}

function openImport(modal, extra = {}) {
  const calls = { complete: [], cancel: 0 };
  modal.openImport({
    importId: 'imp-1',
    archiveName: 'acme-export.zip',
    summary: SUMMARY,
    onComplete: (detail) => calls.complete.push(detail),
    onCancel: () => { calls.cancel += 1; },
    ...extra,
  });
  return calls;
}

async function toAgentStep(flush) {
  $('#setup-next-btn').click(); // Name → Folder
  $('#setup-import-folder-btn').click();
  await flush();
  $('#setup-next-btn').click(); // Folder → Agent
  await flush(); // agent detection
}

test('import: Name → Folder → Agent → Confirm, then main gets the picks and the wizard reports the result', async () => {
  const { api, log } = stubApi();
  await withModal(api, async ({ modal, flush }) => {
    const calls = openImport(modal);
    await flush(); // stored account → Sign-in skipped
    assert.equal(overlay().querySelector('.setup-modal-title').textContent, 'Import Project');
    assert.equal(overlay().querySelectorAll('.setup-modal-dot').length, 5);

    // Name: the archive card and the exported name, editable.
    assert.equal($('.setup-modal-archive-name').textContent, 'acme-export.zip');
    assert.equal($('.setup-modal-archive-meta').textContent, 'Exported from “Acme” on Oct 28, 2026');
    assert.deepEqual([...overlay().querySelectorAll('.setup-modal-archive-count')].map((el) => el.textContent),
      ['12 tasks', '3 sprints', '5 knowledge base files']);
    const name = $('#setup-import-name');
    assert.equal(name.value, 'Acme');
    name.value = 'Acme Two';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    $('#setup-next-btn').click();

    // Folder: nothing picked yet → Next disabled; a pick runs main's check and shows the warning.
    assert.equal($('#setup-next-btn').disabled, true);
    $('#setup-import-folder-btn').click();
    await flush();
    assert.deepEqual(log.checks, [['imp-1', '/work/acme']]);
    assert.equal($('#setup-import-folder-path').textContent, '/work/acme');
    assert.equal(overlay().querySelector('.setup-modal-header-path').dataset.path, '/work/acme', 'the header names the folder');
    const msg = $('#setup-import-folder-msg');
    assert.ok(msg.classList.contains('setup-modal-msg--warning'));
    assert.equal(msg.textContent, 'This folder already contains 3 files in ai/architecture. Files already in the folder are kept, so 1 file from the archive is not written: CLAUDE.md.');
    assert.equal($('#setup-next-btn').disabled, false);
    $('#setup-next-btn').click();
    await flush();

    // Agent: the shared picker; Next validates as everywhere else.
    assert.ok($('#setup-agent-select .sma-cb[data-id="codex"]'));
    $('#setup-next-btn').click();

    // Confirm: archive contents, the new project, the folder and the kept files.
    const rows = Object.fromEntries([...overlay().querySelectorAll('.setup-modal-summary tr')]
      .map((tr) => [tr.querySelector('.setup-modal-summary-key').textContent, tr.querySelector('.setup-modal-summary-val').textContent]));
    assert.deepEqual(rows, {
      Archive: 'acme-export.zip',
      Folder: '/work/acme',
      Account: 'dev@example.test',
      Project: 'Acme Twonew',
      'Knowledge base': '5 files · 1 kept from the folder',
      Tasks: '12',
      Sprints: '3',
      Agent: 'Claude Code',
    });
    assert.equal($('#setup-confirm-btn').textContent, 'Import Project');
    $('#setup-confirm-btn').click();
    await flush(0);
    assert.equal(log.runs.length, 1);
    assert.deepEqual(log.runs[0], {
      importId: 'imp-1',
      projectName: 'Acme Two',
      projectPath: '/work/acme',
      apiBaseUrl: 'https://web.tipatask.com',
      userToken: 'tok',
      agentPreference: { taskAgent: 'claude', availableAgents: ['claude', 'codex'], piModels: [] },
    });
    assert.equal($('#setup-confirm-msg').textContent, 'Import complete ✓');
    assert.equal(log.progress, null, 'the progress listener is removed once the import answered');
    await flush(400); // the 300ms close hand-off
    assert.equal(overlay(), null);
    assert.deepEqual(calls.complete, [{ projectPath: '/work/acme', projectName: 'Acme Two', opened: 'new', report: { tasks: 12, sprints: 3, kbWritten: 4 } }]);
    assert.equal(calls.cancel, 0);
    assert.deepEqual(log.cancels, [], 'a completed import is not released');
  });
});

test('import: progress frames show while the import runs; Escape and × cannot abandon it', async () => {
  let finish;
  const { api, log } = stubApi({
    importProjectFromWizard: (detail) => new Promise((resolve) => {
      log.runs.push(detail);
      finish = resolve;
    }),
  });
  await withModal(api, async ({ modal, flush }) => {
    const calls = openImport(modal);
    await flush();
    await toAgentStep(flush);
    $('#setup-next-btn').click();
    $('#setup-confirm-btn').click();
    assert.equal($('#setup-confirm-msg').textContent, 'Creating the project…');
    log.progress({ importId: 'imp-1', step: 'tasks', done: 4, total: 12 });
    assert.equal($('#setup-confirm-msg').textContent, 'Importing tasks: 4 of 12…');
    log.progress({ importId: 'someone-else', step: 'kb' });
    assert.equal($('#setup-confirm-msg').textContent, 'Importing tasks: 4 of 12…', 'another import\'s frame is ignored');
    assert.equal($('#setup-confirm-btn').disabled, true);
    assert.equal($('#setup-back-btn').disabled, true);

    key('Escape');
    $('.setup-modal-close').click();
    assert.ok(overlay(), 'still open while the import runs');

    finish({ ok: false, code: 'import', step: 'tasks', error: 'API unreachable', removed: true });
    await flush(0);
    const msg = $('#setup-confirm-msg');
    assert.ok(msg.classList.contains('setup-modal-msg--error'));
    assert.equal(msg.textContent, 'The import stopped at “Tasks” (API unreachable). The partly imported project was removed, so you can import the archive again.');
    assert.equal($('#setup-confirm-btn').disabled, false, 'a retry goes into a new project');
    assert.equal($('#setup-back-btn').disabled, false);

    key('Escape');
    assert.equal(overlay(), null, 'Escape closes again once the import ended');
    assert.equal(calls.cancel, 1);
    assert.deepEqual(log.cancels, ['imp-1']);
  });
});

test('import: Cancel, × and Escape create nothing and release the pending import', async () => {
  for (const how of ['cancel-button', 'close-x', 'escape-on-folder', 'escape-on-confirm']) {
    const { api, log } = stubApi();
    if (how === 'cancel-button') delete api.setupStoredAccount;
    await withModal(api, async ({ modal, flush }) => {
      const calls = openImport(modal);
      await flush();
      if (how === 'cancel-button') {
        // No stored account: the wizard starts on Sign-in, whose only footer button is Cancel.
        assert.ok($('#setup-signin-btn'));
        $('#setup-cancel-btn').click();
      } else if (how === 'close-x') {
        $('.setup-modal-close').click();
      } else if (how === 'escape-on-folder') {
        $('#setup-next-btn').click();
        $('#setup-import-folder-btn').click();
        await flush();
        key('Escape');
      } else {
        await toAgentStep(flush);
        $('#setup-next-btn').click();
        assert.ok($('#setup-confirm-btn'));
        key('Escape');
      }
      assert.equal(overlay(), null, `${how}: closed`);
      assert.equal(calls.cancel, 1, `${how}: onCancel once`);
      assert.deepEqual(calls.complete, [], `${how}: nothing completed`);
      assert.deepEqual(log.runs, [], `${how}: project:import-from-wizard never called`);
      assert.deepEqual(log.cancels, ['imp-1'], `${how}: the pending import is released`);
    });
  }
});

test('import: the steps work from the keyboard', async () => {
  const { api, log } = stubApi();
  await withModal(api, async ({ modal, flush }) => {
    openImport(modal);
    await flush();
    // Name: the input has focus and Enter moves on.
    const name = $('#setup-import-name');
    assert.equal(document.activeElement, name);
    key('Enter');
    assert.ok($('#setup-import-folder-btn'), 'Enter on the name went to the Folder step');

    // Folder: Choose Folder has focus; once the folder checks out, focus moves to Next.
    assert.equal(document.activeElement, $('#setup-import-folder-btn'));
    $('#setup-import-folder-btn').click();
    await flush();
    assert.equal(document.activeElement, $('#setup-next-btn'));

    // Tab stays inside the dialog: from the last control it wraps to the first.
    key('Tab');
    assert.ok(overlay().contains(document.activeElement), 'Tab from Next stays in the wizard');
    const controls = [...overlay().querySelectorAll('button, input')].filter((el) => !el.disabled);
    assert.equal(document.activeElement, controls[0], 'wrapped to the first control (the header ×)');
    key('Tab', { shiftKey: true });
    assert.equal(document.activeElement, controls[controls.length - 1], 'Shift+Tab wraps back to Next');

    // Every control on these steps is a native button or input — keyboard-operable as is.
    for (const el of overlay().querySelectorAll('[id^="setup-"]')) {
      if (el.matches('div, p, span, table, label')) continue;
      assert.ok(el.matches('button, input'), `${el.id} is a native control`);
    }

    // Back from the Folder step returns to the name, focused again with the typed value kept.
    $('#setup-back-btn').click();
    assert.equal(document.activeElement, $('#setup-import-name'));
    assert.equal($('#setup-import-name').value, 'Acme');

    // An emptied name blocks Next (Enter does nothing).
    $('#setup-import-name').value = '  ';
    $('#setup-import-name').dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal($('#setup-next-btn').disabled, true);
    key('Enter');
    assert.ok($('#setup-import-name'), 'still on the Name step');
    assert.deepEqual(log.runs, []);
  });
});

test('import: a folder that is already a project is refused, Next stays disabled and focus stays on Choose Folder', async () => {
  const { api } = stubApi({
    checkImportFolder: async (importId, folder) => ({ ok: true, folder, blocked: 'configured', architectureFiles: 0, existingKbFiles: [] }),
  });
  await withModal(api, async ({ modal, flush }) => {
    openImport(modal);
    await flush();
    $('#setup-next-btn').click();
    $('#setup-import-folder-btn').click();
    await flush();
    const msg = $('#setup-import-folder-msg');
    assert.ok(msg.classList.contains('setup-modal-msg--error'));
    assert.equal(msg.textContent, 'This folder already belongs to a TipΔTask project. Choose another folder.');
    assert.equal($('#setup-next-btn').disabled, true);
    assert.equal(document.activeElement, $('#setup-import-folder-btn'));
    assert.equal($('#setup-import-folder-btn').textContent, 'Change Folder…');
  });
});

test('import: the wizard renders in Ukrainian too', async () => {
  const { api } = stubApi();
  await withModal(api, async ({ modal, i18n, flush }) => {
    i18n.setLocale('uk');
    openImport(modal);
    await flush();
    assert.equal(overlay().querySelector('.setup-modal-title').textContent, 'Імпорт проєкту');
    assert.deepEqual([...overlay().querySelectorAll('.setup-modal-dot')].map((d) => d.title),
      ['Вхід', 'Назва', 'Папка', 'Агент', 'Підтвердження'].map((label) => i18n.LOCALES.uk[{
        'Вхід': 'setup.stepSignIn', 'Назва': 'import.stepName', 'Папка': 'import.stepFolder', 'Агент': 'setup.stepAgent', 'Підтвердження': 'setup.stepConfirm',
      }[label]]));
    assert.deepEqual([...overlay().querySelectorAll('.setup-modal-archive-count')].map((el) => el.textContent),
      ['12 задач', '3 спринти', '5 файлів бази знань']);
    assert.match($('.setup-modal-archive-meta').textContent, /^Експортовано з «Acme» 28/);
    assert.equal($('#setup-next-btn').textContent, i18n.LOCALES.uk['common.next']);
    $('#setup-next-btn').click();
    assert.equal($('#setup-import-folder-btn').textContent, 'Вибрати папку…');
    $('#setup-import-folder-btn').click();
    await flush();
    assert.equal($('#setup-import-folder-msg').textContent,
      'У цій папці вже є 3 файли в ai/architecture. Файли, що вже є в папці, залишаться, тож 1 файл з архіву не буде записано: CLAUDE.md.');
    $('#setup-next-btn').click();
    await flush();
    $('#setup-next-btn').click();
    assert.equal($('#setup-confirm-btn').textContent, 'Імпортувати проєкт');
    assert.ok([...overlay().querySelectorAll('.setup-modal-summary-key')].some((el) => el.textContent === 'База знань'));
  });
});
