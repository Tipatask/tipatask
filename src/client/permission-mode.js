// (TPT9063) Agent permission mode — pure helpers shared by the card button and dialog
// (task-permission-mode.js), the settings bundle (group-label.js) and the terminal header's
// live selector (session-mode-control.js, TPT9139). Mirrors
// api/src/lib/agent-permission-mode.js's canonical values (same hand-mirror convention as
// group-label.js's TASK_GROUP_LABELS — the client can't require() the API package's lib).
// null on a PROJECT is "Not set" (legacy behaviour kept — not a fourth mode); null on a TASK is
// Project Default, resolved when the task starts, never copied at creation. Zero imports on
// purpose: `t` is passed in, so this stays importable under bare `node --test` and inside the
// vm harnesses. The screenshot's order is the canonical order everywhere.

export const AGENT_PERMISSION_MODES = Object.freeze(['plan', 'auto', 'bypass']);

function shieldIcon(mode, detail) {
  const outline = 'M8 1.5 3 3.5v4c0 3 2.1 5.3 5 6.5 2.9-1.2 5-3.5 5-6.5v-4Z';
  return `<svg class="permission-mode-icon permission-mode-icon--${mode}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${outline}"${mode === 'inherited' ? ' stroke-dasharray="2 2"' : ''}/>${detail}</svg>`;
}

// Static, trusted SVGs shared by selects and permission indicators. Inheritance/unset is
// deliberately distinct from the effective mode; all glyphs inherit theme colours via CSS.
export const PERMISSION_MODE_ICONS = Object.freeze({
  inherited: shieldIcon('inherited', '<path d="M6 7.5h4"/>'),
  plan: shieldIcon('plan', '<path d="M6 5.5h4M6 7.5h4M6 9.5h2"/>'),
  auto: shieldIcon('auto', '<path d="m8 4 .8 2.7L11 7.5l-2.2.8L8 11l-.8-2.7L5 7.5l2.2-.8Z"/>'),
  bypass: shieldIcon('bypass', '<path d="M8.5 4 6 8h2l-.5 3L10 7H8Z"/>'),
});

export function permissionModeIcon(mode) {
  return PERMISSION_MODE_ICONS[normalizePermissionMode(mode) || 'inherited'];
}

export const PERMISSION_MODE_LABEL_KEYS = Object.freeze({
  plan: 'permissionMode.plan',
  auto: 'permissionMode.auto',
  bypass: 'permissionMode.bypass',
});

export const PERMISSION_MODE_HINT_KEYS = Object.freeze({
  plan: 'permissionMode.hint.plan',
  auto: 'permissionMode.hint.auto',
  bypass: 'permissionMode.hint.bypass',
});

export function isAgentPermissionMode(value) {
  return typeof value === 'string' && AGENT_PERMISSION_MODES.includes(value);
}

// One of the three, else null — unknown strings from a newer server are treated as unset.
export function normalizePermissionMode(value) {
  if (value === 'always_ask' || value === 'accept_edits') return 'auto';
  return isAgentPermissionMode(value) ? value : null;
}

export function permissionModeLabel(value, t) {
  const mode = normalizePermissionMode(value);
  return mode ? t(PERMISSION_MODE_LABEL_KEYS[mode]) : t('permissionMode.notSet');
}

// "Project Default (Auto mode)" / "Project Default (Not set)" — the task-level option that
// defers to the project's effective value when the task starts.
export function projectDefaultLabel(projectDefault, t) {
  return t('permissionMode.projectDefaultWith', { mode: permissionModeLabel(projectDefault, t) });
}

// The mode a task will start with: its own override, else the project default it inherits
// (`inherited: true`, `mode: null` while the project default is Not set). Accepts both the
// Task App's camelCase row and a raw API row.
export function effectivePermissionMode(task, projectDefault) {
  const override = normalizePermissionMode(task?.agentPermissionMode ?? task?.agent_permission_mode);
  if (override) return { mode: override, inherited: false };
  return { mode: normalizePermissionMode(projectDefault), inherited: true };
}

