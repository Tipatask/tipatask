'use strict';

const _factories = {
  claude: () => new (require('./claude-agent'))(),
  codex:  () => new (require('./codex-agent'))(),
  pi:     () => new (require('./pi-agent'))(),
};

const _cache = {};

// Quota lookup must never use normalizeAgentId's unknown -> Claude fallback.
async function getAgentQuotaStatus(agentId, config, opts = {}) {
  const { normalizeQuota, reasonFor } = require('./quota-status');
  const projectRoot = opts.projectRoot || config.PROJECT_ROOT;
  if (!Object.hasOwn(_factories, agentId) || !['claude', 'codex'].includes(agentId)) {
    return normalizeQuota(agentId, projectRoot, { connectionState: 'unsupported', unavailableReason: 'unsupported_provider' });
  }
  try {
    return normalizeQuota(agentId, projectRoot, await getTaskAgent(agentId).getQuotaStatus(config, { ...opts, projectRoot }));
  } catch (err) {
    return normalizeQuota(agentId, projectRoot, { unavailableReason: reasonFor(err) });
  }
}

function normalizeAgentId(agentId) {
  return _factories[agentId] ? agentId : 'claude';
}

function getTaskAgent(agentId) {
  const key = normalizeAgentId(agentId);
  return _cache[key] || (_cache[key] = _factories[key]());
}

function getTaskAgentInfo(agentId) {
  const agent = getTaskAgent(agentId);
  return {
    id: agent.id,
    label: agent.label,
    approvalCommand: agent.approvalCommand,
    supportsPlanMode: agent.supportsPlanMode,
  };
}

// C1285 — display labels belong to the agent plugin registry, not to the currently
// selected/default agent. Keep one immutable id -> label map so every UI surface can
// name all registered agents consistently (especially Claude Code when Codex is default).
let _taskAgentLabels = null;
function getTaskAgentLabels() {
  if (!_taskAgentLabels) {
    _taskAgentLabels = Object.freeze(Object.fromEntries(
      Object.keys(_factories).map((id) => [id, getTaskAgent(id).label])
    ));
  }
  return _taskAgentLabels;
}

async function listTaskAgentStatuses(config, { force = false } = {}) {
  return Promise.all(Object.keys(_factories).map((id) => getTaskAgent(id).cachedDetect(config, force)));
}

// Synchronous cache-only counterpart for informational reads (WS config frames and
// GET /api/agent-config). Actual gates await listTaskAgentStatuses().
function listTaskAgentStatusesPeek(config) {
  return Object.keys(_factories).map((id) => getTaskAgent(id).peekDetect(config));
}

// The one invalidation entry point for agent detection in THIS process: busts resolveBin's
// memo (a not-found is otherwise cached forever, so a CLI installed after boot stays
// invisible) and awaits detection of every agent. Electron main and each forked
// per-window server hold separate copies of these caches — refreshing one never refreshes
// the other, so whichever process serves the read must be the one that calls this.
async function refreshAgentDetection(config) {
  try { require('../spawn-utils').clearBinCache(); } catch { /* best-effort */ }
  return listTaskAgentStatuses(config, { force: true });
}

async function listAvailableTaskAgents(config) {
  return (await listTaskAgentStatuses(config)).filter((agent) => agent.available);
}

function listAvailableTaskAgentsPeek(config) {
  return listTaskAgentStatusesPeek(config).filter((agent) => agent.available);
}

async function getAvailableAgents(config) {
  const all = (await listAvailableTaskAgents(config)).map((a) => a.id);
  const allowed = config && config.AVAILABLE_AGENTS;
  if (!allowed || allowed.length === 0) return all;
  const filtered = all.filter(id => allowed.includes(id));
  return filtered.length > 0 ? filtered : all;
}

function getAvailableAgentsPeek(config) {
  const all = listAvailableTaskAgentsPeek(config).map((a) => a.id);
  const allowed = config && config.AVAILABLE_AGENTS;
  if (!allowed || allowed.length === 0) return all;
  const filtered = all.filter(id => allowed.includes(id));
  return filtered.length > 0 ? filtered : all;
}

// Warm the detect cache for all agents before server listen. The async probes leave
// the event loop responsive while startup awaits their results.
async function preloadAgentDetection(config) {
  await listTaskAgentStatuses(config);
}

