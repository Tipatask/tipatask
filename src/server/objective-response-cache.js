'use strict';

const crypto = require('node:crypto');

const TTL_MS = parseInt(process.env.OBJECTIVE_RESPONSE_CACHE_TTL_MS || '300000', 10);
const MAX_ENTRIES = parseInt(process.env.OBJECTIVE_RESPONSE_CACHE_MAX || '64', 10);

// Map<key, { payload, cachedAt }>
const _cache = new Map();
const _stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

function _fresh(entry) {
  return (Date.now() - entry.cachedAt) < TTL_MS;
}

// Evict the oldest entry when the map grows beyond MAX_ENTRIES.
function _evictOldest() {
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [k, v] of _cache) {
    if (v.cachedAt < oldestAt) { oldestAt = v.cachedAt; oldestKey = k; }
  }
  if (oldestKey !== null) { _cache.delete(oldestKey); _stats.evictions++; }
}

/**
 * Build a stable SHA-256 cache key from task state + user prompt + project + model.
 *
 * @param {{ taskId: string, task: object|null, tasks: object[], userText: string, projectPath?: string, provider?: string, model?: string }} opts
 */
function buildKey({ taskId, task, tasks, userText, projectPath, provider, model }) {
  const status = task ? task.status : null;
  const tags = task ? (task.tags || []).map(t => t.toLowerCase()).sort() : [];

  const counts = { pending: 0, in_progress: 0, on_fire: 0, completed: 0, canceled: 0 };
  for (const t of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, t.status)) counts[t.status]++;
  }

  const userTextSha = crypto.createHash('sha256').update((userText || '').trim()).digest('hex').slice(0, 16);
  // v3 (C1029): include provider+model — the chat-model-selector means a first-turn
  // re-ask with the same text but a different model must NOT replay the other model's
  // cached answer. v2 kept projectPath so per-project responses never collide across windows.
  const payload = JSON.stringify({ v: 3, taskId, status, tags, counts, userTextSha, projectPath: projectPath || '', provider: provider || '', model: model || '' });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Look up a cache entry by key. Returns { payload, cachedAt } if fresh, else null.
 */
function get(key) {
  const entry = _cache.get(key);
  if (!entry) { _stats.misses++; return null; }
  if (!_fresh(entry)) { _cache.delete(key); _stats.misses++; return null; }
  _stats.hits++;
  return entry;
}

/**
 * Store a payload under key.
 */
function set(key, payload) {
  if (_cache.size >= MAX_ENTRIES) _evictOldest();
  _cache.set(key, { payload, cachedAt: payload.cachedAt || Date.now() });
  _stats.sets++;
}

function invalidateAll() {
  _cache.clear();
}

function getStats() {
  return { ..._stats, size: _cache.size, ttlMs: TTL_MS, maxEntries: MAX_ENTRIES };
}

module.exports = { buildKey, get, set, invalidateAll, getStats };
