#!/usr/bin/env node
'use strict';

// Shell entry point for the same project-bound environment used by the desktop.
// Usage: <runtime> src/cli/launch-agent.js codex --project-root <dir> [CLI args...]
// Packaged installs use the Electron executable with ELECTRON_RUN_AS_NODE=1.
// No token is returned, printed, or written to a launch script.
const path = require('node:path');
const fs = require('node:fs');

function launch(argv = process.argv.slice(2), spawn = require('node:child_process').spawn) {
  const provider = argv.shift();
  if (!['claude', 'codex', 'pi'].includes(provider)) throw new Error('Choose claude, codex or pi; Gemini is supported only in objective chat.');
  const i = argv.indexOf('--project-root');
  const explicit = i >= 0 ? argv.splice(i, 2)[1] : null;
  if (i >= 0 && !explicit) throw new Error('--project-root needs a directory');
  const root = require('../server/project-root').resolveProjectRoot({ explicit });
  // Generated local MCP metadata is non-secret and records the installing app's
  // account-store location, including Electron's userData outside app.asar.
  let registration;
  try { registration = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')); }
  catch { throw new Error('Missing or malformed agent harness; run Refresh agent harness.'); }
  const local = registration.mcpServers?.['tipatask-local']?.env;
  if (!local?.TIPATASK_USER_DATA || !local?.TIPATASK_SERVER_ROOT) throw new Error('Refresh agent harness before shell launch.');
  process.env.TIPATASK_PROJECT_ROOT = root;
  process.env.TIPATASK_USER_DATA = local.TIPATASK_USER_DATA;
  process.env.TIPATASK_SERVER_ROOT = local.TIPATASK_SERVER_ROOT;
  const { getApiCredentials } = require('../server/api-credentials');
  const credentials = getApiCredentials(root);
  const { inspectToken } = require('../server/auth-guard');
  const verdict = inspectToken(credentials.token);
  if (!verdict.ok) throw new Error(`${verdict.reason} — sign in again.`);
  const { augmentPathEnv, projectEnvExtras, resolveBin } = require('../server/spawn-utils');
  let env = augmentPathEnv(projectEnvExtras(root));
  let command;
  let prefix = [];
  if (provider === 'codex') {
    env = require('../server/codex-env').buildCodexEnv({ projectRoot: root, term: 'xterm-256color' }).env;
    const launch = require('../server/codex-env').codexTerminalLaunchOptions(root, env.CODEX_HOME, undefined, env);
    prefix = launch.args;
    env.CODEX_HOME = launch.codexHome;
    command = resolveBin('codex');
  } else if (provider === 'pi') {
    const spec = require('../server/spawn-utils').resolvePiLaunch();
    if (spec) { command = spec.command; prefix = spec.argsPrefix; env = { ...env, ...spec.env }; }
  } else command = resolveBin('claude');
  if (!command) throw new Error(`${provider} CLI is unavailable`);
  const child = spawn(command, [...prefix, ...argv], { cwd: root, env, stdio: 'inherit' });
  child.on('error', () => { console.error(`${provider} could not start`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  return child;
}

if (require.main === module) {
  try { launch(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { launch };
