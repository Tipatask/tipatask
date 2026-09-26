'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CAVEMAN_CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'caveman', 'caveman');

// ANSI
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/**
 * Return the first existing plugin version dir (hash-named) under the caveman
 * cache, or null when the plugin is not installed.
 */
function findCavemanPluginDir() {
  try {
    const versions = fs.readdirSync(CAVEMAN_CACHE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (!versions.length) return null;
    return path.join(CAVEMAN_CACHE_DIR, versions[0]);
  } catch {
    return null;
  }
}

/**
 * Locate the statusline shell script inside a plugin version dir.
 */
function findStatuslineScript(pluginDir) {
  const candidate = path.join(pluginDir, 'hooks', 'caveman-statusline.sh');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Configure the caveman plugin's statusline in the parent project's
 * `.claude/settings.json`. Non-destructive: only adds `statusLine` key if
 * missing; leaves existing value alone unless force=true.
 *
 * @returns {{ configured: boolean, reason: string, path?: string }}
 */
function configureStatusline(projectRoot, { force = false } = {}) {
  const pluginDir = findCavemanPluginDir();
  if (!pluginDir) {
    return {
      configured: false,
      reason: 'caveman plugin not found at ~/.claude/plugins/cache/caveman/',
    };
  }

  const script = findStatuslineScript(pluginDir);
  if (!script) {
    return {
      configured: false,
      reason: `statusline script not found in ${pluginDir}`,
    };
  }

  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }

  if (settings.statusLine && !force) {
    return {
      configured: false,
      reason: 'statusLine already configured (pass --force to overwrite)',
      path: settingsPath,
    };
  }

  settings.statusLine = {
    type: 'command',
    command: `bash "${script}"`,
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return {
    configured: true,
    reason: 'caveman statusline configured',
    path: settingsPath,
  };
}

/**
 * Best-effort caveman plugin setup step. Prints friendly guidance; never throws.
 */
async function runCavemanPluginStep(projectRoot, { force = false } = {}) {
  let pluginDir = findCavemanPluginDir();
  let autoInstalled = false;

  if (!pluginDir) {
    try {
      const config = require('../server/config');
      console.log(`  ${DIM}Installing caveman plugin via Claude CLI...${RESET}`);
      execFileSync(config.CLAUDE_BIN, ['plugin', 'marketplace', 'add', 'JuliusBrussee/caveman'], { stdio: 'pipe' });
      execFileSync(config.CLAUDE_BIN, ['plugin', 'install', 'caveman@caveman'], { stdio: 'pipe' });
      pluginDir = findCavemanPluginDir();
      autoInstalled = !!pluginDir;
    } catch (err) {
      console.log(`  ${YELLOW}Caveman plugin auto-install failed: ${err.message}${RESET}`);
      console.log(`  ${YELLOW}Caveman plugin not detected.${RESET}`);
      console.log(`  ${DIM}Install from inside Claude Code:${RESET}`);
      console.log('    /plugin install caveman');
      console.log(`  ${DIM}Marketplace: https://github.com/anthropics/claude-code-plugins (or vendor source).${RESET}`);
      return { installed: false };
    }
  }

  if (!pluginDir) {
    console.log(`  ${YELLOW}Caveman plugin not detected after install attempt.${RESET}`);
    console.log(`  ${DIM}Install from inside Claude Code:${RESET}`);
    console.log('    /plugin install caveman');
    console.log(`  ${DIM}Marketplace: https://github.com/anthropics/claude-code-plugins (or vendor source).${RESET}`);
    return { installed: false };
  }

  console.log(`  ${GREEN}Caveman plugin${autoInstalled ? ' installed and' : ''} detected${RESET} ${DIM}(${pluginDir})${RESET}`);
  const res = configureStatusline(projectRoot, { force });
  if (res.configured) {
    console.log(`  ${GREEN}Statusline configured in .claude/settings.json${RESET}`);
  } else {
    console.log(`  ${DIM}Statusline: ${res.reason}${RESET}`);
  }
  return { installed: true, autoInstalled, statuslineConfigured: res.configured };
}

module.exports = {
  findCavemanPluginDir,
  findStatuslineScript,
  configureStatusline,
  runCavemanPluginStep,
};
