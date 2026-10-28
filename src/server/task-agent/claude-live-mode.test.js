'use strict';

// (TPT9136) Claude native permission modes: launch resolution (claude-live-mode.js
// resolveNativePermissions()), the Shift+Tab cycle model, the screen tracker replayed against real
// claude PTY output (fixtures/attention/claude-permission-modes.json), and live switching against a
// fake claude TUI that repaints its whole screen on every change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-claude-live-'));
process.env.TIPATASK_PROJECT_ROOT = process.env.TIPATASK_PROJECT_ROOT || scratch;
process.env.TIPATASK_USER_DATA = process.env.TIPATASK_USER_DATA || scratch;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const live = require('./claude-live-mode');
const ClaudeAgent = require('./claude-agent');
const { getTaskAgent } = require('./index');
const { buildPermissionPolicy } = require('../permission-policy');
const { createSession } = require('../session-state');
const { stripAnsi, stripOscChunk, feedAttentionChunk, requestPermissionMode } = require('../terminal-session');
const { reflowChunk } = require('../screen-reflow');

const FIXTURE = require('../../../fixtures/attention/claude-permission-modes.json');
const recording = (name) => FIXTURE.recordings[name];
const SHIFT_TAB = live.SHIFT_TAB;

// ── `claude --help` capabilities ──

const HELP_2_1_311 = `Options:
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
                                        as an option, without it being enabled
                                        by default.
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print (choices: "host", "none")`;
const HELP_2_1_154 = HELP_2_1_311.replace('"manual"', '"default"');
const HELP_NO_AUTO = `  --permission-mode <mode>  Permission mode to use for the session (choices:
                            "acceptEdits", "bypassPermissions", "default", "plan")
  --resume`;

test('help capabilities: auto and the bypass pre-enable flag are read from the wrapped choice list', () => {
  assert.deepEqual(live.parsePermissionChoices(HELP_2_1_311), ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  assert.deepEqual(live.cliPermissionCapabilities(HELP_2_1_311), {
    choices: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'], autoMode: true, allowBypassFlag: true,
  });
  assert.equal(live.cliPermissionCapabilities(HELP_2_1_154).autoMode, true, '2.1.154 already lists auto');
  assert.deepEqual(live.cliPermissionCapabilities(HELP_NO_AUTO), {
    choices: ['acceptEdits', 'bypassPermissions', 'default', 'plan'], autoMode: false, allowBypassFlag: false,
  });
  for (const help of [null, '', 'Usage: claude [options]']) {
    assert.deepEqual(live.cliPermissionCapabilities(help), { choices: [], autoMode: false, allowBypassFlag: false });
  }
});

// ── Launch resolution ──

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-claude-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { root, config: path.join(root, 'profile'), project: path.join(root, 'project'), managed: path.join(root, 'managed') };
  for (const dir of [dirs.config, dirs.project, dirs.managed]) fs.mkdirSync(dir, { recursive: true });
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const resolve = (opts = {}) => live.resolveNativePermissions({
    capabilities: { autoMode: true, allowBypassFlag: true }, projectRoot: dirs.project,
    env: { CLAUDE_CONFIG_DIR: dirs.config }, managedDir: dirs.managed, isRoot: () => false, ...opts,
  });
  return { dirs, put, resolve };
}
const policy = (mode, source = 'task') => buildPermissionPolicy({ mode, source }, 'claude');
const projectDefault = (mode) => ({ getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }) });

