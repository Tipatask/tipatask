'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const toml = require('toml');

const TIPATASK_MCP_NAME = 'tipatask';
// C1382 — the local-only companion server name. The remote 'tipatask' server (17
// tools, api/src/routes/mcp.js) is now the primary registration; this stdio server
// keeps only the 4 tools that need a repo checkout or git worktree (batch_grep_tags,
// push_knowledge, pull_knowledge, git_worktree_status) — see tt-mcp-server.md.
const TIPATASK_MCP_LOCAL_NAME = 'tipatask-local';
// The stdio server shipped by THIS checkout. Callers that don't pass mcpServerPath get the
// running install — never a path guessed relative to the project being configured.
const DEFAULT_MCP_SERVER_PATH = path.join(__dirname, 'mcp', 'server.js');
const CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE = 'approve';

// ── Opt-in browser-tools MCP presets (TPT95) ────────────────────────────────────
// Playwright and Chrome DevTools are the two browser-automation MCP servers Codex
// documents support for. Selection is stored as MCP_BROWSER_TOOLS (array of these ids)
// in .tipatask/config.json, surfaced by the Task Edit Modal's Codex-only "Browser
// tools" row — never a CLI setup prompt. Absent key = both enabled (default-on).
// Every id must stay TOML-bare-key-safe since it becomes `mcp_servers.<id>` verbatim.
const BROWSER_PRESET_MARKER = '# tipatask-managed-preset';
const BROWSER_MCP_PRESETS = [
  { id: 'playwright', label: 'Playwright', args: ['@playwright/mcp@latest'] },
  { id: 'chrome-devtools', label: 'Chrome DevTools', args: ['chrome-devtools-mcp@latest'] },
];
const BROWSER_MCP_PRESET_IDS = BROWSER_MCP_PRESETS.map(p => p.id);
const SERVER_PACKAGE_PATH = path.join(__dirname, '..', 'package.json');

function tomlString(value) {
  return JSON.stringify(value);
}

function readRequiredNodeMajor(packageJsonPath = SERVER_PACKAGE_PATH, fsImpl = fs) {
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(packageJsonPath, 'utf8'));
    const match = String(pkg && pkg.engines && pkg.engines.node || '').match(/\d+/);
    return match ? Number(match[0]) : 22;
  } catch {
    return 22;
  }
}

function executablePath(filePath, { fsImpl = fs, platform = process.platform } = {}) {
  if (!filePath) return null;
  const candidates = platform === 'win32' && !path.extname(filePath)
    ? [filePath, `${filePath}.exe`, `${filePath}.cmd`, `${filePath}.bat`]
    : [filePath];
  for (const candidate of candidates) {
    try {
      fsImpl.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return path.resolve(candidate);
    } catch { /* try next */ }
  }
  return null;
}

function executableOnPath(name, envPath, opts) {
  const delimiter = opts.platform === 'win32' ? ';' : ':';
  for (const dir of String(envPath || '').split(delimiter)) {
    if (!dir) continue;
    const found = executablePath(path.join(dir, name), opts);
    if (found) return found;
  }
  return null;
}

