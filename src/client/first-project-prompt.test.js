import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';

// (TPT9319) A new project's one-time first-open prompt: the decision flow of
// first-project-prompt.js with a fake IPC (and once with main/first-open-prompt.js for real),
// the modal itself in happy-dom, and its wiring in index.js / template.html.

const window = new Window({ url: 'http://127.0.0.1:4455/todo.html?projectPath=%2Fprojects%2Ffresh' });
for (const [key, value] of Object.entries({
  window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
  Event: window.Event, CustomEvent: window.CustomEvent, KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent, MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const prompt = await import('./first-project-prompt.js');
const { default: state } = await import('./state.js');
const i18n = await import('./i18n.js');
const dialogFocus = await import('./dialog-focus.js');
const require = createRequire(import.meta.url);
const mainPrompt = require('../../main/first-open-prompt.js');

const indexSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const templateSrc = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

const flush = () => new Promise((resolve) => setTimeout(resolve, 10)); // MutationObserver inerting

function reset() {
  prompt._resetFirstProjectPromptForTests();
  state.activeTab = 'board';
  state.activeTerminal = null;
  i18n.setLocale('en');
  document.body.innerHTML = '<div id="app"><button id="board-btn">board</button></div>';
}

// window.electronAPI's three calls over an in-memory project.json marker.
function fakeApi({ due = true, path = '/projects/fresh' } = {}) {
  const store = { marker: due, path };
  const calls = { get: 0, clear: 0 };
  return {
    store,
    calls,
    getProjectPath: () => store.path,
    getFirstOpenPrompt: async () => { calls.get++; return store.marker === true; },
    clearFirstOpenPrompt: async () => {
      calls.clear++;
      const removed = store.marker === true;
      store.marker = false;
      return removed;
    },
  };
}

function recorder() {
  const log = [];
  return {
    log,
    openObjective: () => { log.push('objective'); },
    openProjectChat: () => { log.push('discuss'); },
  };
}

test('a due marker: wait ~2s, clear it, then show the prompt and run the choice', async () => {
  reset();
  const api = fakeApi();
  const { log, ...open } = recorder();
  const waits = [];
  let markerWhenShown = null;
  const choice = await prompt.maybeShowFirstProjectPrompt({
    api, ...open,
    wait: async (ms) => { waits.push(ms); assert.equal(api.calls.clear, 0, 'nothing is cleared before the delay'); },
    show: async () => { markerWhenShown = api.store.marker; return 'objective'; },
  });
  assert.equal(choice, 'objective');
  assert.deepEqual(waits, [prompt.FIRST_PROMPT_DELAY_MS]);
  assert.equal(prompt.FIRST_PROMPT_DELAY_MS, 2000);
  assert.equal(markerWhenShown, false, 'the marker is cleared before the modal opens');
  assert.deepEqual(log, ['objective']);
});

test('Project Discussion opens a project chat; Dismiss opens nothing', async () => {
  for (const [picked, expected] of [['discuss', ['discuss']], ['dismiss', []]]) {
    reset();
    const { log, ...open } = recorder();
    const choice = await prompt.maybeShowFirstProjectPrompt({
      api: fakeApi(), ...open, wait: async () => {}, isBusy: () => false, show: async () => picked,
    });
    assert.equal(choice, picked);
    assert.deepEqual(log, expected, picked);
  }
});

test('it appears once: later renders never read the marker again, and a reload finds it cleared', async () => {
  reset();
  const api = fakeApi();
  let shows = 0;
  const opts = { api, wait: async () => {}, isBusy: () => false, show: async () => { shows++; return 'dismiss'; } };
  assert.equal(await prompt.maybeShowFirstProjectPrompt(opts), 'dismiss');
  for (let i = 0; i < 3; i++) assert.equal(await prompt.maybeShowFirstProjectPrompt(opts), null);
  assert.equal(api.calls.get, 1, 'one marker read per project and window');

  // A reload is a fresh module in a fresh renderer; the marker store is the project's file.
  const reloaded = await import('./first-project-prompt.js?reload=1');
  assert.equal(await reloaded.maybeShowFirstProjectPrompt(opts), null);
  assert.equal(api.calls.get, 2, 'the reloaded window reads the marker');
  assert.equal(api.calls.clear, 1, 'and finds nothing to clear');
  assert.equal(shows, 1, 'the prompt appeared exactly once');
});

test('an existing project (no marker) never sees the prompt', async () => {
  reset();
  const api = fakeApi({ due: false });
  let waited = false;
  let shown = false;
  for (let i = 0; i < 3; i++) {
    assert.equal(await prompt.maybeShowFirstProjectPrompt({
      api, wait: async () => { waited = true; }, isBusy: () => false, show: async () => { shown = true; return 'objective'; },
    }), null);
  }
  assert.equal(shown, false);
  assert.equal(waited, false, 'no delay is even started');
  assert.equal(api.calls.clear, 0, 'nothing is cleared');
  assert.equal(api.calls.get, 1);
});

test('a busy window consumes the marker but shows nothing', async () => {
  reset();
  const api = fakeApi();
  let shown = false;
  assert.equal(await prompt.maybeShowFirstProjectPrompt({
    api, wait: async () => {}, isBusy: () => true, show: async () => { shown = true; return 'dismiss'; },
  }), null);
  assert.equal(shown, false);
  assert.equal(api.store.marker, false, 'consumed: it will not pop up on a later opening');
});

test('a project switch during the delay leaves the marker and checks the new project next', async () => {
  reset();
  const api = fakeApi();
  let shown = false;
  const result = await prompt.maybeShowFirstProjectPrompt({
    api, isBusy: () => false, show: async () => { shown = true; return 'dismiss'; },
    wait: async () => { api.store.path = '/projects/other'; },
  });
  assert.equal(result, null);
  assert.equal(shown, false);
  assert.equal(api.calls.clear, 0);
  assert.equal(api.store.marker, true, 'the first project keeps its marker');
  await prompt.maybeShowFirstProjectPrompt({ api, wait: async () => {}, isBusy: () => false, show: async () => 'dismiss' });
  assert.equal(api.calls.get, 2, 'the project now in this window gets its own check');
});

test('a lost clear (another reader removed it) or an IPC failure shows nothing', async () => {
  reset();
  const lost = fakeApi();
  lost.clearFirstOpenPrompt = async () => false;
  let shown = 0;
  const show = async () => { shown++; return 'dismiss'; };
  assert.equal(await prompt.maybeShowFirstProjectPrompt({ api: lost, wait: async () => {}, isBusy: () => false, show }), null);

  reset();
  const readFails = fakeApi();
  readFails.getFirstOpenPrompt = async () => { throw new Error('No handler registered'); };
  assert.equal(await prompt.maybeShowFirstProjectPrompt({ api: readFails, wait: async () => {}, isBusy: () => false, show }), null);

  reset();
  const clearFails = fakeApi();
  clearFails.clearFirstOpenPrompt = async () => { throw new Error('EACCES'); };
  assert.equal(await prompt.maybeShowFirstProjectPrompt({ api: clearFails, wait: async () => {}, isBusy: () => false, show }), null);
  assert.equal(shown, 0);
});

test('overlapping renders share one check', async () => {
  reset();
  const api = fakeApi();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let shows = 0;
  const opts = { api, wait: () => gate, isBusy: () => false, show: async () => { shows++; return 'dismiss'; } };
  const first = prompt.maybeShowFirstProjectPrompt(opts);
  const second = prompt.maybeShowFirstProjectPrompt(opts);
  assert.equal(second, first, 'the second render joins the running check');
  release();
  await first;
  assert.equal(api.calls.get, 1);
  assert.equal(shows, 1);
});

test('browser mode (no IPC) and an unbound window are no-ops', async () => {
  reset();
  assert.equal(await prompt.maybeShowFirstProjectPrompt({ api: {} }), null);
  assert.equal(await prompt.maybeShowFirstProjectPrompt({ api: { ...fakeApi(), getProjectPath: () => null } }), null);
  assert.equal(await prompt.maybeShowFirstProjectPrompt(), null, 'window.electronAPI is absent');
});

test('with the real main-side marker: shown on the first opening only, never after a reload', async (t) => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'tt-first-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.tipatask'));
  writeFileSync(join(dir, '.tipatask', 'project.json'), JSON.stringify({ name: 'Fresh', apiProjectId: 41, firstOpenPrompt: true }));
  const handlers = new Map();
  mainPrompt.registerFirstOpenPromptIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    isTrusted: () => true,
    projectDirOf: () => dir,
  });
  const event = { sender: { id: 1 } };
  const api = {
    getProjectPath: () => dir,
    getFirstOpenPrompt: async () => handlers.get(mainPrompt.FIRST_OPEN_PROMPT_CHANNEL)(event),
    clearFirstOpenPrompt: async () => handlers.get(mainPrompt.FIRST_OPEN_PROMPT_CLEAR_CHANNEL)(event),
  };
  let shows = 0;
  const opts = { api, wait: async () => {}, isBusy: () => false, show: async () => { shows++; return 'dismiss'; } };
  assert.equal(await prompt.maybeShowFirstProjectPrompt(opts), 'dismiss');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.tipatask', 'project.json'), 'utf8')), { name: 'Fresh', apiProjectId: 41 });
  const reloaded = await import('./first-project-prompt.js?reload=real-main');
  assert.equal(await reloaded.maybeShowFirstProjectPrompt(opts), null);
  assert.equal(shows, 1);
});