test('Auto launches native auto unless the CLI, any settings source or the cached account gate rules it out', async (t) => {
  const { dirs, put, resolve } = profile(t);
  assert.deepEqual(await resolve({ policy: policy('auto') }),
    { launch: 'auto', auto: 'auto', autoReason: null, bypass: false, bypassReason: 'project', preEnableBypass: false });
  assert.deepEqual(await resolve({ policy: policy('auto'), capabilities: { autoMode: false, allowBypassFlag: true } }),
    { launch: 'acceptEdits', auto: 'acceptEdits', autoReason: 'cli', bypass: false, bypassReason: 'project', preEnableBypass: false });
  for (const [file, value] of [
    [path.join(dirs.config, 'settings.json'), { disableAutoMode: 'disable' }],
    [path.join(dirs.project, '.claude', 'settings.json'), { permissions: { disableAutoMode: 'disable' } }],
    [path.join(dirs.project, '.claude', 'settings.local.json'), { disableAutoMode: 'disable' }],
    [path.join(dirs.managed, 'managed-settings.json'), { permissions: { disableAutoMode: 'disable' } }],
    [path.join(dirs.managed, 'managed-settings.d', '10-policy.json'), { disableAutoMode: 'disable' }],
  ]) {
    put(file, value);
    const out = await resolve({ policy: policy('auto') });
    assert.deepEqual([out.launch, out.auto, out.autoReason], ['acceptEdits', 'acceptEdits', 'settings'], file);
    fs.rmSync(file);
  }
  for (const [enabled, auto] of [['disabled', 'acceptEdits'], ['enabled', 'auto'], ['opt-in', 'auto']]) {
    put(path.join(dirs.config, '.claude.json'), { cachedGrowthBookFeatures: { tengu_auto_mode_config: { enabled } } });
    const out = await resolve({ policy: policy('auto') });
    assert.equal(out.auto, auto, enabled);
    assert.equal(out.autoReason, auto === 'auto' ? null : 'account');
  }
  fs.writeFileSync(path.join(dirs.config, '.claude.json'), '{broken');
  assert.equal((await resolve({ policy: policy('auto') })).auto, 'auto', 'an unreadable cache is unknown, not a refusal');
  // Plan and Bypass launches keep their own flag; their Auto target is still resolved for switching.
  assert.equal((await resolve({ policy: policy('plan'), capabilities: { autoMode: false } })).launch, 'plan');
  assert.deepEqual(await resolve({ policy: policy('bypass') }),
    { launch: 'bypassPermissions', auto: 'auto', autoReason: null, bypass: true, bypassReason: null, preEnableBypass: false });
  assert.equal((await resolve({ policy: buildPermissionPolicy({ mode: null, source: 'legacy' }, 'claude') })).launch, 'plan');
});

test('bypass is pre-enabled only for a Plan/Auto task whose project default is Bypass, and only when the CLI and settings allow it', async (t) => {
  const { dirs, put, resolve } = profile(t);
  for (const mode of ['plan', 'auto']) {
    const out = await resolve({ policy: policy(mode), backend: projectDefault('bypass') });
    assert.deepEqual([out.bypass, out.preEnableBypass, out.bypassReason], [true, true, null], mode);
  }
  const reasons = [
    [{ policy: policy('auto'), backend: projectDefault('auto') }, 'project'],
    [{ policy: policy('plan'), backend: projectDefault('plan') }, 'project'],
    [{ policy: policy('auto', 'project'), backend: projectDefault('bypass') }, 'project'],
    [{ policy: policy('auto'), backend: { getEffectiveProjectSettings: async () => { throw new Error('offline'); } } }, 'project'],
    [{ policy: policy('auto'), backend: projectDefault('nonsense') }, 'project'],
    [{ policy: policy('plan', 'planning'), backend: projectDefault('bypass') }, 'planning'],
    [{ policy: buildPermissionPolicy({ mode: null, source: 'legacy' }, 'claude'), backend: projectDefault('bypass') }, 'mode'],
    [{ policy: policy('auto'), backend: projectDefault('bypass'), capabilities: { autoMode: true, allowBypassFlag: false } }, 'cli'],
    [{ policy: policy('auto'), backend: projectDefault('bypass'), isRoot: () => true }, 'root'],
  ];
  for (const [opts, reason] of reasons) {
    const out = await resolve(opts);
    assert.deepEqual([out.bypass, out.preEnableBypass, out.bypassReason], [false, false, reason], reason);
  }
  // A strict, fresh read: the backend is asked with strict + refresh.
  let asked = null;
  await resolve({ policy: policy('auto'), backend: { getEffectiveProjectSettings: async (o) => { asked = o; return { settings: { agent_permission_mode: 'bypass' } }; } } });
  assert.deepEqual(asked, { strict: true, refresh: true });
  put(path.join(dirs.project, '.claude', 'settings.json'), { permissions: { disableBypassPermissionsMode: 'disable' } });
  assert.equal((await resolve({ policy: policy('auto'), backend: projectDefault('bypass') })).bypassReason, 'settings');
});

// ── Cycle model (claude chat:cycleMode) ──