// (TPT9161) Cowboy-coding mode (tasks.cowboy_mode): on only while the task also starts in Bypass.
// The API stores the flag only under bypass, but a project-default change never rewrites task
// rows, so a stored flag can outlive the bypass it was set under — never trust it alone.
export function cowboyModeOn(task, projectDefault) {
  return !!(task?.cowboyMode ?? task?.cowboy_mode) && effectivePermissionMode(task, projectDefault).mode === 'bypass';
}

// Card button tip: "Permission mode: Project Default (Auto mode)" / "Permission mode: Plan mode",
// plus the cowboy marker while cowboyModeOn() — "Permission mode: Bypass · 🤠 Cowboy-coding mode".
export function permissionModeTip(task, projectDefault, t) {
  const { mode, inherited } = effectivePermissionMode(task, projectDefault);
  const tip = t('permissionMode.tip', { mode: inherited ? projectDefaultLabel(projectDefault, t) : permissionModeLabel(mode, t) });
  return cowboyModeOn(task, projectDefault) ? `${tip} · ${t('cowboyMode.marker')}` : tip;
}

function inheritedHint(projectDefault, t) {
  projectDefault = normalizePermissionMode(projectDefault);
  return isAgentPermissionMode(projectDefault)
    ? t('permissionMode.hint.inherited', { mode: permissionModeLabel(projectDefault, t), hint: t(PERMISSION_MODE_HINT_KEYS[projectDefault]) })
    : t('permissionMode.hint.notSet');
}

function modeRow(mode, selected, t) {
  return { value: mode, label: t(PERMISSION_MODE_LABEL_KEYS[mode]), hint: t(PERMISSION_MODE_HINT_KEYS[mode]), icon: permissionModeIcon(mode), selected: selected === mode };
}

// The task <select>: value '' = "Project Default (…)" first, then the three in order. Exactly one
// row is selected — the override, or Project Default while there is none.
export function buildTaskModeOptions(selected, projectDefault, t) {
  const current = normalizePermissionMode(selected);
  return [
    { value: '', label: projectDefaultLabel(projectDefault, t), hint: inheritedHint(projectDefault, t), icon: permissionModeIcon(null), selected: current === null },
    ...AGENT_PERMISSION_MODES.map(mode => modeRow(mode, current, t)),
  ];
}

// The project <select>: the three in order, plus a disabled "Not set" placeholder row (value '')
// only while the stored default is null — so the select only ever submits a real mode.
export function buildProjectModeOptions(selected, t) {
  const current = normalizePermissionMode(selected);
  const rows = AGENT_PERMISSION_MODES.map(mode => modeRow(mode, current, t));
  if (current === null) rows.unshift({ value: '', label: t('permissionMode.notSet'), hint: t('permissionMode.hint.notSet'), icon: permissionModeIcon(null), selected: true, placeholder: true });
  return rows;
}

// (TPT9139) Live switching in a running task terminal. The server owns the state machine
// (requestPermissionMode(), terminal-session.js); these shape what the terminal header shows.
// Plan can be left but never re-entered, so a Plan run — and a legacy run with no mode, which
// plans first — may go to Auto or Bypass, and an execution mode only to the other one.
export function liveModeOptions(confirmed) {
  const mode = normalizePermissionMode(confirmed);
  if (mode === 'auto') return ['bypass'];
  if (mode === 'bypass') return ['auto'];
  return ['auto', 'bypass'];
}

// Server error reasons with their own terminal.permission.reason.* text; `offline` is the
// client's own (no open terminal socket). Anything else shows the server's message.
export const LIVE_MODE_ERROR_REASONS = Object.freeze(['plan_target', 'invalid_target', 'inactive',
  'busy', 'unsupported', 'unconfirmed', 'session_changed', 'failed', 'offline',
  'starting', 'prompt_open', 'prompt_busy', 'bypass_unavailable']);