test('the modal: three choices in the project language, New Objective focused, the board inert', async () => {
  reset();
  const pending = prompt.showFirstProjectPrompt();
  await flush();
  const overlay = document.getElementById('first-project-prompt');
  assert.ok(overlay?.classList.contains('first-prompt-overlay'));
  const dialog = overlay.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Your project is ready');
  assert.equal(document.getElementById(dialog.getAttribute('aria-describedby')).textContent,
    'Do you wish to create your first objective or to discuss the project?');
  const buttons = [...overlay.querySelectorAll('[data-choice]')];
  assert.deepEqual(buttons.map((b) => b.dataset.choice), ['objective', 'discuss', 'dismiss']);
  assert.ok(buttons.every((b) => b.tagName === 'BUTTON' && b.type === 'button'));
  const labelOf = (b) => document.getElementById(b.getAttribute('aria-labelledby'))?.textContent ?? b.textContent;
  assert.deepEqual(buttons.map(labelOf), ['New Objective', 'Project Discussion', 'Dismiss']);
  assert.equal(document.getElementById(buttons[0].getAttribute('aria-describedby')).textContent,
    i18n.LOCALES.en['firstPrompt.objectiveHint']);
  assert.equal(overlay.querySelector('.first-prompt-note').textContent, 'Both stay in the left menu: Create and Start Chat.');
  assert.equal(document.activeElement, buttons[0], 'New Objective has the focus');
  assert.equal(document.getElementById('app').inert, true, 'the board behind is inert');
  assert.equal(dialogFocus.hasOpenDialog(), true);

  buttons[1].click();
  assert.equal(await pending, 'discuss');
  await flush();
  assert.equal(document.getElementById('first-project-prompt'), null, 'closed');
  assert.notEqual(document.getElementById('app').inert, true, 'the board is interactive again');
  assert.equal(dialogFocus.hasOpenDialog(), false);
});

