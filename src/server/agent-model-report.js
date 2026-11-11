'use strict';

// Reports this device's agent model lists to the Tipatask API, per registered project, so the web
// app's task Model field suggests exactly what this Task App offers
// (PUT /api/projects/:projectId/agent-models; the API side is api/src/lib/agent-models.js).
//
// What a project's report holds:
// - claude / codex: the live model registry (task-agent/model-registry.js), read cache-only — a
//   report never starts a CLI probe. Only a live `probe` entry is sent. A static fallback list
//   says nothing the web does not already fall back to, and leaving the agent out keeps the last
//   live list this device reported.
// - pi: the project's Pi rows a task can start on (configured rows minus tool-less ones, image
//   rows included — the task-start pickers' rule, src/client/pi-task-models.js), always sent and
//   [] when there are none, so a removed row disappears from the web too.
//
// The device is this machine's own row for the project's signed-in account
// (device-identity.js deviceIdForAccount()). Two checkouts of one API project report as one: their
// Pi rows are merged. A report goes out when its content changed, or HEARTBEAT_MS after the last
// one, which keeps the API's reported_at fresh so its read can leave out devices that went
// silent. A refused report is retried after a delay that depends on why (RETRY_MS), and logged
// once per failure streak.

const REPORT_AGENTS = Object.freeze(['claude', 'codex', 'pi']);

// Mirrors the API's AGENT_MODEL_LIMITS (api/src/lib/agent-models.js), which rejects a report past
// them; api/web/src/lib/agent-models.test.js compares the two when both checkouts are present.
const REPORT_LIMITS = Object.freeze({
  MAX_MODELS_PER_AGENT: 100,
  MAX_ID_LENGTH: 200,
  MAX_LABEL_LENGTH: 120,
});

const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
const POLL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
// After a refusal: an API without the route (or a device/project it no longer knows) is not
// asked again for hours; a permission problem for an hour; anything else (5xx, network) at the
// next sync at least a minute later.
const RETRY_MS = Object.freeze({ notFound: 6 * 60 * 60 * 1000, forbidden: 60 * 60 * 1000, other: 60 * 1000 });

// A model id is one token on the agent CLI's command line: printable ASCII, no whitespace — the
// API's isValidModelId().
function isReportableModelId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= REPORT_LIMITS.MAX_ID_LENGTH
    && /^[\x21-\x7e]+$/.test(id);
}

function reportLabel(label, id) {
  if (typeof label !== 'string') return null;
  const text = label.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, REPORT_LIMITS.MAX_LABEL_LENGTH).trim();
  return text && text !== id ? text : null;
}

// [{ id, label? }] in order: reportable ids only, each once, at most MAX_MODELS_PER_AGENT.
function modelList(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (out.length >= REPORT_LIMITS.MAX_MODELS_PER_AGENT) break;
    const id = entry && entry.id;
    if (!isReportableModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const label = reportLabel(entry.label, id);
    out.push(label ? { id, label } : { id });
  }
  return out;
}

// A model-registry entry ({ models: [{ id, label, isLatest }], source }) as a report list, or null
// when it is not a live probe result (cold cache, static fallback, probe error) or lists nothing.
function registryModels(entry) {
  if (!entry || entry.source !== 'probe' || !Array.isArray(entry.models)) return null;
  const models = modelList(entry.models);
  return models.length ? models : null;
}

// The project's Pi model ids a task can start on, in row order: configured rows (a model and,
// where its provider needs one, a key) minus tool-less rows, image rows included.
function piTaskModelIds(projectConfig) {
  if (!projectConfig) return [];
  const { readPiEntries, piConfiguredModelIds } = require('./project-config');
  const { piRowSupportsTools } = require('./pi-custom-endpoint');
  const { isImageModel } = require('../pi-image-settings');
  const entries = readPiEntries(projectConfig);
  const lower = id => String(id).toLowerCase();
  const images = new Set(entries.filter(isImageModel).map(e => lower(e.model)));
  const toolLess = new Set(entries.filter(e => !piRowSupportsTools(e)).map(e => lower(e.model)));
  return piConfiguredModelIds(projectConfig).filter(id => images.has(lower(id)) || !toolLess.has(lower(id)));
}

// Pure. The `agents` body of one report: { claude?: { models }, codex?: { models }, pi: { models } }.
// `registry` maps agent id → model-registry entry; `piModelIds` are the project's Pi task ids.
function buildAgentModelReport({ registry = {}, piModelIds = [] } = {}) {
  const agents = {};
  for (const agent of REPORT_AGENTS) {
    if (agent === 'pi') {
      agents.pi = { models: modelList(piModelIds.map(id => ({ id }))) };
      continue;
    }
    const models = registryModels(registry[agent]);
    if (models) agents[agent] = { models };
  }
  return agents;
}