test('the Shift+Tab cycle model matches the CLI: plan → bypass/auto/manual, bypass → auto/manual, auto → manual', () => {
  const both = { auto: true, bypass: true };
  assert.deepEqual(live.cyclePath('plan', 'auto', { auto: true, bypass: false }), ['auto']);
  assert.deepEqual(live.cyclePath('plan', 'auto', both), ['bypassPermissions', 'auto']);
  assert.deepEqual(live.cyclePath('plan', 'bypassPermissions', both), ['bypassPermissions']);
  assert.deepEqual(live.cyclePath('auto', 'bypassPermissions', both), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  assert.deepEqual(live.cyclePath('acceptEdits', 'bypassPermissions', both), ['plan', 'bypassPermissions']);
  assert.deepEqual(live.cyclePath('bypassPermissions', 'auto', both), ['auto']);
  assert.deepEqual(live.cyclePath('bypassPermissions', 'acceptEdits', { auto: false, bypass: true }), ['default', 'acceptEdits']);
  assert.deepEqual(live.cyclePath('plan', 'acceptEdits', { auto: false, bypass: false }), ['default', 'acceptEdits']);
  assert.equal(live.cyclePath('plan', 'bypassPermissions', { auto: true, bypass: false }), null, 'bypass is unreachable unless enabled at launch');
  assert.equal(live.cyclePath('auto', 'auto', both).length, 0);
  assert.ok(live.permissiveness('bypassPermissions') > live.permissiveness('auto'));
  assert.ok(live.permissiveness('auto') > live.permissiveness('acceptEdits'));
  assert.ok(live.permissiveness('acceptEdits') > live.permissiveness('default'));
  assert.equal(live.permissiveness('plan', { bypass: true }), live.permissiveness('bypassPermissions'), 'plan with bypass available allows like bypass');
});

test('learnCycle: steps from plan and bypass reveal what the CLI offers; fixed steps must match', () => {
  const avail = { auto: true, bypass: false };
  assert.equal(live.learnCycle('plan', 'bypassPermissions', avail), true);
  assert.deepEqual(avail, { auto: true, bypass: true });
  assert.equal(live.learnCycle('bypassPermissions', 'default', avail), true);
  assert.deepEqual(avail, { auto: false, bypass: true });
  assert.equal(live.learnCycle('plan', 'auto', avail), true);
  assert.deepEqual(avail, { auto: true, bypass: false });
  assert.equal(live.learnCycle('plan', 'default', avail), true);
  assert.deepEqual(avail, { auto: false, bypass: false });
  assert.equal(live.learnCycle('default', 'acceptEdits', avail), true);
  assert.equal(live.learnCycle('acceptEdits', 'plan', avail), true);
  assert.equal(live.learnCycle('auto', 'default', avail), true);
  for (const [from, to] of [['default', 'plan'], ['acceptEdits', 'bypassPermissions'], ['auto', 'bypassPermissions'], ['plan', 'acceptEdits'], ['bypassPermissions', 'plan']]) {
    assert.equal(live.learnCycle(from, to, { auto: true, bypass: true }), false, `${from} → ${to}`);
  }
});

// ── The production PTY pipeline ──

// What terminal-session.js onData() does with one chunk before feedAttentionChunk().
function feed(session, agent, raw, now = Date.now()) {
  session.lastOutputAt = now;
  const oscFree = stripOscChunk(session, raw);
  const clean = stripAnsi(oscFree);
  const rowChunk = reflowChunk(session, oscFree);
  if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(raw)) session._attentionTail = '';
  session._attentionTail = ((session._attentionTail || '') + clean).slice(-1024);
  feedAttentionChunk(session, agent, oscFree, clean, now, rowChunk, null);
}

function claudeSession({ mode = 'plan', native = {}, phase } = {}) {
  const frames = [];
  const session = createSession({ OPEN: 1, readyState: 1, send: (m) => frames.push(JSON.parse(m)) }, false, 'TPT9136', scratch);
  const nativeAuto = native.auto || 'auto';
  Object.assign(session, {
    taskAgent: 'claude', taskId: 'TPT9136', tabId: 'TPT9136', projectPath: scratch, alive: true, _injectDone: true,
    permissionPolicy: buildPermissionPolicy({ mode, source: 'task', nativeAuto }, 'claude'),
    permissionMode: { requested: mode, confirmed: mode, pending: false, error: null },
    terminalPhase: phase || (mode === 'plan' ? 'planning' : 'executing'),
    _permissionEpoch: 1,
  });
  const launch = mode === 'bypass' ? 'bypassPermissions' : mode === 'auto' ? nativeAuto : 'plan';
  session._claudeNative = { launch, auto: nativeAuto, autoReason: null, bypass: mode === 'bypass', bypassReason: null,
    preEnableBypass: false, expected: launch, ...native };
  return { session, frames };
}

// ── Screen tracker against real claude output ──

