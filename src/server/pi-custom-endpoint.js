'use strict';

// Generate project-local Pi models.json for a custom OpenAI-compatible endpoint.
// Point Pi at that agent directory and keep sessions in their usual location.
// Never write the row's secret to disk or argv: models.json references the key's
// environment variable. Keyless endpoints use a non-secret placeholder because
// Pi hides models without configured auth.
// Also home to the row-capability helpers both spawn paths share: whether a row's model takes
// tools at all, the sentence shown when it does not, and which row a task terminal may run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PI_PROVIDERS,
  PI_CUSTOM_PROVIDER,
  normalizePiProvider,
  normalizePiApi,
  isPiCustomEntry,
  piProviderEnv,
  readPiEntries,
  piEntryForModel,
  readProjectConfig,
} = require('./project-config');

const PI_CUSTOM_KEY_ENV = PI_PROVIDERS[PI_CUSTOM_PROVIDER].envKey;
const PI_CUSTOM_NO_KEY = 'tipatask-no-key';
const PI_CUSTOM_ID_PREFIX = 'tipatask-custom-';

// ── Pure ────────────────────────────────────────────────────────────────────

// The provider id the generated models.json declares for a custom row — and the value passed to
// Pi's --provider. Derived from what makes two rows one endpoint (url + api) plus whether they
// carry a key, so rows on the same endpoint share one block while a block's apiKey stays uniform
// (a `$VAR` block and a placeholder block never mix). Independent of row order, so a
// recordLastUsedAgent() reorder never renames a provider.
function piCustomProviderId(entry) {
  const keyed = entry && entry.apiKey ? '1' : '0';
  const seed = `${entry && entry.baseUrl}\n${normalizePiApi(entry && entry.api)}\n${keyed}`;
  return PI_CUSTOM_ID_PREFIX + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
}

// The --provider value for a readPiEntries() row (or null → the default provider): a built-in
// row's own id, exactly as before, or the generated block id for a custom row. Both Pi spawn
// paths pass this instead of piProviderEnv(entry).provider.
function piSpawnProvider(entry) {
  return isPiCustomEntry(entry) ? piCustomProviderId(entry) : piProviderEnv(entry).provider;
}

function _hostOf(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return String(baseUrl); }
}

// (TPT634) Whether a readPiEntries() row's model takes tool definitions. Only a custom row can say
// it does not (`tools: false`, kept by sanitizePiModels()); every built-in row, and null (the
// legacy OpenRouter default), is tool-capable. A headless objective turn on such a row runs with
// no tools from the first attempt; a task terminal or a task/project chat refuses to start.
function piRowSupportsTools(entry) {
  return !(isPiCustomEntry(entry) && entry.tools === false);
}

// Where a PI_MODELS row's requests go, for user-facing error copy: a custom row's endpoint host,
// otherwise the provider's label (OpenRouter, DeepSeek, …). A null/legacy row is OpenRouter.
function piRowHost(entry) {
  if (isPiCustomEntry(entry)) {
    try { return new URL(entry.baseUrl).host || String(entry.baseUrl); } catch { return String(entry.baseUrl); }
  }
  return PI_PROVIDERS[normalizePiProvider(entry && entry.provider)].label;
}

// The one sentence every surface shows for a model without tool support: the model, where it
// runs, why, what to do. `declared` (the row sets `tools: false`) replaces the reason a
// tool-compat failure gives, where the endpoint itself rejected the request.
function toolCompatMessage(model, host, { declared = false } = {}) {
  const why = declared ? 'its PI_MODELS row sets tools: false' : 'the endpoint rejected the request';
  return `Model "${model}" at ${host} does not support tool calls (${why}). Choose a tool-capable model.`;
}

// The row a Pi task terminal runs when no model is named: the first row whose model takes tools —
// row 0 unless it sets `tools: false`. A tool-less row 0 stays the objective-chat default, but must
// not block a task start while a tool-capable row exists. null when no row takes tools.
function piTaskDefaultEntry(cfg) {
  return readPiEntries(cfg).find((entry) => piRowSupportsTools(entry)) || null;
}

// Whether a requested model id may run a Pi task terminal: { entry } for a configured row whose model
// takes tools; otherwise { entry: null, reason } — 'unknown' (not one of the project's PI_MODELS rows)
// or 'no-tools' (its row sets tools: false). ws-handlers.js checks the launch-time pick and a task's
// saved pi_model with this; either miss falls back to the task default (piTaskDefaultEntry()).
function piTaskEntryForModel(cfg, modelId) {
  const entry = piEntryForModel(cfg, modelId);
  if (!entry) return { entry: null, reason: 'unknown' };
  if (!piRowSupportsTools(entry)) return { entry: null, reason: 'no-tools' };
  return { entry, reason: null };
}

