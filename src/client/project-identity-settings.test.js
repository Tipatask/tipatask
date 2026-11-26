import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9409) Settings ▸ General ▸ Project identity and Policy, driven in happy-dom with the real
// modules (project-profile.js, desktop-project-profile.js, project-policy-modal.js) bundled with
// esbuild — the dialog-focus.test.js harness. The Settings markup is the real #settings-modal
// slice of template.html; window.electronAPI.api.project is stubbed per test.
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XWQAAAABJRU5ErkJggg==';

async function withSettings(project, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-identity-settings-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator', 'FileReader', 'File']) install(key, window[key]);
  // happy-dom supplies FileReader, but has no image decoder.
  install('Image', class { naturalWidth = 1; naturalHeight = 1; async decode() {} });
  window.electronAPI = { api: { project } };
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('fetch', async () => { throw new Error('Settings reads the project over IPC'); });
  try {
    const start = html.indexOf('<div id="settings-modal"');
    const end = html.indexOf('<!-- (C1388)');
    assert.ok(start >= 0 && end > start, '#settings-modal markup not found in template.html');
    document.body.innerHTML = html.slice(start, end);
    document.getElementById('settings-modal').classList.add('open');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: {
        contents: `export * as profile from './src/client/desktop-project-profile.js';
          export * as identity from './src/client/project-profile.js';
          export * as policy from './src/client/project-policy-modal.js';
          export { setLocale, t } from './src/client/i18n.js';`,
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'identity.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const mod = await import(pathToFileURL(bundle).href);
    const flush = () => new Promise(resolve => setTimeout(resolve, 20));
    try { await run({ ...mod, flush }); } finally { mod.policy.closeProjectPolicyModal(); }
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function profileStub(overrides = {}) {
  const calls = { update: [], savePolicy: [], profile: 0 };
  let current = {
    context: 'ctx', name: 'Demartini Group', editable: true, policyEditable: false, logo: null,
    identity: { display_initials: null, initials: 'DG', brand_color: null, logo_url: null },
    policy: { company: null, rules: {}, owner_rules: {}, company_rules: {} },
    ...overrides,
  };
  const project = {
    calls,
    set(next) { current = { ...current, ...next }; },
    async profile() { calls.profile++; return structuredClone(current); },
    async update(fields, context) { calls.update.push({ fields, context }); return { identity: current.identity }; },
    async savePolicy(rules, base, context) { calls.savePolicy.push({ rules, base, context }); return { policy: current.policy }; },
  };
  return project;
}

const $ = selector => document.querySelector(selector);
const rowFields = () => [...document.querySelectorAll('#settings-project-profile .project-identity-row')].map(row => row.dataset.field);
const input = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
// The editor re-renders on every add/remove: always pick the current "Add a rule…" select.
const addRule = (dialog, field) => {
  const add = dialog.querySelector('[data-add]');
  add.value = field;
  add.dispatchEvent(new Event('change', { bubbles: true }));
};

test('one preview: the logo when there is one, otherwise the initials on the brand color, never both', async () => {
  const project = profileStub({ logo: LOGO, identity: { display_initials: 'DM', initials: 'DM', brand_color: '#1F2F5C', logo_url: '/api/projects/2/logo?v=1' } });
  await withSettings(project, async ({ profile, identity, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    const marks = document.querySelectorAll('#settings-project-profile [data-preview] .project-monogram');
    assert.equal(marks.length, 1, 'a single mark');
    assert.equal(marks[0].querySelector('img').getAttribute('src'), LOGO);
    assert.equal(marks[0].textContent, '', 'no initials beside the logo');
    assert.match($('#settings-project-profile [data-preview]').textContent, /Demartini Group/);

    const initialsOnly = identity.identityMarkup('Demartini Group', { identity: { initials: 'DG', brand_color: '#1F2F5C' } });
    assert.match(initialsOnly, /class="project-monogram" style="background:#1F2F5C;color:#fff">DG</);
    const neutral = identity.identityMarkup('Demartini Group', { identity: { initials: 'DG' } });
    assert.match(neutral, /class="project-monogram">DG</, 'no brand color: no inline fill, the neutral tile');
    // Setup summaries still name what the logo hides: the initials and the color code.
    assert.match(identity.identityMarkup('Demartini Group', { identity: { initials: 'DG', brand_color: '#1f2f5c' }, logo: LOGO }, {}, true),
      /<small>DG · #1F2F5C<\/small>/);
  });
});

test('identity rows: Initials, Brand color and Project logo on the Settings grid, Save in the last row', async () => {
  const project = profileStub();
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    assert.equal($('#settings-profile-section').hidden, false);
    assert.deepEqual(rowFields(), ['initials', 'color', 'logo']);
    for (const row of document.querySelectorAll('#settings-profile-body .settings-row')) {
      const [label, control, ...rest] = row.children;
      assert.ok(label.classList.contains('settings-row-label'), `${row.dataset.field || row.id}: label column first`);
      assert.ok(control.classList.contains('settings-row-control'), `${row.dataset.field || row.id}: control column second`);
      for (const el of rest) assert.ok(el.classList.contains('settings-notice'), 'only notices follow the columns');
    }
    const saveRow = $('#settings-identity-save-row');
    assert.equal(saveRow.hidden, false);
    assert.equal(saveRow.previousElementSibling.id, 'settings-project-profile', 'Save follows the fields');
    assert.equal($('#settings-identity-save').disabled, true, 'nothing to save yet');
    assert.equal($('#settings-identity-save').textContent, t('btn.save'));
    // Labels sit in the label column: the initials label names its input.
    const initials = $('[data-initials]');
    assert.equal($(`label[for="${initials.id}"]`).textContent, t('profile.initials'));
    assert.equal(initials.placeholder, 'DG');
    // (TPT9422) No color chosen: the highlighted "Not selected" chip and Add color, no swatch.
    assert.equal($('[data-brand-colors-none]').textContent.trim(), t('profile.colorNotSelected'));
    assert.equal($('[data-brand-colors-none] .project-swatch').classList.contains('is-unset'), true);
    assert.equal($('[data-brand-color-input]'), null);
    assert.equal($('[data-brand-colors-add]').textContent.trim(), t('profile.addColor'));
    assert.equal($('[data-field="color"] .settings-row-hint').textContent, t('profile.colorsHintNone'));
    assert.equal($('[data-brand-colors]').getAttribute('aria-labelledby'), $('[data-field="color"] .settings-row-label span').id);
    // The logo control: a styled button over a hidden native picker; Remove only with a logo.
    assert.equal($('[data-file]').hidden, true);
    assert.equal($('[data-choose]').textContent.trim(), t('profile.chooseLogo'));
    assert.equal($('[data-remove]').hidden, true);
    assert.equal($('[data-file-name]').hidden, true);
    assert.equal($('#settings-project-profile .project-rules'), null, 'the policy is not part of the identity section');
  });
});

test('Save sends only the fields that differ from the saved identity', async () => {
  const project = profileStub({ logo: LOGO, identity: { display_initials: 'DG', initials: 'DG', brand_color: '#1F2F5C', logo_url: '/api/projects/2/logo?v=1' } });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    const save = $('#settings-identity-save');
    assert.equal($('[data-brand-color-hex]').textContent, '#1F2F5C', 'a saved single brand_color reads as a one-color list');
    assert.ok($('[data-brand-color-remove="0"]'), 'a chosen color has its own remove button');
    assert.equal($('[data-remove]').hidden, false, 'a saved logo can be removed');

    input($('[data-initials]'), 'DMG');
    assert.equal(save.disabled, false);
    input($('[data-initials]'), 'DG');
    assert.equal(save.disabled, true, 'typing the saved initials back leaves nothing to save');

    $('[data-brand-color-remove="0"]').click();
    assert.equal($('[data-brand-colors-none]').textContent.trim(), t('profile.colorNotSelected'));
    assert.equal(document.activeElement, $('[data-brand-colors-add]'), 'focus stays in the field');
    $('[data-remove]').click();
    assert.equal($('[data-remove]').hidden, true);
    assert.equal($('[data-preview] img'), null, 'the preview falls back to the initials');
    assert.equal($('[data-preview] .project-monogram').textContent, 'DG');

    save.click();
    await flush();
    assert.deepEqual(project.calls.update, [{ fields: { brand_colors: [], logo: null }, context: 'ctx' }]);
    assert.equal($('#settings-profile-msg').hidden, false);
    assert.equal($('#settings-profile-msg').textContent, t('profile.saved'));
    assert.equal(document.activeElement, $('#settings-profile-msg'), 'focus lands on the confirmation');
  });
});

test('an added color fills its well and the tile; an unsaved logo removed again sends nothing', async () => {
  const project = profileStub();
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    $('[data-brand-colors-add]').click();
    input($('[data-brand-color-input="0"]'), '#123456');
    assert.equal($('[data-brand-colors-none]'), null);
    assert.equal($('.brand-color-swatch').style.getPropertyValue('--swatch'), '#123456');
    assert.equal($('[data-brand-color-hex]').textContent, '#123456');
    assert.equal($('[data-field="color"] .settings-row-hint').textContent, t('profile.colorsHint'));
    assert.match($('[data-preview] .project-monogram').getAttribute('style'), /background:#123456/);

    const picker = $('[data-file]');
    let opened = 0;
    picker.click = () => { opened++; };
    $('[data-choose]').click();
    assert.equal(opened, 1, 'Choose image opens the hidden picker');
    Object.defineProperty(picker, 'files', { configurable: true, value: [new window.File([Buffer.from(LOGO.split(',')[1], 'base64')], 'brand-mark.png', { type: 'image/png' })] });
    await picker.onchange();
    assert.equal($('[data-file-name]').hidden, false);
    assert.equal($('[data-file-name]').textContent, 'brand-mark.png');
    assert.equal($('[data-preview] img').getAttribute('src'), LOGO);
    assert.equal($('[data-remove]').hidden, false);
    $('[data-remove]').click();
    assert.equal($('[data-file-name]').hidden, true);

    $('#settings-identity-save').click();
    await flush();
    assert.deepEqual(project.calls.update.map(call => call.fields), [{ brand_colors: ['#123456'] }],
      'no logo field: the project had none and still has none');
  });
});

