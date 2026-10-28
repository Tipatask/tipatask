'use strict';

// ── Claude native permission modes: launch resolution and live switching (TPT9136) ──
// Verified against claude 2.1.311 (2.1.154 already lists `auto`):
// - `--permission-mode` accepts acceptEdits | auto | bypassPermissions | manual (the `default`
//   mode, "manual mode" in the footer) | dontAsk | plan. `claude --help` lists the choices.
// - Native auto runs only while the CLI's own gate allows it: `disableAutoMode: "disable"` in any
//   settings source, the account's auto-mode circuit breaker and an unsupported model all close
//   it. A launch with `--permission-mode auto` that the gate refuses still starts, and the CLI
//   moves itself to `default` within its first frames — so Auto launches `acceptEdits` whenever
//   the refusal is knowable up front, and a refusal seen later falls back at runtime.
// - Shift+Tab (`chat:cycleMode`) cycles default → acceptEdits → plan → bypassPermissions (only
//   when bypass is available) → auto (only when auto is available) → default; see
//   nextNativeMode(). The prompt footer repaints with the new mode within a frame, and that
//   footer — not the keypress — confirms every step.
// - Bypass is available only when the run started in it or with
//   --allow-dangerously-skip-permissions; availability is fixed at startup. With bypass
//   available, Claude's plan mode stops asking before edits or commands, so only a Plan/Auto
//   task in a project whose default mode is Bypass pre-enables it (resolveNativePermissions()).
// - Inside an open dialog the same key answers it (a permission dialog's allow-for-the-session
//   option, the plan dialog's approve-with-feedback), so no key is sent while one is up and a
//   switch requested then is refused with `prompt_open`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modeSwitchError, validateLiveMode, buildPermissionPolicy, resolveProjectPermissionMode } = require('../permission-policy');
const { CLAUDE_QUEUED_HINT_RE } = require('../plan-approval-detect');

const SHIFT_TAB = '\x1b[Z';
const MAX_PRESSES = 6; // the longest path (auto → bypass) is four presses
// Waits, in ms (tests shorten them).
const TIMING = {
  step: 3000,          // one press repaints the footer within a frame
  submitRetry: 2500,   // a stranded directive paste gets one more Enter after this
  submitAccept: 8000,  // composer cleared or queued after the directive's Enter
  settleMax: 2000,     // cap on waiting for the TUI to go quiet after a write
  fallbackWait: 120000, // runtime fallback waits this long for the prompt to return
  userKeyGrace: 2000,  // a footer change this soon after the user's Shift+Tab is theirs
  footerWait: 10000,   // a passing hint holds the footer row (a paste's: 8 s)
  poll: 50,
};
// Claude refuses a paste-only message ("no words from you"), so typed words follow the paste.
const DIRECTIVE_TYPED_LINE = ' Apply the permission change pasted above.';

// ── Launch resolution ──

// Choices listed for `--permission-mode` in `claude --help` (the list wraps across lines).
function parsePermissionChoices(help) {
  const text = String(help || '');
  const at = text.search(/--permission-mode\b/);
  if (at < 0) return [];
  const rest = text.slice(at);
  const next = rest.slice(1).search(/\n\s+-{1,2}[a-z]/i);
  const block = (next < 0 ? rest : rest.slice(0, next + 1)).replace(/\s+/g, ' ');
  const m = /choices:\s*([^)]*)\)/.exec(block);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

