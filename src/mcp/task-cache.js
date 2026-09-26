'use strict';

const TTL_MS = parseInt(process.env.MCP_TASK_CACHE_TTL_MS || '5000', 10);
const LOG = process.env.MCP_TASK_CACHE_LOG === '1';

// Per-key slots isolate cached values and in-flight requests by project.
// The default slot (key = '') is used by MCP child-process callers (one project
// per process — correct to share within that process). Multi-window server-side
// callers pass the backend instance as the key to get isolated slots.
const _slots = new Map();
const _DEFAULT_KEY = '';

function _getSlot(key) {
  const k = key === undefined || key === null ? _DEFAULT_KEY : key;
  let slot = _slots.get(k);
  if (!slot) {
    slot = { generation: 0, listEntry: null, listInflight: null, taskMap: new Map(), taskInflight: new Map() };
    _slots.set(k, slot);
  }
  return slot;
}

const stats = { hits: 0, listFetches: 0, taskHits: 0, taskFetches: 0, invalidations: 0, inflightJoins: 0 };

function _listFresh(slot) {
  return slot.listEntry !== null && (Date.now() - slot.listEntry.at) < TTL_MS;
}

function _taskFresh(slot, id) {
  const e = slot.taskMap.get(id);
  return e && (Date.now() - e.at) < TTL_MS ? e.task : null;
}

async function getTasks(backend, key) {
  const slot = _getSlot(key);
  const t = LOG ? Date.now() : 0;

  if (_listFresh(slot)) {
    stats.hits++;
    if (LOG) process.stderr.write(`[mcp:task-cache] op=list outcome=hit ms=${Date.now() - t} hits=${stats.hits} fetches=${stats.listFetches}\n`);
    return slot.listEntry.rows;
  }

  if (slot.listInflight) {
    stats.inflightJoins++;
    if (LOG) process.stderr.write(`[mcp:task-cache] op=list outcome=inflight joins=${stats.inflightJoins}\n`);
    return slot.listInflight;
  }

  stats.listFetches++;
  // Use unfiltered list so MCP agents see all assignees' tasks.
  const _listFn = backend.getTasksUnfiltered ? backend.getTasksUnfiltered.bind(backend) : backend.getTasks.bind(backend);
  const generation = slot.generation;
  const request = Promise.resolve(_listFn()).then(rows => {
    if (slot.generation === generation && slot.listInflight === request) {
      slot.listEntry = { rows, at: Date.now() };
    }
    if (LOG) process.stderr.write(`[mcp:task-cache] op=list outcome=fetch ms=${Date.now() - t} fetches=${stats.listFetches}\n`);
    return rows;
  }).finally(() => {
    if (slot.listInflight === request) slot.listInflight = null;
  });
  slot.listInflight = request;
  return request;
}

async function getTask(backend, id, key) {
  const slot = _getSlot(key);
  const t = LOG ? Date.now() : 0;

  // prefer list cache first (avoids extra round-trip)
  if (_listFresh(slot)) {
    const task = slot.listEntry.rows.find(r => r.id === id) || null;
    stats.taskHits++;
    if (LOG) process.stderr.write(`[mcp:task-cache] op=get id=${id} outcome=list-hit ms=${Date.now() - t}\n`);
    return task;
  }

  const cached = _taskFresh(slot, id);
  if (cached) {
    stats.taskHits++;
    if (LOG) process.stderr.write(`[mcp:task-cache] op=get id=${id} outcome=hit ms=${Date.now() - t}\n`);
    return cached;
  }

  const inflight = slot.taskInflight.get(id);
  if (inflight) {
    stats.inflightJoins++;
    return inflight;
  }

  stats.taskFetches++;
  const generation = slot.generation;
  const request = Promise.resolve(backend.getTask(id)).then(task => {
    if (task && slot.generation === generation && slot.taskInflight.get(id) === request) {
      slot.taskMap.set(id, { task, at: Date.now() });
    }
    if (LOG) process.stderr.write(`[mcp:task-cache] op=get id=${id} outcome=fetch ms=${Date.now() - t}\n`);
    return task;
  }).finally(() => {
    if (slot.taskInflight.get(id) === request) slot.taskInflight.delete(id);
  });
  slot.taskInflight.set(id, request);
  return request;
}

function invalidate(key) {
  if (key !== undefined) {
    // Clear one slot (pass backend instance or '' for default)
    const k = key === null ? _DEFAULT_KEY : key;
    const slot = _slots.get(k);
    if (slot) {
      slot.generation++;
      slot.listEntry = null;
      slot.listInflight = null;
      slot.taskMap.clear();
      slot.taskInflight.clear();
    }
  } else {
    // No-arg: clear all slots — preserves semantics used by MCP child (invalidate())
    for (const slot of _slots.values()) {
      slot.generation++;
      slot.listEntry = null;
      slot.listInflight = null;
      slot.taskMap.clear();
      slot.taskInflight.clear();
    }
  }
  stats.invalidations++;
}

function getStats() {
  return { ...stats };
}

function resetStats() {
  Object.keys(stats).forEach(k => { stats[k] = 0; });
}

module.exports = { getTasks, getTask, invalidate, getStats, resetStats, TTL_MS };
