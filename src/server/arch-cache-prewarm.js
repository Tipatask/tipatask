'use strict';

// Pre-warm the disk arch-doc cache (tipatask-arch-cache-<PROJECT_ID>.json) before objective
// sessions spawn. Eliminates the 386ms MCP stdio round-trip on the first get_tag_architectures
// call by making the tool-result-cache.js hook serve a PreToolUse deny instead.
//
// Tag selection priority:
//   1. tagsOverride — caller supplies explicit tag list (e.g. current task's tt-* tags)
//   2. Stats JSONL  — top-5 tag-set combos from prior session usage
//   3. Fallback     — 5 most-recently-modified tt-*.md files in ai/architecture/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archCache = require('../mcp/architecture-cache');
const ARCH_STALE_MS = 86_400_000; // 24 hours — matches tool-result-cache.js
const TOP_SETS = 5;
const MAX_TAGS = 12;

function readStatsFile(projectId) {
  const statsFile = path.join(os.tmpdir(), `tipatask-arch-tag-stats-${projectId}.jsonl`);
  try {
    const content = fs.readFileSync(statsFile, 'utf8');
    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function topTagsFromStats(entries) {
  const freq = new Map();
  for (const e of entries) {
    if (!Array.isArray(e.tags) || e.tags.length === 0) continue;
    const key = [...e.tags].sort().join(',');
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const union = new Set();
  let setsUsed = 0;
  for (const [key] of sorted) {
    if (setsUsed >= TOP_SETS) break;
    for (const tag of key.split(',')) union.add(tag);
    setsUsed++;
  }
  return [...union].slice(0, MAX_TAGS);
}

function mostRecentArchTags(archDir) {
  try {
    const files = fs.readdirSync(archDir).filter(f => f.startsWith('tt-') && f.endsWith('.md'));
    const withMtime = files.map(f => {
      try {
        const mtime = fs.statSync(path.join(archDir, f)).mtimeMs;
        return { tag: f.slice(0, -3), mtime };
      } catch { return null; }
    }).filter(Boolean);
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.slice(0, 5).map(x => x.tag);
  } catch { return []; }
}

function readCacheFile(cacheFile) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}

function writeCacheFile(cacheFile, cache) {
  const tmp = `${cacheFile}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cacheFile);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function prewarmArchCache({ projectId, tagsOverride, projectRoot } = {}) {
  if (!projectId) return;
  try {
    const cacheFile = path.join(os.tmpdir(), `tipatask-arch-cache-${projectId}.json`);
    // Resolve the active project's architecture dir (defaults to env/repo when projectRoot
    // is absent — dev/dogfood unchanged) so prewarm reads the right project's docs (C894).
    const archDir = archCache.resolveArchitectureDir(projectRoot);

    let tags;
    if (Array.isArray(tagsOverride) && tagsOverride.length > 0) {
      tags = tagsOverride.filter(t => typeof t === 'string').slice(0, MAX_TAGS);
    } else {
      const stats = readStatsFile(projectId);
      tags = stats.length > 0 ? topTagsFromStats(stats) : mostRecentArchTags(archDir);
    }

    if (tags.length === 0) return;

    const now = Date.now();
    const cache = readCacheFile(cacheFile);
    let wrote = false;

    for (const tag of tags) {
      const existing = cache[tag];
      const mdPath = path.join(archDir, `${tag}.md`);
      try {
        const stat = fs.statSync(mdPath);
        if (existing && (now - existing.ts) < ARCH_STALE_MS && existing.mtime === stat.mtimeMs) {
          // Fresh + mtime unchanged — skip, no write needed
          continue;
        }
        const content = fs.readFileSync(mdPath, 'utf8');
        cache[tag] = { content, mtime: stat.mtimeMs, ts: now };
        wrote = true;
      } catch { /* tag file missing — skip */ }
    }

    if (wrote) {
      writeCacheFile(cacheFile, cache);
      console.log(`[arch-prewarm] project=${projectId} tags=[${tags.join(',')}]`);
    }
  } catch (err) {
    console.error('[arch-prewarm] error:', err.message);
  }
}

module.exports = { prewarmArchCache };
