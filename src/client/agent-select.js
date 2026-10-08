// Shared agent cards for wizard, setup, and settings. Single installed agent
// auto-selects; no available agents shows install guidance. Resolve labels at
// access time so project locale changes are reflected.
import { t } from './i18n.js';

const AGENT_COLORS  = { claude: '#d97757', codex: '#10a37f', pi: '#7c6af7' };
const AGENT_INSTALL = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex:  'npm install -g @openai/codex',
  pi:     'pi.dev',
};

// Card display names that differ from the agent's registered label. Id stays `pi` —
// this only changes what the card shows, not any stored id/config value. "Other Model"
// is a description, not a product name (unlike "Claude Code"/"Codex"), so it's the one
// entry that goes through i18n — a getter so it re-evaluates t() on every access.
const AGENT_DISPLAY_NAMES = { get pi() { return t('agentSelect.namePi'); } };
const _displayName = (id, label) => AGENT_DISPLAY_NAMES[id] || label;

// C1285 — fallback labels keep the picker readable while the first server config frame is
// still in flight. Normal runtime values come from task-agent/index.js via agentLabels (or
// the same registry's agentStatuses payload), never from the selected/default agent.
const AGENT_FALLBACK_LABELS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  get pi() { return t('agentSelect.namePi'); },
});

export function getAgentDisplayLabel(id, labels = {}, statuses = []) {
  const configured = labels && typeof labels === 'object' ? labels[id] : '';
  if (typeof configured === 'string' && configured.trim()) return configured;
  const status = Array.isArray(statuses) ? statuses.find((entry) => entry && entry.id === id) : null;
  if (typeof status?.label === 'string' && status.label.trim()) return status.label;
  return AGENT_FALLBACK_LABELS[id] || id;
}

// Shared all-unavailable fallback used by both wizards when IPC returns empty/errors.
// Deliberately NOT faking any agent as available — ensures the empty state is shown.
export const FALLBACK_AGENTS = [
  { id: 'claude', label: 'Claude Code', available: false },
  { id: 'codex',  label: 'Codex',       available: false },
  { id: 'pi',     label: 'Pi',          available: false },
];

// Fetch available agents: Electron IPC first (force=true busts the resolveBin/login
// caches so a newly-installed/signed-in agent is reflected). When the IPC bridge is
// absent (plain browser tab), runs the caller's optional `browserFallback()` — injected
// so this module needs no project-header/fetch knowledge. Falls back to FALLBACK_AGENTS
// (all unavailable) on any throw or empty result — never fakes claude as available.
export async function loadAgents({ force = false, browserFallback } = {}) {
  try {
    if (window.electronAPI?.setupGetAvailableAgents) {
      const agents = await window.electronAPI.setupGetAvailableAgents(force);
      if (agents?.length) return agents;
    } else if (typeof browserFallback === 'function') {
      const agents = await browserFallback(force);
      if (Array.isArray(agents) && agents.length) return agents;
    }
  } catch { /* fall through to FALLBACK_AGENTS */ }
  return FALLBACK_AGENTS;
}

// C1121 — max "Other Model" (pi) rows the wizard collects. Mirror of PI_MAX_MODELS in
// src/server/project-config.js (ESM/CJS boundary — no shared import between the client
// bundle and the server module).
export const PI_MAX_MODELS = 8;

// ── (TPT191) Provider registry ───────────────────────────────────────────────
// The LLM providers an "Other Model" row can name come from GET /api/pi/providers — the
// server's PI_PROVIDERS table (src/server/project-config.js) is the single source of truth:
// [{id, label, envKey, keyRequired, supportsBaseUrl}], default provider first. Labels are
// brand names, not translated. Until that fetch lands (or when it fails) the registry holds
// only the two ids with client-specific behavior: OpenRouter (the default, `openrouter/`
// prefix rule below) and the custom endpoint (keyless, needs a base URL).
export const PI_DEFAULT_PROVIDER = 'openrouter';
export const PI_CUSTOM_PROVIDER = 'custom';
const PI_FALLBACK_PROVIDERS = Object.freeze([
  { id: PI_DEFAULT_PROVIDER, label: 'OpenRouter', keyRequired: true, supportsBaseUrl: false },
  { id: PI_CUSTOM_PROVIDER, label: 'Custom endpoint', keyRequired: false, supportsBaseUrl: true },
]);
// Placeholders are UI copy the API doesn't serve; any other provider gets the generic pair.
const PI_PROVIDER_PLACEHOLDERS = {
  openrouter: { modelPlaceholder: 'anthropic/claude-sonnet-4.5', keyPlaceholder: 'sk-or-…' },
  deepseek: { modelPlaceholder: 'deepseek-v4-flash', keyPlaceholder: 'sk-…' },
  custom: { modelPlaceholder: 'llama3.1:8b', keyPlaceholder: '' },
};
const PI_GENERIC_PLACEHOLDERS = { modelPlaceholder: 'model-id', keyPlaceholder: 'sk-…' };
const PI_BASE_URL_PLACEHOLDER = 'http://localhost:11434/v1';
const _PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

let _piProviders = PI_FALLBACK_PROVIDERS;
let _piProvidersLoaded = false;
let _piProvidersPromise = null;

/** Replace the registry with a server payload. Malformed entries are skipped; an empty or
 *  default-less list is rejected (returns false) and the current registry is kept. */
export function setPiProviders(list) {
  const rows = (Array.isArray(list) ? list : [])
    .map((p) => ({
      id: String(p?.id ?? '').trim().toLowerCase(),
      label: String(p?.label ?? '').trim(),
      keyRequired: p?.keyRequired !== false,
      supportsBaseUrl: p?.supportsBaseUrl === true,
    }))
    .filter((p) => _PROVIDER_ID_RE.test(p.id))
    .map((p) => ({ ...p, label: p.label || p.id }));
  if (!rows.some((p) => p.id === PI_DEFAULT_PROVIDER)) return false;
  _piProviders = rows;
  _piProvidersLoaded = true;
  return true;
}

/** Back to the pre-fetch fallback registry (tests). */
export function resetPiProviders() {
  _piProviders = PI_FALLBACK_PROVIDERS;
  _piProvidersLoaded = false;
  _piProvidersPromise = null;
}

export function getPiProviders() { return _piProviders; }
export function piProvidersLoaded() { return _piProvidersLoaded; }

/** Single-flight GET /api/pi/providers. Never throws; on any failure the fallback registry
 *  stays and a later call retries. Needs no project header — the route reads nothing
 *  project-scoped, so it works in the create wizard / setup-modal before a project exists. */
export function ensurePiProviders() {
  if (_piProvidersLoaded) return Promise.resolve(_piProviders);
  if (!_piProvidersPromise) {
    _piProvidersPromise = (async () => {
      try {
        const r = await fetch('/api/pi/providers', { cache: 'no-store' });
        if (r.ok) setPiProviders(await r.json());
      } catch { /* keep the fallback registry */ }
      if (!_piProvidersLoaded) _piProvidersPromise = null;
      return _piProviders;
    })();
  }
  return _piProvidersPromise;
}

/** Blank → the default provider. A registry id → itself. While the registry is still the
 *  fallback, any well-formed id is kept VERBATIM: collapsing a stored `anthropic` row to
 *  OpenRouter during the load window would `openrouter/`-prefix its model id on the next
 *  emit. Once the real registry is loaded an unknown id is an OpenRouter row, as server-side. */
export function normalizePiProvider(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!id) return PI_DEFAULT_PROVIDER;
  if (_piProviders.some((p) => p.id === id)) return id;
  return !_piProvidersLoaded && _PROVIDER_ID_RE.test(id) ? id : PI_DEFAULT_PROVIDER;
}

/** Registry entry + placeholders for a provider id. An id the registry doesn't (yet) know is
 *  labeled by its id and assumed to need a key. */