// C1131 — resolves the agent id a task should start with, project-scoped, so a task
// launched with no explicit pick reuses the LAST agent+model combination actually used to
// start a task in THIS project rather than the server's global startup TASK_AGENT snapshot
// (config.TASK_AGENT is a process.env-only snapshot — wrong for any project that isn't the
// Electron server's startup project, see project-config.js's recordLastUsedAgent()).
// Precedence: explicitId (already-validated caller pick) > config.json LAST_AGENT >
// config.json TASK_AGENT > global config.TASK_AGENT > 'claude'. Only a known factory id
// (claude/codex/pi) is ever returned at any step — availability (CLI installed/logged in)
// is deliberately NOT filtered here; that stays where it already lives (the WS `agent`
// param check, spawnTerminal's cachedDetect probe) so a transient login blip can't cause
// this resolver to silently substitute a different agent than the user's last choice.
// projectRoot may be '' /falsy (browser/single-project mode) — falls straight through to
// the global default, matching every other project-scoped reader in this file.
function resolveTaskAgentId(projectRoot, explicitId, cfgOverride) {
  if (explicitId && _factories[explicitId]) return explicitId;
  if (projectRoot) {
    try {
      const { readProjectConfig } = require('../project-config');
      const pc = readProjectConfig(projectRoot);
      if (pc) {
        if (pc.LAST_AGENT && _factories[pc.LAST_AGENT]) return pc.LAST_AGENT;
        if (pc.TASK_AGENT && _factories[pc.TASK_AGENT]) return pc.TASK_AGENT;
      }
    } catch { /* fall through to global default */ }
  }
  const cfg = cfgOverride || require('../config');
  return normalizeAgentId(cfg.TASK_AGENT);
}

// (C1504) Live per-agent model registry — see model-registry.js for the cache/fallback
// mechanics; getAvailableModels() on the agent (base-agent.js) is what actually does the
// work, this is just the registry-shaped entry point (mirrors getTaskAgentInfo() above).
async function listAgentModels(agentId, config, opts = {}) {
  const agent = getTaskAgent(agentId);
  const entry = await agent.getAvailableModels(config, opts);
  return { agent: agent.id, ...entry };
}

// (C1515) Cache-only counterpart — mirrors the peekDetect()/cachedDetect() split above,
// never probes. Deliberately does NOT go through normalizeAgentId() (which silently maps
// an unknown id to 'claude') — an unregistered agentId (e.g. 'gemini', which has no
// task-agent plugin) must read as "no cache entry", not "read claude's cache", so callers
// like providers/registry.js can tell "no live models for this provider" apart from
// "this provider isn't even registered". Returns the bare models array or null (cold
// cache / unregistered id) — same shape as model-registry.js's own peekModels().
function peekAgentModels(agentId, config) {
  if (!_factories[agentId]) return null;
  const { peekModels } = require('./model-registry');
  return peekModels(agentId, config);
}

// All registered agents at once, for the GET /api/agent-models route (no `agent` param).
// Per-agent try/catch: one agent's probe throwing (it shouldn't — see base-agent.js's
// getAvailableModels()/model-registry.js's resolveModels(), both fail open to a fallback
// list — but a defensive belt-and-suspenders here costs nothing) never blanks the response
// for the others.
async function listAllAgentModels(config, opts = {}) {
  const ids = Object.keys(_factories);
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      return [id, await listAgentModels(id, config, opts)];
    } catch (err) {
      console.error(`[task-agent] listAgentModels(${id}) failed:`, err.message);
      return [id, { agent: id, models: [], source: 'error', probedAt: Date.now() }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  getAgentQuotaStatus,
  getTaskAgent,
  getTaskAgentInfo,
  getTaskAgentLabels,
  listTaskAgentStatuses,
  listTaskAgentStatusesPeek,
  refreshAgentDetection,
  listAvailableTaskAgents,
  listAvailableTaskAgentsPeek,
  getAvailableAgents,
  getAvailableAgentsPeek,
  preloadAgentDetection,
  resolveTaskAgentId,
  listAgentModels,
  listAllAgentModels,
  peekAgentModels,
};