test('a rejected image is dropped: the saved logo returns and other edits can still be saved', async () => {
  const project = profileStub({ logo: LOGO, identity: { display_initials: null, initials: 'DG', brand_color: null, logo_url: '/api/projects/2/logo?v=1' } });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    input($('[data-initials]'), 'DM');
    const picker = $('[data-file]');
    Object.defineProperty(picker, 'files', { configurable: true, value: [new window.File(['GIF89a'], 'anim.gif', { type: 'image/gif' })] });
    await picker.onchange();
    assert.equal($('[data-error="logo"]').textContent, t('profile.invalidLogo'));
    assert.equal($('[data-file-name]').hidden, true);
    assert.equal($('[data-preview] img').getAttribute('src'), LOGO, 'the saved logo is back in the preview');
    assert.equal($('#settings-identity-save').disabled, false);
    input($('[data-initials]'), 'too long');
    assert.equal($('[data-initials]').getAttribute('aria-invalid'), 'true');
    assert.equal($('[data-error="initials"]').textContent, t('profile.invalidInitials'));
    assert.equal($('#settings-identity-save').disabled, true);
  });
});

test('a failed save keeps the edit, shows the error and hands focus back to Save', async () => {
  const project = profileStub();
  project.update = async () => { throw new Error('API 500: down'); };
  await withSettings(project, async ({ profile, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    input($('[data-initials]'), 'DM');
    const save = $('#settings-identity-save');
    save.click();
    await flush();
    assert.equal($('#settings-profile-msg').hidden, false);
    assert.match($('#settings-profile-msg').textContent, /API 500: down/);
    assert.equal(save.disabled, false);
    assert.equal($('[data-initials]').value, 'DM');
    assert.equal(document.activeElement, save);
  });
});

test('the policy is its own section: Edit… for the owner, View… with rules, hidden when there is nothing to show', async () => {
  const project = profileStub({ policyEditable: true });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    const section = $('#settings-policy-section');
    assert.equal(section.hidden, false);
    assert.equal($('#settings-policy-summary').textContent, t('policy.none'));
    assert.equal($('#settings-policy-open').textContent, t('policy.edit'));

    project.set({ policyEditable: false, policy: { company: { name: 'Atlas' }, rules: {
      language: { value: 'uk', source: 'company' }, vcs_type: { value: 'git', source: 'owner' },
      sprints_enabled: { value: true, source: 'owner' }, kb_sync_as_you_go: { value: false, source: 'owner' },
    }, owner_rules: { vcs_type: 'git', sprints_enabled: true, kb_sync_as_you_go: false }, company_rules: { language: 'uk' } } });
    await profile.refreshDesktopProfile(true);
    await flush();
    assert.equal(section.hidden, false);
    assert.equal($('#settings-policy-open').textContent, t('policy.view'));
    assert.match($('#settings-policy-summary').textContent, /^.+, .+, .+ \+1$/, 'three names and a count');

    project.set({ policy: { company: null, rules: {}, owner_rules: {}, company_rules: {} } });
    await profile.refreshDesktopProfile(true);
    await flush();
    assert.equal(section.hidden, true, 'no rules and no right to add one: no section');
  });
});

