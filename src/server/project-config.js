'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Only the Electron main process needs the app handle. In plain Node, loading
// the npm electron package may try to download its binary when CI omitted it.
let _electronApp = null;
if (process.versions.electron) {
  try { _electronApp = require('electron').app || null; } catch { /* unavailable Electron app */ }
}

// OPENROUTER_API_KEY/PI_MODEL stay here for legacy read-compat only — a project written
// by a pre-C1121 wizard/re-auth pass still has these flat keys on disk and must keep
// spawning Pi via projectEnvExtras() below. C1121-forward writers (project-creation-wizard
// wizard-complete → main.js) write PI_MODELS instead (see sanitizePiModels/piDefaultEntry)
// and no longer write these two flat keys at all.
const CONFIG_FIELDS = ['TASK_BACKEND', 'API_BASE_URL', 'API_TOKEN', 'API_PROJECT_ID', 'OPENROUTER_API_KEY', 'PI_MODEL', 'projectName', 'CLAUDE_MODEL', 'CODEX_MODEL', 'language'];
const API_CREDENTIAL_FIELDS = ['API_BASE_URL', 'API_TOKEN', 'API_PROJECT_ID'];
const CONFIG_REL = path.join('.tipatask', 'config.json');
const PROJECT_JSON_REL = path.join('.tipatask', 'project.json');
// Migration SOURCE only: before the Task App became a standalone repo it was vendored into
// projects at ai/todo/server and kept API credentials in its own .env. migrateFromLegacy()
// still reads that file when present so an old install upgrades cleanly; nothing else in
// the app expects that layout.
const LEGACY_ENV_REL = path.join('ai', 'todo', 'server', '.env');

// C1121 — max "Other Model" (pi) rows the wizard collects / config.json stores.
// Mirror of PI_MAX_MODELS in src/client/agent-select.js (ESM/CJS boundary — no shared
// import between the client bundle and this server module).
const PI_MAX_MODELS = 8;

