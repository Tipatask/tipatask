'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { killProcessGroup } = require('./process-group');

const IS_WIN = process.platform === 'win32';

// Matches Unix nvm binary paths: ~/.nvm/versions/node/vX.Y.Z/bin/<name>
const NVM_BIN_RE = /^(.+\/\.nvm\/versions\/node\/[^/]+\/bin)\//;

// Windows launcher extensions in preference order. A CLI installed through npm ships three
// siblings in the same dir — an extensionless POSIX sh shim (`claude`), `claude.cmd` and
// `claude.ps1` — and `where` lists the bare shim first. Only these four extensions are ever
// accepted: the shim and the .ps1 cannot be spawned by CreateProcess, and the other PATHEXT
// members (.js/.vbs/...) would route through wscript. Intersected with PATHEXT at use time.
const WIN_LAUNCHER_EXTS = ['.exe', '.cmd', '.bat', '.com'];

// Launchers that are batch scripts, not PE images: CreateProcess cannot run them directly, and
// Node >= 20.12.2 / 22 refuses execFile()/spawn() of them without a shell (EINVAL, the
// CVE-2024-27980 fix). winExecSpec() routes these through cmd.exe.
const WIN_SHELL_EXTS = ['.cmd', '.bat'];

function winLauncherExts(pathext = process.env.PATHEXT) {
  if (!pathext) return WIN_LAUNCHER_EXTS.slice();
  const allowed = new Set(String(pathext).toLowerCase().split(';').map(e => e.trim()).filter(Boolean));
  const picked = WIN_LAUNCHER_EXTS.filter(e => allowed.has(e));
  return picked.length ? picked : WIN_LAUNCHER_EXTS.slice();
}

// Rank of a candidate path's extension within `exts` (0 = best); -1 for extensionless
// files and extensions outside the launcher list (e.g. .ps1).
function launcherRank(filePath, exts) {
  const ext = path.win32.extname(String(filePath || '')).toLowerCase();
  return ext ? exts.indexOf(ext) : -1;
}

// Picks the best launcher from `where` output (one path per line, PATH order): lowest
// extension rank wins, ties go to the earlier line, and nothing qualifies -> ''.
function selectWindowsLauncher(lines, { pathext } = {}) {
  const exts = winLauncherExts(pathext);
  const list = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let best = '';
  let bestRank = Infinity;
  for (const raw of list) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const rank = launcherRank(line, exts);
    if (rank < 0 || rank >= bestRank) continue;
    best = line;
    bestRank = rank;
    if (rank === 0) break;
  }
  return best;
}

// Dirs to probe when shell-based `which` fails, and to always prepend to PATH.
// Order: user-local installs (Claude Code installer default) before system-wide.
const PROBE_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),          // Claude Code installer (Linux/macOS)
  path.join(os.homedir(), '.codex', 'bin'),          // Codex CLI default install location
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
  ...(IS_WIN ? [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'), // default npm global on Windows
    path.join(                                            // Claude native Windows installer
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'AnthropicClaude'
    ),
  ] : [
    path.join(os.homedir(), '.claude', 'local'),     // Claude Code alt local installer target (macOS/Linux)
    '/opt/homebrew/bin',                             // Homebrew on Apple Silicon
    '/home/linuxbrew/.linuxbrew/bin',                // Homebrew on Linux
    '/usr/local/bin',                                // Homebrew on Intel / legacy
  ]),
];

// PATH separator is ':' on POSIX, ';' on Windows.
const PATH_SEP = IS_WIN ? ';' : ':';

// The Node binary this server process is itself running under. Always >= engines.node,
// unlike an arbitrary PATH `node`, which can be a stale system install (C1041: a
// root-owned Node 14 at /usr/local/bin/node outranked nvm in PROBE_DIRS order and crashed
// every hook subprocess at internal/modules/cjs/loader.js:888 on require('node:...')).
// Under a packaged Electron build, process.execPath is the Electron binary itself and its
// dir holds no `node` — the existence check below keeps that a harmless no-op.
const NODE_BIN_DIR = path.dirname(process.execPath);
const _nodeBinDirHasNode = (() => {
  try {
    fs.accessSync(path.join(NODE_BIN_DIR, IS_WIN ? 'node.exe' : 'node'), fs.constants.X_OK);
    return true;
  } catch { return false; }
})();

