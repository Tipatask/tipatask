'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { killProcessGroup, killWindowsChildTree } = require('./process-group');

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

// --- Single PATH key (TPT566) ------------------------------------------------------------------
// On Windows process.env's key is spelled `Path`; a plain-object copy keeps that spelling, so
// `{ ...process.env, PATH: x }` yields an env block carrying BOTH a stale `Path` and the new
// `PATH`. Which of two same-named-ignoring-case entries cmd.exe/CreateProcess resolves is
// undefined — npm's claude.cmd/codex.cmd then may not find `node`, and detection reports "not
// logged in". Every spawn env therefore holds exactly ONE PATH-named key, canonically spelled
// `PATH` (the spelling every `env.PATH` reader/writer in this codebase uses; the OS lookup is
// case-insensitive, so a child never notices the rename). POSIX env names are case-sensitive,
// so only the exact `PATH` key is touched there. `isWin` is injectable for tests.
function _pathKeys(env, isWin = IS_WIN) {
  if (!env) return [];
  return Object.keys(env).filter(k => (isWin ? k.toLowerCase() === 'path' : k === 'PATH'));
}

// Current PATH value of `env` regardless of key spelling ('' when absent).
function readPathEnv(env, { isWin = IS_WIN } = {}) {
  const keys = _pathKeys(env, isWin);
  if (!keys.length) return '';
  const exact = keys.includes('PATH') ? 'PATH' : keys[0];
  return env[exact] == null ? '' : String(env[exact]);
}

// Writes `value` to the one canonical `PATH` key, deleting every other-case duplicate. Mutates
// and returns `env`.
function setPathEnv(env, value, { isWin = IS_WIN } = {}) {
  for (const k of _pathKeys(env, isWin)) delete env[k];
  env.PATH = value == null ? '' : String(value);
  return env;
}

// Prepends `dir` to the env's PATH through setPathEnv() — the only sanctioned way to put an
// nvm/launcher dir ahead of a spawn env's PATH (never `env.PATH = dir + env.PATH`, which on
// win32 leaves the inherited `Path` behind). Falsy `dir` is a no-op (still collapses
// duplicates). Mutates and returns `env`.
function prependPathEnv(env, dir, { isWin = IS_WIN } = {}) {
  const current = readPathEnv(env, { isWin });
  if (!dir) return setPathEnv(env, current, { isWin });
  const sep = isWin ? ';' : ':'; // per call, so an injected isWin also picks the right separator
  return setPathEnv(env, current ? `${dir}${sep}${current}` : String(dir), { isWin });
}

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
  const base = readPathEnv(process.env); // `Path` spelling on win32, see setPathEnv()
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
const _piLaunchChecks = new Map();
const _piLaunchChoices = new Map();
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
// line), and so is a line past cmd.exe's own 8191-character limit (CMD_MAX_LINE). `%` is left
// alone: launcher paths come from `where`/the filesystem, already expanded — values that may hold
// anything (prompts, JSON, TOML) belong to cliSpawnSpec() below instead.
// `isWin`/`env` are injectable so the win32 branch is unit-testable on any host.
const CMD_MAX_LINE = 8191;