const view = (tui) => ({ footer: tui.footer, inputBox: tui.inputBox, dialog: tui.dialog, composer: tui.composer });

test('recorded footers read from the screen follow the modelled cycle for every launch (plan, plan+bypass, auto+bypass, bypass, refused auto)', () => {
  const agent = getTaskAgent('claude');
  const cases = {
    'cycle-plan': ['plan', 'auto', 'default', 'acceptEdits', 'plan'],
    'cycle-plan-bypass': ['plan', 'bypassPermissions', 'auto', 'default', 'acceptEdits', 'plan'],
    'cycle-auto-bypass': ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
    'cycle-bypass': ['bypassPermissions', 'auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'],
    // disableAutoMode via --settings: the CLI starts in auto and moves itself to manual mode.
    'auto-refused': ['default', 'acceptEdits', 'plan'],
  };
  for (const [name, expected] of Object.entries(cases)) {
    const { session } = claudeSession({ mode: 'plan' });
    session._claudeNative = null;
    const avail = { auto: name !== 'auto-refused', bypass: /bypass/.test(name) };
    const seen = recording(name).steps.map((step) => {
      for (const c of step.chunks) feed(session, agent, c);
      assert.equal(session._claudeTui.inputBox, true, `${name}: input box on screen after ${step.label}`);
      assert.equal(live.dialogOpen(session), false);
      return live.footerMode(session);
    });
    assert.deepEqual(seen, expected, name);
    for (let i = 1; i < seen.length; i++) assert.equal(live.nextNativeMode(seen[i - 1], avail), seen[i], `${name} step ${i}`);
  }
});

test('Ink repaints only changed cells: a recorded 2.1.312 auto → manual footer ("manu" + skipped cell + "l mode on") is read from the screen', () => {
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'plan' });
  session._claudeNative = null;
  const changes = [];
  const observe = agent.observeModeChange;
  agent.observeModeChange = (s, change) => changes.push(`${change.from}→${change.to}`);
  try {
    for (const c of recording('probe-2.1.312').steps[0].chunks) feed(session, agent, c);
  } finally { agent.observeModeChange = observe; }
  assert.deepEqual(changes, ['null→plan', 'plan→bypassPermissions', 'bypassPermissions→auto', 'auto→default']);
  assert.ok(recording('probe-2.1.312').steps[0].chunks.some((c) => stripAnsi(c).includes('⏸ manul mode on')), 'the raw chunk itself never spells "manual"');
});

test('a recorded permission dialog replaces the input box; it is back once the dialog is answered', () => {
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'auto', native: { auto: 'acceptEdits' } });
  session._claudeNative = null;
  const seen = {};
  for (const step of recording('permission-dialog').steps) {
    for (const c of step.chunks) feed(session, agent, c);
    seen[step.label] = { ...view(session._claudeTui), open: live.dialogOpen(session) };
  }
  assert.deepEqual(seen.enter, { footer: null, inputBox: false, dialog: true, composer: null, open: true });
  assert.deepEqual(seen['esc (reject)'], { footer: 'default', inputBox: true, dialog: false, composer: '', open: false });
  assert.equal(seen['shift+tab'].footer, 'acceptEdits');
  assert.match(seen.typed.composer, /^Use the Bash tool/);
});

test('a recorded directive submission: the paste swaps the footer for its hint, the composer takes it queued mid-turn or empty when idle', () => {
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'bypass' });
  session._claudeNative = null;
  const seen = {};
  for (const step of recording('switch-midturn').steps) {
    for (const c of step.chunks) feed(session, agent, c);
    seen[step.label] = view(session._claudeTui);
  }
  assert.equal(seen['shift+tab mid-tool'].footer, 'auto', 'the mid-tool Shift+Tab reached auto');
  assert.deepEqual(seen['paste directive mid-turn'], { footer: null, inputBox: true, dialog: false, composer: '[Pasted text #1 +11 lines]' });
  assert.deepEqual(seen['typed directive line'], { footer: null, inputBox: true, dialog: false,
    composer: '[Pasted text #1 +11 lines] Apply the permission change pasted above.' });
  assert.equal(seen['enter directive (queued)'].composer, 'Press up to edit queued messages');
  assert.equal(seen['enter directive (queued)'].footer, 'auto');
  assert.equal(seen['enter directive (idle)'].composer, '');
  assert.equal(seen['enter directive (idle)'].footer, null, 'the paste hint outlives the submission');
  assert.equal(seen.reply.footer, 'auto', 'and gives the row back to the mode later');
});

