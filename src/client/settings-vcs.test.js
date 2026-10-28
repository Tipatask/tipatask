import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { VCS_TYPES, VCS_GIT_FLAGS, buildVcsPatchBody } from './vcs-form.js';
import { LOCALES, setLocale, t } from './i18n.js';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (TPT62) Regression guards for the Settings modal's Version Control tab. Source-scan
// style, same DOM-free house pattern as settings-group-label.test.js/dialogs.test.js —
// private helpers are also exercised with a DOM below.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Extracts a top-level function body by name: from the `function <name>(` or
// `async function <name>(` declaration line up to (not including) the next top-level
// `function`/`async function` declaration. Good enough for this file's flat top-level
// function-declaration style (no nested same-named declarations).
function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `function ${name}() not found in source`);
  const startIdx = startMatch.index;
  const nextDeclRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + startMatch[0].length;
  const nextMatch = nextDeclRe.exec(source);
  const endIdx = nextMatch ? nextMatch.index : source.length;
  return source.slice(startIdx, endIdx);
}

test('openSettingsModal() populates the Version Control tab on every open', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'openSettingsModal');
  assert.match(body, /_populateSettingsVersionControlTab\(\)/);
});

test('writeProjectVcs() composes its PATCH body via buildVcsPatchBody(), never an inline object', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'writeProjectVcs');
  assert.match(
    body,
    /buildVcsPatchBody\(/,
    'writeProjectVcs() must build its PATCH body via buildVcsPatchBody() — the single ' +
      'place the dormant-flag rule (omit the four git flags unless type is git) is enforced'
  );
  assert.doesNotMatch(
    body,
    /vcs_worktree_enabled\s*:/,
    'writeProjectVcs() must never hand-build a body with a literal vcs_worktree_enabled ' +
      'key — that would bypass buildVcsPatchBody()\'s dormant-flag omission rule'
  );
});

test('writeProjectVcs() re-applies visible control state in a finally block on every outcome', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'writeProjectVcs');
  const finallyIdx = body.lastIndexOf('finally');
  assert.ok(finallyIdx !== -1, 'writeProjectVcs() must have a finally block');
  const finallyBody = body.slice(finallyIdx);
  assert.match(
    finallyBody,
    /_applyVcsControls\(\)/,
    'writeProjectVcs()\'s finally block must call _applyVcsControls() so the visible ' +
      'radio/checkbox state always matches whatever actually persisted, not just what ' +
      'the user clicked'
  );
});

test('_applyVcsControls() hides the git-only checkbox block unless the stored type is git', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, '_applyVcsControls');
  assert.match(body, /_vcsSettings\.type\s*!==\s*'git'/);
});

test('template.html declares the Version Control tab button and panel', () => {
  const html = readSource('template.html');
  assert.match(html, /id="settings-vcs-tab-btn"/);
  assert.match(html, /data-tab="vcs"/);
  assert.match(html, /id="settings-vcs-type-options"/);
  assert.match(html, /id="settings-vcs-git-options"/);
});

test('the Version Control tab caption/panel text stays empty markup (text set at open time, not baked in)', () => {
  const html = readSource('template.html');
  const capMatch = /<p class="settings-row-hint" id="settings-vcs-caption">([^<]*)<\/p>/.exec(html);
  assert.ok(capMatch, '#settings-vcs-caption not found in template.html');
  assert.strictEqual(
    capMatch[1].trim(),
    '',
    'the caption must stay empty in static markup — its text is set at runtime by ' +
      '_populateSettingsVersionControlTab(), never baked into template.html'
  );
});

test('Settings contains no merge-all action or handler', () => {
  assert.doesNotMatch(readSource('task-board.js'), /settings-vcs-merge-btn|openMergeBranchesModal/);
  assert.doesNotMatch(readSource('template.html'), /settings-vcs-merge-btn/);
});

