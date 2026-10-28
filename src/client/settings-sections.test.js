import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { LOCALES, setLocale, t } from './i18n.js';

// (TPT9111) Every Settings tab pane shares one skeleton: section.settings-section blocks, each an
// h3.settings-section-title followed by .settings-row rows made of .settings-row-label (label,
// optional .settings-row-note badge, optional .settings-row-hint lines) and .settings-row-control.
// These guards pin that contract on the static markup, on the rows the populators build and on
// the CSS, and check that the dialog carries no baked-in English. Private task-board.js helpers
// run in a vm against the real template markup, as in workflow-permission-mode.test.js.
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Containers whose .settings-row children are built at open time.
const ROW_CONTAINERS = ['settings-agents-summary', 'settings-voice-local-list'];

// Every id the Settings markup carried before the section/row rewrite; handlers, populators and
// other tests query them, so none may disappear.
const LEGACY_IDS = `agents-edit agents-row agents-summary debug-perf-copy debug-perf-hint debug-perf-path
  debug-perf-reveal debug-perf-toggle debug-row kb-sync-caption kb-sync-row kb-sync-toggle
  language-row language-select memory-tab-btn modal notifications-hint notifications-hint-text
  notifications-repair notifications-row notifications-state notifications-style-btn
  notifications-style-hint notifications-style-text notifications-test objective-grouping-caption
  objective-grouping-row objective-grouping-toggle permission-mode-row sprints-enabled-caption
  sprints-enabled-row sprints-enabled-toggle task-group-label task-group-label-caption
  task-group-label-row theme-select vcs-caption vcs-git-options vcs-hint vcs-tab-btn vcs-type-options
  voice-assemblyai-key voice-assemblyai-row voice-input-device voice-input-device-label
  voice-input-device-row voice-key-clear voice-key-save voice-key-status voice-local-list
  voice-local-not-wired-hint voice-preset-assemblyai voice-preset-assemblyai-label voice-shortcut
  voice-shortcut-hint voice-shortcut-label voice-shortcut-row voice-tab-btn workflow-add-btn
  workflow-add-color workflow-add-form workflow-add-name workflow-caption workflow-head workflow-list
  workflow-tab-btn`.split(/\s+/).map(id => `settings-${id}`);

const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function productionFunction(name) {
  const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `${name} exists`);
  return match[0].replace(/^export /, '');
}

async function withModal(run) {
  const window = new Window();
  try {
    const start = html.indexOf('<div id="settings-modal"');
    const end = html.indexOf('<!-- (C1388)');
    assert.ok(start >= 0 && end > start, '#settings-modal markup not found in template.html');
    window.document.body.innerHTML = html.slice(start, end);
    await run(window.document);
  } finally {
    await window.happyDOM.close();
  }
}

// Bodies of every rule whose whole selector is `selector` (not one entry of a selector list).
function rule(selector) {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].trim().replace(/\s+/g, ' ') === selector)
    .map(m => m[2]);
  assert.ok(bodies.length, `no rule for ${selector}`);
  return bodies.join('\n');
}

test('every Settings pane is a stack of titled sections whose rows hold a label and a control column', async () => {
  await withModal((document) => {
    const panes = [...document.querySelectorAll('#settings-modal .modal-tab-panel')];
    assert.deepEqual(panes.map(el => el.dataset.tab), ['general', 'voice', 'workflow', 'memory', 'vcs']);
    for (const pane of panes) {
      const tab = pane.dataset.tab;
      const sections = [...pane.children].filter(el => el.matches('section.settings-section'));
      assert.ok(sections.length, `${tab} pane holds sections`);
      for (const child of pane.children) {
        assert.ok(child.matches('section.settings-section, .settings-notice'), `${tab}: #${child.id} is a section or a notice`);
      }
      for (const section of sections) {
        if (!section.children.length) continue; // filled at open time (Version Control's git options)
        const [title, ...rest] = section.children;
        assert.ok(title.matches('h3.settings-section-title'), `${tab}: each section starts with its title`);
        for (const el of rest) {
          assert.ok(el.matches('.settings-row, .settings-notice') || ROW_CONTAINERS.includes(el.id),
            `${tab}: ${el.id || el.className} is a row, a notice or a row container`);
        }
      }
    }
    for (const row of document.querySelectorAll('#settings-modal .settings-row')) {
      const [label, control, ...extra] = row.children;
      assert.ok(label?.classList.contains('settings-row-label'), `#${row.id}: label column first`);
      assert.ok(control?.classList.contains('settings-row-control'), `#${row.id}: control column second`);
      for (const el of extra) assert.ok(el.classList.contains('settings-notice'), `#${row.id}: only notices follow the columns`);
    }
    for (const hint of document.querySelectorAll('#settings-modal .settings-row-hint')) {
      assert.ok(hint.parentElement.classList.contains('settings-row-label'), `#${hint.id}: hints live in a row's label column`);
    }
  });
});

