'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archCache = require('../mcp/architecture-cache');
const { runBatchGrep } = require('../mcp/batch-grep');
const taskCache = require('../mcp/task-cache');
const config = require('./config');
const { fetchStatusContext } = require('./status-roles');
const { maxNumbersByPrefix } = require('./task-key-format');
const { codingPriorityBaseline } = require('./sprint-assign');

// The forked todo-server serves multiple project windows, so GENERAL.md / CONVENTIONS.md /
// the assembled static bundle are keyed by the resolved architecture directory rather than a
// single module-load constant. projectRoot is threaded in from session.projectPath /
// opts.projectPath; it defaults (undefined) to the env/repo resolution so dev is unchanged (C894).
const _docCaches = new Map();    // archDir → { generalContent, generalMtime, conventionsContent, conventionsMtime }
const _bundleCaches = new Map(); // archDir → { bundle, tagSig, generalMtime, conventionsMtime }
let _lastBundleSha = '';

function _resolvePaths(projectRoot) {
  const archDir = archCache.resolveArchitectureDir(projectRoot);
  return {
    archDir,
    generalMd: path.join(archDir, 'GENERAL.md'),
    conventionsMd: path.join(archDir, '..', 'CONVENTIONS.md'),
  };
}

function _docCache(archDir) {
  let c = _docCaches.get(archDir);
  if (!c) {
    c = { generalContent: '', generalMtime: 0, conventionsContent: '', conventionsMtime: 0 };
    _docCaches.set(archDir, c);
  }
  return c;
}

// Byte-stable — built once at module load. Embedding 3 allowed-tool schemas
// into the static bundle lets the objective model skip ToolSearch entirely.
const MCP_SCHEMA_BLOCK = `## MCP Tool Schemas (already loaded — do NOT call ToolSearch)

### Read
{ file_path: string (absolute path),
  offset?: int (line to start from, 1-based),
  limit?: int (max lines to read) }
→ file contents as text with line numbers

### mcp__tipatask-local__batch_grep_tags
{ tag_names: string[] (1..20, tt-* tags),
  paths?: string[] (relative paths to scan, default repo root),
  max_hits_per_tag?: int (1..100, default 50),
  symbols?: string[] (extra grep patterns beyond tag-derived ones),
  cross_refs?: bool (find file intersections between tags),
  validate_only?: bool (return derived patterns without scanning) }
→ { results: { tag: [{file, line, text, pattern}] },
    tagPatterns, totalHits, elapsedMs,
    crossRefs?: { "tagA→tagB": { hits, files } } }

### mcp__tipatask__get_tag_architecture
{ tag_name: string (single tt-* tag name) }
→ string content of ai/architecture/{tag_name}.md, or null if file missing`;

function _getGeneral(generalMd, dc) {
  try {
    const stat = fs.statSync(generalMd);
    if (stat.mtimeMs !== dc.generalMtime) {
      dc.generalContent = fs.readFileSync(generalMd, 'utf8');
      dc.generalMtime = stat.mtimeMs;
    }
  } catch {
    dc.generalContent = '';
  }
  return dc.generalContent;
}

function _getConventions(conventionsMd, dc) {
  try {
    const stat = fs.statSync(conventionsMd);
    if (stat.mtimeMs !== dc.conventionsMtime) {
      dc.conventionsContent = fs.readFileSync(conventionsMd, 'utf8');
      dc.conventionsMtime = stat.mtimeMs;
    }
  } catch {
    dc.conventionsContent = '';
  }
  return dc.conventionsContent;
}

