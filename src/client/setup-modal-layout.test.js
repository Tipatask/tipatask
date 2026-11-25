import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9386) The create wizard and setup-modal.js (setup, re-auth, account and import modes) are
// fixed-size dialogs: one panel size on every step, sized by the window and never by the step,
// with the header, the progress dots and the Back / Next footer as fixed rows around the one
// scrolling step body. CSS isn't executable under node, so the size rules are source-scanned (as
// settings-modal-layout.test.js does for Settings), and the markup those rules rely on is checked
// on every step of the real modules in happy-dom. Edit Agents shares the panel classes but keeps
// its own content-sized panel.

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Split a selector list on its top-level commas (`:has(a, b)` stays whole).
function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

// Every style rule as { selectors, body, media }; @media / @supports blocks are walked, other
// at-rules (keyframes, font-face) skipped.
const RULES = (() => {
  const out = [];
  const walk = (src, media) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      let prelude = src.slice(i, open);
      prelude = prelude.slice(prelude.lastIndexOf(';') + 1).trim();
      const inner = src.slice(open + 1, j - 1);
      if (/^@(media|supports)\b/.test(prelude)) walk(inner, prelude);
      else if (!prelude.startsWith('@')) out.push({ selectors: splitSelectors(prelude), body: inner, media });
      i = j;
    }
  };
  walk(css, null);
  return out;
})();

// The top-level rule whose selector list contains exactly `selector`.
function rule(selector) {
  const found = RULES.filter((r) => !r.media && r.selectors.includes(selector));
  assert.ok(found.length, `no rule for ${selector}`);
  return found.map((r) => r.body).join(';');
}