test('the modal: Escape and the backdrop dismiss it, a click inside the card does not', async () => {
  reset();
  let pending = prompt.showFirstProjectPrompt();
  await flush();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(await pending, 'dismiss');

  pending = prompt.showFirstProjectPrompt();
  await flush();
  let overlay = document.getElementById('first-project-prompt');
  overlay.querySelector('.first-prompt-question').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
  assert.ok(document.getElementById('first-project-prompt'), 'a click on the card text keeps it open');
  overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(await pending, 'dismiss');

  pending = prompt.showFirstProjectPrompt();
  await flush();
  overlay = document.getElementById('first-project-prompt');
  overlay.querySelector('[data-choice="objective"] .first-prompt-choice-label').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(await pending, 'objective', 'a click on a choice\'s inner text picks that choice');
  await flush();
  assert.equal(dialogFocus.hasOpenDialog(), false);
});

test('the modal follows the project language (Ukrainian, Chinese, Spanish)', async () => {
  for (const locale of ['uk', 'zh', 'es']) {
    reset();
    i18n.setLocale(locale);
    const pending = prompt.showFirstProjectPrompt();
    await flush();
    const overlay = document.getElementById('first-project-prompt');
    const table = i18n.LOCALES[locale];
    assert.equal(overlay.querySelector('.first-prompt-title').textContent, table['firstPrompt.title'], locale);
    assert.equal(overlay.querySelector('#first-prompt-discuss-label').textContent, table['firstPrompt.discuss'], locale);
    assert.ok(overlay.querySelector('.first-prompt-note').textContent.includes(table['nav.startChat']), `${locale} note names Start Chat`);
    overlay.querySelector('[data-choice="dismiss"]').click();
    assert.equal(await pending, 'dismiss');
    await flush();
  }
  i18n.setLocale('en');
});

