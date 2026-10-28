import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// (TPT9110) The Settings modal is a fixed-size dialog: switching tabs never resizes it, so the
// title, tab strip and close button stay where they are, and the visible tab pane is the only
// scroll region. CSS isn't executable under node, so the layout invariants are source-scanned,
// same as card-desc-scroll.test.js; the tab-switch focus/scroll behavior is exercised against
// the real task-board.js in dialog-focus.test.js.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

// Body of the first rule whose selector text matches `selectorRe` (selector must end at `{`).
function ruleBody(selectorRe) {
  const m = css.match(new RegExp(selectorRe.source + String.raw`\s*\{([^}]*)\}`));
  assert.ok(m, `rule ${selectorRe} not found`);
  return m[1];
}

test('the settings panel box is sized by the viewport and never scrolls itself', () => {
  const body = ruleBody(/\n\s*\.settings-panel/);
  assert.match(body, /display:\s*flex/);
  assert.match(body, /flex-direction:\s*column/);
  assert.match(body, /(?<![-\w])width:\s*min\(\d+vw,\s*\d+px\)/);
  assert.match(body, /(?<![-\w])height:\s*min\(\d+vh,\s*\d+px\)/);
  assert.match(body, /overflow:\s*hidden/);
  // A max-height or a scrolling panel would let the active tab's content size the dialog again.
  assert.doesNotMatch(body, /max-height|max-width|overflow-y/);
});

test('the title and the tab strip are fixed rows of the panel', () => {
  assert.match(ruleBody(/\n\s*\.settings-title/), /flex:\s*none/);
  assert.match(ruleBody(/\n\s*#settings-modal \.modal-tabs/), /flex:\s*none/);
});

test('each tab pane fills the rest of the panel and is the scroll region', () => {
  const body = ruleBody(/\n\s*\.settings-body/);
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
  // Short and scrolling panes keep the same content width.
  assert.match(body, /scrollbar-gutter:\s*stable/);
  // Rows never shrink to fit the pane; the pane scrolls instead.
  assert.match(ruleBody(/\n\s*\.settings-body > \*/), /flex-shrink:\s*0/);
});

test('the Workflow status list has no scroll of its own and its header sticks in the pane', () => {
  assert.doesNotMatch(ruleBody(/\n\s*\.settings-wf-table/), /overflow|max-height/);
  const head = ruleBody(/\n\s*\.settings-wf-head/);
  assert.match(head, /position:\s*sticky/);
  assert.match(head, /background:/);
});

test('every Settings tab pane is a direct child of the panel, after the tab strip', async () => {
  const window = new Window();
  try {
    const start = html.indexOf('<div id="settings-modal"');
    const end = html.indexOf('<!-- (C1388)');
    assert.ok(start >= 0 && end > start, '#settings-modal markup not found in template.html');
    window.document.body.innerHTML = html.slice(start, end);
    const panel = window.document.querySelector('#settings-modal > .settings-panel');
    assert.ok(panel, '.settings-panel must be the dialog box');
    const children = [...panel.children];
    const tabs = children.findIndex(el => el.classList.contains('modal-tabs'));
    assert.ok(tabs > children.findIndex(el => el.classList.contains('settings-title')), 'title precedes the tab strip');
    const panes = children.filter(el => el.classList.contains('modal-tab-panel'));
    assert.deepEqual(panes.map(el => el.dataset.tab), ['general', 'voice', 'workflow', 'memory', 'vcs']);
    for (const pane of panes) {
      assert.ok(pane.classList.contains('settings-body'), `${pane.dataset.tab} pane carries .settings-body`);
      assert.ok(children.indexOf(pane) > tabs, `${pane.dataset.tab} pane follows the tab strip`);
    }
    const buttons = [...panel.querySelectorAll('.modal-tabs > .modal-tab-btn')].map(el => el.dataset.tab);
    assert.deepEqual(buttons, panes.map(el => el.dataset.tab), 'one tab button per pane');
  } finally {
    await window.happyDOM.close();
  }
});