function cliPermissionCapabilities(help) {
  const choices = parsePermissionChoices(help);
  return {
    choices,
    autoMode: choices.includes('auto'),
    allowBypassFlag: /--allow-dangerously-skip-permissions\b/.test(String(help || '')),
  };
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function managedSettingsDir(platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

// The settings files the CLI merges for this project, as far as they live on disk: user,
// project, project-local and managed (file + drop-in directory). Server-managed and MDM policy
// are not readable here; a mode they close is caught at runtime.
function claudeSettingsFiles(projectRoot, { env = process.env, platform = process.platform, managedDir } = {}) {
  const userDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const managed = managedDir || managedSettingsDir(platform);
  let dropIns = [];
  try {
    dropIns = fs.readdirSync(path.join(managed, 'managed-settings.d'))
      .filter((f) => f.endsWith('.json')).sort().map((f) => path.join(managed, 'managed-settings.d', f));
  } catch { /* no drop-ins */ }
  return [
    path.join(userDir, 'settings.json'),
    ...(projectRoot ? [path.join(projectRoot, '.claude', 'settings.json'), path.join(projectRoot, '.claude', 'settings.local.json')] : []),
    path.join(managed, 'managed-settings.json'),
    ...dropIns,
  ];
}

// Restrictive keys win from any source, so one "disable" closes the mode for the CLI as well.
function settingsDisable(settingsList, key) {
  return settingsList.some((s) => s?.[key] === 'disable' || s?.permissions?.[key] === 'disable');
}

// The account's auto-mode circuit breaker as the CLI last cached it: .claude.json's
// cachedGrowthBookFeatures.tengu_auto_mode_config.enabled ('enabled' | 'opt-in' | 'disabled').
// An undocumented cache, read best effort: anything unreadable is unknown, and the runtime
// fallback still catches a refusal.
function cachedAutoModeGate(env = process.env) {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const value = readJsonObject(file)?.cachedGrowthBookFeatures?.tengu_auto_mode_config?.enabled;
  return typeof value === 'string' ? value : null;
}

const runningAsRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

// Native modes for one launch:
//   launch       --permission-mode value
//   auto         native mode the app's Auto uses in this run: 'auto', or 'acceptEdits' when the
//                CLI lacks auto (autoReason 'cli'), settings disable it ('settings') or the
//                account's cached gate is closed ('account'); 'runtime' is set later
//   bypass       bypassPermissions reachable: launched in it, or pre-enabled with
//                --allow-dangerously-skip-permissions (preEnableBypass) for a Plan/Auto task
//                whose project default is Bypass; bypassReason says why not otherwise
async function resolveNativePermissions({ policy, projectRoot, backend, capabilities, env = process.env,
  platform = process.platform, managedDir, isRoot = runningAsRoot } = {}) {
  const mode = policy?.mode ?? null;
  const settings = claudeSettingsFiles(projectRoot, { env, platform, managedDir }).map(readJsonObject).filter(Boolean);
  let auto = 'auto';
  let autoReason = null;
  if (!capabilities?.autoMode) autoReason = 'cli';
  else if (settingsDisable(settings, 'disableAutoMode')) autoReason = 'settings';
  else if (cachedAutoModeGate(env) === 'disabled') autoReason = 'account';
  if (autoReason) auto = 'acceptEdits';
  let bypass = mode === 'bypass';
  let bypassReason = null;
  let preEnableBypass = false;
  if (!bypass) {
    if (mode !== 'plan' && mode !== 'auto') bypassReason = 'mode';
    else if (policy?.source === 'planning') bypassReason = 'planning';
    else if ((await resolveProjectPermissionMode({ backend, resolved: policy })) !== 'bypass') bypassReason = 'project';
    else if (!capabilities?.allowBypassFlag) bypassReason = 'cli';
    else if (settingsDisable(settings, 'disableBypassPermissionsMode')) bypassReason = 'settings';
    else if (isRoot()) bypassReason = 'root'; // the CLI refuses the flag under root and exits
    else bypass = preEnableBypass = true;
  }
  const launch = mode === 'bypass' ? 'bypassPermissions' : mode === 'auto' ? auto : 'plan';
  return { launch, auto, autoReason, bypass, bypassReason, preEnableBypass };
}

// ── Cycle model ──

function nextNativeMode(mode, { auto, bypass }) {
  switch (mode) {
    case 'default': return 'acceptEdits';
    case 'acceptEdits': return 'plan';
    case 'plan': return bypass ? 'bypassPermissions' : auto ? 'auto' : 'default';
    case 'bypassPermissions': return auto ? 'auto' : 'default';
    default: return 'default'; // auto, dontAsk
  }
}

// The modes each press passes through from `from` to `to`, or null when the cycle cannot reach it.
function cyclePath(from, to, avail, max = MAX_PRESSES) {
  const steps = [];
  let mode = from;
  while (mode !== to) {
    if (steps.length >= max) return null;
    mode = nextNativeMode(mode, avail);
    steps.push(mode);
  }
  return steps;
}

// How much a native mode lets run without asking. Plan with bypass available allows like bypass.
function permissiveness(mode, { bypass } = {}) {
  switch (mode) {
    case 'bypassPermissions': return 4;
    case 'plan': return bypass ? 4 : 1;
    case 'auto': return 3;
    case 'acceptEdits': return 2;
    default: return 0; // default asks, dontAsk denies
  }
}

// ── Screen state (fed by plan-approval-detect.js trackClaudeScreen()) ──

// The mode the footer shows now; null while no footer is on screen.
const footerMode = (session) => session?._claudeTui?.footer || null;

// The prompt is not available for keys: its input box is not on screen (a dialog has replaced
// it, or the REPL is not up).
function dialogOpen(session) {
  const tui = session?._claudeTui;
  return !tui || !tui.inputBox;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs, live, pollMs = TIMING.poll) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!live()) throw modeSwitchError('session_changed');
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(pollMs);
  }
}

