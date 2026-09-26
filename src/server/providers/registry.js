'use strict';

// Objective-chat provider/model registry (C1029).
// Leaf module — depends only on config + project-config + task-agent detection, never
// on claude-session.js/dispatch.js/context-manager.js, so it can be safely required
// by all of them without creating an import cycle.

const config = require('../config');
const { listTaskAgentStatusesPeek, listAgentModels, peekAgentModels } = require('../task-agent');
const { resolveBinAsync, peekResolvedBin } = require('../spawn-utils');
const { readProjectConfig, readPiEntries, readAvailableAgents, piConfiguredModelIds } = require('../project-config');

// (C1515) The two provider ids with a real C1504 model probe — mirrors client
// constants.js STATIC_MODEL_LISTS. Gemini/pi have no task-agent plugin/probe (see
// task-agent/index.js), so they're excluded here and always resolve through the static
// cfg[modelsKey] list below (offeredModelIds()'s rung 3).
const REGISTRY_AGENTS = ['claude', 'codex'];

// sessionIdField — which session-state.js field holds this provider's CLI-side session id.
// modelsKey — config.js array of selectable model strings (null = no user-selectable list).
// defaultKey — config.js key holding this provider's default/current model.
const PROVIDER_META = {
  // (C1254) label 'Claude Code' — matches the task-agent plugin's constructor label
  // (claude-agent.js) and the "always call it Claude Code" naming rule, so the
  // chat-model-selector optgroup, the terminal header caption, and the
  // provider-unavailable reason text all agree.
  claude: { label: 'Claude Code', sessionIdField: 'claudeSessionId', supportsEffort: true, supportsStreamDeltas: true, modelsKey: 'CLAUDE_MODELS', defaultKey: 'CLAUDE_MODEL' },
  codex: { label: 'Codex', sessionIdField: 'codexSessionId', supportsEffort: false, supportsStreamDeltas: false, modelsKey: 'CODEX_MODELS', defaultKey: 'CODEX_MODEL' },
  // (C1030) modelsKey now set — gemini/pi are user-selectable, see SELECTABLE_PROVIDERS below.
  gemini: { label: 'Gemini', sessionIdField: 'geminiSessionId', supportsEffort: false, supportsStreamDeltas: true, modelsKey: 'GEMINI_MODELS', defaultKey: 'GEMINI_MODEL' },
  // (C1136) label 'Other Model' — matches the wizard/setup-modal/agents-modal naming
  // (AGENT_DISPLAY_NAMES in agent-select.js) so the chat-model-selector optgroup, the
  // provider-unavailable error text, and the "<label> CLI not found" reason all agree.
  pi: { label: 'Other Model', sessionIdField: 'piSessionId', supportsEffort: false, supportsStreamDeltas: true, modelsKey: 'PI_MODELS', defaultKey: 'PI_MODEL' },
};

// (C1030) All four providers are now offered in the chat-model-selector UI.
const SELECTABLE_PROVIDERS = ['claude', 'codex', 'gemini', 'pi'];

// (TPT162) Providers that an EMPTY/absent AVAILABLE_AGENTS allowlist does NOT enable.
// "Unrestricted" for an empty allowlist means "every agent this app can run unprompted" —
// that universe is the task-agent plugin registry (task-agent/index.js's _factories is
// exactly claude/codex/pi). Gemini has no plugin, no login-state detection, and no wizard
// card (setup-modal.js/agent-select.js never write it into AVAILABLE_AGENTS), so it must be
// named explicitly to appear. Kept as an explicit const rather than derived from the plugin
// registry so a future Gemini task-agent plugin can't silently flip this default back on.
const OPT_IN_ONLY_PROVIDERS = ['gemini'];

// (C1101) Config fields a project's .tipatask/config.json can override the global
// default for — currently just Pi's ("Other Model") wizard-collected model. Extend
// here (and see the CLAUDE_MODEL/CODEX_MODEL follow-up note in the C1101 task) if
// another provider's default ever becomes per-project.
const PROJECT_MODEL_KEYS = ['PI_MODEL'];

