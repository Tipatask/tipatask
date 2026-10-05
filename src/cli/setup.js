#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { selectProject, selectAgent, selectFromItems, multiSelect, createProject, confirm, prompt, drawSplash } = require('./prompts');
const { request } = require('./http');
const { syncOnSessionStart, pushAll, pullArchitectureDocs, pushArchitectureDocs } = require('./knowledge-sync');
const {
  readProjectConfig,
  writeProjectConfig,
  migrateFromLegacy,
  API_CREDENTIAL_FIELDS,
  CONFIG_FIELDS,
  writeProjectMcpConfig,
  writeProjectClaudeMcpApproval,
} = require('../server/project-config');
const { readAccount } = require('../server/account-store');
const {
  TIPATASK_MCP_NAME,
  ensureProjectCodexHome,
  buildCodexMcpSection,
  buildCodexLocalMcpSection,
} = require('../codex-mcp-config');
const { resolveProjectRoot } = require('../server/project-root');

const pkg = require('../../package.json');

const DEVICE_ID_DIR = path.join(os.homedir(), '.tipatask');
const DEVICE_ID_PATH = path.join(DEVICE_ID_DIR, 'device_id');

const ENV_PATH = path.resolve(__dirname, '../../.env');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../.env.example');
// Mirror of src/client/constants.js DEFAULT_API_BASE_URL — that file is ESM
// (the browser bundle) and this one is CJS, so the literal is duplicated.
const DEFAULT_API_URL = 'https://web.tipatask.com';
// The project being set up: --project-root, else TIPATASK_PROJECT_ROOT, else the nearest
// ancestor of cwd holding .tipatask/config.json, else cwd. Never derived from where this
// checkout lives — the Task App is a standalone repo that can be cloned anywhere.
function projectRootFromArgv(argv) {
  const i = argv.indexOf('--project-root');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const PROJECT_ROOT = resolveProjectRoot({ explicit: projectRootFromArgv(process.argv) });

// ANSI helpers
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Minimum Claude Code version required by Tipatask
// (needs --permission-mode plan, --output-format stream-json,
//  --append-system-prompt, --exclude-dynamic-system-prompt-sections)
const CLAUDE_MIN_VERSION = [1, 0, 0];

function parseClaudeVersion(str) {
  if (!str) return null;
  const m = str.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

function versionAtLeast(v, min) {
  if (!v) return null; // unknown
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * Synchronous Claude health check — runs before the splash is drawn.
 * Auto-fixes the node-pty spawn-helper execute bit on macOS if possible.
 * Returns { ok, binPath, version, versionOk, loggedIn, spawnHelperFixed, issues }
 */
function checkClaudeHealth() {
  const { resolveBin } = require('../server/spawn-utils');
  const issues = [];

  // 1. Binary
  const binPath = resolveBin('claude');
  if (!binPath) {
    return {
      ok: false, binPath: null, version: null, versionOk: null, loggedIn: false,
      spawnHelperFixed: false,
      issues: [{ severity: 'error', msg: 'Claude CLI not found', fix: 'Install Claude Code: https://claude.ai/download' }],
    };
  }

  // 2. Version (best-effort)
  let version = null;
  let versionOk = null;
  try {
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    version = parseClaudeVersion(out);
    versionOk = versionAtLeast(version, CLAUDE_MIN_VERSION);
    if (versionOk === false) {
      issues.push({
        severity: 'warn',
        msg: `Claude v${version.join('.')} may be too old (need ≥${CLAUDE_MIN_VERSION.join('.')})`,
        fix: 'Run: claude update',
      });
    }
  } catch { /* non-fatal — version unknown */ }

  // 3. Auth status
  let loggedIn = false;
  try {
    const out = execFileSync(binPath, ['auth', 'status'], { encoding: 'utf8', timeout: 5000 }).trim();
    try {
      loggedIn = !!JSON.parse(out).loggedIn;
    } catch {
      loggedIn = !(/loggedIn.*?false/i.test(out));
    }
  } catch { /* non-fatal */ }
  if (!loggedIn) {
    issues.push({ severity: 'error', msg: 'Claude not logged in', fix: 'Run: claude auth login' });
  }

  // 4. node-pty spawn-helper permissions (macOS + Linux) — auto-fix if possible.
  // Checks both electron-rebuild output (build/Release/) and arch-specific prebuild;
  // Windows uses ConPTY so no spawn-helper needed there.
  let spawnHelperFixed = false;
  if (process.platform !== 'win32') {
    const platformDir = `${process.platform}-${process.arch}`;
    const candidates = [
      path.join(__dirname, '../../node_modules/node-pty/build/Release/spawn-helper'),
      path.join(__dirname, '../../node_modules/node-pty/prebuilds', platformDir, 'spawn-helper'),
    ];
    for (const helperPath of candidates) {
      if (!fs.existsSync(helperPath)) continue;
      let executable = false;
      try { fs.accessSync(helperPath, fs.constants.X_OK); executable = true; } catch {}
      if (!executable) {
        try {
          fs.chmodSync(helperPath, 0o755);
          spawnHelperFixed = true;
        } catch {
          issues.push({
            severity: 'error',
            msg: `PTY helper not executable (${helperPath})`,
            fix: `chmod +x ${helperPath}`,
          });
        }
      }
    }
  }

  const errors = issues.filter(i => i.severity === 'error');
  return { ok: errors.length === 0, binPath, version, versionOk, loggedIn, spawnHelperFixed, issues };
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {
    templatesOnly: false,
    skipInstall: false,
    skipDiscover: false,
    force: false,
    dryRun: false,
    projectRoot: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--templates-only': flags.templatesOnly = true; break;
      case '--skip-install':   flags.skipInstall = true; break;
      case '--skip-discover':  flags.skipDiscover = true; break;
      case '--force':          flags.force = true; break;
      case '--dry-run':        flags.dryRun = true; break;
      case '--project-root':   flags.projectRoot = argv[++i]; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.warn(`  ${YELLOW}Unknown flag: ${arg}${RESET}`);
        }
    }
  }
  return flags;
}

function printUsage() {
  console.log(`
  Tipatask Setup — install infra templates + configure MCP for a project

  Usage: tipatask-setup [flags]

  Flags:
    --templates-only      Skip auth/project flow; only install templates + MCP config
    --skip-install        Run auth/project flow but don't install templates (legacy)
    --skip-discover       Don't offer discovery after install
    --force               Overwrite user-modified files
    --dry-run             Print planned actions, don't write
    --project-root <path> Override auto-detected project root
    -h, --help            Print this help

  Interactive prompts (in order after MCP config):
    Seed agent setup tasks (CLAUDE.md / AGENTS.md / GENERAL.md)
    Seed architecture docs from project scan (discovery)
    Import tasks from existing TODO.md
  `);
}

// ---------------------------------------------------------------------------
// Local config helpers
// ---------------------------------------------------------------------------

/**
 * Read .env file into { lines, values }. API credentials are overlaid from
 * .tipatask/config.json, their only persistent source.
 * If file is missing, copies from .env.example or starts empty.
 */
function readEnv(filePath, projectRoot = PROJECT_ROOT, { readOnly = false } = {}) {
  const isMainEnv = path.resolve(filePath) === path.resolve(ENV_PATH);
  if (isMainEnv && !readOnly) migrateFromLegacy(projectRoot);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Try to copy from .env.example
    try {
      content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
      if (!readOnly && (!isMainEnv || path.resolve(projectRoot) === PROJECT_ROOT)) {
        fs.writeFileSync(filePath, content, 'utf8');
      }
    } catch {
      content = '';
    }
  }

  const lines = content.split('\n');
  const values = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    values[key] = val;
  }

  if (isMainEnv) {
    const projectConfig = readProjectConfig(projectRoot) || {};
    for (const key of API_CREDENTIAL_FIELDS) delete values[key];
    for (const key of [...API_CREDENTIAL_FIELDS, ...CONFIG_FIELDS, 'TASK_AGENT', 'AVAILABLE_AGENTS', 'DEVICE_ID', 'DEVICE_NAME']) {
      if (Object.prototype.hasOwnProperty.call(projectConfig, key)) {
        values[key] = projectConfig[key];
      }
    }
    // The token is the signed-in account's, held in the app-level account store.
    const account = readAccount(values.API_BASE_URL);
    if (account) values.API_TOKEN = account.token;
    try { require('../server/account-store').assertTokenProject(values.API_TOKEN, values.API_PROJECT_ID); }
    catch { values.API_TOKEN = ''; }
  }

  return { lines, values };
}