// The footer row is lent to passing hints: for 8 s after any paste (the directive is one) it
// reads "paste again to expand" instead of the mode, and other notices take it for a moment.
// With the input box on screen, wait that out (bounded) before reading the mode.
async function visibleFooter(session, live) {
  if (!footerMode(session) && !dialogOpen(session)) {
    await waitUntil(() => footerMode(session) || dialogOpen(session), TIMING.footerWait, live);
  }
  return footerMode(session);
}

// After a write: at least one quiet window, then until the TUI stops repainting (capped).
async function settle(session, quietMs, live) {
  const start = Date.now();
  await delay(quietMs);
  while (Date.now() - (session.lastOutputAt || 0) < quietMs && Date.now() - start < TIMING.settleMax) {
    if (!live()) throw modeSwitchError('session_changed');
    await delay(TIMING.poll);
  }
  if (!live()) throw modeSwitchError('session_changed');
}

// What one observed press says about the CLI's cycle: from plan and from bypass the next mode
// depends on what is available, so the observation updates `avail`; every other step is fixed.
// False when the footer went somewhere the cycle cannot.
function learnCycle(from, to, avail) {
  if (from === 'plan') {
    if (to === 'bypassPermissions') avail.bypass = true;
    else if (to === 'auto') Object.assign(avail, { bypass: false, auto: true });
    else if (to === 'default') Object.assign(avail, { bypass: false, auto: false });
    else return false;
    return true;
  }
  if (from === 'bypassPermissions') {
    if (to === 'auto') avail.auto = true;
    else if (to === 'default') avail.auto = false;
    else return false;
    return true;
  }
  return to === nextNativeMode(from, avail);
}

// Presses Shift+Tab until the footer shows targetFor(avail), verifying every step. `avail`
// (what the CLI cycles through) follows each observed step: auto skipped means the CLI refused
// it, bypass skipped means it was never enabled. Never presses while a dialog is up.
async function driveTo(session, targetFor, avail, live, { onAutoUnavailable } = {}) {
  for (let presses = 0; ; presses++) {
    const target = targetFor(avail);
    const from = await visibleFooter(session, live);
    if (!from) throw modeSwitchError(dialogOpen(session) ? 'prompt_open' : 'unconfirmed');
    if (from === target) return target;
    if (dialogOpen(session)) throw modeSwitchError('prompt_open');
    if (presses >= MAX_PRESSES) throw modeSwitchError('unconfirmed');
    const pressedAt = Date.now();
    session.pty.write(SHIFT_TAB);
    const to = await waitUntil(() => { const m = footerMode(session); return m !== from ? m : null; }, TIMING.step, live);
    console.log(`[claude-live-mode] task ${session.taskId || session.tabId}: Shift+Tab ${presses + 1} ${from} → ${to || 'no footer change'} (${Date.now() - pressedAt}ms, target ${target})`);
    if (!to) throw modeSwitchError('unconfirmed');
    const hadAuto = avail.auto;
    if (!learnCycle(from, to, avail)) throw modeSwitchError('unconfirmed');
    if (hadAuto && !avail.auto) onAutoUnavailable?.();
  }
}