export function piProviderMeta(value) {
  const id = normalizePiProvider(value);
  const known = _piProviders.find((p) => p.id === id)
    || { id, label: id, keyRequired: true, supportsBaseUrl: false };
  return { ...known, ...(PI_PROVIDER_PLACEHOLDERS[id] || PI_GENERIC_PLACEHOLDERS) };
}

/** Client mirror of the server's normalizePiBaseUrl(): trimmed http(s) URL with a hostname
 *  and no userinfo (credentials must never reach the generated models.json), else ''. */
export function normalizePiBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname || u.username || u.password) return '';
    return raw;
  } catch { return ''; }
}

// ── (TPT191) Model catalog ───────────────────────────────────────────────────
// GET /api/pi/models?provider=<id> → [{id, name}]; always 200, [] on any failure. Suggestions
// are an aid, never a gate — the model input stays free text. Cached per provider for the
// page's lifetime (the server caches for 10 minutes anyway); an empty result is not cached so
// a catalog that needed a just-saved key can show up on the next open.
const _piModelCache = new Map();

export function fetchPiModels(provider) {
  const id = normalizePiProvider(provider);
  if (_piModelCache.has(id)) return _piModelCache.get(id);
  const p = (async () => {
    try {
      const projectPath = new URLSearchParams(globalThis.location?.search || '').get('projectPath');
      const r = await fetch(`/api/pi/models?provider=${encodeURIComponent(id)}`, {
        cache: 'no-store',
        headers: projectPath ? { 'x-tipatask-project': projectPath } : {},
      });
      const list = r.ok ? await r.json() : [];
      const ids = (Array.isArray(list) ? list : []).map((m) => String(m?.id ?? '').trim()).filter(Boolean);
      if (!ids.length) _piModelCache.delete(id);
      return ids;
    } catch {
      _piModelCache.delete(id);
      return [];
    }
  })();
  _piModelCache.set(id, p);
  return p;
}

/** Case-insensitive substring filter over catalog ids; prefix matches first. A query that
 *  exactly equals the only match yields nothing (no point suggesting what's already typed). */
export function filterPiModelSuggestions(ids, query, limit = 50) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = Array.isArray(ids) ? ids : [];
  if (!q) return all.slice(0, limit);
  const hits = all.filter((id) => id.toLowerCase().includes(q));
  if (hits.length === 1 && hits[0].toLowerCase() === q) return [];
  const starts = hits.filter((id) => id.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((id) => !id.toLowerCase().startsWith(q))].slice(0, limit);
}

// ── (TPT172) OpenRouter model-id prefix ──────────────────────────────────────
// The STORED id of an OpenRouter row always starts with `openrouter/` — piEntryForModel(),
// a saved task.pi_model pin and PI_CONFIGURED_MODELS all match that exact string. The picker
// shows/accepts the id WITHOUT it (the Provider select already says OpenRouter): the working
// client array holds the DISPLAY id, normalizePiModels() strips on the way in, and _piRow() —
// the single constructor behind emit() and computePiSaveRows() — adds the prefix back exactly
// once on the way out. Both helpers are idempotent and no-ops for every non-OpenRouter
// provider (DeepSeek and any future direct provider store their own id verbatim).
const OPENROUTER_PREFIX = 'openrouter/';
const _hasOpenRouterPrefix = (id) => id.toLowerCase().startsWith(OPENROUTER_PREFIX);

/** Display form of a stored id. Strips ONE leading `openrouter/` from an OpenRouter row —
 *  except when what remains itself starts with `openrouter/` (OpenRouter's own
 *  `openrouter/auto` family is stored `openrouter/openrouter/auto`), which is shown as-is so it
 *  round-trips instead of collapsing to `openrouter/auto`. */
export function stripPiModelPrefix(model, provider) {
  const id = String(model ?? '').trim();
  if (normalizePiProvider(provider) !== PI_DEFAULT_PROVIDER) return id;
  if (!_hasOpenRouterPrefix(id)) return id;
  const rest = id.slice(OPENROUTER_PREFIX.length);
  return _hasOpenRouterPrefix(rest) ? id : rest;
}

/** Stored form of a display id — the inverse of stripPiModelPrefix(). A blank id stays blank
 *  (never becomes a bare `openrouter/`); an id that already carries the prefix is returned
 *  unchanged apart from normalizing the prefix's own case. */
export function applyPiModelPrefix(model, provider) {
  const id = String(model ?? '').trim();
  if (!id || normalizePiProvider(provider) !== PI_DEFAULT_PROVIDER) return id;
  return _hasOpenRouterPrefix(id) ? OPENROUTER_PREFIX + id.slice(OPENROUTER_PREFIX.length) : OPENROUTER_PREFIX + id;
}

/** (TPT191) What to put in the model input for a picked catalog id. The catalog lists ids as Pi
 *  prints them — for OpenRouter that is already the display form, except OpenRouter's own
 *  `openrouter/*` family, which must be held as `openrouter/openrouter/*` to round-trip. */
export function piCatalogDisplayId(catalogId, provider) {
  const id = String(catalogId ?? '').trim();
  if (normalizePiProvider(provider) !== PI_DEFAULT_PROVIDER) return id;
  return _hasOpenRouterPrefix(id) ? OPENROUTER_PREFIX + id : id;
}

// Fields beyond {model, apiKey}, shared by both row constructors — the same on-disk shape the
// server's sanitizePiModels() persists: `provider` only on a non-OpenRouter row, `baseUrl` only
// on a custom-endpoint row, and that row's `api` passed through untouched (no UI for it, but it
// must survive an edit/save round-trip).
function _rowExtras(src, id) {
  const extra = {};
  if (id !== PI_DEFAULT_PROVIDER) extra.provider = id;
  if (id === PI_CUSTOM_PROVIDER) {
    extra.baseUrl = String(src?.baseUrl ?? '').trim();
    const api = String(src?.api ?? '').trim();
    if (api) extra.api = api;
  }
  if (src?.apiKeyAction) extra.apiKeyAction = src.apiKeyAction;
  if (src?.credentialRef) extra.credentialRef = { ...src.credentialRef };
  if (src?.hasApiKey !== undefined) extra.hasApiKey = !!src.hasApiKey;
  return extra;
}

// One EMITTED/SAVED row — the ONLY place the openrouter/ prefix is added, so an OpenRouter
// row round-trips unchanged.
function _piRow(src) {
  const id = normalizePiProvider(src?.provider);
  return { model: applyPiModelPrefix(src?.model, id), apiKey: String(src?.apiKey ?? '').trim(), ..._rowExtras(src, id) };
}

// One WORKING/DISPLAY row — the mirror image of _piRow(): prefix stripped, same extras. Must
// stay a separate constructor: reusing _piRow() here would add the prefix straight back and
// the strip would never take effect.
function _displayRow(src) {
  const id = normalizePiProvider(src?.provider);
  return { model: stripPiModelPrefix(src?.model, id), apiKey: String(src?.apiKey ?? ''), ..._rowExtras(src, id) };
}

// Case-insensitive identity of a row as SAVED — same key sanitizePiModels() de-dupes on, so
// `anthropic/x` and `openrouter/anthropic/x` collide here exactly as they would server-side.
const _saveKey = (row) => _piRow(row).model.toLowerCase();

/**
 * Dual-shape seed: turn a caller's `value` into the working [{model, apiKey}] array in
 * DISPLAY form (an OpenRouter row's `openrouter/` prefix stripped — see above). Accepts the
 * current `value.piModels` (objects or bare model-id strings, prefixed or not) and the legacy
 * `value.piModel`/`value.piApiKey` scalars (still round-tripped for back-compat by every
 * caller — see emit() below). Always returns at least one row so callers never see an empty
 * array (that synthetic blank row is dropped again by buildPiRowState()); caps at
 * PI_MAX_MODELS. Returns fresh objects — never aliases the caller's array, so mutating the
 * result never mutates caller state out from under it.
 */