// Supported Pi provider ids and key env vars mirror pi-ai's catalog, except
// OAuth-only openai-codex and extension-only llama.cpp. The client reads this
// ordered table from GET /api/pi/providers; no client copy exists.
const PI_PROVIDERS = {
  openrouter: { label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', keyRequired: true },
  deepseek: { label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', keyRequired: true },
  anthropic: { label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', keyRequired: true },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', keyRequired: true },
  google: { label: 'Google Gemini', envKey: 'GEMINI_API_KEY', keyRequired: true },
  groq: { label: 'Groq', envKey: 'GROQ_API_KEY', keyRequired: true },
  xai: { label: 'xAI', envKey: 'XAI_API_KEY', keyRequired: true },
  mistral: { label: 'Mistral', envKey: 'MISTRAL_API_KEY', keyRequired: true },
  cerebras: { label: 'Cerebras', envKey: 'CEREBRAS_API_KEY', keyRequired: true },
  'github-copilot': { label: 'GitHub Copilot', envKey: 'COPILOT_GITHUB_TOKEN', keyRequired: true },
  'azure-openai-responses': { label: 'Azure OpenAI', envKey: 'AZURE_OPENAI_API_KEY', keyRequired: true },
  'google-vertex': { label: 'Google Vertex AI', envKey: 'GOOGLE_CLOUD_API_KEY', keyRequired: false },
  'amazon-bedrock': { label: 'Amazon Bedrock', envKey: 'AWS_BEARER_TOKEN_BEDROCK', keyRequired: false },
  'vercel-ai-gateway': { label: 'Vercel AI Gateway', envKey: 'AI_GATEWAY_API_KEY', keyRequired: true },
  'cloudflare-workers-ai': { label: 'Cloudflare Workers AI', envKey: 'CLOUDFLARE_API_KEY', keyRequired: true },
  'cloudflare-ai-gateway': { label: 'Cloudflare AI Gateway', envKey: 'CLOUDFLARE_API_KEY', keyRequired: true },
  huggingface: { label: 'Hugging Face', envKey: 'HF_TOKEN', keyRequired: true },
  fireworks: { label: 'Fireworks AI', envKey: 'FIREWORKS_API_KEY', keyRequired: true },
  together: { label: 'Together AI', envKey: 'TOGETHER_API_KEY', keyRequired: true },
  baseten: { label: 'Baseten', envKey: 'BASETEN_API_KEY', keyRequired: true },
  nvidia: { label: 'NVIDIA', envKey: 'NVIDIA_API_KEY', keyRequired: true },
  opencode: { label: 'OpenCode Zen', envKey: 'OPENCODE_API_KEY', keyRequired: true },
  'opencode-go': { label: 'OpenCode Go', envKey: 'OPENCODE_API_KEY', keyRequired: true },
  zai: { label: 'Z.AI', envKey: 'ZAI_API_KEY', keyRequired: true },
  'zai-coding-cn': { label: 'Z.AI Coding (CN)', envKey: 'ZAI_CODING_CN_API_KEY', keyRequired: true },
  minimax: { label: 'MiniMax', envKey: 'MINIMAX_API_KEY', keyRequired: true },
  'minimax-cn': { label: 'MiniMax (CN)', envKey: 'MINIMAX_CN_API_KEY', keyRequired: true },
  moonshotai: { label: 'Moonshot AI', envKey: 'MOONSHOT_API_KEY', keyRequired: true },
  'moonshotai-cn': { label: 'Moonshot AI (CN)', envKey: 'MOONSHOT_API_KEY', keyRequired: true },
  'kimi-coding': { label: 'Kimi Coding', envKey: 'KIMI_API_KEY', keyRequired: true },
  xiaomi: { label: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', keyRequired: true },
  'xiaomi-token-plan-cn': { label: 'Xiaomi Token Plan (CN)', envKey: 'XIAOMI_TOKEN_PLAN_CN_API_KEY', keyRequired: true },
  'xiaomi-token-plan-ams': { label: 'Xiaomi Token Plan (AMS)', envKey: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', keyRequired: true },
  'xiaomi-token-plan-sgp': { label: 'Xiaomi Token Plan (SGP)', envKey: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', keyRequired: true },
  'qwen-token-plan': { label: 'Qwen Token Plan', envKey: 'QWEN_TOKEN_PLAN_API_KEY', keyRequired: true },
  'qwen-token-plan-individual': { label: 'Qwen Token Plan (Individual)', envKey: 'QWEN_TOKEN_PLAN_API_KEY', keyRequired: true },
  'qwen-token-plan-cn': { label: 'Qwen Token Plan (CN)', envKey: 'QWEN_TOKEN_PLAN_CN_API_KEY', keyRequired: true },
  'ant-ling': { label: 'Ant Ling', envKey: 'ANT_LING_API_KEY', keyRequired: true },
  radius: { label: 'Radius', envKey: 'RADIUS_API_KEY', keyRequired: true },
  // (TPT189) Not a Pi built-in: an arbitrary OpenAI-compatible endpoint (local Ollama / LM Studio /
  // vLLM, a gateway). The row carries `baseUrl` (+ optional `api`) and the key is optional — a local
  // server usually has none. `envKey` is a Tipatask-owned name, not one Pi reads on its own: the
  // generated models.json (pi-custom-endpoint.js) references it as `$TIPATASK_PI_CUSTOM_API_KEY`.
  custom: { label: 'Custom endpoint', envKey: 'TIPATASK_PI_CUSTOM_API_KEY', keyRequired: false, supportsBaseUrl: true },
};
for (const provider of Object.values(PI_PROVIDERS)) {
  if (provider.supportsBaseUrl === undefined) provider.supportsBaseUrl = false;
}
const PI_DEFAULT_PROVIDER = 'openrouter';
const PI_CUSTOM_PROVIDER = 'custom';

// (TPT189) `api` values Pi documents for a models.json custom provider (docs/models.md "Supported
// APIs"). Pi itself accepts any registered api id there; this is the set a row may name.
const PI_CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const PI_CUSTOM_DEFAULT_API = 'openai-completions';

// (TPT189) A custom row's endpoint: trimmed, kept verbatim, http(s) with a hostname and NO userinfo
// (`http://user:pw@host` would put a secret into the generated models.json). '' = unusable.
function normalizePiBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname || url.username || url.password) return '';
  return raw;
}

// Unknown/blank → the default, mirroring normalizePiProvider()'s "never reach Pi with an id we don't know".
function normalizePiApi(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return PI_CUSTOM_APIS.includes(id) ? id : PI_CUSTOM_DEFAULT_API;
}

// A readPiEntries() row that runs on a custom endpoint.
function isPiCustomEntry(entry) {
  return !!entry && normalizePiProvider(entry.provider) === PI_CUSTOM_PROVIDER;
}

// Blank/unknown → the default, so a hand-edited or future-version row never reaches Pi's
// --provider flag with an id this app has no key env mapping for.
function normalizePiProvider(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PI_PROVIDERS, id) ? id : PI_DEFAULT_PROVIDER;
}

// {provider, envKey, keyRequired} for a readPiEntries() row (or null/undefined → the default
// provider).
function piProviderEnv(entry) {
  const provider = normalizePiProvider(entry && entry.provider);
  const { envKey, keyRequired } = PI_PROVIDERS[provider];
  return { provider, envKey, keyRequired };
}

// (TPT188) The spawn-env fragment carrying a row's API key: {[providerEnvVar]: key}, or {} when
// there is nothing to export — a null entry, a keyless row (a key-optional provider left blank),
// or a provider with no key env var. An empty key must never be written: it would shadow a
// real ambient value of that variable with nothing. Every Pi spawn path merges this instead of
// assigning env[envKey] itself, so the guard lives once.
function piKeyEnvVars(entry) {
  if (!entry || !entry.apiKey) return {};
  const { envKey } = piProviderEnv(entry);
  return envKey ? { [envKey]: entry.apiKey } : {};
}

// Normalize any accepted pi-model payload into the canonical config.json PI_MODELS shape:
// an array of trimmed {model, apiKey} rows — plus `provider` on a non-OpenRouter row only, so
// an OpenRouter row serializes exactly as it did before the field existed (config.json is
// git-tracked; no churn for existing projects). Accepts (in priority order):
//   • { piModels: [{model,apiKey}|'model-id', …] }  — C1121 wizard payload
//   • [{model,apiKey}, …]                            — a bare rows array
//   • { piModel, piApiKey }                          — legacy single-value payload
// Drops rows missing a model, and rows missing a key whose provider requires one
// (PI_PROVIDERS[id].keyRequired — no blank-inherits-row-0; a key-optional provider's row is
// kept with an empty key), de-dupes by case-insensitive trimmed model id (first row wins —
// later spawn-time consumers key a picker by model id, so duplicates are ambiguous), caps at
// PI_MAX_MODELS. Returns [] when there is nothing usable — callers spread the result in
// conditionally so an empty result never writes an empty array.
// (TPT189) A `custom` row also carries `baseUrl` (required: a row whose URL isn't a plain http(s)
// endpoint is dropped, like a row without a model) and `api` (written only when it differs from
// PI_CUSTOM_DEFAULT_API). Every other provider's row is written without either field, so a stray
// `baseUrl` on e.g. an openrouter row is discarded and existing on-disk shapes never churn.
function sanitizePiModels(value, max = PI_MAX_MODELS) {
  const raw = Array.isArray(value) ? value
    : Array.isArray(value?.piModels) ? value.piModels
    : null;
  const rows = raw
    ? raw.map((e) => (typeof e === 'string'
        ? { model: e, apiKey: '' }
        : { model: String(e?.model ?? ''), apiKey: String(e?.apiKey ?? ''), provider: e?.provider, baseUrl: e?.baseUrl, api: e?.api }))
    : [{ model: String(value?.piModel ?? ''), apiKey: String(value?.piApiKey ?? '') }];

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const model = r.model.trim();
    const apiKey = r.apiKey.trim();
    const provider = normalizePiProvider(r.provider);
    if (!model) continue;
    if (!apiKey && PI_PROVIDERS[provider].keyRequired) continue;
    let baseUrl = '';
    if (provider === PI_CUSTOM_PROVIDER) {
      baseUrl = normalizePiBaseUrl(r.baseUrl);
      if (!baseUrl) continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (provider === PI_CUSTOM_PROVIDER) {
      const api = normalizePiApi(r.api);
      out.push(api === PI_CUSTOM_DEFAULT_API
        ? { model, apiKey, provider, baseUrl }
        : { model, apiKey, provider, baseUrl, api });
    } else {
      out.push(provider === PI_DEFAULT_PROVIDER ? { model, apiKey } : { model, apiKey, provider });
    }
    if (out.length >= max) break;
  }
  return out;
}

// config.json's AVAILABLE_AGENTS is a comma-separated STRING (unlike config.js's env-derived
// ARRAY of the same name — see providers/registry.js PROJECT_MODEL_KEYS comment for the
// matching PI_MODEL/PI_MODELS collision). Shared split so summarizeAgents() and
// providers/registry.js configForProject() (C1136) can't drift on the parse rule.
function readAvailableAgents(cfg) {
  return String((cfg && cfg.AVAILABLE_AGENTS) || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// (C1136) Pi's "actually usable" model ids — configured means a model name AND, for a provider
// that requires one (PI_PROVIDERS keyRequired), an API key entered for it, never just a bare
// model id. PI_MODELS rows (sanitizePiModels above already drops any row missing either)
// when present, else the legacy flat
// PI_MODEL+OPENROUTER_API_KEY pair as a single-entry fallback (pre-C1121 project, e.g. this
// repo's own .tipatask/config.json) — only when BOTH flat fields are non-empty, so a bare
// PI_MODEL with no key does NOT count as configured. Empty array = Pi has nothing configured
// for this project. Deliberately NOT reused by summarizeAgents() below — that Settings-row
// summary mirrors what is STORED (its own legacy fallback shows a keyless PI_MODEL), this
// mirrors what can actually SPAWN, consumed by providers/registry.js listObjectiveProviders()
// (chat selector) so a keyless model is never offered.
function piConfiguredModelIds(cfg) {
  const entries = readPiEntries(cfg);
  if (entries.length) return entries.map((e) => e.model);
  const model = cfg && typeof cfg.PI_MODEL === 'string' ? cfg.PI_MODEL.trim() : '';
  const apiKey = cfg && typeof cfg.OPENROUTER_API_KEY === 'string' ? cfg.OPENROUTER_API_KEY.trim() : '';
  return (model && apiKey) ? [model] : [];
}

// Read-side compat shim (C1121 decision: config.json's flat PI_MODEL/OPENROUTER_API_KEY
// keys are retired going forward — PI_MODELS is now the sole source). Returns the
// project's configured pi rows as [{model, apiKey}] — plus `provider` on a non-OpenRouter row,
// plus `baseUrl`/`api?` on a `custom` row (same shape sanitizePiModels() writes) — or [] when
// none are set. Resolve a row's provider and key env var with piProviderEnv(), never by reading
// `.provider` directly.
function readPiEntries(cfg) {
  if (!cfg) return [];
  return sanitizePiModels(Array.isArray(cfg.PI_MODELS) ? cfg.PI_MODELS : []);
}

// Renderer settings never receive stored credentials. A row's credentialRef is a
// non-secret identity within the requesting project's own config, used only by writes.
function rendererPiModels(cfg) {
  const rows = readPiEntries(cfg);
  if (!rows.length && cfg?.PI_MODEL) {
    rows.push({ model: cfg.PI_MODEL, apiKey: cfg.OPENROUTER_API_KEY || '' });
  }
  return rows.map(({ model, apiKey, provider, baseUrl, api }) => ({
    model,
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(api ? { api } : {}),
    hasApiKey: !!apiKey,
    apiKeyAction: apiKey ? 'preserve' : 'clear',
    credentialRef: { model, provider: provider || PI_DEFAULT_PROVIDER },
  }));
}

function rendererProjectConfig(cfg = {}) {
  const safe = {};
  for (const key of [
    'TASK_BACKEND', 'API_BASE_URL', 'API_PROJECT_ID', 'projectName', 'DEVICE_ID',
    'DEVICE_NAME', 'TASK_AGENT', 'LAST_AGENT', 'AVAILABLE_AGENTS', 'CLAUDE_MODEL',
    'CODEX_MODEL', 'theme', 'language', 'voicePreset', 'voiceLocalModel',
    'voiceInputDeviceId', 'voiceShortcut', 'boardFilters', 'debugPerfLog',
    'MCP_BROWSER_TOOLS',
  ]) {
    if (cfg[key] !== undefined) safe[key] = cfg[key];
  }
  safe.hasApiToken = !!cfg.API_TOKEN || !!require('./account-store').readAccount(cfg.API_BASE_URL);
  safe.hasAssemblyaiKey = !!cfg.ASSEMBLYAI_API_KEY;
  safe.PI_MODELS = rendererPiModels(cfg);
  return safe;
}

const isMaskedCredential = (value) => /^[*•●]{3,}(?:\s*\([^)]*\))?$/.test(value);

function resolvePiModelWrites(existing, rows) {
  if (!Array.isArray(rows)) throw new Error('piModels must be an array');
  const stored = rendererPiModels(existing);
  const resolved = rows.map((row) => {
    const action = row?.apiKeyAction || (row?.apiKey ? 'replace' : 'clear');
    let apiKey = '';
    if (action === 'replace') {
      apiKey = String(row.apiKey || '').trim();
      if (!apiKey || isMaskedCredential(apiKey)) throw new Error('Replacement API key is required');
    } else if (action === 'preserve') {
      const ref = row?.credentialRef;
      const match = stored.find((item) => item.model === ref?.model
        && (item.provider || PI_DEFAULT_PROVIDER) === ref?.provider);
      if (!match || !match.hasApiKey) throw new Error('Saved API key is unavailable for this project');
      const raw = readPiEntries(existing).find((item) => item.model === ref.model
        && (item.provider || PI_DEFAULT_PROVIDER) === ref.provider);
      apiKey = raw?.apiKey || (existing.PI_MODEL === ref.model ? existing.OPENROUTER_API_KEY || '' : '');
      if ((row.provider || PI_DEFAULT_PROVIDER) !== ref.provider) {
        throw new Error('Changing provider requires a replacement API key');
      }
    } else if (action !== 'clear') {
      throw new Error('Invalid API key action');
    }
    return { ...row, apiKey };
  });
  const sanitized = sanitizePiModels(resolved);
  if (sanitized.length !== resolved.length) throw new Error('Incomplete or duplicate Pi model row');
  return sanitized;
}

function mergeRendererProjectConfig(existing, patch = {}, { allowApiToken = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid project config patch');
  const merged = { ...(existing || {}) };
  for (const key of [
    'TASK_BACKEND', 'API_BASE_URL', 'API_PROJECT_ID', 'projectName', 'DEVICE_ID',
    'DEVICE_NAME', 'TASK_AGENT', 'LAST_AGENT', 'AVAILABLE_AGENTS', 'CLAUDE_MODEL',
    'CODEX_MODEL', 'theme', 'language', 'voicePreset', 'voiceLocalModel',
    'voiceInputDeviceId', 'voiceShortcut', 'boardFilters', 'debugPerfLog',
    'MCP_BROWSER_TOOLS',
  ]) {
    if (Object.hasOwn(patch, key)) merged[key] = patch[key];
  }
  if (allowApiToken && Object.hasOwn(patch, 'API_TOKEN')) merged.API_TOKEN = String(patch.API_TOKEN || '');
  if (Object.hasOwn(patch, 'PI_MODELS')) {
    merged.PI_MODELS = resolvePiModelWrites(existing || {}, patch.PI_MODELS);
    delete merged.PI_MODEL;
    delete merged.OPENROUTER_API_KEY;
  }
  if (Object.hasOwn(patch, 'assemblyaiKey')) {
    const op = patch.assemblyaiKey;
    if (op?.action === 'replace' && typeof op.value === 'string' && op.value.trim()
      && !isMaskedCredential(op.value.trim())) merged.ASSEMBLYAI_API_KEY = op.value.trim();
    else if (op?.action === 'clear') merged.ASSEMBLYAI_API_KEY = '';
    else if (op?.action !== 'preserve') throw new Error('Invalid AssemblyAI key action');
  }
  if (Object.hasOwn(patch, 'ASSEMBLYAI_API_KEY')) throw new Error('Use assemblyaiKey action to update the key');
  return merged;
}

// Row 0 of readPiEntries(cfg), or null when the project has no configured pi model —
// the fallback every Pi spawn path resolves against when no specific row is named.
function piDefaultEntry(cfg) {
  return readPiEntries(cfg)[0] || null;
}

// C1122 — the row a per-task/per-turn model selection names, matched case-insensitively
// on trimmed model id (same key sanitizePiModels() de-dupes on). null when unconfigured —
// callers fall back to piDefaultEntry() rather than spawning on a mismatched key.
function piEntryForModel(cfg, modelId) {
  const want = String(modelId || '').trim().toLowerCase();
  if (!want) return null;
  return readPiEntries(cfg).find((e) => e.model.toLowerCase() === want) || null;
}

// Remember agent/model only after a successful task spawn. This project default
// must not create missing config or fail task startup on write errors.
function recordLastUsedAgent(projectRoot, agentId, model) {
  if (!projectRoot || !agentId) return false;
  try {
    const cfg = readProjectConfig(projectRoot);
    if (!cfg) return false; // unconfigured project — nothing to update, nothing to create
    const next = { ...cfg, LAST_AGENT: agentId };
    const trimmedModel = typeof model === 'string' ? model.trim() : '';
    if (trimmedModel) {
      if (agentId === 'claude') {
        next.CLAUDE_MODEL = trimmedModel;
      } else if (agentId === 'codex') {
        next.CODEX_MODEL = trimmedModel;
      } else if (agentId === 'pi') {
        const rawRows = Array.isArray(cfg.PI_MODELS) ? cfg.PI_MODELS : [];
        if (rawRows.length) {
          const idx = rawRows.findIndex((r) => String(r?.model ?? '').trim().toLowerCase() === trimmedModel.toLowerCase());
          if (idx > 0) {
            next.PI_MODELS = [rawRows[idx], ...rawRows.slice(0, idx), ...rawRows.slice(idx + 1)];
          }
          // idx === 0 → already the default, nothing to reorder.
          // idx === -1 → id not among configured rows — leave PI_MODELS untouched, no fabrication.
        } else if (cfg.PI_MODEL) {
          // Legacy flat-field project (no PI_MODELS array at all).
          next.PI_MODEL = trimmedModel;
        }
      }
    }
    if (JSON.stringify(next) === JSON.stringify(cfg)) return false; // no-op — skip the write
    writeProjectConfig(projectRoot, next);
    return true;
  } catch (e) {
    console.warn(`[project-config] recordLastUsedAgent failed: ${e.message}`);
    return false;
  }
}

// C1124 — known task-agent ids. Mirror of the factory keys in task-agent/index.js — kept
// as a literal (not required from there) because task-agent/index.js already requires this
// module for readProjectConfig()/recordLastUsedAgent(); requiring it back would be circular.
const KNOWN_AGENT_IDS = ['claude', 'codex', 'pi'];

// C1124 — the agent that will actually launch next for this project, mirroring
// resolveTaskAgentId()'s per-project precedence (task-agent/index.js, C1131) without
// requiring that module: LAST_AGENT (set on every real task launch by
// recordLastUsedAgent() above) > TASK_AGENT (the explicit project default) > 'claude'.
// Read-only — doesn't filter against AVAILABLE_AGENTS, matching resolveTaskAgentId's own
// behavior (availability is a separate, later gate elsewhere).
function effectiveTaskAgent(cfg) {
  if (cfg && cfg.LAST_AGENT && KNOWN_AGENT_IDS.includes(cfg.LAST_AGENT)) return cfg.LAST_AGENT;
  if (cfg && cfg.TASK_AGENT && KNOWN_AGENT_IDS.includes(cfg.TASK_AGENT)) return cfg.TASK_AGENT;
  return 'claude';
}

// C1124 — collapse a full agent-selection payload from the Settings "Edit Agents" modal
// into ONE complete config object, ready for a single writeProjectConfig() call. Replaces
// the old per-field POST /api/config round trips (TASK_AGENT, then CLAUDE_MODEL, then
// CODEX_MODEL as separate writes) whose crash-on-throw could leave the app dead mid-save.
// selection = { taskAgent, availableAgents:string[], piModels:[{model,apiKey}]?,
//               claudeModel?, codexModel? }
function buildAgentsConfigPatch(existing, selection = {}) {
  const cfg = { ...(existing || {}) };
  const uniq = [...new Set((selection.availableAgents || []).map((s) => String(s || '').trim()).filter(Boolean))];
  let taskAgent = String(selection.taskAgent || '').trim();
  if (taskAgent && !uniq.includes(taskAgent)) uniq.push(taskAgent);
  if (!taskAgent) taskAgent = uniq[0] || '';
  cfg.TASK_AGENT = taskAgent;
  cfg.AVAILABLE_AGENTS = uniq.join(',');
  // Mirror the POST /api/config precedent (C1131, ws-handlers.js): LAST_AGENT otherwise
  // outranks TASK_AGENT in resolveTaskAgentId(), so an explicit Edit-Agents Save would
  // otherwise be silently shadowed by whatever agent last actually launched a task. An
  // empty taskAgent (nothing enabled) intentionally leaves any existing LAST_AGENT alone.
  if (taskAgent) cfg.LAST_AGENT = taskAgent;

  if (uniq.includes('pi')) {
    const piRows = selection.piModels === undefined ? [] : resolvePiModelWrites(existing, selection.piModels);
    if (piRows.length) {
      cfg.PI_MODELS = piRows;
      // Migrate off the pre-C1121 flat pair — PI_MODELS already wins in every read path
      // (readPiEntries/piDefaultEntry/piEntryForModel/registry.configForProject/
      // projectEnvExtras), so leaving the flat keys behind is dead weight and a second
      // source of truth.
      delete cfg.PI_MODEL;
      delete cfg.OPENROUTER_API_KEY;
    }
    // piRows empty (pi enabled but every row blank/incomplete) — the caller gates Save on
    // piCredentialsMissing() before this is ever reached, so leave existing rows as-is
    // rather than guess.
  }
  if (!uniq.includes('pi') && selection.clearPiModels === true) {
    cfg.PI_MODELS = [];
    delete cfg.PI_MODEL;
    delete cfg.OPENROUTER_API_KEY;
  }
  // pi left unchecked entirely → don't touch PI_MODELS/the legacy pair at all (C1101/C1121
  // carry-forward precedent — unchecking Other Model must never destroy a stored key).

  if (selection.claudeModel !== undefined) cfg.CLAUDE_MODEL = String(selection.claudeModel || '');
  if (selection.codexModel !== undefined) cfg.CODEX_MODEL = String(selection.codexModel || '');
  return cfg;
}

// Read-side summary for the Settings "Agents" row. Never includes a Pi API key.
// labels = {claude?, codex?, pi?} → display label, typically getTaskAgentInfo(id).label.
function summarizeAgents(cfg, labels = {}) {
  cfg = cfg || {};
  const availableAgents = String(cfg.AVAILABLE_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const taskAgent = effectiveTaskAgent(cfg);
  const claudeModel = cfg.CLAUDE_MODEL || '';
  const codexModel = cfg.CODEX_MODEL || '';
  const piEntries = readPiEntries(cfg);
  // Legacy fallback — a pre-C1121 project with no PI_MODELS array at all still has a model
  // configured via the flat pair; show it rather than an empty "Other Model" entry.
  const piModelIds = piEntries.length ? piEntries.map((e) => e.model) : (cfg.PI_MODEL ? [cfg.PI_MODEL] : []);

  const entries = availableAgents.map((id) => ({
    id,
    label: labels[id] || id,
    isDefault: id === taskAgent,
    models: id === 'claude' ? (claudeModel ? [claudeModel] : [])
      : id === 'codex' ? (codexModel ? [codexModel] : [])
      : id === 'pi' ? piModelIds
      : [],
  }));

  const summary = entries
    .map((e) => (e.models.length ? `${e.label} (${e.models.join(', ')})` : e.label))
    .join(' · ');

  return {
    taskAgent,
    taskAgentLabel: labels[taskAgent] || taskAgent,
    availableAgents,
    claudeModel,
    codexModel,
    piModels: piModelIds,
    entries,
    summary,
  };
}

// (C1259) mtime-memoized: readProjectConfig() is called on every single upstream API
// request (api-credentials.js) plus once per WS connect (multiple times), so a naive
// readFileSync+JSON.parse ran synchronously on the event loop constantly. A stat() is
// far cheaper than a read+parse; only re-read the file when its mtime actually changed.
// writeProjectConfig() below evicts its own project's entry immediately so a write
// followed by a same-process read never risks serving stale data on a low-res mtime clock.
const _readConfigCache = new Map(); // projectRoot -> { mtimeMs, value }

function readProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_REL);
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch (e) {
    _readConfigCache.delete(projectRoot);
    if (e.code !== 'ENOENT') console.warn(`[project-config] stat failed (${configPath}): ${e.message}`);
    return null;
  }
  const cached = _readConfigCache.get(projectRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Always expose `theme` and `language` keys so callers never see `undefined`.
    // theme '' = unset, which the client resolves to its default theme ('paper', TipATask dawn);
    // language 'en' = project default. Saved values win via spread.
    const value = { theme: '', language: 'en', ...parsed };
    _readConfigCache.set(projectRoot, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (e) {
    console.warn(`[project-config] read failed (${configPath}): ${e.message}`);
    return null;
  }
}

// (C1186) Single read path for voicePreset/voiceLocalModel/ASSEMBLYAI_API_KEY — was ad hoc at 3
// call sites (ws-handlers.js's old /api/project-config GET, task-board.js's
// readProjectVoiceSettings(), voice-stream/index.js's resolveVoicePreset()), each duplicating
// the same defaults. Centralized so streaming (C1185) and batch (C1186) transcription can never
// disagree on what preset a project is actually on. Defaults match C1178's client-side ones.
function readVoiceSettings(projectRoot) {
  const cfg = readProjectConfig(projectRoot) || {};
  return {
    voicePreset: cfg.voicePreset || 'assemblyai',
    voiceLocalModel: cfg.voiceLocalModel || 'whisper-base',
    assemblyaiApiKey: cfg.ASSEMBLYAI_API_KEY || null,
  };
}

const LANGUAGE_NAMES = { en: 'English', uk: 'Ukrainian' };

// Language directive prepended to agent prompts (C942). Returns '' for the
// default 'en' (keeps prompts byte-identical to pre-C942 — no cache churn).
// opts.objective adds the JSON-output clause needed to override the planner's
// "plain human-readable English" description style rule.
function buildLanguageDirective(projectRoot, opts = {}) {
  if (!projectRoot) return '';
  const cfg = readProjectConfig(projectRoot) || {};
  const lang = cfg.language || 'en';
  if (lang === 'en') return '';
  const name = LANGUAGE_NAMES[lang] || lang;
  let directive = `Communicate with the user in ${name}. All responses, questions, and status messages must be in ${name}.`;
  if (opts.objective) {
    directive += ` Task titles and descriptions in the JSON output must also be written in ${name} — this overrides any instruction to write descriptions in English.`;
  }
  return directive;
}

// The signed-in account's token lives in the app-level account store (account-store.js),
// not in any project's config.json. Every writer — re-auth, open-existing, the creation
// wizard, token refresh, CLI setup — funnels through writeProjectConfig(), so the routing is
// done once, here: a non-blank API_TOKEN is saved to the store under this config's
// API_BASE_URL, a blank one signs that server out, and the key never reaches disk.
// A config with no API_BASE_URL has no store key; the token then stays in the file rather
// than being lost.
function _routeTokenToAccountStore(config) {
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'API_TOKEN')) return config;
  const { API_TOKEN: token, ...rest } = config;
  const baseUrl = rest.API_BASE_URL;
  const accountStore = require('./account-store');
  if (!accountStore.normalizeBaseUrl(baseUrl)) return config;
  const value = typeof token === 'string' ? token.trim() : '';
  if (value) accountStore.writeAccountToken(baseUrl, value);
  else accountStore.clearAccountToken(baseUrl);
  return rest;
}

function writeProjectConfig(projectRoot, config) {
  config = _routeTokenToAccountStore(config);
  const dir = path.join(projectRoot, '.tipatask');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const tmp = configPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath);
  // (C1259) Evict the read cache above so an immediate same-process readProjectConfig()
  // never serves stale data on a low-resolution mtime clock.
  _readConfigCache.delete(projectRoot);
}

// One-time move of a legacy per-project config.json API_TOKEN into the account store.
// A project written before the account store still carries the token inline; the first
// getApiCredentials() read lifts it into the store (unless the store already holds a token
// that outlives it) and strips the key so config.json stops being a credential file.
// A legacy blank is only stripped — it never signs the account out of other projects.
// Never throws: a read-only checkout just keeps working off the inline token.
function migrateLegacyApiToken(projectRoot) {
  try {
    const configPath = path.join(projectRoot, CONFIG_REL);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'API_TOKEN')) return false;
    const accountStore = require('./account-store');
    if (!accountStore.normalizeBaseUrl(raw.API_BASE_URL)) return false;
    const legacy = typeof raw.API_TOKEN === 'string' ? raw.API_TOKEN.trim() : '';
    if (legacy) {
      const expOf = (t) => Number((accountStore.decodeTokenPayload(t) || {}).exp) || 0;
      const stored = accountStore.readAccount(raw.API_BASE_URL);
      // >= so an inline token written by an older Task App build (same or later expiry) wins.
      if (!stored || expOf(legacy) >= expOf(stored.token)) accountStore.writeAccountToken(raw.API_BASE_URL, legacy);
    }
    delete raw.API_TOKEN;
    writeProjectConfig(projectRoot, raw);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false; // no config.json yet: nothing to migrate
    console.warn(`[project-config] legacy API_TOKEN migration skipped: ${e.message}`);
    return false;
  }
}

