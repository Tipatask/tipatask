import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { renderAgentSelect, agentModelPick, setPiProviders, computePiSaveRows } from './agent-select.js';
import { LOCALES } from './i18n.js';

// (TPT637) Edit Agents' Claude/Codex model picks follow the wizard's card contract: the card reads
// `<Agent> · <model>`, and its ✎ opens one inline `.setup-modal-agent-form--model` under it. Driven
// in happy-dom with the real renderer, then through the real Edit Agents modal (esbuild bundle —
// same harness as project-creation-wizard-locked.test.js) for the Save path and the Save gate.

const REGISTRY = [
  { id: 'openrouter', label: 'OpenRouter', keyRequired: true, supportsBaseUrl: false },
  { id: 'deepseek', label: 'DeepSeek', keyRequired: true, supportsBaseUrl: false },
  { id: 'custom', label: 'Custom endpoint', keyRequired: false, supportsBaseUrl: true },
];
setPiProviders(REGISTRY);

const CLAUDE = {
  label: 'Claude Code Model',
  options: [
    { value: 'opusplan', label: 'opusplan (default)' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  ],
  defaultValue: 'opusplan',
};
const CODEX = {
  label: 'Codex Model',
  options: [
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol (default)', description: 'Latest frontier agentic coding model.' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
  ],
  placeholder: { value: '', label: 'codex default' },
};
const MODEL_SELECTS = { claude: CLAUDE, codex: CODEX };
const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: true },
];
const VALUE = {
  availableAgents: ['claude', 'codex', 'pi'],
  taskAgent: 'claude',
  piModels: [{ model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-x' }],
  claudeModel: 'claude-opus-5-5',
  codexModel: '',
};

// Swaps happy-dom globals in for one test and restores them afterwards.
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

// One renderAgentSelect() grid in a fresh document. The Pi model input reads the global `document`
// and fetches a catalog when it takes focus, so both are swapped in; any unhandled rejection from
// that async path fails the test.
async function withGrid({ agents = AGENTS, value = VALUE, modelSelects = MODEL_SELECTS } = {}, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const restore = installGlobals({
    document: window.document,
    fetch: async () => ({ ok: true, json: async () => [] }),
  });
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    const container = window.document.createElement('div');
    window.document.body.append(container);
    const payloads = [];
    const opts = { agents, value: structuredClone(value), onChange: (p) => payloads.push(p) };
    if (modelSelects) opts.modelSelects = modelSelects; // null = a caller that passes none
    renderAgentSelect(container, opts);
    const $ = (sel) => container.querySelector(sel);
    const card = (id) => $(`.setup-modal-agent-card[data-id="${id}"]`);
    const change = (el, props) => {
      Object.assign(el, props);
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
    await run({ window, $, card, change, flush, payloads, last: () => payloads.at(-1) });
    await flush();
    assert.deepEqual(rejections, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
    restore();
    await window.happyDOM.abort();
  }
}

// The option(s) rendered with the `selected` attribute. happy-dom 20 misreports `value` /
// `selectedIndex` when the selected option is the last one, so freshly rendered selects are judged
// on their markup (a real browser is checked by hand).
const markedSelected = (select) => [...select.options].filter((o) => o.hasAttribute('selected')).map((o) => o.value);

test('agentModelPick: the entry default, the placeholder, a listed label, and an unlisted id as itself', () => {
  assert.deepEqual(agentModelPick(CLAUDE, ''), { value: 'opusplan', label: 'opusplan (default)' });
  assert.deepEqual(agentModelPick(CLAUDE, 'claude-opus-5-5'), { value: 'claude-opus-5-5', label: 'Opus 5.5' });
  assert.deepEqual(agentModelPick(CLAUDE, 'claude-opus-4-1'), { value: 'claude-opus-4-1', label: 'claude-opus-4-1' });
  assert.deepEqual(agentModelPick(CODEX, ''), { value: '', label: 'codex default' });
  assert.deepEqual(agentModelPick(CODEX, 'gpt-5.6-luna'), { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' });
});

test('no modelSelects (create wizard, setup modal): plain Claude/Codex names, no model controls or keys', async () => {
  await withGrid({ modelSelects: null }, async ({ $, card, change, last }) => {
    for (const id of ['claude', 'codex']) {
      assert.equal(card(id).querySelector('.setup-modal-agent-name').children.length, 0, `${id}: plain-text name`);
      assert.equal(card(id).classList.contains('setup-modal-agent-card--model'), false);
    }
    assert.equal($('.sma-model-edit'), null);
    assert.equal($('.setup-modal-agent-form'), null);
    change($('.sma-cb[data-id="codex"]'), { checked: false });
    assert.equal('claudeModel' in last(), false);
    assert.equal('codexModel' in last(), false);
  });
});

test('with modelSelects each Claude/Codex card reads `<Agent> · <model>`, with a ✎ only while enabled', async () => {
  await withGrid({}, async ({ $, card, change }) => {
    const claude = card('claude');
    assert.ok(claude.classList.contains('setup-modal-agent-card--model'));
    assert.equal(claude.querySelector('.setup-modal-agent-provider').textContent, 'Claude Code');
    assert.equal(claude.querySelector('.setup-modal-agent-sep').textContent, '·');
    assert.equal(claude.querySelector('.setup-modal-agent-model').textContent, 'Opus 5.5');
    assert.equal(claude.querySelector('.setup-modal-agent-model').title, 'claude-opus-5-5');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'codex default');
    const edit = claude.querySelector('.sma-model-edit');
    assert.equal(edit.getAttribute('aria-label'), 'Edit Claude Code model');
    assert.equal(edit.title, 'Edit Claude Code model');
    assert.equal($('.setup-modal-agent-form'), null, 'no form until ✎');
    assert.equal($('.setup-modal-agent-extra'), null, 'the C1161 sub-row is gone');
    assert.equal($('.setup-modal-agent-extra-field--select'), null, 'and so is its select field');

    change($('.sma-cb[data-id="codex"]'), { checked: false });
    assert.equal(card('codex').querySelector('.sma-model-edit'), null, 'a disabled card has no ✎');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'codex default', 'it still shows its model');
  });
});

test('an agent that is not available keeps its plain name: no model, no ✎', async () => {
  const agents = [AGENTS[0], { id: 'codex', label: 'Codex', available: false, reason: 'Codex CLI not found' }, AGENTS[2]];
  await withGrid({ agents }, async ({ card }) => {
    assert.equal(card('codex').classList.contains('setup-modal-agent-card--model'), false);
    assert.equal(card('codex').querySelector('.setup-modal-agent-name').children.length, 0);
    assert.equal(card('codex').querySelector('.sma-model-edit'), null);
  });
});

test('✎ opens one inline form right under its card; a pick applies at once and Save closes it', async () => {
  await withGrid({}, async ({ window, $, card, change, payloads, last }) => {
    card('claude').querySelector('.sma-model-edit').click();
    const form = $('.setup-modal-agent-form--model');
    assert.ok(form, 'form opened');
    assert.equal(form.dataset.for, 'claude');
    assert.equal(card('claude').nextElementSibling, form, 'directly under the Claude card');
    assert.equal(form.getAttribute('role'), 'group');
    assert.equal(form.getAttribute('aria-label'), 'Change Claude Code model');
    assert.equal(form.querySelector('.setup-modal-agent-extra-label').textContent, 'Claude Code Model');
    const select = form.querySelector('select.sma-model-select');
    assert.equal(window.document.activeElement, select, 'focus moves into the form');
    assert.deepEqual([...select.options].map((o) => o.value), ['opusplan', 'claude-opus-5-5', 'claude-sonnet-5']);
    assert.deepEqual(markedSelected(select), ['claude-opus-5-5']);

    const before = payloads.length;
    change(select, { value: 'claude-sonnet-5' });
    assert.equal(payloads.length, before + 1, 'the pick is emitted at once');
    assert.equal(last().claudeModel, 'claude-sonnet-5');
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'Sonnet 5', 'the card label follows');
    assert.equal($('.sma-model-select'), select, 'no rebuild, so the select keeps focus');

    form.querySelector('.sma-model-form-save').click();
    assert.equal($('.setup-modal-agent-form'), null, 'Save closes the form');
    assert.equal(payloads.length, before + 1, 'Save emits nothing new');
    assert.equal(window.document.activeElement, card('claude').querySelector('.sma-model-edit'), 'focus goes back to ✎');
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'Sonnet 5');
  });
});

test('Cancel puts back the pick the form opened with', async () => {
  await withGrid({}, async ({ $, card, change, payloads, last }) => {
    card('codex').querySelector('.sma-model-edit').click();
    const select = $('.setup-modal-agent-form--model[data-for="codex"] .sma-model-select');
    assert.deepEqual([...select.options].map((o) => o.value), ['', 'gpt-5.6-sol', 'gpt-5.6-luna'], 'placeholder first');
    assert.equal(select.options[0].textContent, 'codex default');
    assert.equal(select.options[1].title, 'Latest frontier agentic coding model.');
    assert.deepEqual(markedSelected(select), ['']);

    let count = payloads.length;
    $('.sma-model-form-cancel').click();
    assert.equal(payloads.length, count, 'Cancel with nothing changed emits nothing');

    card('codex').querySelector('.sma-model-edit').click();
    change($('.sma-model-select'), { value: 'gpt-5.6-luna' });
    assert.equal(last().codexModel, 'gpt-5.6-luna');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'gpt-5.6-luna');
    count = payloads.length;
    $('.sma-model-form-cancel').click();
    assert.equal(payloads.length, count + 1, 'the old pick is emitted back');
    assert.equal(last().codexModel, '');
    assert.equal($('.setup-modal-agent-form'), null);
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'codex default');
  });
});

