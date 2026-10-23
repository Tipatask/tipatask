// (TPT9063) Agent permission mode — pure helpers shared by the card button and dialog
// (task-permission-mode.js) and the settings bundle (group-label.js). Mirrors
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

// Card button tip: "Permission mode: Project Default (Auto mode)" / "Permission mode: Plan mode".
export function permissionModeTip(task, projectDefault, t) {
  const { mode, inherited } = effectivePermissionMode(task, projectDefault);
  return t('permissionMode.tip', { mode: inherited ? projectDefaultLabel(projectDefault, t) : permissionModeLabel(mode, t) });
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