function _parseEnvFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function _removeEnvKeys(filePath, keys) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  const keySet = new Set(keys);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  let changed = false;
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const eq = trimmed.indexOf('=');
    if (eq < 0 || !keySet.has(trimmed.slice(0, eq).trim())) return true;
    changed = true;
    return false;
  });
  if (!changed) return false;

  const next = kept.join(newline) + (trailingNewline ? newline : '');
  const tmp = filePath + '.tmp.' + process.pid;
  const mode = fs.statSync(filePath).mode;
  fs.writeFileSync(tmp, next, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
  return true;
}

function migrateFromLegacy(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_REL);
  const legacyEnvPath = path.join(projectRoot, LEGACY_ENV_REL);
  const configExists = fs.existsSync(configPath);
  const legacyExists = fs.existsSync(legacyEnvPath);
  if (!configExists && !legacyExists) return null;

  try {
    const env = legacyExists ? _parseEnvFile(legacyEnvPath) : {};
    let migrated;
    let configChanged = false;

    if (configExists) {
      // Existing config is authoritative. Only backfill credentials that are truly
      // absent; an explicit blank (notably API_TOKEN during re-auth) must stay blank.
      migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      for (const key of API_CREDENTIAL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(migrated, key) && env[key]) {
          migrated[key] = env[key];
          configChanged = true;
        }
      }
    } else {
      let projectName = path.basename(projectRoot);
      const projectJsonPath = path.join(projectRoot, PROJECT_JSON_REL);
      try {
        const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
        if (meta && meta.name) projectName = meta.name;
      } catch {}

      // First migration keeps every non-empty legacy setting, not only known fields.
      migrated = { projectName };
      for (const [key, val] of Object.entries(env)) {
        if (val !== undefined && val !== '') migrated[key] = val;
      }
      configChanged = true;
    }

    if (configChanged) writeProjectConfig(projectRoot, migrated);

    // Credentials now belong exclusively to config.json. Sanitize even when config
    // already existed so old self-hosted installs cannot retain a stale bearer token.
    const envChanged = legacyExists
      ? _removeEnvKeys(legacyEnvPath, API_CREDENTIAL_FIELDS)
      : false;
    return (configChanged || envChanged) ? migrated : null;
  } catch (e) {
    console.warn(`[project-config] migration failed: ${e.message}`);
    return null;
  }
}

