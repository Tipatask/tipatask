import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Settings rows and notices (.settings-row, .settings-notice) are toggled with the `hidden`
// attribute. Any author rule that sets `display` on one of them outranks the UA [hidden] rule,
// so without its own [hidden] override a "hidden" notice still paints as an empty warning
// balloon (and a hidden row still shows its label and control).
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selectors: sel.split(',').map((s) => s.trim()).filter(Boolean),
  body,
}));
const HIDEABLE = ['.settings-section', '.settings-row', '.settings-row-hint', '.settings-notice'];

test('every hideable Settings row or notice class that sets display has a [hidden] display:none override', () => {
  for (const target of HIDEABLE) {
    const setsDisplay = rules.some((r) => r.selectors.includes(target) && /(^|;|\s)display\s*:/.test(r.body));
    if (!setsDisplay) continue;
    const hiddenOverride = rules.some((r) => r.selectors.includes(`${target}[hidden]`) && /display\s*:\s*none/.test(r.body));
    assert.ok(hiddenOverride, `${target} sets display but has no ${target}[hidden] { display: none } override`);
  }
});

test('notices stay hideable despite their display:flex, with no one-off rule per notice', () => {
  assert.ok(rules.some((r) => r.selectors.includes('.settings-notice') && /display\s*:\s*flex/.test(r.body)));
  assert.ok(rules.some((r) => r.selectors.includes('.settings-notice[hidden]') && /display\s*:\s*none/.test(r.body)));
  for (const id of ['#settings-notifications-hint', '#settings-notifications-style-hint']) {
    assert.ok(!rules.some((r) => r.selectors.some((s) => s.startsWith(id))), `${id} must not carry its own rule`);
  }
});

test('both notification notices ship hidden, so no balloon shows before Settings populates them', () => {
  assert.match(html, /<div class="settings-notice" id="settings-notifications-hint" hidden>/);
  assert.match(html, /<div class="settings-notice settings-notice--info" id="settings-notifications-style-hint" hidden>/);
});