function getStaticBundle(projectRoot) {
  const { archDir, generalMd, conventionsMd } = _resolvePaths(projectRoot);
  const dc = _docCache(archDir);
  const tags = archCache.listSystemTags(projectRoot);
  const general = _getGeneral(generalMd, dc);
  const conventions = _getConventions(conventionsMd, dc);
  // Identity sig: length + last tag name (sorted list — catches add/remove/rename)
  const tagSig = tags.length + ':' + (tags.length ? tags[tags.length - 1].tag : '');
  const cached = _bundleCaches.get(archDir);
  if (cached && cached.tagSig === tagSig && cached.generalMtime === dc.generalMtime && cached.conventionsMtime === dc.conventionsMtime) {
    return cached.bundle;
  }
  // Tags are already returned sorted by filename (readdirSync.sort in architecture-cache.js)
  const taxonomy = tags.map(t => `- ${t.tag} — ${t.description}`).join('\n');
  const conventionsSection = conventions ? `\n\n## Project Conventions (ai/CONVENTIONS.md)\n\n${conventions}` : '';
  const bundle = `━━ STATIC CONTEXT (pre-loaded from project KB; consult this BEFORE calling MCP) ━━\n\n## General Architecture\n\n${general}\n\n## Tag Taxonomy (tt-* tags)\n\n${taxonomy}\n\n${MCP_SCHEMA_BLOCK}${conventionsSection}`;

  const sha = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 8);
  if (sha !== _lastBundleSha) {
    console.log(`[static-context] bundle changed sha=${sha} len=${bundle.length} tags=${tags.length}`);
    _lastBundleSha = sha;
  }
  _bundleCaches.set(archDir, { bundle, tagSig, generalMtime: dc.generalMtime, conventionsMtime: dc.conventionsMtime });

  return bundle;
}

function getStaticBundleStats(projectRoot) {
  const { archDir } = _resolvePaths(projectRoot);
  const bundle = getStaticBundle(projectRoot); // warms cache + _lastBundleSha
  const cached = _bundleCaches.get(archDir);
  const tagsCount = cached ? parseInt(cached.tagSig, 10) : 0;
  return { chars: bundle.length, sha: _lastBundleSha, tagsCount };
}


const SESSION_ARCH_TTL_MS = 10 * 60 * 1000;

// Builds arch doc bundle for the given tagNames, backed by session-scoped Map.
// sessionMap: Map<tagName, { content, fetchedAt, mtimeMs }> — read+written in-place.
// On cache miss (absent or stale), falls back to archCache and updates the map.
// Returns { bundle: string, fresh: string[], cached: string[] } for logging.
function getTaskTagBundleFromSession(sessionMap, tagNames, projectRoot) {
  const seen = new Set();
  const fresh = [];
  const cached = [];
  const parts = [];
  const now = Date.now();

  for (const tag of (tagNames || [])) {
    if (!tag || !tag.startsWith('tt-') || seen.has(tag)) continue;
    seen.add(tag);

    const entry = sessionMap.get(tag);
    if (entry && entry.content && (now - entry.fetchedAt) < SESSION_ARCH_TTL_MS) {
      cached.push(tag);
      parts.push(entry.content);
    } else {
      const content = archCache.getTagArchitecture(tag, projectRoot);
      if (content) {
        sessionMap.set(tag, { content, fetchedAt: now, mtimeMs: 0 });
        fresh.push(tag);
        parts.push(content);
      }
    }
  }

  if (parts.length === 0) return { bundle: '', fresh, cached };
  return {
    bundle: `## Pre-loaded Tag Architectures\n\n${parts.join('\n\n---\n\n')}`,
    fresh,
    cached,
  };
}

// Cache for pre-baked startup grep bundles. Key = sha of sorted tags + arch-doc mtimes.
const _grepBundleCache = new Map(); // key → { bundle, mtimeSig }

function _grepCacheKey(tagNames, archDir) {
  const sorted = [...tagNames].sort().join(',');
  const mtimes = tagNames.map(t => {
    try {
      const f = path.join(archDir, `${t}.md`);
      return fs.statSync(f).mtimeMs;
    } catch { return 0; }
  }).join(',');
  return `${archDir}|${sorted}|${mtimes}`;
}

// Pre-bake cross-reference grep at spawn time.
// Returns a formatted markdown section (empty string if no tags or scan fails).
function getTaskStartupGrepBundle(tagNames, projectRoot) {
  if (!tagNames || tagNames.length === 0) return '';
  const ttTags = tagNames.filter(t => t.startsWith('tt-'));
  if (ttTags.length < 2) return '';

  const { archDir } = _resolvePaths(projectRoot);
  const cacheKey = _grepCacheKey(ttTags, archDir);
  const cached = _grepBundleCache.get(cacheKey);
  if (cached) return cached.bundle;

  let result;
  try {
    result = runBatchGrep({ tagNames: ttTags, crossRefs: true, maxHitsPerTag: 12, projectRoot });
  } catch (err) {
    process.stderr.write(`[static-context] startup grep failed: ${err.message}\n`);
    return '';
  }

  const lines = [`## Pre-computed Cross-References (${result.elapsedMs}ms)\n`];

  // Per-tag: top files by hit count
  for (const tag of ttTags) {
    const hits = result.results[tag] || [];
    if (!hits.length) continue;
    const byFile = new Map();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([f, n]) => `${f} (${n})`).join(', ');
    lines.push(`### ${tag}\nTop files: ${topFiles}`);
  }

  // Cross-refs between tags
  if (result.crossRefs && Object.keys(result.crossRefs).length > 0) {
    lines.push('\n### Cross-tag file intersections');
    for (const [pair, { hits, files }] of Object.entries(result.crossRefs)) {
      lines.push(`- ${pair}: ${hits} hit(s) in ${files.slice(0, 3).join(', ')}`);
    }
  }

  const bundle = lines.join('\n');
  _grepBundleCache.set(cacheKey, { bundle });
  console.log(`[static-context] startup grep bundle: ${ttTags.length} tags, ${result.totalHits} hits in ${result.elapsedMs}ms`);
  return bundle;
}