test('every locale has the prompt copy, distinct from English outside en', () => {
  const keys = ['title', 'question', 'objective', 'objectiveHint', 'discuss', 'discussHint', 'note', 'dismiss']
    .map((k) => `firstPrompt.${k}`);
  for (const [locale, table] of Object.entries(i18n.LOCALES)) {
    for (const key of keys) {
      assert.ok(table[key]?.trim(), `${locale}.${key}`);
      if (locale !== 'en') assert.notEqual(table[key], i18n.LOCALES.en[key], `${locale}.${key} is translated`);
    }
    assert.match(table['firstPrompt.note'], /\{create\}/);
    assert.match(table['firstPrompt.note'], /\{chat\}/);
  }
});

test('busy: left the board, a terminal, another dialog or an unlayered overlay', async () => {
  reset();
  document.body.insertAdjacentHTML('beforeend',
    '<div id="project-choose-modal" style="display:none"></div><div id="project-rename-modal" style="display:none"></div>');
  assert.equal(prompt.firstPromptWindowBusy(), false, 'on the board, nothing open');
  state.activeTab = 'backlog';
  assert.equal(prompt.firstPromptWindowBusy(), false, 'another board view still counts as the board');
  state.activeTab = 'objective';
  assert.equal(prompt.firstPromptWindowBusy(), true, 'already in the Create section');
  state.activeTab = 'board';
  state.activeTerminal = { taskId: 'TPT1' };
  assert.equal(prompt.firstPromptWindowBusy(), true, 'a terminal is open');
  state.activeTerminal = null;
  document.getElementById('project-choose-modal').style.display = 'flex';
  assert.equal(prompt.firstPromptWindowBusy(), true, 'Get Started is up');
  document.getElementById('project-choose-modal').style.display = 'none';
  const settings = document.createElement('div');
  settings.innerHTML = '<button>x</button>';
  document.body.appendChild(settings);
  const layer = dialogFocus.activateDialogFocus({ root: settings });
  assert.equal(prompt.firstPromptWindowBusy(), true, 'another dialog is open');
  layer.close();
  assert.equal(prompt.firstPromptWindowBusy(), false);
  document.body.insertAdjacentHTML('beforeend', '<input class="search-input" type="text"><input id="tick" type="checkbox">');
  document.querySelector('.search-input').focus();
  assert.equal(prompt.firstPromptWindowBusy(), true, 'the user is typing in the board search');
  document.getElementById('tick').focus();
  assert.equal(prompt.firstPromptWindowBusy(), false, 'a focused checkbox takes no typing');
  document.getElementById('tick').blur();
});

test('index.js runs the check after each board render with the two openers', () => {
  assert.match(indexSrc, /import \* as firstProjectPrompt from '\.\/first-project-prompt\.js';/);
  const at = indexSrc.indexOf("document.addEventListener('tiptask:rendered'");
  assert.notEqual(at, -1, 'listens for the board render');
  const block = indexSrc.slice(at, indexSrc.indexOf('\n});', at));
  assert.match(block, /firstProjectPrompt\.maybeShowFirstProjectPrompt\(\{/);
  assert.match(block, /openObjective: \(\) => window\.TipTask\.openNewObjectiveForm\?\.\(\{ focus: true \}\)/);
  assert.match(block, /openProjectChat: \(\) => taskChat\.openProjectChat\(\)/);
});

test('template.html: the shared New Objective opener and the post-render event', () => {
  assert.match(templateSrc, /async function openNewObjectiveForm\(\{ focus = false \} = \{\}\) \{\n  state\.activeTab = 'objective';\n  sessionStorage\.setItem\(ACTIVE_NEW_TAB_KEY, 'objective'\);\n  await loadAndRender\(\{ scrollToTop: true \}\);/);
  assert.match(templateSrc, /window\.TipTask\.openNewObjectiveForm = openNewObjectiveForm;/);
  assert.match(templateSrc, /emptyObjectiveBtn\.addEventListener\('click', \(\) => \{ void openNewObjectiveForm\(\); \}\);/);
  // 'tiptask:rendered' fires only at the end of a successful full render, after the offline
  // banner is cleared — a failed load (renderTaskLoadError) never reaches it.
  const fired = templateSrc.indexOf("document.dispatchEvent(new Event('tiptask:rendered'));");
  assert.notEqual(fired, -1);
  assert.ok(templateSrc.lastIndexOf('stopOfflineRetry();', fired) > templateSrc.lastIndexOf('async function _loadAndRenderImpl', fired));
});
