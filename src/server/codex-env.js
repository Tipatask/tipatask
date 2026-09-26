'use strict';

// Shared Codex CLI spawn-env builder (C1029). Extracted from
// task-agent/codex-agent.js getSpawnSpec() so the objective-chat Codex provider
// (providers/codex-session.js) gets the exact same MCP wiring as the terminal Codex
// task agent for free — same refreshed Tipatask servers, same inherited user-level MCP
// servers, same project-scoped CODEX_HOME.
const path = require('node:path');
const config = require('./config');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir } = require('./spawn-utils');
const { ensureProjectCodexHome } = require('../codex-mcp-config');

const CODEX_REASONING_EFFORT = 'high';

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

/**
 * @param {object} opts
 * @param {string} [opts.projectRoot] - defaults to config.PROJECT_ROOT
 * @param {string} [opts.taskId] - when set, stamps TIPATASK_TASK_ID / TIPATASK_TRACK_DIR
 *   so the file-access-tracking hook attributes reads to this task (matches codex-agent.js).
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
  else delete env.TIPATASK_API_TOKEN;
  const nvmBinDir = resolveNvmBinDir(config.CODEX_BIN);
  if (nvmBinDir) {
    env.PATH = `${nvmBinDir}${path.delimiter}${env.PATH}`;
  }
  if (taskId) {
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

module.exports = { CODEX_REASONING_EFFORT, buildCodexEnv, codexEffortArgs, toCodexEffort };