test('the owner edits their layer in the policy dialog and saves it with the layer it opened with', async () => {
  const project = profileStub({ policyEditable: true, policy: {
    company: { name: 'Atlas' }, rules: { language: { value: 'uk', source: 'company' }, sprints_enabled: { value: false, source: 'owner' } },
    owner_rules: { sprints_enabled: false }, company_rules: { language: 'uk' },
  } });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    let saved = 0;
    document.addEventListener('tiptask:policy-saved', () => { saved++; });
    $('#settings-policy-open').click();
    const dialog = $('.policy-modal');
    assert.ok(dialog, 'the dialog opens');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(dialog.querySelector('#policy-modal-company').textContent, /Atlas/);
    assert.match(dialog.querySelector('.policy-modal-list').textContent, /Українська|ukrainian/i, 'company rules are listed read-only');
    assert.deepEqual([...dialog.querySelectorAll('[data-rule]')].map(el => el.dataset.rule), ['sprints_enabled']);

    // Add a rule the company also sets: it can only take the company's value.
    addRule(dialog, 'language');
    const language = dialog.querySelector('[data-rule="language"]');
    assert.deepEqual([...language.options].map(option => JSON.parse(option.value)), ['uk']);
    assert.match(dialog.querySelector('.policy-modal-lock').textContent, /Atlas/);
    // Add sprint duration, then remove it again.
    addRule(dialog, 'sprint_duration_days');
    assert.equal(document.activeElement, dialog.querySelector('[data-rule="sprint_duration_days"]'), 'focus moves to the new rule');
    assert.equal(dialog.querySelector('[data-rule="sprint_duration_days"]').value, '14');
    dialog.querySelector('[data-remove="sprint_duration_days"]').click();
    // Flip the owner's switch rule on.
    const sprints = dialog.querySelector('[data-rule="sprints_enabled"]');
    sprints.value = JSON.stringify(true);
    sprints.dispatchEvent(new Event('input', { bubbles: true }));

    dialog.querySelector('[data-save]').click();
    await flush();
    assert.deepEqual(project.calls.savePolicy, [{ rules: { sprints_enabled: true, language: 'uk' }, base: { sprints_enabled: false }, context: 'ctx' }]);
    assert.equal($('.policy-modal'), null, 'the dialog closes after a save');
    assert.equal(saved, 1, 'Settings is told to repopulate');
    assert.equal($('#settings-modal').classList.contains('open'), true);
    assert.equal(t('policy.title'), dialog.querySelector('#policy-modal-title').textContent);
  });
});

