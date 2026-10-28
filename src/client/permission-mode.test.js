import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  AGENT_PERMISSION_MODES, PERMISSION_MODE_LABEL_KEYS, PERMISSION_MODE_HINT_KEYS,
  PERMISSION_MODE_ICONS, permissionModeIcon,
  isAgentPermissionMode, normalizePermissionMode, permissionModeLabel, projectDefaultLabel,
  effectivePermissionMode, cowboyModeOn, permissionModeTip, buildTaskModeOptions, buildProjectModeOptions,
  liveModeOptions, liveModeState, liveModeLabel, buildLiveModeOptions, liveModeErrorText, LIVE_MODE_ERROR_REASONS,
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

// (TPT9161) Cowboy-coding mode counts only while the task starts in Bypass, from either source.
test('cowboyModeOn needs the flag and an effective Bypass; the tip carries the marker in both locales', () => {
  assert.equal(cowboyModeOn({ agentPermissionMode: 'bypass', cowboyMode: true }, 'auto'), true);
  assert.equal(cowboyModeOn({ agentPermissionMode: null, cowboyMode: true }, 'bypass'), true, 'inherited Bypass');
  assert.equal(cowboyModeOn({ agent_permission_mode: 'bypass', cowboy_mode: 1 }, null), true, 'raw API row');
  assert.equal(cowboyModeOn({ agentPermissionMode: 'bypass', cowboyMode: false }, 'bypass'), false);
  assert.equal(cowboyModeOn({ agentPermissionMode: 'bypass' }, 'bypass'), false, 'no field is off');
  for (const mode of ['plan', 'auto', null]) {
    assert.equal(cowboyModeOn({ agentPermissionMode: mode, cowboyMode: true }, mode === null ? 'auto' : 'bypass'), false, `a stored flag under ${mode ?? 'inherited Auto'} is off`);
  }
  assert.equal(cowboyModeOn(null, 'bypass'), false);
  assert.equal(permissionModeTip({ agentPermissionMode: 'bypass', cowboyMode: true }, 'auto', t), 'Permission mode: Bypass · 🤠 Cowboy-coding mode');
  assert.equal(permissionModeTip({ agentPermissionMode: null, cowboyMode: true }, 'bypass', t), 'Permission mode: Project Default (Bypass) · 🤠 Cowboy-coding mode');
  assert.equal(permissionModeTip({ agentPermissionMode: 'auto', cowboyMode: true }, 'bypass', t), 'Permission mode: Auto mode', 'no marker outside Bypass');
  assert.equal(permissionModeTip({ agentPermissionMode: 'bypass', cowboyMode: false }, 'auto', t), 'Permission mode: Bypass');
  setLocale('uk');
  assert.equal(permissionModeTip({ agentPermissionMode: 'bypass', cowboyMode: true }, 'auto', t), 'Режим дозволів: Без підтверджень · 🤠 Ковбойський режим');
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

// (TPT9139) The terminal header's live selector: allowed targets, one state shape, and labels
// that never present a requested mode as applied.
test('liveModeOptions offers Auto/Bypass from Plan or a legacy run and only the other execution mode after, never Plan', () => {
  for (const from of ['plan', null, undefined, '', 'typo']) assert.deepEqual(liveModeOptions(from), ['auto', 'bypass']);
  assert.deepEqual(liveModeOptions('auto'), ['bypass']);
  assert.deepEqual(liveModeOptions('bypass'), ['auto']);
  assert.deepEqual(liveModeOptions('accept_edits'), ['bypass'], 'a retired stored mode reads as Auto');
  for (const from of ['plan', 'auto', 'bypass', null]) assert.ok(!liveModeOptions(from).includes('plan'));
});

test('liveModeState folds every carrier into one shape; only the server can make a run switchable', () => {
  assert.deepEqual(liveModeState('auto'), { requested: 'auto', confirmed: 'auto', pending: false, error: null, supported: false });
  assert.deepEqual(liveModeState(null), { requested: null, confirmed: null, pending: false, error: null, supported: false });
  assert.deepEqual(liveModeState({ requested: 'bypass', confirmed: 'plan', pending: true, error: null, supported: true, extra: 1 }),
    { requested: 'bypass', confirmed: 'plan', pending: true, error: null, supported: true });
  assert.deepEqual(liveModeState({ requested: 'plan2', confirmed: 'auto', pending: 'yes', supported: 'true' }),
    { requested: null, confirmed: 'auto', pending: false, error: null, supported: false });
  const refused = liveModeState({ requested: 'auto', confirmed: 'plan', error: { code: 'EPERMISSION_MODE', reason: 'unsupported', message: 'No' }, supported: true });
  assert.deepEqual(refused.error, { code: 'EPERMISSION_MODE', reason: 'unsupported', message: 'No' });
  assert.equal(refused.supported, false, 'a run refused as unsupported stops offering the selector');
  assert.deepEqual(liveModeState({ confirmed: 'auto', error: {} }).error, { code: '', reason: 'failed', message: '' });
});

test('liveModeLabel shows the confirmed mode, or "Switching to …" while pending — never a requested mode as applied', () => {
  assert.equal(liveModeLabel({ requested: 'plan', confirmed: 'plan' }, t), 'Plan mode');
  assert.equal(liveModeLabel({ requested: 'bypass', confirmed: 'plan', pending: true }, t), 'Switching to Bypass…');
  assert.equal(liveModeLabel({ requested: 'bypass', confirmed: 'plan', pending: false, error: { reason: 'failed' } }, t), 'Plan mode');
  assert.equal(liveModeLabel({ requested: 'auto', confirmed: 'auto', pending: true }, t), 'Auto mode');
  assert.equal(liveModeLabel({ requested: 'yolo', confirmed: 'auto', pending: true }, t), 'Auto mode');
  assert.equal(liveModeLabel('bypass', t), 'Bypass');
  assert.equal(liveModeLabel({ confirmed: null, requested: 'auto', pending: true }, t), 'Switching to Auto mode…');
  setLocale('uk');
  assert.equal(liveModeLabel({ requested: 'auto', confirmed: 'plan', pending: true }, t), 'Перемикання на «Автоматичний режим»…');
  setLocale('en');
});

test('buildLiveModeOptions: the confirmed mode first and selected, then the allowed targets; a legacy run starts at a disabled Not set', () => {
  const plan = buildLiveModeOptions('plan', t);
  assert.deepEqual(plan.map(r => [r.value, r.selected]), [['plan', true], ['auto', false], ['bypass', false]]);
  assert.match(plan[0].hint, /can't return to Plan\. An action already running is not cancelled\.$/);
  assert.equal(plan[1].hint, LOCALES.en['permissionMode.hint.auto']);
  assert.ok(plan.every(r => r.icon === permissionModeIcon(r.value)));
  const auto = buildLiveModeOptions('auto', t);
  assert.deepEqual(auto.map(r => [r.value, r.selected]), [['auto', true], ['bypass', false]]);
  assert.equal(auto[0].hint, "This run's mode. A switch applies from the agent's next action. An action already running is not cancelled.");
  assert.deepEqual(buildLiveModeOptions('bypass', t).map(r => r.value), ['bypass', 'auto']);
  const legacy = buildLiveModeOptions(null, t);
  assert.deepEqual(legacy.map(r => r.value), ['', 'auto', 'bypass']);
  assert.equal(legacy[0].placeholder, true);
  assert.equal(legacy[0].label, 'Not set');
  assert.ok(legacy[0].hint.startsWith(LOCALES.en['terminal.permission.currentPlan']));
});

test('(TPT9136) a run\'s native modes: kept from server frames, Auto names its fallback, an unreachable Bypass is disabled', () => {
  const state = liveModeState({ requested: 'plan', confirmed: 'plan', supported: true, native: { auto: 'acceptEdits', bypass: false, extra: 1 } });
  assert.deepEqual(state.native, { auto: 'acceptEdits', bypass: false });
  assert.deepEqual(liveModeState({ confirmed: 'auto', native: { auto: 'weird' } }).native, { auto: 'auto', bypass: true });
  assert.equal('native' in liveModeState({ confirmed: 'auto' }), false);
  const plan = buildLiveModeOptions('plan', t, state.native);
  assert.deepEqual(plan.map(r => [r.value, !!r.disabled]), [['plan', false], ['auto', false], ['bypass', true]]);
  assert.equal(plan[1].hint, LOCALES.en['terminal.permission.autoFallback']);
  assert.equal(plan[2].hint, LOCALES.en['terminal.permission.bypassUnavailable']);
  const auto = buildLiveModeOptions('auto', t, { auto: 'acceptEdits', bypass: true });
  assert.ok(auto[0].hint.startsWith(LOCALES.en['terminal.permission.autoFallback']));
  assert.equal(auto[1].disabled, undefined);
  assert.deepEqual(buildLiveModeOptions('plan', t, { auto: 'auto', bypass: true }), buildLiveModeOptions('plan', t));
  for (const key of ['terminal.permission.autoFallback', 'terminal.permission.bypassUnavailable']) {
    assert.ok(LOCALES.uk[key]?.trim() && LOCALES.uk[key] !== LOCALES.en[key], key);
  }
});

test('liveModeErrorText names the target, a localized reason (server text for unknown ones) and the mode the run keeps', () => {
  const failed = (reason, extra = {}) => liveModeErrorText({ requested: 'bypass', confirmed: 'auto', error: { reason, message: 'Server words.' }, ...extra }, t);
  assert.equal(failed('unconfirmed'), "Couldn't switch to Bypass: the agent didn't confirm the new mode. This run stays in Auto mode.");
  assert.equal(failed('native_timeout'), "Couldn't switch to Bypass: Server words. This run stays in Auto mode.");
  assert.equal(liveModeErrorText({ requested: 'typo', confirmed: null, error: { reason: 'invalid_target' } }, t),
    "Couldn't change the permission mode: choose Auto mode or Bypass.");
  assert.equal(liveModeErrorText({ requested: 'auto', confirmed: 'plan', error: { reason: 'offline' } }, t),
    "Couldn't switch to Auto mode: the terminal isn't connected. Try again once it reconnects. This run stays in Plan mode.");
  for (const reason of LIVE_MODE_ERROR_REASONS) {
    for (const locale of ['en', 'uk']) assert.ok(LOCALES[locale][`terminal.permission.reason.${reason}`]?.trim(), `${locale} reason.${reason}`);
    assert.notEqual(LOCALES.uk[`terminal.permission.reason.${reason}`], LOCALES.en[`terminal.permission.reason.${reason}`]);
  }
  setLocale('uk');
  assert.equal(failed('unsupported'), 'Не вдалося перемкнути на «Без підтверджень»: цей агент не може змінити режим дозволів під час роботи. У цьому запуску й далі діє «Автоматичний режим».');
  setLocale('en');
});