function versionedNodeCandidates(root, relativeNodePath, fsImpl = fs) {
  try {
    return fsImpl.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^v?\d/.test(entry.name))
      .map(entry => path.join(root, entry.name, ...relativeNodePath))
      .map(nodePath => {
        try { return { nodePath, mtimeMs: fsImpl.statSync(nodePath).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(entry => entry.nodePath);
  } catch {
    return [];
  }
}

function browserRuntimePath(nodeBinDir, envPath, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  // POSIX presets need only a stable system tail after the selected Node bin. Do not
  // persist the Task App/Codex process's ambient PATH: desktop hosts may inject
  // session-scoped temp directories, causing config churn on every spawn. Windows
  // keeps its ambient tail because system tool locations are installation-specific.
  const tail = platform === 'win32'
    ? String(envPath || '').split(delimiter)
    : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const seen = new Set();
  return [nodeBinDir, ...tail]
    .filter(Boolean)
    .filter(dir => {
      const key = platform === 'win32' ? dir.toLowerCase() : dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(delimiter);
}

// Resolves the concrete Node/npm toolchain used by marker-owned browser MCP presets.
// Candidate order mirrors bin/mcp-node: TIPATASK_NODE, PATH, nvm, fnm, Volta, then
// common system locations. Compatibility intentionally follows that wrapper's
// engines.node-major check. npx must live beside the accepted node so its env-node
// shebang cannot fall back to an older ambient runtime.
function resolveBrowserMcpRuntime({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  packageJsonPath = SERVER_PACKAGE_PATH,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  requiredMajor = readRequiredNodeMajor(packageJsonPath, fsImpl),
} = {}) {
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const npxName = platform === 'win32' ? 'npx.cmd' : 'npx';
  const probeOpts = { fsImpl, platform };
  const failure = reason => ({ available: false, requiredMajor, reason });

  function inspect(rawNodePath) {
    const nodePath = executablePath(rawNodePath, probeOpts);
    if (!nodePath) return null;
    let version;
    try {
      version = String(execFileSyncImpl(nodePath, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })).trim();
    } catch {
      return null;
    }
    const match = version.match(/^v?(\d+)/);
    if (!match || Number(match[1]) < requiredMajor) return null;
    const nodeBinDir = path.dirname(nodePath);
    const npxPath = executablePath(path.join(nodeBinDir, npxName), probeOpts);
    if (!npxPath) return null;
    return {
      available: true,
      requiredMajor,
      nodePath,
      nodeVersion: version,
      nodeBinDir,
      npxPath,
      path: browserRuntimePath(nodeBinDir, env.PATH, platform),
    };
  }

  if (env.TIPATASK_NODE) {
    return inspect(env.TIPATASK_NODE)
      || failure(`TIPATASK_NODE does not provide Node >=${requiredMajor} with npx`);
  }

  const candidates = [];
  const pathNode = executableOnPath(platform === 'win32' ? 'node' : nodeName, env.PATH, probeOpts);
  if (pathNode) candidates.push(pathNode);

  if (platform === 'win32') {
    const nvmRoot = env.NVM_HOME || path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'nvm');
    candidates.push(...versionedNodeCandidates(nvmRoot, [nodeName], fsImpl));
    const fnmRoot = path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'fnm', 'node-versions');
    candidates.push(...versionedNodeCandidates(fnmRoot, ['installation', nodeName], fsImpl));
    candidates.push(path.join(homeDir, '.volta', 'bin', nodeName));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'nodejs', nodeName));
    if (env['ProgramFiles(x86)']) candidates.push(path.join(env['ProgramFiles(x86)'], 'nodejs', nodeName));
  } else {
    const nvmRoot = path.join(env.NVM_DIR || path.join(homeDir, '.nvm'), 'versions', 'node');
    candidates.push(...versionedNodeCandidates(nvmRoot, ['bin', nodeName], fsImpl));
    const fnmRoot = path.join(homeDir, '.fnm', 'node-versions');
    candidates.push(...versionedNodeCandidates(fnmRoot, ['installation', 'bin', nodeName], fsImpl));
    candidates.push(
      path.join(homeDir, '.volta', 'bin', nodeName),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node'
    );
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const runtime = inspect(candidate);
    if (runtime) return runtime;
  }
  return failure(`no Node >=${requiredMajor} installation with npx was found`);
}

// Emits the full TOML body for one browser preset, marker line included. Section name
// is always derived as `mcp_servers.<id>` — never stored separately, so it can't drift.
function browserPresetSectionLines(preset, runtime) {
  const sectionName = `mcp_servers.${preset.id}`;
  const args = ['-y', ...preset.args];
  if (!runtime || !runtime.available) {
    const requiredMajor = runtime && runtime.requiredMajor || 22;
    return [
      `[${sectionName}]`,
      BROWSER_PRESET_MARKER,
      `# Disabled: Tipatask could not find Node >=${requiredMajor} with a sibling npx launcher.`,
      '# Install a compatible Node runtime or set TIPATASK_NODE, then restart Codex.',
      // Codex requires a command even for disabled STDIO servers. This fallback is never
      // spawned while disabled; keeping the intended command makes the table schema-valid.
      `command = ${tomlString('npx')}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      'enabled = false',
      'startup_timeout_sec = 60',
      `default_tools_approval_mode = ${tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE)}`,
      '',
    ];
  }
  return [
    `[${sectionName}]`,
    BROWSER_PRESET_MARKER,
    `command = ${tomlString(runtime.npxPath)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    `env = { PATH = ${tomlString(runtime.path)} }`,
    'startup_timeout_sec = 60',
    `default_tools_approval_mode = ${tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE)}`,
    '',
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTomlSection(content, sectionName, sectionLines) {
  const lines = content ? content.split('\n') : [];
  const result = [];
  let i = 0;
  let inserted = false;

  while (i < lines.length) {
    if (lines[i].trim() === `[${sectionName}]`) {
      if (!inserted && result.length > 0 && result[result.length - 1] !== '') {
        result.push('');
      }
      if (!inserted) {
        result.push(...sectionLines);
        inserted = true;
      }
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('[')) {
        i += 1;
      }
      continue;
    }
    result.push(lines[i]);
    i += 1;
  }

  if (!inserted) {
    if (result.length > 0 && result[result.length - 1] !== '') {
      result.push('');
    }
    result.push(...sectionLines);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function removeTomlSections(content, shouldRemove) {
  const lines = content ? content.split('\n') : [];
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const match = lines[i].trim().match(/^\[([^\]]+)\]$/);
    if (match && shouldRemove(match[1])) {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('[')) {
        i += 1;
      }
      continue;
    }
    result.push(lines[i]);
    i += 1;
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function isMcpToolApprovalSection(sectionName) {
  return /^mcp_servers\.(?:"(?:[^"\\]|\\.)+"|[^.]+)\.tools\./.test(sectionName);
}

// Returns true when the named [sectionName] block in `content` already contains a
// `command =` or `url =` key — i.e. has a resolvable MCP transport.
// Returns false when the section is absent, or present but only has metadata keys
// (e.g. a bare approval-only stub created by upsertTomlKey).
function mcpSectionHasCommand(content, sectionName) {
  const lines = content ? content.split('\n') : [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === `[${sectionName}]`) {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('[')) {
        if (/^\s*(command|url)\s*=/.test(lines[i])) return true;
        i += 1;
      }
      return false;
    }
    i += 1;
  }
  return false;
}

