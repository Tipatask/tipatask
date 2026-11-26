import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT564) The wizard's locked first-run mode — and (TPT653) its Agent step's Default, (TPT9316)
// its A/B/C Preset step — driven in happy-dom with the real module. Same bundling harness as dialog-focus.test.js; electronAPI is
// stubbed per test.
async function withWizard(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-wizard-locked-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator', 'FileReader']) install(key, window[key]);
  // happy-dom supplies FileReader, but has no image decoder.
  install('Image', class { naturalWidth = 1; naturalHeight = 1; async decode() {} });
  window.electronAPI = { setupProjectProfile: async () => ({ policy: { rules: {} } }), ...electronAPI };
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

// (TPT653) Unchecking every agent leaves no Default, so Next answers "Select a default agent.";
// checking one again makes it the Default and Next goes on — no radio click in between.
test('Agent step: re-checking an agent after unchecking all makes it the Default, and Next goes on', async () => {
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => [
      { id: 'claude', label: 'Claude Code', available: true },
      { id: 'codex', label: 'Codex', available: true },
      { id: 'pi', label: 'Pi', available: false, reason: 'pi not found' },
    ],
  };
  await withWizard(electronAPI, async ({ wizard, flush }) => {
    wizard.open({ projectPath: '/tmp/p' });
    await flush();
    const $ = (sel) => overlay().querySelector(sel);
    $('.setup-modal-project-card[data-id="7"]').click();
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    $('#wiz-next-btn').click();
    await flush(); // device-name prefill
    $('#wiz-next-btn').click();
    await flush(); // agent detection
    assert.ok($('#wiz-agent-select .sma-cb[data-id="codex"]'), 'on the Agent step');

    const toggle = (id, checked) => {
      const cb = $(`.sma-cb[data-id="${id}"]`);
      cb.checked = checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    };
    toggle('claude', false);
    toggle('codex', false);
    assert.equal($('#wiz-next-btn').disabled, false);
    $('#wiz-next-btn').click();
    assert.equal($('#wiz-agent-msg').textContent, 'Select a default agent.', 'nothing enabled: Next answers and stays');

    toggle('codex', true);
    assert.equal($('.sma-radio[data-id="codex"]').checked, true, 'Codex took the empty Default');
    assert.equal($('#wiz-agent-msg').textContent, '');
    assert.equal($('#wiz-next-btn').disabled, false);
    $('#wiz-next-btn').click();
    assert.equal($('#wiz-agent-select'), null, 'left the Agent step');
    const agentRow = [...overlay().querySelectorAll('.setup-modal-summary tr')]
      .find((tr) => tr.querySelector('.setup-modal-summary-key')?.textContent === 'Agent');
    // (TPT9388) By the name its card showed, not the stored id `codex`.
    assert.equal(agentRow?.querySelector('.setup-modal-summary-val').textContent, 'Codex', 'Confirm shows Codex');
  });
});

