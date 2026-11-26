// (TPT9422) The identity form's Brand colors field, driven in happy-dom with the real module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

async function withDom(run, { accent = '' } = {}) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const globals = new Map();
  const install = (key, value) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['document', 'HTMLElement', 'Event', 'Node', 'navigator', 'localStorage']) install(key, window[key]);
  install('window', window);
  install('getComputedStyle', () => ({ getPropertyValue: name => (name === '--c-primary' ? accent : '') }));
  try {
    const picker = await import('./brand-color-picker.js');
    const i18n = await import('./i18n.js');
    i18n.setLocale('en');
    document.body.innerHTML = '<span id="label">Brand color</span><div id="host"></div>';
    const host = document.getElementById('host');
    const changes = [];
    await run({ picker, i18n, host, changes, window });
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const swatches = host => [...host.querySelectorAll('[data-brand-color-input]')];

test('no color reads as a highlighted "Not selected" chip with an Add button, never a default swatch', async () => {
  await withDom(async ({ picker, host }) => {
    picker.mountBrandColorPicker(host, { colors: [], labelledBy: 'label' });
    assert.equal(host.getAttribute('role'), 'group');
    assert.equal(host.getAttribute('aria-labelledby'), 'label');
    assert.equal(host.querySelector('[data-brand-colors-none]').textContent.trim(), 'Not selected');
    assert.equal(swatches(host).length, 0, 'no swatch pretends a color is chosen');
    assert.equal(host.querySelector('[data-brand-colors-add]').textContent.trim(), 'Add color');
  });
});

test('Add appends a visible, removable color up to three, then says three is the maximum', async () => {
  await withDom(async ({ picker, host, changes }) => {
    picker.mountBrandColorPicker(host, { colors: [], onChange: list => changes.push(list) });
    host.querySelector('[data-brand-colors-add]').click();
    assert.deepEqual(changes.at(-1), ['#0E8377'], 'the first color starts at the window accent fallback');
    assert.equal(host.querySelector('[data-brand-colors-none]'), null, 'the chip gives way to the swatch');
    assert.equal(document.activeElement === swatches(host)[0], true, 'focus lands on the new swatch');
    host.querySelector('[data-brand-colors-add]').click();
    host.querySelector('[data-brand-colors-add]').click();
    const [first, second, third] = changes.at(-1);
    assert.equal(changes.at(-1).length, 3);
    assert.equal(new Set([first, second, third]).size, 3, 'suggestions never repeat a color');
    assert.equal(host.querySelector('[data-brand-colors-add]'), null, 'no fourth color');
    assert.equal(host.querySelector('[data-brand-colors-full]').textContent, 'Three colors at most.');
    const roles = [...host.querySelectorAll('.brand-color-role')].map(node => node.textContent);
    assert.deepEqual(roles, ['Primary', 'Secondary', 'Secondary'], 'the order is the accent order');
    await settle();
    assert.match(host.querySelector('[data-brand-colors-live]').textContent, /^Brand color #[0-9A-F]{6} added\.$/);
  });
});

test('the first new color starts at the window accent', async () => {
  await withDom(async ({ picker, host, changes }) => {
    picker.mountBrandColorPicker(host, { onChange: list => changes.push(list) });
    host.querySelector('[data-brand-colors-add]').click();
    assert.deepEqual(changes.at(-1), ['#7C3AED']);
  }, { accent: '#7c3aed' });
});

test('editing a swatch updates it in place, so the open native picker stays bound to its input', async () => {
  await withDom(async ({ picker, host, changes, window }) => {
    picker.mountBrandColorPicker(host, { colors: ['#0E8377', '#FF6600'], onChange: list => changes.push(list) });
    const [first, second] = swatches(host);
    first.value = '#1d4ed8';
    first.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(changes.at(-1), ['#1D4ED8', '#FF6600']);
    assert.equal(first.isConnected, true, 'same element, not a re-render');
    const item = first.closest('[data-brand-color]');
    assert.equal(item.querySelector('[data-brand-color-hex]').textContent, '#1D4ED8');
    assert.match(item.querySelector('.brand-color-swatch').getAttribute('style'), /--swatch:\s*#1D4ED8/);
    assert.equal(first.getAttribute('aria-label'), 'Brand color 1, Primary: #1D4ED8');

    // Another swatch's color is not taken twice; the panel closing restores this swatch's color.
    const before = changes.length;
    second.value = '#1d4ed8';
    second.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(changes.length, before, 'a duplicate is not committed');
    second.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(second.value, '#ff6600');
  });
});

test('removing a color re-orders the roles and keeps keyboard focus in the field', async () => {
  await withDom(async ({ picker, host, changes }) => {
    picker.mountBrandColorPicker(host, { colors: ['#0E8377', '#FF6600', '#7C3AED'], onChange: list => changes.push(list) });
    const remove = host.querySelector('[data-brand-color-remove="0"]');
    assert.equal(remove.getAttribute('aria-label'), 'Remove brand color 1 (#0E8377)');
    remove.click();
    assert.deepEqual(changes.at(-1), ['#FF6600', '#7C3AED'], 'the second color becomes the primary');
    assert.equal(host.querySelector('.brand-color-role').textContent, 'Primary');
    assert.equal(document.activeElement === host.querySelector('[data-brand-color-remove="0"]'), true);
    host.querySelector('[data-brand-color-remove="1"]').click();
    host.querySelector('[data-brand-color-remove="0"]').click();
    assert.deepEqual(changes.at(-1), [], 'all removed: none selected');
    assert.ok(host.querySelector('[data-brand-colors-none]'), 'back to the Not selected chip');
    assert.equal(document.activeElement === host.querySelector('[data-brand-colors-add]'), true, 'focus moves to Add');
  });
});

test('the field follows the project language', async () => {
  await withDom(async ({ picker, i18n, host }) => {
    i18n.setLocale('uk');
    picker.mountBrandColorPicker(host, { colors: [] });
    assert.equal(host.querySelector('[data-brand-colors-none]').textContent.trim(), 'Не вибрано');
    assert.equal(host.querySelector('[data-brand-colors-add]').textContent.trim(), 'Додати колір');
    i18n.setLocale('en');
  });
});

test('suggested colors are distinct from the ones already chosen', async () => {
  const { suggestBrandColor } = await import('./brand-color-picker.js');
  assert.equal(suggestBrandColor([], '#ff6600'), '#FF6600');
  assert.equal(suggestBrandColor([], 'not a color'), '#0E8377');
  const second = suggestBrandColor(['#0E8377']);
  assert.match(second, /^#[0-9A-F]{6}$/);
  assert.notEqual(second, '#0E8377');
  const third = suggestBrandColor(['#0E8377', second]);
  assert.ok(![second, '#0E8377'].includes(third));
});