test('a stored model the option list does not carry keeps its own option, so Save never swaps it', async () => {
  await withGrid({ value: { ...VALUE, claudeModel: 'claude-opus-4-1' } }, async ({ $, card, payloads }) => {
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'claude-opus-4-1');
    card('claude').querySelector('.sma-model-edit').click();
    const select = $('.sma-model-select');
    assert.deepEqual(markedSelected(select), ['claude-opus-4-1'], 'its own option, selected');
    assert.equal([...select.options].at(-1).textContent, 'claude-opus-4-1');
    const count = payloads.length;
    $('.sma-model-form-save').click();
    assert.equal(payloads.length, count, 'nothing emitted: the stored pick stands');
  });
});

test('unchecking an agent closes its open model form and keeps the pick', async () => {
  await withGrid({}, async ({ $, card, change, last }) => {
    card('claude').querySelector('.sma-model-edit').click();
    change($('.sma-model-select'), { value: 'claude-sonnet-5' });
    change($('.sma-cb[data-id="claude"]'), { checked: false });
    assert.equal($('.setup-modal-agent-form'), null);
    assert.equal(card('claude').querySelector('.sma-model-edit'), null);
    assert.equal(last().availableAgents.includes('claude'), false);
    assert.equal(last().claudeModel, 'claude-sonnet-5');
    change($('.sma-cb[data-id="claude"]'), { checked: true });
    assert.equal($('.setup-modal-agent-form'), null, 'checking it again does not reopen the form');
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'Sonnet 5');
  });
});

