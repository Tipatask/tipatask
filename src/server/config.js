'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { resolveBin, isAsarPath } = require('./spawn-utils');

// Resolve back to this checkout's root (two levels up from src/server/).
// TIPATASK_SERVER_ROOT overrides the default so MCP child processes read the
// spawning project's .env. Codex task terminals prepare project-local
// .codex/config.toml before spawn and set CODEX_HOME to that directory.
// C1061 guard: an inherited TIPATASK_SERVER_ROOT pointing inside a packaged Electron
// app.asar is unusable by a plain-node process (asar is a single regular file — only
// Electron's patched fs/child_process, i.e. process.versions.electron set, can read
// through it). A plain-node child (this process) resolving it verbatim would produce a
// path nothing downstream can spawn out of. Fall back to the real on-disk default and warn
// instead of silently propagating the bad path.
const _envServerRoot = process.env.TIPATASK_SERVER_ROOT
  ? path.resolve(process.env.TIPATASK_SERVER_ROOT)
  : null;
const _rejectAsarServerRoot = _envServerRoot && isAsarPath(_envServerRoot) && !process.versions.electron;
if (_rejectAsarServerRoot) {
  console.warn(`[config] ignoring TIPATASK_SERVER_ROOT=${_envServerRoot} — points inside an app.asar bundle, unusable by this plain-node process; falling back to on-disk default`);
}
const SERVER_ROOT = (_envServerRoot && !_rejectAsarServerRoot)
  ? _envServerRoot
  : path.resolve(__dirname, '../..');

// Writable state root: userData dir when packaged, same as SERVER_ROOT in dev.
// Set by main.js via TIPATASK_USER_DATA = app.getPath('userData') when packaged.
const USER_DATA_ROOT = process.env.TIPATASK_USER_DATA
  ? path.resolve(process.env.TIPATASK_USER_DATA)
  : SERVER_ROOT;

function parseEnvFile(filePath, excludedKeys = null) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim();
    if ((!excludedKeys || !excludedKeys.has(key)) && !(key in process.env)) out[key] = val;
  }
  return out;
}

// Migrate/sanitize legacy config before taking the startup snapshot. This runs for
// the self-hosted Tipatask repo as well as external projects.
// The project root is never derived from this checkout's location (see project-root.js):
// TIPATASK_PROJECT_ROOT, else the nearest ancestor of cwd holding .tipatask/config.json,
// else cwd. The Task App can be cloned anywhere.
const { resolveProjectRoot } = require('./project-root');
const PROJECT_ROOT_EARLY = resolveProjectRoot();
const {
  readProjectConfig,
  CONFIG_FIELDS,
  API_CREDENTIAL_FIELDS,
  migrateFromLegacy,
  migrateLegacyApiToken,
} = require('./project-config');
const { readAccount } = require('./account-store');
migrateFromLegacy(PROJECT_ROOT_EARLY);
// Lift an inline config.json API_TOKEN into the app-level account store (no-op when absent).
migrateLegacyApiToken(PROJECT_ROOT_EARLY);
const _startupProjectCfg = readProjectConfig(PROJECT_ROOT_EARLY) || {};
// The signed-in account's token lives in the account store, keyed by the project's API server.
const _startupToken = readAccount(_startupProjectCfg.API_BASE_URL)?.token || _startupProjectCfg.API_TOKEN || '';