test('the rewrite keeps every element id the Settings code queries', async () => {
  await withModal((document) => {
    const missing = LEGACY_IDS.filter(id => !document.getElementById(id));
    assert.deepEqual(missing, []);
    const ids = [...document.querySelectorAll('#settings-modal [id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length, 'ids stay unique');
  });
});

test('the dialog ships no visible text of its own — labels come from t() at open time', async () => {
  await withModal((document) => {
    const baked = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (child.textContent.trim()) baked.push(child.textContent.trim());
        } else if (child.nodeType === 1 && !child.matches('option, optgroup, .settings-close')) {
          walk(child);
        }
      }
    };
    walk(document.getElementById('settings-modal'));
    assert.deepEqual(baked, []);
  });
});

test('openSettingsModal() localizes the dialog before the tab populators run', () => {
  const body = productionFunction('openSettingsModal');
  const at = body.indexOf('_localizeSettingsModal()');
  assert.ok(at > 0, 'openSettingsModal() calls _localizeSettingsModal()');
  assert.ok(at < body.indexOf('_populateSettingsAgentsRow()'), 'before the first populator');
});

for (const locale of ['en', 'uk']) {
  test(`_localizeSettingsModal() fills the title, every tab and section title and the fixed labels (${locale})`, async () => {
    await withModal((document) => {
      setLocale(locale);
      try {
        const table = source.match(/^const _SETTINGS_TEXT = \[[\s\S]*?^\];/m);
        assert.ok(table, '_SETTINGS_TEXT exists');
        const context = vm.createContext({ document, t });
        vm.runInContext(`${table[0]}\n${productionFunction('_localizeSettingsModal')}\nthis.localize = _localizeSettingsModal; this.table = _SETTINGS_TEXT;`, context);
        context.localize();
        for (const [id, key] of context.table) {
          assert.ok(document.getElementById(id), `#${id} exists`);
          assert.ok(key in LOCALES[locale], `${key} is translated in ${locale}`);
          assert.equal(document.getElementById(id).textContent, LOCALES[locale][key], `#${id}`);
        }
        const covered = new Set(context.table.map(([id]) => id));
        for (const el of document.querySelectorAll('#settings-modal .settings-title, #settings-modal .modal-tab-btn, #settings-modal .settings-section-title')) {
          assert.ok(covered.has(el.id), `#${el.id} is localized on open`);
        }
        const modal = document.getElementById('settings-modal');
        assert.equal(modal.getAttribute('aria-label'), LOCALES[locale]['settings.title']);
        assert.equal(modal.querySelector('.settings-close').getAttribute('aria-label'), LOCALES[locale]['settings.close']);
      } finally {
        setLocale('en');
      }
    });
  });
}