export function normalizePiModels(value) {
  const raw = Array.isArray(value?.piModels) ? value.piModels : null;
  let rows = raw
    ? raw.map((e) => _displayRow(typeof e === 'string' ? { model: e } : e))
    : (value?.piModel || value?.piApiKey)
      ? [_displayRow({ model: value.piModel, apiKey: value.piApiKey })]
      : [];
  rows = rows.slice(0, PI_MAX_MODELS);
  return rows.length ? rows : [{ model: '', apiKey: '' }];
}

// (TPT191) What a row still lacks, as a field name, or '' when it is complete: a model id
// always; an API key unless the provider's `keyRequired` is false; a valid base URL on a
// custom-endpoint row. The same three rules sanitizePiModels() drops a row on server-side.
function _rowGap(row) {
  if (!String(row?.model ?? '').trim()) return 'model';
  const meta = piProviderMeta(row?.provider);
  const preservesKey = row?.apiKeyAction === 'preserve' && row?.hasApiKey
    && normalizePiProvider(row?.credentialRef?.provider) === meta.id;
  if (meta.keyRequired && !String(row?.apiKey ?? '').trim() && !preservesKey) return 'apiKey';
  if (meta.id === PI_CUSTOM_PROVIDER && !normalizePiBaseUrl(row?.baseUrl)) return 'baseUrl';
  return '';
}

/**
 * Persistence filter shared by the create wizard, setup-modal and agents-modal: trimmed rows
 * that are COMPLETE (an incomplete row is never saved) — a model id, an API key unless the
 * provider is keyless (`keyRequired: false`, e.g. a local Ollama custom endpoint), and a valid
 * `baseUrl` on a custom-endpoint row. Rows are built by _piRow(), i.e. the same on-disk shape
 * the server's sanitizePiModels() produces, and an OpenRouter row's id is stored WITH its
 * `openrouter/` prefix whichever form the caller holds (idempotent, never doubled). Returns
 * fresh plain objects, safe to structured-clone across IPC.
 */
export function computePiSaveRows(piModels) {
  return (piModels || []).map((m) => _piRow(m)).filter((m) => !_rowGap(m));
}

/**
 * (TPT172) Working UI state for the Pi cards: every configured row starts `enabled` (the
 * checkbox flag is UI-only and never emitted) and row 0 is the default — the server treats
 * PI_MODELS[0] as the default model. Drops normalizePiModels()'s synthetic blank row: with no
 * real row the grid renders a placeholder card, not a nameless model card.
 */
export function buildPiRowState(value) {
  const rows = normalizePiModels(value)
    .filter((r) => r.model)
    .map((r) => ({ ...r, enabled: true }));
  return { rows, defaultIdx: rows.length ? 0 : -1 };
}

/**
 * (TPT172) Rows in the order they are emitted/saved: the default row FIRST (the server reads
 * PI_MODELS[0] as the default — there is no dedicated key), the rest in display order.
 * Unchecked rows are omitted — an unchecked model is not configured for the project. Applied
 * at emit time only, never to the on-screen order, so cards don't jump under the cursor.
 */
export function orderPiModelsForSave(rows, defaultIdx) {
  const on = (rows || []).map((row, i) => ({ row, i })).filter(({ row }) => row.enabled !== false);
  return [...on.filter(({ i }) => i === defaultIdx), ...on.filter(({ i }) => i !== defaultIdx)]
    .map(({ row }) => row);
}

/**
 * (TPT172) First problem with the Add/Edit form's draft, or null when it can be committed.
 * `editIdx` is the row being edited (skipped by the duplicate check). Duplicates are judged on
 * the SAVED id, so `anthropic/x` collides with an existing `openrouter/anthropic/x`.
 */
export function addPiModelIssue(rows, draft, editIdx = -1) {
  const gap = _rowGap(draft);
  if (gap === 'model') return t('agentSelect.errModelRequired');
  if (gap === 'apiKey') return t('agentSelect.errApiKeyRequired');
  if (gap === 'baseUrl') return t('agentSelect.errBaseUrlRequired');
  const key = _saveKey(draft);
  const clash = (rows || []).some((r, i) => i !== editIdx && _saveKey(r) === key);
  return clash ? t('agentSelect.duplicateModel') : null;
}

// Internal: first problem with the current rows, or null when they're all usable.
// Backs the exported piCredentialsMissing() gate. The UI itself can no longer produce a
// blank or duplicate row (the form validates first), so this now guards disk-seeded state.
function _piRowsIssue(models) {
  if (!models.length) return t('agentSelect.addAtLeastOneModel');
  if (models.some((m) => _rowGap(m))) return t('agentSelect.fixOtherModelRows');
  const seen = new Set();
  for (const m of models) {
    const key = _saveKey(m);
    if (seen.has(key)) return t('agentSelect.duplicateModel');
    seen.add(key);
  }
  return null;
}

/**
 * (TPT172) Pure card model behind the grid. Maps `agents` (claude/codex/pi) to one descriptor
 * per rendered card, expanding `pi` in place:
 *   agent          claude / codex                                    checkbox + radio
 *   pi-model       pi available, one per configured row              checkbox + radio
 *   pi-empty       pi available, no rows yet — one placeholder card  neither (nothing to enable)
 *   pi-unavailable pi CLI missing — exactly ONE dimmed card          disabled, no Add button
 * Every Pi card keeps `id: 'pi'` — the emitted taskAgent must stay the literal 'pi'; `piIdx`
 * (the row's display index) is the only discriminator between two Pi cards.
 */
export function buildAgentCardRows({ agents, piModels = [], enabledIds = [], defaultId = '', piDefaultIdx = -1, single = false }) {
  const out = [];
  for (const { id, label, available, reason, detail } of agents) {
    if (id !== 'pi') {
      out.push({
        kind: 'agent', id, piIdx: -1, color: AGENT_COLORS[id] || '#888', available,
        enabled: enabledIds.includes(id), isDefault: defaultId === id,
        name: _displayName(id, label), reason, detail: detail || null, hasCheckbox: !single, hasRadio: true,
      });
      continue;
    }
    const color = AGENT_COLORS.pi;
    if (!available) {
      out.push({
        kind: 'pi-unavailable', id, piIdx: -1, color, available: false, enabled: false, isDefault: false,
        name: _displayName(id, label), reason, detail: detail || null, hasCheckbox: !single, hasRadio: true,
      });
    } else if (!piModels.length) {
      out.push({
        kind: 'pi-empty', id, piIdx: -1, color, available: true, enabled: false, isDefault: false,
        name: _displayName(id, label), reason: '', hasCheckbox: false, hasRadio: false,
      });
    } else {
      piModels.forEach((row, i) => {
        const providerLabel = piProviderMeta(row.provider).label;
        const modelText = stripPiModelPrefix(row.model, row.provider);
        out.push({
          kind: 'pi-model', id, piIdx: i, color, available: true,
          enabled: row.enabled !== false, isDefault: defaultId === 'pi' && i === piDefaultIdx,
          providerLabel, modelText, storedModel: _piRow(row).model,
          name: `${providerLabel} · ${modelText}`, reason: '', hasCheckbox: !single, hasRadio: true,
        });
      });
    }
  }
  return out;
}