// --- Windows registry Path fallback -------------------------------------------------------
// A GUI-launched (or long-running) process keeps the PATH it was started with, so dirs the
// user added to the user/machine Path later — `%APPDATA%\npm` after an `npm i -g`, the native
// installer's `%LOCALAPPDATA%\Programs\...` — are invisible to `where` and to child spawns.
// The registry holds the live values; this is the win32 counterpart of captureLoginShellPath().
// User hive first, then machine: same "user-local before system-wide" order as PROBE_DIRS.
const REG_PATH_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
];

// `reg query <key> /v Path` output -> the raw (unexpanded) value, or '' when absent.
function parseRegQueryPath(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

// Expands %VAR% references case-insensitively from `env`; unknown names stay verbatim.
function expandWindowsEnv(str, env = process.env) {
  const lookup = new Map(Object.keys(env || {}).map(k => [k.toLowerCase(), env[k]]));
  return String(str || '').replace(/%([^%]+)%/g, (whole, name) => {
    const value = lookup.get(name.toLowerCase());
    return value == null ? whole : String(value);
  });
}

function _defaultRegExec() {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const regExe = path.join(sysRoot, 'System32', 'reg.exe');
  const cmd = _exists(regExe) ? regExe : 'reg';
  return (args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, windowsHide: true });
}

// Dirs from the user + machine registry Path values, %VAR%-expanded, de-duped (case-
// insensitive), user dirs first. Each hive is best-effort; a failing query contributes
// nothing. Never spawns off win32 unless an `exec` stub is injected (tests).
function readWindowsRegistryPathDirs({ exec, env = process.env, isWin = IS_WIN } = {}) {
  if (!isWin && !exec) return [];
  const run = exec || _defaultRegExec();
  const dirs = [];
  const seen = new Set();
  for (const key of REG_PATH_KEYS) {
    let stdout = '';
    try { stdout = run(['query', key, '/v', 'Path']); } catch { continue; }
    for (const entry of expandWindowsEnv(parseRegQueryPath(stdout), env).split(';')) {
      const dir = entry.trim();
      if (!dir) continue;
      const k = dir.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      dirs.push(dir);
    }
  }
  return dirs;
}

// Memoized; clearBinCache() (no name) resets it so a forced re-detection also picks up dirs
// added to the registry after this process started.
let _registryPathDirs = null;
function registryPathDirs() {
  if (_registryPathDirs === null) _registryPathDirs = IS_WIN ? readWindowsRegistryPathDirs() : [];
  return _registryPathDirs;
}

// Augmented PATH injected into every spawn env so child processes (MCP servers,
// hooks, subprocesses spawned by claude) don't inherit a stripped PATH.
// NODE_BIN_DIR goes first — ahead of PROBE_DIRS — so `node` always resolves to this
// server's own binary and never to a stale PROBE_DIRS/system `node` (C1041). PROBE_DIRS
// itself stays put; it's still needed to find Homebrew-Intel `claude`/`codex` binaries.
// Registry Path dirs (win32) are appended last: they only add what the inherited PATH
// lacks and never reorder it. Built on first use (not module load) so a PATH the host set
// after requiring this module — main.js's captureLoginShellPath() — is honored.
let _augmentedPath = null;
function augmentedPath() {
  if (_augmentedPath !== null) return _augmentedPath;
  const base = process.env.PATH || '';
  const dirs = [
    ...(_nodeBinDirHasNode ? [NODE_BIN_DIR] : []),
    ...PROBE_DIRS,
    ...base.split(PATH_SEP),
    ...registryPathDirs(),
  ];
  // De-dupe while preserving order (case-insensitive on Windows)
  const seen = new Set();
  _augmentedPath = dirs.filter((d) => {
    if (!d) return false;
    const k = IS_WIN ? d.toLowerCase() : d;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join(PATH_SEP);
  return _augmentedPath;
}

// One-time diagnostic for task item 1 (C1041) — stderr, never stdout: some hook scripts
// (push-kb-on-write.js) write a JSON hookSpecificOutput payload to stdout, and any stray
// stdout text ahead of it would corrupt that JSON.
if (_nodeBinDirHasNode) {
  console.error(`[spawn-utils] child node -> ${NODE_BIN_DIR} (${process.version})`);
}

const _binCache = {};
const _binInflight = new Map();
const _binGeneration = new Map();
function peekResolvedBin(name) { return _binCache[name]; }

const _firstLine = (lines) => (lines.find(l => l.trim()) || '').trim();

// `pickLine(lines)` chooses the result from the probe's stdout lines; win32 callers pass
// selectWindowsLauncher so a bare npm shim listed first by `where` never wins.
function _whichAsync(command, args, pickLine = _firstLine) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve(value);
    };
    const backstop = setTimeout(() => {
      if (child && child.pid && !killProcessGroup(child.pid, 'SIGKILL')) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
      finish('');
    }, 5500);
    try {
      child = execFile(command, args, {
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
        detached: !IS_WIN, windowsHide: true,
      }, (err, stdout) => finish(err ? '' : pickLine(String(stdout || '').split(/\r?\n/))));
    } catch {
      finish('');
    }
  });
}

