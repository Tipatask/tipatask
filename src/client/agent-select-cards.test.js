import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { renderAgentSelect, setPiProviders } from './agent-select.js';
import { LOCALES } from './i18n.js';

// (TPT9387) The agent picker reads as one list: each card lays its cells on the grid's five shared
// columns (enable switch | dot · name · status | badge | ✎ × | Default pill), the name cell is a
// second <label> for the card's Default radio, and every inline control hands keyboard focus to a
// sensible neighbour when the grid is rebuilt under it. The host contract stays: `data-id`,
// `data-pi-idx`, the one `sma-default` radio group and the onChange payload.

setPiProviders([
  { id: 'openrouter', label: 'OpenRouter', keyRequired: true, supportsBaseUrl: false },
  { id: 'custom', label: 'Custom endpoint', keyRequired: false, supportsBaseUrl: true },
]);

const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: true },
];
const KIMI = { model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-x' };
const GLM = { model: 'openrouter/z-ai/glm-5', apiKey: 'sk-or-y' };
const RECRAFT = { model: 'recraft-v3', apiKey: '', provider: 'custom', baseUrl: 'https://example.test/v1', tools: false };
const IMAGE = { model: 'openrouter/black-forest-labs/flux-1.1-pro', apiKey: 'sk-or-z', purpose: 'image' };
const VALUE = { availableAgents: ['claude', 'pi'], taskAgent: 'claude', piModels: [KIMI, GLM] };

function installGlobals(entries) {
  const saved = new Map();
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

// One or more renderAgentSelect() pickers in a fresh document (each `opts` entry is one picker).
async function withPickers(list, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const restore = installGlobals({ document: window.document, fetch: async () => ({ ok: true, json: async () => [] }) });
  try {
    const payloads = [];
    const containers = list.map(({ agents = AGENTS, value = VALUE, ...rest }) => {
      const container = window.document.createElement('div');
      window.document.body.append(container);
      renderAgentSelect(container, { agents, value: structuredClone(value), onChange: (p) => payloads.push(p), ...rest });
      return container;
    });
    const $ = (sel) => containers[0].querySelector(sel);
    const $$ = (sel) => [...containers[0].querySelectorAll(sel)];
    const change = (el, props) => {
      Object.assign(el, props);
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    await run({ window, $, $$, containers, change, payloads, last: () => payloads.at(-1), active: () => window.document.activeElement });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    restore();
    await window.happyDOM.abort();
  }
}
const withPicker = (opts, run) => withPickers([opts], run);
const card = ($, id, piIdx) => $(`.setup-modal-agent-card[data-id="${id}"]${piIdx === undefined ? '' : `[data-pi-idx="${piIdx}"]`}`);

test('each card: an agent-named switch, a name cell that labels the card\'s Default radio, one radio group', async () => {
  await withPicker({}, async ({ $, $$ }) => {
    const claude = card($, 'claude');
    const sw = claude.querySelector('input.sma-cb');
    assert.equal(sw.getAttribute('role'), 'switch');
    assert.equal(sw.getAttribute('aria-label'), 'Claude Code');
    assert.equal(sw.checked, true);
    assert.equal(card($, 'pi', 1).querySelector('input.sma-cb').getAttribute('aria-label'), 'OpenRouter · z-ai/glm-5');

    const radios = $$('input.sma-radio');
    assert.deepEqual(radios.map((r) => r.name), radios.map(() => 'sma-default'), 'one radio group');
    assert.deepEqual(radios.map((r) => r.value), ['claude', 'codex', 'pi', 'pi'], 'every Pi radio is the literal pi');
    for (const radio of radios) {
      const cardEl = radio.closest('.setup-modal-agent-card');
      const ident = cardEl.querySelector('.setup-modal-agent-ident');
      assert.equal(ident.tagName, 'LABEL', `${cardEl.dataset.id}: the name cell is a label`);
      assert.equal(ident.getAttribute('for'), radio.id, `${cardEl.dataset.id}: …for this card's radio`);
      assert.equal(radio.closest('label').classList.contains('setup-modal-agent-default-wrap'), true, 'inside the Default pill');
      assert.ok(radio.closest('label').querySelector('.setup-modal-agent-default-mark'), 'with its ring/tick mark');
    }
    assert.equal(new Set(radios.map((r) => r.id)).size, radios.length, 'radio ids are unique');
    // Cell order is the column order the grid lays them out in.
    assert.deepEqual([...card($, 'pi', 0).children].map((el) => el.className.split(' ')[0]),
      ['sma-cb', 'setup-modal-agent-ident', 'setup-modal-agent-actions', 'setup-modal-agent-default-wrap']);
  });
});

test('two pickers in one document never share a radio id', async () => {
  await withPickers([{}, {}], async ({ containers }) => {
    const ids = containers.flatMap((c) => [...c.querySelectorAll('.sma-radio')].map((r) => r.id));
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('a click on an enabled card\'s name picks it as the Default; an off card\'s name does nothing', async () => {
  await withPicker({ value: { ...VALUE, availableAgents: ['claude', 'codex', 'pi'] } }, async ({ $, last, change }) => {
    card($, 'codex').querySelector('.setup-modal-agent-ident').click();
    assert.equal(last().taskAgent, 'codex');
    assert.ok(card($, 'codex').classList.contains('is-selected'));
    assert.equal(card($, 'claude').classList.contains('is-selected'), false);

    change($('.sma-cb[data-id="claude"]'), { checked: false });
    const before = last();
    card($, 'claude').querySelector('.setup-modal-agent-ident').click();
    assert.equal(last(), before, 'nothing emitted: the off agent\'s radio is disabled');
    assert.equal(last().taskAgent, 'codex');
  });
});

test('name and status share one line: an unavailable agent reads `<name> · <reason>`, the empty Pi card `<name> · No model added yet`', async () => {
  const agents = [
    AGENTS[0],
    { id: 'codex', label: 'Codex', available: false, reason: 'Codex not logged in', detail: { bin: '/usr/local/bin/codex', exit: 1, output: 'Not logged in' } },
    AGENTS[2],
  ];
  await withPicker({ agents, value: { availableAgents: ['claude'], taskAgent: 'claude', piModels: [] } }, async ({ $ }) => {
    const ident = card($, 'codex').querySelector('.setup-modal-agent-ident');
    assert.equal(ident.querySelector('.setup-modal-agent-name').textContent, 'Codex');
    assert.equal(ident.querySelector('.setup-modal-agent-name').children.length, 0, 'a plain name');
    assert.equal(ident.querySelector('.setup-modal-agent-sep').getAttribute('aria-hidden'), 'true');
    const status = ident.querySelector('.setup-modal-agent-unavailable');
    assert.equal(status.textContent, LOCALES.en['agentSelect.notLoggedIn']);
    assert.match(status.title, /log in, then Re-Check/);
    assert.ok(card($, 'codex').querySelector(':scope > .setup-modal-agent-detail'), 'diagnostics on the card\'s second row');

    const empty = card($, 'pi');
    assert.equal(empty.querySelector('.sma-cb'), null, 'nothing to switch on yet');
    assert.equal(empty.querySelector('.sma-radio'), null);
    assert.equal(empty.querySelector('.setup-modal-agent-ident').tagName, 'SPAN', 'no radio to label');
    assert.equal(empty.querySelector('.setup-modal-agent-sub').textContent, LOCALES.en['agentSelect.noModelsYet']);
  });
});

test('states: Default is-selected, an installed agent or Pi row switched off is-off, a missing one is-unavailable', async () => {
  const agents = [AGENTS[0], AGENTS[1], { id: 'pi', label: 'Pi', available: false, reason: 'pi not found' }];
  await withPicker({ agents, value: { availableAgents: ['claude'], taskAgent: 'claude' } }, async ({ $ }) => {
    assert.deepEqual([...card($, 'claude').classList].filter((c) => c.startsWith('is-')), ['is-selected']);
    assert.deepEqual([...card($, 'codex').classList].filter((c) => c.startsWith('is-')), ['is-off']);
    assert.deepEqual([...card($, 'pi').classList].filter((c) => c.startsWith('is-')), ['is-unavailable']);
  });
  await withPicker({}, async ({ $, change }) => {
    change($('.sma-cb[data-id="pi"][data-pi-idx="1"]'), { checked: false });
    assert.ok(card($, 'pi', 1).classList.contains('is-off'));
    assert.equal(card($, 'pi', 0).classList.contains('is-off'), false);
  });
});

test('the card whose form is open is-editing, its ✎ aria-expanded, and the form follows it directly', async () => {
  await withPicker({}, async ({ $ }) => {
    const edit = $('.sma-pi-edit[data-pi-idx="1"]');
    assert.equal(edit.getAttribute('aria-expanded'), 'false');
    edit.click();
    const cardEl = card($, 'pi', 1);
    assert.ok(cardEl.classList.contains('is-editing'));
    assert.equal(cardEl.querySelector('.sma-pi-edit').getAttribute('aria-expanded'), 'true');
    assert.ok(cardEl.nextElementSibling.matches('.setup-modal-agent-form[data-mode="edit"]'));
    assert.equal(card($, 'pi', 0).classList.contains('is-editing'), false);
  });
});

test('keyboard focus lands on a neighbour after the Pi form closes or a row goes, never on <body>', async () => {
  await withPicker({}, async ({ window, $, active }) => {
    const type = (el, value) => {
      el.value = value;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    // Edit → Cancel: back on that row's ✎.
    $('.sma-pi-edit[data-pi-idx="1"]').click();
    $('.sma-pi-form-cancel').click();
    assert.equal(active() === $('.sma-pi-edit[data-pi-idx="1"]'), true);
    // Edit → Save: the same.
    $('.sma-pi-edit[data-pi-idx="0"]').click();
    $('.sma-pi-form-save').click();
    assert.equal(active() === $('.sma-pi-edit[data-pi-idx="0"]'), true);
    // Add → Cancel, and Add → Save: on "+ Add model".
    $('.sma-pi-add').click();
    $('.sma-pi-form-cancel').click();
    assert.equal(active() === $('.sma-pi-add'), true);
    $('.sma-pi-add').click();
    type($('.sma-pi-model'), 'qwen/qwen-3');
    type($('.sma-pi-key'), 'sk-or-q');
    $('.sma-pi-form-save').click();
    assert.ok(card($, 'pi', 2), 'the model was added');
    assert.equal(active() === $('.sma-pi-add'), true);
    // × : the × now in that row's place, then the previous row's, then "+ Add model".
    $('.sma-pi-remove[data-pi-idx="1"]').click();
    assert.equal(active() === $('.sma-pi-remove[data-pi-idx="1"]'), true, 'the next row moved up into its place');
    $('.sma-pi-remove[data-pi-idx="1"]').click();
    assert.equal(active() === $('.sma-pi-remove[data-pi-idx="0"]'), true, 'no next row: the previous one');
    $('.sma-pi-remove[data-pi-idx="0"]').click();
    assert.equal(active() === $('.sma-pi-add'), true, 'no rows left');
  });
});

test('one installed agent: the grid is --single, with no switches, and Default stays a pill', async () => {
  const agents = [AGENTS[0], { id: 'codex', label: 'Codex', available: false, reason: 'codex not found' }, { id: 'pi', label: 'Pi', available: false }];
  await withPicker({ agents, value: { availableAgents: [], taskAgent: '' } }, async ({ $, $$ }) => {
    assert.ok($('.setup-modal-agent-grid').classList.contains('setup-modal-agent-grid--single'));
    assert.deepEqual($$('.sma-cb'), []);
    assert.equal($('.sma-radio[data-id="claude"]').checked, true);
  });
  await withPicker({}, async ({ $ }) => {
    assert.equal($('.setup-modal-agent-grid').classList.contains('setup-modal-agent-grid--single'), false);
  });
});

test('badges: an image model\'s purpose badge is neutral (--purpose), a no-tools row keeps the warning badge', async () => {
  await withPicker({ value: { ...VALUE, piModels: [KIMI, RECRAFT, IMAGE] } }, async ({ $ }) => {
    assert.equal(card($, 'pi', 0).querySelector('.setup-modal-agent-badge'), null);
    const noTools = card($, 'pi', 1).querySelector('.setup-modal-agent-badge');
    assert.equal(noTools.textContent, 'No tools');
    assert.equal(noTools.classList.contains('setup-modal-agent-badge--purpose'), false);
    const purpose = card($, 'pi', 2).querySelector('.setup-modal-agent-badge');
    assert.equal(purpose.textContent, LOCALES.en['agentSelect.purposeImage']);
    assert.ok(purpose.classList.contains('setup-modal-agent-badge--purpose'));
  });
});

test('all unavailable: the same header row (hint | Re-Check), one `<name> · <status>` row per agent, install commands as code', async () => {
  const agents = [
    { id: 'claude', label: 'Claude Code', available: false, reason: 'claude not found' },
    { id: 'codex', label: 'Codex', available: false, reason: 'Codex not logged in' },
    { id: 'pi', label: 'Pi', available: false },
  ];
  let rechecks = 0;
  await withPicker({ agents, value: { availableAgents: [], taskAgent: '' }, onReCheck: async () => { rechecks += 1; } }, async ({ $, $$ }) => {
    const header = $('.setup-modal-agent-empty > .setup-modal-agent-header');
    assert.ok(header.querySelector('.setup-modal-hint'));
    const recheck = header.querySelector('.setup-modal-agent-recheck');
    assert.ok(recheck.querySelector('svg[aria-hidden="true"]'), 'the refresh glyph is decorative');
    assert.equal(recheck.textContent.trim(), 'Re-Check');
    const rows = $$('.setup-modal-agent-empty-item');
    assert.deepEqual(rows.map((li) => li.querySelector('.setup-modal-agent-ident .setup-modal-agent-name').textContent), ['Claude Code', 'Codex', 'Other Model']);
    assert.deepEqual(rows.map((li) => li.querySelector('.setup-modal-agent-unavailable').textContent), ['not installed', 'not logged in', 'not installed']);
    assert.deepEqual(rows.map((li) => li.querySelector('code.setup-modal-agent-install')?.textContent ?? null),
      ['npm install -g @anthropic-ai/claude-code', null, 'pi.dev'], 'a broken install shows its reason, not an install command');
    recheck.click();
    assert.equal(rechecks, 1);
  });
});

// CSS isn't executable under node: pin the rules the layout rests on at the source level.
const CSS = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// The body of the rule whose whole selector list is `selector` (not a descendant rule ending in it).
const block = (selector) => {
  const m = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `styles.css has no ${selector} rule`);
  return m[1];
};

test('styles: five shared columns, each card a subgrid; cells pinned to their columns', () => {
  assert.match(block('.setup-modal-agent-grid'), /grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto;/);
  assert.match(block('.setup-modal-agent-grid'), /column-gap:\s*0;/);
  assert.match(block('.setup-modal-agent-grid > *'), /grid-column:\s*1 \/ -1;/);
  assert.match(block('.setup-modal-agent-card'), /grid-template-columns:\s*subgrid;/);
  for (const [selector, column] of [
    ['.setup-modal-agent-card > .sma-cb', '1'],
    ['.setup-modal-agent-ident', '2'],
    ['.setup-modal-agent-card > .setup-modal-agent-badge', '3'],
    ['.setup-modal-agent-actions', '4'],
    ['.setup-modal-agent-card > .setup-modal-agent-default-wrap', '5'],
    ['.setup-modal-agent-card > .setup-modal-agent-detail', '2 / -1'],
  ]) assert.match(block(selector), new RegExp(`grid-column:\\s*${column.replace('/', '\\/')};`), selector);
});

test('styles: off and unavailable cards keep their text at full strength — no whole-card opacity or dead pointer', () => {
  for (const selector of ['.setup-modal-agent-card.is-off', '.setup-modal-agent-card.is-unavailable']) {
    const rules = [...CSS.matchAll(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
    assert.doesNotMatch(rules, /opacity|pointer-events/, selector);
  }
  assert.match(block('.setup-modal-agent-card.is-unavailable'), /border-style:\s*dashed;/);
});

test('styles: the switch, the Default pill and their forced-colours / reduced-motion fallbacks', () => {
  assert.match(block('input.sma-cb'), /appearance:\s*none;/);
  assert.match(block('input.sma-cb:checked'), /background:\s*var\(--c-primary\);/);
  assert.match(block('input.sma-cb:focus-visible'), /outline:\s*2px solid var\(--c-primary-border\);/);
  assert.match(block('.setup-modal-agent-default-wrap > .sma-radio'), /opacity:\s*0;/);
  assert.match(block('.setup-modal-agent-default-wrap:has(> .sma-radio:focus-visible)'), /outline:\s*2px solid var\(--c-primary-border\);/);
  assert.match(block('.setup-modal-agent-default-wrap:has(> .sma-radio:disabled)'), /visibility:\s*hidden;/);
  const forced = /@media \(forced-colors: active\) \{\s*input\.sma-cb \{[^}]*appearance: auto;/.exec(CSS);
  assert.ok(forced, 'forced colours hand the switch back to the native checkbox');
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*input\.sma-cb,/);
});

test('styles: an open form joins the card above it', () => {
  assert.match(block('.setup-modal-agent-card.is-editing'), /border-bottom-left-radius:\s*0;/);
  const joined = block('.setup-modal-agent-card.is-editing + .setup-modal-agent-form');
  assert.match(joined, /margin-top:\s*calc\(-1 \* var\(--sma-row-gap/);
  assert.match(joined, /border-top:\s*0;/);
});