// Per-project view of `config`, live-reading .tipatask/config.json for the model
// fields in PROJECT_MODEL_KEYS so a project's saved "Other Model" choice is valid
// (isValidSelection) and effective (resolveProviderModel/currentSelection/
// listObjectiveProviders) without restarting the server. Returns the `config`
// singleton itself — by identity — whenever there's nothing to override, so every
// pre-existing caller/project is unaffected.
//
// Object.create(config), not {...config}: config.js defines CLAUDE_BIN/CODEX_BIN/
// GEMINI_BIN/PI_BIN as enumerable lazy getters that shell out to resolveBin() (a
// login-shell probe with a 5s timeout) — a spread would eagerly fire all four on
// every call. Prototype delegation keeps them lazy and keeps later singleton model-default
// mutations (POST /api/config's CLAUDE_MODEL/CODEX_MODEL) visible through the view.
function configForProject(projectPath) {
  if (!projectPath) return config;
  let cfg;
  try { cfg = readProjectConfig(projectPath); } catch { cfg = null; }
  if (!cfg) return config;

  let view = null;
  for (const key of PROJECT_MODEL_KEYS) {
    const val = typeof cfg[key] === 'string' ? cfg[key].trim() : '';
    if (!val || val === config[key]) continue;
    if (!view) view = Object.create(config);
    view[key] = val;
    const meta = Object.values(PROVIDER_META).find(m => m.defaultKey === key);
    if (meta && meta.modelsKey) {
      const list = config[meta.modelsKey] || [];
      view[meta.modelsKey] = list.includes(val) ? list : [...list, val];
    }
  }

  // C1121 — PI_MODELS (array of {model,apiKey} rows) is now the sole source a
  // wizard-created project writes; the legacy flat PI_MODEL string handled by the loop
  // above is pre-C1121-only. Row 0's model becomes the view's PI_MODEL (skipped above
  // since it never matches the `typeof cfg[key] === 'string'` check), and every row's
  // model id is unioned into PI_MODELS so isValidSelection() accepts all of them, not
  // just the default.
  const piEntries = readPiEntries(cfg);
  if (piEntries.length) {
    if (!view) view = Object.create(config);
    if (view.PI_MODEL !== piEntries[0].model) view.PI_MODEL = piEntries[0].model;
    const list = config.PI_MODELS || [];
    const ids = piEntries.map(e => e.model);
    const merged = [...list, ...ids.filter(id => !list.includes(id))];
    view.PI_MODELS = merged;
  }

  // (C1136) PI_CONFIGURED_MODELS — the ids this project can actually spawn Pi with (a
  // model name AND an api key both entered). Computed via piConfiguredModelIds() (shared
  // with project-config.js summarizeAgents()'s "is Pi configured" question) rather than
  // re-deriving from piEntries above, because it ALSO covers the pre-C1121 legacy flat
  // PI_MODEL+OPENROUTER_API_KEY pair — this repo's own .tipatask/config.json is exactly
  // that shape, and the piEntries-only block above never set this field for it.
  // Deliberately NOT gated on "differs from the global default" — the startup project's
  // config.js already seeds config.PI_MODEL from this same file (see _resolvedPiModel),
  // so for THIS project view.PI_MODEL above is skipped as a no-op identical value, and a
  // "differs from global" gate would wrongly leave PI_CONFIGURED_MODELS unset for the
  // very project the server booted with.
  // C1122 note carried over: ids only, never apiKeys, never unioned with the global
  // env-default PI_MODELS list — those have no apiKey behind them, so a client rendering
  // a launch button (or, as of C1136, the chat-model-selector) per id must never offer
  // one it can't actually spawn with its own key.
  const configuredIds = piConfiguredModelIds(cfg);
  if (configuredIds.length) {
    if (!view) view = Object.create(config);
    view.PI_CONFIGURED_MODELS = configuredIds;
  }

  // (C1136) Project's own agent allowlist — .tipatask/config.json stores it as a CSV
  // STRING (config.js's process.env-derived config.AVAILABLE_AGENTS is an ARRAY of the
  // same name — readAvailableAgents() normalizes both). listObjectiveProviders() uses this
  // to hide a provider the project never selected. Keyed on the key's PRESENCE, not on it
  // being non-empty: a project that saved an empty allowlist owns `[]` (= no allowlist)
  // rather than falling through. Only a truly absent key falls through to
  // config.AVAILABLE_AGENTS, which is a server-boot default that no Settings save ever
  // mutates — so one project window's save can never change another's view.
  if (Object.prototype.hasOwnProperty.call(cfg, 'AVAILABLE_AGENTS')) {
    if (!view) view = Object.create(config);
    view.AVAILABLE_AGENTS = readAvailableAgents(cfg);
  }

  return view || config;
}

