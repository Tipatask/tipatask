#!/usr/bin/env node
'use strict';

// Benchmark architecture-cache.js in isolation (no MCP stdio overhead).
// Measures cold-read vs warm-hit latency to separate cache from transport cost.
//
// Usage: node scripts/bench-arch-cache.js

const cache = require('../src/mcp/architecture-cache');

const REPS = 5;

function ns() { return process.hrtime.bigint(); }
function fmtNs(n) {
  const us = Number(n) / 1e3;
  return us < 1000 ? `${us.toFixed(1)}µs` : `${(us / 1e3).toFixed(2)}ms`;
}

// ── 1. Warm cache ──
const { count, ms: loadMs } = cache.loadAll();
console.log(`\nloadAll(): ${count} tags in ${loadMs}ms`);
cache.resetStats();

// ── 2. Pick up to 5 tags ──
const tags = cache.listSystemTags().slice(0, 5).map(t => t.tag);
cache.resetStats();

// ── 3. Cold reads (invalidate first so first call per tag is a real read) ──
console.log('\n--- Cold read (post-invalidate, mtime unchanged → stat+bump, no readFileSync) ---');
for (const tag of tags) {
  cache.invalidate(tag);
  cache.resetStats();
  const t0 = ns();
  cache.getTagArchitecture(tag);
  const elapsed = ns() - t0;
  const s = cache.getStats();
  const outcome = s.hits ? 'hit' : s.mtimeRevalidations ? 'revalidated' : s.contentReads ? 'read' : s.misses ? 'miss' : '?';
  console.log(`  ${tag.padEnd(45)} outcome=${outcome} ${fmtNs(elapsed)}`);
}

// ── 4. Warm hits ──
console.log('\n--- Warm hits (TTL-fresh, no I/O) ---');
cache.resetStats();
for (const tag of tags) {
  const t0 = ns();
  cache.getTagArchitecture(tag);
  const elapsed = ns() - t0;
  console.log(`  ${tag.padEnd(45)} ${fmtNs(elapsed)}`);
}

// ── 5. Repeated warm hits (5×) ──
console.log('\n--- 5× warm hit per tag ---');
for (const tag of tags) {
  const times = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = ns();
    cache.getTagArchitecture(tag);
    times.push(ns() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0n) / BigInt(REPS);
  console.log(`  ${tag.padEnd(45)} avg=${fmtNs(avg)}`);
}

// ── 6. Final stats ──
const s = cache.getStats();
console.log('\n--- Final stats ---');
console.log(`  hits:               ${s.hits}`);
console.log(`  mtimeRevalidations: ${s.mtimeRevalidations}`);
console.log(`  contentReads:       ${s.contentReads}`);
console.log(`  dirRescans:         ${s.dirRescans}`);
console.log(`  misses:             ${s.misses}`);
console.log(`  invalidations:      ${s.invalidations}`);
console.log('\nConclusion: if hits >> contentReads, cache is effective. MCP roundtrip overhead is separate (see task C374).\n');
