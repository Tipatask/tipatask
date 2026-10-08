'use strict';

const { execFileSync } = require('node:child_process');
const { resolveBin, clearBinCache, augmentPathEnv, prependPathEnv, resolveNvmBinDir, winExecSpec } = require('../server/spawn-utils');

/**
 * Probe `--version` output from a resolved binary path.
 * Runs under the nvm-matched node bin dir when applicable so shebang CLIs resolve.
 * A Windows `.cmd`/`.bat` launcher (npm's `claude.cmd`) runs through cmd.exe via
 * winExecSpec() — Node >= 22 refuses a shell-less exec of those with EINVAL.
 * Returns the trimmed version string, or null on failure.
 * @param {string} binPath
 * @returns {string|null}
 */
function _probeVersion(binPath) {
  try {
    // prependPathEnv keeps the env at one PATH key (TPT566) — never `env.PATH = …`.
    const env = prependPathEnv(augmentPathEnv({}), resolveNvmBinDir(binPath));
    const spec = winExecSpec(binPath, ['--version']);
    const out = execFileSync(spec.command, spec.args, {
      ...spec.options, encoding: 'utf8', timeout: 5000, env, windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Detect the Claude CLI.
 * @returns {{ found: boolean, path: string|null, version: string|null }}
 */
function detectClaudeCliPath() {
  const binPath = resolveBin('claude');
  if (!binPath) return { found: false, path: null, version: null };
  return { found: true, path: binPath, version: _probeVersion(binPath) };
}

/**
 * Detect the Codex CLI.
 * @returns {{ found: boolean, path: string|null, version: string|null }}
 */
function detectCodexPath() {
  const binPath = resolveBin('codex');
  if (!binPath) return { found: false, path: null, version: null };
  return { found: true, path: binPath, version: _probeVersion(binPath) };
}

/**
 * Detect both CLIs in one call.
 * @param {{ force?: boolean }} [opts] - force:true busts resolveBin's _binCache
 *   for both 'claude' and 'codex' before probing, so newly-installed agents are
 *   found even when a prior null result was cached (e.g. Re-check in first-run wizard).
 * @returns {{ claude: { found, path, version }, codex: { found, path, version } }}
 */
function detectCli({ force = false } = {}) {
  if (force) {
    clearBinCache('claude');
    clearBinCache('codex');
  }
  return {
    claude: detectClaudeCliPath(),
    codex: detectCodexPath(),
  };
}

module.exports = { detectClaudeCliPath, detectCodexPath, detectCli };