// "claude:claude-opus-5" → { providerId: 'claude', model: 'claude-opus-5' }. Splits on the
// FIRST ':' only (model ids never contain one, but keep this robust either way).
function parseSelection(str) {
  if (typeof str !== 'string' || !str) return null;
  const i = str.indexOf(':');
  if (i < 0) return null;
  const providerId = str.slice(0, i);
  const model = str.slice(i + 1);
  if (!providerId || !model) return null;
  return { providerId, model };
}

function formatSelection(providerId, model) {
  return `${providerId}:${model}`;
}

// (C1515) Live model ids for a REGISTRY_AGENTS provider (claude/codex — the two with a
// real C1504 probe) — a pure cache peek, NEVER probes. No side effects, so it's safe to
// call on every listObjectiveProviders()/isValidSelection() invocation, including from the
// hermetic bare-config test suite. Returns [] for gemini/pi (no probe exists — see
// task-agent/index.js's peekAgentModels(), which returns null for an unregistered id and
// [] whenever the models array itself is empty) and [] whenever the shared process-global
// cache (task-agent/model-registry.js) hasn't been warmed yet. Warming happens at server
// boot (index.js) and opportunistically whenever GET /api/agent-models is hit (the task
// edit modal's ensureAgentModels()) — both populate the SAME cache this reads; there is no
// warm-on-read here on purpose, so a cold read never triggers a CLI spawn as a side effect
// of an unrelated code path (a WS connect, a test assertion).
function liveModelIds(providerId, cfg) {
  if (!REGISTRY_AGENTS.includes(providerId)) return [];
  const cached = peekAgentModels(providerId, cfg);
  return cached && cached.length ? cached.map((m) => m.id) : [];
}

// (C1515) What the chat-model-selector dropdown offers, for claude/codex/gemini — the
// fallback ladder: the live cache if it has anything (rungs "live" and "last active"
// collapse into the one peek in liveModelIds() — peekAgentModels() returns whatever's
// cached, whether from this process's own probe or the disk mirror a previous run wrote),
// else the static cfg[modelsKey] allowlist (rung 3, never empty). NOT used for pi — its own
// C1136 narrowing (cfg.PI_CONFIGURED_MODELS, a model AND an api key both entered) is
// unrelated to this ladder and stays as its own inline branch in listObjectiveProviders().
function offeredModelIds(providerId, cfg) {
  const live = liveModelIds(providerId, cfg);
  if (live.length) return live;
  const meta = PROVIDER_META[providerId];
  return (meta && cfg[meta.modelsKey]) || [];
}

// (C1515) What a selection is ALLOWED to name, for claude/codex/gemini — a superset of
// offeredModelIds() (live ∪ static), so a resumed session or sticky localStorage pick
// naming an id the live catalog has since dropped keeps validating even though the dropdown
// no longer freshly offers it (same "live or static" leniency model-registry.js
// isModelAllowed() already applies to the task-edit modal's CLAUDE_MODEL/CODEX_MODEL
// fields). Deliberately NOT used for pi, which keeps its own two independent rules instead
// of being folded in here: isValidSelection() below still reads the WIDE cfg.PI_MODELS
// directly (back-compat for a legacy PI_MODEL-only project's resumed session, predates
// C1136), while applyModelSelection()'s real per-turn gate reads the NARROW
// entry.allowedModels === entry.models (the C1136 security boundary — a global-default Pi
// model has no api key behind it for this project). Unifying those two into one ladder
// would either loosen the C1136 boundary or break the legacy resume case; see
// registry.test.js for both directions covered.
function allowedModelIds(providerId, cfg) {
  const meta = PROVIDER_META[providerId];
  const staticIds = (meta && cfg[meta.modelsKey]) || [];
  const live = liveModelIds(providerId, cfg);
  return live.length ? Array.from(new Set([...live, ...staticIds])) : staticIds;
}

