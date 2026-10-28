'use strict';

// Shared Codex CLI spawn-env builder (C1029). Extracted from
// task-agent/codex-agent.js getSpawnSpec() so the objective-chat Codex provider
// (providers/codex-session.js) gets the exact same MCP wiring as the terminal Codex
// task agent for free — same refreshed Tipatask servers, same inherited user-level MCP
// servers, same project-scoped CODEX_HOME.
const path = require('node:path');
const fs = require('node:fs');
const toml = require('toml');
const { createHash, randomUUID } = require('node:crypto');
const config = require('./config');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir } = require('./spawn-utils');
const { ensureProjectCodexHome, prepareCodexTerminalHome, tomlValue } = require('../codex-mcp-config');
const { permissionError } = require('./permission-policy');

function policyToCodexConfig(mode) {
  // Plan retains the user's sandbox; planning itself is the existing prompt gate.
  if (mode === 'plan') return { sandbox_mode: undefined, approval_policy: 'on-request', approvals_reviewer: 'user' };
  if (mode === 'auto') return { sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'auto_review' };
  if (mode === 'bypass') return { sandbox_mode: 'danger-full-access', approval_policy: 'never', approvals_reviewer: 'user' };
  throw permissionError('invalid');
}

function codexPermissionOverrides(policy, parsed) {
  // Planning is a prompt gate; execution continues with native user approvals.
  if (policy?.mode === 'plan') {
    const { sandbox_mode, ...overrides } = policyToCodexConfig('plan');
    return overrides;
  }
  if (!policy?.enforced) return {};
  if (parsed.default_permissions) throw permissionError('unsupported', {
    mode: policy.mode, agent: 'codex', supportReason: 'codexProfiles',
  });
  const auto = policy.mode === 'auto';
  const result = {
    ...policyToCodexConfig(policy.mode),
    'features.guardian_approval': auto,
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.writable_roots': [],
  };
  for (const id of new Set(['_default', ...Object.keys(parsed.apps || {})])) {
    const prefix = `apps.${JSON.stringify(id)}`;
    result[`${prefix}.default_tools_approval_mode`] = auto ? 'prompt' : 'approve';
    result[`${prefix}.approvals_reviewer`] = auto ? 'auto_review' : 'user';
    for (const tool of Object.keys(parsed.apps?.[id]?.tools || {})) {
      result[`${prefix}.tools.${JSON.stringify(tool)}.approval_mode`] = auto ? 'prompt' : 'approve';
    }
  }
  for (const [plugin, config] of Object.entries(parsed.plugins || {})) {
    for (const id of Object.keys(config.mcp_servers || {})) {
      result[`plugins.${JSON.stringify(plugin)}.mcp_servers.${JSON.stringify(id)}.default_tools_approval_mode`] = auto ? 'prompt' : 'approve';
    }
  }
  for (const [id, server] of Object.entries(parsed.mcp_servers || {})) {
    const prefix = `mcp_servers.${JSON.stringify(id)}`;
    result[`${prefix}.default_tools_approval_mode`] = auto ? 'prompt' : 'approve';
    for (const tool of Object.keys(server.tools || {})) {
      result[`${prefix}.tools.${JSON.stringify(tool)}.approval_mode`] = auto ? 'prompt' : 'approve';
    }
  }
  return result;
}

const CODEX_REASONING_EFFORT = 'high';
const DAEMON_RECORD = 'tipatask-daemon.json';
const DAEMON_START_WINDOW_MS = 120000;

function stableJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