// Every write into the prompt first checks that no dialog has taken its place: a permission
// dialog that opened mid-turn would take typed text, and Enter would confirm its highlighted
// option.
function writeToPrompt(session, data) {
  if (dialogOpen(session)) throw modeSwitchError('prompt_open');
  session.pty.write(data);
}

// The prompt row holds text waiting to be submitted (not empty, not the queue placeholder).
const composerHolds = (tui) => !!tui?.composer && !CLAUDE_QUEUED_HINT_RE.test(tui.composer);

// Pastes the directive, types the words Claude requires, and once the prompt row holds them
// presses Enter, then waits for the composer to take it: an empty prompt row, or the
// queued-messages placeholder when a turn is running (Claude then delivers the message at the
// next tool boundary). Text still on the prompt after a quiet spell gets one more Enter.
async function submitDirective(agent, session, directive, live) {
  const tui = session._claudeTui;
  const quietMs = agent.getPasteSilenceMs();
  writeToPrompt(session, `\x1b[200~${directive}\x1b[201~`);
  await settle(session, quietMs, live);
  writeToPrompt(session, DIRECTIVE_TYPED_LINE);
  await settle(session, quietMs, live);
  if (!composerHolds(tui)) throw modeSwitchError('unconfirmed');
  const taken = () => tui.composer === '' || CLAUDE_QUEUED_HINT_RE.test(tui.composer || '');
  writeToPrompt(session, '\r');
  if (await waitUntil(taken, TIMING.submitRetry, live)) return;
  if (!dialogOpen(session) && composerHolds(tui) && Date.now() - (session.lastOutputAt || 0) >= 1000) session.pty.write('\r');
  if (!(await waitUntil(taken, TIMING.submitAccept, live))) throw modeSwitchError('unconfirmed');
}

function notice(session, key, params) {
  try { require('../terminal-session').noticeCopy(session, key, params); } catch { /* no terminal */ }
}

function emitState(session) {
  try { require('../terminal-session').emitPermissionModeState(session); } catch { /* no terminal */ }
}

// Auto turned out unavailable for this run: Auto now means acceptEdits, and the run's policy
// text says so for every later prompt (applyLivePolicy() keeps nativeAuto).
function noteAutoUnavailable(session, native, reason) {
  if (!native || native.auto !== 'auto') return;
  native.auto = 'acceptEdits';
  native.autoReason = reason;
  if (session.permissionPolicy) {
    session.permissionPolicy = buildPermissionPolicy({ ...session.permissionPolicy, nativeAuto: 'acceptEdits' }, 'claude');
  }
  console.log(`[claude-live-mode] task ${session.taskId || session.tabId}: native auto mode unavailable (${reason}); Auto uses acceptEdits`);
}

// The CLI's own footer wording for a native mode, for notices.
const FOOTER_LABELS = Object.freeze({ plan: 'plan mode', auto: 'auto mode', acceptEdits: 'accept edits',
  bypassPermissions: 'bypass permissions', default: 'manual mode', dontAsk: "don't ask" });
const footerLabel = (mode) => FOOTER_LABELS[mode] || String(mode);