/**
 * Render agent selection into container.
 * @param {HTMLElement} container - mount target (contents replaced)
 * @param {object} opts
 * @param {{id:string,label:string,available:boolean}[]} opts.agents - all agents (available or not)
 * @param {{availableAgents:string[],taskAgent:string,piModels?:{model:string,apiKey:string,provider?:string}[],piModel?:string,piApiKey?:string,claudeModel?:string,codexModel?:string}} opts.value - current
 *   selection state. `piModels` (C1121, up to PI_MAX_MODELS rows, each becoming its own card —
 *   TPT172) is preferred; the legacy `piModel`/`piApiKey` scalar pair is still accepted as a
 *   one-row fallback (normalizePiModels()). Ids may be stored (`openrouter/…`) or display form.
 *   `claudeModel`/`codexModel` (C1161) seed the opt-in `opts.modelSelects` blocks — ignored
 *   when `modelSelects` isn't passed.
 * @param {function} opts.onChange - called with updated {availableAgents, taskAgent, piModels, piModel, piApiKey, claudeModel, codexModel}
 *   on every change. `piModels` holds only the CHECKED rows in STORED form (`openrouter/` prefix
 *   present), default row first (TPT172); `availableAgents` contains 'pi' iff at least one Pi row
 *   is checked. piModel/piApiKey mirror piModels[0] (the default row) for callers not yet upgraded
 *   to the array (C1122). claudeModel/codexModel are only meaningful when the caller passed
 *   `opts.modelSelects`; callers that don't can just ignore the two extra keys.
 * @param {function} [opts.onReCheck] - called when Re-Check button is clicked (force re-detect);
 *   async; the button shows a spinner while pending. Rendered whenever provided — in the
 *   populated grid header and in the all-unavailable empty state.
 * @param {{[agentId:string]:{label:string,options:{value:string,label:string,description?:string}[],defaultValue?:string,placeholder?:{value:string,label:string}}}} [opts.modelSelects] -
 *   (C1161) opt-in per-agent model-version `<select>`, rendered as a sibling block directly under
 *   that agent's card, toggled by the same enable checkbox. Omit entirely for callers that have
 *   no model picker (the create wizard, the open-existing/re-auth setup modal) — they get exactly
 *   the pre-C1161 markup.
 */
