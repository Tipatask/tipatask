'use strict';

// ── Computer use for task runs (TPT9225) ──
// Desktop control (screenshots, clicks, typing) so a task terminal's agent can run the app it
// changed and check the result. Claude uses its built-in session-bound server; Codex/Pi use
// the app-scoped native backend in computer-use-runtime.js. macOS only.
//
// Claude Code ships that server as a built-in. Verified against claude 2.1.318:
// - Each interactive session registers it as `computer-use` (not under -p, --bare /
//   CLAUDE_CODE_SIMPLE or --restricted) for a claude.ai Pro or Max sign-in while the CLI's own
//   feature gate is open, after --strict-mcp-config is applied, and adds every one of its tools
//   to the session's allowed tools — in every permission mode, plan included.
// - The server stays off until the project's entry in the Claude user configuration
//   (`.claude.json` projects[<key>].enabledMcpServers) lists `computer-use`: the switch /mcp
//   toggles. <key> is the canonical git root of the session's cwd, else the resolved cwd.
// - `computer-use` is a reserved server name there: a --mcp-config entry under it is skipped
//   with a startup warning. Claude gets the switch, never a derived-config entry. Codex/Pi
//   use computer-use-runtime.js: the standalone Claude entry has no session-bound grants.
// - PreToolUse hook input carries `permission_mode`, so a hook tells plan mode from the other
//   modes on every call, across live mode switches.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_NAME = 'computer-use';
const SERVER_FLAG = '--computer-use-mcp';
const PROVIDERS = Object.freeze(['claude', 'codex', 'pi']);
// The tool names an agent sees, where known: Claude prefixes MCP tools `mcp__<server>__`; Pi's
// bridge names them `<server>__<tool>` (providers/pi-ext/mcp-bridge.mjs).
const TOOL_PREFIXES = Object.freeze({ claude: `mcp__${SERVER_NAME}__`, pi: `${SERVER_NAME}__` });
// What a run may use in Plan: the server's observation-only tools (the CLI's own read-only set:
// screenshot, zoom, cursor_position, wait) plus the two a screenshot depends on. A screenshot
// shows only the apps the user granted, so asking for access and listing grants stay allowed.
const PLAN_TOOLS = Object.freeze(['screenshot', 'zoom', 'cursor_position', 'wait', 'request_access', 'list_granted_applications']);
const REASONS = Object.freeze({
  provider: 'No computer-use support is registered for this agent.',
  platform: 'Computer use needs macOS.',
  server: 'Computer use needs Claude Code with its computer-use server (claude --computer-use-mcp); install or update Claude Code.',
  switch: "Claude Code's computer-use server could not be turned on for this project: its user configuration could not be updated.",
  hooks: 'Claude Code settings turn hooks off (disableAllHooks or allowManagedHooksOnly), so Plan cannot be held to screenshots; this Plan run starts without computer use.',
  session: 'Claude Code standalone computer-use MCP has no session-bound app permissions. Start a fresh task in an updated Task App to use its native app-scoped backend.',
});

function unavailable(provider, reasonCode) {
  return Object.freeze({ available: false, provider: provider ?? null, reasonCode, reason: REASONS[reasonCode] });
}

// The computer-use server for one provider's task run, or why there is none. Pure: the caller
// passes what it found out about the Claude CLI — `command`, the absolute path of the CLI, and
// `serverSupported`, whether its bundle carries the server (ClaudeAgent._cliSupportsComputerUse()).
//   { available: true, provider, serverName, server: { command, args }, builtin, toolPrefix, planTools }
//     builtin  Claude: the session's own CLI provides the server; turn it on with
//              enableClaudeComputerUse() and never register `server` (the name is reserved there)
//     server   the stdio entry an MCP client (Codex, Pi's bridge) registers under serverName
//     toolPrefix  how the agent's tool names start, or null when not known here
//   { available: false, provider, reasonCode, reason }   reasonCode is a REASONS key
function resolveComputerUse(provider, platform = process.platform, { command = null, serverSupported = false } = {}) {
  if (!PROVIDERS.includes(provider)) return unavailable(provider, 'provider');
  if (platform !== 'darwin') return unavailable(provider, 'platform');
  if (provider !== 'claude') return unavailable(provider, 'session');
  if (typeof command !== 'string' || !path.isAbsolute(command) || serverSupported !== true) {
    return unavailable(provider, 'server');
  }
  return Object.freeze({
    available: true,
    provider,
    serverName: SERVER_NAME,
    server: Object.freeze({ command, args: Object.freeze([SERVER_FLAG]) }),
    builtin: provider === 'claude',
    toolPrefix: TOOL_PREFIXES[provider] || null,
    planTools: PLAN_TOOLS,
  });
}