// After a failed switch, back to the mode the run had. A dialog in the way means Claude is
// waiting for the user, and a footer row still held by a hint past driveTo()'s wait leaves the
// mode unreadable: either way the mode is restored once the prompt is free. When the TUI stops
// answering instead and the footer shows a wider mode than before, the run must not keep
// executing unverified.
async function restoreMode(session, original, avail, live) {
  // A dialog or the directive's paste hint can hide the footer; the last one seen counts.
  const now = footerMode(session) || session._claudeTui?.mode || null;
  if (!original || !now || now === original || !live()) return;
  const back = original === 'auto' && !avail.auto ? 'acceptEdits' : original;
  let blocked = false;
  try {
    await driveTo(session, () => back, avail, live);
    return;
  } catch (err) { blocked = err?.reason === 'prompt_open' || !footerMode(session); }
  const current = footerMode(session) || session._claudeTui?.mode || null;
  if (!blocked && current && permissiveness(current, avail) > permissiveness(original, avail)) {
    console.warn(`[claude-live-mode] task ${session.taskId || session.tabId}: could not restore ${original} from ${current}; stopping the run`);
    notice(session, 'notice.permission.claudeRestoreFailed', { mode: footerLabel(current) });
    const pid = session.pty?.pid;
    try {
      if (!require('../process-group').killProcessGroup(pid, 'SIGTERM')) session.pty.kill();
    } catch { /* already gone */ }
    return;
  }
  if (current && current !== back) {
    notice(session, 'notice.permission.claudeRestoreDeferred', { mode: footerLabel(current) });
    scheduleRestore(session, back, avail);
  }
}

// Restores `back` once nothing holds the prompt. A later switch request (a new permission epoch)
// or a fresh run cancels it.
function scheduleRestore(session, back, avail) {
  const pty = session.pty;
  const epoch = session._permissionEpoch;
  const live = () => session.pty === pty && session._permissionEpoch === epoch && session.alive === true && !session._terminated;
  const run = async () => {
    const ready = await waitUntil(() => !session.permissionMode?.pending && !session._claudeDriving
      && !!footerMode(session) && !dialogOpen(session), TIMING.fallbackWait, live, Math.max(TIMING.poll, 250));
    if (!ready || footerMode(session) === back) return;
    session._claudeDriving = true;
    try {
      await driveTo(session, () => back, { ...avail }, live);
      if (session._claudeNative) session._claudeNative.expected = back;
    } finally { session._claudeDriving = false; }
  };
  run().catch((err) => console.log(`[claude-live-mode] task ${session.taskId || session.tabId}: ${back} not restored (${err.reason || err.message})`));
}

// switchPermissionMode() for Claude: drive the native mode first (the new enforcement, confirmed
// by the footer), then hand Claude the mode directive; either failure restores the old mode.
async function switchMode(agent, session, mode) {
  validateLiveMode(mode);
  const native = session?._claudeNative;
  if (!native || !session.pty) return { supported: false };
  if (session._injectDone !== true) throw modeSwitchError('starting');
  if (session._claudeDriving) throw modeSwitchError('busy');
  if (mode === 'bypass' && !native.bypass) throw modeSwitchError('bypass_unavailable');
  const pty = session.pty;
  const epoch = session._permissionEpoch;
  const live = () => session.pty === pty && session._permissionEpoch === epoch && session.alive === true && !session._terminated;
  // No key goes into a dialog, and the directive is submitted from the composer: text the user
  // has not sent would go with it. Checked again after waiting for the footer.
  const refusal = () => (dialogOpen(session) ? 'prompt_open' : composerHolds(session._claudeTui) ? 'prompt_busy' : null);
  if (refusal()) throw modeSwitchError(refusal());
  // `avail` predicts the CLI's cycle; what Auto means in this run is native.auto. A run whose
  // Auto is the acceptEdits fallback stays there even if the CLI still cycles through auto.
  const avail = { auto: native.auto === 'auto', bypass: native.bypass === true };
  const targetFor = mode === 'bypass'
    ? (a) => { if (!a.bypass) throw modeSwitchError('bypass_unavailable'); return 'bypassPermissions'; }
    : (a) => (native.auto === 'auto' && a.auto ? 'auto' : 'acceptEdits');
  session._claudeDriving = true;
  try {
    const original = await visibleFooter(session, live);
    if (refusal()) throw modeSwitchError(refusal());
    if (!original) throw modeSwitchError('unconfirmed');
    try {
      const reached = await driveTo(session, targetFor, avail, live);
      if (!avail.auto) noteAutoUnavailable(session, native, 'runtime');
      if (!avail.bypass) native.bypass = false;
      await submitDirective(agent, session, agent.buildModeSwitchDirective(mode, { nativeAuto: native.auto }), live);
      native.expected = reached;
      return { supported: true, confirmed: mode };
    } catch (err) {
      await restoreMode(session, original, avail, live).catch(() => {});
      throw err;
    }
  } finally {
    session._claudeDriving = false;
  }
}