export function renderAgentSelect(container, { agents, value, onChange, onReCheck, modelSelects }) {
  const availableOnes = agents.filter(a => a.available);

  // All agents unavailable: show install guidance + Re-Check button instead of the grid.
  if (availableOnes.length === 0) {
    _renderEmpty(container, agents, onReCheck);
    return;
  }

  const single = availableOnes.length <= 1;
  const availableIdSet = new Set(availableOnes.map(a => a.id));
  const piAvailable = availableIdSet.has('pi');

  // Working state (mutated by interactions)
  let enabledIds = value.availableAgents?.length
    ? [...value.availableAgents]
    : availableOnes.map(a => a.id);
  let defaultId = value.taskAgent || availableOnes[0]?.id || '';
  // Ensure default is always in enabledIds
  if (defaultId && !enabledIds.includes(defaultId)) enabledIds.push(defaultId);

  // (TPT172) One working row per configured Pi model, in DISPLAY form (prefix stripped), each
  // with a UI-only `enabled` flag (the row's checkbox) that _piRow() never emits. A row on disk
  // is "configured", but it is only CHECKED when Pi itself was enabled — a project that has
  // PI_MODELS stored while Pi is unchecked must not be silently re-enabled by opening the picker.
  const piSeed = buildPiRowState(value);
  const piModels = piSeed.rows;
  let piDefaultIdx = piSeed.defaultIdx;
  let clearPiModels = !!value?.clearPiModels;
  // Single-installed-agent mode has no checkboxes, so its rows can never be toggled on later.
  const piRowsOn = !piAvailable || single || enabledIds.includes('pi');
  piModels.forEach((r) => { r.enabled = piRowsOn; });
  // The Add/Edit form: { mode: 'add'|'edit', idx, draft: {provider, model, apiKey}, issue }.
  // Lives in this closure, not in piModels — a row only enters piModels once the form validates.
  let form = null;

  // C1161 — one working value per opt-in model-select entry, keyed by agent id. Seeded from
  // `value.{id}Model` (agents-modal.js's flat claudeModel/codexModel fields) falling back to
  // the entry's declared default/placeholder value. No-op object when the caller passes no
  // `modelSelects` — wizard/setup-modal never see this key.
  const agentModels = {};
  for (const id of Object.keys(modelSelects || {})) {
    const entry = modelSelects[id];
    const seeded = value?.[`${id}Model`];
    agentModels[id] = seeded !== undefined && seeded !== null
      ? seeded
      : (entry.defaultValue ?? entry.placeholder?.value ?? '');
  }

  // 'pi' membership in enabledIds is DERIVED: on iff at least one Pi row is checked. Also keeps
  // the default Pi row on a checked row, and gives a default back to a Pi-only project the
  // moment its first model is added.
  const syncPiEnabledId = () => {
    if (!piAvailable) return;
    const anyOn = piModels.some((r) => r.enabled !== false);
    const has = enabledIds.includes('pi');
    if (anyOn && !has) {
      enabledIds.push('pi');
      if (!defaultId) defaultId = 'pi';
    } else if (!anyOn && has) {
      enabledIds = enabledIds.filter((x) => x !== 'pi');
      if (defaultId === 'pi') defaultId = enabledIds[0] || '';
    }
    if (anyOn && (piDefaultIdx < 0 || piModels[piDefaultIdx]?.enabled === false)) {
      piDefaultIdx = piModels.findIndex((r) => r.enabled !== false);
    }
  };

  // Prune stale selection: an id that was enabled/default on a prior render (e.g. before a
  // Re-Check) but is no longer available now (uninstalled, logged out) must not survive —
  // otherwise it gets written to AVAILABLE_AGENTS/TASK_AGENT at Confirm despite being unusable.
  // (TPT172) syncPiEnabledId() rides the same rail: `pi` enabled on disk with no model rows
  // is dropped here and re-emitted, so the caller never keeps an enabled Pi with nothing to run.
  const prevEnabledIds = enabledIds;
  const prevDefaultId = defaultId;
  enabledIds = enabledIds.filter(id => availableIdSet.has(id));
  if (!availableIdSet.has(defaultId)) defaultId = enabledIds[0] || availableOnes[0]?.id || '';
  if (defaultId && !enabledIds.includes(defaultId)) enabledIds.push(defaultId);
  syncPiEnabledId();
  const pruned = defaultId !== prevDefaultId
    || enabledIds.length !== prevEnabledIds.length
    || enabledIds.some(id => !prevEnabledIds.includes(id));

  const emit = () => {
    syncPiEnabledId();
    // Default row first (PI_MODELS[0] IS the default), unchecked rows omitted, prefix added
    // back exactly once by _piRow(). Deep-copied so the caller's stored array is never aliased.
    const ordered = orderPiModelsForSave(piModels, piDefaultIdx).map((m) => _piRow(m));
    onChange({
      availableAgents: [...enabledIds],
      taskAgent: defaultId,
      piModels: ordered,
      clearPiModels,
      // Legacy row-0 mirror (= the default row) — setup-modal.js's scalar readers and callers
      // persisting config (project-creation-wizard.js → main.js) keep them around for back-compat.
      piModel: ordered[0]?.model || '',
      piApiKey: ordered[0]?.apiKey || '',
      // C1161 — one flat `{id}Model` key per opt-in modelSelects entry (e.g. claudeModel,
      // codexModel). Absent entirely when the caller passed no modelSelects.
      ...Object.fromEntries(Object.keys(modelSelects || {}).map((id) => [`${id}Model`, agentModels[id]])),
    });
  };

  const headerNote = single
    ? `<p class="setup-modal-hint">${t('agentSelect.oneAgentDetected')}</p>`
    : `<p class="setup-modal-hint">${t('agentSelect.enableAgentsHint')}</p>`;
  const recheckHtml = typeof onReCheck === 'function' ? _recheckBtnHtml() : '';
  container.innerHTML = `
    <div class="setup-modal-agent-header">${headerNote}${recheckHtml}</div>
    <div class="setup-modal-agent-grid"></div>
    <p class="setup-modal-agent-extra-note setup-modal-agent-unchecked-note" hidden>${_esc(t('agentSelect.uncheckedNotSaved'))}</p>`;
  if (recheckHtml) _wireRecheck(container, onReCheck);

  const gridEl = container.querySelector('.setup-modal-agent-grid');
  const noteEl = container.querySelector('.setup-modal-agent-unchecked-note');

  // Rebuilds ONLY the grid's children (cards, the Add/Edit form, the model-select blocks) from
  // working state. Called on structural changes — checkbox, radio, Add/Save/Cancel/Edit/Remove —
  // never on typing, so the form inputs keep their caret. All listeners are delegated on gridEl
  // below, so a rebuild never needs re-wiring.
  function renderGrid() {
    const cards = buildAgentCardRows({ agents, piModels, enabledIds, defaultId, piDefaultIdx, single });
    let html = '';
    cards.forEach((d, i) => {
      html += _cardHtml(d);
      if (d.kind === 'agent' && modelSelects?.[d.id]) {
        html += _modelExtraHtml(d.id, modelSelects[d.id], agentModels[d.id], d.enabled);
      }
      if (d.kind === 'pi-model' && form?.mode === 'edit' && form.idx === d.piIdx) {
        html += _piFormHtml(form, piModels.length);
      }
      // After the last Pi card: the inline Add form, or the quiet "+ Add model" row.
      if (d.id === 'pi' && cards[i + 1]?.id !== 'pi' && piAvailable) {
        html += form?.mode === 'add' ? _piFormHtml(form, piModels.length) : _piAddRowHtml(piModels.length);
      }
    });
    gridEl.innerHTML = html;
    _syncExtras(container, enabledIds);
    // Only worth saying when SOME (not all) models are unchecked: unchecking every Pi model
    // disables Pi and leaves the stored rows alone, so nothing is lost in that case.
    const checked = piModels.filter((r) => r.enabled !== false).length;
    noteEl.hidden = !(piAvailable && checked > 0 && checked < piModels.length);
  }

  // Re-focus the control the user just toggled — the rebuild replaced it.
  const refocus = (cls, id, piIdx) => {
    const idx = id === 'pi' ? `[data-pi-idx="${piIdx}"]` : '';
    gridEl.querySelector(`.${cls}[data-id="${id}"]${idx}`)?.focus();
  };

  const openForm = (mode, idx) => {
    const row = mode === 'edit' ? piModels[idx] : null;
    form = {
      mode, idx,
      draft: {
        provider: normalizePiProvider(row?.provider),
        model: row ? row.model : '',
        apiKey: row ? row.apiKey : '',
        apiKeyAction: row?.apiKeyAction,
        credentialRef: row?.credentialRef,
        hasApiKey: row?.hasApiKey,
        baseUrl: row?.baseUrl || '',
        api: row?.api || '', // no input for it — carried so an edit never drops it
      },
      issue: '',
    };
    closeSuggest();
    renderGrid();
    const modelInp = gridEl.querySelector('.sma-pi-model');
    if (modelInp) {
      modelInp.focus();
      modelInp.setSelectionRange(modelInp.value.length, modelInp.value.length);
      modelInp.closest('.setup-modal-agent-form')?.scrollIntoView?.({ block: 'nearest' });
    }
  };

  const setFormIssue = (issue) => {
    if (!form) return;
    form.issue = issue;
    const hint = gridEl.querySelector('.setup-modal-agent-form .setup-modal-agent-extra-hint');
    if (!hint) return;
    hint.textContent = issue;
    hint.hidden = !issue;
  };

  // ── (TPT191) Model typeahead ──────────────────────────────────────────────
  // Suggestions from GET /api/pi/models for the draft's provider, filtered client-side. An
  // aid only: the input stays free text and an empty/failed catalog just shows nothing. The
  // list is portaled to <body> (the grid scrolls and would clip it) and sits above every host
  // modal. Picking mutates the draft + input in place — no re-render, the caret stays put.
  let suggest = null; // { el, input, items, active }
  function closeSuggest() {
    if (!suggest) return;
    suggest.el.remove();
    suggest.input.setAttribute('aria-expanded', 'false');
    suggest = null;
  }
  const pickSuggestion = (catalogId) => {
    if (!form || !suggest) return;
    const input = suggest.input;
    form.draft.model = piCatalogDisplayId(catalogId, form.draft.provider);
    input.value = form.draft.model;
    closeSuggest();
    if (form.issue) setFormIssue('');
    input.focus();
  };
  const paintSuggest = () => {
    const { el, input, items, active } = suggest;
    el.innerHTML = items.map((id, i) => `<div class="sma-pi-suggest-option${i === active ? ' active' : ''}" role="option" data-index="${i}">${_esc(id)}</div>`).join('');
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const h = Math.min(el.scrollHeight, 220);
    el.style.left = `${r.left}px`;
    el.style.width = `${r.width}px`;
    el.style.top = below < h + 8 && r.top > below ? `${Math.max(4, r.top - h - 2)}px` : `${r.bottom + 2}px`;
    el.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  };
  async function openSuggest(input) {
    if (!form) return;
    const provider = form.draft.provider;
    const ids = await fetchPiModels(provider);
    // Stale by the time the catalog arrived: form closed, provider switched, focus moved on.
    if (!form || form.draft.provider !== provider || !input.isConnected || document.activeElement !== input) return;
    const items = filterPiModelSuggestions(ids, input.value);
    if (!items.length) { closeSuggest(); return; }
    if (!suggest || suggest.input !== input) {
      closeSuggest();
      const el = document.createElement('div');
      el.className = 'sma-pi-suggest';
      el.setAttribute('role', 'listbox');
      // mousedown (not click) + preventDefault keeps focus in the input, so blur never closes
      // the list before the pick registers.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const opt = e.target.closest?.('.sma-pi-suggest-option');
        if (opt && suggest) pickSuggestion(suggest.items[Number(opt.dataset.index)]);
      });
      document.body.appendChild(el);
      input.setAttribute('aria-expanded', 'true');
      suggest = { el, input, items, active: -1 };
    } else {
      suggest.items = items;
      suggest.active = -1;
    }
    paintSuggest();
  }
  // True when the key was consumed by the open list. Enter with no highlighted item falls
  // through to the form commit; Escape is swallowed ONLY while the list is open, so the host
  // modal's document-level Escape still closes the modal otherwise.
  function suggestKeydown(e) {
    if (!suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); openSuggest(e.target); return true; }
      return false;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggest.items.length;
      suggest.active = e.key === 'ArrowDown' ? (suggest.active + 1) % n : (suggest.active - 1 + n) % n;
      paintSuggest();
      return true;
    }
    if (e.key === 'Enter' && suggest.active >= 0) {
      e.preventDefault();
      pickSuggestion(suggest.items[suggest.active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSuggest();
      return true;
    }
    return false;
  }
  gridEl.addEventListener('focusin', (e) => { if (e.target.matches('.sma-pi-model')) openSuggest(e.target); });
  gridEl.addEventListener('focusout', (e) => { if (e.target.matches('.sma-pi-model')) closeSuggest(); });
  gridEl.addEventListener('scroll', closeSuggest, { passive: true });

  // Validate, then commit the form's draft as a checked row. `_displayRow()` strips a typed
  // `openrouter/` so the working array stays in display form whichever form was typed; _piRow()
  // adds it back once at emit time.
  const submitForm = () => {
    if (!form) return;
    const editIdx = form.mode === 'edit' ? form.idx : -1;
    const issue = addPiModelIssue(piModels, form.draft, editIdx);
    if (issue) { setFormIssue(issue); return; }
    const row = _displayRow({ ...form.draft, apiKey: String(form.draft.apiKey).trim() });
    closeSuggest();
    if (editIdx >= 0) piModels[editIdx] = { ...row, enabled: piModels[editIdx] ? piModels[editIdx].enabled : true };
    else if (piModels.length < PI_MAX_MODELS) piModels.push({ ...row, enabled: true });
    if (piModels.length) clearPiModels = false;
    form = null;
    syncPiEnabledId();
    renderGrid();
    emit();
  };

  const removeRow = (idx) => {
    if (!piModels[idx]) return;
    piModels.splice(idx, 1);
    if (!piModels.length) clearPiModels = true;
    if (piDefaultIdx === idx) piDefaultIdx = piModels.length ? Math.min(idx, piModels.length - 1) : -1;
    else if (piDefaultIdx > idx) piDefaultIdx -= 1; // same row, one slot up
    // An open form pointed at this row (or a later one whose index just shifted) — close it.
    if (form?.mode === 'edit' && form.idx >= idx) { form = null; closeSuggest(); }
    syncPiEnabledId();
    renderGrid();
    emit();
  };

  // ── Checkbox / radio ──────────────────────────────────────────────────────
  // A Pi checkbox toggles ONE model row; 'pi' in enabledIds follows from syncPiEnabledId().
  function onCheckbox(cb) {
    const id = cb.dataset.id;
    if (id === 'pi') {
      const row = piModels[Number(cb.dataset.piIdx)];
      if (row) row.enabled = cb.checked;
      syncPiEnabledId();
    } else if (cb.checked) {
      if (!enabledIds.includes(id)) enabledIds.push(id);
    } else {
      enabledIds = enabledIds.filter((x) => x !== id);
      // If this was the default, shift to first remaining enabled agent
      if (defaultId === id) defaultId = enabledIds[0] || '';
    }
    renderGrid();
    emit();
    refocus('sma-cb', id, cb.dataset.piIdx);
  }

  function onRadio(r) {
    if (!r.checked) return;
    defaultId = r.dataset.id;
    // Selecting a default implicitly enables that agent (or that Pi model row).
    if (defaultId === 'pi') {
      const i = Number(r.dataset.piIdx);
      if (piModels[i]) { piModels[i].enabled = true; piDefaultIdx = i; }
      syncPiEnabledId();
    } else if (!enabledIds.includes(defaultId)) {
      enabledIds.push(defaultId);
    }
    renderGrid();
    emit();
    refocus('sma-radio', r.dataset.id, r.dataset.piIdx);
  }

  gridEl.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('.sma-cb')) onCheckbox(el);
    else if (el.matches('.sma-radio')) onRadio(el);
    else if (el.matches('.sma-model-select')) { agentModels[el.dataset.id] = el.value; emit(); }
    else if (el.matches('.sma-pi-provider') && form) {
      // (TPT163/TPT191) Provider change updates the form in place — no re-render, so focus and
      // any typed text survive: placeholders, the key label ("optional" for a keyless provider)
      // and the Base URL row (custom endpoint only). The typed model text is left alone
      // (strip/add are both no-ops off OpenRouter, and applied once at commit time under
      // whichever provider is chosen).
      const nextProvider = normalizePiProvider(el.value);
      if (nextProvider !== form.draft.provider && form.draft.apiKeyAction === 'preserve') {
        form.draft.apiKeyAction = 'clear';
        form.draft.hasApiKey = false;
      }
      form.draft.provider = nextProvider;
      const meta = piProviderMeta(form.draft.provider);
      const formEl = el.closest('.setup-modal-agent-form');
      const modelInp = formEl && formEl.querySelector('.sma-pi-model');
      const keyInp = formEl && formEl.querySelector('.sma-pi-key');
      const keyLabel = formEl && formEl.querySelector('.sma-pi-key-label');
      const baseField = formEl && formEl.querySelector('.setup-modal-agent-extra-field--baseurl');
      if (modelInp) modelInp.placeholder = meta.modelPlaceholder;
      if (keyInp) { keyInp.placeholder = meta.keyPlaceholder; keyInp.setAttribute('aria-label', _keyLabel(meta)); }
      const clearBtn = formEl && formEl.querySelector('.sma-pi-key-clear');
      if (clearBtn && !form.draft.hasApiKey) clearBtn.hidden = true;
      if (keyLabel) keyLabel.textContent = _keyLabel(meta);
      if (baseField) baseField.hidden = !meta.supportsBaseUrl;
      closeSuggest();
      fetchPiModels(form.draft.provider); // warm the catalog for the model input
      setFormIssue('');
    }
  });

  // Typing mutates the draft in place and never re-renders, so the caret never moves.
  gridEl.addEventListener('input', (e) => {
    const el = e.target;
    if (!form) return;
    if (el.matches('.sma-pi-model')) { form.draft.model = el.value; openSuggest(el); }
    else if (el.matches('.sma-pi-key')) {
      form.draft.apiKey = el.value;
      form.draft.apiKeyAction = el.value.trim() ? 'replace' : (form.draft.hasApiKey ? 'preserve' : 'clear');
    }
    else if (el.matches('.sma-pi-baseurl')) form.draft.baseUrl = el.value;
    else return;
    if (form.issue) setFormIssue('');
  });

  // Enter commits the form. Escape is deliberately NOT bound here: every host modal owns a
  // document-level Escape that closes the whole modal, so Cancel is the button.
  gridEl.addEventListener('keydown', (e) => {
    if (e.target.matches('.sma-pi-model') && suggestKeydown(e)) return;
    if (e.key === 'Enter' && e.target.matches('.sma-pi-model, .sma-pi-key, .sma-pi-baseurl')) {
      e.preventDefault();
      submitForm();
    }
  });

  gridEl.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button');
    if (!btn || btn.disabled) return;
    if (btn.classList.contains('sma-pi-add')) {
      if (piModels.length < PI_MAX_MODELS) openForm('add', -1);
    } else if (btn.classList.contains('sma-pi-edit')) {
      openForm('edit', Number(btn.dataset.piIdx));
    } else if (btn.classList.contains('sma-pi-remove')) {
      removeRow(Number(btn.dataset.piIdx));
    } else if (btn.classList.contains('sma-pi-form-cancel')) {
      form = null;
      closeSuggest();
      renderGrid();
    } else if (btn.classList.contains('sma-pi-form-save')) {
      submitForm();
    } else if (btn.classList.contains('sma-pi-key-clear') && form) {
      form.draft.apiKey = '';
      form.draft.apiKeyAction = 'clear';
      form.draft.hasApiKey = false;
      const input = gridEl.querySelector('.sma-pi-key');
      if (input) { input.value = ''; input.placeholder = piProviderMeta(form.draft.provider).keyPlaceholder; }
      btn.hidden = true;
      setFormIssue('');
    }
  });

  renderGrid();

  // (TPT191) The provider registry arrives asynchronously. When it lands: repaint the cards
  // (labels) — or, with a form open, just its Provider <select>, so typed text and the caret
  // survive — and re-emit so the caller's piCredentialsMissing() gate re-judges keyless rows.
  if (!piProvidersLoaded()) {
    ensurePiProviders().then(() => {
      if (!piProvidersLoaded() || !gridEl.isConnected) return;
      const sel = form && gridEl.querySelector('.sma-pi-provider');
      if (sel) {
        sel.innerHTML = _providerOptionsHtml(normalizePiProvider(form.draft.provider));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        renderGrid();
      }
      emit();
    });
  }

  // Selection changed underneath the caller (stale agent pruned, or Pi enabled with no
  // models) — sync state before any user interaction so Confirm never writes a
  // since-unavailable agent.
  if (pruned) emit();
}