// (TPT9388) Every step names itself beside the dots with "Step n of N" (following visibleSteps(),
// so a pick that adds or drops a step recounts at once) and opens with one heading block. Create
// Project opens its form right under its card; Confirm is one aligned summary, the project first.
test('every step names itself beside the dots and opens with one heading block', async () => {
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }, { id: 8, name: 'Other' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => [
      { id: 'claude', label: 'Claude Code', available: true },
      { id: 'codex', label: 'Codex', available: true },
    ],
  };
  await withWizard(electronAPI, async ({ wizard, flush }) => {
    wizard.open({ projectPath: '/tmp/p' });
    await flush();
    const $ = (sel) => overlay().querySelector(sel);
    const seen = [];
    const look = () => {
      const heads = overlay().querySelectorAll('.setup-modal-step-body .setup-modal-step-head');
      assert.equal(heads.length, 1, 'one heading block per step');
      const heading = heads[0].querySelector('h2.setup-modal-label#wiz-step-heading');
      assert.ok(heading?.textContent.trim(), 'the block holds the step heading');
      assert.ok([...overlay().querySelectorAll('.setup-modal-steps > .setup-modal-dot')].every((d) => d.getAttribute('aria-hidden') === 'true'));
      seen.push(`${$('.setup-modal-step-name').textContent} | ${$('.setup-modal-step-count').textContent}`);
    };

    look(); // Create Project, nothing picked yet
    $('.setup-modal-project-card[data-id="7"]').click();
    look(); // an existing project drops Work presets and Onboarding
    $('#wiz-new-card').click();
    look();
    const form = $('#wiz-create-form');
    assert.equal($('#wiz-new-card').nextElementSibling, form, 'the form opens right under its card');
    assert.ok(form.classList.contains('is-visible'));
    assert.equal(form.nextElementSibling.textContent, 'Existing projects');
    assert.ok(form.nextElementSibling.nextElementSibling.matches('.setup-modal-project-card[data-id="7"]'));
    assert.ok($('#wiz-proj-desc').matches('textarea.setup-modal-input.setup-modal-input--multiline'));
    assert.equal(overlay().querySelector('.setup-modal-textarea'), null);
    $('#wiz-proj-name').value = 'Fresh';
    $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#wiz-next-btn').click();
    await flush();
    look(); // identity and policy
    assert.ok($('.setup-modal-profile [data-preview]'), 'the profile renders under the heading block');
    $('#wiz-next-btn').click();
    await flush();
    look(); // device
    assert.equal($('#wiz-device-input').getAttribute('aria-labelledby'), 'wiz-step-heading');
    assert.equal($('#wiz-device-input').getAttribute('aria-describedby'), 'wiz-step-hint');
    assert.ok($('#wiz-step-hint').textContent.trim(), 'the device hint sits under the heading');
    $('#wiz-next-btn').click();
    await flush();
    look(); // agent
    $('#wiz-next-btn').click();
    look(); // work presets
    assert.ok($('.setup-modal-step-head #wiz-work-all'), 'Select all sits on the heading row');
    assert.equal($('.wizard-work-grid').getAttribute('aria-labelledby'), 'wiz-step-heading');
    $('[value="software"]').click();
    look(); // Software adds onboarding
    $('#wiz-next-btn').click();
    look(); // onboarding
    assert.equal($('#wiz-step-hint').textContent, 'No project description is needed here — the agents ask for what they need as they work.');
    $('.setup-modal-preset-card[data-letter="A"]').click();
    $('#wiz-next-btn').click();
    look(); // confirm

    const rows = [...overlay().querySelectorAll('.setup-modal-summary tr')];
    assert.ok(rows.every((tr) => tr.querySelector(':scope > th[scope="row"].setup-modal-summary-key')), 'every key is a row header');
    assert.equal(rows[0].querySelector('th').textContent, 'Project', 'the project leads');
    assert.equal(rows[0].querySelector('.setup-modal-summary-badge').textContent, 'new');
    assert.doesNotMatch(rows[0].textContent, /#new/, 'a new project has no id to show');
    const agent = rows.find((tr) => tr.querySelector('th').textContent === 'Agent');
    assert.equal(agent.querySelector('td').textContent, 'Claude Code');

    for (let i = 0; i < 7; i += 1) $('#wiz-back-btn').click();
    look(); // signed-in variant of Sign In
    assert.ok($('.setup-modal-step-body').classList.contains('setup-modal-step-body--center'), 'Sign in is centred');
    assert.ok($('.setup-modal-signin #wiz-step-heading'));

    assert.deepEqual(seen, [
      'Create Project | Step 2 of 7',
      'Create Project | Step 2 of 6',
      'Create Project | Step 2 of 7',
      'Project identity | Step 3 of 7',
      'Device | Step 4 of 7',
      'Agent | Step 5 of 7',
      'Work presets | Step 6 of 7',
      'Work presets | Step 6 of 8',
      'Onboarding | Step 7 of 8',
      'Confirm | Step 8 of 8',
      'Sign In | Step 1 of 8',
    ]);
  });
});

// (TPT9316) Preset step: three stacked toggle-button cards, A = compose the knowledge base as you
// go, then B/C (the two seeding presets). The pick shows on Confirm and lands in the
// wizard-complete detail as { letter, mode, value }.
const PRESET_EXPECTATIONS = [
  { letter: 'A', name: 'Compose the knowledge base as you go', preset: { letter: 'A', mode: 'compose', value: 'compose-as-you-go' } },
  { letter: 'B', name: 'Original Specification', preset: { letter: 'B', mode: 'new', value: 'original-specification' } },
  { letter: 'C', name: 'Existing Codebase', preset: { letter: 'C', mode: 'existing', value: 'existing-code' } },
];