// Return a secret-free reason, or null when compatible. Persist the fingerprint
// so restarting the Task App does not forget a daemon it launched. Native PID
// identity is still required: a record alone never authorizes an unknown server.
function terminalDaemonFallback(codexHome, env, parsedConfig) {
  // The TUI writes onboarding counters on each launch. They are client state,
  // not daemon settings. Compare semantic config, ignoring formatting and order.
  const { tui, ...serverConfig } = parsedConfig;
  const fingerprint = createHash('sha256')
    .update(stableJson(env)).update(stableJson(serverConfig)).digest('hex');
  const recordPath = path.join(codexHome, DAEMON_RECORD);
  const lockPath = `${recordPath}.lock`;
  let lock;
  try {
    try { lock = fs.openSync(lockPath, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Recover a lock left by an exited writer. Never steal a live/unknown lock.
      const owner = fs.readFileSync(lockPath, 'utf8');
      const pid = Number(owner);
      if (!Number.isInteger(pid) || pid <= 0) return 'daemon-record-busy';
      try { process.kill(pid, 0); return 'daemon-record-busy'; }
      catch (probe) { if (probe.code !== 'ESRCH') return 'daemon-record-busy'; }
      if (fs.readFileSync(lockPath, 'utf8') !== owner) return 'daemon-record-busy';
      fs.unlinkSync(lockPath);
      lock = fs.openSync(lockPath, 'wx', 0o600);
    }
    fs.writeFileSync(lock, String(process.pid));
    return checkDaemonRecord();
  } catch { return 'daemon-record-unavailable'; }
  finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch { /* another launch will fail closed */ }
    }
  }

  function save(record) {
    const temporary = `${recordPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, recordPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed, or never written */ }
    }
  }

  function checkDaemonRecord() {
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (previous.version !== 1 || previous.home !== fs.realpathSync(codexHome)
        || !/^[a-f0-9]{64}$/.test(previous.fingerprint)
        || !Number.isFinite(previous.startedAt)) return 'daemon-record-invalid';
    } catch (err) {
      if (err.code !== 'ENOENT') return 'daemon-record-invalid';
    }
    let daemon = null;
    try {
      daemon = JSON.parse(fs.readFileSync(path.join(codexHome, 'app-server-daemon', 'daemon.pid'), 'utf8'));
      if (!Number.isInteger(daemon.pid) || daemon.pid <= 0
        || !Number.isFinite(daemon.processIdentity?.startSeconds)) return 'daemon-identity-invalid';
      try { process.kill(daemon.pid, 0); }
      catch (err) { if (err.code === 'ESRCH') daemon = null; else return 'daemon-identity-unavailable'; }
    } catch (err) {
      if (err.code !== 'ENOENT') return 'daemon-identity-invalid';
    }
    if (!daemon) {
      // Other daemon backends need their own identity verification. A live socket
      // without the PID backend's identity is not proof of a compatible server.
      if (fs.existsSync(path.join(codexHome, 'app-server-control', 'app-server-control.sock'))) return 'daemon-identity-unavailable';
      if (previous && !previous.identity && Date.now() - previous.startedAt < DAEMON_START_WINDOW_MS) {
        return previous.fingerprint === fingerprint ? null : 'daemon-start-pending';
      }
      save({ version: 1, home: fs.realpathSync(codexHome), fingerprint, startedAt: Date.now(), identity: null });
      return null;
    }
    if (!previous) return 'daemon-unrecognized';
    if (previous.fingerprint !== fingerprint) return 'daemon-settings-changed';
    const identity = stableJson(daemon);
    if (!previous.identity) {
      const start = daemon.processIdentity.startSeconds * 1000;
      if (start < Math.floor(previous.startedAt / 1000) * 1000
        || start > previous.startedAt + DAEMON_START_WINDOW_MS) return 'daemon-unrecognized';
      previous.identity = identity;
      save(previous);
    }
    return previous.identity === identity ? null : 'daemon-identity-changed';
  }
}

// Task App effort levels (low/medium/high/max, see task-agent/base-agent.js#resolveEffort)
// onto Codex's model_reasoning_effort. Task App calls its top level `max`; Codex calls it `xhigh`.
function toCodexEffort(level) {
  return level === 'max' ? 'xhigh' : level;
}

// No argument = the fixed terminal-task default when a task sets no effort. Objective chat
// passes config.OBJECTIVE_EFFORT explicitly so provider-specific names still go through mapping.
function codexEffortArgs(level = CODEX_REASONING_EFFORT) {
  return ['-c', `model_reasoning_effort="${level}"`];
}

// Legacy interactive consoles share immutable native homes without CLI overrides.
// Enforced permission modes use embedded sessions and authoritative CLI overrides.
function codexTerminalLaunchOptions(projectRoot, codexHome, level = CODEX_REASONING_EFFORT, env = null, policy = null) {
  const base = toml.parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  const overrides = codexPermissionOverrides(policy, base);
  const home = prepareCodexTerminalHome({ projectRoot, codexHome, effort: level, env: env || {}, overrides });
  if (policy?.enforced && policy.mode !== 'plan') {
    // An explicit embedded launch gives these overrides precedence over project-layer
    // config. Legacy shared-daemon launches retain their zero-override contract.
    const args = ['--no-daemon'];
    const effective = toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
    // Codex CLI dotted keys do not parse quoted TOML identifiers. Override each
    // whole affected table using the same serializer as scoped chat MCP configs.
    for (const key of new Set(Object.keys(overrides).map(key => key.split('.')[0]))) {
      args.push('-c', `${key}=${tomlValue(effective[key])}`);
    }
    return { args, mode: 'embedded', reason: `permission-${policy.mode}`, codexHome: home };
  }
  const terminalEnv = env && { ...env, CODEX_HOME: home };
  const parsed = toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  const reason = terminalEnv && terminalDaemonFallback(home, terminalEnv, parsed);
  // Effort already matches. Do not manufacture a config override just to force
  // isolation: use the native explicit mode switch and report the actual cause.
  if (reason) return { args: ['--no-daemon'], mode: 'embedded', reason, codexHome: home };
  return { args: [], mode: 'shared', reason: 'compatible-project-config', codexHome: home };
}

function codexTerminalEffortArgs(...args) {
  return codexTerminalLaunchOptions(...args).args;
}

/**
 * @param {object} opts
 * @param {string} [opts.projectRoot] - defaults to config.PROJECT_ROOT
 * @param {string} [opts.taskId] - task context for embedded headless turns only
 * @param {string} [opts.term] - 'dumb' (default, headless objective turns) or
 *   'xterm-256color' (interactive PTY terminal task spawns).
 * @returns {{ env: object }}
 */
function buildCodexEnv({ projectRoot, taskId, term = 'dumb' } = {}) {
  const root = projectRoot || config.PROJECT_ROOT;
  const serverRoot = config.SERVER_ROOT;
  const wrapperName = process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node';
  // projectEnvExtras() live-reads this project's .tipatask/config.json. Keep the MCP
  // bearer alias Codex-specific instead of adding it to CONFIG_FIELDS (which would
  // expose it to every agent provider). Explicitly delete an inherited alias when this
  // project has no token so a stale parent-process credential can never cross projects.
  const projectExtras = projectEnvExtras(root);
  const env = augmentPathEnv({ TERM: term, TIPATASK_SERVER_ROOT: serverRoot, ...projectExtras });
  if (projectExtras.API_TOKEN) env.TIPATASK_API_TOKEN = projectExtras.API_TOKEN;
  else {
    delete env.TIPATASK_API_TOKEN;
    delete env.API_TOKEN;
  }
  const nvmBinDir = resolveNvmBinDir(config.CODEX_BIN);
  if (nvmBinDir) {
    env.PATH = `${nvmBinDir}${path.delimiter}${env.PATH}`;
  }
  // The shared server keeps its startup environment for every thread. Task keys
  // belong in the terminal prompt/tool arguments, never in daemon-global state.
  // track-file-access.js is a Claude PostToolUse hook, not a Codex hook.
  for (const key of ['TIPATASK_TASK_ID', 'TIPATASK_TRACK_DIR', 'TIPATASK_OBJECTIVE_TASK_ID', 'TIPATASK_LOCAL_SECRET']) {
    delete env[key];
  }
  if (taskId && term === 'dumb') {
    env.TIPATASK_TASK_ID = taskId;
    env.TIPATASK_TRACK_DIR = path.join(config.USER_DATA_ROOT, '.file-tracks');
  }
  const prepared = ensureProjectCodexHome({
    projectRoot: root,
    mcpServerPath: path.join(serverRoot, 'src', 'mcp', 'server.js'),
    nodePath: path.join(serverRoot, 'bin', wrapperName),
  });
  env.CODEX_HOME = prepared.projectCodexDir;
  env.TIPATASK_CODEX_GLOBAL_HOME = prepared.globalCodexDir;
  return { env };
}

module.exports = { CODEX_REASONING_EFFORT, buildCodexEnv, codexEffortArgs, codexTerminalEffortArgs, codexTerminalLaunchOptions, terminalDaemonFallback, toCodexEffort, codexPermissionOverrides, policyToCodexConfig };