// ── Browser preset ownership probes (TPT95) — deliberately asymmetric ──────────
// Both resolve an ambiguous case to "leave it alone": tomlSectionExists is
// comment-tolerant so a header with a trailing comment still counts as "already
// present" (and is never duplicated into a second, `toml.parse`-breaking table);
// tomlSectionHasMarkerLine is a strict trim-equality header match so a commented-out
// or hand-written header is never mistaken for one this app owns and safe to remove.

// True when [sectionName] appears anywhere as a header, with or without a trailing
// `# comment`. Does not require exact equality the way upsertTomlSection's own header
// match does — see the header-with-trailing-comment hazard in the file banner above.
function tomlSectionExists(content, sectionName) {
  const escaped = escapeRegExp(sectionName);
  const headerRe = new RegExp(`^\\[${escaped}\\]\\s*(?:#.*)?$`);
  const lines = content ? content.split('\n') : [];
  return lines.some(line => headerRe.test(line.trim()));
}

// True only when [sectionName] is an exact header match (no trailing comment — a
// commented header is never "ours") and its body carries `marker` as its own line.
function tomlSectionHasMarkerLine(content, sectionName, marker) {
  const lines = content ? content.split('\n') : [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === `[${sectionName}]`) {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('[')) {
        if (lines[i].trim() === marker) return true;
        i += 1;
      }
      return false;
    }
    i += 1;
  }
  return false;
}

function upsertTopLevelTomlKey(content, key, value) {
  const lines = content ? content.split('\n') : [];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const filtered = lines.filter(line => !keyPattern.test(line));
  return [`${key} = ${value}`, ...filtered].join('\n').replace(/\n{3,}/g, '\n\n');
}

function upsertTomlKey(content, sectionName, key, value) {
  const lines = content ? content.split('\n') : [];
  const result = [];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let i = 0;
  let sectionFound = false;

  while (i < lines.length) {
    if (lines[i].trim() !== `[${sectionName}]`) {
      result.push(lines[i]);
      i += 1;
      continue;
    }

    sectionFound = true;
    result.push(lines[i]);
    i += 1;

    let keyFound = false;
    while (i < lines.length && !lines[i].trim().startsWith('[')) {
      if (keyPattern.test(lines[i])) {
        if (!keyFound) {
          result.push(`${key} = ${value}`);
          keyFound = true;
        }
      } else {
        result.push(lines[i]);
      }
      i += 1;
    }
    if (!keyFound) result.push(`${key} = ${value}`);
  }

  if (!sectionFound) {
    if (result.length > 0 && result[result.length - 1] !== '') {
      result.push('');
    }
    result.push(`[${sectionName}]`, `${key} = ${value}`, '');
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function removeTopLevelTomlKey(content, key) {
  const lines = content ? content.split('\n') : [];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const result = [];
  let topLevel = true;
  for (const line of lines) {
    if (topLevel && line.trim().startsWith('[')) topLevel = false;
    if (topLevel && keyPattern.test(line)) continue;
    result.push(line);
  }
  return result.join('\n');
}

// A hand-tuned global tipatask-local section keeps its command/args/env during
// refresh. Remove only Codex's unsupported transport key from either Tipatask
// server table, leaving all other settings and server tables intact.
function removeTipataskTransportKeys(content) {
  const tipataskSections = new Set([
    `mcp_servers.${TIPATASK_MCP_NAME}`,
    `mcp_servers.${TIPATASK_MCP_LOCAL_NAME}`,
  ]);
  let inTipataskSection = false;
  return content.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const header = trimmed.match(/^\[([^\]]+)\](?:\s*#.*)?$/);
      inTipataskSection = Boolean(header && tipataskSections.has(header[1]));
    }
    return !(inTipataskSection && /^\s*transport\s*=/.test(line));
  }).join('\n');
}

function upsertKeyInAllMcpServerSections(content, key, value) {
  const serverSection = /^mcp_servers\.(?:"(?:[^"\\]|\\.)+"|[^.]+)$/;
  const lines = content ? content.split('\n') : [];
  const serverNames = [];
  for (const line of lines) {
    const m = line.trim().match(/^\[([^\]]+)\]$/);
    if (m && serverSection.test(m[1]) && !serverNames.includes(m[1])) {
      serverNames.push(m[1]);
    }
  }
  return serverNames.reduce((acc, name) => upsertTomlKey(acc, name, key, value), content);
}