// Exercise the actual private VCS functions and delegated listeners against a DOM,
// without loading unrelated board/terminal modules and their startup side effects.
function vcsHarness() {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = readSource('template.html').match(/<div class="settings-body modal-tab-panel" data-tab="vcs" hidden>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];
  const tabButton = document.createElement('button');
  tabButton.id = 'settings-vcs-tab-btn';
  document.body.append(tabButton);
  const source = readSource('task-board.js');
  const functions = source.slice(source.indexOf('let _vcsSettings ='), source.indexOf('function _renderWorkflowRows('));
  const listenersStart = source.indexOf("  const vcsTypeOptions = modal.querySelector('#settings-vcs-type-options');");
  const listeners = source.slice(listenersStart, source.indexOf('  // Notifications: status/Test button', listenersStart));
  const stored = { vcsType: 'git', vcsMergeEnabled: false };
  const writes = [];
  let failSave = false;
  const api = { project: {
    settings: async () => ({ ...stored }),
    update: async (body) => {
      writes.push(body);
      if (failSave) throw new Error('save failed');
      stored.vcsType = body.vcs_type;
      if ('vcs_merge_enabled' in body) stored.vcsMergeEnabled = body.vcs_merge_enabled;
    },
  } };
  const controls = new Function('document', 'api', 'VCS_TYPES', 'VCS_GIT_FLAGS', 'buildVcsPatchBody', 't', 'escapeAttr', 'showToast', 'console', `
    ${functions}
    const modal = document.body;
    ${listeners}
    return { populate: _populateSettingsVersionControlTab };
  `)(document, api, VCS_TYPES, VCS_GIT_FLAGS, buildVcsPatchBody, t,
    value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    () => {}, { error() {} });
  return {
    ...controls, window, document, writes, stored,
    failSave: () => { failSave = true; },
    async change(selector, checked) {
      const input = document.querySelector(selector);
      input.checked = checked;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

// (TPT9111) The tab is built on the shared Settings skeleton: the type radios are the segments of
// one .settings-row's control, and every git flag is its own row in the git-only section.
test('VCS settings render onto the shared section and row skeleton', async () => {
  setLocale('en');
  const h = vcsHarness();
  try {
    await h.populate();
    const group = h.document.querySelector('#settings-vcs-type-options');
    assert.ok(group.classList.contains('settings-row-control') && group.classList.contains('settings-segmented'));
    assert.equal(group.getAttribute('role'), 'radiogroup');
    assert.equal(group.closest('.settings-row').id, 'settings-vcs-type-row');
    assert.deepEqual([...group.querySelectorAll('input[name="settings-vcs-type"]')].map(el => el.value), VCS_TYPES.map(o => o.value));
    assert.equal(h.document.querySelector('#settings-vcs-caption').textContent, t('settings.vcs.caption'));
    assert.ok(h.document.querySelector('#settings-vcs-type-label').textContent.startsWith(t('settings.vcs.typeLabel')));
    const git = h.document.querySelector('#settings-vcs-git-options');
    assert.ok(git.classList.contains('settings-section'));
    assert.ok(git.firstElementChild.classList.contains('settings-section-title'));
    assert.equal(git.firstElementChild.textContent, t('settings.vcs.gitSection'));
    const rows = [...git.children].filter(el => el.classList.contains('settings-row'));
    assert.equal(rows.length, VCS_GIT_FLAGS.length);
    rows.forEach((row, i) => {
      const [label, control] = row.children;
      assert.ok(label.classList.contains('settings-row-label'), 'label column first');
      assert.ok(control.classList.contains('settings-row-control'), 'control column second');
      const input = control.querySelector('input[type="checkbox"]');
      assert.equal(input.dataset.field, VCS_GIT_FLAGS[i].field);
      assert.equal(label.querySelector('label').getAttribute('for'), input.id);
      assert.equal(label.querySelector('.settings-row-hint').textContent, t(VCS_GIT_FLAGS[i].hintKey));
    });
  } finally {
    await h.window.happyDOM.close();
  }
});

for (const locale of ['en', 'uk']) {
  test(`VCS settings render localized merge checkbox and persist it (${locale})`, async () => {
    setLocale(locale);
    const h = vcsHarness();
    try {
      await h.populate();
      const options = h.document.querySelector('#settings-vcs-git-options');
      const selector = 'input[data-field="vcs_merge_enabled"]';
      assert.equal(options.querySelectorAll('input[type="checkbox"]').length, 4);
      assert.equal(options.querySelectorAll('button').length, 0);
      assert.ok(options.textContent.includes(LOCALES[locale]['settings.vcs.mergeLabel']));
      assert.ok(options.textContent.includes(LOCALES[locale]['settings.vcs.mergeHint']));
      assert.equal(h.document.querySelector(selector).checked, false);
      await h.change(selector, true);
      assert.equal(h.writes.at(-1).vcs_merge_enabled, true);
      await h.populate();
      assert.equal(h.document.querySelector(selector).checked, true);
      await h.change('input[value="svn"]', true);
      assert.equal(options.hidden, true);
      assert.deepEqual(h.writes.at(-1), { vcs_type: 'svn' });
      await h.populate();
      await h.change('input[value="git"]', true);
      assert.equal(options.hidden, false);
      assert.equal(h.document.querySelector(selector).checked, true);
      await h.change(selector, false);
      await h.populate();
      assert.equal(h.document.querySelector(selector).checked, false);
      h.failSave();
      await h.change(selector, true);
      assert.equal(h.document.querySelector(selector).checked, false, 'failed save restores stored value');
      assert.equal(h.document.querySelector(selector).disabled, false);
    } finally {
      await h.window.happyDOM.close();
      setLocale('en');
    }
  });
}