for (const expected of PRESET_EXPECTATIONS) {
  test(`Preset step: picking ${expected.letter} shows "${expected.letter} — ${expected.name}" on Confirm and emits its value`, async () => {
    const electronAPI = {
      setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
      setupListProjects: async () => [{ id: 7, name: 'Proj' }],
      setupGetDeviceName: async () => 'Mac',
      setupGetAvailableAgents: async () => [{ id: 'claude', label: 'Claude Code', available: true }],
    };
    await withWizard(electronAPI, async ({ wizard, flush }) => {
      let detail = null;
      wizard.open({ projectPath: '/tmp/p', onComplete: (d) => { detail = d; } });
      await flush();
      const $ = (sel) => overlay().querySelector(sel);
      $('#wiz-new-card').click();
      $('#wiz-proj-name').value = 'Fresh';
      $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
      $('#wiz-next-btn').click();
      await flush(); // policy and identity
      $('#wiz-next-btn').click();
      await flush(); // device-name prefill
      $('#wiz-next-btn').click();
      await flush(); // agent detection
      $('#wiz-next-btn').click();

      $('[value="software"]').click();
      $('[value="science"]').click();
      $('#wiz-next-btn').click();
      const cards = [...overlay().querySelectorAll('.setup-modal-preset-grid > button.setup-modal-preset-card')];
      assert.deepEqual(cards.map((c) => c.querySelector('.setup-modal-preset-letter').textContent), ['A', 'B', 'C']);
      assert.deepEqual(cards.map((c) => c.querySelector('.setup-modal-preset-name').textContent),
        PRESET_EXPECTATIONS.map((p) => p.name));
      assert.ok(cards.every((c) => c.getAttribute('type') === 'button' && c.getAttribute('aria-pressed') === 'false'),
        'toggle buttons, none pressed on first paint');
      assert.equal($('#wiz-next-btn').disabled, true, 'Next waits for a pick');

      const card = cards.find((c) => c.dataset.letter === expected.letter);
      card.click();
      assert.equal(card.isConnected, true, 'selection updates in place (no repaint that would drop focus)');
      assert.deepEqual(cards.map((c) => c.getAttribute('aria-pressed')),
        cards.map((c) => String(c === card)));
      assert.deepEqual(cards.map((c) => c.classList.contains('is-selected')), cards.map((c) => c === card));
      assert.equal($('#wiz-next-btn').disabled, false);

      $('#wiz-next-btn').click();
      const presetRow = [...overlay().querySelectorAll('.setup-modal-summary tr')]
        .find((tr) => tr.querySelector('.setup-modal-summary-key')?.textContent === 'Onboarding');
      assert.equal(presetRow?.querySelector('.setup-modal-summary-val').textContent, `${expected.letter} — ${expected.name}`);

      // Back keeps the pick.
      $('#wiz-back-btn').click();
      const again = overlay().querySelector(`.setup-modal-preset-card[data-letter="${expected.letter}"]`);
      assert.equal(again.getAttribute('aria-pressed'), 'true');
      assert.equal($('#wiz-next-btn').disabled, false);
      $('#wiz-next-btn').click();

      $('#wiz-confirm-btn').click();
      assert.ok(detail, 'onComplete fired');
      assert.deepEqual(detail.preset, expected.preset);
      assert.deepEqual(detail.apiProject.projectPresets, ['software', 'science']);
      assert.equal(detail.apiProject.isNew, true);
      assert.equal(overlay(), null, 'wizard closed after Create Project');
    });
  });
}

// (TPT9318) Open Project entry: open({ presetLocked: true }) has no Preset step and no Preset
// dot. A new project goes Work presets → Confirm, the summary names compose-as-you-go (no letter —
// the A/B/C cards were never shown) and the detail carries the compose preset, so main.js
// writes KB_MODE: 'compose' and seeds no starter tasks. Linking an existing project creates
// nothing and still emits preset: null.
function presetLockedAPI() {
  return {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'a@b.c' } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => [{ id: 'claude', label: 'Claude Code', available: true }],
  };
}