test('one inline form at a time: a Pi ✎ and a model ✎ replace each other', async () => {
  await withGrid({}, async ({ $, card, flush }) => {
    card('claude').querySelector('.sma-model-edit').click();
    assert.ok($('.setup-modal-agent-form--model'));
    assert.ok($('.setup-modal-agent-add-row'), '+ Add model is still rendered');

    $('.sma-pi-edit[data-pi-idx="0"]').click();
    assert.equal($('.setup-modal-agent-form--model'), null, 'the Pi form replaced the model form');
    assert.equal($('.setup-modal-agent-form').dataset.mode, 'edit');

    // The Pi model input took focus and is fetching its catalog; swap forms before it lands. The
    // late result must bail out on the draft-less model form instead of throwing.
    card('claude').querySelector('.sma-model-edit').click();
    assert.equal($('.setup-modal-agent-form[data-mode="edit"]'), null, 'the model form replaced the Pi form');
    assert.ok($('.setup-modal-agent-form--model'));
    await flush();
  });
});

test('styles: model cards share the Pi name row and the 26px ghost ✎; the C1161 sub-row rules are retired', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.setup-modal-agent-card--pi \.setup-modal-agent-name,\s*\.setup-modal-agent-card--model \.setup-modal-agent-name \{/);
  assert.match(css, /\.sma-pi-edit,\s*\.sma-pi-remove,\s*\.sma-model-edit \{[^}]*width: 26px;[^}]*height: 26px;/);
  assert.match(css, /\.sma-pi-edit:hover,\s*\.sma-model-edit:hover \{/);
  // The Pi form hides the redundant "+ Add model" row; the model form must not.
  assert.match(css, /\.setup-modal-agent-form:not\(\.setup-modal-agent-form--model\) ~ \.setup-modal-agent-add-row \{\s*display: none;/);
  assert.doesNotMatch(css, /\.setup-modal-agent-form ~ \.setup-modal-agent-add-row/);
  assert.doesNotMatch(css, /setup-modal-agent-extra-field--select/);
  assert.doesNotMatch(css, /\.setup-modal-agent-extra[\s{.[]/, 'no rule targets the retired .setup-modal-agent-extra block');
});

test('the model form copy exists in both locales with its {name} slot', () => {
  for (const lang of ['en', 'uk']) {
    for (const key of ['agentSelect.editModel', 'agentSelect.changeModel']) {
      assert.match(LOCALES[lang][key] || '', /\{name\}/, `${lang} ${key}`);
    }
  }
});

// ── The real Edit Agents modal ───────────────────────────────────────────────────────────────

async function withAgentsModal(electronAPI, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-agents-modal-'));
  const entries = {};
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) entries[key] = window[key];
  window.electronAPI = electronAPI;
  Object.assign(entries, {
    window, self: window,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    fetch: async (url) => (String(url).startsWith('/api/pi/providers')
      ? { ok: true, status: 200, json: async () => REGISTRY }
      : { ok: false, status: 404, json: async () => ({}) }),
  });
  const restore = installGlobals(entries);
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as modal from './src/client/agents-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'agents-modal.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { modal } = await import(pathToFileURL(bundle).href);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    try { await run({ modal, flush, $: (sel) => document.querySelector(sel) }); } finally { modal.closeAgentsModal(); }
  } finally {
    await window.happyDOM.abort();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The stubbed IPC both modal tests open: Claude + Codex enabled, Claude the Default, and a
// saveAgents() that records every selection it is handed.
function editAgentsApi(saved) {
  return {
    setupGetAvailableAgents: async () => AGENTS,
    api: {
      project: {
        config: async () => ({
          config: { TASK_AGENT: 'claude', AVAILABLE_AGENTS: 'claude,codex', CLAUDE_MODEL: 'claude-opus-4-8', CODEX_MODEL: '' },
          agents: { taskAgent: 'claude', availableAgents: ['claude', 'codex'] },
        }),
        saveAgents: async (selection) => {
          saved.push(selection);
          const taskAgentLabel = AGENTS.find((a) => a.id === selection.taskAgent)?.label;
          return { ok: true, agents: { taskAgent: selection.taskAgent, taskAgentLabel, availableAgents: selection.availableAgents } };
        },
      },
    },
  };
}

const toggle = (el, checked) => {
  el.checked = checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

test('Edit Agents: the Save gate still guards, and Save writes the model picked in the open form', async () => {
  const saved = [];
  await withAgentsModal(editAgentsApi(saved), async ({ modal, flush, $ }) => {
    modal.openAgentsModal();
    await flush();
    const card = (id) => $(`.agents-modal .setup-modal-agent-card[data-id="${id}"]`);
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'Opus 4.8');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'codex default');
    assert.equal($('.agents-modal .setup-modal-agent-extra'), null);
    const save = $('#agents-modal-save');
    const msg = $('#agents-modal-msg');
    assert.equal(save.disabled, false);

    // _syncSaveGate(): nothing enabled → Save off with the selection message; back on as soon as
    // Claude is checked again — it takes the empty Default, no radio click needed (TPT653).
    toggle($('.sma-cb[data-id="claude"]'), false);
    toggle($('.sma-cb[data-id="codex"]'), false);
    assert.equal(save.disabled, true);
    assert.equal(msg.textContent, 'Enable at least one agent.');
    toggle($('.sma-cb[data-id="claude"]'), true);
    assert.equal(save.disabled, false);
    assert.equal(msg.textContent, '');

    // Pick a model in the inline form, then press the modal's Save without the form's own Save.
    card('claude').querySelector('.sma-model-edit').click();
    const select = $('.setup-modal-agent-form--model .sma-model-select');
    select.value = 'claude-sonnet-4-6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    save.click();
    await flush();
    assert.equal($('.agents-modal'), null, 'the modal closed after saving');
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].claudeModel, 'claude-sonnet-4-6');
  assert.equal(saved[0].codexModel, '');
  assert.equal(saved[0].taskAgent, 'claude');
  assert.deepEqual(saved[0].availableAgents, ['claude']);
});

test('Edit Agents: a Codex pick confirmed with the form Save survives Re-Check and is what Save writes; the untouched Claude pick round-trips', async () => {
  const saved = [];
  const api = editAgentsApi(saved);
  // Re-Check asks the server first (a 404 here), then falls back to the forced IPC detect.
  let forcedDetects = 0;
  const detect = api.setupGetAvailableAgents;
  api.setupGetAvailableAgents = async (force) => {
    if (force) forcedDetects += 1;
    return detect(force);
  };
  await withAgentsModal(api, async ({ modal, flush, $ }) => {
    modal.openAgentsModal();
    await flush();
    const card = (id) => $(`.agents-modal .setup-modal-agent-card[data-id="${id}"]`);

    // ✎, a pick, then the form's own Save: the pick was emitted on change, Save only closes the form.
    card('codex').querySelector('.sma-model-edit').click();
    const select = $('.setup-modal-agent-form--model[data-for="codex"] .sma-model-select');
    select.value = 'gpt-5.6-luna';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    $('.setup-modal-agent-form--model .sma-model-form-save').click();
    assert.equal($('.agents-modal .setup-modal-agent-form'), null, 'the form Save closed the form');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'gpt-5.6-luna');

    // Re-Check rebuilds the grid from the modal's _draft, so the pick and its ✎ come back with it.
    $('.agents-modal .setup-modal-agent-recheck').click();
    await flush();
    assert.equal(forcedDetects, 1, 'Re-Check ran the forced detect');
    assert.equal(card('codex').querySelector('.setup-modal-agent-model').textContent, 'gpt-5.6-luna', 'the pick survived the repaint');
    assert.ok(card('codex').querySelector('.sma-model-edit'), 'the ✎ is rendered again');
    assert.equal(card('claude').querySelector('.setup-modal-agent-model').textContent, 'Opus 4.8');

    $('#agents-modal-save').click();
    await flush();
    assert.equal($('.agents-modal'), null, 'the modal closed after saving');
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].codexModel, 'gpt-5.6-luna');
  assert.equal(saved[0].claudeModel, 'claude-opus-4-8', 'the untouched Claude pick is written back as loaded');
  assert.equal(saved[0].taskAgent, 'claude');
  assert.deepEqual(saved[0].availableAgents, ['claude', 'codex']);
});