// ── Live switching against a fake claude ──

// The fake repaints its whole screen on every change: transcript, the input box (rule, composer,
// rule) and the mode footer — or a dialog in the box's place. Behaviour follows the real CLI's
// cycle, and like it a paste lends the footer row to "paste again to expand" for a while
// (`pasteHintMs`; 8 s in the CLI) whatever the composer does, until a Shift+Tab takes it back.
// `hooks` bend it per test.
const FOOTER = { plan: '⏸ plan mode on', default: '⏸ manual mode on', auto: '⏵⏵ auto mode on',
  acceptEdits: '⏵⏵ accept edits on', bypassPermissions: '⏵⏵ bypass permissions on' };
const RULE = '─'.repeat(100);
function screenChunk(state) {
  const rows = ['⏺ Working on the task.', '', ...state.queued.map((q) => `❯ ${q}`), ''];
  if (state.dialog) rows.push(RULE, ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend');
  else rows.push(RULE, state.composer ? `❯ ${state.composer}` : '❯', RULE, '', state.pasted ? '  paste again to expand' : `  ${FOOTER[state.mode]} (shift+tab to cycle)`);
  return `\x1b[2J\x1b[H${rows.join('\r\n')}`;
}

function fakeClaude(session, agent, { mode, avail = { auto: true, bypass: false }, running = false, pasteHintMs = 60, hooks = {} } = {}) {
  const state = { mode, avail: { ...avail }, composer: '', pasted: false, dialog: false, running, queued: [], submitted: [], writes: [],
    keysInDialog: [], pressesUnderHint: [], hintTimer: null };
  const paint = () => feed(session, agent, screenChunk(state));
  const later = (fn) => setImmediate(() => { if (fn() !== false) paint(); });
  const hint = (on) => {
    clearTimeout(state.hintTimer);
    state.pasted = on;
    if (on && Number.isFinite(pasteHintMs)) state.hintTimer = setTimeout(() => { state.pasted = false; paint(); }, pasteHintMs).unref();
  };
  state.paint = paint;
  session.pty = {
    pid: 0,
    write(data) {
      state.writes.push(data);
      if (state.dialog) { state.keysInDialog.push(data); return; }
      if (data === SHIFT_TAB) {
        if (state.pasted) state.pressesUnderHint.push(state.mode);
        return later(() => { hint(false); return hooks.press ? hooks.press(state) : (state.mode = live.nextNativeMode(state.mode, state.avail), true); });
      }
      if (data.startsWith('\x1b[200~')) return later(() => { hint(true); state.composer = '[Pasted text #1 +11 lines]'; hooks.paste?.(state); });
      if (data === '\r') {
        return later(() => {
          if (hooks.enter?.(state) === false) return false;
          if (state.composer && !/^Press up/.test(state.composer)) state.submitted.push(state.composer);
          if (state.running && state.submitted.length) state.queued.push('queued directive');
          state.composer = state.running ? 'Press up to edit queued messages' : '';
        });
      }
      return later(() => { state.composer = `${state.composer}${data}`.trim(); });
    },
    kill() { state.writes.push('<kill>'); },
  };
  paint();
  return state;
}

function fastTiming(t) {
  const saved = { ...live.TIMING };
  Object.assign(live.TIMING, { step: 600, submitRetry: 200, submitAccept: 600, settleMax: 150, footerWait: 400, poll: 5 });
  t.after(() => Object.assign(live.TIMING, saved));
  t.mock.method(getTaskAgent('claude'), 'getPasteSilenceMs', () => 10);
}

const presses = (state) => state.writes.filter((w) => w === SHIFT_TAB).length;
const sessionsOf = (session) => new Map([['key', session]]);

for (const [from, to, avail, native, count] of [
  ['plan', 'auto', { auto: true, bypass: false }, {}, 1],
  ['plan', 'bypass', { auto: true, bypass: true }, { bypass: true, preEnableBypass: true }, 1],
  ['auto', 'bypass', { auto: true, bypass: true }, { bypass: true, preEnableBypass: true }, 4],
  ['bypass', 'auto', { auto: true, bypass: true }, {}, 1],
]) {
  test(`${from} → ${to}: footer-confirmed Shift+Tab steps, then the directive taken by the composer`, async (t) => {
    fastTiming(t);
    const agent = getTaskAgent('claude');
    const { session, frames } = claudeSession({ mode: from, native });
    const native0 = { plan: 'plan', auto: 'auto', bypass: 'bypassPermissions' }[from];
    const fake = fakeClaude(session, agent, { mode: native0, avail });
    const result = await requestPermissionMode('key', to, sessionsOf(session));
    assert.deepEqual(result, { requested: to, confirmed: to, pending: false, error: null });
    assert.equal(presses(fake), count);
    const directive = fake.writes.find((w) => w.startsWith('\x1b[200~'));
    assert.match(directive, new RegExp(`The user selected ${to} for this session`));
    assert.match(directive, to === 'auto' ? /native auto mode is on/ : /Bypass mode:/);
    assert.deepEqual(fake.writes.slice(-3), [directive, live.DIRECTIVE_TYPED_LINE, '\r']);
    assert.equal(fake.submitted.length, 1);
    assert.equal(session._claudeTui.mode, to === 'auto' ? 'auto' : 'bypassPermissions');
    assert.equal(session._claudeNative.expected, session._claudeTui.mode);
    assert.deepEqual(fake.pressesUnderHint, []);
    assert.equal(session.permissionPolicy.mode, to);
    assert.equal(session.permissionPolicy.nativeAuto, 'auto', 'the run keeps its native Auto meaning');
    assert.equal(session.terminalPhase, 'executing');
    assert.deepEqual(frames.filter((f) => f.type === 'session:permission-mode-changed').map((f) => [f.pending, f.confirmed]),
      [[true, from], [false, to]]);
    assert.deepEqual(frames.findLast((f) => f.type === 'session:permission-mode-changed').native, live.nativeSummary(session));
  });
}

test('mid-turn the directive is queued for the next tool boundary: the composer shows the queue placeholder', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'plan' });
  const fake = fakeClaude(session, agent, { mode: 'plan', running: true });
  const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
  assert.equal(result.confirmed, 'auto');
  assert.deepEqual(fake.queued, ['queued directive']);
  assert.equal(session._claudeTui.composer, 'Press up to edit queued messages');
});