// The models.json object for a set of rows. Non-custom rows are ignored. Deliberately built from
// ALL the project's custom rows, not just the one being spawned: the file is then a pure function
// of config, so two concurrent spawns (a terminal task + an objective-chat turn on different rows)
// write identical bytes and neither can remove the block the other still needs.
function buildPiModelsJson(entries) {
  const blocks = new Map();
  for (const e of entries || []) {
    if (!isPiCustomEntry(e)) continue;
    const id = piCustomProviderId(e);
    let block = blocks.get(id);
    if (!block) {
      block = { baseUrl: e.baseUrl, api: normalizePiApi(e.api), keyed: !!e.apiKey, models: new Set() };
      blocks.set(id, block);
    }
    block.models.add(e.model);
  }
  const providers = {};
  for (const id of [...blocks.keys()].sort()) {
    const b = blocks.get(id);
    providers[id] = {
      name: `Custom endpoint (${_hostOf(b.baseUrl)})`,
      baseUrl: b.baseUrl,
      api: b.api,
      apiKey: b.keyed ? `$${PI_CUSTOM_KEY_ENV}` : PI_CUSTOM_NO_KEY,
      models: [...b.models].sort().map((modelId) => ({ id: modelId })),
    };
  }
  return { providers };
}

function serializePiModelsJson(entries) {
  return JSON.stringify(buildPiModelsJson(entries), null, 2) + '\n';
}

// Pi expands a leading `~` in PI_CODING_AGENT_DIR (utils/paths.js normalizePath); mirror just that.
function _expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Pi's own agent dir for a given spawn env — what it would use if we did NOT override it.
function piRealAgentDir(env) {
  const fromEnv = env && env.PI_CODING_AGENT_DIR;
  return fromEnv ? path.resolve(_expandTilde(String(fromEnv))) : path.join(os.homedir(), '.pi', 'agent');
}

// Pi's default per-cwd session directory, <agentDir>/sessions/--<cwd, separators and ':' → '-'>--
// (dist/core/session-manager.js getDefaultSessionDirPath — private there, so hand-mirrored;
// pi-custom-endpoint.test.js checks it against the bundled Pi's own SessionManager). Pointing
// PI_CODING_AGENT_SESSION_DIR at it keeps sessions of a relocated-agent-dir spawn in the store
// every other spawn (and `pi --resume`) uses, so `--session <uuid>` resume works across a switch
// between a custom row and any other row.
function piDefaultSessionDir(cwd, env) {
  const safe = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(piRealAgentDir(env), 'sessions', safe);
}

// ── Side effects ────────────────────────────────────────────────────────────

// <dir>/.gitignore containing `*` — the generated dir ignores itself, so it never lands in a
// user's commit whatever their root .gitignore says. (Same trick as attachment-paths.js's private
// seedGitignore, which is not exported.)
function _seedSelfIgnore(dir) {
  const gitignore = path.join(dir, '.gitignore');
  try { if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n', 'utf8'); } catch { /* best effort */ }
}

// Writes <projectRoot>/.pi/agent/models.json for `entries`' custom rows. Idempotent (skips the
// write when the bytes already match — no mtime churn) and atomic (tmp + rename, same pattern as
// writeProjectConfig()). Never throws: a failure is logged and reported, and the spawn carries on
// — Pi's own `Unknown provider "tipatask-custom-…"` then names the real problem.
function writePiModelsJson(projectRoot, entries) {
  const dir = path.join(projectRoot, '.pi', 'agent');
  const file = path.join(dir, 'models.json');
  const content = serializePiModelsJson(entries);
  try {
    fs.mkdirSync(dir, { recursive: true });
    _seedSelfIgnore(dir);
    try { if (fs.readFileSync(file, 'utf8') === content) return { dir, file, changed: false, error: null }; } catch { /* absent */ }
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return { dir, file, changed: true, error: null };
  } catch (e) {
    console.warn(`[pi] could not write models.json (${file}): ${e.message}`);
    return { dir, file, changed: false, error: e };
  }
}

// The one entry point both Pi spawn paths (task-agent/pi-agent.js getSpawnSpec(), providers/
// pi-session.js spawnPiTurn()) call once they know which row they run on. Returns
// { provider, env }: `provider` for --provider, `env` to merge into the spawn env.
//   • non-custom row (or null) → { provider: <its id>, env: {} }, and NOTHING touches disk.
//   • custom row → writes the models.json and returns the two agent-dir vars.
// `baseEnv` is the spawn env, used only to find Pi's real agent dir (an ambient
// PI_CODING_AGENT_DIR is honored). `projectRoot` is the cwd Pi runs in.
function preparePiCustomEndpoint(projectRoot, entry, baseEnv) {
  if (!isPiCustomEntry(entry)) return { provider: piProviderEnv(entry).provider, env: {} };

  let rows = [];
  try { rows = readPiEntries(readProjectConfig(projectRoot)).filter(isPiCustomEntry); } catch { rows = []; }
  const id = piCustomProviderId(entry);
  if (!rows.some((r) => r.model === entry.model && piCustomProviderId(r) === id)) rows.push(entry);

  const { dir } = writePiModelsJson(projectRoot, rows);
  return {
    provider: id,
    env: {
      PI_CODING_AGENT_DIR: dir,
      PI_CODING_AGENT_SESSION_DIR: piDefaultSessionDir(projectRoot, baseEnv || process.env),
    },
  };
}

module.exports = {
  PI_CUSTOM_KEY_ENV,
  PI_CUSTOM_NO_KEY,
  piCustomProviderId,
  piSpawnProvider,
  piRowSupportsTools,
  piRowHost,
  toolCompatMessage,
  piTaskDefaultEntry,
  piTaskEntryForModel,
  buildPiModelsJson,
  serializePiModelsJson,
  piRealAgentDir,
  piDefaultSessionDir,
  writePiModelsJson,
  preparePiCustomEndpoint,
};
