'use strict';

// Runtime policy, independent of the display-only normalizer in src/client.
// Unknown values and unavailable live settings must never become permission grants.
const MODES = Object.freeze(['plan', 'auto', 'bypass']);
const READ_TASK_TOOLS = Object.freeze(['get_task', 'list_tasks', 'list_system_tags', 'get_project_tags',
  'get_tag_architecture', 'get_tag_architectures', 'list_task_resolutions', 'list_knowledge_conflicts',
  'get_knowledge_conflict']);
const READ_LOCAL_TOOLS = Object.freeze(['git_worktree_status', 'batch_grep_tags']);
const SUPPORT_REASONS = Object.freeze({
  codexGate: 'this CLI has no fail-closed gate for every tool action',
  codexVersion: 'Codex 0.163.0 or newer is required',
  codexProfiles: 'named Codex permission profiles conflict with task sandbox policies; remove default_permissions before starting',
  windows: 'a verified Windows read-only sandbox is required',
  piVersion: 'Pi 0.84.1 or newer is required for blocking tool events',
  provider: 'no permission adapter is registered',
  images: 'image tasks use a separate generation approval flow',
});
// First Pi CLI whose extension tool_call handlers can block a tool (the gate's requirement).
const PI_GATE_VERSION = Object.freeze([0, 84, 1]);

function permissionError(reason, params = {}) {
  if (params.supportReason) params = { ...params, detail: SUPPORT_REASONS[params.supportReason] };
  const messages = {
    unavailable: 'Could not read current permission settings. Task start canceled.',
    invalid: 'Invalid permission mode. Task start canceled.',
    unsupported: `Permission mode ${params.mode} is not supported by ${params.agent}: ${params.detail}`,
  };
  return Object.assign(new Error(messages[reason] || messages.unavailable), {
    code: 'EPERMISSION', reason, params,
  });
}

function validateMode(value) {
  if (value == null) return null;
  if (value === 'always_ask' || value === 'accept_edits') return 'auto';
  if (!MODES.includes(value)) throw permissionError('invalid');
  return value;
}

async function resolvePermissionMode({ backend, task, taskId, planOnly = false } = {}) {
  if (!task && taskId) {
    try { task = await backend?.getTask(taskId); } catch { throw permissionError('unavailable'); }
    if (!task) throw permissionError('unavailable');
  }
  const override = validateMode(task?.agentPermissionMode !== undefined
    ? task.agentPermissionMode : task?.agent_permission_mode);
  // Explicit planning/discussion launches cannot inherit execution permissions.
  if (planOnly) return Object.freeze({ mode: 'plan', source: 'planning', inherited: false });
  if (override) return Object.freeze({ mode: override, source: 'task', inherited: false });
  let result;
  try { result = await backend?.getEffectiveProjectSettings({ strict: true, refresh: true }); }
  catch { throw permissionError('unavailable'); }
  if (!result?.settings || !Object.hasOwn(result.settings, 'agent_permission_mode')) {
    throw permissionError('unavailable');
  }
  const mode = validateMode(result.settings.agent_permission_mode);
  return Object.freeze({ mode, source: mode ? 'project' : 'legacy', inherited: true });
}

// (TPT9136) The project's effective default mode, for launch decisions that follow it even when a
// task override chose the run's mode. Read fresh and strict: a cached, offline or unreadable value
// returns null and never widens a run. Planning launches and legacy runs have none.
async function resolveProjectPermissionMode({ backend, resolved } = {}) {
  if (resolved?.source === 'project') return validateMode(resolved.mode);
  if (resolved?.source !== 'task') return null;
  try {
    const result = await backend?.getEffectiveProjectSettings({ strict: true, refresh: true });
    return validateMode(result?.settings?.agent_permission_mode);
  } catch { return null; }
}

