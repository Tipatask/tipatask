import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { LOCALES } from './i18n.js';

// (TPT9156) Settings > Voice > Mode end to end on the real client modules: task-board.js and
// audio-recorder.js bundled together (one recorder store, as in the app) in happy-dom, with the
// real Settings markup from template.html. The fetch double answers /api/project-config through
// the server's own rendererProjectConfig()/mergeRendererProjectConfig(), so `store.config` holds
// exactly what .tipatask/config.json would. Each renderer imports a fresh copy of the bundle — a
// new module state over the same stored config, which is what an app restart is.
const require = createRequire(import.meta.url);
const { rendererProjectConfig, mergeRendererProjectConfig } = require('../server/project-config.js');

const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const modalMarkup = html.slice(html.indexOf('<div id="settings-modal"'), html.indexOf('<!-- (C1388)'));
const en = LOCALES.en;
const uk = LOCALES.uk;

const scratch = mkdtempSync(join(tmpdir(), 'tt-voice-mode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let bundled = null;
let renderers = 0;

function bundle() {
  bundled ??= build({
    stdin: { contents: `export * as board from './src/client/task-board.js';
      export * as recorder from './src/client/audio-recorder.js';
      export * as i18n from './src/client/i18n.js';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'terminal-double', setup(b) {
      b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
      b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
        export class FitAddon { fit() {} }
        export class Terminal { loadAddon() {} open() {} dispose() {} }` }));
    } }],
  }).then((result) => {
    const file = join(scratch, 'client.mjs');
    writeFileSync(file, result.outputFiles[0].contents);
    return pathToFileURL(file).href;
  });
  return bundled;
}

// Browser mode (no window.electronAPI): every config read/write goes over fetch.
function fetchDouble(store) {
  return async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (path === '/api/project-config' && method === 'GET') {
      return reply({ projectPath: '/project', config: rendererProjectConfig(store.config) });
    }
    if (path === '/api/project-config' && method === 'POST') {
      const body = JSON.parse(opts.body);
      store.posts.push(body);
      if (store.failWrites) return reply({ error: 'disk full' }, 500);
      store.config = mergeRendererProjectConfig(store.config, body, { allowApiToken: true });
      return reply({ ok: true });
    }
    if (path === '/api/voice-models') return reply({ models: [] });
    return reply({});
  };
}