// Detection must not enter resolveBin()'s synchronous login-shell probes on a cold cache.
// Match its search order and share its result cache; concurrent lookups share one search.
async function resolveBinAsync(name) {
  if (_binCache[name] !== undefined) return _binCache[name];
  const generation = _binGeneration.get(name) || 0;
  const pending = _binInflight.get(name);
  if (pending && pending.generation === generation) return pending.promise;
  const promise = (async () => {
    const envOverride = process.env[name.toUpperCase() + '_BIN'];
    if (envOverride) {
      const found = _findExecutable(envOverride);
      if (found) return found;
    }
    const bundled = resolveBundledBin(name);
    if (bundled) return bundled;
    if (IS_WIN) {
      const found = await _whichAsync('where', [name], selectWindowsLauncher);
      if (found) return found;
    } else {
      const login = await _whichAsync('/bin/sh', ['-lc', `command -v ${name}`]);
      if (login) return login;
      const userShell = process.env.SHELL;
      if (userShell && userShell !== '/bin/sh') {
        const interactive = await _whichAsync(userShell, ['-ilc', `command -v ${name}`]);
        if (interactive) return interactive;
      }
    }
    for (const dir of PROBE_DIRS) {
      const found = _findExecutable(path.join(dir, name));
      if (found) return found;
    }
    for (const dir of registryPathDirs()) {
      const found = _findExecutable(path.join(dir, name));
      if (found) return found;
    }
    const unixNvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    try {
      const versions = fs.readdirSync(unixNvmDir).sort().reverse();
      for (const ver of versions) {
        const found = _findExecutable(path.join(unixNvmDir, ver, 'bin', name));
        if (found) return found;
      }
    } catch { /* nvm not present */ }
    if (IS_WIN) {
      const nvmWinDir = process.env.NVM_HOME || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm');
      try {
        const versions = fs.readdirSync(nvmWinDir).filter(v => /^v?\d/.test(v)).sort().reverse();
        for (const ver of versions) {
          const found = _findExecutable(path.join(nvmWinDir, ver, name));
          if (found) return found;
        }
      } catch { /* nvm-windows not present */ }
    }
    return null;
  })().then((found) => {
    if ((_binGeneration.get(name) || 0) === generation) _binCache[name] = found;
    return found;
  }).finally(() => {
    if (_binInflight.get(name)?.promise === promise) _binInflight.delete(name);
  });
  _binInflight.set(name, { generation, promise });
  return promise;
}

// Check whether a path is executable. POSIX: the X_OK bit decides. Windows has no execute
// bit — X_OK degrades to F_OK — so an extensionless npm sh shim next to `claude.cmd` would
// pass a plain access() check and be handed to CreateProcess, which cannot run it. On win32
// the launcher extensions are therefore probed BEFORE the bare name: the path itself when it
// already carries a launcher extension, then `<path>.exe/.cmd/.bat/.com` in rank order, and
// the bare name last (only so an explicit `${NAME}_BIN` pointing at an odd file still works).
// `isWin`/`exts` are injectable so the win32 order is unit-testable on any host.
function _findExecutable(filePath, { isWin = IS_WIN, exts } = {}) {
  if (!filePath) return null;
  if (!isWin) {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return filePath;
    } catch { return null; }
  }
  const ranked = exts || winLauncherExts();
  const candidates = [];
  if (launcherRank(filePath, ranked) >= 0) candidates.push(filePath);
  for (const ext of ranked) candidates.push(filePath + ext);
  candidates.push(filePath);
  for (const candidate of candidates) {
    if (_exists(candidate)) return candidate;
  }
  return null;
}

// Check whether a path exists at all (no execute-bit requirement) — used to gate the bundled
// CLI branches below on "was this actually installed/staged", not "is it executable" (that's
// _findExecutable's job, applied once we know the launcher itself is there).
function _exists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