// Merge per-project config BEFORE legacy .env so project config wins.
// parseEnvFile skips keys already in process.env, so order determines precedence:
//   env var (set before process start) > project config.json > legacy .env > default
// EXCEPTIONS: CLAUDE_MODEL/CODEX_MODEL and API credentials are deliberately
// excluded from this generic seed. Models use their dedicated precedence below.
// API credentials are explicitly overwritten from config.json so stale exported
// variables and legacy .env values cannot shadow a refreshed project token.
// C953: CLAUDE_MODEL/CODEX_MODEL are deliberately excluded from this
// seed — a stale exported env var (e.g. a forgotten `export CLAUDE_MODEL=...` in a
// shell profile) would otherwise permanently shadow config.json edits, since this
// block only runs once at startup and config.CLAUDE_MODEL below is a static
// snapshot, not a live getter. The model fields are instead read fresh from
// config.json below (config.json > env > default) and re-read live at spawn time
// via spawn-utils.resolveSpawnModel(). See tt-project-config.md for the precedence
// writeup.
const _CONFIG_ENV_SEED_SKIP = new Set([
  'projectName',
  'CLAUDE_MODEL',
  'CODEX_MODEL',
  'PI_MODEL',
  // C1121 — NAME COLLISION GUARD. config.json's PI_MODELS is an ARRAY of {model,apiKey}
  // rows (the wizard's multi-model "Other Model" picker); process.env.PI_MODELS /
  // config.PI_MODELS below is an unrelated comma-separated STRING list — the objective
  // chat-model-selector's Pi allowlist (see _modelList('PI_MODELS', ...) below). Seeding
  // the array here would stringify to "[object Object],[object Object]" and poison that
  // dropdown. Consuming the array's rows is C1122+ (registry.js configForProject()) —
  // this task only guards against the collision.
  'PI_MODELS',
  // TPT440 — agent resource limits are resolved per project by process-group.js
  // resolveAgentLimits() (env > config.json > default). Seeding the startup project's
  // values into process.env would make them win over every other project's config.
  'AGENT_LIMITS_MAX_CONCURRENT_SESSIONS',
  'AGENT_LIMITS_MAX_SUBAGENTS',
  'AGENT_LIMITS_WARN_DESCENDANTS',
  'AGENT_LIMITS_MAX_TREE_RSS_MB',
  'AGENT_LIMITS_WATCHDOG_ACTION',
  ...API_CREDENTIAL_FIELDS,
]);
for (const [key, val] of Object.entries(_startupProjectCfg)) {
  // typeof guard: env vars are strings — any object/array config value would otherwise
  // stringify to garbage. Generic so a future array-valued config key can't repeat the
  // PI_MODELS collision above.
  if (!_CONFIG_ENV_SEED_SKIP.has(key) && val != null && val !== '' && typeof val !== 'object'
      && !(key in process.env)) {
    process.env[key] = val;
  }
}

// Credential env vars are still populated for child agents/raw curl workflows,
// but config.json is their only source. Missing/blank config values clear any
// stale value inherited from the parent shell.
for (const key of API_CREDENTIAL_FIELDS) {
  const val = key === 'API_TOKEN' ? _startupToken : _startupProjectCfg[key];
  if (val != null && val !== '') process.env[key] = String(val);
  else delete process.env[key];
}

// Load .env from writable location (userData when packaged, SERVER_ROOT in dev)
Object.assign(
  process.env,
  parseEnvFile(path.join(USER_DATA_ROOT, '.env'), new Set(API_CREDENTIAL_FIELDS))
);

const PROJECT_ROOT = PROJECT_ROOT_EARLY; // project root (env → cwd walk-up → cwd)

// (C1318) The SAME env value as PROJECT_ROOT above, EXCEPT it stays `null` instead of
// falling back to the cwd-based guess. That guess is only meaningful in dev, where the
// server is started from inside (or below) the project. Packaged, the forked server child
// starts with an arbitrary cwd, so the guess lands on an unrelated directory — main.js
// never sets TIPATASK_PROJECT_ROOT for the forked server child by design (see
// main/window-state.js's own note: this one server process is shared across every open
// project window, so there is no single project to bind at fork time). Callers that need to
// tell "a real project is genuinely bound" apart from "nothing is bound, don't guess" —
// isSingletonUnbound() (index.js) and boot-kb-sync.js's fallback-root resolution — read this
// instead of PROJECT_ROOT, which can't make that distinction and stays the existing fallback
// for its ~80 other call sites (spawn cwd, architecture-doc paths, per-session defaults), all
// of which already prefer a real per-request/session projectPath ahead of it.
const BOUND_PROJECT_ROOT = process.env.TIPATASK_PROJECT_ROOT
  ? path.resolve(process.env.TIPATASK_PROJECT_ROOT)
  : null;