// Render the all-unavailable empty state: install commands per agent + Re-Check button.
function _renderEmpty(container, agents, onReCheck) {
  const items = agents.map(({ id, label, reason, detail }) => {
    const color = AGENT_COLORS[id] || '#888';
    const cmd   = AGENT_INSTALL[id] || '';
    // Non-"not found" reason (e.g. "not logged in") — installed but broken:
    // show the real reason instead of a misleading install command.
    const installed = reason && !/not found/i.test(reason);
    const detailHtml = installed
      ? `<span class="setup-modal-agent-unavailable" title="${_esc(_unavailHint(reason))}">${_esc(reason)}</span>`
      : `<code>${_esc(cmd)}</code>`;
    // (TPT567) Same launcher/probe diagnostics as the card grid — this all-unavailable list is
    // what a Windows user whose CLIs both fail detection actually sees.
    const diagHtml = _detailHtml(detail);
    return `
      <li class="setup-modal-agent-empty-item">
        <span class="setup-modal-agent-dot" style="background:${color}"></span>
        <span class="setup-modal-agent-name">${_esc(_displayName(id, label))}</span>
        ${detailHtml}
        ${diagHtml}
      </li>`;
  }).join('');

  container.innerHTML = `
    <div class="setup-modal-agent-empty">
      <p class="setup-modal-hint">${t('agentSelect.noAgentsDetected')}</p>
      <ul class="setup-modal-agent-empty-list">${items}</ul>
      ${_recheckBtnHtml()}
    </div>`;

  _wireRecheck(container, onReCheck);
}