// Valid = selectable provider + model in that provider's current allowlist.
// cfg defaults to the global config singleton — pass a configForProject(path) view
// to also accept a project's custom Pi model (C1101).
function isValidSelection(str, cfg = config) {
  const parsed = parseSelection(str);
  if (!parsed) return false;
  if (!SELECTABLE_PROVIDERS.includes(parsed.providerId)) return false;
  const meta = PROVIDER_META[parsed.providerId];
  if (!meta || !meta.modelsKey) return false;
  // (C1515) pi is intentionally NOT routed through allowedModelIds() — see that function's
  // comment. This is the unchanged pre-C1515 check (cfg.PI_MODELS, the wide back-compat
  // list), byte-for-byte: meta.modelsKey for pi is already 'PI_MODELS'.
  const ids = parsed.providerId === 'pi' ? (cfg.PI_MODELS || []) : allowedModelIds(parsed.providerId, cfg);
  return ids.includes(parsed.model);
}

// Always returns a valid {providerId, model} pair — falls back to config.OBJECTIVE_PROVIDER
// (or 'claude' if that's not user-selectable) + that provider's configured default model.
function resolveSelection(str) {
  if (isValidSelection(str)) return parseSelection(str);
  const providerId = SELECTABLE_PROVIDERS.includes(config.OBJECTIVE_PROVIDER) ? config.OBJECTIVE_PROVIDER : 'claude';
  const meta = PROVIDER_META[providerId];
  return { providerId, model: config[meta.defaultKey] || '' };
}

// Current effective {providerId, model} for a live session (or the project default
// when no session/selection exists yet, e.g. the board watcher's global config frame).
function currentSelection(session, cfg) {
  const providerId = (session && session.providerType) || cfg.OBJECTIVE_PROVIDER;
  const meta = PROVIDER_META[providerId] || PROVIDER_META.claude;
  const model = (session && session.selectedModel) || cfg[meta.defaultKey] || '';
  return { providerId, model };
}

// Configured/default model for a provider, no session involved — the value a fresh spawn
// would use. Pass a configForProject(path) view for the per-project PI_MODEL (C1101).
function getProviderDefaultModel(providerId, cfg = config) {
  const meta = PROVIDER_META[providerId];
  if (!meta || !meta.defaultKey) return '';
  return (cfg && cfg[meta.defaultKey]) || '';
}

function getProviderSessionId(session, providerId) {
  const meta = PROVIDER_META[providerId] || PROVIDER_META.claude;
  return session[meta.sessionIdField] || null;
}

// (C1030) Resolve the model argv value for gemini/pi — session.selectedModel wins (the
// user's chat-model-selector choice), falling back to that provider's configured default.
// Same fallback shape as claude-session.js resolveClaudeModel(session), simplified: callers
// only reach gemini/pi-session.js once dispatch.js has already confirmed
// session.providerType matches, so the providerType-mismatch guard resolveClaudeModel needs
// (it can be called for non-Claude sessions too, e.g. heartbeat) doesn't apply here.
function resolveProviderModel(session, providerId, cfg) {
  const meta = PROVIDER_META[providerId] || PROVIDER_META.claude;
  return (session && session.selectedModel) || (cfg && cfg[meta.defaultKey]) || '';
}

function clearProviderSessionId(session, providerId) {
  const meta = PROVIDER_META[providerId] || PROVIDER_META.claude;
  session[meta.sessionIdField] = null;
}