const summaryValue = (key) => [...overlay().querySelectorAll('.setup-modal-summary tr')]
  .find((tr) => tr.querySelector('.setup-modal-summary-key')?.textContent === key)
  ?.querySelector('.setup-modal-summary-val').textContent;

test('work presets track none, mixed and all in place; removing Software skips a prior code seed', async () => {
  await withWizard(presetLockedAPI(), async ({ wizard, flush }) => {
    let detail;
    wizard.open({ projectPath: '/tmp/p', onComplete: d => { detail = d; } });
    await flush();
    const $ = selector => overlay().querySelector(selector);
    $('#wiz-new-card').click();
    $('#wiz-proj-name').value = 'Research';
    $('#wiz-proj-name').dispatchEvent(new Event('input'));
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    const all = $('#wiz-work-all');
    const inputs = [...overlay().querySelectorAll('.wizard-work-grid input')];
    assert.equal(inputs.length, 8);
    assert.equal($('#wiz-next-btn').disabled, true);
    inputs[0].focus();
    inputs[0].click();
    assert.equal(document.activeElement, inputs[0]);
    assert.equal(all.indeterminate, true);
    all.click();
    assert.ok(inputs.every(input => input.checked));
    assert.equal(all.indeterminate, false);
    all.click();
    assert.ok(inputs.every(input => !input.checked));
    assert.equal($('#wiz-next-btn').disabled, true);
    inputs[0].click();
    inputs[1].click();
    $('#wiz-next-btn').click();
    $('[data-letter="C"]').click();
    $('#wiz-next-btn').click();
    $('#wiz-back-btn').click();
    $('#wiz-back-btn').click();
    assert.equal($('[value="software"]').checked, true);
    assert.equal($('[value="science"]').checked, true);
    $('[value="software"]').click();
    $('#wiz-next-btn').click();
    assert.equal(summaryValue('Work presets'), 'Science');
    assert.equal(summaryValue('Onboarding'), 'Compose the knowledge base as you go');
    $('#wiz-confirm-btn').click();
    assert.deepEqual(detail.apiProject.projectPresets, ['science']);
    assert.equal(detail.preset.value, wizard.COMPOSE_PRESET);
  });
});

test('presetLocked: a new project skips the Preset step and emits compose-as-you-go', async () => {
  await withWizard(presetLockedAPI(), async ({ wizard, flush }) => {
    let detail = null;
    wizard.open({ projectPath: '/tmp/p', presetLocked: true, onComplete: (d) => { detail = d; } });
    await flush();
    const $ = (sel) => overlay().querySelector(sel);
    const dots = () => overlay().querySelectorAll('.setup-modal-steps .setup-modal-dot').length;
    assert.equal(dots(), 7, 'work presets included, onboarding skipped');
    $('#wiz-new-card').click();
    $('#wiz-proj-name').value = 'Fresh';
    $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    $('#wiz-next-btn').click();
    await flush(); // device-name prefill
    assert.equal(dots(), 7, 'a new project keeps the work step');
    $('#wiz-next-btn').click();
    await flush(); // agent detection
    $('#wiz-next-btn').click();
    assert.equal($('#wiz-next-btn').disabled, true);
    $('[value="home"]').click();
    $('#wiz-next-btn').click();
    assert.equal($('.setup-modal-preset-grid'), null);
    assert.equal(summaryValue('Work presets'), 'Home');
    assert.ok($('#wiz-confirm-btn'), 'on the Confirm step');
    assert.equal($('#wiz-confirm-btn').textContent, 'Create Project');
    assert.equal(summaryValue('Onboarding'), 'Compose the knowledge base as you go');

    $('#wiz-back-btn').click();
    assert.equal($('[value="home"]').checked, true, 'Back retains the selection');
    await flush();
    $('#wiz-next-btn').click();
    assert.ok($('#wiz-confirm-btn'), 'and Next goes to Confirm again');

    $('#wiz-confirm-btn').click();
    assert.ok(detail, 'onComplete fired');
    assert.deepEqual(detail.preset, { letter: 'A', mode: 'compose', value: 'compose-as-you-go' });
    assert.equal(detail.apiProject.isNew, true);
    assert.equal(detail.apiProject.name, 'Fresh');
    assert.deepEqual(detail.apiProject.projectPresets, ['home']);
    assert.equal(overlay(), null, 'wizard closed after Create Project');
  });
});