// Re-Check button markup, shared by the empty state and the populated grid header.
// No id — both render paths can be on screen across re-renders and must not collide.
function _recheckBtnHtml() {
  return `<button type="button" class="setup-modal-btn setup-modal-btn--secondary setup-modal-agent-recheck">${_esc(t('agentSelect.recheck'))}</button>`;
}

// Wire the click handler for a Re-Check button rendered into container by either
// _renderEmpty() or the populated-grid header. async; the button shows a spinner
// while pending and restores itself if onReCheck() throws.
function _wireRecheck(container, onReCheck) {
  const btn = container.querySelector('.setup-modal-agent-recheck');
  if (!btn || typeof onReCheck !== 'function') return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      await onReCheck();
      // Success: onReCheck() replaces container.innerHTML, so this node is discarded.
    } catch {
      // Failure: restore the button so the user can retry.
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  });
}

// One card from a buildAgentCardRows() descriptor. The Pi model rows carry data-pi-idx (the
// display index) next to data-id="pi"; every Pi radio shares the single `sma-default` group with
// value="pi", so the emitted taskAgent is always the literal 'pi'.
function _cardHtml(d) {
  const piAttr = d.kind === 'pi-model' ? ` data-pi-idx="${d.piIdx}"` : '';
  const checkHtml = d.hasCheckbox
    ? `<input type="checkbox" class="sma-cb" data-id="${_esc(d.id)}"${piAttr}${d.enabled ? ' checked' : ''}${!d.available ? ' disabled' : ''} />`
    : '';
  const radioHtml = d.hasRadio
    ? `<label class="setup-modal-agent-default-wrap">
          <input type="radio" name="sma-default" class="sma-radio" data-id="${_esc(d.id)}"${piAttr} value="${_esc(d.id)}"${d.isDefault ? ' checked' : ''}${!d.available || !d.enabled ? ' disabled' : ''} />
          <span class="setup-modal-agent-default-label">${_esc(t('agentSelect.default'))}</span>
        </label>`
    : '';
  const unavailHtml = !d.available
    ? `<span class="setup-modal-agent-unavailable" title="${_esc(_unavailHint(d.reason))}">${_esc(_unavailText(d.reason))}</span>`
    : '';
  // (TPT567) Launcher path + probe exit/output behind the negative — the only place a packaged
  // app ever shows them. Full-width row under the name/reason line (card is flex-wrap).
  const detailHtml = !d.available ? _detailHtml(d.detail) : '';
  const isPi = d.kind === 'pi-model' || d.kind === 'pi-empty';
  const cls = `setup-modal-agent-card${isPi ? ' setup-modal-agent-card--pi' : ''}${d.isDefault ? ' is-selected' : ''}${!d.available ? ' is-unavailable' : ''}${d.kind === 'pi-model' && !d.enabled ? ' is-off' : ''}`;

  let nameHtml;
  let actionsHtml = '';
  if (d.kind === 'pi-model') {
    nameHtml = `<span class="setup-modal-agent-name">
          <span class="setup-modal-agent-provider">${_esc(d.providerLabel)}</span>
          <span class="setup-modal-agent-sep">·</span>
          <span class="setup-modal-agent-model" title="${_esc(d.storedModel)}">${_esc(d.modelText)}</span>
        </span>`;
    actionsHtml = `
        <button type="button" class="sma-pi-edit" data-pi-idx="${d.piIdx}" title="${_esc(t('agentSelect.editModelName', { name: d.name }))}" aria-label="${_esc(t('agentSelect.editModelName', { name: d.name }))}">✎</button>
        <button type="button" class="sma-pi-remove" data-pi-idx="${d.piIdx}" title="${_esc(t('agentSelect.removeModelName', { name: d.name }))}" aria-label="${_esc(t('agentSelect.removeModelName', { name: d.name }))}">×</button>`;
  } else if (d.kind === 'pi-empty') {
    nameHtml = `<span class="setup-modal-agent-name">${_esc(d.name)}</span>
        <span class="setup-modal-agent-sub">${_esc(t('agentSelect.noModelsYet'))}</span>`;
  } else {
    nameHtml = `<span class="setup-modal-agent-name">${_esc(d.name)}</span>`;
  }

  return `
      <div class="${cls}" data-id="${_esc(d.id)}"${piAttr}>
        ${checkHtml}
        <span class="setup-modal-agent-dot" style="background:${d.color}"></span>
        ${nameHtml}
        ${unavailHtml}${actionsHtml}
        ${radioHtml}
        ${detailHtml}
      </div>`;
}

// (TPT567) `detail` on an unavailable agent status — `{ bin, exit, output }` from
// BaseTaskAgent.buildDetectDetail(): the resolved launcher (null = not found), the auth/login
// probe's exit status and the first 200 chars of its output. Renders only the parts present;
// an absent/empty detail renders nothing, so pre-TPT567 servers and the IPC fallback rows are
// unaffected. Shared by the card grid (_cardHtml) and the all-unavailable list (_renderEmpty).
export function buildDetailLines(detail) {
  if (!detail || typeof detail !== 'object') return { bin: '', output: '' };
  const bin = detail.bin ? String(detail.bin) : '';
  const out = detail.output ? String(detail.output).trim() : '';
  const exit = Number.isInteger(detail.exit) ? `exit=${detail.exit}` : '';
  const output = [exit, out].filter(Boolean).join(' · ');
  return { bin, output };
}

function _detailHtml(detail) {
  const { bin, output } = buildDetailLines(detail);
  if (!bin && !output) return '';
  const binHtml = bin
    ? `<code class="setup-modal-agent-detail-bin" title="${_esc(t('agentSelect.detailLauncher'))}">${_esc(bin)}</code>`
    : '';
  const outHtml = output
    ? `<pre class="setup-modal-agent-detail-output" title="${_esc(t('agentSelect.detailProbe'))}">${_esc(output)}</pre>`
    : '';
  return `<div class="setup-modal-agent-detail">${binHtml}${outHtml}</div>`;
}

// The quiet "+ Add model" row shown while no form is open, with the N/8 count.
function _piAddRowHtml(count) {
  const atMax = count >= PI_MAX_MODELS;
  return `
      <div class="setup-modal-agent-add-row">
        <button type="button" class="setup-modal-btn setup-modal-btn--secondary sma-pi-add"${atMax ? ' disabled' : ''}
          title="${_esc(atMax ? t('agentSelect.maxModels', { n: PI_MAX_MODELS }) : t('agentSelect.addAnotherModel'))}">+ ${_esc(t('agentSelect.addModel'))}</button>
        <span class="setup-modal-agent-add-count">${count}/${PI_MAX_MODELS}</span>
      </div>`;
}