test('the Agents section renders one settings row per enabled agent, the default one badged', async () => {
  await withModal(async (document) => {
    const agents = {
      summary: 'Claude Code (opusplan) · Codex · Other Model (kimi-k3, glm-4.6)',
      entries: [
        { id: 'claude', label: 'Claude Code', isDefault: true, models: ['opusplan'] },
        { id: 'codex', label: 'Codex', isDefault: false, models: [] },
        { id: 'pi', label: 'Other Model', isDefault: false, models: ['kimi-k3', 'glm-4.6'] },
      ],
    };
    let ctx = { agents };
    let reads = 0;
    const window = { electronAPI: { api: { project: { config: async () => { reads++; return ctx; } } } } };
    const fetch = () => { throw new Error('Electron reads the project config over IPC'); };
    const context = vm.createContext({ document, window, fetch, t, escapeAttr, console });
    vm.runInContext(`${productionFunction('_populateSettingsAgentsRow')}\nthis.populate = _populateSettingsAgentsRow;`, context);
    const section = document.getElementById('settings-agents-section');
    const rows = () => [...document.querySelectorAll('#settings-agents-summary > .settings-row')];

    await context.populate();
    assert.equal(section.hidden, false);
    assert.deepEqual(rows().map(r => r.dataset.agent), ['claude', 'codex', 'pi']);
    for (const row of rows()) {
      assert.ok(row.children[0].classList.contains('settings-row-label'));
      assert.ok(row.children[1].classList.contains('settings-row-control'));
    }
    assert.equal(rows()[0].querySelector('.settings-row-note').textContent, t('settings.agentDefault'));
    assert.equal(rows()[1].querySelector('.settings-row-note'), null);
    assert.deepEqual(rows().map(r => r.querySelector('.settings-row-value').textContent),
      ['opusplan', t('settings.agentModelDefault'), 'kimi-k3, glm-4.6']);
    assert.ok(document.getElementById('settings-agents-row'), 'the Edit row stays after the agent rows');

    // agents-modal.js's onSaved hands the saved summary straight in, without a re-read.
    await context.populate({ entries: [agents.entries[1]] });
    assert.equal(reads, 1);
    assert.deepEqual(rows().map(r => r.dataset.agent), ['codex']);

    await context.populate({ entries: [] });
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].querySelector('.settings-row-label').textContent, t('settings.agentsNone'));

    ctx = null; // no project bound to this window
    await context.populate();
    assert.equal(section.hidden, true);
  });
});

test('rows built at open time use the shared row classes', () => {
  for (const name of ['_populateSettingsAgentsRow', '_populateSettingsPermissionModeRow', '_populateSettingsVersionControlTab', '_voiceModelRowHtml']) {
    const body = productionFunction(name);
    assert.match(body, /settings-row-label/, `${name} emits .settings-row-label`);
    assert.match(body, /settings-row-control/, `${name} emits .settings-row-control`);
  }
});

test('rows are a two-column grid on the pane-wide label column, with plain-text hints', () => {
  const row = rule('.settings-row');
  assert.match(row, /display:\s*grid/);
  assert.match(row, /grid-template-columns:\s*var\(--settings-label-col\)\s+minmax\(0,\s*1fr\)/);
  assert.match(row, /padding:\s*12px 0/);
  const pane = rule('.settings-body');
  for (const token of ['--settings-label-col', '--settings-control-w', '--settings-control-h']) {
    assert.match(pane, new RegExp(`${token}:`), `.settings-body defines ${token}`);
  }
  assert.match(rule('.settings-row-control > select'), /width:\s*min\(100%,\s*var\(--settings-control-w\)\)/);
  assert.doesNotMatch(rule('.settings-row-hint'), /background|border|display/, 'a hint is text, not a balloon');
  for (const selector of ['.settings-row[hidden]', '.settings-notice[hidden]']) {
    assert.match(rule(selector), /display:\s*none/);
  }
});

test('the per-tab one-off layout rules are gone', () => {
  const classTokens = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)));
  for (const legacy of [
    '.settings-row-controls', '.settings-wf-caption', '.settings-vcs-option', '.settings-vcs-suboption',
    '.settings-voice-engine-list', '.settings-voice-key-row', '.settings-voice-key-status',
    '#settings-notifications-style-hint', '.permission-mode-section', '.permission-mode-label',
  ]) {
    assert.ok(!css.includes(legacy), `${legacy} has no rule`);
    if (legacy.startsWith('.')) assert.ok(!classTokens.has(legacy.slice(1)), `${legacy} is not used in template.html`);
  }
});