// Claude's Auto: native auto mode lets the CLI's classifier decide each tool call; when this run
// cannot use it (CLI, settings, account or model), Auto launches acceptEdits instead and the
// native dialog decides everything beyond project edits. `resolved.nativeAuto` carries which one
// the run uses (ClaudeAgent#getSpawnSpec(), claude-live-mode.js); absent means the dialog text.
const CLAUDE_AUTO_TEXT = Object.freeze({
  auto: "Auto mode: Claude Code's native auto mode is on: its classifier checks each tool call, runs routine actions it assesses as lower-risk without asking, and blocks risky ones. A blocked action needs a different approach or the user's explicit approval in the terminal.",
  acceptEdits: "Auto mode: project file edits are accepted automatically; other actions follow Claude's native allow / allow-all / deny permission dialog, answered in the terminal.",
});

function buildPermissionPolicy(resolved, agent) {
  const mode = validateMode(resolved?.mode);
  const planning = mode === null || mode === 'plan';
  const instructions = {
    plan: 'First study the task, relevant source code, configuration files, and architecture docs. Present the plan, then end with a standalone line reading Plan ready. Wait for user approval before implementing, editing files, changing tasks, or running mutating commands. After approval, implement the approved plan in this same session, verify the changes, and finish through the guarded completion tool.',
    auto: (agent === 'claude'
      ? CLAUDE_AUTO_TEXT[resolved?.nativeAuto === 'auto' ? 'auto' : 'acceptEdits']
      : 'Auto mode: known read-only actions and project file edits are assessed automatically; uncertain actions require approval.')
      + ' Start implementing the requested task; do not impose a separate plan-approval pause.',
    bypass: 'Bypass mode: the user authorizes carrying out this task without approval pauses. Implement, verify, make all required VCS commits, and finish through the guarded completion tool in this run. Do not stop for a plan approval, ask permission for already-authorized work, or offer to finish later. VCS settings and completion guards still apply.',
  };
  return Object.freeze({ ...resolved, mode, agent, planning, enforced: !planning,
    communication: communicationDirective(mode),
    prompt: mode ? `Permission policy for this run (${mode}):\n${instructions[mode]}\nProject VCS permissions and guarded completion remain mandatory.` : '',
  });
}

function modeSwitchError(reason) {
  const messages = {
    plan_target: 'Switching back to Plan is not supported.',
    invalid_target: 'Permission mode must be auto or bypass.',
    inactive: 'Permission mode can only change in a running task terminal.',
    busy: 'A permission-mode change is already pending.',
    unsupported: 'This provider does not support live permission-mode changes.',
    unconfirmed: 'The provider did not confirm the requested permission mode.',
    session_changed: 'The terminal run ended or changed before permission mode was confirmed.',
    failed: 'The provider could not change permission mode.',
    starting: 'The agent is still starting. Switch once its first prompt has been sent.',
    prompt_open: 'A prompt is open in the terminal. Answer it there, then switch again.',
    prompt_busy: 'There is unsent text in the terminal prompt. Send or clear it, then switch again.',
    bypass_unavailable: 'Bypass was not enabled when this run started. Restart the task in Bypass to use it.',
  };
  return Object.assign(new Error(messages[reason] || messages.failed), { code: 'EPERMISSION_MODE', reason });
}

function validateLiveMode(mode) {
  if (mode === 'plan') throw modeSwitchError('plan_target');
  if (mode !== 'auto' && mode !== 'bypass') throw modeSwitchError('invalid_target');
  return mode;
}

// Rebuild on the existing session, retaining immutable snapshots and all unrelated
// constraints (including the separately verified VCS context). No preference writes.
function applyLivePolicy(session, mode) {
  validateLiveMode(mode);
  if (!session.permissionPolicy) throw modeSwitchError('inactive');
  session.permissionPolicy = buildPermissionPolicy({ ...session.permissionPolicy,
    mode, source: 'session', inherited: false }, session.taskAgent || session.permissionPolicy.agent);
  return session.permissionPolicy;
}