/**
 * Update local config. Non-credential settings remain in .env. API credentials
 * are merge-written to .tipatask/config.json and removed from .env.
 */
function writeEnv(filePath, lines, updates, projectRoot = PROJECT_ROOT) {
  const isMainEnv = path.resolve(filePath) === path.resolve(ENV_PATH);
  if (isMainEnv && path.resolve(projectRoot) !== PROJECT_ROOT) {
    writeProjectConfig(projectRoot, { ...(readProjectConfig(projectRoot) || {}), ...updates });
    return;
  }
  const credentialKeys = new Set(API_CREDENTIAL_FIELDS);
  const envUpdates = {};
  const credentialUpdates = {};
  for (const [key, val] of Object.entries(updates)) {
    if (isMainEnv && credentialKeys.has(key)) credentialUpdates[key] = val;
    else envUpdates[key] = val;
  }

  if (Object.keys(credentialUpdates).length > 0) {
    const current = readProjectConfig(projectRoot) || {};
    writeProjectConfig(projectRoot, { ...current, ...credentialUpdates });
  }

  const handled = new Set();
  const updated = lines.flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [line];
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return [line];
    const key = trimmed.slice(0, eqIdx).trim();
    if (isMainEnv && credentialKeys.has(key)) return [];
    if (key in envUpdates) {
      handled.add(key);
      return [`${key}=${envUpdates[key]}`];
    }
    return [line];
  });

  // Append keys not already in file
  for (const [key, val] of Object.entries(envUpdates)) {
    if (!handled.has(key)) {
      updated.push(`${key}=${val}`);
    }
  }

  // Ensure file ends with a newline
  const result = updated.join('\n');
  fs.writeFileSync(filePath, result.endsWith('\n') ? result : result + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// MCP configuration
// ---------------------------------------------------------------------------

// C1382 — 'tipatask' points at the remote Streamable HTTP endpoint (17 tools) instead of
// spawning the stdio server directly; 'tipatask-local' keeps the 4 tools that need a repo
// checkout (batch_grep_tags, push_knowledge, pull_knowledge, git_worktree_status) — see
// TIPATASK_MCP_LOCAL_ONLY in src/mcp/server.js. Both entries are written by the same
// writeProjectMcpConfig() the desktop app uses, with absolute paths into THIS checkout —
// there is no project-relative layout to assume.
function configureMcpServers({ projectRoot = PROJECT_ROOT, dryRun = false } = {}) {
  if (dryRun) return;
  const serverRoot = path.resolve(__dirname, '../..');
  const errors = [];
  let codexHome;
  const attempt = fn => { try { return fn(); } catch (err) { errors.push(err.message); } };
  attempt(() => writeProjectMcpConfig(projectRoot, serverRoot));
  attempt(() => writeProjectClaudeMcpApproval(projectRoot));
  codexHome = attempt(() => ensureProjectCodexHome({
    projectRoot,
    mcpServerPath: path.join(serverRoot, 'src/mcp/server.js'),
    nodePath: path.join(serverRoot, 'bin', process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node'),
  }));
  if (errors.length) throw new Error([...new Set(errors)].join('; '));
  return codexHome;
}

// ---------------------------------------------------------------------------
// Template installation
// ---------------------------------------------------------------------------

function buildPlaceholders(projectRoot, env) {
  let projectName = path.basename(projectRoot);
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const parentPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (parentPkg && parentPkg.name) projectName = parentPkg.name;
  } catch { /* fall back to dir basename */ }
  try {
    const cargoPath = path.join(projectRoot, 'Cargo.toml');
    const cargoRaw = fs.readFileSync(cargoPath, 'utf8');
    const match = cargoRaw.match(/\[package\][^[]*?\bname\s*=\s*"([^"]+)"/);
    if (match && projectName === path.basename(projectRoot)) {
      projectName = match[1];
    }
  } catch { /* no Cargo.toml, fine */ }

  // This checkout's root, absolute — this file lives at <checkout>/src/cli/setup.js.
  // buildHarnessPlaceholders() keeps the path relative when the checkout sits inside the
  // project being set up (so a git-tracked .claude/settings.json carries no machine-specific
  // absolute path) and absolute otherwise.
  const serverRootAbs = path.resolve(__dirname, '../..');
  const { buildHarnessPlaceholders } = require('./install-templates');

  return {
    ...buildHarnessPlaceholders(projectRoot, serverRootAbs),
    PROJECT_NAME: projectName,
    API_BASE_URL: (env && env.values && env.values.API_BASE_URL) || '',
    STACK_SUMMARY: '',
    DIR_TABLE: '',
    ENV_TABLE: '',
    SETUP_COMMANDS: '',
    DB_NOTES: '',
    COMMANDS_TABLE: '',
  };
}

async function runInstallTemplates(flags, env) {
  const projectRoot = flags.projectRoot
    ? path.resolve(flags.projectRoot)
    : PROJECT_ROOT;
  const placeholders = buildPlaceholders(projectRoot, env);

  console.log(`\n  ${DIM}Installing templates into ${projectRoot}${RESET}`);
  if (flags.dryRun) {
    console.log(`  ${YELLOW}(dry-run — no files will be written)${RESET}`);
  }

  const { installTemplates } = require('./install-templates');
  const report = await installTemplates({
    projectRoot,
    placeholders,
    force: flags.force,
    dryRun: flags.dryRun,
    packageVersion: pkg.version || '0.0.0',
  });

  if (report.written.length) {
    console.log(`  ${GREEN}Installed:${RESET}`);
    for (const entry of report.written) {
      console.log(`    + ${entry.path}${entry.reason ? `  ${DIM}(${entry.reason})${RESET}` : ''}`);
    }
  }
  if (report.merged.length) {
    console.log(`  ${GREEN}Merged:${RESET}`);
    for (const entry of report.merged) {
      console.log(`    ~ ${entry.path}`);
    }
  }
  if (report.skipped.length) {
    console.log(`  ${YELLOW}Skipped:${RESET}`);
    for (const entry of report.skipped) {
      console.log(`    ! ${entry.path}  ${DIM}(${entry.reason})${RESET}`);
    }
  }
  if (report.warnings.length) {
    for (const msg of report.warnings) {
      console.log(`  ${YELLOW}warn:${RESET} ${msg}`);
    }
  }

  return { projectRoot, report };
}

// ---------------------------------------------------------------------------
// Extracted sub-command runners
// ---------------------------------------------------------------------------

/**
 * OAuth + device registration step.
 * Returns { token, user, device, apiBaseUrl }.
 */
async function runAuthStep({ env, machineId }) {
  const apiBaseUrl = (await prompt(`  API base URL`, env.values.API_BASE_URL || DEFAULT_API_URL)).replace(/\/+$/, '');

  const { authenticate } = require('./auth');
  const { token, user } = await authenticate(apiBaseUrl);
  console.log(`\n  ${GREEN}Authenticated as ${user.name || user.email}${RESET}`);
  if (user.name && user.email) {
    console.log(`  ${DIM}(${user.email})${RESET}`);
  }

  let device;
  const devRes = await request(`${apiBaseUrl}/api/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const devices = (devRes.data && devRes.data.devices) || [];
  const existing = devices.find(d => d.machine_id === machineId);

  if (existing) {
    console.log(`\n  Device: '${existing.name}' detected.`);
    const reuse = await confirm('  Use this device name?');
    if (reuse) {
      device = existing;
    }
  }

  if (!device) {
    const deviceName = await prompt('  Device name', os.hostname());
    const regRes = await request(`${apiBaseUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { name: deviceName, machine_id: machineId },
    });
    if (regRes.status >= 400) {
      throw new Error(`Failed to register device: ${JSON.stringify(regRes.data)}`);
    }
    device = regRes.data.device || regRes.data;
  }

  console.log(`  ${GREEN}Device: ${device.name} (${device.id})${RESET}`);
  return { token, user, device, apiBaseUrl };
}