// ── (TPT653) The Default follows a re-checked agent ──────────────────────────────────────────
// Unchecking every agent leaves no Default; checking one again makes it the Default — as checking
// the first Pi model always did — so no host gate waits on a radio click. The renderer cases run
// without modelSelects: the create wizard / setup modal shape.

const PI_ROW = '.sma-cb[data-id="pi"][data-pi-idx="0"]';
const ALL_CHECKBOXES = ['.sma-cb[data-id="claude"]', '.sma-cb[data-id="codex"]', PI_ROW];

test('re-checking an agent after unchecking every agent makes it the Default; later re-checks keep it', async () => {
  await withGrid({ modelSelects: null }, async ({ $, card, change, last }) => {
    for (const sel of ALL_CHECKBOXES) change($(sel), { checked: false });
    assert.equal(last().taskAgent, '', 'nothing enabled, no Default');
    assert.deepEqual(last().availableAgents, []);

    change($('.sma-cb[data-id="codex"]'), { checked: true });
    assert.equal(last().taskAgent, 'codex');
    assert.deepEqual(last().availableAgents, ['codex']);
    assert.equal($('.sma-radio[data-id="codex"]').checked, true, 'its Default radio is checked');
    assert.ok(card('codex').classList.contains('is-selected'));

    change($('.sma-cb[data-id="claude"]'), { checked: true });
    change($(PI_ROW), { checked: true });
    assert.equal(last().taskAgent, 'codex', 'a later re-check leaves the Default alone');
    assert.deepEqual(last().availableAgents, ['codex', 'claude', 'pi']);
    assert.equal($('.sma-radio[data-id="claude"]').checked, false);
  });
});

