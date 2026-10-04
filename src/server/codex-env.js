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
const { ensureProjectCodexHome } = require('../codex-mcp-config');

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

// Interactive Codex cannot use its shared daemon with -c OR --profile. Keep a
// stable project default, never a last-spawn-wins task value in the shared file.
// A differing task effort must still use an override (and embedded mode).
function codexTerminalLaunchOptions(projectRoot, codexHome, level = CODEX_REASONING_EFFORT, env = null) {
  const embedded = reason => ({ args: codexEffortArgs(level), mode: 'embedded', reason });
  const configPath = path.join(codexHome, 'config.toml');
  let content = fs.readFileSync(configPath, 'utf8');
  const parsed = toml.parse(content);
  if (parsed.model_reasoning_effort === undefined) {
    content = `model_reasoning_effort = "${CODEX_REASONING_EFFORT}"\n${content}`;
    fs.writeFileSync(configPath, content, 'utf8');
    parsed.model_reasoning_effort = CODEX_REASONING_EFFORT;
  }
  // A project opened below a repository root can have higher-precedence ancestor
  // config. Retain the explicit override when that layering is not ours to manage.
  let dir = fs.realpathSync(projectRoot);
  while (!fs.existsSync(path.join(dir, '.git'))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, '.codex', 'config.toml'))) return embedded('ancestor-config');
  }
  if (parsed.model_reasoning_effort !== level) return embedded('effort-override');
  const reason = env && terminalDaemonFallback(codexHome, env, parsed);
  // Effort already matches. Do not manufacture a config override just to force
  // isolation: use the native explicit mode switch and report the actual cause.
  if (reason) return { args: ['--no-daemon'], mode: 'embedded', reason };
  return { args: [], mode: 'shared', reason: 'compatible-project-config' };
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
  const codexHome = ensureProjectCodexHome({
    projectRoot: root,
    mcpServerPath: path.join(serverRoot, 'src', 'mcp', 'server.js'),
    nodePath: path.join(serverRoot, 'bin', wrapperName),
  }).projectCodexDir;
  env.CODEX_HOME = codexHome;
  return { env };
}

module.exports = { CODEX_REASONING_EFFORT, buildCodexEnv, codexEffortArgs, codexTerminalEffortArgs, codexTerminalLaunchOptions, toCodexEffort };