// One { requested, confirmed, pending, error, supported } shape for whatever carried it: a
// `session:permission-mode-changed` frame, terminal-state's permissionModeState, a
// GET /api/sessions row, or a bare confirmed mode (never switchable). `supported` is true only
// when the server says the run's agent can switch live and has not refused it as unsupported.
// (TPT9136) `native` is kept when the server reports it: what Auto means for this run natively
// ('auto', or the 'acceptEdits' fallback) and whether Bypass is reachable at all.
export function liveModeState(raw) {
  if (!raw || typeof raw !== 'object') {
    const mode = normalizePermissionMode(raw);
    return { requested: mode, confirmed: mode, pending: false, error: null, supported: false };
  }
  const error = raw.error && typeof raw.error === 'object'
    ? { code: String(raw.error.code || ''), reason: String(raw.error.reason || 'failed'), message: String(raw.error.message || '') }
    : null;
  const native = raw.native && typeof raw.native === 'object'
    ? { auto: raw.native.auto === 'acceptEdits' ? 'acceptEdits' : 'auto', bypass: raw.native.bypass !== false }
    : null;
  return {
    requested: normalizePermissionMode(raw.requested),
    confirmed: normalizePermissionMode(raw.confirmed),
    pending: raw.pending === true,
    error,
    supported: raw.supported === true && error?.reason !== 'unsupported',
    ...(native ? { native } : {}),
  };
}

// The header's text for a run: its confirmed mode, or "Switching to {mode}…" while a request is
// pending — never a requested mode as if it already applied.
export function liveModeLabel(state, t) {
  const live = liveModeState(state);
  if (live.pending && live.requested && live.requested !== live.confirmed) {
    return t('terminal.permission.switching', { mode: permissionModeLabel(live.requested, t) });
  }
  return permissionModeLabel(live.confirmed, t);
}

// The live selector's rows: the confirmed mode first and selected — its hint says what a switch
// does — then the liveModeOptions() targets. A legacy run's current row is the disabled
// "Not set" placeholder, so it can only be left. (TPT9136) With the run's `native` modes known,
// Auto's hint names the acceptEdits fallback and an unreachable Bypass row is disabled.
export function buildLiveModeOptions(confirmed, t, native = null) {
  const current = normalizePermissionMode(confirmed);
  const fallback = native?.auto === 'acceptEdits' ? t('terminal.permission.autoFallback') : '';
  const hint = [current === 'auto' ? fallback : '', t(current === 'auto' || current === 'bypass' ? 'terminal.permission.current' : 'terminal.permission.currentPlan'), t('terminal.permission.notCancelled')].filter(Boolean).join(' ');
  const head = current
    ? { ...modeRow(current, current, t), hint }
    : { value: '', label: t('permissionMode.notSet'), hint, icon: permissionModeIcon(null), selected: true, placeholder: true };
  return [head, ...liveModeOptions(current).map((mode) => {
    const row = modeRow(mode, current, t);
    if (mode === 'bypass' && native?.bypass === false) return { ...row, hint: t('terminal.permission.bypassUnavailable'), disabled: true };
    if (mode === 'auto' && fallback) return { ...row, hint: fallback };
    return row;
  })];
}

// Toast text for a refused or failed switch: what was asked, why (a known reason in the UI
// language, else the server's own words), and the mode the run keeps.
export function liveModeErrorText(state, t) {
  const live = liveModeState(state);
  const reason = live.error?.reason || 'failed';
  const why = LIVE_MODE_ERROR_REASONS.includes(reason)
    ? t(`terminal.permission.reason.${reason}`)
    : (live.error?.message || t('terminal.permission.reason.failed'));
  const head = live.requested
    ? t('terminal.permission.failed', { mode: permissionModeLabel(live.requested, t), reason: why })
    : t('terminal.permission.failedAny', { reason: why });
  return live.confirmed ? `${head} ${t('terminal.permission.kept', { mode: permissionModeLabel(live.confirmed, t) })}` : head;
}