// ── Browser preset selection + apply (TPT95) ────────────────────────────────────
// `undefined`/`null`/non-array → both presets (default-on; also protects a
// hand-corrupted config.json from reading as "delete everything"). `[]` is a real,
// managed value meaning "user unchecked both". Unknown ids are dropped.
function normalizeBrowserToolIds(value) {
  if (!Array.isArray(value)) return BROWSER_MCP_PRESET_IDS.slice();
  const known = new Set(BROWSER_MCP_PRESET_IDS);
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Adds/refreshes/removes each BROWSER_MCP_PRESETS section per `enabledIds`. Always
// iterates the fixed preset registry — never caller input — so an unvalidated id can
// never become an injected TOML section name, and a disabled preset is still visited
// (needed for removal). `enabledIds: null` means "unmanaged": returns `content`
// unchanged (same string, not a copy — callers rely on this for a byte-identical
// no-write short-circuit).
function applyBrowserToolPresets(content, enabledIds, browserRuntime) {
  if (!Array.isArray(enabledIds)) return content;
  const enabled = new Set(normalizeBrowserToolIds(enabledIds));
  let out = content;
  let runtime = browserRuntime;
  let runtimeResolved = browserRuntime !== undefined;
  for (const preset of BROWSER_MCP_PRESETS) {
    const sectionName = `mcp_servers.${preset.id}`;
    const owned = tomlSectionHasMarkerLine(out, sectionName, BROWSER_PRESET_MARKER);
    const exists = tomlSectionExists(out, sectionName);
    if (enabled.has(preset.id)) {
      if (!exists || owned) {
        if (!runtimeResolved) {
          runtime = resolveBrowserMcpRuntime();
          runtimeResolved = true;
        }
        out = upsertTomlSection(out, sectionName, browserPresetSectionLines(preset, runtime));
      }
      // present, not owned → leave the user/global definition alone
    } else if (owned) {
      // Remove the whole subtree (mcp_servers.<id> AND mcp_servers.<id>.env/.tools.*),
      // not just the exact name — a surviving [mcp_servers.<id>.env] parses as a
      // server with no `command`, which Codex fails to start.
      out = removeTomlSections(out, name => name === sectionName || name.startsWith(`${sectionName}.`));
    }
    // present, not owned, disabled → leave alone
  }
  return out;
}

// Reads MCP_BROWSER_TOOLS off .tipatask/config.json. Never throws — mirrors
// readCodexCredentials()'s never-throw contract, since this also runs at points where
// the project may not be configured yet.
function readBrowserToolSelection(projectRoot) {
  if (!projectRoot) return normalizeBrowserToolIds(undefined);
  try {
    const { readProjectConfig } = require('./server/project-config');
    const cfg = readProjectConfig(projectRoot);
    return normalizeBrowserToolIds(cfg ? cfg.MCP_BROWSER_TOOLS : undefined);
  } catch {
    return normalizeBrowserToolIds(undefined);
  }
}

// ── Directory-trust pre-approval (C1048) ──
// Codex's own first-run "do you trust this directory?" dialog gates on a
// `[projects."<abs-path>"].trust_level` key in whatever config.toml it resolves as its home
// config. This app redirects CODEX_HOME to {projectRoot}/.codex on every spawn
// (ensureProjectCodexHome below), so that project-local config.toml IS Codex's home config
// for a Task-App-spawned session — writing the trust key here prevents the dialog outright,
// the same way writeProjectClaudeMcpApproval() prevents Claude Code's MCP trust dialog (see
// tt-project-config.md). No-op when projectRoot is absent (mirrors buildCodexMcpSection's own
// projectRoot-optional signature).
function upsertProjectTrustLevel(content, projectRoot) {
  if (!projectRoot) return content;
  const absProjectRoot = path.resolve(projectRoot);
  return upsertTomlKey(content, `projects.${tomlString(absProjectRoot)}`, 'trust_level', tomlString('trusted'));
}

function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseTomlOptional(content) {
  if (!content || !content.trim()) return {};
  try {
    return toml.parse(content);
  } catch {
    return null;
  }
}

function mcpServerNames(parsed) {
  const servers = parsed && parsed.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers);
}

// Names of every MCP server the project's .codex/config.toml registers (app-owned tables,
// browser presets, servers inherited from the user's own config). [] when the file is missing
// or not valid TOML.
function listProjectMcpServerNames(projectRoot) {
  if (!projectRoot) return [];
  return mcpServerNames(parseTomlOptional(readOptional(getCodexPaths(projectRoot).projectConfigPath)));
}