test('the policy dialog keeps the edit and explains a refused save', async () => {
  const project = profileStub({ policyEditable: true });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    const answers = [
      [new Error("Error invoking remote method 'api:project.savePolicy': Error: policy_stale"), t('policy.stale')],
      [new Error('policy_conflict:language'), t('policy.conflict', { field: t('settings.language') })],
      [new Error('forbidden'), t('policy.forbidden')],
    ];
    $('#settings-policy-open').click();
    const dialog = $('.policy-modal');
    addRule(dialog, 'vcs_commit_enabled');
    dialog.querySelector('[data-save]').click();
    await flush();
    assert.equal(dialog.querySelector('[data-policy-error]').textContent, t('policy.gitRequired'), 'a Git flag needs a Git rule');
    assert.equal(project.calls.savePolicy.length, 0);
    dialog.querySelector('[data-remove="vcs_commit_enabled"]').click();
    assert.equal(document.activeElement, dialog.querySelector('[data-add]'), 'focus returns to Add a rule');
    addRule(dialog, 'language');
    for (const [error, text] of answers) {
      project.savePolicy = async () => { throw error; };
      dialog.querySelector('[data-save]').click();
      await flush();
      assert.equal(dialog.querySelector('[data-policy-error]').textContent, text);
      assert.ok($('.policy-modal'), 'the dialog stays open');
      assert.equal(dialog.querySelector('[data-save]').disabled, false);
      assert.ok(dialog.querySelector('[data-rule="language"]'), 'the edit is kept');
    }
  });
});