function winExecSpec(binPath, args = [], { isWin = IS_WIN, env = process.env } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const ext = path.win32.extname(String(binPath || '')).toLowerCase();
  if (!isWin || !WIN_SHELL_EXTS.includes(ext)) return { command: binPath, args: list, options: {} };
  const parts = [String(binPath), ...list];
  for (const part of parts) {
    if (/["\r\n]/.test(part)) throw new Error(`winExecSpec: unquotable argument ${JSON.stringify(part)}`);
  }
  const line = `"${parts.map(p => `"${p}"`).join(' ')}"`;
  if (line.length > CMD_MAX_LINE) {
    throw new Error(`winExecSpec: command line of ${line.length} characters exceeds cmd.exe's ${CMD_MAX_LINE}-character limit`);
  }
  return {
    command: _comSpec(env),
    args: ['/d', '/s', '/c', line],
    options: { windowsVerbatimArguments: true },
  };
}

// --- npm cmd-shim resolution (TPT575) ----------------------------------------------------------
// npm writes a global CLI's Windows launcher (`claude.cmd`, `codex.cmd`, `gemini.cmd`, `pi.cmd`)
// with cmd-shim: a batch file whose exec line runs node on the package's bin script,
//   "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*     (npm >= 7)
//   node  "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*          (legacy npm / yarn)
// where `_prog` is <shim dir>\node.exe when present, else `node` from PATH — or, for a bin with
// no shebang, the target itself ("%dp0%\node_modules\pkg\tool.exe" %*). resolveWindowsCmdShim()
// reads that back into { command, argsPrefix }, so the CLI is spawned with no cmd.exe in between:
// no cmd quoting rules, no %VAR% expansion of the arguments, no 8191-character line limit, and a
// kill reaches the CLI process itself. Anything else returns null — a shim that sets variables of
// its own (pnpm's NODE_PATH, `env -S` shebang variables), a program other than node, a custom
// wrapper such as this checkout's bin/pi.cmd or Node's own npm.cmd, or a target that does not
// exist — and cliSpawnSpec() falls back to winExecSpec(). `env` is the spawn env: its PATH and
// PATHEXT decide the node lookup, exactly as they would for cmd.exe. `readFile`/`exists` are test
// seams; paths are handled with the host's `path`, so the resolver also runs on POSIX test hosts.
const SHIM_MAX_BYTES = 64 * 1024;
const SHIM_VARS = new Set(['dp0', '_prog', 'pathext']);
const SHIM_DP0_RE = /%~dp0|%dp0%/gi;
const SHIM_NODE_PROG_RE = /^(?:(?:%~dp0|%dp0%)\\+)?node(?:\.exe)?$/i;

// A Windows path from a shim as a host path. `%dp0%` ends in `\` and cmd-shim appends `\<target>`,
// so the joined path carries a doubled separator that path.normalize() folds.
function _shimHostPath(p) {
  return path.normalize(path.sep === '\\' ? String(p) : String(p).replace(/\\/g, '/'));
}

// Case-insensitive env lookup: a plain-object copy of process.env keeps Windows' own key spelling.
function _envValue(env, name) {
  const key = Object.keys(env || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined || env[key] == null ? '' : String(env[key]);
}

// The `node` cmd.exe would run for a shim's bare `node`: the first PATH dir holding a launcher-
// extension `node` decides, and only a node.exe found there can be spawned directly.
function _findShimNode(env, exists) {
  const exts = winLauncherExts(_envValue(env, 'PATHEXT'));
  for (const raw of readPathEnv(env, { isWin: true }).split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(_shimHostPath(dir), `node${ext}`);
      if (exists(candidate)) return ext === '.exe' ? candidate : null;
    }
  }
  return null;
}

// Tokens of a shim exec line with the trailing `%*` dropped, or null when the line does not end in
// `%*`. The command is the last `&`-separated segment outside quotes (npm >= 7 prefixes it with
// `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & `); a leading `@` is cmd's echo-off.
function _shimExecTokens(line) {
  let segment = '';
  let quoted = false;
  for (const ch of String(line)) {
    if (ch === '"') quoted = !quoted;
    if (ch === '&' && !quoted) { segment = ''; continue; }
    segment += ch;
  }
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(segment.trim().replace(/^@/, ''))) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens.pop() === '%*' ? tokens : null;
}

function resolveWindowsCmdShim(cmdPath, { env = process.env, readFile = fs.readFileSync, exists = _exists } = {}) {
  let text;
  try { text = String(readFile(cmdPath, 'utf8')); } catch { return null; }
  if (!text || text.length > SHIM_MAX_BYTES) return null;
  const dir = path.dirname(_shimHostPath(cmdPath));
  const expand = token => _shimHostPath(token.replace(SHIM_DP0_RE, () => `${dir}${path.sep}`));
  const progs = [];
  const execLines = [];
  for (const line of text.split(/\r?\n/)) {
    const set = /^\s*@?set\s+"?([^=\s"]+)=([^"]*)"?\s*$/i.exec(line);
    if (set) {
      const name = set[1].toLowerCase();
      if (!SHIM_VARS.has(name)) return null;
      if (name === '_prog') progs.push(set[2].trim());
    } else if (line.includes('%*')) {
      execLines.push(line);
    }
  }
  const isNodeProg = token => (/^%_prog%$/i.test(token)
    ? progs.length > 0 && progs.every(v => SHIM_NODE_PROG_RE.test(v))
    : SHIM_NODE_PROG_RE.test(token));
  let found = null;
  for (const line of execLines) {
    const tokens = _shimExecTokens(line);
    if (!tokens || !tokens.length) return null;
    let parsed;
    if (isNodeProg(tokens[0]) && tokens.length >= 2) {
      const rest = tokens.slice(1);
      if (rest.some(t => t.replace(SHIM_DP0_RE, '').includes('%'))) return null;
      parsed = { flags: rest.slice(0, -1), script: expand(rest[rest.length - 1]) };
    } else if (tokens.length === 1 && /^(?:%~dp0|%dp0%)/i.test(tokens[0])) {
      const target = expand(tokens[0]);
      if (target.includes('%') || !['.exe', '.com'].includes(path.extname(target).toLowerCase())) return null;
      parsed = { target };
    } else {
      return null;
    }
    // The legacy template's two branches must launch the same thing.
    if (found && JSON.stringify(found) !== JSON.stringify(parsed)) return null;
    found = parsed;
  }
  if (!found) return null;
  if (found.target) return exists(found.target) ? { command: found.target, argsPrefix: [] } : null;
  if (!exists(found.script)) return null;
  const local = path.join(dir, 'node.exe');
  const node = exists(local) ? local : _findShimNode(env, exists);
  return node ? { command: node, argsPrefix: [...found.flags, found.script] } : null;
}

// How to spawn() a resolved CLI launcher on every platform (TPT575). Returns { command, args,
// options }; callers spread `options` LAST into their own spawn options:
//   const spec = cliSpawnSpec(bin, args, { env });
//   spawn(spec.command, spec.args, { cwd, env, stdio, detached: true, ...spec.options });
// POSIX: the launcher and `args` unchanged and `options: {}`, so the call is byte-identical to a
// plain spawn(bin, args, …). win32: `options` always carries { detached: false, windowsHide: true }
// — a detached child gets no console, so each console process it starts (the CLI behind a
// launcher, its MCP servers) opens a visible window, and with no process groups on Windows
// detaching buys nothing (callers tree-kill instead: process-group.js killWindowsChildTree()). A
// .cmd/.bat launcher runs as the program its npm shim launches (resolveWindowsCmdShim), so the
// argv reaches the CLI verbatim whatever it holds — quotes, line breaks, `%`, any length up to
// CreateProcess's 32,767-character line; any other batch file goes through winExecSpec()'s cmd.exe
// wrapper, which throws for an argument cmd cannot carry. `env` is the spawn env (shim node
// lookup, ComSpec); `isWin`/`readFile`/`exists` are test seams.
function cliSpawnSpec(binPath, args = [], { isWin = IS_WIN, env = process.env, readFile, exists } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (!isWin) return { command: binPath, args: list, options: {} };
  const options = { detached: false, windowsHide: true };
  const ext = path.win32.extname(String(binPath || '')).toLowerCase();
  if (!WIN_SHELL_EXTS.includes(ext)) return { command: binPath, args: list, options };
  const shim = resolveWindowsCmdShim(binPath, { env, readFile, exists });
  if (shim) return { command: shim.command, args: [...shim.argsPrefix, ...list], options };
  const wrapped = winExecSpec(binPath, list, { isWin, env });
  return { command: wrapped.command, args: wrapped.args, options: { ...options, ...wrapped.options } };
}

// (TPT575) A value a Windows command line cannot carry goes to a file the CLI reads instead —
// `claude --append-system-prompt-file`, a `--mcp-config` path. CreateProcess caps the whole line
// at 32,767 characters (the objective system prompt alone carries the static KB bundle), and a
// cmd.exe-wrapped launcher cannot quote `"` or line breaks at all. Files are content-addressed
// under <userDataRoot>/spawn-args/, so concurrent spawns of the same text share one file that is
// never rewritten while a CLI may be reading it (a new file is written to a temp name and
// renamed into place). Reusing a file refreshes its mtime; files unused for
// SPAWN_ARG_FILE_MAX_AGE_MS are pruned, at most once per SPAWN_ARG_PRUNE_INTERVAL_MS. Returns the
// absolute path, or null when the file cannot be written. `now` is a test seam.
const SPAWN_ARG_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SPAWN_ARG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let _lastSpawnArgPrune = 0;

function _pruneSpawnArgFiles(dir, keep, now) {
  if (now - _lastSpawnArgPrune < SPAWN_ARG_PRUNE_INTERVAL_MS) return;
  _lastSpawnArgPrune = now;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    if (file === keep) continue;
    try {
      if (now - fs.statSync(file).mtimeMs > SPAWN_ARG_FILE_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch { /* removed by a concurrent prune */ }
  }
}

function writeSpawnArgFile(userDataRoot, text, ext = '.txt', { now = Date.now() } = {}) {
  if (!userDataRoot) return null;
  const content = text == null ? '' : String(text);
  const dir = path.join(userDataRoot, 'spawn-args');
  const file = path.join(dir, crypto.createHash('sha256').update(content).digest('hex').slice(0, 32) + ext);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (_exists(file)) {
      try { fs.utimesSync(file, new Date(now), new Date(now)); } catch { /* still usable */ }
    } else {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        if (!_exists(file)) throw err; // else a concurrent writer renamed the same bytes in first
      }
    }
  } catch {
    return null;
  }
  _pruneSpawnArgFiles(dir, file, now);
  return file;
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
  if (!name || name === 'pi') {
    _piLaunchChecks.clear();
    _piLaunchChoices.clear();
  }
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

function packagedPiLaunch() {
  if (!process.resourcesPath) return null;
  const cli = path.join(process.resourcesPath, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  if (!_exists(cli)) return null;
  // The Windows app executable is a GUI program. A successful piped --version
  // check does not establish that its interactive stdin/stdout work in ConPTY.
  // All packaged Windows Pi launches use a console Node runtime instead.
  if (IS_WIN) return {
    command: path.join(process.resourcesPath, 'pi', 'node_modules', 'tipatask-node', 'node.exe'),
    argsPrefix: [cli], env: { ELECTRON_RUN_AS_NODE: '' },
  };
  return { command: process.execPath, argsPrefix: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function piFileFingerprint(file) {
  try { const stat = fs.statSync(file); return `${file}:${stat.size}:${stat.mtimeMs}`; }
  catch { return file; }
}

function piLaunchKey(launch) {
  const node = path.join(process.resourcesPath, 'pi', 'node_modules', 'tipatask-node', 'node.exe');
  const key = [launch.command, ...launch.argsPrefix, node].map(piFileFingerprint).join('|');
  const choice = _piLaunchChoices.get(key);
  // A system Node can be upgraded independently of the app and its staged CLI.
  if (choice && choice.fingerprint !== piFileFingerprint(choice.launch.command)) {
    _piLaunchChoices.delete(key);
    _piLaunchChecks.delete(key);
  }
  return key;
}

// (TPT9047) Windows Pi runtime verification runs in stages, each with its own deadline, so a
// failure names the layer that broke and a healthy-but-cold install is never mistaken for a dead
// runtime. Measured on a 4-vCPU Windows 11 ARM64 VM with Defender real-time protection on:
//   runtime  `node.exe --version`                                 ~35 ms
//   import   one ESM file (dist/config.js) printing Pi's VERSION  ~0.4 s cold, ~0.1 s warm
//   cli      `cli.js --version` — Pi imports its whole dist tree (~19k files) before it prints:
//            ~0.7 s warm, ~17 s on a cold file cache (first run after install or reboot, every
//            file read and scanned once); an x64 build under ARM emulation is slower still.
// One 5 s budget used to cover all three, so a cold start overran it on every runtime and the
// bundled and the system Node failed alike with a message that blamed the runtimes.
const PI_STAGE_TIMEOUT_MS = Object.freeze({ runtime: 5000, import: 15000, cli: 60000 });
const PI_STAGES = Object.freeze(['runtime', 'import', 'cli']);

// Full argv of one stage. `--version` is appended only where it means Node's or Pi's version:
// after `-e` it would make Node print its own version and skip the import.
function piStageArgs(stage, cli) {
  if (stage === 'runtime') return ['--version'];
  if (stage === 'import') {
    const config = pathToFileURL(path.join(path.dirname(cli), 'config.js')).href;
    return ['--input-type=module', '-e', `import(${JSON.stringify(config)}).then(m => process.stdout.write(String(m.VERSION)))`];
  }
  return [cli, '--version'];
}

// Run one probe with a bound on output and lifetime. On the deadline the captured child tree is
// taken (Windows: taskkill /T) and `killed` records whether that succeeded; `elapsedMs` is wall
// time from spawn to settle, so a timeout and a slow success are both measured.
function probePackagedPi(launch, args) {
  const timeoutMs = launch.timeoutMs;
  return new Promise(resolve => {
    let child;
    let settled = false;
    const started = Date.now();
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve({ ...result, elapsedMs: Date.now() - started });
    };
    const stop = () => {
      if (IS_WIN) return killWindowsChildTree(child);
      if (child?.pid && !killProcessGroup(child.pid, 'SIGKILL')) {
        try { child.kill('SIGKILL'); } catch { return false; }
      }
      return true;
    };
    const backstop = setTimeout(() => {
      const killed = stop();
      finish({ error: Object.assign(new Error('Pi runtime probe timed out'), { code: 'ETIMEDOUT' }), status: null, output: '', stdout: '', killed });
    }, timeoutMs);
    try {
      child = execFile(launch.command, args, {
        env: augmentPathEnv({ PI_SKIP_VERSION_CHECK: '1', ...launch.env }),
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        finish({ error, status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          output: [stdout, stderr].filter(Boolean).join('\n').trim(), stdout: String(stdout || '').trim() });
      });
    } catch (error) {
      finish({ error, status: null, output: '', stdout: '' });
    }
  });
}

// Search every node.exe, not only resolveBin('node')'s first hit: a stale system install
// must not hide a compatible registry/nvm-windows runtime. Never accept npm shell shims.
function systemPiNodes() {
  const dirs = augmentedPath().split(PATH_SEP);
  const nvmRoot = process.env.NVM_HOME || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm');
  try {
    dirs.push(...fs.readdirSync(nvmRoot).filter(v => /^v?\d/.test(v)).sort().reverse()
      .map(v => path.join(nvmRoot, v)));
  } catch { /* nvm-windows not present */ }
  const seen = new Set();
  return dirs.filter(Boolean).map(dir => path.join(dir.replace(/^"(.*)"$/, '$1'), 'node.exe'))
    .filter(file => {
      const key = file.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
}

function piNodeMeetsEngine(version, engine) {
  // The app declares a >=X.Y.Z floor. Reject unknown ranges/versions rather than running
  // Pi under a runtime whose compatibility we could not establish.
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engine || '');
  const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!min || !current) return false;
  for (let i = 1; i <= 3; i++) {
    if (+current[i] !== +min[i]) return +current[i] > +min[i];
  }
  return true;
}

// One line per attempted runtime for an error message or a log: the stage that ended the
// attempt, how long it took against its deadline, and what it printed (or why it failed).
function describePiRuntimeCheck(check) {
  const where = check.stage ? ` ${check.stage} stage ${check.elapsedMs ?? '?'}ms/${check.timeoutMs}ms` : '';
  return `${check.runtime} (${check.command})${where}: ${check.output || 'empty output'}`;
}

// Verify the packaged Windows launch: the bundled console Node first, then every compatible
// system Node, each through the runtime → import → cli stages above. The verified launch carries
// `runtimeChecks` (one entry per attempted runtime with its `stages`) and `piVersion` (the exact
// version `cli.js --version` printed), so the agent's detect() can trust it without re-importing
// Pi. A failure throws `EPI_RUNTIME` with the same `runtimeChecks`, the failing attempt's summary
// (`stage`, `elapsedMs`, `timeoutMs`) and a message that lists every attempt.
async function verifyPackagedPiLaunch(launch) {
  const key = piLaunchKey(launch);
  if (_piLaunchChecks.has(key)) return _piLaunchChecks.get(key);
  const pending = (async () => {
    const cli = launch.argsPrefix[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8'));
    const node = path.join(process.resourcesPath, 'pi', 'node_modules', 'tipatask-node', 'node.exe');
    const engine = require('../../package.json').engines.node;
    const checks = [];
    let lastCandidate, lastProbe;
    const skip = (candidate, output) => {
      checks.push({ runtime: candidate.runtime, command: candidate.command, stage: null, timeoutMs: null,
        elapsedMs: null, exit: null, output, stages: [] });
    };
    const verify = async candidate => {
      lastCandidate = candidate;
      const entry = { runtime: candidate.runtime, command: candidate.command, stages: [] };
      checks.push(entry);
      for (const stage of PI_STAGES) {
        const timeoutMs = PI_STAGE_TIMEOUT_MS[stage];
        const probe = lastProbe = await probePackagedPi({ ...candidate, timeoutMs }, piStageArgs(stage, cli));
        let failure = null;
        if (probe.error) failure = probe.output || probe.error.code || probe.error.message;
        else if (stage === 'runtime' && !piNodeMeetsEngine(probe.stdout, engine)) {
          failure = `Node ${probe.stdout || 'empty version'} does not satisfy ${engine}`;
        } else if (stage !== 'runtime' && probe.stdout !== manifest.version) {
          failure = probe.output ? `expected Pi ${manifest.version}, got ${probe.output}` : 'empty output';
        }
        const record = { stage, ok: !failure, timeoutMs, elapsedMs: probe.elapsedMs, exit: probe.status,
          output: String(failure ?? probe.stdout).slice(0, 200), ...(probe.killed === undefined ? {} : { killed: probe.killed }) };
        entry.stages.push(record);
        Object.assign(entry, record);
        if (stage === 'runtime' && !failure) entry.nodeVersion = probe.stdout;
        if (failure) return null;
      }
      const verified = { ...candidate, runtimeChecks: checks, piVersion: manifest.version, verifiedAt: Date.now() };
      if (_piLaunchChecks.get(key) === pending) {
        _piLaunchChoices.set(key, { launch: verified, fingerprint: piFileFingerprint(candidate.command) });
      }
      return verified;
    };
    const bundled = { command: node, argsPrefix: [cli], env: { ELECTRON_RUN_AS_NODE: '' }, runtime: 'bundled-node' };
    if (_exists(node)) {
      const verified = await verify(bundled);
      if (verified) return verified;
    } else {
      skip(bundled, 'bundled node.exe is missing');
    }
    const nodes = systemPiNodes();
    if (!nodes.length) {
      skip({ runtime: 'system-node', command: 'node.exe' }, `system node.exe not found (requires ${engine})`);
    }
    for (const command of nodes) {
      const verified = await verify({ command, argsPrefix: [cli], env: { ELECTRON_RUN_AS_NODE: '' }, runtime: 'system-node' });
      if (verified) return verified;
    }
    const why = checks.map(describePiRuntimeCheck).join('; ');
    const failed = checks.findLast(check => check.stage) || checks.at(-1) || {};
    throw Object.assign(new Error(`Pi runtime verification failed (expected Pi ${manifest.version}; ${why})`), {
      code: 'EPI_RUNTIME', launch: lastCandidate,
      stage: failed.stage || null, elapsedMs: failed.elapsedMs ?? null, timeoutMs: failed.timeoutMs ?? null,
      runtime: failed.runtime || null, stageOutput: failed.output || '',
      probe: { ...lastProbe, output: `Expected Pi ${manifest.version}; ${why}` },
      runtimeChecks: checks,
    });
  })();
  _piLaunchChecks.set(key, pending);
  try { return await pending; }
  catch (error) {
    if (_piLaunchChecks.get(key) === pending) _piLaunchChecks.delete(key);
    error.launch ||= launch;
    throw error;
  }
}

// (C1112) How to launch Pi, beyond what a single resolveBin() path string can express. The
// packaged-Electron case needs a two-part command (`process.execPath <cliPath>`, not a plain
// executable), so this returns { command, argsPrefix, env } — callers do
// spawn(launch.command, [...launch.argsPrefix, ...args], { env: { ...env, ...launch.env } }).
//
// Order: PI_BIN env override > bundled checkout (bin/pi via resolveBundledBin) > packaged
// extraResources copy (Windows: bundled Node > compatible system Node)
// > system-wide Pi install (login shell / PROBE_DIRS / nvm). The first two
// mirror resolveBin('pi') exactly; the packaged branch only ever matches when resolveBundledBin
// returned null because __dirname is inside app.asar (see resolveBundledBin's asar guard) —
// electron-builder's extraResources ships the Pi package as plain files at
// process.resourcesPath/pi/node_modules (staged by scripts/stage-pi-bundle.js), outside the
// asar and therefore spawnable, but on a runtime with no `node` next to process.execPath
// (packaged Electron never has one). POSIX uses Electron run-as-node, the same mechanism as
// the in-asar MCP entry point. Windows instead ships a console Node executable under
// tipatask-node, with a verified compatible system Node as its fallback.
function resolvePiLaunch(serverRoot = SERVER_ROOT_DIR) {
  const envOverride = process.env.PI_BIN;
  if (envOverride) {
    const found = _findExecutable(envOverride);
    if (found) return { command: found, argsPrefix: [], env: {} };
  }

  const bundled = resolveBundledBin('pi', serverRoot);
  if (bundled) return { command: bundled, argsPrefix: [], env: {} };

  const packaged = packagedPiLaunch();
  if (packaged) return (IS_WIN && _piLaunchChoices.get(piLaunchKey(packaged))?.launch) || packaged;

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
  const packaged = packagedPiLaunch();
  if (packaged) return IS_WIN ? verifyPackagedPiLaunch(packaged) : packaged;
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
  // setPathEnv() after merging extras: the inherited win32 `Path` (and any `Path` an extras
  // object carries) is collapsed into the single canonical `PATH` key (TPT566).
  return setPathEnv({ ...base, ...extras }, augmentedPath());
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
    extras.language = require('./project-config').readProjectLanguage(projectPath);
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
  PI_STAGE_TIMEOUT_MS, PI_STAGES, piStageArgs, describePiRuntimeCheck, probePackagedPi,
  // Windows launcher/registry resolution (TPT558) — pure helpers, exported for tests
  WIN_LAUNCHER_EXTS, winLauncherExts, selectWindowsLauncher, parseRegQueryPath,
  expandWindowsEnv, readWindowsRegistryPathDirs, _findExecutable,
  // (TPT559) cmd.exe wrapper for exec'ing .cmd/.bat launchers under Node >= 22
  WIN_SHELL_EXTS, winExecSpec, CMD_MAX_LINE,
  // (TPT575) spawning any CLI launcher (npm cmd-shim resolution) + files for oversized argv values
  resolveWindowsCmdShim, cliSpawnSpec, writeSpawnArgFile, SPAWN_ARG_FILE_MAX_AGE_MS,
  // (TPT566) single-PATH-key env writers — the only way to set/prepend a spawn env's PATH
  readPathEnv, setPathEnv, prependPathEnv,
};