test('bypass → auto when the CLI skips auto at runtime lands on accept edits and turns Auto into the fallback for the run', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'bypass' });
  const fake = fakeClaude(session, agent, { mode: 'bypassPermissions', avail: { auto: false, bypass: true } });
  const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
  assert.equal(result.confirmed, 'auto');
  assert.equal(presses(fake), 2);
  assert.equal(session._claudeTui.mode, 'acceptEdits');
  assert.deepEqual(live.nativeSummary(session), { auto: 'acceptEdits', bypass: true });
  assert.equal(session._claudeNative.autoReason, 'runtime');
  assert.match(session.permissionPolicy.prompt, /native allow \/ allow-all \/ deny permission dialog/);
  assert.match(fake.writes.find((w) => w.startsWith('\x1b[200~')), /native allow \/ allow-all \/ deny permission dialog/);
});

test('a run whose Auto is the acceptEdits fallback stays there even when the CLI still cycles through auto', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'bypass', native: { auto: 'acceptEdits' } });
  const fake = fakeClaude(session, agent, { mode: 'bypassPermissions', avail: { auto: true, bypass: true } });
  const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
  assert.equal(result.confirmed, 'auto');
  assert.equal(session._claudeTui.mode, 'acceptEdits');
  assert.equal(presses(fake), 3, 'bypass → auto → manual → accept edits');
  assert.equal(session._claudeNative.auto, 'acceptEdits');
});

test('refusals send nothing: kickoff not sent, a dialog up, unsent text in the prompt, bypass never enabled, another drive running, a footer row that stays hidden', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const cases = [
    ['starting', (s) => { s._injectDone = false; }],
    ['prompt_open', (s, fake) => { fake.dialog = true; fake.paint(); }],
    ['prompt_busy', (s, fake) => { fake.composer = 'half-typed user message'; fake.paint(); }],
    ['bypass_unavailable', (s) => { s._claudeNative.bypass = false; }],
    ['busy', (s) => { s._claudeDriving = true; }],
    ['unconfirmed', (s, fake) => { fake.pasted = true; fake.paint(); }],
  ];
  for (const [reason, arrange] of cases) {
    const { session } = claudeSession({ mode: 'auto', native: { bypass: true } });
    const fake = fakeClaude(session, agent, { mode: 'auto', avail: { auto: true, bypass: true } });
    arrange(session, fake);
    const result = await requestPermissionMode('key', 'bypass', sessionsOf(session));
    assert.equal(result.error?.reason, reason, reason);
    assert.equal(result.confirmed, 'auto', reason);
    assert.deepEqual(fake.writes, [], `${reason}: no key reaches the TUI`);
    assert.deepEqual(fake.keysInDialog, []);
    assert.equal(session.permissionPolicy.mode, 'auto');
  }
});