function decl(body, prop) {
  const m = body.match(new RegExp(String.raw`(?:^|[;{\s])${prop}\s*:\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

// The last compound of a selector (after its last top-level combinator).
function subject(selector) {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) last = i + 1;
  }
  return selector.slice(last);
}

const SIZE_PROPS = ['width', 'max-width', 'min-width', 'height', 'max-height', 'min-height'];

test('the wizards share one panel size, sized by the window and never by the step', () => {
  const fixed = rule('.setup-modal > .setup-modal-panel');
  assert.equal(decl(fixed, 'width'), 'min(820px, 92vw)');
  assert.equal(decl(fixed, 'height'), 'min(660px, 92vh)');
  assert.equal(decl(fixed, 'max-width'), 'none', 'the base 520px cap must not narrow it');
  const base = rule('.setup-modal-panel');
  assert.equal(decl(base, 'display'), 'flex');
  assert.equal(decl(base, 'flex-direction'), 'column');
  assert.equal(decl(base, 'overflow'), 'hidden');
});

test('nothing else sizes a wizard panel: the :has() widening belongs to Edit Agents alone', () => {
  const allowed = new Set(['.setup-modal-panel', '.setup-modal > .setup-modal-panel']);
  for (const r of RULES) {
    for (const selector of r.selectors) {
      if (!subject(selector).includes('.setup-modal-panel')) continue;
      const sizes = SIZE_PROPS.filter((p) => decl(r.body, p) !== null);
      if (!sizes.length) continue;
      assert.ok(allowed.has(selector) || /^\.(agents-modal|merge-modal) /.test(selector),
        `${selector}${r.media ? ` (${r.media})` : ''} sets ${sizes.join(', ')} on a wizard panel`);
      if (selector.includes(':has(')) assert.match(selector, /^\.agents-modal /, `${selector} widens the wizards per step again`);
    }
  }
  const widen = RULES.find((r) => r.selectors.some((s) => s.startsWith('.agents-modal .setup-modal-panel:has(')));
  assert.ok(widen, 'Edit Agents still widens once it holds the agent picker');
  const has = widen.selectors.find((s) => s.startsWith('.agents-modal .setup-modal-panel:has('));
  for (const seed of ['.setup-modal-agent-grid', '.setup-modal-agent-empty', '#agents-modal-grid']) assert.ok(has.includes(seed), seed);
  assert.equal(decl(widen.body, 'max-width'), '820px');
  assert.equal(decl(widen.body, 'height'), null, 'Edit Agents keeps its content-sized height');
});

test('the header, the dots and the footer are fixed rows; the step body is the one scroll region', () => {
  for (const row of ['.setup-modal-header', '.setup-modal-steps', '.setup-modal-footer']) {
    assert.equal(decl(rule(row), 'flex-shrink'), '0', `${row} never shrinks`);
  }
  const body = rule('.setup-modal-step-body');
  assert.equal(decl(body, 'flex'), '1');
  assert.equal(decl(body, 'overflow-y'), 'auto');
  assert.equal(decl(body, 'overflow-x'), 'hidden');
  const wizardBody = rule('.setup-modal .setup-modal-step-body');
  assert.equal(decl(wizardBody, 'min-height'), '0', 'a short window shrinks the body, never clips the footer');
  assert.equal(decl(wizardBody, 'scrollbar-gutter'), 'stable', 'scrolling and short steps keep one content width');
  const grid = rule('.setup-modal .setup-modal-agent-grid');
  assert.equal(decl(grid, 'max-height'), 'none', 'no second scroll region inside the body');
  assert.equal(decl(grid, 'overflow-y'), 'visible');
});

test('the header keeps its path line while the path is empty', () => {
  const path = rule('.setup-modal-header-path');
  const lh = decl(path, 'line-height');
  assert.match(lh, /^\d+(\.\d+)?$/, 'a unitless line-height');
  assert.equal(decl(path, 'min-height'), `${lh}em`, 'the empty line is exactly as tall as a filled one');
});

// (TPT9388) One look on every setup step: the setup cards share one radius, edge, hover and focus
// ring; dividers, card edges and the secondary outline mix the text colour (the mocha, nord, rose
// and ink palettes set --c-border to their card colour, so a --c-border edge vanishes there);
// buttons change colour, never opacity, on hover.
test('setup cards, dividers and buttons share one edge, radius, hover and focus state', () => {
  const panel = rule('.setup-modal-panel');
  assert.equal(decl(panel, '--setup-edge'), 'color-mix(in srgb, var(--c-text) 13%, transparent)');
  assert.equal(decl(panel, '--setup-edge-strong'), 'color-mix(in srgb, var(--c-text) 26%, transparent)');
  for (const row of ['.setup-modal-header', '.setup-modal-steps']) assert.match(decl(rule(row), 'border-bottom'), /var\(--setup-edge,/, row);
  assert.match(decl(rule('.setup-modal-footer'), 'border-top'), /var\(--setup-edge,/);
  for (const card of ['.setup-modal-project-card', '.setup-modal-preset-card', '.wizard-work-card']) {
    const body = rule(card);
    assert.equal(decl(body, 'border-radius'), '8px', `${card} radius`);
    assert.match(decl(body, 'border'), /var\(--setup-edge,/, `${card} edge`);
    assert.match(rule(`${card}:hover`), /var\(--setup-edge-strong,/, `${card} hover edge`);
  }
  for (const focus of ['.setup-modal-project-card:focus-visible', '.setup-modal-preset-card:focus-visible',
    '.setup-modal-btn:focus-visible', '.setup-modal-close:focus-visible']) {
    assert.equal(decl(rule(focus), 'outline'), '2px solid var(--c-primary-border)', focus);
  }
  assert.match(decl(rule('.setup-modal-btn--secondary'), 'border-color'), /var\(--setup-edge-strong,/);
  assert.doesNotMatch(decl(rule('.setup-modal-btn'), 'transition'), /opacity/);
  assert.match(decl(rule('.setup-modal-btn'), 'line-height'), /^\d+(\.\d+)?$/, 'one footer height in every language');
  const project = rule('.setup-modal .setup-modal-project-list');
  assert.equal(decl(project, 'max-height'), 'none', 'no second scroll region inside the body');
  assert.equal(decl(project, 'overflow-y'), 'visible');
});

test('the Description-step classes retired by C1096 are gone', () => {
  for (const cls of ['setup-modal-tabs', 'setup-modal-tab', 'setup-modal-tab-panel', 'setup-modal-textarea',
    'setup-modal-audio-panel', 'setup-modal-audio-file-label', 'setup-modal-audio-file-input']) {
    assert.doesNotMatch(css, new RegExp(String.raw`\.${cls}(?![\w-])`), cls);
  }
  assert.doesNotMatch(css, /\.setup-modal-dot\.is-skipped/);
});

test('the backward and the forward action hold the footer\'s two edges', () => {
  assert.equal(decl(rule('.setup-modal-footer'), 'justify-content'), 'flex-end');
  assert.equal(decl(rule('.setup-modal .setup-modal-footer > .setup-modal-btn--secondary:first-child'), 'margin-right'), 'auto');
});

// ── The real modules in happy-dom ────────────────────────────────────────────────────────────

const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Other Model', available: true },
];

async function withModules(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-setup-modal-layout-'));
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
  install('fetch', async (url) => {
    const u = String(url);
    const body = u.startsWith('/api/pi/models') ? [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }] : [];
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: {
        contents: `export * as wizard from './src/client/project-creation-wizard.js';
          export * as setup from './src/client/setup-modal.js';
          export * as agents from './src/client/agents-modal.js';`,
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'modules.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const mods = await import(pathToFileURL(bundle).href);
    const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
    try { await run({ ...mods, flush }); } finally { mods.wizard.close(); mods.setup.close(); mods.agents.closeAgentsModal(); }
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const STEP_MARKERS = {
  signin: '#wiz-signin-btn, #setup-signin-btn',
  signedIn: '#wiz-switch-btn, #setup-switch-btn',
  project: '#wiz-proj-list, #setup-proj-list',
  profile: '[data-preview]',
  device: '#wiz-device-input, #setup-device-input',
  agent: '#wiz-agent-select, #setup-agent-select',
  work: '.wizard-work-grid',
  onboarding: '.setup-modal-preset-grid',
  name: '#setup-import-name',
  folder: '#setup-import-folder-btn',
  confirm: '.setup-modal-summary',
};

// The shell the size rules rely on, read off the live overlay: a .setup-modal root on <body>
// whose panel holds exactly header, dots, step body and footer, in that order; the header always
// has its path line; the footer starts with a secondary (backward) button and, when it has more
// than one, ends with the primary (forward) one. Returns which step is showing.
function shell(rootSelector) {
  const root = document.querySelector(rootSelector);
  assert.ok(root, `${rootSelector} is open`);
  assert.equal(root.parentElement, document.body, 'the overlay root sits on <body>');
  assert.ok(root.classList.contains('setup-modal'), 'a .setup-modal root, so the fixed panel size applies');
  const panel = [...root.children].find((el) => el.classList.contains('setup-modal-panel'));
  assert.ok(panel, 'the panel is a direct child of the root');
  assert.deepEqual([...panel.children].map((el) => el.className.split(' ')[0]),
    ['setup-modal-header', 'setup-modal-steps', 'setup-modal-step-body', 'setup-modal-footer']);
  assert.ok(panel.querySelector('.setup-modal-header > .setup-modal-header-text > .setup-modal-header-path'), 'the path line is always rendered');
  assert.ok(panel.querySelectorAll('.setup-modal-steps > .setup-modal-dot').length >= 2, 'the dots are rendered');
  const buttons = [...panel.querySelector('.setup-modal-footer').children];
  assert.ok(buttons.length >= 1 && buttons.every((b) => b.matches('button.setup-modal-btn')), 'the footer holds only buttons');
  assert.ok(buttons[0].classList.contains('setup-modal-btn--secondary'), `the backward action leads: ${buttons[0].id}`);
  if (buttons.length > 1) assert.ok(buttons.at(-1).classList.contains('setup-modal-btn--primary'), `the forward action ends: ${buttons.at(-1).id}`);
  const step = Object.entries(STEP_MARKERS).find(([, sel]) => panel.querySelector(sel));
  return step ? step[0] : 'unknown';
}

const setVal = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };

test('create wizard: all seven steps render the same fixed shell inside a .setup-modal root', async () => {
  const electronAPI = {
    setupStoredAccount: async () => null,
    setupProjectProfile: async () => ({ policy: { rules: {} } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => AGENTS,
  };
  await withModules(electronAPI, async ({ wizard, flush }) => {
    // Not signed in yet, and the locked first-run variant (no ×). These come first: the wizard
    // keeps an in-memory sign-in across opens.
    for (const locked of [false, true]) {
      wizard.open({ projectPath: '/work/acme', locked });
      await flush();
      assert.equal(shell('.wizard-modal'), 'signin');
      wizard.close();
    }

    electronAPI.setupStoredAccount = async () => ({ token: 'tok', user: { email: 'dev@example.test' } });
    const seen = [];
    const $ = (sel) => document.querySelector(`.wizard-modal ${sel}`);
    wizard.open({ projectPath: '/work/acme' });
    await flush();
    seen.push(shell('.wizard-modal'));
    $('#wiz-new-card').click();
    setVal($('#wiz-proj-name'), 'Acme');
    $('#wiz-next-btn').click();
    await flush();
    seen.push(shell('.wizard-modal'));
    $('#wiz-next-btn').click();
    await flush();
    seen.push(shell('.wizard-modal'));
    $('#wiz-next-btn').click();
    seen.push(shell('.wizard-modal')); // agent detection still running
    await flush();
    seen.push(shell('.wizard-modal'));
    $('#wiz-next-btn').click();
    seen.push(shell('.wizard-modal'));
    $('[value="software"]').click();
    $('#wiz-next-btn').click();
    seen.push(shell('.wizard-modal'));
    $('.setup-modal-preset-card[data-letter="A"]').click();
    $('#wiz-next-btn').click();
    seen.push(shell('.wizard-modal'));
    for (let i = 0; i < 7; i += 1) $('#wiz-back-btn').click();
    seen.push(shell('.wizard-modal'));
    assert.deepEqual(seen, ['project', 'profile', 'device', 'agent', 'agent', 'work', 'onboarding', 'confirm', 'signedIn']);
  });
});

test('setup modal: setup, import and account modes render the same fixed shell on every step', async () => {
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'dev@example.test' } }),
    setupProjectProfile: async () => ({ policy: { rules: {} } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => AGENTS,
    selectFolder: async () => '/work/imported',
    checkImportFolder: async () => ({ ok: true, folder: '/work/imported', blocked: null, existingKbFiles: [] }),
    cancelProjectImport: () => {},
  };
  await withModules(electronAPI, async ({ setup, flush }) => {
    const $ = (sel) => document.querySelector(`.setup-modal ${sel}`);
    const seen = [];
    setup.open({ projectPath: '/work/acme' });
    await flush();
    seen.push(shell('.setup-modal'));
    $('.setup-modal-project-card').click();
    $('#setup-next-btn').click();
    await flush();
    seen.push(shell('.setup-modal'));
    $('#setup-next-btn').click();
    await flush();
    seen.push(shell('.setup-modal'));
    $('#setup-next-btn').click();
    await flush();
    seen.push(shell('.setup-modal'));
    $('#setup-next-btn').click();
    seen.push(shell('.setup-modal'));
    for (let i = 0; i < 5; i += 1) $('#setup-back-btn').click();
    seen.push(shell('.setup-modal'));
    assert.deepEqual(seen, ['project', 'profile', 'device', 'agent', 'confirm', 'signedIn']);
    setup.close();

    // Import mode: the header's path stays empty until the folder is picked.
    const imported = [];
    setup.openImport({ importId: 'imp-1', archiveName: 'acme.zip', summary: { projectName: 'Acme', taskCount: 3, sprintCount: 1, kbFileCount: 2 } });
    await flush();
    imported.push(shell('.setup-modal'));
    assert.equal($('.setup-modal-header-path').textContent, '', 'no folder yet: an empty path line');
    $('#setup-next-btn').click();
    imported.push(shell('.setup-modal'));
    $('#setup-import-folder-btn').click();
    await flush();
    imported.push(shell('.setup-modal'));
    assert.equal($('.setup-modal-header-path').dataset.path, '/work/imported');
    $('#setup-next-btn').click();
    await flush();
    imported.push(shell('.setup-modal'));
    $('#setup-next-btn').click();
    imported.push(shell('.setup-modal'));
    assert.deepEqual(imported, ['name', 'folder', 'folder', 'agent', 'confirm']);
    setup.close();

    setup.openReauth({ projectPath: null, existingConfig: {}, accountOnly: true });
    await flush();
    assert.equal(shell('.setup-modal'), 'signin');
  });
});

test('Edit Agents keeps its own panel: an .agents-modal root, never a .setup-modal one', async () => {
  await withModules({ setupGetAvailableAgents: async () => AGENTS }, async ({ agents, flush }) => {
    agents.openAgentsModal();
    await flush();
    const root = document.querySelector('.agents-modal');
    assert.ok(root, 'Edit Agents is open');
    assert.equal(root.classList.contains('setup-modal'), false, 'the fixed wizard size cannot match it');
    assert.equal(document.querySelector('.setup-modal'), null);
    const panel = root.querySelector(':scope > .setup-modal-panel');
    assert.ok(panel.querySelector('#agents-modal-grid .setup-modal-agent-grid'), 'the :has() widening finds its picker');
  });
});

// The step body, not the agent grid, scrolls in the fixed-size wizards, so the Pi model
// suggestions (portaled to <body>, placed at the input's rect) close when a scroller that holds
// the input moves it — but not for their own scroll, an unrelated scroller, the document, or the
// scroll that focusing the input starts just before the list opens.
test('Pi model suggestions close when the step body scrolls the input away, and only then', async () => {
  const electronAPI = {
    setupStoredAccount: async () => ({ token: 'tok', user: { email: 'dev@example.test' } }),
    setupProjectProfile: async () => ({ policy: { rules: {} } }),
    setupListProjects: async () => [{ id: 7, name: 'Proj' }],
    setupGetDeviceName: async () => 'Mac',
    setupGetAvailableAgents: async () => AGENTS,
  };
  await withModules(electronAPI, async ({ wizard, flush }) => {
    const $ = (sel) => document.querySelector(sel);
    wizard.open({ projectPath: '/work/acme' });
    await flush();
    $('.setup-modal-project-card[data-id="7"]').click();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('#wiz-next-btn').click();
    await flush();
    $('.sma-pi-add').click();
    const input = $('.sma-pi-model');
    assert.ok(input, 'the Pi model form is open');
    let top = 300;
    input.getBoundingClientRect = () => ({ top, left: 40, bottom: top + 30, right: 340, width: 300, height: 30, x: 40, y: top });
    const isOpen = () => !!$('.sma-pi-suggest');
    const scroll = (el) => el.dispatchEvent(new Event('scroll'));
    const reopen = async () => { input.blur(); await flush(); input.focus(); await flush(); assert.ok(isOpen(), 'the list opened'); };
    const body = $('.wizard-modal .setup-modal-step-body');
    const outside = document.body.appendChild(document.createElement('div'));

    await reopen();
    scroll(body);
    assert.ok(isOpen(), 'a body scroll that left the input where the list was placed keeps it (focus scroll)');
    scroll($('.sma-pi-suggest'));
    scroll(outside);
    scroll(document);
    assert.ok(isOpen(), 'its own scroll, an unrelated scroller and the document leave it open');
    top = 260;
    scroll(body);
    assert.equal(isOpen(), false, 'the body scrolled the input away: the list closes');
    assert.equal(input.getAttribute('aria-expanded'), 'false');

    await reopen();
    top = 200;
    scroll($('.wizard-modal .setup-modal-agent-grid'));
    assert.equal(isOpen(), false, 'any scroller holding the input closes it once the input moved');
  });
});