// Full current descriptions of the active tasks the objective text names by key. The
// planner needs the verbatim original before it may propose a "modified" description
// (buildObjectiveSystemPrompt()'s DESCRIPTION PRESERVATION rule) — list_task_id_meta's
// active list carries no descriptions, and Pi has no MCP get_task to fetch one. Never
// truncated: a cut description would be exactly the detail loss this exists to prevent.
// Returns '' when the text names no active task.
const REFERENCED_TASK_KEY_RE = /\b(?:H|[A-Z]{1,6})[0-9]+\b/g;
const REFERENCED_TASKS_MAX = 5;

function buildReferencedTasksSection(tasks, text, activeStatuses, max = REFERENCED_TASKS_MAX) {
  if (!text || !Array.isArray(tasks)) return '';
  const byId = new Map(tasks.map(t => [t.id, t]));
  const picked = [];
  const seen = new Set();
  for (const key of String(text).match(REFERENCED_TASK_KEY_RE) || []) {
    if (seen.has(key)) continue;
    seen.add(key);
    const t = byId.get(key);
    if (!t || !activeStatuses.has(t.status)) continue;
    picked.push({ id: t.id, title: t.title, status: t.status, description: t.description || '' });
    if (picked.length >= max) break;
  }
  if (picked.length === 0) return '';
  return `### Referenced task descriptions\nFull current descriptions of active tasks named in the objective — the verbatim originals to patch when proposing a "modified" description.\n\`\`\`json\n${JSON.stringify(picked, null, 2)}\n\`\`\``;
}