// ── Claude ──

// The Claude user configuration (`.claude.json`): in $CLAUDE_CONFIG_DIR, else the home dir.
function claudeUserConfigPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// The key the CLI files a session's project settings under: the canonical git root of the cwd —
// the nearest directory holding `.git`, mapped to the main repository when that `.git` is a
// linked worktree's pointer file — else the resolved cwd.
function claudeProjectKey(projectRoot) {
  const start = path.resolve(projectRoot);
  for (let dir = start; ; dir = path.dirname(dir)) {
    let stat = null;
    try { stat = fs.statSync(path.join(dir, '.git')); } catch { /* not here */ }
    if (stat) return (stat.isFile() && linkedWorktreeMain(dir)) || dir;
    if (path.dirname(dir) === dir) return start;
  }
}

// A linked worktree's `.git` file names its gitdir, whose `commondir` leads to the main
// repository's `.git`. A submodule's gitdir has no `commondir`: its own root is the key.
function linkedWorktreeMain(dir) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'));
    if (!pointer) return null;
    const gitDir = path.resolve(dir, pointer[1].trim());
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    return path.basename(common) === '.git' ? path.dirname(common) : null;
  } catch { return null; }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The CLI's per-project switch for its built-in server, the one /mcp toggles: `computer-use` in
// projects[claudeProjectKey(projectRoot)].enabledMcpServers of the Claude user configuration.
// Keeps everything else in the file, writes nothing when the switch is already on, writes
// atomically with the file's own mode, and never replaces a malformed file. Returns whether the
// switch is on. It is the project's own setting: the user's `claude` sessions there get it too.
function enableClaudeComputerUse(projectRoot, { env = process.env } = {}) {
  const file = claudeUserConfigPath(env);
  let tmp = null;
  try {
    const key = claudeProjectKey(projectRoot);
    let config = {};
    let mode = 0o600;
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
      mode = fs.statSync(file).mode & 0o777;
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!isObject(config) || (config.projects !== undefined && !isObject(config.projects))) {
      throw new Error('the Claude user configuration is not an object');
    }
    const entry = config.projects?.[key];
    if (entry !== undefined && !isObject(entry)) throw new Error('the project entry is not an object');
    const enabled = entry?.enabledMcpServers;
    if (enabled !== undefined && !Array.isArray(enabled)) throw new Error('enabledMcpServers is not a list');
    if (enabled?.includes(SERVER_NAME)) return true;
    config.projects = { ...config.projects, [key]: { ...entry, enabledMcpServers: [...(enabled || []), SERVER_NAME] } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    tmp = null;
    return true;
  } catch (err) {
    console.warn(`[computer-use] could not turn on Claude's computer-use server for this project: ${err.message}`);
    return false;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
  }
}

// ── Claude: Plan held to screenshots ──
// The CLI allows every computer-use tool in every mode, and its plan mode does not hold an
// allowed call. A PreToolUse hook (passed in --settings) holds the rest: while the hook input's
// permission_mode is `plan`, a computer-use tool outside PLAN_TOOLS is denied. It is read on
// every call, so leaving Plan — plan approval or a live switch — lifts it at the next call, and
// Auto and Bypass never match. Shell builtins only (the CLI runs hook commands through
// /bin/sh): no Node start per tool call, nothing to resolve on PATH.
const PLAN_DENY_REASON = 'Plan mode: computer use is limited to screenshots until the plan is approved.';

