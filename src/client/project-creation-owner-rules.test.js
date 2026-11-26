import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9409) A new project's own policy rules: the creator sets them in the policy dialog on the
// wizard's profile step, the confirm step lists them with the company mandates, and
// project:create-from-wizard (main.js, run in a vm) saves them once the project exists — a
// refused save is reported, never a failed creation. Same bundling harness as
// project-creation-wizard-locked.test.js.
async function withWizard(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-wizard-owner-rules-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator', 'FileReader']) install(key, window[key]);
  install('Image', class { naturalWidth = 1; naturalHeight = 1; async decode() {} });
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

const api = () => ({
  setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
  setupListProjects: async () => [{ id: 7, name: 'Proj' }],
  setupGetDeviceName: async () => 'Mac',
  setupGetAvailableAgents: async () => [{ id: 'claude', label: 'Claude Code', available: true }],
  setupProjectProfile: async () => ({ policy: { company: { name: 'Atlas' }, rules: { language: { value: 'uk', source: 'company' } } } }),
});
const overlay = () => document.querySelector('.wizard-modal');

test('the creator sets the new project’s rules in the policy dialog; confirm lists them and the detail carries them', async () => {
  let detail = null;
  await withWizard(api(), async ({ wizard, flush }) => {
    wizard.open({ projectPath: '/tmp/p', presetLocked: true, onComplete: d => { detail = d; } });
    await flush();
    const $ = selector => overlay().querySelector(selector);
    $('#wiz-new-card').click();
    $('#wiz-proj-name').value = 'Fresh';
    $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    const row = $('.setup-modal-owner-rules');
    assert.equal(row.hidden, false, 'a new project offers its own rules');
    assert.match(row.textContent, /Project owner rules/);
    assert.match($('#wiz-owner-rules-summary').textContent, /^None$/);

    $('#wiz-owner-rules-btn').click();
    const dialog = document.querySelector('.policy-modal');
    assert.ok(dialog, 'the policy dialog opens over the wizard');
    assert.match(dialog.querySelector('#policy-modal-company').textContent, /Atlas/);
    // Escape closes the dialog and leaves the wizard open.
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.policy-modal'), null);
    assert.ok(overlay(), 'the wizard stays open');

    $('#wiz-owner-rules-btn').click();
    const add = document.querySelector('.policy-modal [data-add]');
    add.value = 'sprint_sort_order';
    add.dispatchEvent(new Event('change', { bubbles: true }));
    const order = document.querySelector('.policy-modal [data-rule="sprint_sort_order"]');
    order.value = JSON.stringify('desc');
    order.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.policy-modal [data-save]').click();
    await flush();
    assert.equal(document.querySelector('.policy-modal'), null, 'Save closes the dialog');
    assert.equal($('#wiz-owner-rules-summary').textContent, 'Sprint order');
    assert.equal(document.activeElement === $('#wiz-owner-rules-btn'), true, 'focus stays on the row');

    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    $('[value="home"]').click();
    $('#wiz-next-btn').click();
    const rules = $('.project-rules').textContent;
    assert.match(rules, /Sprint order · Newest first \(Project owner\)/);
    assert.match(rules, /Atlas/);
    $('#wiz-confirm-btn').click();
  });
  assert.ok(detail, 'the wizard completed');
  assert.deepEqual(detail.apiProject.ownerRules, { sprint_sort_order: 'desc' });
  assert.deepEqual(detail.apiProject.settings, { sprint_sort_order: 'desc', language: 'uk' }, 'the project starts with the values its rules lock');
});

test('linking an existing project offers no creator rules', async () => {
  await withWizard({ ...api(), setupProjectProfile: async () => ({ policy: { rules: {} }, identity: {} }) }, async ({ wizard, flush }) => {
    wizard.open({ projectPath: '/tmp/p', presetLocked: true });
    await flush();
    const $ = selector => overlay().querySelector(selector);
    $('[data-id="7"]').click();
    $('#wiz-next-btn').click();
    await flush();
    assert.equal($('.setup-modal-owner-rules'), null);
    assert.equal($('.project-rules'), null, 'no empty policy block either');
  });
});

// The main-process half: the rules are saved after the project exists; a refusal is reported.
async function runCreateHandler(t, { saveProjectOwnerPolicy }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'tt-owner-rules-project-'));
  const userData = mkdtempSync(join(tmpdir(), 'tt-owner-rules-userdata-'));
  const savedUserData = process.env.TIPATASK_USER_DATA;
  process.env.TIPATASK_USER_DATA = userData;
  t.after(() => {
    if (savedUserData === undefined) delete process.env.TIPATASK_USER_DATA;
    else process.env.TIPATASK_USER_DATA = savedUserData;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });
  const require = createRequire(import.meta.url);
  const mainSrc = readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
  const start = mainSrc.indexOf("  ipcMain.handle('project:create-from-wizard'");
  const end = mainSrc.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start !== -1 && end > start, 'create-from-wizard handler found');
  const realSeeder = require('../server/project-seeder.js');
  const setup = {
    createApiProject: async ({ name }) => ({ id: 52, name, projectPresets: ['home'] }),
    saveProjectOwnerPolicy,
    registerDevice: async ({ name }) => ({ id: 9, name }),
    associateDeviceProject: async () => ({}),
    initializeProjectSettings: async () => {},
  };
  const modules = {
    './src/cli/setup': setup,
    './src/cli/auth': { exchangeProjectToken: async () => 'scoped-token' },
    './src/server/project-config': require('../server/project-config.js'),
    './src/server/project-seeder': { ...realSeeder, callSeedPresetTasks: async () => ({ seeded: 0, failed: 0 }) },
    './src/cli/knowledge-sync': { pushAll: async () => {}, pushArchitectureDocs: async () => {} },
  };
  let handler = null;
  vm.runInNewContext(mainSrc.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    require: id => { assert.ok(id in modules, `unexpected require(${id})`); return modules[id]; },
    getOrCreateMachineId: () => 'machine-1',
    writeProjectMeta: () => {},
    writeProjectMcpConfig: () => {},
    writeProjectSkillsConfig: () => {},
    writeProjectCodexConfig: () => {},
    console: { warn: () => {}, error: () => {}, log: () => {} },
  });
  return handler({}, {
    projectPath: projectDir, apiBaseUrl: 'https://api.example.test', userToken: 'user-token',
    apiProject: { isNew: true, name: 'Fresh', projectPresets: ['home'], identity: {}, settings: { sprint_sort_order: 'desc' },
      ownerRules: { sprint_sort_order: 'desc' } },
    deviceName: 'Mac', preset: null, agentPreference: { taskAgent: 'claude', availableAgents: ['claude'], piModels: [] },
  });
}

test('project:create-from-wizard saves the creator’s rules once the project exists', async (t) => {
  const calls = [];
  const res = await runCreateHandler(t, { saveProjectOwnerPolicy: async args => { calls.push(args); return {}; } });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.policyError, null);
  // The arguments come from the vm realm: compare their JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ apiBaseUrl: 'https://api.example.test', token: 'user-token', projectId: 52, rules: { sprint_sort_order: 'desc' } }]);
});

test('project:create-from-wizard reports refused rules without failing the creation', async (t) => {
  const res = await runCreateHandler(t, { saveProjectOwnerPolicy: async () => { throw new Error('Policy rules were not saved: policy_conflict (language)'); } });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.policyError, 'Policy rules were not saved: policy_conflict (language)');
});
