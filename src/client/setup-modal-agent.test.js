import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT678) setup-modal.js's Agent step (open existing folder / re-authenticate) driven in happy-dom
// with the real module: with every agent unchecked there is no Default, so Next answers
// "Select a default agent." and stays; Confirm saves exactly the agents picked, never a 'claude'
// fallback. Same bundling harness as project-creation-wizard-locked.test.js; electronAPI is
// stubbed per test.
async function withModal(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-setup-modal-agent-'));
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
      stdin: { contents: `export * as modal from './src/client/setup-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'setup-modal.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { modal } = await import(pathToFileURL(bundle).href);
    const flush = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
    try { await run({ modal, flush }); } finally { modal.close(); }
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
const $ = (sel) => overlay().querySelector(sel);

const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: false, reason: 'pi not found' },
];

function toggle(id, checked) {
  const cb = $(`.sma-cb[data-id="${id}"]`);
  cb.checked = checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}

function summaryAgent() {
  const row = [...overlay().querySelectorAll('.setup-modal-summary tr')]
    .find((tr) => tr.querySelector('.setup-modal-summary-key')?.textContent === 'Agent');
  return row?.querySelector('.setup-modal-summary-val').textContent;
}

// Uncheck every agent → blocked Next with the message; re-check Codex → it is the Default, the
// message clears and Next reaches Confirm showing Codex.
function assertEmptyDefaultBlocked() {
  toggle('claude', false);
  toggle('codex', false);
  assert.equal($('#setup-next-btn').disabled, false, 'Next stays enabled');
  $('#setup-next-btn').click();
  assert.equal($('#setup-agent-msg').textContent, 'Select a default agent.', 'nothing enabled: Next answers and stays');
  assert.ok($('#setup-agent-select'), 'still on the Agent step');

  toggle('codex', true);
  assert.equal($('.sma-radio[data-id="codex"]').checked, true, 'Codex took the empty Default');
  assert.equal($('#setup-agent-msg').textContent, '', 'the edit cleared the message');
  $('#setup-next-btn').click();
  assert.equal($('#setup-agent-select'), null, 'left the Agent step');
  assert.equal(summaryAgent(), 'Codex', 'Confirm shows Codex');
}

test('open existing: no agent enabled blocks Next; Confirm saves only the re-checked agent', async () => {
  const saved = [];
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => AGENTS,
    setupExchangeProjectToken: async () => 'scoped', // marks the Electron save branch
    openExistingProject: async (detail) => { saved.push(detail); return { ok: true }; },
  };
  await withModal(electronAPI, async ({ modal, flush }) => {
    modal.open({ projectPath: '/tmp/p' });
    await flush();
    $('.setup-modal-project-card[data-id="7"]').click();
    $('#setup-next-btn').click();
    await flush(); // device-name prefill
    $('#setup-next-btn').click();
    await flush(); // agent detection
    assert.ok($('#setup-agent-select .sma-cb[data-id="codex"]'), 'on the Agent step');

    assertEmptyDefaultBlocked();

    $('#setup-confirm-btn').click();
    await flush(400); // save + the 300ms close hand-off
    assert.equal(saved.length, 1);
    assert.equal(saved[0].taskAgent, 'codex');
    assert.deepEqual(saved[0].availableAgents, ['codex'], 'no invented claude');
  });
});

test('re-authenticate: no agent enabled blocks Next; Confirm saves only the re-checked agent', async () => {
  const saved = [];
  const electronAPI = {
    setupAuthWeb: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetAvailableAgents: async () => AGENTS,
    setupExchangeProjectToken: async () => 'scoped',
    api: { auth: { reauthSave: async (cfg) => { saved.push(cfg); return { ok: true }; } } },
  };
  await withModal(electronAPI, async ({ modal, flush }) => {
    modal.openReauth({
      projectPath: '/tmp/p',
      existingConfig: { API_PROJECT_ID: '7', projectName: 'Proj', TASK_AGENT: 'claude', AVAILABLE_AGENTS: 'claude,codex' },
    });
    await flush();
    $('#setup-signin-btn').click();
    await flush(500); // sign-in → 400ms hand-off straight to Agent (project already known)
    await flush(); // agent detection
    assert.ok($('#setup-agent-select .sma-cb[data-id="codex"]'), 'on the Agent step');

    assertEmptyDefaultBlocked();

    $('#setup-confirm-btn').click();
    await flush(400); // save + the 300ms close hand-off
    assert.equal(saved.length, 1);
    assert.equal(saved[0].TASK_AGENT, 'codex');
    assert.equal(saved[0].AVAILABLE_AGENTS, 'codex', 'the old claude entry is not carried over');
  });
});