test('everyone else reads the rules; Escape closes the dialog and leaves Settings open', async () => {
  const project = profileStub({ policyEditable: false, policy: {
    company: null, rules: { vcs_type: { value: 'git', source: 'owner' } }, owner_rules: { vcs_type: 'git' }, company_rules: {},
  } });
  await withSettings(project, async ({ profile, t, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    $('#settings-policy-open').click();
    const dialog = $('.policy-modal');
    assert.equal(dialog.querySelector('select, input'), null, 'read-only');
    assert.equal(dialog.querySelector('[data-save]'), null);
    assert.equal(dialog.querySelector('[data-cancel]').textContent, t('btn.close'));
    assert.equal(dialog.querySelector('.policy-modal-scope').textContent, t('policy.ownerOnly'));
    assert.match(dialog.querySelector('.policy-modal-list').textContent, /Git/);
    let settingsEscapes = 0;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') settingsEscapes++; });
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('.policy-modal'), null);
    assert.equal(settingsEscapes, 0, 'the Escape never reaches Settings');
  });
});

test('the setup wizards list no empty policy block', async () => {
  await withSettings(profileStub(), async ({ identity, t }) => {
    assert.equal(identity.policyMarkup({ rules: {} }), '');
    assert.equal(identity.policyMarkup(null), '');
    assert.match(identity.policyMarkup({ company: { name: 'Atlas' }, rules: { sprint_sort_order: { value: 'desc', source: 'company' } } }),
      new RegExp(`${t('board.sprintOrderDesc')}.*Atlas`));
  });
});

// (TPT9422) The window's accent colors follow a saved brand color list without waiting for a reload.
test('saving brand colors paints them as the window accents at once; clearing them restores the theme', async () => {
  const project = profileStub();
  project.update = async (fields, context) => {
    project.calls.update.push({ fields, context });
    const colors = fields.brand_colors ?? [];
    project.set({ identity: { display_initials: null, initials: 'DG', brand_color: colors[0] ?? null, brand_colors: colors, logo_url: null } });
    return {};
  };
  await withSettings(project, async ({ profile, flush }) => {
    await profile.refreshDesktopProfile(true);
    await flush();
    const root = document.documentElement;
    assert.equal(root.hasAttribute('data-brand-accents'), false, 'no brand colors: the theme accents');
    $('[data-brand-colors-add]').click();
    input($('[data-brand-color-input="0"]'), '#7c3aed');
    $('[data-brand-colors-add]').click();
    assert.equal(root.hasAttribute('data-brand-accents'), false, 'an unsaved pick does not repaint the window');
    $('#settings-identity-save').click();
    await flush();
    assert.equal(project.calls.update[0].fields.brand_colors.length, 2);
    assert.equal(project.calls.update[0].fields.brand_colors[0], '#7C3AED');
    assert.equal(root.getAttribute('data-brand-accents'), '2');
    assert.equal(root.style.getPropertyValue('--c-primary'), '#7C3AED', 'the first color is the primary accent');
    assert.equal(root.style.getPropertyValue('--c-accent-2'), project.calls.update[0].fields.brand_colors[1]);

    $('[data-brand-color-remove="1"]').click();
    $('[data-brand-color-remove="0"]').click();
    $('#settings-identity-save').click();
    await flush();
    assert.deepEqual(project.calls.update[1].fields, { brand_colors: [] });
    assert.equal(root.hasAttribute('data-brand-accents'), false);
    assert.equal(root.style.getPropertyValue('--c-primary'), '', 'the theme accents are back');
  });
});
