import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import * as projectOpenFlow from './project-open-flow.js';
import { LOCALES } from './i18n.js';

// (TPT9318) Open Project and Create Project are two entries of one renderer flow. These tests
// run template.html's real Get Started renderer, openOrCreateProject(entry) and Project-menu
// handler in happy-dom with stubbed IPC: both Get Started buttons and both menu actions reach
// the flow with their own entry, and the entry reaches the create-project event that opens
// the project wizard (index.js turns 'open' into presetLocked).

const template = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');

function slice(from, to) {
  const start = template.indexOf(from);
  const end = template.indexOf(to, start);
  assert.ok(start !== -1 && end > start, `could not locate ${from}`);
  return template.slice(start, end);
}

async function withHarness({ picks = [], focus = async () => ({ ok: false }) } = {}, run) {
  const win = new Window({ url: 'http://localhost:4455/' });
  try {
    win.document.body.innerHTML = slice('<div id="project-choose-modal"', '<div id="project-rename-modal"');
    const calls = { picks: [], opened: [], wizards: [] };
    let menuHandler = null;
    win.electronAPI = {
      getProjectPath: () => null, // unbound window: Get Started comes back after every non-wizard outcome
      pickAndOpenProject: async (entry) => { calls.picks.push(entry); return picks.shift() ?? null; },
      focusProjectWindow: focus,
      openProject: (dir, target) => { calls.opened.push([dir, target]); },
      onProjectMenu: (cb) => { menuHandler = cb; },
    };
    win.TipTask = { projectOpenFlow };
    // The detail object is built inside the vm context (another realm): copy it into this one.
    win.addEventListener('create-project', (e) => { calls.wizards.push({ ...e.detail }); });
    const $ = (id) => win.document.getElementById(id);
    const context = vm.createContext({
      window: win,
      document: win.document,
      CustomEvent: win.CustomEvent,
      t: (key) => LOCALES.en[key] ?? key,
      _chooseModal: $('project-choose-modal'),
      _chooseTitle: $('project-choose-title'),
      _chooseDesc: $('project-choose-desc'),
      _chooseActions: $('project-choose-actions'),
    });
    vm.runInContext(slice('  let _chooseLocked = false;', '  function _showProjectRenameModal('), context);
    vm.runInContext(slice('  window.electronAPI.onProjectMenu(async (action) => {', '\n  // Capture Escape before the task workspace'), context);
    assert.equal(typeof menuHandler, 'function', 'the Project menu handler registered');
    await run({
      win,
      context,
      calls,
      menu: (action) => menuHandler(action),
      buttons: () => [...$('project-choose-actions').querySelectorAll('button')],
      visible: () => $('project-choose-modal').style.display === 'flex',
      flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
  } finally {
    await win.happyDOM.abort();
  }
}

test('Get Started offers Create Project… (primary) and Open Project…', async () => {
  await withHarness({}, async (h) => {
    h.context._showChooseModal();
    assert.equal(h.visible(), true);
    assert.equal(h.win.document.getElementById('project-choose-title').textContent, LOCALES.en['project.getStartedTitle']);
    assert.equal(h.win.document.getElementById('project-choose-desc').textContent, LOCALES.en['project.getStartedDesc']);
    assert.deepEqual(h.buttons().map((b) => b.textContent), ['Create Project…', 'Open Project…']);
    const [create, open] = h.buttons();
    assert.equal(create.style.cssText.includes('--c-on-primary'), true, 'Create Project… is the primary action');
    assert.equal(open.style.cssText.includes('--c-on-primary'), false, 'Open Project… is the secondary action');
    // Re-showing rebuilds the pair instead of stacking a second one.
    h.context._showChooseModal();
    assert.equal(h.buttons().length, 2);
  });
});

for (const [label, entry] of [['Create Project…', 'create'], ['Open Project…', 'open']]) {
  test(`Get Started ${label} runs the flow with the ${entry} entry and hands it to the wizard`, async () => {
    await withHarness({ picks: [{ path: '/fresh', needsSetup: true }] }, async (h) => {
      h.context._showChooseModal();
      h.buttons().find((b) => b.textContent === label).click();
      await h.flush();
      assert.deepEqual(h.calls.picks, [entry], 'the folder picker learns the entry (its title)');
      assert.deepEqual(h.calls.wizards, [{ projectPath: '/fresh', entry }]);
      assert.deepEqual(h.calls.opened, []);
      assert.equal(h.visible(), false, 'the wizard replaces Get Started');
    });
  });
}

for (const action of ['open', 'create']) {
  test(`Project menu '${action}' runs the flow with that entry; a configured folder opens in both`, async () => {
    const picks = [{ path: '/fresh', needsSetup: true }, { path: '/configured', config: { API_PROJECT_ID: '2' } }];
    await withHarness({ picks }, async (h) => {
      await h.menu(action);
      assert.deepEqual(h.calls.wizards, [{ projectPath: '/fresh', entry: action }]);
      await h.menu(action);
      assert.deepEqual(h.calls.picks, [action, action]);
      assert.deepEqual(h.calls.opened, [['/configured', 'new']], 'configured folder opens in a new window');
      assert.equal(h.calls.wizards.length, 1, 'no wizard for a configured folder');
      assert.equal(h.visible(), true, 'unbound window: Get Started comes back after opening elsewhere');
    });
  });

  test(`Project menu '${action}': a folder already open elsewhere is focused, nothing opens`, async () => {
    const picks = [{ path: '/open-elsewhere', needsSetup: true }];
    await withHarness({ picks, focus: async () => ({ ok: true }) }, async (h) => {
      await h.menu(action);
      assert.deepEqual(h.calls.picks, [action]);
      assert.deepEqual(h.calls.wizards, []);
      assert.deepEqual(h.calls.opened, []);
    });
  });
}

test("index.js locks the wizard's preset for the Open Project entry only", () => {
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const listener = src.slice(src.indexOf("window.addEventListener('create-project'"));
  assert.match(listener, /projectCreationWizard\.open\(\{[\s\S]*?presetLocked: projectOpenFlow\.wizardPresetLocked\(e\?\.detail\?\.entry\),/);
  assert.equal(projectOpenFlow.wizardPresetLocked('open'), true);
  assert.equal(projectOpenFlow.wizardPresetLocked('create'), false);
});

test('Get Started labels and description are translated in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['project.getStartedCreate', 'project.getStartedOpen', 'project.getStartedDesc']) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${locale} ${key}`);
      if (locale !== 'en') assert.notEqual(table[key], LOCALES.en[key], `${locale} ${key} is translated`);
    }
    for (const key of ['project.getStartedCreate', 'project.getStartedOpen']) assert.ok(table[key].endsWith('…'), `${locale} ${key} ends with an ellipsis`);
    assert.equal(table['project.getStartedAction'], undefined, `${locale} drops the combined label`);
  }
});