function createAgentModelReporter({
  getProjectPaths,
  deviceIdentity,
  config,
  request = require('../cli/http').request,
  getCredentials = projectPath => require('./api-credentials').getApiCredentials(projectPath, { migrate: false }),
  readConfig = projectPath => require('./project-config').readProjectConfig(projectPath),
  peekEntry = agentId => require('./task-agent/model-registry').peekModelEntry(agentId, config),
  now = Date.now,
  heartbeatMs = HEARTBEAT_MS,
  pollMs = POLL_MS,
  debounceMs = DEBOUNCE_MS,
  log = console,
} = {}) {
  const sent = new Map();     // report key -> { fingerprint, at }
  const blocked = new Map();  // report key -> { until, failure }
  let running = null;
  let again = false;
  let debounce = null;
  let poll = null;
  let stopped = false;

  // [{ key, baseUrl, token, projectId, deviceId, piModelIds }] — one per API project, account
  // and device, its checkouts' Pi rows merged in registration order.
  async function collectTargets() {
    const targets = new Map();
    let paths = [];
    try { paths = [...(getProjectPaths() || [])]; } catch { paths = []; }
    for (const projectPath of paths) {
      let credentials;
      try { credentials = getCredentials(projectPath); } catch { continue; } // not an API project, or signed out
      const projectId = Number(credentials && credentials.projectId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0) continue;
      let origin;
      try { origin = new URL(credentials.baseUrl).origin; } catch { continue; }
      let deviceId = null;
      try { deviceId = await deviceIdentity.deviceIdForAccount(credentials); } catch { deviceId = null; }
      if (!Number.isSafeInteger(deviceId) || deviceId <= 0) continue;
      let projectConfig = null;
      try { projectConfig = readConfig(projectPath); } catch { projectConfig = null; }
      let piIds = [];
      try { piIds = piTaskModelIds(projectConfig); } catch { piIds = []; }
      const key = JSON.stringify([origin, projectId, deviceId]);
      const target = targets.get(key);
      if (target) {
        for (const id of piIds) if (!target.piModelIds.includes(id)) target.piModelIds.push(id);
      } else {
        targets.set(key, { key, baseUrl: credentials.baseUrl.replace(/\/+$/, ''), token: credentials.token, projectId, deviceId, piModelIds: [...piIds] });
      }
    }
    return [...targets.values()];
  }

  function noteFailure(target, status) {
    const reason = status === 404 || status === 405 ? 'notFound' : status === 401 || status === 403 ? 'forbidden' : 'other';
    const until = now() + RETRY_MS[reason];
    const failure = `[agent-models] could not report this device's model lists for project ${target.projectId} (${typeof status === 'number' ? `HTTP ${status}` : status}); retrying in ${Math.round(RETRY_MS[reason] / 60000)} min`;
    const previous = blocked.get(target.key);
    blocked.set(target.key, { until, failure });
    if (!previous || previous.failure !== failure) log.warn(failure);
  }

  async function report(target, registry) {
    const hold = blocked.get(target.key);
    if (hold && now() < hold.until) return;
    const agents = buildAgentModelReport({ registry, piModelIds: target.piModelIds });
    const fingerprint = JSON.stringify(agents);
    const last = sent.get(target.key);
    if (last && last.fingerprint === fingerprint && now() - last.at < heartbeatMs) return;
    let res;
    try {
      res = await request(`${target.baseUrl}/api/projects/${target.projectId}/agent-models`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${target.token}` },
        body: { device_id: target.deviceId, agents },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      noteFailure(target, (err && err.code) || 'network error');
      return;
    }
    if (res && res.status >= 200 && res.status < 300) {
      sent.set(target.key, { fingerprint, at: now() });
      if (blocked.delete(target.key)) log.log(`[agent-models] reported this device's model lists for project ${target.projectId} again`);
      return;
    }
    noteFailure(target, res ? res.status : 'no response');
  }

  async function syncOnce() {
    const targets = await collectTargets();
    if (!targets.length) return;
    const registry = {};
    for (const agent of REPORT_AGENTS.filter(id => id !== 'pi')) {
      try { registry[agent] = peekEntry(agent); } catch { registry[agent] = null; }
    }
    for (const target of targets) {
      if (stopped) return;
      await report(target, registry);
    }
  }

  // Runs one sync now, or one more right after the sync already running. Never rejects.
  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try { await syncOnce(); } catch (err) { log.warn(`[agent-models] report failed: ${err && err.message}`); }
      } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  // A sync shortly from now, coalescing a burst of triggers (several registry probes finishing,
  // window binds) into one.
  function schedule() {
    if (stopped || debounce) return;
    debounce = setTimeout(() => { debounce = null; void sync(); }, debounceMs);
    if (debounce.unref) debounce.unref();
  }

  // The periodic sync: picks up Pi row edits and keeps the heartbeat going. A sync with nothing
  // new sends nothing.
  function start() {
    if (poll || stopped) return;
    poll = setInterval(schedule, pollMs);
    if (poll.unref) poll.unref();
    schedule();
  }

  function stop() {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    if (poll) clearInterval(poll);
    debounce = null;
    poll = null;
  }

  return { sync, schedule, start, stop };
}

module.exports = {
  REPORT_AGENTS,
  REPORT_LIMITS,
  HEARTBEAT_MS,
  POLL_MS,
  RETRY_MS,
  isReportableModelId,
  registryModels,
  piTaskModelIds,
  buildAgentModelReport,
  createAgentModelReporter,
};