// Appends `<line>` to `<dir>/.gitignore` if not already present (creating the file if
// absent). Best-effort — swallows write failures (a read-only checkout, e.g.) so the
// caller can decide whether to skip the credential-bearing write it was guarding.
// Returns true if the line is present in the file afterward, false otherwise.
function _ensureGitignoreLine(dir, line) {
  const gitignorePath = path.join(dir, '.gitignore');
  try {
    let content = '';
    try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* absent */ }
    const lines = content.split('\n').map(l => l.trim());
    if (lines.includes(line)) return true;
    const withNewline = content.length > 0 && !content.endsWith('\n') ? content + '\n' : content;
    fs.writeFileSync(gitignorePath, `${withNewline}${line}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[project-config] could not add "${line}" to ${gitignorePath}: ${e.message}`);
    return false;
  }
}

// Pre-approve registered MCP servers before Claude's first spawn. Write
// settings.local.json atomically and preserve existing/third-party settings.
// Add it to .gitignore before writing concrete API credentials; if that fails,
// omit the env block so a JWT cannot enter a commit. Missing/corrupt settings
// are tolerated.
function writeProjectClaudeMcpApproval(projectRoot) {
  const serverNames = ['tipatask', 'tipatask-local'];
  const settingsDir = path.join(projectRoot, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');

  let settings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a settings object');
    settings = parsed;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }

  const enabled = new Set(settings.enabledMcpjsonServers || []);
  const alreadyEnabled = serverNames.every(n => enabled.has(n));
  for (const n of serverNames) enabled.add(n);
  settings.enabledMcpjsonServers = [...enabled];

  let disabledChanged = false;
  if (Array.isArray(settings.disabledMcpjsonServers)) {
    const before = settings.disabledMcpjsonServers.length;
    settings.disabledMcpjsonServers = settings.disabledMcpjsonServers.filter(s => !serverNames.includes(s));
    disabledChanged = settings.disabledMcpjsonServers.length !== before;
    if (settings.disabledMcpjsonServers.length === 0) delete settings.disabledMcpjsonServers;
  }

  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  const allow = new Set(settings.permissions.allow);
  const allowBefore = allow.size;
  for (const n of serverNames) {
    allow.add(`mcp__${n}`);
    allow.add(`mcp__${n}__*`);
  }
  settings.permissions.allow = [...allow];

  // Configured projects own all three credential values, including explicit
  // blanks. A cleared token must not leave a stale credential in Claude settings.
  // Without a project config, preserve standalone user environment settings.
  let envChanged = false;
  if (_ensureGitignoreLine(projectRoot, '.claude/settings.local.json')) {
    const cfg = readProjectConfig(projectRoot);
    const wanted = {};
    for (const k of ['API_BASE_URL', 'API_PROJECT_ID']) {
      if (cfg) wanted[k] = cfg[k] == null ? '' : String(cfg[k]);
    }
    // The token comes from the account store; a legacy config.json token is the fallback.
    if (cfg) {
      const account = require('./account-store').readAccount(cfg.API_BASE_URL);
      wanted.API_TOKEN = account ? account.token : (cfg.API_TOKEN == null ? '' : String(cfg.API_TOKEN));
    }
    if (Object.keys(wanted).length > 0) {
      const beforeEnv = JSON.stringify(settings.env || {});
      settings.env = { ...(settings.env || {}), ...wanted };
      envChanged = JSON.stringify(settings.env) !== beforeEnv;
    }
  }

  if (alreadyEnabled && !disabledChanged && allow.size === allowBefore && !envChanged) return; // already approved

  fs.mkdirSync(settingsDir, { recursive: true });
  const newContent = JSON.stringify(settings, null, 2) + '\n';
  const tmp = settingsPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, settingsPath);
}

