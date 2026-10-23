import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Settings ▸ General notification hint rows (.settings-row-hint) are toggled with the `hidden`
// attribute. Any author rule that sets `display` on one of them outranks the UA [hidden] rule,
// so without its own [hidden] override a "hidden" row still paints as an empty warning balloon.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selectors: sel.split(',').map((s) => s.trim()).filter(Boolean),
  body,
}));
const HINT_ROWS = ['.settings-row-hint', '#settings-notifications-hint', '#settings-notifications-style-hint'];

test('every notification hint row that sets display has a [hidden] display:none override', () => {
  for (const target of HINT_ROWS) {
    const setsDisplay = rules.some((r) => r.selectors.includes(target) && /(^|;|\s)display\s*:/.test(r.body));
    if (!setsDisplay) continue;
    const hiddenOverride = rules.some((r) => r.selectors.includes(`${target}[hidden]`) && /display\s*:\s*none/.test(r.body));
    assert.ok(hiddenOverride, `${target} sets display but has no ${target}[hidden] { display: none } override`);
  }
});

test('the macOS Alerts-style hint row stays hideable despite its display:flex', () => {
  assert.ok(rules.some((r) => r.selectors.includes('#settings-notifications-style-hint') && /display\s*:\s*flex/.test(r.body)));
  assert.ok(rules.some((r) => r.selectors.includes('#settings-notifications-style-hint[hidden]') && /display\s*:\s*none/.test(r.body)));
});

test('both notification hint rows ship hidden, so no balloon shows before Settings populates them', () => {
  assert.match(html, /<div class="settings-row-hint" id="settings-notifications-hint" hidden>/);
  assert.match(html, /<div class="settings-row-hint" id="settings-notifications-style-hint" hidden>/);
});