for (const [projectPresets, summary] of [[['health', 'home'], 'Health, Home'], [undefined, 'Software'], [[], 'Software']]) {
  test(`linking shows the API work presets ${JSON.stringify(projectPresets)} as ${summary} and skips onboarding`, async () => {
    const api = { ...presetLockedAPI(), setupListProjects: async () => [{ id: 7, name: 'Proj', projectPresets }] };
    await withWizard(api, async ({ wizard, flush }) => {
      let detail = null;
      wizard.open({ projectPath: '/tmp/p', presetLocked: true, onComplete: (d) => { detail = d; } });
      await flush();
      const $ = (sel) => overlay().querySelector(sel);
      $('.setup-modal-project-card[data-id="7"]').click();
      $('#wiz-next-btn').click();
      await flush(); // policy and identity
      $('#wiz-next-btn').click();
      await flush();
      $('#wiz-next-btn').click();
      await flush();
      $('#wiz-next-btn').click();
      assert.equal(summaryValue('Onboarding'), undefined, 'no onboarding row for an existing project');
      assert.equal(summaryValue('Work presets'), summary);
      assert.equal($('#wiz-confirm-btn').textContent, 'Open Project');
      $('#wiz-confirm-btn').click();
      assert.equal(detail.preset, null);
      assert.deepEqual(detail.apiProject.projectPresets, projectPresets?.length ? projectPresets : ['software']);
      assert.equal(detail.apiProject.isNew, false);
      assert.equal(detail.apiProject.id, 7);
    });
  });
}

test('presetLocked does not leak: the next unlocked run can choose software onboarding', async () => {
  await withWizard(presetLockedAPI(), async ({ wizard, flush }) => {
    wizard.open({ projectPath: '/tmp/p', presetLocked: true });
    await flush();
    wizard.close();
    wizard.open({ projectPath: '/tmp/p' });
    await flush();
    const $ = (sel) => overlay().querySelector(sel);
    assert.equal(overlay().querySelectorAll('.setup-modal-steps .setup-modal-dot').length, 7);
    // The earlier session's sign-in is still in memory: step 1 shows "Signed in as …".
    $('#wiz-next-btn').click();
    await flush(); // project list
    $('#wiz-new-card').click();
    $('#wiz-proj-name').value = 'Fresh';
    $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    $('[value="software"]').click();
    $('#wiz-next-btn').click();
    assert.ok($('.setup-modal-preset-grid'), 'Create Project entry still asks for an onboarding mode');
    assert.equal($('#wiz-next-btn').disabled, true, 'nothing preselected');
  });
});