// ── MCP config writer ──
// Generates .mcp.json for external projects with two servers:
//   'tipatask'       — (C1382) remote Streamable HTTP, api/src/routes/mcp.js, 17 tools.
//                       Credential-free `${VAR}` references — every Claude/Codex process
//                       the Task App spawns already gets API_BASE_URL/API_PROJECT_ID/
//                       API_TOKEN injected by projectEnvExtras() (spawn-utils.js), so no
//                       per-project baked value is needed here, and the file stays git-safe.
//   'tipatask-local' — stdio, this shared install, TIPATASK_MCP_LOCAL_ONLY=1 (registers
//                       only the 4 tools that need a repo checkout: batch_grep_tags,
//                       push_knowledge, pull_knowledge, git_worktree_status).
// Safe to call on every project open — idempotent atomic write, skips if content unchanged.
// Also runs when projectRoot IS this checkout (dogfooding the Task App on itself): the
// resulting .mcp.json carries machine-specific absolute paths, which is why this repo
// gitignores its own /.mcp.json.
function writeProjectMcpConfig(projectRoot, serverRoot) {
  const absProjectRoot = path.resolve(projectRoot);
  const absServerRoot = path.resolve(serverRoot);
  // Same rule as config.js USER_DATA_ROOT: TIPATASK_USER_DATA, else the server root. Handed
  // to the stdio server so a `claude` launched from a plain shell still finds the account store.
  const userDataRoot = path.resolve(process.env.TIPATASK_USER_DATA || absServerRoot);

  // Pre-approve both MCP servers in Claude's local project settings so the "New MCP
  // server found" trust dialog never appears on a task's first spawn (C1047), and (C1382)
  // write concrete credentials into settings.local.json's env block for a shell-launched
  // `claude`. .claude/settings.local.json is a local, gitignored file (see
  // writeProjectClaudeMcpApproval).
  try { writeProjectClaudeMcpApproval(absProjectRoot); }
  catch (e) { console.warn(`[project-config] mcp trust pre-approval write failed: ${e.message}`); }

  const tipataskEntry = {
    type: 'http',
    url: '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp',
    headers: {
      Authorization: 'Bearer ${API_TOKEN}',
      'X-Tipatask-Session-Task': '${TIPATASK_TASK_ID:-}',
    },
  };

  let tipataskLocalEntry;
  if (_electronApp && _electronApp.isPackaged) {
    // Packaged Electron build — the asar is read-only; plain posix_spawn cannot enter it.
    // Use the Electron binary as a Node process (ELECTRON_RUN_AS_NODE=1) so it reads the
    // asar normally with its bundled Node runtime.
    const asarRoot = path.join(process.resourcesPath, 'app.asar');
    tipataskLocalEntry = {
      command: process.execPath,                                        // …/Contents/MacOS/TipATask
      args: [path.join(asarRoot, 'src', 'mcp', 'server.js')],           // …/app.asar/src/mcp/server.js
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        TIPATASK_PROJECT_ROOT: absProjectRoot,
        TIPATASK_SERVER_ROOT: asarRoot,                                  // …/Contents/Resources/app.asar
        TIPATASK_USER_DATA: userDataRoot,                                // account store + .file-tracks live here
        TIPATASK_MCP_LOCAL_ONLY: '1',
      },
    };
  } else {
    // Dev mode or plain-Node context — use the mcp-node shell wrapper as before.
    const wrapperName = process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node';
    tipataskLocalEntry = {
      command: path.join(absServerRoot, 'bin', wrapperName),
      args: [path.join(absServerRoot, 'src', 'mcp', 'server.js')],
      env: {
        TIPATASK_PROJECT_ROOT: absProjectRoot,
        TIPATASK_SERVER_ROOT: absServerRoot,
        TIPATASK_USER_DATA: userDataRoot,
        TIPATASK_MCP_LOCAL_ONLY: '1',
      },
    };
  }

  const mcpPath = path.join(absProjectRoot, '.mcp.json');
  let existing = {};
  try {
    const raw = fs.readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an MCP configuration object');
    existing = parsed;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      tipatask: tipataskEntry,
      'tipatask-local': tipataskLocalEntry,
    },
  };
  const newContent = JSON.stringify(merged, null, 2) + '\n';
  // Idempotent: skip write if already up-to-date.
  try { if (fs.readFileSync(mcpPath, 'utf8') === newContent) return; } catch { /* absent */ }
  const tmp = mcpPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, mcpPath);
}