// (C1318) Even a genuinely-bound projectRoot must never itself contain the running asar (i.e.
// be the bundle, or an ancestor of it) — writing there would silently repeat the exact same
// signed-bundle-corruption regression (see assertWritableDataDir below) via a different code
// path than the one actually found broken. Exported below (config.containsPath) so other call
// sites — api-backend.js's/recipes-store.js's per-project recipe dir, in particular — apply the
// identical bundle-containment rule instead of duplicating it.
function containsPath(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// (C1346) TRIPWIRE — called by recipes-store.js#ensureRecipesDir() right before its mkdir.
// Every known path that could produce an in-asar data root is guarded upstream (BOUND_
// PROJECT_ROOT staying null when nothing is genuinely bound, main.js's own TIPATASK_USER_DATA,
// and the per-project containment check above). If one is ever reintroduced, fail with a
// diagnostic that names the cause instead of a bare `ENOTDIR: not a directory, mkdir …` — an
// app.asar is a single regular file, not a directory, so mkdir into it is the shape every bug
// in this lineage takes (C1061 hook spawns, C1141/C1318 the since-retired DATA_ROOT, C1284 perf
// log, C1346 recipes).
function assertWritableDataDir(dir, label = 'data dir') {
  if (isAsarPath(dir)) {
    throw new Error(
      `[config] refusing to write ${label} inside a packaged app.asar: ${dir} — app.asar is a ` +
      `single regular file, not a directory (mkdir would fail with ENOTDIR). This means ` +
      `TIPATASK_USER_DATA was not set on this process (see main.js) or a project root resolved ` +
      `onto the app bundle.`
    );
  }
}

const DIST = path.join(SERVER_ROOT, 'dist');

// Lazy binary resolution — delegates to spawn-utils.resolveBin which probes
// login shell, interactive shell, and common install dirs (handles ~/.local/bin
// on M1 Macs where claude is installed via the official installer).
function _lazyBin(name) {
  return resolveBin(name) || name;
}

// C1030 — GEMINI_MODELS/PI_MODELS list builder. envKey overrides with a comma-separated
// list when set; ensureDefault is always unioned in so the provider's configured default
// model (GEMINI_MODEL/PI_MODEL) is never rejected by registry.js isValidSelection().
function _modelList(envKey, defaults, ensureDefault) {
  const raw = process.env[envKey];
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : defaults.slice();
  if (ensureDefault && !list.includes(ensureDefault)) list.push(ensureDefault);
  return list;
}

// C1101 — PI_MODEL mirrors CLAUDE_MODEL/CODEX_MODEL's config.json-over-env precedence
// (C953): a project's saved "Other Model" choice must win over a stale exported shell
// var. Hoisted so PI_MODELS' ensureDefault union (below) uses the same resolved value —
// otherwise a per-project custom model could still be rejected by isValidSelection().
const _resolvedPiModel = (typeof _startupProjectCfg.PI_MODEL === 'string' && _startupProjectCfg.PI_MODEL.trim())
  || process.env.PI_MODEL || 'openrouter/anthropic/claude-3.5-sonnet';

const config = {
  PORT: process.env.PORT || 4455,
  SERVER_ROOT,
  USER_DATA_ROOT,
  DIST,
  PROJECT_ROOT,
  BOUND_PROJECT_ROOT,
  MAX_SCROLLBACK: parseInt(process.env.MAX_SCROLLBACK, 10) || 128 * 1024,
  // config.json wins over process.env here (see C953 note above) — a value already
  // exported in the shell must not permanently override a project's saved model
  // choice. Non-terminal callers (objective/spec chat via claude-session.js) read
  // this static snapshot; terminal task spawns re-read config.json live instead
  // (spawn-utils.resolveSpawnModel), so both paths end up config.json-authoritative.
  CLAUDE_MODEL: (typeof _startupProjectCfg.CLAUDE_MODEL === 'string' && _startupProjectCfg.CLAUDE_MODEL.trim())
    || process.env.CLAUDE_MODEL || 'opusplan',
  CODEX_MODEL: (typeof _startupProjectCfg.CODEX_MODEL === 'string' && _startupProjectCfg.CODEX_MODEL.trim())
    || process.env.CODEX_MODEL || '',
  // Available model option lists — keep in sync with client src/client/constants.js CLAUDE_MODELS / CODEX_MODELS / GEMINI_MODELS / PI_MODELS
  CLAUDE_MODELS: ['opusplan', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'],
  CODEX_MODELS: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  PI_MODEL: _resolvedPiModel,
  // C1030 — GEMINI_MODELS/PI_MODELS env override (comma-separated), else built-in default
  // list, always unioned with the configured GEMINI_MODEL/PI_MODEL above so a custom
  // default never fails registry.js isValidSelection(). No reliable way to enumerate these
  // CLIs' real model lists from this environment (gemini --help crashes under a login-shell
  // Node too old for its bundle — the exact mismatch NODE_BIN_DIR in gemini-session.js
  // works around) — so this is a user-editable default, not a verified enumeration.
  GEMINI_MODELS: _modelList('GEMINI_MODELS', ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], process.env.GEMINI_MODEL || 'gemini-2.5-flash'),
  PI_MODELS: _modelList('PI_MODELS', ['openrouter/anthropic/claude-3.5-sonnet', 'openrouter/openai/gpt-4o'], _resolvedPiModel),
  // Canonical selectable-provider list lives in providers/registry.js SELECTABLE_PROVIDERS —
  // this allowlist just needs to be a superset so a legacy env-var provider choice is never
  // silently dropped back to 'claude'.
  OBJECTIVE_PROVIDER: (['claude', 'codex', 'gemini', 'pi'].includes(process.env.OBJECTIVE_PROVIDER) ? process.env.OBJECTIVE_PROVIDER : 'claude'),
  TASK_AGENT: process.env.TASK_AGENT || 'claude',
  AVAILABLE_AGENTS: (process.env.AVAILABLE_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  // (C1352) The file task backend is retired — "file" only remains reachable via a stale
  // config, which task-backend.js's coerceBackendType() coerces to "api" at the factory.
  TASK_BACKEND: process.env.TASK_BACKEND || 'api',
  API_BASE_URL: _startupProjectCfg.API_BASE_URL || '',
  API_TOKEN: _startupToken,
  API_PROJECT_ID: _startupProjectCfg.API_PROJECT_ID || '',
  USER_NAME: process.env.USER_NAME || '',
  USER_ID: parseInt(process.env.USER_ID, 10) || 1,
  USER_AVATAR_URL: '',
  DEVICE_ID: parseInt(process.env.DEVICE_ID, 10) || 0,
  DEVICE_NAME: process.env.DEVICE_NAME || '',
  PLANS_DIR: path.join(require('node:os').homedir(), '.claude', 'plans'),
  SHOW_AI_STATS: process.env.SHOW_AI_STATS === 'true',
  SIMPLE_MODE: process.env.SIMPLE_MODE === 'true',
  CONTEXT_MAX_INPUT_TOKENS: parseInt(process.env.CONTEXT_MAX_INPUT_TOKENS, 10) || 120000,
  CONTEXT_MAX_MESSAGES: parseInt(process.env.CONTEXT_MAX_MESSAGES, 10) || 20,
  CONTEXT_TRIM_KEEP_MESSAGES: parseInt(process.env.CONTEXT_TRIM_KEEP_MESSAGES, 10) || 4,
  OBJECTIVE_STREAM_IDLE_MS: parseInt(process.env.OBJECTIVE_STREAM_IDLE_MS, 10) || 60000,
  OBJECTIVE_MAX_RETRIES: parseInt(process.env.OBJECTIVE_MAX_RETRIES, 10) || 2,
  OBJECTIVE_RETRY_BACKOFF_MS: parseInt(process.env.OBJECTIVE_RETRY_BACKOFF_MS, 10) || 250,
  OBJECTIVE_MAX_NUDGES: parseInt(process.env.OBJECTIVE_MAX_NUDGES, 10) || 1,
  OBJECTIVE_TURN_MAX_MS: parseInt(process.env.OBJECTIVE_TURN_MAX_MS, 10) || 600000,
  OBJECTIVE_EFFORT: process.env.OBJECTIVE_EFFORT || 'medium',
  OBJECTIVE_SLOW_TURN_MS: parseInt(process.env.OBJECTIVE_SLOW_TURN_MS, 10) || 60000,
  OBJECTIVE_SLOW_REQUEST_MS: parseInt(process.env.OBJECTIVE_SLOW_REQUEST_MS, 10) || 88000,
  OBJECTIVE_TIMING_ENABLED: process.env.OBJECTIVE_TIMING_ENABLED !== 'false',
  OBJECTIVE_TIMING_VERBOSE: process.env.OBJECTIVE_TIMING_VERBOSE === 'true',
  // Default OFF (opt-in with OBJECTIVE_HEARTBEAT_ENABLED=true). Every ping is a full-context
  // `claude --resume`; when enabled it is additionally gated on real wall-clock cache age and
  // capped per idle period (see armHeartbeat/spawnHeartbeat in claude-session.js).
  OBJECTIVE_HEARTBEAT_ENABLED: process.env.OBJECTIVE_HEARTBEAT_ENABLED === 'true',
  OBJECTIVE_HEARTBEAT_MS: parseInt(process.env.OBJECTIVE_HEARTBEAT_MS, 10) || 240000,
  // Max consecutive keepalive pings with no real user turn in between; reset by the next turn.
  OBJECTIVE_HEARTBEAT_MAX_PINGS: parseInt(process.env.OBJECTIVE_HEARTBEAT_MAX_PINGS, 10) || 3,
  OBJECTIVE_PREWARM_ENABLED: process.env.OBJECTIVE_PREWARM_ENABLED !== 'false',
  OBJECTIVE_PREWARM_TTL_MS: parseInt(process.env.OBJECTIVE_PREWARM_TTL_MS, 10) || 240000,
  OBJECTIVE_DEBUG_STARTUP: process.env.OBJECTIVE_DEBUG_STARTUP === 'true',
  OBJECTIVE_PREFETCH_ARCH_CHAR_LIMIT: parseInt(process.env.OBJECTIVE_PREFETCH_ARCH_CHAR_LIMIT, 10) || 10000,
  OBJECTIVE_EARLY_FINALIZE: process.env.OBJECTIVE_EARLY_FINALIZE !== 'false',
  OBJECTIVE_CB_TIMEOUT_THRESHOLD: parseInt(process.env.OBJECTIVE_CB_TIMEOUT_THRESHOLD, 10) || 5,
  OBJECTIVE_CB_OPEN_MS: parseInt(process.env.OBJECTIVE_CB_OPEN_MS, 10) || 30000,
  OBJECTIVE_QUEUE_MAX: parseInt(process.env.OBJECTIVE_QUEUE_MAX, 10) || 100,
  OBJECTIVE_MAX_CONCURRENT: parseInt(process.env.OBJECTIVE_MAX_CONCURRENT, 10) || 10,
  OBJECTIVE_API_TIMEOUT_MS: parseInt(process.env.OBJECTIVE_API_TIMEOUT_MS, 10) || 30000,
  OBJECTIVE_EFFICIENCY_TIMEOUT_MS: parseInt(process.env.OBJECTIVE_EFFICIENCY_TIMEOUT_MS, 10) || 30000,
  OBJECTIVE_HEARTBEAT_TIMEOUT_MS: parseInt(process.env.OBJECTIVE_HEARTBEAT_TIMEOUT_MS, 10) || 30000,
  OBJECTIVE_FINALIZE_TIMEOUT_MS: parseInt(process.env.OBJECTIVE_FINALIZE_TIMEOUT_MS, 10) || 60000,
  OBJECTIVE_EARLY_KILL_GRACE_MS: parseInt(process.env.OBJECTIVE_EARLY_KILL_GRACE_MS, 10) || 200,
  // How long an objective session whose socket closed mid-turn waits for a reattach (page reload)
  // before teardownObjectiveSession() kills the in-flight turn. Idle heartbeat/prewarm stop at once.
  OBJECTIVE_DETACH_GRACE_MS: parseInt(process.env.OBJECTIVE_DETACH_GRACE_MS, 10) || 2000,
  OBJECTIVE_DEFER_EFFICIENCY: process.env.OBJECTIVE_DEFER_EFFICIENCY !== 'false',
  OBJECTIVE_HISTORY_COMPRESS_ENABLED: process.env.OBJECTIVE_HISTORY_COMPRESS_ENABLED !== 'false',
  OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS: parseInt(process.env.OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS, 10) || 3,
  OBJECTIVE_HISTORY_COMPRESS_TIMEOUT_MS: parseInt(process.env.OBJECTIVE_HISTORY_COMPRESS_TIMEOUT_MS, 10) || 10000,
  // C1029 — chat-model-selector (objective-chat provider/model switching)
  OBJECTIVE_HANDOFF_MAX_CHARS: parseInt(process.env.OBJECTIVE_HANDOFF_MAX_CHARS, 10) || 120000,
  OBJECTIVE_CODEX_STREAM_IDLE_MS: parseInt(process.env.OBJECTIVE_CODEX_STREAM_IDLE_MS, 10) || 180000,
  // Codex CLI emits no token-level deltas (verified: a whole turn arrives as one
  // item.completed) — its stdout can go quiet for minutes between turn.started and the
  // final item while it reasons/tools, so it gets a longer idle budget than the
  // token-streaming providers' shared OBJECTIVE_STREAM_IDLE_MS (60s default).
  OBJECTIVE_MODEL_SWITCH_RESUME: process.env.OBJECTIVE_MODEL_SWITCH_RESUME !== 'false',
  // default true — Claude's `--resume <id>` with a changed `--model` keeps prior context
  // (verified against a live claude CLI turn). Flip to false to route model-only changes
  // through the same full-transcript handoff a provider switch uses, as a rollback.
  MIME: {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  },
};

Object.defineProperty(config, 'CLAUDE_BIN',  { get: () => _lazyBin('claude'),  enumerable: true, configurable: true });
Object.defineProperty(config, 'CODEX_BIN',   { get: () => _lazyBin('codex'),   enumerable: true, configurable: true });
Object.defineProperty(config, 'GEMINI_BIN',  { get: () => _lazyBin('gemini'),  enumerable: true, configurable: true });
Object.defineProperty(config, 'PI_BIN',      { get: () => _lazyBin('pi'),      enumerable: true, configurable: true });

// (C1318/C1346) Exposed so other modules (api-backend.js, recipes-store.js) apply the
// identical bundle-containment / in-asar guards instead of duplicating them. Pure fns, no
// module state.
config.containsPath = containsPath;
config.assertWritableDataDir = assertWritableDataDir;

module.exports = config;