test('an unconfirmed step or an untaken directive restores the previous native mode before failing', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  {
    const { session } = claudeSession({ mode: 'plan' });
    const fake = fakeClaude(session, agent, { mode: 'plan', hooks: { press: () => false } }); // footer never repaints
    const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
    assert.equal(result.error.reason, 'unconfirmed');
    assert.deepEqual(fake.writes, [SHIFT_TAB]);
    assert.equal(session.permissionPolicy.mode, 'plan');
  }
  {
    // Enter is never taken: the directive stays in the composer. Once the paste hint gives the
    // footer row back, the mode is restored before the error is reported.
    const { session, frames } = claudeSession({ mode: 'plan' });
    const fake = fakeClaude(session, agent, { mode: 'plan', hooks: { enter: () => false } });
    const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
    assert.equal(result.error.reason, 'unconfirmed');
    assert.equal(result.confirmed, 'plan');
    assert.equal(fake.mode, 'plan', 'restored: auto → manual → accept edits → plan');
    assert.deepEqual(fake.pressesUnderHint, []);
    assert.equal(frames.some((f) => f.type === 'data' && /previous permission mode is restored/.test(f.data)), false);
  }
  {
    // A footer row still hidden after the wait defers the restore, with a notice, until it is
    // readable again (here: the hint clears).
    const { session, frames } = claudeSession({ mode: 'plan' });
    const fake = fakeClaude(session, agent, { mode: 'plan', pasteHintMs: Infinity, hooks: { enter: () => false } });
    const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
    assert.equal(result.error.reason, 'unconfirmed');
    assert.equal(result.confirmed, 'plan');
    assert.equal(fake.mode, 'auto');
    assert.ok(frames.some((f) => f.type === 'data' && /previous permission mode is restored/.test(f.data)));
    Object.assign(fake, { pasted: false });
    fake.paint();
    const deadline = Date.now() + 3000;
    while (fake.mode !== 'plan' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.mode, 'plan', 'restored: auto → manual → accept edits → plan');
    assert.equal(live.footerMode(session), 'plan');
    assert.equal(fake.writes.includes('<kill>'), false);
  }
});

test('a dialog that opens while the directive is written stops it before Enter; the mode is restored once the prompt is back', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session, frames } = claudeSession({ mode: 'plan' });
  const fake = fakeClaude(session, agent, { mode: 'plan', hooks: { paste: (s) => { s.dialog = true; } } });
  const result = await requestPermissionMode('key', 'auto', sessionsOf(session));
  assert.equal(result.error.reason, 'prompt_open');
  assert.equal(result.confirmed, 'plan');
  assert.equal(presses(fake), 1);
  assert.equal(fake.writes.length, 2, 'the press and the paste; no typed words, no Enter into the dialog');
  assert.deepEqual(fake.keysInDialog, []);
  assert.ok(frames.some((f) => f.type === 'data' && /previous permission mode is restored/.test(f.data)));
  // The user answers the dialog: the prompt (still in auto) comes back and plan is restored.
  Object.assign(fake, { dialog: false, pasted: false, composer: '' });
  fake.paint();
  const deadline = Date.now() + 3000;
  while (fake.mode !== 'plan' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.mode, 'plan');
  assert.equal(presses(fake), 4, 'auto → manual → accept edits → plan');
  assert.equal(session._claudeNative.expected, 'plan');
  assert.equal(session.permissionPolicy.mode, 'plan');
});

test('a switch right after another waits until the paste hint gives the footer row back, then presses from the mode it shows', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'auto', native: { bypass: true, preEnableBypass: true } });
  const fake = fakeClaude(session, agent, { mode: 'auto', avail: { auto: true, bypass: true }, pasteHintMs: Infinity });
  const first = await requestPermissionMode('key', 'bypass', sessionsOf(session));
  assert.equal(first.confirmed, 'bypass');
  assert.equal(live.footerMode(session), null, 'the directive\'s paste hint holds the footer row');
  assert.equal(session._claudeTui.mode, 'bypassPermissions');
  setTimeout(() => { fake.pasted = false; fake.paint(); }, 100); // the hint's timer runs out
  const second = await requestPermissionMode('key', 'auto', sessionsOf(session));
  assert.deepEqual(second, { requested: 'auto', confirmed: 'auto', pending: false, error: null });
  assert.equal(presses(fake), 5, 'auto → manual → accept edits → plan → bypass, then bypass → auto');
  assert.deepEqual(fake.pressesUnderHint, [], 'no Shift+Tab while the footer row was hidden');
  assert.equal(fake.submitted.length, 2);
  assert.equal(session._claudeTui.mode, 'auto');
});