// ── Installed agent harness ──
// Kept under the existing entry-point name so every desktop open, restore,
// adoption and re-authentication path refreshes guides, hooks and Claude skills.
function writeProjectSkillsConfig(projectRoot, serverRoot) {
  const { refreshHarnessTemplates } = require('../cli/install-templates');
  const report = refreshHarnessTemplates(path.resolve(projectRoot), path.resolve(serverRoot));
  for (const entry of report.skipped) {
    console.warn(`[harness] Preserved ${entry.path}: ${entry.reason}`);
  }
  for (const warning of report.warnings) console.warn(`[harness] ${warning}`);
  return report;
}

// ── Project meta helpers (.tipatask/project.json) ──
// Mirrors the private readProjectMeta / writeProjectMeta in main.js so that
// window-state.js can refresh project.json without a circular dep on main.js.

function readProjectMeta(projectRoot) {
  const metaPath = path.join(projectRoot, PROJECT_JSON_REL);
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { name: path.basename(projectRoot), apiProjectId: null };
  }
}

function writeProjectMeta(projectRoot, meta) {
  const metaDir = path.join(projectRoot, '.tipatask');
  fs.mkdirSync(metaDir, { recursive: true });
  const metaPath = path.join(metaDir, 'project.json');
  const tmp = metaPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, metaPath);
}

module.exports = {
  readProjectConfig,
  readVoiceSettings,
  writeProjectConfig,
  writeProjectMcpConfig,
  writeProjectClaudeMcpApproval,
  writeProjectSkillsConfig,
  migrateFromLegacy,
  CONFIG_FIELDS,
  API_CREDENTIAL_FIELDS,
  migrateLegacyApiToken,
  readProjectMeta,
  writeProjectMeta,
  buildLanguageDirective,
  LANGUAGE_NAMES,
  PI_MAX_MODELS,
  PI_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_CUSTOM_PROVIDER,
  PI_CUSTOM_APIS,
  PI_CUSTOM_DEFAULT_API,
  normalizePiProvider,
  normalizePiBaseUrl,
  normalizePiApi,
  isPiCustomEntry,
  piProviderEnv,
  piKeyEnvVars,
  sanitizePiModels,
  readPiEntries,
  rendererPiModels,
  rendererProjectConfig,
  resolvePiModelWrites,
  mergeRendererProjectConfig,
  readAvailableAgents,
  piConfiguredModelIds,
  piDefaultEntry,
  piEntryForModel,
  recordLastUsedAgent,
  buildAgentsConfigPatch,
  summarizeAgents,
};