// Pre-fetches list_task_id_meta + get_tag_architectures concurrently at spawn time,
// injecting results into the first-turn user prompt to eliminate LLM tool round-trips.
// Returns { bundle: string, elapsedMs: number }.
// objectiveText — the first-turn user prompt; active task keys named in it get their full
// description pre-fetched (### Referenced task descriptions).
async function prefetchObjectiveWorkflow(backend, taskId, projectRoot, objectiveText = '') {
  const t0 = Date.now();
  try {
    // C1439: getTagsDetailed()'s failure used to collapse to `[]`, indistinguishable
    // from "this project genuinely has zero tags" — the tagsSection below then either
    // showed an accurate empty registry or silently vanished on a fetch error, and the
    // planner had no way to tell which. Three-way instead of a plain catch-to-[]: ok+rows,
    // or ok:false+reason so the prompt can tell the model the registry is UNKNOWN, not empty.
    const [tasks, tagsResult, statusCtx] = await Promise.all([
      taskCache.getTasks(backend, backend),
      backend.getTagsDetailed
        ? backend.getTagsDetailed().then(rows => ({ ok: true, rows })).catch(err => ({ ok: false, reason: err.message }))
        : Promise.resolve({ ok: false, reason: 'backend exposes no getTagsDetailed()' }),
      fetchStatusContext(backend),
    ]);

    // list_task_id_meta computation (mirrors mcp/server.js) — C1187: "active" resolved
    // via the project's own status registry (complement of complete/canceled roles)
    // instead of the legacy literal ['pending','in_progress','on_fire'] set.
    // (C1483) Per-prefix max suffix, not a hardcoded C/H-only scan — maxCId/maxHId kept
    // as named fields for back-compat, now just read off the same map.
    const byPrefix = maxNumbersByPrefix(tasks);
    const maxCId = byPrefix.get('C') ?? 0;
    const maxHId = byPrefix.get('H') ?? 0;
    const maxByPrefix = Object.fromEntries(byPrefix);
    const active = [];
    for (const t of tasks) {
      if (statusCtx.active.has(t.status)) {
        active.push({ id: t.id, title: t.title, category: t.category, status: t.status, priority: t.priority, tags: t.tags });
      }
    }

    // sync arch reads for this task's tt-* tags — cap total chars to keep first-turn cold tokens low.
    // Oversized tags are deferred; model fetches them on-demand via get_tag_architecture.
    const currentTask = tasks.find(t => t.id === taskId);
    const ttTags = (currentTask?.tags || []).filter(t => t.startsWith('tt-'));
    const archParts = [];
    const deferredTags = [];
    let archCharsTotal = 0;
    const archCharLimit = config.OBJECTIVE_PREFETCH_ARCH_CHAR_LIMIT;
    for (const tag of ttTags) {
      const content = archCache.getTagArchitecture(tag, projectRoot);
      if (!content) continue;
      if (archCharsTotal + content.length > archCharLimit) {
        deferredTags.push(tag);
        continue;
      }
      archParts.push(content);
      archCharsTotal += content.length;
    }

    const priorityBaseline = codingPriorityBaseline(tasks, statusCtx.active);
    const idMetaJson = JSON.stringify({ maxCId, maxHId, maxByPrefix, active, priorityBaseline }, null, 2);
    // C1439: always emit the ### get_project_tags header — never silently omit it — so
    // the planner (utils.js's OBJECTIVE_SYSTEM_PROMPT) can tell "genuinely zero tags"
    // (a real, populated-but-empty registry — every tag needs new_tags, same as before)
    // apart from "the registry could not be read this turn" (UNAVAILABLE — same
    // instruction, but the model shouldn't conclude the project simply has no tags).
    let tagsSection;
    if (!tagsResult.ok) {
      tagsSection = `### get_project_tags\nUNAVAILABLE (${tagsResult.reason}) — the tag registry could not be read this turn. Treat every tag you use as unregistered and give each one a new_tags entry.`;
    } else if (tagsResult.rows.length === 0) {
      tagsSection = '### get_project_tags\n`[]` — this project has NO tags registered yet. Every tag you use needs a new_tags entry with a real one-line description (architecture_hint too, for a tt-* tag).';
    } else {
      tagsSection = `### get_project_tags\n\`\`\`json\n${JSON.stringify(tagsResult.rows, null, 2)}\n\`\`\``;
    }
    const archSection = archParts.length > 0
      ? `### get_tag_architectures\n\n${archParts.join('\n\n---\n\n')}`
      : '';
    const deferredSection = deferredTags.length > 0
      ? `\n\n### Deferred tag architectures (too large for prefetch — call \`mcp__tipatask__get_tag_architecture\` if needed)\n${deferredTags.map(t => `- ${t}`).join('\n')}`
      : '';
    const sections = [`### list_task_id_meta\n\`\`\`json\n${idMetaJson}\n\`\`\``, tagsSection];
    const referencedSection = buildReferencedTasksSection(tasks, objectiveText, statusCtx.active);
    if (referencedSection) sections.push(referencedSection);
    if (archSection) sections.push(archSection);
    const bundle = `## Pre-fetched Workflow Data (do not re-fetch via MCP tools)\n\n${sections.join('\n\n')}${deferredSection}`;

    const elapsedMs = Date.now() - t0;
    const taxonomyCount = archCache.listSystemTags(projectRoot).length;
    const skippedNonTask = taxonomyCount - ttTags.length;
    console.log(`[objective:prefetch] task=${taskId} ms=${elapsedMs} active=${active.length} taskTags=${(currentTask?.tags || []).length} ttTags=[${ttTags.join(',')}] archDocs=${archParts.length} archChars=${archCharsTotal} deferred=[${deferredTags.join(',')}] skippedNonTask=${skippedNonTask}/${taxonomyCount} projectTags=${tagsResult.ok ? tagsResult.rows.length : 'unavailable'}`);
    return { bundle, elapsedMs };
  } catch (err) {
    process.stderr.write(`[static-context] prefetchObjectiveWorkflow failed: ${err.message}\n`);
    return { bundle: '', elapsedMs: Date.now() - t0 };
  }
}

module.exports = { getStaticBundle, getStaticBundleStats, getTaskTagBundleFromSession, getTaskStartupGrepBundle, prefetchObjectiveWorkflow, buildReferencedTasksSection, SESSION_ARCH_TTL_MS };