test('a Pi model re-checked first stays the Default when Claude is re-checked after it', async () => {
  await withGrid({ modelSelects: null }, async ({ $, change, last }) => {
    for (const sel of ALL_CHECKBOXES) change($(sel), { checked: false });
    change($(PI_ROW), { checked: true });
    assert.equal(last().taskAgent, 'pi');
    change($('.sma-cb[data-id="claude"]'), { checked: true });
    assert.equal(last().taskAgent, 'pi');
    assert.deepEqual(last().availableAgents, ['pi', 'claude']);
    assert.equal($('.sma-radio[data-id="pi"]').checked, true);
  });
});

test('Edit Agents: re-checking Codex after unchecking every agent makes it the Default and enables Save', async () => {
  const saved = [];
  await withAgentsModal(editAgentsApi(saved), async ({ modal, flush, $ }) => {
    modal.openAgentsModal();
    await flush();
    const save = $('#agents-modal-save');
    const msg = $('#agents-modal-msg');
    toggle($('.sma-cb[data-id="claude"]'), false);
    toggle($('.sma-cb[data-id="codex"]'), false);
    assert.equal(save.disabled, true);
    assert.equal(msg.textContent, 'Enable at least one agent.');

    toggle($('.sma-cb[data-id="codex"]'), true);
    assert.equal($('.sma-radio[data-id="codex"]').checked, true, 'Codex is the Default without a radio click');
    assert.equal(save.disabled, false);
    assert.equal(msg.textContent, '');
    save.click();
    await flush();
    assert.equal($('.agents-modal'), null, 'the modal closed after saving');
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].taskAgent, 'codex');
  assert.deepEqual(saved[0].availableAgents, ['codex']);
});