function permissionModeSnapshot(session) {
  return { ...(session.permissionMode || {
    requested: session.permissionPolicy?.mode ?? null,
    confirmed: session.permissionPolicy?.mode ?? null,
    pending: false, error: null,
  }) };
}

// What a session's tool gate enforces now: always the confirmed mode, never a requested one
// (permission-gate.js holds decisions while a switch is pending). `assess` is the rule set:
// Plan and legacy null stay read-only while planning; once the plan is approved in place
// ('approved') the run keeps the provider's unattended tool loop, as before the gate loaded
// in those modes. Any other value is treated as Plan.
function gatePolicy(session) {
  const state = session?.permissionMode;
  const mode = state ? (state.confirmed ?? null) : (session?.permissionPolicy?.mode ?? null);
  if (mode === 'auto' || mode === 'bypass') return { mode, assess: mode };
  const planFirst = mode === null || mode === 'plan';
  return { mode, assess: planFirst && session?.terminalPhase === 'executing' ? 'approved' : 'plan' };
}

// Communication follows the same confirmed run policy as tool permissions. It never
// authorizes an action: the native/bridged gate still decides whether it can run.
function communicationDirective(mode) {
  const scopes = {
    plan: '', // Preserve the existing planning and clarification flow.
    auto: 'Settle routine implementation choices autonomously within already-authorized work. Uncertain actions still require approval through the existing permission gate; do not treat choosing an option as permission to execute it.',
    bypass: 'Use autonomous decision-making by default for this task. Do not request routine preferences or approval for already-authorized work.',
  };
  const scope = scopes[validateMode(mode)];
  if (!scope) return '';
  return [
    'Communication for this run:',
    scope,
    'Before deciding, inspect the task, comments, repository and KB using permitted tools. Compare reasonable options against the user\'s requirements, correctness, compatibility, maintainability and scope; choose the best overall option and continue within the permission policy.',
    'Briefly report material decisions or assumptions without an unsolicited questionnaire or approval pause. This replaces generic instructions to ask about routine implementation preferences for already-authorized work.',
    'Still honor explicit user instructions to consult them. Ask a concise necessary question for genuinely missing external input or a blocking requirement that available context cannot resolve; never invent an answer or treat silence as consent.',
  ].join('\n');
}

function versionAtLeast(version, minimum) {
  const found = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found) return false;
  const n = found.slice(1).map(Number);
  return n.some((v, i) => v > minimum[i] && n.slice(0, i).every((x, j) => x === minimum[j]))
    || n.every((v, i) => v === minimum[i]);
}

function assertPermissionSupport(policy, version, platform = process.platform) {
  if (!policy.enforced) return;
  const { agent, mode } = policy;
  let supportReason;
  if (agent === 'codex') {
    if (['always_ask', 'accept_edits'].includes(mode)) supportReason = 'codexGate';
    else if (!versionAtLeast(version, [0, 163, 0])) supportReason = 'codexVersion';
    else if (mode === 'plan' && platform === 'win32') supportReason = 'windows';
  } else if (agent === 'claude') {
    // Native plan/auto/acceptEdits/bypassPermissions do not require blocking hook support; Auto
    // falls back to acceptEdits at spawn when native auto is unavailable (claude-live-mode.js).
  } else if (agent === 'pi') {
    if (mode !== 'bypass' && !versionAtLeast(version, PI_GATE_VERSION)) supportReason = 'piVersion';
  } else supportReason = 'provider';
  if (supportReason) throw permissionError('unsupported', { mode, agent, supportReason });
}

module.exports = { MODES, READ_TASK_TOOLS, READ_LOCAL_TOOLS, PI_GATE_VERSION, permissionError, validateMode,
  resolvePermissionMode, resolveProjectPermissionMode, buildPermissionPolicy, assertPermissionSupport, versionAtLeast,
  applyLivePolicy, validateLiveMode, modeSwitchError, permissionModeSnapshot, gatePolicy };