// Used on a provider switch (Risk 10 in the plan) — returning to a provider used earlier
// in the same chat must NOT silently --resume a CLI history that's missing everything
// that happened on the other provider(s) in between.
function clearAllProviderSessionIds(session) {
  for (const meta of Object.values(PROVIDER_META)) session[meta.sessionIdField] = null;
}

// (C1045) Dedup map so an unavailable provider logs once per distinct reason, not on
// every listObjectiveProviders() call (invoked on every WS wire, every board-watcher
// connect, and every applyModelSelection gate check).
const _loggedUnavailable = new Map(); // providerId -> last logged "source|bin|reason" key

function _logUnavailable(providerId, source, bin, reason) {
  const key = `${source}|${bin}|${reason}`;
  if (_loggedUnavailable.get(providerId) === key) return;
  _loggedUnavailable.set(providerId, key);
  console.warn(`[objective:providers] ${providerId} unavailable — source=${source} bin=${bin ?? '(unresolved)'} reason=${reason || '(none)'}`);
}

// Joined with live CLI detection (same binaries/login-state the terminal task agents
// already probe) so an unavailable/not-logged-in provider is reported, not silently broken.
// Gemini has no task-agent plugin. A cold provider-list read starts its binary lookup
// asynchronously and treats it as unavailable until the next read sees the cached path.
// (C1136) Always returns all SELECTABLE_PROVIDERS entries — never drops one — so every
// existing `.find(p => p.id === X)` caller (registry.test.js, console-modal.js's launch-time
// agent picker) keeps working whether or not that provider ended up offerable. "Offerable"
// is instead exposed as two new booleans, computed once here so the chat-model-selector wire
// filter (ws-handlers.js) and the applyModelSelection() gate (dispatch.js) both read the same
// answer instead of re-deriving it and risking drift:
//   enabled    — this project's AVAILABLE_AGENTS allowlist includes this provider (readAvailableAgents;
//                empty/absent allowlist = no restriction = every provider enabled, matching
//                task-agent/index.js getAvailableAgents()'s same empty-allowlist fallback).
//   selectable — enabled && CLI available && has at least one model to offer. This is the
//                single "should this provider appear in the chat selector" answer.
// Provider lists are synchronous cache peeks. A turn gate explicitly awaits fresh
// detection and supplies those rows, so it never rejects from a stale negative.
function listObjectiveProviders(cfg, { statuses = null } = {}) {
  statuses = statuses || listTaskAgentStatusesPeek(cfg);
  const statusById = new Map(statuses.map(s => [s.id, s]));
  const allowedAgents = readAvailableAgents(cfg);
  return SELECTABLE_PROVIDERS.map((providerId) => {
    const meta = PROVIDER_META[providerId];
    const st = statusById.get(providerId);
    // (C1136) Pi's offered models are narrowed to the project's own configured ids (a model
    // name AND an api key both entered — piConfiguredModelIds()/PI_CONFIGURED_MODELS) instead
    // of cfg.PI_MODELS, which is unioned with global env defaults that have no key behind
    // them for this project. (C1515) Claude/Codex/Gemini instead go through offeredModelIds()
    // — the live-registry ladder for claude/codex, falling back to the static cfg[modelsKey]
    // allowlist for all three when there's no live cache (gemini has no probe at all).
    const modelIds = providerId === 'pi' ? (cfg.PI_CONFIGURED_MODELS || []) : offeredModelIds(providerId, cfg);
    const models = modelIds.map((value) => ({ value }));
    // (C1515) The wider validation allowlist — see allowedModelIds()'s comment for why pi is
    // excepted (its `models` above already IS the narrow value applyModelSelection() must
    // enforce, so allowedModels is just an alias for it here, not a separate computation).
    const allowedModels = providerId === 'pi' ? modelIds : allowedModelIds(providerId, cfg);
    let available = true;
    let reason = null;
    if (st) {
      available = st.available;
      reason = st.reason;
      if (!available) _logUnavailable(providerId, 'task-agent', peekResolvedBin(providerId), reason);
    } else {
      const bin = peekResolvedBin(providerId);
      if (bin === undefined) void resolveBinAsync(providerId);
      available = !!bin && bin !== providerId;
      reason = available ? null : `${meta.label} CLI not found on PATH`;
      if (!available) _logUnavailable(providerId, 'bin-probe', bin, reason);
    }
    // (TPT162) An empty/absent allowlist enables everything EXCEPT OPT_IN_ONLY_PROVIDERS —
    // see that const's comment. A non-empty allowlist is unchanged: named = enabled.
    const enabled = allowedAgents.length === 0
      ? !OPT_IN_ONLY_PROVIDERS.includes(providerId)
      : allowedAgents.includes(providerId);
    // Only overwrite `reason` when the CLI itself is fine — an unavailable CLI's reason
    // (checked above) is the more actionable message and must win. A project simply not
    // selecting a provider is a config choice, not a fault — deliberately not logged via
    // _logUnavailable (would spam every WS wire for every project's unselected agents).
    if (available && !enabled) {
      reason = (allowedAgents.length === 0 && OPT_IN_ONLY_PROVIDERS.includes(providerId))
        ? `${meta.label} is opt-in for objective chat — add "${providerId}" to AVAILABLE_AGENTS in .tipatask/config.json`
        : `${meta.label} is not enabled for this project`;
    } else if (available && enabled && models.length === 0) {
      reason = `No ${meta.label} is configured for this project`;
    }
    return {
      id: providerId,
      label: meta.label,
      available,
      enabled,
      selectable: enabled && available && models.length > 0,
      reason,
      defaultModel: getProviderDefaultModel(providerId, cfg),
      models,
      // (C1515) The validation superset applyModelSelection() enforces — see
      // allowedModelIds()'s comment. Bare model-id strings (unlike `models`, which is
      // {value} option objects) since nothing renders this one.
      allowedModels,
      // C1122 — Pi-only: the project's own configured PI_MODELS rows (ids, never
      // apiKeys). Same value as `models` above for pi as of C1136 (both narrowed to the
      // project's own configured ids) — kept as a separate field since console-modal.js's
      // launch-time agent picker reads this one specifically.
      configuredModels: providerId === 'pi' ? modelIds : [],
    };
  });
}