test('a restore that cannot be confirmed from a wider mode stops the run', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'auto', native: { bypass: true, preEnableBypass: true } });
  // Auto → Bypass: the TUI stops answering presses in plan mode, which allows everything while
  // bypass is available — wider than the Auto the run had.
  const fake = fakeClaude(session, agent, { mode: 'auto', avail: { auto: true, bypass: true }, hooks: {
    press: (s) => { if (s.mode === 'plan') return false; s.mode = live.nextNativeMode(s.mode, s.avail); return true; },
  } });
  const result = await requestPermissionMode('key', 'bypass', sessionsOf(session));
  assert.equal(result.error.reason, 'unconfirmed');
  assert.equal(result.confirmed, 'auto');
  assert.equal(fake.mode, 'plan');
  assert.equal(fake.writes.at(-1), '<kill>');
});

test('the CLI refusing auto after an Auto launch falls back to accept edits once the prompt is free; the user\'s own Shift+Tab never does', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  {
    const { session, frames } = claudeSession({ mode: 'auto' });
    const fake = fakeClaude(session, agent, { mode: 'auto' });
    fake.mode = 'default'; // the CLI's gate refuses auto
    fake.paint();
    assert.equal(session._claudeNative.auto, 'acceptEdits');
    assert.equal(session._claudeNative.autoReason, 'runtime');
    assert.match(session.permissionPolicy.prompt, /native allow \/ allow-all \/ deny/);
    assert.ok(frames.some((f) => f.type === 'session:permission-mode-changed' && f.native?.auto === 'acceptEdits'));
    const deadline = Date.now() + 2000;
    while (fake.mode !== 'acceptEdits' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.writes, [SHIFT_TAB]);
    assert.equal(live.footerMode(session), 'acceptEdits');
    assert.equal(session._claudeNative.expected, 'acceptEdits');
  }
  {
    const { session } = claudeSession({ mode: 'auto' });
    const fake = fakeClaude(session, agent, { mode: 'auto' });
    session._userModeKeyAt = Date.now();
    fake.mode = 'default';
    fake.paint();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(session._claudeNative.auto, 'auto', 'the user moved it themselves');
    assert.equal(session._claudeNative.expected, null);
    assert.deepEqual(fake.writes, []);
  }
});

test('Proceed in a run with bypass pre-enabled drives plan → bypass → auto before the approval text, never stopping in bypass', async (t) => {
  fastTiming(t);
  const agent = getTaskAgent('claude');
  const { session } = claudeSession({ mode: 'plan', native: { bypass: true, preEnableBypass: true } });
  const fake = fakeClaude(session, agent, { mode: 'plan', avail: { auto: true, bypass: true } });
  agent.approvePlan(session);
  const deadline = Date.now() + 2000;
  while (!fake.writes.includes('\r') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fake.writes.slice(0, 2), [SHIFT_TAB, SHIFT_TAB]);
  assert.equal(fake.mode, 'auto');
  assert.deepEqual(fake.writes.slice(2), [agent.getApprovalText(session), '\r']);
  // Without pre-enabled bypass, Proceed keeps its one Shift+Tab.
  const plain = claudeSession({ mode: 'plan' });
  const plainWrites = [];
  plain.session.pty = { write: (d) => plainWrites.push(d) };
  agent.approvePlan(plain.session);
  assert.deepEqual(plainWrites, [SHIFT_TAB]);
});

test('the adapter offers switching only for runs it launched and reports their native modes', () => {
  const agent = getTaskAgent('claude');
  assert.equal(agent.supportsLivePermissionSwitch({}), false);
  const { session } = claudeSession({ mode: 'auto', native: { auto: 'acceptEdits' } });
  assert.equal(agent.supportsLivePermissionSwitch(session), true);
  assert.deepEqual(agent.nativePermissionSummary(session), { auto: 'acceptEdits', bypass: false });
  session._imageOperation = {};
  assert.equal(agent.supportsLivePermissionSwitch(session), false);
  assert.ok(agent instanceof ClaudeAgent);
});