/**
 * Discovery step. Calls runDiscovery unconditionally.
 */
async function runDiscoveryStep({ projectRoot, apiBaseUrl, token, projectId }) {
  const { runDiscovery } = require('./discover');
  await runDiscovery({ projectRoot, apiBaseUrl, token, projectId });
}

/**
 * KB sync step. Pulls remote changes then pushes all local KB files.
 * Non-fatal: errors are logged as warnings.
 */
async function runKbSyncStep({ projectRoot, apiBaseUrl, token, projectId }) {
  let archPullReport = { pulled: [], merged: [], skipped: [] };
  try {
    archPullReport = await pullArchitectureDocs(apiBaseUrl, projectId, token, projectRoot);
  } catch (err) {
    console.log(`  ${YELLOW}Architecture pull skipped: ${err.message}${RESET}`);
  }
  try {
    const { remoteIsEmpty, pulledCount } = await syncOnSessionStart(apiBaseUrl, projectId, token, projectRoot);
    const totalPulled = archPullReport.pulled.length + archPullReport.merged.length + pulledCount;
    if (remoteIsEmpty && totalPulled === 0) {
      console.log(`  ${DIM}Remote KB is new — pushing local KB to API...${RESET}`);
    } else {
      console.log(`  ${GREEN}KB pull complete${RESET} ${DIM}(${totalPulled} updated)${RESET}`);
      if (archPullReport.merged.length) {
        console.log(`  ${DIM}  merged: ${archPullReport.merged.map(k => k.replace('ai/architecture/', '')).join(', ')}${RESET}`);
      }
    }
  } catch (err) {
    console.log(`  ${YELLOW}KB pull skipped: ${err.message}${RESET}`);
  }

  let archPushReport = { pushed: [], skipped: [] };
  try {
    archPushReport = await pushArchitectureDocs(apiBaseUrl, projectId, token, projectRoot);
  } catch (err) {
    console.log(`  ${YELLOW}Architecture push skipped: ${err.message}${RESET}`);
  }
  try {
    await pushAll(apiBaseUrl, projectId, token, projectRoot);
    console.log(`  ${GREEN}KB push complete${RESET} ${DIM}(${archPushReport.pushed.length} tt-*.md pushed, ${archPushReport.skipped.length} skipped)${RESET}`);
  } catch (err) {
    console.log(`  ${YELLOW}KB push skipped: ${err.message}${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Agent config sync
// ---------------------------------------------------------------------------

/**
 * Fetch the device record from the API, compute union of local + remote agent
 * lists, update the API device and write merged non-secret values back to .env.
 * Non-fatal: API errors are logged as DIM warnings and setup continues.
 */
async function runSyncSetupStep({ env, apiBaseUrl, token, deviceId, projectRoot = PROJECT_ROOT,
  dryRun = false, requestFn = request, deviceIdPath = DEVICE_ID_PATH,
  envPath = path.resolve(projectRoot) === PROJECT_ROOT ? ENV_PATH : null }) {
  const { refreshHarnessTemplates } = require('./install-templates');
  const report = refreshHarnessTemplates(projectRoot, path.resolve(__dirname, '../..'), { dryRun });
  for (const entry of [...report.written, ...report.merged]) console.log(`  ${dryRun ? 'Would refresh' : 'Refreshed'} ${entry.path}`);
  for (const entry of report.skipped) console.log(`  Preserved ${entry.path}: ${entry.reason}`);
  for (const warning of report.warnings) console.warn(`  ${warning}`);
  if (dryRun) return { harness: report, dryRun: true };
  try { configureMcpServers({ projectRoot }); }
  catch (err) { report.warnings.push(`MCP refresh failed: ${err.message}`); console.warn(report.warnings.at(-1)); }

  // The selected project's configuration wins over stale shared-install settings.
  const currentConfig = readProjectConfig(projectRoot);
  const values = { ...env.values, ...(currentConfig || {}) };
  if (currentConfig) {
    apiBaseUrl = currentConfig.API_BASE_URL;
    token = readAccount(currentConfig.API_BASE_URL)?.token || currentConfig.API_TOKEN;
    deviceId = currentConfig.DEVICE_ID;
  }
  let machineId;
  try {
    machineId = fs.readFileSync(deviceIdPath, 'utf8').trim();
  } catch {
    console.log(`  ${DIM}Sync: local device_id missing — skipping device upsert.${RESET}`);
  }

  const localAgents = (values.AVAILABLE_AGENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  let remoteAgents = [];
  let remoteTaskAgent = '';
  let remoteName   = values.DEVICE_NAME || '';
  if (deviceId && apiBaseUrl && token) {
    try {
      const { status, data } = await requestFn(`${apiBaseUrl}/api/devices/${deviceId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5000,
      });
      if (status === 200 && data && data.device) {
        const d = data.device;
        remoteTaskAgent = d.task_agent || '';
        remoteAgents = (d.available_agents || '').split(',').map(s => s.trim()).filter(Boolean);
        if (d.name) remoteName = d.name;
      } else {
        console.log(`  ${DIM}Sync: GET /api/devices/${deviceId} returned ${status} — using local config only.${RESET}`);
      }
    } catch (err) {
      console.log(`  ${DIM}Sync: could not reach API (${err.message}) — using local config only.${RESET}`);
    }
  }

  const merged = [...new Set([...localAgents, ...remoteAgents])];
  if (merged.length === 0) {
    console.log(`  ${DIM}Sync: no agent info available — nothing to merge.${RESET}`);
    return { harness: report };
  }

  const localTaskAgent = values.TASK_AGENT || '';
  const taskAgent = merged.includes(localTaskAgent)
    ? localTaskAgent
    : (merged.includes(remoteTaskAgent) ? remoteTaskAgent : merged[0]);

  // Push merged config to API (upsert by machine_id)
  if (machineId && apiBaseUrl && token) {
    try {
      const { status } = await requestFn(`${apiBaseUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          name: remoteName || values.DEVICE_NAME || os.hostname(),
          machine_id: machineId,
          available_agents: merged.join(','),
          task_agent: taskAgent,
        },
      });
      if (status >= 400) {
        console.log(`  ${DIM}Sync: POST /api/devices returned ${status} — API not updated.${RESET}`);
      } else {
        console.log(`  ${GREEN}Agent config synced to API${RESET}`);
      }
    } catch (err) {
      console.log(`  ${DIM}Sync: could not update API (${err.message}).${RESET}`);
    }
  }

  const updates = { AVAILABLE_AGENTS: merged.join(','), TASK_AGENT: taskAgent };
  if (currentConfig) writeProjectConfig(projectRoot, { ...currentConfig, ...updates });
  if (envPath) {
    const envReloaded = readEnv(envPath, projectRoot);
    writeEnv(envPath, envReloaded.lines, updates, projectRoot);
  }
  console.log(`  ${GREEN}AVAILABLE_AGENTS=${merged.join(',')}  TASK_AGENT=${taskAgent}${RESET}`);
  return { harness: report, agents: merged, taskAgent };
}

// ---------------------------------------------------------------------------
// State analysis + new sub-command runners
// ---------------------------------------------------------------------------

function inspectHarnessConfiguration(projectRoot) {
  const serverRoot = path.resolve(__dirname, '../..');
  const cfg = readProjectConfig(projectRoot);
  const checks = [
    ['.mcp.json', JSON.parse, value => value.mcpServers?.tipatask?.type === 'http'
      && value.mcpServers?.tipatask?.url === (cfg?.API_BASE_URL && cfg?.API_PROJECT_ID
        ? `${String(cfg.API_BASE_URL).replace(/\/+$/, '')}/api/projects/${encodeURIComponent(cfg.API_PROJECT_ID)}/mcp`
        : '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp')
      && !!value.mcpServers?.tipatask?.headersHelper
      && value.mcpServers?.tipatask?.headers?.Authorization === ''
      && value.mcpServers?.['tipatask-local']?.env?.TIPATASK_MCP_LOCAL_ONLY === '1'],
    ['.claude/settings.local.json', JSON.parse, value => ['tipatask', 'tipatask-local'].every(name =>
      value.enabledMcpjsonServers?.includes(name)) && (!cfg || API_CREDENTIAL_FIELDS.every(key =>
      value.env?.[key] === (key === 'API_TOKEN'
        ? ''
        : String(cfg[key] ?? ''))))],
    ['.codex/config.toml', require('toml').parse, value => {
      const opts = { projectRoot, mcpServerPath: path.join(serverRoot, 'src/mcp/server.js') };
      const parse = require('toml').parse;
      const remote = parse(buildCodexMcpSection(opts).sectionLines.join('\n')).mcp_servers.tipatask;
      const local = parse(buildCodexLocalMcpSection(opts).sectionLines.join('\n')).mcp_servers['tipatask-local'];
      return value.mcp_servers?.tipatask?.url === remote.url
        && value.mcp_servers?.tipatask?.bearer_token_env_var === remote.bearer_token_env_var
        && !value.mcp_servers?.tipatask?.http_headers?.Authorization
        && value.mcp_servers?.['tipatask-local']?.command === local.command
        && JSON.stringify(value.mcp_servers?.['tipatask-local']?.env) === JSON.stringify(local.env);
    }],
  ];
  return checks.map(([file, parse, matches]) => {
    try {
      const value = parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
      return { path: file, status: value && matches(value) ? 'current' : 'outdated' };
    } catch (err) {
      return { path: file, status: err.code === 'ENOENT' ? 'missing' : 'invalid' };
    }
  });
}

/**
 * Check token validity and KB presence for the state-aware splash + menu.
 * @returns {{ hasToken, tokenValid, hasKb, user, deviceName, projectId }}
 */
async function analyzeSetupState(env, projectRoot, { requestFn = request } = {}) {
  const hasToken = !!env.values.API_TOKEN;
  let tokenValid = false;
  let user = null;
  if (hasToken && env.values.API_BASE_URL) {
    try {
      const { status, data } = await requestFn(`${env.values.API_BASE_URL}/api/auth/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.values.API_TOKEN}` },
        timeoutMs: 4000,
      });
      if (status === 200) { tokenValid = true; user = (data && data.user) || null; }
    } catch { /* network error → tokenValid stays false */ }
  }

  const archDir = path.join(projectRoot, 'ai', 'architecture');
  let hasKb = fs.existsSync(path.join(projectRoot, 'AGENTS.md'))
           || fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))
           || fs.existsSync(path.join(archDir, 'GENERAL.md'));
  if (!hasKb) {
    try {
      hasKb = fs.readdirSync(archDir).some(f => /^tt-.*\.md$/.test(f));
    } catch { /* no archDir */ }
  }

  return {
    harness: require('./install-templates').refreshHarnessTemplates(projectRoot, path.resolve(__dirname, '../..'), { dryRun: true }),
    harnessConfiguration: inspectHarnessConfiguration(projectRoot),
    hasToken,
    tokenValid,
    hasKb,
    user,
    deviceName: env.values.DEVICE_NAME || null,
    projectId:  env.values.API_PROJECT_ID || null,
  };
}

/**
 * Rename the current device by re-upserting via POST /api/devices (updates name on machine_id conflict).
 */
async function runChangeDeviceNameStep({ env, projectRoot = PROJECT_ROOT }) {
  const { API_BASE_URL, API_TOKEN, DEVICE_ID, DEVICE_NAME } = env.values;
  if (!API_BASE_URL || !API_TOKEN || !DEVICE_ID) {
    console.error(`\n  ${YELLOW}Missing device config. Run Full setup first.${RESET}\n`);
    process.exit(1);
  }
  let machineId;
  try {
    machineId = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
  } catch {
    console.error(`\n  ${YELLOW}Local device id missing (${DEVICE_ID_PATH}). Run Full setup.${RESET}\n`);
    process.exit(1);
  }

  const newName = await prompt('  New device name', DEVICE_NAME || os.hostname());
  if (!newName || newName === DEVICE_NAME) {
    console.log('\n  No change.\n');
    return;
  }

  const { status, data } = await request(`${API_BASE_URL}/api/devices`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: { name: newName, machine_id: machineId },
  });
  if (status >= 400) {
    throw new Error(`Failed to update device: ${JSON.stringify(data)}`);
  }

  const device = data.device || data;
  writeEnv(ENV_PATH, env.lines, { DEVICE_NAME: device.name, DEVICE_ID: String(device.id) }, projectRoot);
  console.log(`\n  ${GREEN}Device renamed to '${device.name}'.${RESET}\n`);
}

// ---------------------------------------------------------------------------
// Reusable async API helpers (exported; no interactive prompts)
// ---------------------------------------------------------------------------

/**
 * Look up an existing device by machineId or register a new one.
 * Returns the device record.
 */
async function registerDevice({ apiBaseUrl, token, machineId, name }) {
  const devRes = await request(`${apiBaseUrl}/api/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const devices = (devRes.data && devRes.data.devices) || [];
  const existing = devices.find(d => d.machine_id === machineId);
  if (existing) return existing;

  const regRes = await request(`${apiBaseUrl}/api/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { name, machine_id: machineId },
  });
  if (regRes.status >= 400) {
    throw new Error(`Failed to register device: ${JSON.stringify(regRes.data)}`);
  }
  return regRes.data.device || regRes.data;
}

/**
 * Create a new API project and return the project record.
 */
async function createApiProject({ apiBaseUrl, token, name, description }) {
  const { status, data } = await request(`${apiBaseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { name, description: description || undefined },
  });
  if (status >= 400) {
    throw new Error(`Failed to create project: ${JSON.stringify(data)}`);
  }
  return data.project || data;
}

/**
 * Associate a device with a project.
 */
async function associateDeviceProject({ apiBaseUrl, token, deviceId, projectId }) {
  await request(`${apiBaseUrl}/api/devices/${deviceId}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { project_id: projectId },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv);

  const projectRoot = flags.projectRoot ? path.resolve(flags.projectRoot) : PROJECT_ROOT;
  const initialEnv = readEnv(ENV_PATH, projectRoot, { readOnly: flags.dryRun });
  if (flags.dryRun) {
    await runInstallTemplates(flags, initialEnv);
    console.log('  MCP and environment refresh skipped (dry-run).');
    return;
  }
  const [state, claudeHealth] = await Promise.all([
    analyzeSetupState(initialEnv, projectRoot),
    Promise.resolve(checkClaudeHealth()),
  ]);

  const tokenLine = !state.hasToken
    ? `${DIM}Token:${RESET}   ${YELLOW}✗ missing${RESET}`
    : state.tokenValid
      ? `${DIM}Token:${RESET}   ${GREEN}✓ valid${RESET}`
      : `${DIM}Token:${RESET}   ${YELLOW}✗ invalid${RESET}`;
  const kbLine     = `${DIM}KB:${RESET}      ${state.hasKb ? GREEN + '✓ present' : YELLOW + '✗ missing'}${RESET}`;
  const deviceLine = `${DIM}Device:${RESET}  ${state.deviceName || '—'}`;
  const projLine   = `${DIM}Project:${RESET} ${state.projectId  || '—'}`;

  const claudeLine = (() => {
    if (!claudeHealth.binPath) return `${DIM}Claude:${RESET}  ${RED}✗ not found${RESET}`;
    const v = claudeHealth.version ? ` v${claudeHealth.version.join('.')}` : '';
    const authStr = claudeHealth.loggedIn ? '' : `  ${YELLOW}✗ not logged in${RESET}`;
    const vWarn = claudeHealth.versionOk === false ? `  ${YELLOW}⚠ may be too old${RESET}` : '';
    const color = claudeHealth.ok ? GREEN : YELLOW;
    return `${DIM}Claude:${RESET}  ${color}${claudeHealth.ok ? '✓' : '✗'}${v}${RESET}${authStr}${vWarn}`;
  })();

  drawSplash([
    `${BOLD}Tip${CYAN}Δ${RESET}${BOLD}Task${RESET}  ${DIM}v${pkg.version}${RESET}`,
    tokenLine, kbLine, claudeLine, deviceLine, projLine,
    `Harness: ${state.harness.written.length + state.harness.merged.length + state.harnessConfiguration.filter(c => c.status !== 'current').length} refreshable, ${state.harness.skipped.length} preserved`,
  ]);

  // Print actionable notices for any Claude issues
  if (claudeHealth.spawnHelperFixed) {
    console.log(`  ${YELLOW}⚠ PTY helper: auto-fixed execute permission (${process.platform}-${process.arch}/spawn-helper)${RESET}`);
    console.log(`  ${DIM}  This prevented task terminals from spawning. Permanent fix: npm install (in the Task App checkout)${RESET}`);
  }
  for (const issue of claudeHealth.issues) {
    const icon = issue.severity === 'error' ? `${RED}✗` : `${YELLOW}⚠`;
    console.log(`  ${icon} ${issue.msg}${RESET}`);
    if (issue.fix) console.log(`    ${DIM}→ ${issue.fix}${RESET}`);
  }
  if (claudeHealth.issues.length > 0) console.log('');

  // --templates-only: skip auth / project / env flow, just install templates + MCP
  if (flags.templatesOnly) {
    const env = initialEnv;
    const { projectRoot: tplRoot } = await runInstallTemplates(flags, env);
    if (!flags.dryRun) {
      configureMcpServers({ projectRoot: tplRoot, dryRun: flags.dryRun });
      console.log(`  ${GREEN}MCP configured for Claude and Codex${RESET}`);
      try {
        const { runCavemanPluginStep } = require('./plugin-install');
        await runCavemanPluginStep(tplRoot, { force: flags.force });
      } catch (err) {
        console.log(`  ${YELLOW}Caveman plugin step failed: ${err.message}${RESET}`);
      }
    }
    console.log('\n  Done.\n');
    return;
  }

  // Top-level menu — items depend on current config state
  let menuItems;
  if (!state.hasToken || !state.tokenValid) {
    menuItems = [
      { label: 'Full setup',     value: 'full' },
      { label: 'Sign in to API', value: 'auth' },
      { label: 'Refresh agent harness', value: 'sync-agents' },
      { label: 'Exit',           value: 'exit' },
    ];
  } else if (!state.hasKb) {
    menuItems = [
      { label: 'Full setup',                  value: 'full' },
      { label: 'Sign in again / change user', value: 'reauth' },
      { label: 'Create KB from scratch',      value: 'discover' },
      { label: 'Refresh agent harness',        value: 'sync-agents' },
      { label: 'Sync KB with remote',         value: 'sync' },
      { label: 'Change device name',          value: 'change-device' },
      { label: 'Exit',                        value: 'exit' },
    ];
  } else {
    menuItems = [
      { label: 'Re-run setup from scratch',   value: 'scratch' },
      { label: 'Sign in again / change user', value: 'reauth' },
      { label: 'Rebuild knowledge base',      value: 'rebuild' },
      { label: 'Sync KB with remote',         value: 'sync' },
      { label: 'Refresh agent harness / sync agents',  value: 'sync-agents' },
      { label: 'Change device name',          value: 'change-device' },
      { label: 'Exit',                        value: 'exit' },
    ];
  }
  const menuChoice = await selectFromItems('What do you want to do?', menuItems);

  if (menuChoice === 'exit') {
    return;
  }

  // ---- Standalone: Sign in to API (or reauth / change user) ---------------
  if (menuChoice === 'auth' || menuChoice === 'reauth') {
    let machineId;
    try {
      machineId = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
    } catch {
      machineId = crypto.randomUUID();
      fs.mkdirSync(DEVICE_ID_DIR, { recursive: true });
      fs.writeFileSync(DEVICE_ID_PATH, machineId, 'utf8');
    }
    const { token, device, apiBaseUrl } = await runAuthStep({ env: initialEnv, machineId });
    const updates = { API_BASE_URL: apiBaseUrl, API_TOKEN: token };
    if (!initialEnv.values.DEVICE_ID) {
      updates.DEVICE_ID = String(device.id);
      updates.DEVICE_NAME = device.name;
    }
    writeEnv(ENV_PATH, initialEnv.lines, updates, projectRoot);
    console.log(`\n  ${GREEN}Signed in. Credentials saved to the account store.${RESET}\n`);
    return;
  }

  // ---- Standalone: Create KB from scratch / rebuild -----------------------
  if (menuChoice === 'discover' || menuChoice === 'rebuild') {
    const { API_BASE_URL, API_TOKEN, API_PROJECT_ID } = initialEnv.values;
    if (!API_BASE_URL || !API_TOKEN || !API_PROJECT_ID) {
      console.error(`\n  ${YELLOW}Missing config. Run Full setup or "Sign in to API" first.${RESET}\n`);
      process.exit(1);
    }
    try {
      await runDiscoveryStep({
        projectRoot,
        apiBaseUrl: API_BASE_URL,
        token: API_TOKEN,
        projectId: API_PROJECT_ID,
      });
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        console.log(`  ${DIM}Discovery module not yet installed — skipping.${RESET}`);
      } else {
        throw err;
      }
    }
    console.log('\n  Done.\n');
    return;
  }

  // ---- Standalone: Sync KB with remote ------------------------------------
  if (menuChoice === 'sync') {
    const { API_BASE_URL, API_TOKEN, API_PROJECT_ID } = initialEnv.values;
    if (!API_BASE_URL || !API_TOKEN || !API_PROJECT_ID) {
      console.error(`\n  ${YELLOW}Missing config. Run Full setup or "Sign in to API" first.${RESET}\n`);
      process.exit(1);
    }
    await runKbSyncStep({
      projectRoot,
      apiBaseUrl: API_BASE_URL,
      token: API_TOKEN,
      projectId: API_PROJECT_ID,
    });
    console.log('\n  Done.\n');
    return;
  }

  // ---- Standalone: Sync agent config with API -----------------------------
  if (menuChoice === 'sync-agents') {
    const { API_BASE_URL, API_TOKEN, DEVICE_ID } = initialEnv.values;
    await runSyncSetupStep({
      env: initialEnv, apiBaseUrl: API_BASE_URL, token: API_TOKEN,
      deviceId: DEVICE_ID, projectRoot, dryRun: flags.dryRun,
    });
    console.log('\n  Harness refresh finished.\n');
    return;
  }

  // ---- Standalone: Change device name -------------------------------------
  if (menuChoice === 'change-device') {
    await runChangeDeviceNameStep({ env: initialEnv, projectRoot });
    return;
  }

  // ---- Full setup ---------------------------------------------------------

  // Resolve machine ID — persist in ~/.tipatask/device_id
  let machineId;
  try {
    machineId = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
  } catch {
    machineId = crypto.randomUUID();
    fs.mkdirSync(DEVICE_ID_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_PATH, machineId, 'utf8');
  }

  // Check existing configuration (reuse env read from analyzeSetupState)
  const env = initialEnv;

  if (env.values.API_TOKEN && env.values.API_PROJECT_ID) {
    console.log(`  ${DIM}Current configuration:${RESET}`);
    console.log(`    Backend:    ${env.values.TASK_BACKEND || 'api'}`);
    console.log(`    API URL:    ${env.values.API_BASE_URL || '(not set)'}`);
    console.log(`    Project ID: ${env.values.API_PROJECT_ID}`);
    console.log('');

    const reconf = await confirm('  Reconfigure?');
    if (!reconf) {
      console.log('\n  Keeping current config. Done.\n');
      process.exit(0);
    }
    console.log('');
  }

  const { token, user, device, apiBaseUrl } = await runAuthStep({ env, machineId });

  // Fetch user's projects
  console.log(`\n  ${DIM}Fetching projects...${RESET}`);
  const { status, data } = await request(`${apiBaseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (status >= 400) {
    throw new Error(`Failed to fetch projects: ${JSON.stringify(data)}`);
  }

  const rawProjects = Array.isArray(data) ? data : data.projects || data.data || [];
  const projects = rawProjects.map(p => ({ ...p, taskCount: p.task_count ?? 0 }));

  // Select or create project
  let project;
  let selectedPreset = 'none'; // stays 'none' when reusing an existing API project — no seed
  const selection = await selectProject(projects);
  if (selection === 'CREATE_NEW') {
    project = await createProject(apiBaseUrl, token);
    console.log(`\n  ${GREEN}Created project: ${project.name}${RESET}\n`);
    selectedPreset = await selectFromItems('What best describes your project?', [
      { label: 'New project — starting from scratch',        value: 'original-specification', selected: true },
      { label: 'Existing project — already being worked on', value: 'existing-code' },
    ]);
  } else {
    project = selection;
  }

  // Associate device with project
  await request(`${apiBaseUrl}/api/devices/${device.id}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { project_id: project.id },
  });

  // Exchange the sign-in token for the account-wide desktop token (legacy scope is preserved).
  let scopedToken;
  try {
    const { exchangeProjectToken } = require('./auth');
    scopedToken = await exchangeProjectToken(apiBaseUrl, token, project.id);
  } catch (err) {
    console.error(`\n  ${YELLOW}Failed to exchange desktop token: ${err.message}${RESET}`);
    process.exit(1);
  }

  try {
    const archReport = await pullArchitectureDocs(apiBaseUrl, project.id, scopedToken, PROJECT_ROOT);
    const { remoteIsEmpty, pulledCount } = await syncOnSessionStart(apiBaseUrl, project.id, scopedToken, PROJECT_ROOT);
    const totalPulled = archReport.pulled.length + archReport.merged.length + pulledCount;
    if (remoteIsEmpty && totalPulled === 0) {
      console.log(`  ${DIM}Remote KB is new — local KB will be pushed after setup${RESET}`);
    } else {
      console.log(`  ${GREEN}Pulled ${totalPulled} KB file(s) from API${RESET}`);
      if (archReport.merged.length) {
        console.log(`  ${DIM}  merged: ${archReport.merged.map(k => k.replace('ai/architecture/', '')).join(', ')}${RESET}`);
      }
    }
  } catch (err) {
    console.log(`  ${YELLOW}KB pull skipped: ${err.message}${RESET}`);
  }

  const { listAvailableTaskAgents } = require('../server/task-agent');
  const config = require('../server/config');
  const availableAgents = await listAvailableTaskAgents(config);
  if (availableAgents.length === 0) {
    throw new Error('No supported task agents are available. Install and log into Claude Code or Codex before running setup.');
  }

  const preferredAgent = env.values.TASK_AGENT || 'claude';
  const previouslyEnabled = (env.values.AVAILABLE_AGENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  let enabledAgents;
  if (availableAgents.length === 1) {
    enabledAgents = [availableAgents[0]];
    console.log(`\n  Task agents: ${availableAgents[0].label} ${DIM}(only available option)${RESET}`);
  } else {
    let valid = false;
    while (!valid) {
      const items = availableAgents.map(a => ({
        label: a.label,
        value: a,
        selected: previouslyEnabled.length === 0 ? true : previouslyEnabled.includes(a.id),
      }));
      enabledAgents = await multiSelect('Select agents available for task assignment', items);
      if (enabledAgents.length > 0) {
        valid = true;
      } else {
        console.log(`  ${YELLOW}Select at least one agent.${RESET}`);
      }
    }
  }

  let selectedAgent = enabledAgents.find(a => a.id === preferredAgent) || enabledAgents[0];
  if (enabledAgents.length > 1) {
    selectedAgent = await selectAgent(enabledAgents, selectedAgent.id);
  }

  // Merge existing agent config with newly detected agents before writing
  const preWriteEnv = readEnv(ENV_PATH, projectRoot);
  const existingAgents = (preWriteEnv.values.AVAILABLE_AGENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const detectedAgentIds = enabledAgents.map(a => a.id);
  const mergedAgentIds = [...new Set([...existingAgents, ...detectedAgentIds])];
  const finalTaskAgent = mergedAgentIds.includes(selectedAgent.id)
    ? selectedAgent.id
    : (preWriteEnv.values.TASK_AGENT && mergedAgentIds.includes(preWriteEnv.values.TASK_AGENT)
        ? preWriteEnv.values.TASK_AGENT
        : mergedAgentIds[0]);

  // Write the target to config.json, token to the account store, and runtime settings to .env.
  writeEnv(ENV_PATH, preWriteEnv.lines, {
    TASK_BACKEND: 'api',
    TASK_AGENT: finalTaskAgent,
    AVAILABLE_AGENTS: mergedAgentIds.join(','),
    API_BASE_URL: apiBaseUrl,
    API_TOKEN: scopedToken,
    API_PROJECT_ID: String(project.id),
    DEVICE_ID: String(device.id),
    DEVICE_NAME: device.name,
  }, projectRoot);

  // Push merged agent config to API device record
  try {
    let machineIdForSync;
    try { machineIdForSync = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim(); } catch { /* ok */ }
    if (machineIdForSync) {
      await request(`${apiBaseUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${scopedToken}` },
        body: {
          name: device.name,
          machine_id: machineIdForSync,
          available_agents: mergedAgentIds.join(','),
          task_agent: finalTaskAgent,
        },
      });
    }
  } catch { /* non-fatal */ }

  // Reload env after write so placeholders see current values
  const freshEnv = readEnv(ENV_PATH, projectRoot);

  // Install templates (CLAUDE.md, AGENTS.md, .mcp.json, .claude/*, etc.) unless --skip-install
  if (!flags.skipInstall) {
    await runInstallTemplates(flags, freshEnv);
  }

  // Configure MCP clients (.claude/settings.local.json + ~/.codex/config.toml)
  configureMcpServers({ projectRoot, dryRun: flags.dryRun });

  console.log(`  ${GREEN}Configuration saved to .tipatask/config.json + .env${RESET}`);
  console.log(`    Backend:    api`);
  console.log(`    API URL:    ${apiBaseUrl}`);
  console.log(`    Project:    ${project.name} (${project.id})`);
  console.log(`    Device:     ${device.name} (${device.id})`);
  console.log(`    Task agent: ${finalTaskAgent}`);
  console.log(`    Available:  ${mergedAgentIds.join(', ')}`);
  console.log(`    MCP:        configured for Claude and Codex`);
  console.log(`    Claude:     .claude/settings.local.json`);
  console.log(`    Codex (global):  ~/.codex/config.toml`);
  console.log(`    Codex (project): .codex/config.toml`);

  // Caveman plugin step (best-effort)
  if (!flags.skipInstall) {
    try {
      const { runCavemanPluginStep } = require('./plugin-install');
      await runCavemanPluginStep(
        flags.projectRoot ? path.resolve(flags.projectRoot) : PROJECT_ROOT,
        { force: flags.force }
      );
    } catch (err) {
      console.log(`  ${YELLOW}Caveman plugin step failed: ${err.message}${RESET}`);
    }
  }

  // Task import prompt — offer to seed the project from an existing TODO.md
  try {
    const { importFromTodo, TODO_PATH: defaultTodoPath } = require('./migrate-tasks');
    if (fs.existsSync(defaultTodoPath)) {
      let taskCount = 0;
      try {
        const raw = fs.readFileSync(defaultTodoPath, 'utf8');
        const m = raw.match(/```json\s*\n([\s\S]*?)```/);
        if (m) {
          const d = JSON.parse(m[1]);
          taskCount = Array.isArray(d.tasks) ? d.tasks.length : 0;
        }
      } catch {}

      if (taskCount > 0) {
        const doImport = await confirm(`  Import ${taskCount} tasks from TODO.md into this project?`);
        if (doImport) {
          await importFromTodo(apiBaseUrl, String(project.id), token, defaultTodoPath, { dryRun: flags.dryRun });
        }
      }
    }
  } catch (err) {
    console.log(`  ${YELLOW}Task import failed: ${err.message}${RESET}`);
  }

  // Seed agent setup tasks (confirm-gated)
  try {
    const { runSeedSetupTasks } = require('./seed-setup-tasks');
    const doSeedSetup = await confirm(`  Set up Tip${CYAN}Δ${RESET}Task for this project?`);
    if (doSeedSetup) {
      await runSeedSetupTasks({
        projectRoot: flags.projectRoot ? path.resolve(flags.projectRoot) : PROJECT_ROOT,
        apiBaseUrl,
        token,
        projectId: project.id,
      });
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.log(`  ${DIM}Setup-task seeder not yet installed — skipping.${RESET}`);
    } else {
      console.log(`  ${YELLOW}Agent setup tasks failed: ${err.message}${RESET}`);
    }
  }

  // Preset placeholder task seeding. The result is kept (TPT203) so a partial/failed seed is
  // reported loudly at the end of the run instead of scrolling past — setup still continues.
  let presetSeedProblem = null;
  if (selectedPreset !== 'none') {
    try {
      const { seedPresetTasks, describePresetSeedProblem } = require('./seed-setup-tasks');
      const seedResult = await seedPresetTasks(selectedPreset, { projectRoot, apiBaseUrl, token, projectId: project.id, presetDescription: null });
      presetSeedProblem = describePresetSeedProblem(seedResult);
    } catch (err) {
      console.log(`  ${YELLOW}Preset task seeding failed: ${err.message}${RESET}`);
      presetSeedProblem = `Preset task seeding failed: ${err.message}`;
    }
  }

  // Discovery prompt
  if (!flags.skipDiscover) {
    const doDiscover = await confirm('  Seed architecture docs from project scan?');
    if (doDiscover) {
      try {
        await runDiscoveryStep({
          projectRoot: flags.projectRoot ? path.resolve(flags.projectRoot) : PROJECT_ROOT,
          apiBaseUrl,
          token,
          projectId: project.id,
        });
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          console.log(`  ${DIM}Discovery module not yet installed — skipping.${RESET}`);
        } else {
          console.log(`  ${YELLOW}Discovery failed: ${err.message}${RESET}`);
        }
      }
    }
  }

  try {
    const archReport = await pushArchitectureDocs(apiBaseUrl, project.id, token, PROJECT_ROOT);
    await pushAll(apiBaseUrl, project.id, token, PROJECT_ROOT);
    console.log(`  ${GREEN}Pushed KB to API${RESET} ${DIM}(${archReport.pushed.length} tt-*.md pushed, ${archReport.skipped.length} skipped)${RESET}`);
  } catch (err) {
    console.log(`  ${YELLOW}KB push skipped: ${err.message}${RESET}`);
  }

  if (presetSeedProblem) {
    console.log(`\n  ${RED}${BOLD}Starter tasks were not fully seeded${RESET}`);
    console.log(`  ${RED}${presetSeedProblem}${RESET}`);
    console.log(`  ${RED}Those tasks exist only as blank "New task" placeholders and cannot be started by an agent.${RESET}`);
    console.log(`  ${DIM}Re-run \`npm run setup\` to seed them again, or delete/finalize them from the task board.${RESET}`);
  }

  console.log(`\n  Run ${CYAN}node todo-server.js${RESET} to start.\n`);
}

if (require.main === module) {
  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdout.write('\x1b[?25h'); // Show cursor
    console.log('\n  Aborted.\n');
    process.exit(1);
  });

  main().catch((err) => {
    if (err.message === 'Aborted') {
      console.log('\n  Setup cancelled.\n');
      process.exit(1);
    }
    console.error(`\n  Error: ${err.message}\n`);
    if (err.message.includes('Request to')) {
      console.error('  Make sure the Tipatask API server is running and accessible.\n');
    }
    process.exit(1);
  });
}

module.exports = { registerDevice, createApiProject, associateDeviceProject, analyzeSetupState, runSyncSetupStep, configureMcpServers, readEnv };