async function withRenderer(store, run) {
  const href = await bundle();
  const window = new Window({ url: 'http://localhost:4455/' });
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
  install('fetch', fetchDouble(store));
  try {
    const api = await import(`${href}?renderer=${++renderers}`);
    window.document.body.innerHTML = modalMarkup;
    api.board.initSettingsModal(); // the boot path: wires Settings and reads the voice settings
    await api.board.refreshVoiceInputAvailability(); // joins that boot read
    const doc = window.document;
    const modal = doc.getElementById('settings-modal');
    const radio = mode => doc.getElementById(`settings-voice-mode-${mode}`);
    const hint = () => doc.getElementById('settings-voice-mode-hint').textContent;
    // openSettingsModal() fills the Voice tab after an async config read; the hint is cleared
    // first so the wait below sees this open's fill, not the previous one.
    async function open() {
      doc.getElementById('settings-voice-mode-hint').textContent = '';
      api.board.openSettingsModal();
      await until(() => hint() !== '', 'the Voice tab populated');
      modal.querySelector('.modal-tab-btn[data-tab="voice"]').click();
    }
    function pick(mode) {
      const el = radio(mode);
      el.checked = true;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    await run({ ...api, window, doc, modal, radio, hint, open, pick });
    await new Promise(resolve => setTimeout(resolve, 30)); // let the other tab populators settle
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const project = extra => ({ config: { API_PROJECT_ID: '1', ...extra }, posts: [] });

test('the saved mode is live once the project loads; a missing or unknown one counts as standard', async () => {
  for (const [saved, expected] of [[undefined, 'standard'], ['thankyou', 'thankyou'], ['standard', 'standard'], ['ThankYou', 'standard'], [42, 'standard']]) {
    const store = project(saved === undefined ? {} : { voiceMode: saved });
    await withRenderer(store, ({ recorder }) => {
      assert.equal(recorder.getVoiceMode(), expected, `saved ${JSON.stringify(saved)}`);
    });
    assert.deepEqual(store.posts, [], 'loading never writes the mode back');
  }
});

test('the Mode row renders in the Voice tab Input section as a labelled two-option radio group', async () => {
  await withRenderer(project({}), async ({ doc, modal, radio, hint, open }) => {
    await open();
    const row = doc.getElementById('settings-voice-mode-row');
    const voicePane = modal.querySelector('.modal-tab-panel[data-tab="voice"]');
    assert.equal(voicePane.hidden, false);
    assert.ok(row.closest('section').querySelector('#settings-voice-input-title'), 'the row sits in the Input section');
    assert.ok(row.matches('.settings-row') && row.children[0].matches('.settings-row-label') && row.children[1].matches('.settings-row-control'));
    const group = row.querySelector('[role="radiogroup"]');
    assert.ok(group.classList.contains('settings-segmented'), 'drawn as the shared segmented control');
    assert.equal(group.getAttribute('aria-labelledby'), 'settings-voice-mode-label');
    assert.equal(group.getAttribute('aria-describedby'), 'settings-voice-mode-hint');
    assert.deepEqual([...group.querySelectorAll('input[type="radio"]')].map(el => [el.name, el.value]),
      [['settings-voice-mode', 'standard'], ['settings-voice-mode', 'thankyou']]);
    assert.equal(doc.getElementById('settings-voice-mode-label').textContent, en['settings.voiceMode']);
    assert.equal(doc.getElementById('settings-voice-mode-standard-label').textContent, en['settings.voiceModeStandard']);
    assert.equal(doc.getElementById('settings-voice-mode-thankyou-label').textContent, en['settings.voiceModeThankYou']);
    assert.equal(radio('standard').checked, true, 'no saved mode checks Standard');
    assert.equal(radio('thankyou').checked, false);
    assert.equal(hint(), en['settings.voiceModeStandardHint']);
  });
});

test('the row follows the project language', async () => {
  await withRenderer(project({ voiceMode: 'thankyou' }), async ({ i18n, doc, hint, open }) => {
    i18n.setLocale('uk');
    await open();
    assert.equal(doc.getElementById('settings-voice-mode-label').textContent, uk['settings.voiceMode']);
    assert.equal(doc.getElementById('settings-voice-mode-standard-label').textContent, uk['settings.voiceModeStandard']);
    assert.equal(doc.getElementById('settings-voice-mode-thankyou-label').textContent, uk['settings.voiceModeThankYou']);
    assert.equal(hint(), uk['settings.voiceModeThankYouHint']);
  });
});

test('a picked mode applies at once, is saved, and survives reopening Settings and restarting the app', async () => {
  const store = project({ voiceMode: 'standard', voicePreset: 'assemblyai' });
  await withRenderer(store, async ({ board, recorder, radio, hint, open, pick }) => {
    await open();
    pick('thankyou');
    assert.equal(recorder.getVoiceMode(), 'thankyou', 'live before the save round-trips');
    assert.equal(hint(), en['settings.voiceModeThankYouHint']);
    await until(() => store.config.voiceMode === 'thankyou', 'the save');
    assert.deepEqual(store.posts, [{ voiceMode: 'thankyou' }], 'one partial write carrying only the mode');
    assert.equal(store.config.voicePreset, 'assemblyai', 'the other voice settings are untouched');

    board.closeSettingsModal();
    radio('thankyou').checked = false; // prove the reopen re-reads the saved value
    await open();
    assert.equal(radio('thankyou').checked, true, 'reopened Settings shows the saved mode');
    assert.equal(radio('standard').checked, false);
  });
  await withRenderer(store, async ({ recorder, radio, hint, open }) => {
    assert.equal(recorder.getVoiceMode(), 'thankyou', 'the restarted app starts in the saved mode');
    await open();
    assert.equal(radio('thankyou').checked, true);
    assert.equal(hint(), en['settings.voiceModeThankYouHint']);
  });
});

test('a failed save keeps the picked mode live and says so', async () => {
  const store = project({});
  store.failWrites = true;
  await withRenderer(store, async ({ recorder, doc, open, pick }) => {
    await open();
    pick('thankyou');
    assert.equal(recorder.getVoiceMode(), 'thankyou');
    const message = en['settings.voiceModeSaveFailed'].replace('{msg}', 'HTTP 500'); // writeProjectVoiceSettings()'s browser-mode error
    await until(() => doc.body.textContent.includes(message), 'the failure toast');
    assert.equal(store.config.voiceMode, undefined, 'nothing was stored');
  });
});

test('a config read already in flight never reverts a mode picked meanwhile', async () => {
  const store = project({ voiceMode: 'standard' });
  await withRenderer(store, async ({ board, recorder, radio, open, pick }) => {
    await open();
    const staleRead = board.refreshVoiceInputAvailability(); // reads 'standard' right now
    pick('thankyou');
    await staleRead;
    assert.equal(recorder.getVoiceMode(), 'thankyou');
    assert.equal(radio('thankyou').checked, true);
    await until(() => store.config.voiceMode === 'thankyou', 'the save');
  });
});