// cmd.exe to run a .cmd/.bat through: %ComSpec% (what Windows itself uses), else
// %SystemRoot%\System32\cmd.exe, else a bare `cmd.exe` resolved via PATH.
function _comSpec(env = process.env) {
  if (env && env.ComSpec) return env.ComSpec;
  const sysRoot = env && (env.SystemRoot || env.windir);
  return sysRoot ? path.win32.join(sysRoot, 'System32', 'cmd.exe') : 'cmd.exe';
}

// How to execFile()/execFileSync() a resolved launcher so it also works for a Windows .cmd/.bat
// (npm's `claude.cmd` / `codex.cmd`): Node >= 20.12.2 / 22 throws EINVAL on a shell-less exec
// of those (CVE-2024-27980 fix), so they are wrapped as `cmd.exe /d /s /c "<command line>"`.
// Anything else — .exe, POSIX paths, any host that is not win32 — passes through unchanged.
// Returns { command, args, options }; callers spread `options` into their own exec options:
//   const spec = winExecSpec(bin, ['--version']);
//   execFileSync(spec.command, spec.args, { ...spec.options, encoding: 'utf8', windowsHide: true });
// Quoting: every part is wrapped in "…" and the whole line once more (cmd's /s strips that outer
// pair), and `windowsVerbatimArguments: true` stops Node from re-quoting/backslash-escaping the
// line into something cmd.exe cannot parse. A part holding a double quote or a line break has no
// safe cmd encoding and is rejected (same rule as mcp-spawn-config.js's headersHelper command
// line). `%` is left alone: launcher paths come from `where`/the filesystem, already expanded.
// `isWin`/`env` are injectable so the win32 branch is unit-testable on any host.
function winExecSpec(binPath, args = [], { isWin = IS_WIN, env = process.env } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const ext = path.win32.extname(String(binPath || '')).toLowerCase();
  if (!isWin || !WIN_SHELL_EXTS.includes(ext)) return { command: binPath, args: list, options: {} };
  const parts = [String(binPath), ...list];
  for (const part of parts) {
    if (/["\r\n]/.test(part)) throw new Error(`winExecSpec: unquotable argument ${JSON.stringify(part)}`);
  }
  const line = `"${parts.map(p => `"${p}"`).join(' ')}"`;
  return {
    command: _comSpec(env),
    args: ['/d', '/s', '/c', line],
    options: { windowsVerbatimArguments: true },
  };
}

// (C1112) CLIs shipped as npm dependencies of this server instead of requiring the user to
// install them separately. Key = resolveBin() name, value = the npm package that provides it.
const BUNDLED_CLI_PACKAGES = { pi: '@earendil-works/pi-coding-agent' };

// <serverRoot> = this checkout's root — this file is <serverRoot>/src/server/spawn-utils.js.
// Deliberately __dirname-based, not config.SERVER_ROOT: config.js requires this module at its
// own top level (circular), and its TIPATASK_SERVER_ROOT override could point at a different
// checkout than the code actually executing.
const SERVER_ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Absolute launcher path for a CLI bundled as an npm dependency, or null when unavailable.
 * serverRoot is a parameter so this is unit-testable against a fixture tree.
 */
function resolveBundledBin(name, serverRoot = SERVER_ROOT_DIR) {
  const pkg = BUNDLED_CLI_PACKAGES[name];
  if (!pkg) return null;
  // Packaged Electron: node_modules lives inside app.asar — a single regular file, nothing can
  // posix_spawn through it — electron-builder drops node_modules/.bin entirely regardless
  // (NodeModuleCopyHelper topLevelExcludedFiles), and bin/** is excluded from build.files too.
  // Packaged runs resolve the CLI via resolvePiLaunch()'s extraResources branch instead.
  if (isAsarPath(serverRoot)) return null;
  // Package must actually be installed — a checkout that never ran `npm install` keeps falling
  // through to a system-wide install.
  if (!_exists(path.join(serverRoot, 'node_modules', ...pkg.split('/'), 'package.json'))) return null;
  // The bin/<name> wrapper picks the interpreter via bin/mcp-node; never trust the package's
  // own `#!/usr/bin/env node` shebang directly (see bin/pi header comment for why).
  return _findExecutable(path.join(serverRoot, 'bin', IS_WIN ? `${name}.cmd` : name));
}

function resolveBin(name) {
  if (_binCache[name] !== undefined) return _binCache[name];
  function _cache(v) { _binCache[name] = v; return v; }

  // Strategy 0: explicit override via env var (e.g. CODEX_BIN, CLAUDE_BIN in .env)
  const envOverride = process.env[name.toUpperCase() + '_BIN'];
  if (envOverride) {
    const found = _findExecutable(envOverride);
    if (found) return _cache(found);
  }

  // Strategy 0.5 (C1112): CLI bundled as an npm dependency. Ranked above the shell probes so
  // (a) the exact version this app is tested against wins over whatever the user happens to
  // have installed globally — providers/pi-session.js parses pi's JSONL event schema, so a
  // random global pi is a functional risk, not just a version mismatch — and (b) the common
  // case costs one stat() instead of two shell spawns with 5s timeouts. `${NAME}_BIN` (Strategy
  // 0 above) still overrides it — that's the documented escape hatch.
  const bundled = resolveBundledBin(name);
  if (bundled) return _cache(bundled);

  if (IS_WIN) {
    // Strategy 1 (Windows): where.exe — lists every PATH match (bare npm shim, .cmd, .ps1…)
    // in PATH order; selectWindowsLauncher keeps only a spawnable launcher, best rank first.
    try {
      const out = selectWindowsLauncher(
        execFileSync('where', [name], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split(/\r?\n/)
      );
      if (out) return _cache(out);
    } catch { /* fall through */ }
  } else {
    // Strategy 1: login shell `which` (picks up /etc/profile + ~/.bash_profile)
    try {
      const out = execFileSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }).trim();
      if (out) return _cache(out);
    } catch { /* fall through */ }

    // Strategy 2: user's interactive shell (picks up ~/.zshrc / ~/.bashrc)
    const userShell = process.env.SHELL;
    if (userShell && userShell !== '/bin/sh') {
      try {
        const out = execFileSync(userShell, ['-ilc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }).trim();
        if (out) return _cache(out);
      } catch { /* fall through */ }
    }
  }

  // Strategy 3: filesystem probe of well-known install directories
  for (const dir of PROBE_DIRS) {
    const found = _findExecutable(path.join(dir, name));
    if (found) return _cache(found);
  }

  // Strategy 3b (Windows): dirs from the live user/machine registry Path — covers a PATH
  // the process inherited before the CLI was installed. Empty off win32.
  for (const dir of registryPathDirs()) {
    const found = _findExecutable(path.join(dir, name));
    if (found) return _cache(found);
  }

  // Strategy 4a: Unix nvm — ~/.nvm/versions/node/*/bin/<name>
  const unixNvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(unixNvmDir).sort().reverse(); // newest first
    for (const ver of versions) {
      const found = _findExecutable(path.join(unixNvmDir, ver, 'bin', name));
      if (found) return _cache(found);
    }
  } catch { /* nvm not present */ }

  // Strategy 4b: nvm-windows — %NVM_HOME%\{version}\<name>[.cmd]
  // npm globals on nvm-windows are installed directly into the version dir alongside node.exe
  if (IS_WIN) {
    const nvmWinDir = process.env.NVM_HOME
      || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm');
    try {
      const versions = fs.readdirSync(nvmWinDir)
        .filter(v => /^v?\d/.test(v)) // skip non-version entries
        .sort().reverse();
      for (const ver of versions) {
        const found = _findExecutable(path.join(nvmWinDir, ver, name));
        if (found) return _cache(found);
      }
    } catch { /* nvm-windows not present */ }
  }

  // Unresolved — null lets callers surface a helpful error instead of ENOENT
  return _cache(null);
}

/**
 * Bust the resolveBin cache for the given binary name (or all entries when
 * name is omitted). Use before a forced re-detection so stale null entries
 * don't suppress a newly-installed binary.
 * @param {string} [name]
 */
function clearBinCache(name) {
  if (name === undefined) {
    for (const key of new Set([...Object.keys(_binCache), ..._binInflight.keys()])) clearBinCache(key);
    // Forced re-detection also re-reads the registry Path dirs (win32) and rebuilds the
    // augmented PATH from them, so a CLI installed after startup is found and spawnable.
    _registryPathDirs = null;
    _augmentedPath = null;
  } else {
    delete _binCache[name];
    _binInflight.delete(name);
    _binGeneration.set(name, (_binGeneration.get(name) || 0) + 1);
  }
}

// True when path p has an `.asar` path segment — an Electron-packaged bundle. A plain-node
// child (any hook or CLI spawned outside Electron) cannot posix_spawn through it (ENOTDIR:
// app.asar is a single regular file, not a directory) even though Electron's own patched
// fs/child_process read it transparently. Same regex as the private _isAsarPath in
// src/codex-mcp-config.js — kept in sync there; this copy is the exported canonical one.
function isAsarPath(p) {
  return typeof p === 'string' && /\.asar([\\/]|$)/.test(p);
}

// (C1112) How to launch Pi, beyond what a single resolveBin() path string can express. The
// packaged-Electron case needs a two-part command (`process.execPath <cliPath>`, not a plain
// executable), so this returns { command, argsPrefix, env } — callers do
// spawn(launch.command, [...launch.argsPrefix, ...args], { env: { ...env, ...launch.env } }).
//
// Order: PI_BIN env override > bundled checkout (bin/pi via resolveBundledBin) > packaged
// extraResources copy > system-wide install (login shell / PROBE_DIRS / nvm). The first two
// mirror resolveBin('pi') exactly; the packaged branch only ever matches when resolveBundledBin
// returned null because __dirname is inside app.asar (see resolveBundledBin's asar guard) —
// electron-builder's extraResources ships the Pi package as plain files at
// process.resourcesPath/pi/node_modules (staged by scripts/stage-pi-bundle.js), outside the
// asar and therefore spawnable, but on a runtime with no `node` next to process.execPath
// (packaged Electron never has one) — so it's launched via the Electron binary itself running
// as plain Node (ELECTRON_RUN_AS_NODE=1), the same trick used for the in-asar MCP entry point
// in codex-mcp-config.js / project-config.js.
function resolvePiLaunch(serverRoot = SERVER_ROOT_DIR) {
  const envOverride = process.env.PI_BIN;
  if (envOverride) {
    const found = _findExecutable(envOverride);
    if (found) return { command: found, argsPrefix: [], env: {} };
  }

  const bundled = resolveBundledBin('pi', serverRoot);
  if (bundled) return { command: bundled, argsPrefix: [], env: {} };

  if (process.resourcesPath) {
    const packagedCli = path.join(
      process.resourcesPath, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'
    );
    if (_exists(packagedCli)) {
      return { command: process.execPath, argsPrefix: [packagedCli], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }

  // Fall back to a system-wide install. resolveBin('pi') re-runs Strategy 0/0.5 too, but both
  // are memoized in _binCache, so that's free.
  const fallback = resolveBin('pi');
  return fallback ? { command: fallback, argsPrefix: [], env: {} } : null;
}

async function resolvePiLaunchAsync(serverRoot = SERVER_ROOT_DIR) {
  const envOverride = process.env.PI_BIN;
  if (envOverride) {
    const found = _findExecutable(envOverride);
    if (found) return { command: found, argsPrefix: [], env: {} };
  }
  const bundled = resolveBundledBin('pi', serverRoot);
  if (bundled) return { command: bundled, argsPrefix: [], env: {} };
  if (process.resourcesPath) {
    const packagedCli = path.join(process.resourcesPath, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (_exists(packagedCli)) {
      return { command: process.execPath, argsPrefix: [packagedCli], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  const fallback = await resolveBinAsync('pi');
  return fallback ? { command: fallback, argsPrefix: [], env: {} } : null;
}

// Resolves a TIPATASK_SERVER_ROOT value that a plain-node child can actually spawn out of
// (C1061). Unconditionally stamping config.SERVER_ROOT (as before) leaked the packaged
// app.asar path into every hook/CLI spawn env once __dirname resolved inside the bundle —
// `.claude/settings.json` hooks then tried `<asar>/bin/mcp-node` and hit
// "/bin/sh: ...app.asar/bin/mcp-node: Not a directory". Preference order:
//   1. this checkout (SERVER_ROOT_DIR, __dirname-based) when it isn't an asar path and holds
//      a real, executable bin/mcp-node — the normal dev / plain-clone case.
//   2. config.SERVER_ROOT (lazy require — config.js requires this module at its own top
//      level, so a top-level require here would be circular), when it isn't an asar path
//      and holds a real, executable bin/mcp-node (TIPATASK_SERVER_ROOT override case).
//   3. null — no spawnable root found (e.g. packaged app). Caller omits TIPATASK_SERVER_ROOT
//      entirely rather than handing a child an unusable path; the `.claude/settings.json`
//      hook commands fall back to their own baked-in default and self-guard from there.
// The project path is deliberately NOT a source of candidates: the Task App is a standalone
// checkout and never lives at a fixed location inside the projects it manages.
function resolveSpawnServerRoot(projectPath) { // eslint-disable-line no-unused-vars
  const wrapperName = IS_WIN ? 'mcp-node.cmd' : 'mcp-node';
  const candidates = [SERVER_ROOT_DIR];
  try {
    const { SERVER_ROOT } = require('./config');
    if (SERVER_ROOT) candidates.push(SERVER_ROOT);
  } catch { /* config not loadable in this context — skip */ }
  for (const dir of candidates) {
    if (isAsarPath(dir)) continue;
    if (_findExecutable(path.join(dir, 'bin', wrapperName))) return dir;
  }
  return null;
}

// Returns env object with probe dirs prepended to PATH.
// Pass binary-specific extras (TERM, task IDs, etc.) as the second argument.
// Stamps TIPATASK_SERVER_ROOT with a spawnable root (C1061 — see resolveSpawnServerRoot
// above) so a packaged Electron build's asar SERVER_ROOT never leaks into a project-scoped
// agent/hook spawn; extras can still override the result per caller (codex-env.js does,
// for its project-local CODEX_HOME wiring).
function augmentPathEnv(extras) {
  const projectPath = (extras && extras.TIPATASK_PROJECT_ROOT) || process.env.TIPATASK_PROJECT_ROOT;
  const serverRoot = resolveSpawnServerRoot(projectPath);
  const base = { ...process.env };
  if (serverRoot) base.TIPATASK_SERVER_ROOT = serverRoot;
  else delete base.TIPATASK_SERVER_ROOT; // never hand a child an unusable asar path
  return { ...base, ...extras, PATH: augmentedPath() };
}

// Resolves the model to pass on the CLI's --model flag, live-reading project
// config.json at spawn time so a settings-page edit takes effect on the very
// next task spawn — mirrors the getCredentials() live-read pattern used for
// API tokens (api-backend.js), fixing the class of bug where a stale exported
// env var (process.env.CLAUDE_MODEL) permanently shadowed config.json because
// config.js only snapshots process.env once at server startup.
// Precedence: per-task override (optsModel) > live config.json[field] > fallback.
// Never falls back to a hard-coded model id — callers pass the default explicitly.
function resolveSpawnModel(optsModel, projectRoot, field, fallback) {
  const trimmedOpt = typeof optsModel === 'string' ? optsModel.trim() : optsModel;
  if (trimmedOpt) return trimmedOpt;
  if (projectRoot) {
    const { readProjectConfig } = require('./project-config');
    let cfg;
    try { cfg = readProjectConfig(projectRoot); } catch { cfg = null; }
    const val = cfg && cfg[field];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return fallback;
}

// (C1057) Whether to ask Claude Code to emit a terminal-bell (\x07) notification signal via
// --settings preferredNotifChannel:terminal_bell — see claude-agent.js#getSpawnSpec and
// terminal-session.js#feedAttentionChunk(). Default true; a project can opt out with
// { "ATTENTION_TERMINAL_BELL": false } in .tipatask/config.json if a probe run
// (npm run probe:attention) ever finds --settings clobbers rather than merges the user's own
// Claude settings on some CLI version.
function resolveAttentionTerminalBell(projectRoot) {
  if (projectRoot) {
    const { readProjectConfig } = require('./project-config');
    let cfg;
    try { cfg = readProjectConfig(projectRoot); } catch { cfg = null; }
    if (cfg && cfg.ATTENTION_TERMINAL_BELL === false) return false;
  }
  return true;
}

// Per-project spawn environment: selected target, live account-store token, runtime
// tool paths and writable user-data location. Empty values clear inherited credentials.
// A missing explicit path resolves the active project before reading configuration.
// Shared by terminal agents and objective/task-chat providers.
function projectEnvExtras(projectPath) {
  if (!projectPath) projectPath = require('./project-root').resolveProjectRoot();
  const { readProjectConfig, CONFIG_FIELDS, piDefaultEntry, piKeyEnvVars } = require('./project-config');
  let cfg;
  try { cfg = readProjectConfig(projectPath); } catch { cfg = null; }
  const extras = {
    TIPATASK_PROJECT_ROOT: projectPath,
    TIPATASK_USER_DATA: require('./account-store').userDataRoot(),
    TIPATASK_TOOL_EXEC: process.execPath,
    TIPATASK_TOOL_SCRIPT: path.join(__dirname, '../cli/task-tools.js'),
    API_BASE_URL: '', API_PROJECT_ID: '', API_TOKEN: '', TIPATASK_API_TOKEN: '',
  };
  if (cfg) {
    for (const k of CONFIG_FIELDS) {
      if (k !== 'projectName' && cfg[k] != null && cfg[k] !== '') extras[k] = String(cfg[k]);
    }
    // The token is the signed-in account's, held app-level (account-store.js); a legacy
    // inline config.json value (copied by the loop above) is only the fallback.
    let account = null;
    try { account = require('./account-store').readAccount(cfg.API_BASE_URL); } catch { /* unreadable store: no token */ }
    if (account) extras.API_TOKEN = account.token;
    try { require('./account-store').assertTokenProject(extras.API_TOKEN, extras.API_PROJECT_ID); }
    catch { extras.API_TOKEN = ''; }
    // C1121 — PI_MODELS (array of {model,apiKey} rows) is now the sole source for
    // Pi's OpenRouter key; the flat OPENROUTER_API_KEY config.json field the loop above
    // reads is legacy-only (pre-C1121 projects). Row 0 wins when both are present — a
    // project re-configured through the new wizard should use its new key, not a stale
    // flat one left over from an earlier pass. (TPT163) The key lands under the env var of
    // the row's own provider — DEEPSEEK_API_KEY for a deepseek row, ANTHROPIC_API_KEY for an
    // anthropic one. (TPT188) piKeyEnvVars() yields nothing for a keyless row or a provider
    // with no key env var, so a blank key never overwrites an ambient value.
    Object.assign(extras, piKeyEnvVars(piDefaultEntry(cfg)));
  }
  return extras;
}

// If binPath is an NVM-installed binary, returns its parent bin dir so callers
// can prepend it to PATH and keep `env node` on the matching NVM version.
function resolveNvmBinDir(binPath) {
  if (!binPath) return null;
  // Unix nvm: ~/.nvm/versions/node/vX/bin/<name>
  const m = NVM_BIN_RE.exec(binPath);
  if (m) return m[1];
  // nvm-windows: %NVM_HOME%\{version}\<name>[.cmd] — node.exe lives in same dir
  if (IS_WIN) {
    const nvmWinDir = (process.env.NVM_HOME
      || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm')).replace(/\\/g, '/');
    const normalized = binPath.replace(/\\/g, '/');
    if (normalized.startsWith(nvmWinDir + '/')) {
      const rel = normalized.slice(nvmWinDir.length + 1);
      const version = rel.split('/')[0];
      return path.join(process.env.NVM_HOME
        || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm'), version);
    }
  }
  return null;
}

// Capture the user's full login-shell PATH once (e.g. on Electron startup) so
// GUI-launched processes — which inherit only the minimal launchd/systemd PATH —
// get the same PATH as a terminal session. Uses the same shell-probe strategy
// as resolveBin: user's $SHELL first, then /bin/sh login shell.
// Returns the captured PATH string, or null on failure/Windows.
function captureLoginShellPath() {
  if (IS_WIN) return null;
  const userShell = process.env.SHELL;
  const shells = userShell && userShell !== '/bin/sh'
    ? [[userShell, ['-ilc', 'echo "$PATH"']], ['/bin/sh', ['-lc', 'echo "$PATH"']]]
    : [['/bin/sh', ['-lc', 'echo "$PATH"']]];
  for (const [shell, args] of shells) {
    try {
      const out = execFileSync(shell, args, { encoding: 'utf8', timeout: 5000 }).trim();
      if (out && out.includes('/')) return out;
    } catch { /* try next */ }
  }
  return null;
}

module.exports = {
  resolveBin, resolveBinAsync, peekResolvedBin, clearBinCache, augmentPathEnv, augmentedPath,
  projectEnvExtras, resolveNvmBinDir, captureLoginShellPath, resolveSpawnModel,
  resolveAttentionTerminalBell, isAsarPath, resolveSpawnServerRoot, resolveBundledBin,
  resolvePiLaunch, resolvePiLaunchAsync, PROBE_DIRS,
  // Windows launcher/registry resolution (TPT558) — pure helpers, exported for tests
  WIN_LAUNCHER_EXTS, winLauncherExts, selectWindowsLauncher, parseRegQueryPath,
  expandWindowsEnv, readWindowsRegistryPathDirs, _findExecutable,
  // (TPT559) cmd.exe wrapper for exec'ing .cmd/.bat launchers under Node >= 22
  WIN_SHELL_EXTS, winExecSpec,
};