// Footer changes nobody here asked for. The CLI moving an Auto run from auto to manual is its
// gate refusing auto: Auto falls back to acceptEdits once the prompt is free. A change right
// after the user's own Shift+Tab, or any other one, only means the app no longer knows the mode.
function observeModeChange(agent, session, change, now = Date.now()) {
  const native = session?._claudeNative;
  if (!native || !change || session.permissionMode?.pending || session._claudeDriving) return;
  if (now - (session._userModeKeyAt || 0) < TIMING.userKeyGrace) { native.expected = null; return; }
  if (native.expected === 'auto' && change.to === 'default' && native.auto === 'auto') {
    startAutoFallback(agent, session);
    return;
  }
  if (native.expected && change.to !== native.expected) native.expected = null;
}

function startAutoFallback(agent, session) {
  const native = session._claudeNative;
  noteAutoUnavailable(session, native, 'runtime');
  notice(session, 'notice.permission.claudeAutoFallback');
  emitState(session);
  const pty = session.pty;
  const live = () => session.pty === pty && session.alive === true && !session._terminated;
  const run = async () => {
    // One press, manual → accept edits, once the prompt is free and nobody else is switching.
    // A hint or dialog hiding the footer is waited out; another mode on it means someone moved it.
    const ready = await waitUntil(() => {
      const shown = footerMode(session);
      if (shown && shown !== 'default') return 'moved';
      return shown && !session.permissionMode?.pending && !session._claudeDriving && !dialogOpen(session) ? 'ready' : null;
    }, TIMING.fallbackWait, live, Math.max(TIMING.poll, 250));
    if (ready !== 'ready') return;
    session._claudeDriving = true;
    try {
      await driveTo(session, () => 'acceptEdits', { auto: false, bypass: native.bypass === true }, live);
      native.expected = 'acceptEdits';
    } finally { session._claudeDriving = false; }
  };
  run().catch((err) => console.log(`[claude-live-mode] task ${session.taskId || session.tabId}: acceptEdits fallback not applied (${err.reason || err.message})`));
}

// Proceed in a run whose bypass is pre-enabled: one Shift+Tab from plan would enter bypass, so
// drive to where it lands without bypass (auto, else manual), then send the approval text.
async function approveFromPlan(agent, session, current) {
  const native = session._claudeNative;
  const live = () => current() && session.alive === true;
  const avail = { auto: native.auto === 'auto', bypass: true };
  session._claudeDriving = true;
  try {
    native.expected = await driveTo(session, (a) => (a.auto ? 'auto' : 'default'), avail, live, {
      onAutoUnavailable: () => noteAutoUnavailable(session, native, 'runtime'),
    });
  } finally { session._claudeDriving = false; }
  if (!live()) return;
  writeToPrompt(session, agent.getApprovalText(session));
  await delay(100);
  if (live()) writeToPrompt(session, '\r');
}

// What the terminal header needs to know about this run's native modes.
function nativeSummary(session) {
  const native = session?._claudeNative;
  return native ? { auto: native.auto, bypass: native.bypass === true } : null;
}

module.exports = {
  SHIFT_TAB, MAX_PRESSES, TIMING, DIRECTIVE_TYPED_LINE,
  parsePermissionChoices, cliPermissionCapabilities, claudeSettingsFiles, settingsDisable, cachedAutoModeGate,
  resolveNativePermissions, nextNativeMode, cyclePath, learnCycle, permissiveness,
  footerMode, dialogOpen, driveTo, submitDirective, switchMode, observeModeChange, approveFromPlan,
  noteAutoUnavailable, restoreMode, nativeSummary,
};
