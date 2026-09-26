'use strict';

// Parse and cache CLI-discovered models; agent adapters own the probes. Keep
// hardcoded lists as fallback. Persist cache to share results with the Electron
// main process, which has a separate memory cache.

const fs = require('node:fs');
const path = require('node:path');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — the requested "once per day" ceiling
// A failed/empty probe (CLI missing, minifier changed the binary layout, network down for
// Codex) is cached far more briefly than a real result — same "never serve a stale negative
// for hours" reasoning base-agent.js's cachedDetect() already applies to CLI availability
// (NEGATIVE_DETECT_TTL_MS there). Without this, one bad probe would hide a CLI's real model
// list for a full day.
const FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Claude's own public family names (its CLI's alias table — RP/Gvt arrays in the installed
// binary — confirmed against 2.1.263). `mythos` (and any future preview family) is deliberately
// excluded: it showed up in the binary's model table but isn't one of the CLI's own selectable
// aliases, i.e. not something a normal account can pick via --model.
const PUBLIC_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

// Hardcoded, not scraped — alias inputs change far less often than concrete model ids, and
// `opusplan` (today's project default, config.js CLAUDE_MODEL fallback) must always be
// present regardless of what the binary scan finds, or a saved default stops validating.
const CLAUDE_ALIASES = [
  { id: 'opusplan', label: 'opusplan (default)' },
  { id: 'opus', label: 'opus (latest Opus)' },
  { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
  { id: 'haiku', label: 'haiku (latest Haiku)' },
  { id: 'fable', label: 'fable (latest Fable)' },
].map(a => ({ ...a, isLatest: true }));

// Claude's embedded table gives a clean display_name ("Opus 5", "Haiku 3.5", "Sonnet 4") —
// parsing the trailing version number off THAT is far more robust than trying to parse a
// version out of the id, since id naming isn't consistent across eras (claude-opus-4-8 vs
// claude-3-5-haiku vs claude-fable-5-1).
function versionTuple(displayName) {
  const m = /(\d+(?:\.\d+)*)\s*$/.exec(String(displayName || ''));
  if (!m) return [0];
  return m[1].split('.').map(n => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Matches the installed Claude CLI's embedded model-table records, e.g.
// id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026"
// Deliberately narrow (only the 3 fields this registry needs) so it keeps matching even if
// unrelated fields around it (knowledge_cutoff, provider_ids, capabilities, …) change shape.
const CLAUDE_ROW_RE = /id:"(claude-[a-z0-9.-]+)",family:"([a-z0-9]+)",display_name:"([^"]{1,40})"/g;

// Pure — takes the raw scanned text (or any string containing these records) and returns
// the public-family model rows, newest-first per family, with isLatest on the top id of
// each family. Returns [] on no matches (caller treats that as "probe found nothing" and
// falls back to the static list) — this must never throw on unexpected input.
function parseClaudeModelTable(text) {
  const rows = [];
  const seen = new Set();
  const re = new RegExp(CLAUDE_ROW_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) {
    const [, id, family, displayName] = m;
    if (!PUBLIC_FAMILIES.includes(family)) continue;
    if (seen.has(id)) continue; // chunk-boundary rescans can re-find the same record
    seen.add(id);
    rows.push({ id, family, label: displayName, version: versionTuple(displayName) });
  }
  const latestPerFamily = new Map();
  for (const row of rows) {
    const cur = latestPerFamily.get(row.family);
    if (!cur || compareVersions(row.version, cur.version) > 0) latestPerFamily.set(row.family, row);
  }
  rows.sort((a, b) => {
    if (a.family !== b.family) return PUBLIC_FAMILIES.indexOf(a.family) - PUBLIC_FAMILIES.indexOf(b.family);
    return compareVersions(b.version, a.version); // newest first within a family
  });
  return rows.map(r => ({ id: r.id, label: r.label, isLatest: latestPerFamily.get(r.family) === r }));
}

// Aliases first (always present, always isLatest), then the concrete ids found in the binary.
// Returns just the aliases when the scan found nothing — never an empty list, since the
// aliases alone are enough to spawn a task (they're what --model already accepts today).
function buildClaudeModelList(scannedText) {
  return [...CLAUDE_ALIASES, ...parseClaudeModelTable(scannedText)];
}

// Pure — takes the parsed JSON body of `codex debug models` (or the on-disk
// ~/.codex/models_cache.json mirror, same {"models":[...]} shape) and returns the
// user-selectable subset. `visibility !== "list"` entries (e.g. "gpt-reserve",
// "codex-auto-review") are internal/hidden models, not real user choices — same distinction
// the CLI's own model picker makes. Sorted by the catalog's own `priority` (lower = more
// prominent); isLatest on the top entry, matching what the CLI recommends by default.
function parseCodexCatalog(json) {
  const models = Array.isArray(json && json.models) ? json.models : [];
  const visible = models
    .filter(m => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .slice()
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  return visible.map((m, i) => ({ id: m.slug, label: m.display_name || m.slug, isLatest: i === 0 }));
}

// Fallback source of truth when a probe fails or returns nothing: the existing static
// config.js lists (still the single id source for these two agents — unchanged by C1504).
// Labels fall back to the raw id, same as the client's modelLabel() does today for any id
// missing from its display-label table — this registry doesn't duplicate that table
// server-side. First entry is flagged isLatest (CLAUDE_MODELS[0] is 'opusplan', the
// project default; CODEX_MODELS[0] is the current top model — both lists are already
// ordered "default/newest first").
function fallbackModels(agentId, config) {
  const ids = agentId === 'claude' ? config.CLAUDE_MODELS
    : agentId === 'codex' ? config.CODEX_MODELS
      : [];
  return (ids || []).map((id, i) => ({ id, label: id, isLatest: i === 0 }));
}

// ── Process-global cache + disk mirror ──

const _cache = new Map();    // agentId -> { models, source: 'probe'|'fallback', probedAt, key }
const _inflight = new Map(); // agentId -> Promise<entry> — coalesces concurrent window requests
let _diskHydrated = false;

function registryFilePath(config) {
  return path.join(config.USER_DATA_ROOT, 'model-registry.json');
}

function readDiskCache(config) {
  try { return JSON.parse(fs.readFileSync(registryFilePath(config), 'utf8')); } catch { return {}; }
}

// Atomic tmp+rename write, fail-open — same shape as arch-cache-prewarm.js's
// readCacheFile/writeCacheFile pair. A write failure just means this process keeps its
// in-memory cache and re-probes on next restart; never worth surfacing to a caller.
function writeDiskCache(config, data) {
  const file = registryFilePath(config);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(config.USER_DATA_ROOT, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function hydrateFromDisk(config) {
  if (_diskHydrated) return;
  _diskHydrated = true;
  const disk = readDiskCache(config);
  for (const [agentId, entry] of Object.entries(disk || {})) {
    if (!_cache.has(agentId) && entry && Array.isArray(entry.models)) {
      _cache.set(agentId, entry);
    }
  }
}

function persistToDisk(config) {
  const obj = {};
  for (const [k, v] of _cache.entries()) obj[k] = v;
  writeDiskCache(config, obj);
}

function ttlFor(entry) {
  return entry.source === 'probe' ? TTL_MS : FALLBACK_TTL_MS;
}

function isFresh(entry, now) {
  return entry && (now - entry.probedAt) < ttlFor(entry);
}

// The one entry point. Never throws — a probe failure (or empty result) degrades to
// fallbackModels() instead. `agent` is a BaseTaskAgent instance (has probeModels()/
// getModelProbeKey()); `config` is the shared config singleton (for USER_DATA_ROOT + the
// static fallback lists). Pass { force: true } to bypass TTL/key freshness entirely.
async function resolveModels(agent, config, { force = false } = {}) {
  hydrateFromDisk(config);
  const now = Date.now();
  const currentKey = safeProbeKey(agent, config);
  const cached = _cache.get(agent.id);
  if (!force && cached && cached.key === currentKey && isFresh(cached, now)) {
    return cached;
  }
  const inflight = _inflight.get(agent.id);
  if (inflight) return inflight;

  const promise = Promise.resolve()
    .then(() => agent.probeModels(config))
    .then((models) => {
      const entry = Array.isArray(models) && models.length > 0
        ? { models, source: 'probe', probedAt: Date.now(), key: currentKey }
        : { models: fallbackModels(agent.id, config), source: 'fallback', probedAt: Date.now(), key: currentKey };
      _cache.set(agent.id, entry);
      persistToDisk(config);
      return entry;
    })
    .catch((err) => {
      console.error(`[model-registry] ${agent.id} probe failed:`, err && err.message);
      const entry = { models: fallbackModels(agent.id, config), source: 'fallback', probedAt: Date.now(), key: currentKey };
      _cache.set(agent.id, entry);
      persistToDisk(config);
      return entry;
    })
    .finally(() => { _inflight.delete(agent.id); });

  _inflight.set(agent.id, promise);
  return promise;
}

function safeProbeKey(agent, config) {
  try { return agent.getModelProbeKey(config) || ''; } catch { return ''; }
}

// Cache-only read — never probes. Used by isModelAllowed() (validation must never block on
// a cold probe) and available to anything else that wants a non-blocking peek, mirroring
// base-agent.js's peekDetect()/cachedDetect() split.
function peekModels(agentId, config) {
  hydrateFromDisk(config);
  const entry = _cache.get(agentId);
  return entry ? entry.models : null;
}

// Validator for POST /api/config's CLAUDE_MODEL/CODEX_MODEL fields. A value is allowed when
// it's in the live cache, in the static fallback list, OR is the value already saved for
// this project (so a value discovered by a probe that has since rotated out, or set before
// this registry existed, never becomes un-savable). Empty string always means "project
// default" and is allowed unconditionally, matching the pre-existing behavior.
function isModelAllowed(agentId, value, projectRoot, config) {
  if (!value) return true;
  const peeked = peekModels(agentId, config) || [];
  if (peeked.some(m => m.id === value)) return true;
  const staticIds = agentId === 'claude' ? config.CLAUDE_MODELS : agentId === 'codex' ? config.CODEX_MODELS : [];
  if ((staticIds || []).includes(value)) return true;
  if (projectRoot) {
    try {
      const { readProjectConfig } = require('../project-config');
      const cfg = readProjectConfig(projectRoot);
      const field = agentId === 'claude' ? 'CLAUDE_MODEL' : agentId === 'codex' ? 'CODEX_MODEL' : null;
      if (field && cfg && cfg[field] === value) return true;
    } catch { /* fall through to reject */ }
  }
  return false;
}

// Test-only: wipe process-global state between test cases in the same file (node:test may
// run multiple `test()` blocks in one process/module instance).
function _resetForTest() {
  _cache.clear();
  _inflight.clear();
  _diskHydrated = false;
}

module.exports = {
  TTL_MS,
  FALLBACK_TTL_MS,
  PUBLIC_FAMILIES,
  CLAUDE_ALIASES,
  versionTuple,
  compareVersions,
  parseClaudeModelTable,
  buildClaudeModelList,
  parseCodexCatalog,
  fallbackModels,
  resolveModels,
  peekModels,
  isModelAllowed,
  _resetForTest,
};