// (TPT9318) Whole Open Project chain for a new project: the preset-locked wizard's detail goes
// through the real project:create-from-wizard handler (main.js, run in a vm with the API
// calls stubbed and the real project-config / project-seeder modules), which must write
// KB_MODE: 'compose' into the folder's config.json and never seed starter tasks.
test('presetLocked chain: the created project has KB_MODE compose and no seeded tasks', async (t) => {
  const { createRequire } = await import('node:module');
  const { readFileSync, existsSync } = await import('node:fs');
  const vm = await import('node:vm');
  const projectDir = mkdtempSync(join(tmpdir(), 'tt-open-entry-project-'));
  const userData = mkdtempSync(join(tmpdir(), 'tt-open-entry-userdata-'));
  const savedUserData = process.env.TIPATASK_USER_DATA;
  process.env.TIPATASK_USER_DATA = userData; // the scoped token lands in a private account store
  t.after(() => {
    if (savedUserData === undefined) delete process.env.TIPATASK_USER_DATA;
    else process.env.TIPATASK_USER_DATA = savedUserData;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  let detail = null;
  const api = { ...presetLockedAPI(), setupProjectProfile: async () => ({
    policy: { company: { name: 'Atlas' }, rules: { language: { value: 'uk', source: 'company' } } },
  }) };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XWQAAAABJRU5ErkJggg==';
  const expectedLogo = 'data:image/png;base64,' + png;
  await withWizard(api, async ({ wizard, flush }) => {
    wizard.open({ projectPath: projectDir, presetLocked: true, onComplete: (d) => { detail = d; } });
    await flush();
    const $ = (sel) => overlay().querySelector(sel);
    $('#wiz-new-card').click();
    $('#wiz-proj-name').value = 'Fresh';
    $('#wiz-proj-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#wiz-next-btn').click();
    await flush(); // policy and identity
    assert.match($('.project-rules').textContent, /Atlas/);
    const initials = $('[data-initials]');
    initials.value = 'too long';
    initials.dispatchEvent(new Event('input'));
    assert.equal($('#wiz-next-btn').disabled, true);
    initials.value = 'UX';
    initials.dispatchEvent(new Event('input'));
    $('[data-brand-colors-add]').click();
    $('[data-brand-color-input="0"]').value = '#134789';
    $('[data-brand-color-input="0"]').dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal($('.project-monogram').textContent, 'UX');
    const picker = $('[data-file]');
    Object.defineProperty(picker, 'files', { value: [new window.File([Buffer.from(png, 'base64')], 'brand.png', { type: 'image/png' })] });
    await picker.onchange();
    assert.equal($('[data-preview] img').getAttribute('src'), expectedLogo);
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    $('[value="home"]').click();
    $('[value="health"]').click();
    $('#wiz-next-btn').click();
    assert.equal($('.setup-modal-summary .project-monogram img').getAttribute('src'), expectedLogo);
    assert.match($('.setup-modal-summary').textContent, /UX/);
    assert.match($('.setup-modal-summary').textContent, /#134789/);
    $('#wiz-confirm-btn').click();
  });
  assert.ok(detail, 'the wizard completed');

  const require = createRequire(import.meta.url);
  const mainSrc = readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
  const start = mainSrc.indexOf("  ipcMain.handle('project:create-from-wizard'");
  const end = mainSrc.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start !== -1 && end > start, 'create-from-wizard handler found');
  const seeded = [];
  const realSeeder = require('../server/project-seeder.js');
  const modules = {
    './src/cli/setup': {
      createApiProject: async ({ name, projectPresets, identity, settings }) => {
        assert.equal(identity.display_initials, 'UX');
        assert.deepEqual(identity.brand_colors, ['#134789']);
        assert.equal(identity.logo, expectedLogo);
        assert.equal(settings.language, 'uk');
        assert.deepEqual(projectPresets, ['health', 'home']);
        return { id: 41, name, projectPresets };
      },
      registerDevice: async ({ name }) => ({ id: 9, name }),
      associateDeviceProject: async () => ({}),
      initializeProjectSettings: async () => {},
    },
    './src/cli/auth': { exchangeProjectToken: async () => 'scoped-token' },
    './src/server/project-config': require('../server/project-config.js'),
    './src/server/project-seeder': { ...realSeeder, callSeedPresetTasks: async (...args) => { seeded.push(args); return { seeded: 1 }; } },
    './src/cli/knowledge-sync': { pushAll: async () => {}, pushArchitectureDocs: async () => {} },
  };
  let handler = null;
  vm.runInNewContext(mainSrc.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    require: (id) => { assert.ok(id in modules, `unexpected require(${id})`); return modules[id]; },
    getOrCreateMachineId: () => 'machine-1',
    writeProjectMeta: () => {},
    writeProjectMcpConfig: () => {},
    writeProjectSkillsConfig: () => {},
    writeProjectCodexConfig: () => {},
    console: { warn: () => {}, error: () => {}, log: () => {} },
  });

  const res = await handler({}, detail);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.presetSeed, null, 'nothing seeded, nothing to report');
  assert.equal(seeded.length, 0, 'callSeedPresetTasks never ran');
  const config = JSON.parse(readFileSync(join(projectDir, '.tipatask', 'config.json'), 'utf8'));
  assert.equal(config.KB_MODE, 'compose');
  assert.equal(config.API_PROJECT_ID, '41');
  assert.equal(Object.hasOwn(config, 'API_TOKEN'), false, 'the token went to the account store');
  assert.equal(existsSync(join(projectDir, 'ai', 'architecture', 'GENERAL.md')), true, 'base GENERAL.md written');
});