// Show only selectable configured providers; use the same flag as selection
// validation so the picker and server gate agree. An empty list is valid.
function listVisibleObjectiveProviders(cfg, opts) {
  const all = listObjectiveProviders(cfg, opts);
  const selectable = all.filter(p => p.selectable);
  if (selectable.length) return selectable;
  if (readAvailableAgents(cfg).length === 0) return [];
  return all.filter(p => p.enabled);
}

// (C1136) Clamp a no-live-session default selection (currentSelection(null, cfg) or a fresh
// session with no explicit selectedModel yet) to a provider actually present in `providers`
// — normally listVisibleObjectiveProviders()'s output — so objectiveSelection always names
// an option the client's objectiveProviders list actually has. Never applied to a session
// that has really picked a model (session.selectedModel set): reconnect stays
// session-authoritative even if that provider is no longer visible — chat-ui.js's own
// stale-selection heal handles showing/recovering the display in that rarer case.
function clampSelectionToProviders(sel, providers) {
  if (providers.some(p => p.id === sel.providerId && p.models.some(m => m.value === sel.model))) return sel;
  const first = providers[0];
  if (!first) return sel;
  const model = first.defaultModel || (first.models[0] && first.models[0].value) || '';
  return { providerId: first.id, model };
}

module.exports = {
  PROVIDER_META,
  SELECTABLE_PROVIDERS,
  OPT_IN_ONLY_PROVIDERS,
  REGISTRY_AGENTS,
  PROJECT_MODEL_KEYS,
  offeredModelIds,
  allowedModelIds,
  configForProject,
  parseSelection,
  formatSelection,
  isValidSelection,
  resolveSelection,
  currentSelection,
  getProviderSessionId,
  getProviderDefaultModel,
  resolveProviderModel,
  clearProviderSessionId,
  clearAllProviderSessionIds,
  listObjectiveProviders,
  listVisibleObjectiveProviders,
  clampSelectionToProviders,
};