// Preserve user formatting/comments by using the TOML parser only for validation and
// logical server-name discovery, then copy the matching raw table blocks. A server is the
// whole subtree rooted at mcp_servers.<name>; when the project defines any part of that
// subtree, every global block for that name is skipped so project configuration wins.
function extractMcpServerTableBlocks(content) {
  const lines = content ? content.split('\n') : [];
  const headers = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isArrayTable = /^\s*\[\[.+\]\]\s*(?:#.*)?$/.test(line);
    const isTable = /^\s*\[(?!\[).+\]\s*(?:#.*)?$/.test(line);
    if (!isArrayTable && !isTable) continue;
    let parsedHeader;
    try {
      parsedHeader = toml.parse(`${line}\n`);
    } catch {
      continue;
    }
    const names = mcpServerNames(parsedHeader);
    headers.push({ index: i, serverName: names.length === 1 ? names[0] : null });
  }

  const blocks = [];
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    if (!header.serverName) continue;
    const end = i + 1 < headers.length ? headers[i + 1].index : lines.length;
    blocks.push({
      serverName: header.serverName,
      content: lines.slice(header.index, end).join('\n').replace(/\n+$/, ''),
    });
  }
  return blocks;
}

function mergeGlobalMcpServerTables(projectContent, globalContent) {
  const parsedGlobal = parseTomlOptional(globalContent);
  if (!parsedGlobal) return projectContent;

  const parsedProject = parseTomlOptional(projectContent);
  if (!parsedProject) return projectContent;

  const projectNames = new Set(mcpServerNames(parsedProject));
  const missingNames = new Set(mcpServerNames(parsedGlobal).filter(name => !projectNames.has(name)));
  if (missingNames.size === 0) return projectContent;

  const inherited = extractMcpServerTableBlocks(globalContent)
    .filter(block => missingNames.has(block.serverName))
    .map(block => block.content)
    .filter(Boolean);
  if (inherited.length === 0) return projectContent;

  const base = (projectContent || '').replace(/\n+$/, '');
  return `${base ? `${base}\n\n` : ''}${inherited.join('\n\n')}\n`;
}

function tomlValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, v]) => `${tomlString(key)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf';
  }
  return JSON.stringify(value);
}

// Replace the complete MCP map for a headless turn. Codex -c dotted keys do not
// parse TOML quotes, so quoting a server name there creates a different invalid
// entry. A single inline table excludes every third-party entry without editing
// the user's config (including names containing dots, spaces or quotes).
function buildScopedCodexMcpOverride(projectRoot, profile) {
  const parsed = toml.parse(fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf8'));
  const all = parsed.mcp_servers || {};
  const selected = {};
  for (const name of profile.mcpServers) {
    if (!all[name]) continue;
    const entry = { ...all[name], enabled: true };
    if (name === TIPATASK_MCP_NAME) entry.disabled_tools = profile.remoteDisabledTools;
    if (name === TIPATASK_MCP_LOCAL_NAME) entry.enabled_tools = profile.localEnabledTools;
    selected[name] = entry;
  }
  return `mcp_servers=${tomlValue(selected)}`;
}

// Project-local CODEX_HOME hides user defaults. Backfill absent preferences on
// upgrades as well as first setup. Existing values remain project-owned because
// older configs have no provenance proving they are safe to replace.
function mergeGlobalCodexPreferences(projectContent, globalContent) {
  const global = parseTomlOptional(globalContent);
  const project = parseTomlOptional(projectContent);
  if (!global || !project) return projectContent;
  let out = projectContent;
  const isTable = value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
  const lookup = (obj, keys) => keys.reduce((v, key) => v?.[key], obj);
  function add(keys, value) {
    const assignment = rest => `${rest.map(tomlString).join('.')} = ${tomlValue(value)}\n`;
    const candidates = [assignment(keys) + out];
    if (isTable(value)) {
      // Prefer an open table for inherited defaults so later upgrades can add
      // keys to it; an inline table would permanently seal that namespace.
      const tableText = (parts, table) => {
        const entries = Object.entries(table);
        return `[${parts.map(tomlString).join('.')}]\n`
          + entries.filter(([, v]) => !isTable(v)).map(([k, v]) => `${tomlString(k)} = ${tomlValue(v)}\n`).join('')
          + entries.filter(([, v]) => isTable(v)).map(([k, v]) => tableText([...parts, k], v)).join('');
      };
      candidates.unshift(`${out.trimEnd()}\n\n${tableText(keys, value)}`);
    }
    // Dotted keys cannot reopen an explicitly declared table. Insert in the
    // matching table instead, preserving comments, formatting and user values.
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\[(?!\[).+\]\s*(?:#.*)?$/.test(lines[i])) continue;
      for (let n = keys.length - 1; n > 0; n--) {
        const probe = parseTomlOptional(`${lines[i]}\n__tipatask_probe__ = true\n`);
        if (lookup(probe, keys.slice(0, n))?.__tipatask_probe__ !== true) continue;
        candidates.push([...lines.slice(0, i + 1), assignment(keys.slice(n)).trimEnd(), ...lines.slice(i + 1)].join('\n'));
      }
    }
    for (const candidate of candidates) {
      const parsed = parseTomlOptional(candidate);
      if (parsed && JSON.stringify(lookup(parsed, keys)) === JSON.stringify(value)) {
        out = candidate;
        return;
      }
    }
    // Inline tables are sealed by TOML; leave such custom configuration alone.
  }
  function visit(defaults, current, prefix = []) {
    for (const [key, value] of Object.entries(defaults)) {
      if (!prefix.length && ['mcp_servers', 'projects', 'default_tools_approval_mode'].includes(key)) continue;
      const keys = [...prefix, key];
      if (!Object.prototype.hasOwnProperty.call(current, key)) add(keys, value);
      else if (isTable(value) && isTable(current[key])) visit(value, current[key], keys);
    }
  }
  visit(global, project);
  return out;
}

function getCodexPaths(projectRoot, { env = process.env, homeDir = os.homedir() } = {}) {
  const projectCodexDir = path.resolve(projectRoot, '.codex');
  const exportedCodexDir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : null;
  // Task App-spawned Codex processes export the project directory as CODEX_HOME. Do not
  // read that same file as its own "global" source; fall back to the user's normal home.
  // A different exported CODEX_HOME is a real user-level override and must be honored.
  const globalCodexDir = exportedCodexDir && exportedCodexDir !== projectCodexDir
    ? exportedCodexDir
    : path.join(homeDir, '.codex');
  return {
    globalCodexDir,
    globalConfigPath: path.join(globalCodexDir, 'config.toml'),
    globalAuthPath: path.join(globalCodexDir, 'auth.json'),
    projectCodexDir,
    projectConfigPath: path.join(projectCodexDir, 'config.toml'),
    projectAuthPath: path.join(projectCodexDir, 'auth.json'),
  };
}

// Detects whether the resolved MCP server path lives inside an Electron asar archive.
// In packaged builds SERVER_ROOT = .../Contents/Resources/app.asar (a regular file, not a
// directory), so any path derived from it (bin/mcp-node, node_modules/...) cannot be
// spawned by plain-node. The Electron binary must be used with ELECTRON_RUN_AS_NODE=1.
function _isAsarPath(p) {
  return /\.asar([\\/]|$)/.test(p);
}

// Reads concrete API_BASE_URL/API_PROJECT_ID from .tipatask/config.json.
// Returns null when projectRoot can't be resolved or the project isn't configured yet
// (mid-setup) — callers degrade to an empty/partial section rather than throwing, since
// this runs at points (Electron project-open, setup.js) where credentials may not exist
// yet and a Codex-config write must never block the caller.
function readCodexCredentials(projectRoot) {
  if (!projectRoot) return null;
  try {
    const { readProjectConfig } = require('./server/project-config');
    const cfg = readProjectConfig(projectRoot);
    if (!cfg) return null;
    // Same trailing-slash trim as api-credentials.js's getApiCredentials(), so a
    // config.json with or without one produces the same URL.
    const baseUrl = String(cfg.API_BASE_URL || '').replace(/\/+$/, '');
    const projectId = String(cfg.API_PROJECT_ID || '');
    if (!baseUrl || !projectId) return null;
    return { baseUrl, projectId };
  } catch {
    return null;
  }
}

// ── Remote HTTP section (C1382) — the primary registration; replaces the old
// stdio-only buildCodexMcpSection for the 'tipatask' name. Emits a concrete URL but
// never a credential: Codex resolves TIPATASK_API_TOKEN from its spawn environment and
// sends it as the Authorization bearer token. buildCodexEnv() live-reads API_TOKEN from
// .tipatask/config.json before every Task App Codex spawn. Because this whole app-owned
// section is replaced on every rewrite, legacy `http_headers = { Authorization = ... }`
// entries are removed rather than preserved beside the env-var contract.
function buildCodexMcpSection({ projectRoot } = {}) {
  // No projectRoot → no credentials to read; the section is emitted with an empty url and
  // gets refreshed once the project is bound. The root is never inferred from a server path.
  const creds = readCodexCredentials(projectRoot || null);
  const sectionName = `mcp_servers.${TIPATASK_MCP_NAME}`;

  const sectionLines = [
    `[${sectionName}]`,
    `url = ${tomlString(creds ? `${creds.baseUrl}/api/projects/${creds.projectId}/mcp` : '')}`,
    `bearer_token_env_var = ${tomlString('TIPATASK_API_TOKEN')}`,
  ];
  sectionLines.push(`default_tools_approval_mode = ${tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE)}`, '');

  return { sectionName, sectionLines };
}

// ── Local stdio section (C1382 — was the whole of buildCodexMcpSection pre-C1382,
// renamed and registered under 'tipatask-local' instead of 'tipatask'). Adds
// TIPATASK_MCP_LOCAL_ONLY=1 so the spawned server registers only the 4 tools that
// still need this transport — see src/mcp/server.js's own LOCAL_ONLY gate.
function buildCodexLocalMcpSection({ projectRoot, mcpServerPath, nodePath } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const resolvedMcpServerPath = path.resolve(mcpServerPath || DEFAULT_MCP_SERVER_PATH);
  const sectionName = `mcp_servers.${TIPATASK_MCP_LOCAL_NAME}`;

  const resolvedProjectRoot = path.resolve(projectRoot);
  // Server root = the checkout that ships the MCP server (src/mcp/server.js → up 2 dirs).
  const computedServerRoot = path.resolve(path.dirname(resolvedMcpServerPath), '../..');
  // The account token is shared by projects on one API server. A shell-launched Codex
  // does not inherit Electron's userData path, so the local MCP needs it explicitly.
  const userDataRoot = require('./server/account-store').userDataRoot({ serverRoot: computedServerRoot });

  // ── Packaged-asar branch ───────────────────────────────────────────────────
  // When the MCP server path is inside an .asar archive, plain-node / shell wrappers
  // cannot be spawned from it (app.asar is a regular file; posix_spawn hits ENOTDIR).
  // Mirror the pattern from project-config.js writeProjectMcpConfig: use the Electron
  // binary as a Node process (ELECTRON_RUN_AS_NODE=1) so it reads the asar transparently.
  // NODE_COMPILE_CACHE is omitted — it would point inside the read-only asar.
  if (_isAsarPath(resolvedMcpServerPath)) {
    return {
      sectionName,
      sectionLines: [
        `[${sectionName}]`,
        `command = ${tomlString(process.execPath)}`,
        `args = [${tomlString(resolvedMcpServerPath)}]`,
        `env = { ELECTRON_RUN_AS_NODE = "1", TIPATASK_PROJECT_ROOT = ${tomlString(resolvedProjectRoot)}, TIPATASK_SERVER_ROOT = ${tomlString(computedServerRoot)}, TIPATASK_USER_DATA = ${tomlString(userDataRoot)}, TIPATASK_MCP_LOCAL_ONLY = "1" }`,
        `default_tools_approval_mode = ${tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE)}`,
        '',
      ],
    };
  }

  // ── Dev / plain-node branch ────────────────────────────────────────────────
  // Use the portable wrapper script so Codex doesn't lock to the node binary that
  // happened to run setup. Falls back to any explicit nodePath override.
  const compileCacheDir = path.join(computedServerRoot, 'node_modules/.cache/v8-compile-cache');
  const wrapperName = process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node';
  const defaultCommand = path.join(computedServerRoot, 'bin', wrapperName);
  const command = nodePath || defaultCommand;

  return {
    sectionName,
    sectionLines: [
      `[${sectionName}]`,
      `command = ${tomlString(command)}`,
      `args = [${tomlString(resolvedMcpServerPath)}]`,
      `env = { NODE_COMPILE_CACHE = ${tomlString(compileCacheDir)}, TIPATASK_PROJECT_ROOT = ${tomlString(resolvedProjectRoot)}, TIPATASK_SERVER_ROOT = ${tomlString(computedServerRoot)}, TIPATASK_USER_DATA = ${tomlString(userDataRoot)}, TIPATASK_MCP_LOCAL_ONLY = "1" }`,
      `default_tools_approval_mode = ${tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE)}`,
      '',
    ],
  };
}

function writeCodexMcpConfig({ targetPath, projectRoot, mcpServerPath, nodePath, seedPath = null, browserTools = null, browserRuntime }) {
  const remote = buildCodexMcpSection({ projectRoot });
  const local = buildCodexLocalMcpSection({ projectRoot, mcpServerPath, nodePath });
  const existing = readOptional(targetPath);
  const globalSeed = seedPath ? readOptional(seedPath) : '';
  // Keep the historical first-write behavior (a new project starts from the full user
  // config), but never seed malformed TOML. Later writes also backfill missing
  // user preferences and MCP tables without replacing project overrides.
  if (existing.trim() && !parseTomlOptional(existing)) {
    throw new Error(`Invalid Codex configuration at ${targetPath}; existing file preserved`);
  }
  const seed = existing
    ? mergeGlobalCodexPreferences(mergeGlobalMcpServerTables(existing, globalSeed), globalSeed)
    : (parseTomlOptional(globalSeed) ? globalSeed : '');
  let out = removeTomlSections(seed, isMcpToolApprovalSection);
  out = removeTopLevelTomlKey(out, 'default_tools_approval_mode');
  // upsertTomlSection replaces a whole section body when present, so this cleanly
  // migrates a pre-C1382 file whose 'tipatask' section still holds the old stdio
  // command/args/env block — no separate detect-and-strip step needed.
  out = upsertTomlSection(out, remote.sectionName, remote.sectionLines);
  out = upsertTomlSection(out, local.sectionName, local.sectionLines);
  out = removeTipataskTransportKeys(out);
  // TPT95 — after both tipatask upserts, before the approve-mode sweep, so any preset
  // section this call writes inherits it too. `browserTools: null` (the default, and
  // always the case for the global ~/.codex/config.toml write) is a no-op.
  out = applyBrowserToolPresets(out, browserTools, browserRuntime);
  out = upsertKeyInAllMcpServerSections(out, 'default_tools_approval_mode', tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE));
  out = upsertTomlKey(out, 'features', 'guardian_approval', 'false');
  out = upsertProjectTrustLevel(out, projectRoot);
  const final = out.endsWith('\n') ? out : `${out}\n`;
  try { if (fs.readFileSync(targetPath, 'utf8') === final) return; } catch { /* absent */ }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, final, 'utf8');
}

function updateGlobalCodexMcpApprovalConfig({ targetPath, projectRoot, mcpServerPath, nodePath }) {
  if (!targetPath) throw new Error('targetPath is required');
  const existing = readOptional(targetPath);
  if (existing.trim() && !parseTomlOptional(existing)) {
    throw new Error(`Invalid Codex configuration at ${targetPath}; existing file preserved`);
  }
  let out = removeTomlSections(existing, isMcpToolApprovalSection);
  out = removeTopLevelTomlKey(out, 'default_tools_approval_mode');

  // Project registrations belong only to the project home. A global last-opened
  // project would route a plain shell launched in another checkout to the wrong API.
  out = removeTomlSections(out, name =>
    /^mcp_servers\.(tipatask|tipatask-local)(\.|$)/.test(name));

  out = removeTipataskTransportKeys(out);

  out = upsertKeyInAllMcpServerSections(out, 'default_tools_approval_mode', tomlString(CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE));
  out = upsertTomlKey(out, 'features', 'guardian_approval', 'false');
  out = upsertProjectTrustLevel(out, projectRoot);
  if (out === existing) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, out.endsWith('\n') ? out : `${out}\n`, 'utf8');
}

function ensureProjectAuthLink(paths) {
  if (!fs.existsSync(paths.globalAuthPath)) {
    return { ok: false, reason: 'global-auth-missing' };
  }

  let needsLink = false;
  try {
    const stat = fs.lstatSync(paths.projectAuthPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(paths.projectAuthPath);
      if (target === paths.globalAuthPath && fs.existsSync(paths.projectAuthPath)) {
        // Correct symlink pointing at a live target — nothing to do.
        return { ok: true, reason: 'already-linked' };
      }
      // Wrong target or dangling symlink — recreate.
      fs.rmSync(paths.projectAuthPath, { force: true });
      needsLink = true;
    } else {
      // Regular file: keep only when it parses as a JSON object (genuine standalone auth).
      // A materialized symlink (e.g. the path-string "/Users/.../.codex/auth.json" written
      // as plain text by git-checkout / rsync) is NOT valid JSON → replace with symlink.
      try {
        const raw = fs.readFileSync(paths.projectAuthPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ok: true, reason: 'project-auth-exists' };
        }
      } catch { /* not valid JSON — fall through to recreate */ }
      fs.rmSync(paths.projectAuthPath, { force: true });
      needsLink = true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    needsLink = true;
  }

  if (needsLink) {
    fs.mkdirSync(paths.projectCodexDir, { recursive: true });
    fs.symlinkSync(paths.globalAuthPath, paths.projectAuthPath);
    return { ok: true, reason: 'linked' };
  }
  return { ok: true, reason: 'linked' };
}

function ensureProjectCodexHome({ projectRoot, mcpServerPath, nodePath, browserTools } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const paths = getCodexPaths(projectRoot);
  // TPT95 — explicit `browserTools` overrides a disk read (needed since
  // readProjectConfig is mtime-cached, and for tests); otherwise read the project's
  // current MCP_BROWSER_TOOLS selection. Applied to the PROJECT config only — never
  // passed to updateGlobalCodexMcpApprovalConfig below, so ~/.codex/config.toml never
  // gains a preset section.
  const resolvedBrowserTools = browserTools !== undefined
    ? normalizeBrowserToolIds(browserTools)
    : readBrowserToolSelection(projectRoot);
  writeCodexMcpConfig({
    targetPath: paths.projectConfigPath,
    projectRoot,
    mcpServerPath,
    nodePath,
    seedPath: paths.globalConfigPath,
    browserTools: resolvedBrowserTools,
  });
  updateGlobalCodexMcpApprovalConfig({
    targetPath: paths.globalConfigPath,
    projectRoot,
    mcpServerPath,
    nodePath,
  });
  const auth = ensureProjectAuthLink(paths);
  return { ...paths, auth };
}

// ── Project-level Codex config writer ──────────────────────────────────────────
// Writes {projectRoot}/.codex/config.toml with the tipatask MCP entry and repairs
// the project-local auth.json symlink. Mirror of writeProjectMcpConfig / writeProjectSkillsConfig
// in project-config.js — call alongside those functions at every setup entry point
// (Open Project, Create Project, Re-authenticate, reconfigureWindowBackend).
//
// Also runs when projectRoot IS this checkout (dogfooding): .codex/ is gitignored here, so
// the machine-specific absolute paths it writes never reach VCS.
// Idempotent: delegates to ensureProjectCodexHome which already skips writes when the
// on-disk file matches (writeCodexMcpConfig now has an early-exit check).
function writeProjectCodexConfig(projectRoot, serverRoot) {
  const absProjectRoot = path.resolve(projectRoot);
  const absServerRoot = path.resolve(serverRoot);
  const wrapperName = process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node';
  ensureProjectCodexHome({
    projectRoot: absProjectRoot,
    mcpServerPath: path.join(absServerRoot, 'src', 'mcp', 'server.js'),
    nodePath: path.join(absServerRoot, 'bin', wrapperName),
  });
}

module.exports = {
  TIPATASK_MCP_NAME,
  TIPATASK_MCP_LOCAL_NAME,
  DEFAULT_MCP_SERVER_PATH,
  buildCodexMcpSection,
  buildCodexLocalMcpSection,
  CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE,
  ensureProjectCodexHome,
  getCodexPaths,
  listProjectMcpServerNames,
  buildScopedCodexMcpOverride,
  mcpSectionHasCommand,
  mergeGlobalMcpServerTables,
  mergeGlobalCodexPreferences,
  removeTopLevelTomlKey,
  removeTomlSections,
  upsertKeyInAllMcpServerSections,
  upsertProjectTrustLevel,
  upsertTopLevelTomlKey,
  upsertTomlSection,
  upsertTomlKey,
  updateGlobalCodexMcpApprovalConfig,
  writeCodexMcpConfig,
  writeProjectCodexConfig,
  // TPT95 — opt-in browser-tools MCP presets
  BROWSER_MCP_PRESETS,
  BROWSER_PRESET_MARKER,
  applyBrowserToolPresets,
  normalizeBrowserToolIds,
  readBrowserToolSelection,
  readRequiredNodeMajor,
  resolveBrowserMcpRuntime,
  tomlSectionExists,
  tomlSectionHasMarkerLine,
};