// The single inline Add/Edit form (Provider · Model · API key). Rendered at the bottom of the Pi
// group for Add, or directly under the card being edited for Edit — never both at once. The
// inputs carry no data-idx: there is only ever one form, and typing mutates form.draft in place.
function _piFormHtml(form, count) {
  const meta = piProviderMeta(form.draft.provider);
  const isEdit = form.mode === 'edit';
  return `
      <div class="setup-modal-agent-form" data-mode="${isEdit ? 'edit' : 'add'}">
        <div class="setup-modal-agent-form-fields">
          <label class="setup-modal-agent-extra-field setup-modal-agent-extra-field--provider">
            <span class="setup-modal-agent-extra-label">${_esc(t('agentSelect.provider'))}</span>
            <select class="setup-modal-input sma-pi-provider" aria-label="${_esc(t('agentSelect.provider'))}">${_providerOptionsHtml(meta.id)}</select>
          </label>
          <label class="setup-modal-agent-extra-field setup-modal-agent-extra-field--model">
            <span class="setup-modal-agent-extra-label">${_esc(t('agentSelect.model'))}</span>
            <input type="text" class="setup-modal-input sma-pi-model" value="${_esc(form.draft.model)}"
              placeholder="${_esc(meta.modelPlaceholder)}" autocomplete="off" spellcheck="false" aria-label="${_esc(t('agentSelect.model'))}"
              role="combobox" aria-autocomplete="list" aria-expanded="false" />
          </label>
          <div class="setup-modal-agent-extra-field setup-modal-agent-extra-field--key">
            <span class="setup-modal-agent-extra-label sma-pi-key-label">${_esc(_keyLabel(meta))}</span>
            <input type="password" class="setup-modal-input sma-pi-key" value="${_esc(form.draft.apiKey)}"
              placeholder="${_esc(form.draft.apiKeyAction === 'preserve' ? t('agentSelect.savedKeyKept') : meta.keyPlaceholder)}" autocomplete="off" spellcheck="false" aria-label="${_esc(_keyLabel(meta))}" />
            ${isEdit && form.draft.hasApiKey ? `<button type="button" class="sma-pi-key-clear">${_esc(t('agentSelect.clearSavedKey'))}</button>` : ''}
          </div>
          <label class="setup-modal-agent-extra-field setup-modal-agent-extra-field--baseurl"${meta.supportsBaseUrl ? '' : ' hidden'}>
            <span class="setup-modal-agent-extra-label">${_esc(t('agentSelect.baseUrl'))}</span>
            <input type="url" class="setup-modal-input sma-pi-baseurl" value="${_esc(form.draft.baseUrl)}"
              placeholder="${_esc(PI_BASE_URL_PLACEHOLDER)}" autocomplete="off" spellcheck="false" aria-label="${_esc(t('agentSelect.baseUrl'))}" />
          </label>
        </div>
        <p class="setup-modal-agent-extra-note">${_esc(t('agentSelect.providerHint'))}</p>
        <p class="setup-modal-agent-extra-hint"${form.issue ? '' : ' hidden'}>${_esc(form.issue)}</p>
        <div class="setup-modal-agent-form-actions">
          <span class="setup-modal-agent-add-count">${count}/${PI_MAX_MODELS}</span>
          <button type="button" class="setup-modal-btn setup-modal-btn--secondary sma-pi-form-cancel">${_esc(t('common.cancel'))}</button>
          <button type="button" class="setup-modal-btn setup-modal-btn--primary sma-pi-form-save">${_esc(isEdit ? t('agentSelect.saveModel') : t('agentSelect.addModel'))}</button>
        </div>
      </div>`;
}

// "API key", or "API key (optional)" for a provider whose `keyRequired` is false.
const _keyLabel = (meta) => t(meta.keyRequired ? 'agentSelect.apiKey' : 'agentSelect.apiKeyOptional');

// Provider <option>s in registry order. A selected id the registry doesn't list (a stored row
// seen before the registry loaded) still gets its own option, so it is never silently swapped.
function _providerOptionsHtml(selected) {
  const list = getPiProviders();
  const all = list.some((p) => p.id === selected) ? list : [...list, { id: selected, label: selected }];
  return all.map((p) => `<option value="${_esc(p.id)}"${p.id === selected ? ' selected' : ''}>${_esc(p.label)}</option>`).join('');
}

// C1161 — markup for one opt-in model-version <select>, rendered as a sibling under its
// own agent card, keyed by `data-for="{id}"`. `visible` controls the starting `hidden` state,
// kept in sync afterward by _syncExtras(). Rebuilt with the rest of the grid on every
// renderGrid(), from the working value in `current`.
function _modelExtraHtml(id, entry, current, visible) {
  const options = _modelOptionsHtml(entry, current);
  return `
    <div class="setup-modal-agent-extra" data-for="${_esc(id)}"${visible ? '' : ' hidden'}>
      <label class="setup-modal-agent-extra-field setup-modal-agent-extra-field--select">
        <span class="setup-modal-agent-extra-label">${_esc(entry.label)}</span>
        <select class="sma-model-select" data-id="${_esc(id)}" aria-label="${_esc(entry.label)}">${options}</select>
      </label>
    </div>`;
}

function _modelOptionsHtml(entry, current) {
  // A blank/unset working value ('' — no explicit project override) visually selects the
  // entry's own default (e.g. claude's 'opusplan') rather than leaving the browser to fall
  // back to whatever option happens to render first. An entry with a `placeholder` instead
  // of a `defaultValue` (codex) already treats '' as its own real, selectable option, so this
  // is a no-op there.
  const selected = current || entry.defaultValue || entry.placeholder?.value || '';
  const placeholderHtml = entry.placeholder
    ? `<option value="${_esc(entry.placeholder.value)}"${selected === entry.placeholder.value ? ' selected' : ''}>${_esc(entry.placeholder.label)}</option>`
    : '';
  const optionsHtml = (entry.options || []).map((o) => `<option value="${_esc(o.value)}"${o.value === selected ? ' selected' : ''}${o.description ? ` title="${_esc(o.description)}"` : ''}>${_esc(o.label)}</option>`).join('');
  return placeholderHtml + optionsHtml;
}

// Keep every per-agent model-select extra block (C1161) in sync with current enable state.
// Called after every renderGrid(). (The Pi rows are top-level cards now, not an extra block.)
function _syncExtras(container, enabledIds) {
  container.querySelectorAll('.setup-modal-agent-extra[data-for]').forEach((extra) => {
    extra.hidden = !enabledIds.includes(extra.dataset.for);
  });
}

// Shared gate: true when Pi ("Other Model") is enabled and its rows aren't usable — any
// row missing a model name or API key, or two rows naming the same model. Accepts BOTH
// shapes: the C1121 `piModels` array and the legacy scalar `piModel`/`piApiKey` pair
// setup-modal.js still passes (C1122 upgrades it). Callers (project-creation-wizard.js,
// setup-modal.js, agents-modal.js) use this to disable Next/Confirm/Save. Duplicates are
// judged on the SAVED id (`openrouter/` prefix included), matching sanitizePiModels().
export function piCredentialsMissing(value) {
  if (!value?.availableAgents?.includes('pi')) return false;
  return _piRowsIssue(normalizePiModels(value)) !== null;
}

// Short row label for an unavailable agent. Uses the server detect() reason when
// present — "not logged in" is NOT "not installed" and the fix differs.
function _unavailText(reason) {
  if (!reason) return t('agentSelect.notInstalled');
  if (/not logged in/i.test(reason)) return t('agentSelect.notLoggedIn');
  if (/not found/i.test(reason)) return t('agentSelect.notInstalled');
  return reason;
}

// Tooltip with the full reason + actionable fix hint.
function _unavailHint(reason) {
  if (!reason) return t('agentSelect.cliNotDetected');
  if (/not logged in/i.test(reason)) return t('agentSelect.notLoggedInHint', { reason });
  return reason;
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
