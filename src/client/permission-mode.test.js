import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  AGENT_PERMISSION_MODES, PERMISSION_MODE_LABEL_KEYS, PERMISSION_MODE_HINT_KEYS,
  PERMISSION_MODE_ICONS, permissionModeIcon,
  isAgentPermissionMode, normalizePermissionMode, permissionModeLabel, projectDefaultLabel,
  effectivePermissionMode, permissionModeTip, buildTaskModeOptions, buildProjectModeOptions,
} from './permission-mode.js';
import { t, setLocale, LOCALES } from './i18n.js';

// (TPT9063) Pure helpers behind the card's permission-mode button and dialog — canonical order,
// label/hint keys in both locales, inheritance, tips and the two option lists.

after(() => setLocale('en'));

test('every mode and inheritance have distinct decorative shield SVGs; helpers stay zero-import', () => {
  const modes = ['inherited', ...AGENT_PERMISSION_MODES];
  assert.deepEqual(Object.keys(PERMISSION_MODE_ICONS), modes);
  assert.equal(new Set(Object.values(PERMISSION_MODE_ICONS)).size, modes.length);
  // Compare geometry too: changing only a class does not make a distinct glyph.
  assert.equal(new Set(Object.values(PERMISSION_MODE_ICONS).map(svg => svg.replace(/class="[^"]*"/g, ''))).size, modes.length);
  for (const mode of modes) {
    const svg = PERMISSION_MODE_ICONS[mode];
    assert.match(svg, /^<svg .*viewBox="0 0 16 16"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /aria-hidden="true" focusable="false"/);
    assert.match(svg, /<path /);
    assert.equal(permissionModeIcon(mode), svg);
  }
  for (const value of [null, undefined, '', 'unknown', '__proto__']) {
    assert.equal(permissionModeIcon(value), PERMISSION_MODE_ICONS.inherited);
  }
  const source = readFileSync(new URL('./permission-mode.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
});

test('AGENT_PERMISSION_MODES is the canonical three in order and every mode has a label + hint key in en and uk', () => {
  assert.deepEqual([...AGENT_PERMISSION_MODES], ['plan', 'auto', 'bypass']);
  for (const mode of AGENT_PERMISSION_MODES) {
    for (const key of [PERMISSION_MODE_LABEL_KEYS[mode], PERMISSION_MODE_HINT_KEYS[mode]]) {
      assert.ok(LOCALES.en[key]?.trim(), `en.${key}`);
      assert.ok(LOCALES.uk[key]?.trim(), `uk.${key}`);
      assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must be translated`);
    }
  }
  assert.deepEqual(AGENT_PERMISSION_MODES.map(m => t(PERMISSION_MODE_LABEL_KEYS[m])),
    ['Plan mode', 'Auto mode', 'Bypass']);
});

test('isAgentPermissionMode / normalizePermissionMode accept only the three', () => {
  for (const mode of AGENT_PERMISSION_MODES) {
    assert.equal(isAgentPermissionMode(mode), true);
    assert.equal(normalizePermissionMode(mode), mode);
  }
  for (const v of [null, undefined, '', 'Plan', ' auto ', 'default', 5, {}]) {
    assert.equal(isAgentPermissionMode(v), false);
    assert.equal(normalizePermissionMode(v), null);
  }
});

test('effectivePermissionMode: an override wins; null, unknown or missing defers to the project default (snake_case accepted)', () => {
  assert.deepEqual(effectivePermissionMode({ agentPermissionMode: 'plan' }, 'auto'), { mode: 'plan', inherited: false });
  assert.deepEqual(effectivePermissionMode({ agentPermissionMode: null }, 'auto'), { mode: 'auto', inherited: true });
  assert.deepEqual(effectivePermissionMode({}, null), { mode: null, inherited: true });
  assert.deepEqual(effectivePermissionMode({ agentPermissionMode: 'yolo' }, 'auto'), { mode: 'auto', inherited: true });
  assert.deepEqual(effectivePermissionMode({ agent_permission_mode: 'bypass' }, 'auto'), { mode: 'bypass', inherited: false });
  assert.deepEqual(effectivePermissionMode(null, 'plan'), { mode: 'plan', inherited: true });
});

test('permissionModeLabel / projectDefaultLabel / permissionModeTip name the effective mode in both locales', () => {
  assert.equal(permissionModeLabel('auto', t), 'Auto mode');
  assert.equal(permissionModeLabel(null, t), 'Not set');
  assert.equal(projectDefaultLabel('auto', t), 'Project Default (Auto mode)');
  assert.equal(projectDefaultLabel(null, t), 'Project Default (Not set)');
  assert.equal(permissionModeTip({ agentPermissionMode: null }, 'auto', t), 'Permission mode: Project Default (Auto mode)');
  assert.equal(permissionModeTip({ agentPermissionMode: null }, null, t), 'Permission mode: Project Default (Not set)');
  assert.equal(permissionModeTip({ agentPermissionMode: 'plan' }, 'auto', t), 'Permission mode: Plan mode');
  setLocale('uk');
  assert.equal(permissionModeTip({ agentPermissionMode: null }, 'auto', t), 'Режим дозволів: Типовий для проєкту (Автоматичний режим)');
  assert.equal(permissionModeTip({ agentPermissionMode: 'bypass' }, 'auto', t), 'Режим дозволів: Без підтверджень');
  setLocale('en');
});

test('buildTaskModeOptions: Project Default (…) first with value "", then the three in order, exactly one selected, inherited hint', () => {
  const rows = buildTaskModeOptions(null, 'auto', t);
  assert.deepEqual(rows.map(r => r.value), ['', 'plan', 'auto', 'bypass']);
  assert.deepEqual(rows.map(r => r.selected), [true, false, false, false]);
  assert.equal(rows[0].label, 'Project Default (Auto mode)');
  assert.equal(rows[0].hint, 'Inherits the project default: Auto mode — The agent judges each action and asks only when unsure.');
  assert.equal(rows[2].hint, 'The agent judges each action and asks only when unsure.');
  assert.ok(rows.every(r => !r.placeholder));
  assert.ok(rows.every(r => r.icon === permissionModeIcon(r.value)));
  const overridden = buildTaskModeOptions('bypass', 'auto', t);
  assert.deepEqual(overridden.map(r => r.selected), [false, false, false, true]);
  const unset = buildTaskModeOptions(null, null, t);
  assert.equal(unset[0].label, 'Project Default (Not set)');
  assert.equal(unset[0].hint, 'Until a mode is chosen, agents keep their current behaviour.');
});

test('buildProjectModeOptions: the three, plus a disabled "Not set" placeholder only while null', () => {
  const unset = buildProjectModeOptions(null, t);
  assert.equal(unset.length, 4);
  assert.deepEqual(unset[0], { value: '', label: 'Not set', hint: 'Until a mode is chosen, agents keep their current behaviour.', icon: permissionModeIcon(null), selected: true, placeholder: true });
  assert.ok(unset.every(r => r.icon === permissionModeIcon(r.value)));
  assert.deepEqual(unset.slice(1).map(r => r.value), ['plan', 'auto', 'bypass']);
  assert.ok(unset.slice(1).every(r => !r.selected));
  const set = buildProjectModeOptions('auto', t);
  assert.equal(set.length, 3);
  assert.ok(set.every(r => !r.placeholder));
  assert.deepEqual(set.map(r => r.selected), [false, true, false]);
  assert.equal(buildProjectModeOptions('yolo', t).length, 4, 'an unknown stored value renders as Not set');
});

test('retired stored modes display and select Auto without losing task overrides', () => {
  for (const mode of ['always_ask', 'accept_edits']) {
    assert.equal(isAgentPermissionMode(mode), false);
    assert.equal(normalizePermissionMode(mode), 'auto');
    assert.equal(permissionModeLabel(mode, t), 'Auto mode');
    assert.equal(permissionModeIcon(mode), PERMISSION_MODE_ICONS.auto);
    assert.deepEqual(effectivePermissionMode({ agentPermissionMode: mode }, 'bypass'), { mode: 'auto', inherited: false });
    assert.equal(buildTaskModeOptions(mode, 'plan', t).find(r => r.selected).value, 'auto');
    assert.equal(buildProjectModeOptions(mode, t).find(r => r.selected).value, 'auto');
    assert.match(buildTaskModeOptions(null, mode, t)[0].hint, /Auto mode — The agent/);
  }
});