function claudePlanHookCommand() {
  // The CLI writes the hook input as compact JSON; the spaced form matches too.
  const field = (name, value) => [`*'"${name}":"${value}"'*`, `*'"${name}": "${value}"'*`];
  const observe = PLAN_TOOLS.flatMap((tool) => field('tool_name', TOOL_PREFIXES.claude + tool)).join('|');
  const deny = JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_DENY_REASON,
  } });
  return `i=$(cat); case $i in ${field('permission_mode', 'plan').join('|')}) case $i in ${observe}) ;; *) printf '%s\\n' '${deny}' ;; esac ;; esac`;
}

// The --settings fragment carrying that hook (merged with any other --settings keys).
function claudePlanHookSettings() {
  return { hooks: { PreToolUse: [{
    matcher: `${TOOL_PREFIXES.claude}.*`,
    hooks: [{ type: 'command', command: claudePlanHookCommand(), timeout: 10 }],
  }] } };
}

// --allowedTools for a Claude launch: the whole server for Auto and Bypass, the Plan tools for a
// planning launch (Plan, or a legacy run without a mode).
function claudeAllowedTools(mode) {
  return mode === 'auto' || mode === 'bypass'
    ? [`mcp__${SERVER_NAME}`]
    : PLAN_TOOLS.map((tool) => TOOL_PREFIXES.claude + tool);
}

// Whether a Claude settings file this project reads turns hooks off (disableAllHooks) or limits
// them to managed ones (allowManagedHooksOnly): the plan hook would then never run. Same files
// as claude-live-mode.js claudeSettingsFiles(); an unreadable file counts as not blocking.
function claudeHooksBlocked(projectRoot, opts = {}) {
  const { claudeSettingsFiles } = require('./task-agent/claude-live-mode');
  return claudeSettingsFiles(projectRoot, opts).some((file) => {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    return isObject(settings) && (settings.disableAllHooks === true || settings.allowManagedHooksOnly === true);
  });
}

// Everything one Claude launch needs for computer use, from resolveComputerUse()'s answer and
// the run's permission mode. Returns { computerUse, args, settings }:
//   computerUse  what the kickoff sees: the answer as given, or unavailable when the switch
//                could not be set ('switch') or a planning launch cannot be held to screenshots
//                ('hooks'; fail closed: --disallowedTools keeps the whole server off, even one
//                the user turned on, for the life of the run)
//   args         command-line flags
//   settings     the plan hook, to merge into --settings; null when not used
// Turns the switch on as a side effect; call it after the folder-trust write (hooks only run in
// a trusted folder).
function claudeComputerUseLaunch(computerUse, { mode = null, projectRoot, env = process.env, platform, managedDir } = {}) {
  const none = { computerUse: computerUse || null, args: [], settings: null };
  if (!computerUse?.available || computerUse.provider !== 'claude') return none;
  const planning = mode !== 'auto' && mode !== 'bypass';
  if (planning && claudeHooksBlocked(projectRoot, { env, platform, managedDir })) {
    return { computerUse: unavailable('claude', 'hooks'), args: ['--disallowedTools', `mcp__${SERVER_NAME}`], settings: null };
  }
  if (!enableClaudeComputerUse(projectRoot, { env })) return { ...none, computerUse: unavailable('claude', 'switch') };
  return { computerUse, args: ['--allowedTools', claudeAllowedTools(mode).join(',')], settings: claudePlanHookSettings() };
}

module.exports = {
  SERVER_NAME, SERVER_FLAG, PROVIDERS, TOOL_PREFIXES, PLAN_TOOLS, REASONS, PLAN_DENY_REASON,
  resolveComputerUse, claudeUserConfigPath, claudeProjectKey, enableClaudeComputerUse,
  claudePlanHookCommand, claudePlanHookSettings, claudeAllowedTools, claudeHooksBlocked, claudeComputerUseLaunch,
};