// ── (TPT694) Custom endpoint rows: "Model supports tool calls" and the "No tools" badge ────────
// Only a custom row can carry `tools: false`. The Pi Add/Edit form's checkbox sets it (unchecked),
// and a card declared that way shows a "No tools" badge whose tooltip says what it can still run.

const NO_TOOLS_HINT = LOCALES.en['agentSelect.noToolsHint'];
const RECRAFT = { model: 'recraft-v3', apiKey: '', provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1' };
const typeInto = (window, el, value) => {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const piCard = ($, idx) => $(`.setup-modal-agent-card[data-id="pi"][data-pi-idx="${idx}"]`);
const badgeOf = (cardEl) => cardEl.querySelector('.setup-modal-agent-badge');

test('the tool-support checkbox shows only for a custom endpoint; unchecked, it adds the row with tools:false and a No tools badge', async () => {
  await withGrid({ modelSelects: null }, async ({ window, $, change, last }) => {
    assert.equal(badgeOf(piCard($, 0)), null, 'an OpenRouter card has no badge');
    $('.sma-pi-add').click();
    const field = $('.setup-modal-agent-extra-field--tools');
    const box = $('.sma-pi-tools');
    assert.ok(field && box, 'the form renders the tool-support row');
    assert.equal(field.hidden, true, 'hidden while the provider is OpenRouter');
    assert.equal(box.checked, true, 'checked by default');
    assert.equal(field.title, NO_TOOLS_HINT);
    assert.equal(field.querySelector('.setup-modal-agent-extra-label').textContent, 'Model supports tool calls');

    change($('.sma-pi-provider'), { value: 'custom' });
    assert.equal(field.hidden, false, 'shown for a custom endpoint');
    typeInto(window, $('.sma-pi-model'), RECRAFT.model);
    typeInto(window, $('.sma-pi-baseurl'), RECRAFT.baseUrl);
    change(box, { checked: false });
    $('.sma-pi-form-save').click();

    const rows = last().piModels;
    assert.deepEqual(rows[1], { ...RECRAFT, tools: false });
    assert.equal(Object.hasOwn(rows[0], 'tools'), false, 'the OpenRouter row carries no tools field');
    assert.deepEqual(computePiSaveRows(rows)[1], { ...RECRAFT, tools: false }, 'the persistence filter keeps it');
    const badge = badgeOf(piCard($, 1));
    assert.ok(badge, 'the new card shows the badge');
    assert.equal(badge.textContent, 'No tools');
    assert.equal(badge.title, NO_TOOLS_HINT);
    assert.equal(badgeOf(piCard($, 0)), null);
  });
});

test('editing a tools:false row shows the box unchecked; checking it again drops the field and the badge', async () => {
  const value = { ...VALUE, piModels: [{ ...RECRAFT, tools: false }] };
  await withGrid({ value, modelSelects: null }, async ({ $, change, last }) => {
    assert.equal(badgeOf(piCard($, 0)).textContent, 'No tools');
    $('.sma-pi-edit[data-pi-idx="0"]').click();
    assert.equal($('.setup-modal-agent-extra-field--tools').hidden, false);
    const box = $('.sma-pi-tools');
    assert.equal(box.checked, false, 'the stored tools:false reads as unchecked');
    change(box, { checked: true });
    $('.sma-pi-form-save').click();
    const [row] = last().piModels;
    assert.deepEqual(row, RECRAFT, 'checked again: no tools field at all');
    assert.deepEqual(computePiSaveRows([row]), [RECRAFT]);
    assert.equal(badgeOf(piCard($, 0)), null, 'and the badge is gone');
  });
});

test('switching a custom row to another provider hides the box and drops tools:false', async () => {
  const value = { ...VALUE, piModels: [{ ...RECRAFT, tools: false }] };
  await withGrid({ value, modelSelects: null }, async ({ window, $, change, last }) => {
    $('.sma-pi-edit[data-pi-idx="0"]').click();
    const field = $('.setup-modal-agent-extra-field--tools');
    const provider = $('.sma-pi-provider');
    change(provider, { value: 'deepseek' });
    assert.equal(field.hidden, true, 'hidden off a custom endpoint');
    change(provider, { value: 'custom' });
    assert.equal(field.hidden, false);
    assert.equal($('.sma-pi-tools').checked, false, 'back on custom, the box still shows the draft');
    change(provider, { value: 'deepseek' });
    typeInto(window, $('.sma-pi-key'), 'sk-ds');
    $('.sma-pi-form-save').click();
    const [row] = last().piModels;
    assert.equal(row.provider, 'deepseek');
    assert.equal(row.model, 'recraft-v3');
    assert.equal(Object.hasOwn(row, 'tools'), false, 'a non-custom row never carries tools');
    assert.equal(Object.hasOwn(row, 'baseUrl'), false);
    assert.equal(Object.hasOwn(computePiSaveRows([row])[0], 'tools'), false);
    assert.equal(badgeOf(piCard($, 0)), null);
  });
});

test('Edit Agents: an unchecked box writes tools:false to config.json on that row only; re-checking it removes the field', async () => {
  const { readProjectConfig, writeProjectConfig, rendererPiModels, buildAgentsConfigPatch } = createRequire(import.meta.url)('../server/project-config.js');
  const root = mkdtempSync(join(tmpdir(), 'tt-agents-tools-'));
  const KIMI = { model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-x' };
  writeProjectConfig(root, { TASK_AGENT: 'claude', AVAILABLE_AGENTS: 'claude,pi', PI_MODELS: [KIMI] });
  const onDisk = () => JSON.parse(readFileSync(join(root, '.tipatask', 'config.json'), 'utf8')).PI_MODELS;
  // The two IPC handlers Edit Agents calls (main/ipc/api-router.js api:project.config /
  // api:project.saveAgents), over the real config code and a real config.json.
  const api = {
    setupGetAvailableAgents: async () => AGENTS,
    api: {
      project: {
        config: async () => {
          const cfg = readProjectConfig(root);
          return {
            config: { TASK_AGENT: cfg.TASK_AGENT, AVAILABLE_AGENTS: cfg.AVAILABLE_AGENTS, PI_MODELS: rendererPiModels(cfg) },
            agents: { taskAgent: cfg.TASK_AGENT, availableAgents: cfg.AVAILABLE_AGENTS.split(',') },
          };
        },
        saveAgents: async (selection) => {
          try {
            const merged = buildAgentsConfigPatch(readProjectConfig(root), selection);
            writeProjectConfig(root, merged);
            return { ok: true, agents: { taskAgent: merged.TASK_AGENT, taskAgentLabel: 'Claude Code', availableAgents: merged.AVAILABLE_AGENTS.split(',') } };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
      },
    },
  };
  const set = (el, prop, value, type) => {
    el[prop] = value;
    el.dispatchEvent(new Event(type, { bubbles: true }));
  };
  try {
    await withAgentsModal(api, async ({ modal, flush, $ }) => {
      modal.openAgentsModal();
      await flush();
      $('.agents-modal .sma-pi-add').click();
      set($('.sma-pi-provider'), 'value', 'custom', 'change');
      set($('.sma-pi-model'), 'value', RECRAFT.model, 'input');
      set($('.sma-pi-baseurl'), 'value', RECRAFT.baseUrl, 'input');
      set($('.sma-pi-tools'), 'checked', false, 'change');
      $('.sma-pi-form-save').click();
      assert.equal($('.agents-modal .setup-modal-agent-card[data-pi-idx="1"] .setup-modal-agent-badge').textContent, 'No tools');
      $('#agents-modal-save').click();
      await flush();
      assert.equal($('.agents-modal'), null, 'the modal closed after saving');
      assert.deepEqual(onDisk(), [KIMI, { ...RECRAFT, tools: false }], 'tools:false on the custom row only; the stored key kept');

      modal.openAgentsModal();
      await flush();
      const card = $('.agents-modal .setup-modal-agent-card[data-pi-idx="1"]');
      assert.ok(badgeOf(card), 'reopened: the badge is back');
      card.querySelector('.sma-pi-edit').click();
      assert.equal($('.sma-pi-tools').checked, false, 'reopened: the box is still unchecked');
      set($('.sma-pi-tools'), 'checked', true, 'change');
      $('.sma-pi-form-save').click();
      $('#agents-modal-save').click();
      await flush();
      assert.equal($('.agents-modal'), null, 'the modal closed after saving again');
    });
    assert.deepEqual(onDisk(), [KIMI, RECRAFT], 're-checked: the field is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('styles: the tool-support row spans the form grid and the No tools badge uses the warning tokens', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.setup-modal-agent-form-fields > \.setup-modal-agent-extra-field--tools \{[^}]*grid-column: 1 \/ -1;[^}]*flex-direction: row;/);
  assert.match(css, /\.setup-modal-agent-badge \{[^}]*border: 1px solid var\(--c-warning-border\);[^}]*background: var\(--c-warning-bg\);[^}]*color: var\(--c-warning\);/);
});
