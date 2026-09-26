'use strict';

// Cache Claude tool results only with TIPATASK_TURN_ID. Glob/Grep use per-turn
// files; architecture and task metadata use project/session keys with TTL and
// write invalidation. Batch tag results are cached per tag to reuse overlapping
// requests. Keep cache keys scoped so projects cannot share stale results.

const TURN_ID = process.env.TIPATASK_TURN_ID;
if (!TURN_ID) process.exit(0); // only cache objective-chat turns

const nodeMajor = parseInt(process.versions.node, 10);
if (nodeMajor < 22) {
  // C1041: this hook can be spawned under whatever `node` wins PATH resolution, which can
  // be a stale system install. Never block the agent — just leave a breadcrumb on stderr
  // (hook stdout is reserved for hookSpecificOutput JSON elsewhere in the hook chain).
  console.error(`[tool-result-cache] skipped — node ${process.version} (${process.execPath}) below required major 22`);
  process.exit(0);
}

// Bare specifiers (not `node:fs`/`node:os`/`node:path`) — see track-file-access.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_FILE = path.join(os.tmpdir(), `tipatask-tool-cache-${TURN_ID}.json`);
const MAX_ENTRIES = 64;
const STALE_MS = 3_600_000; // 1 hour

// ── arch-doc cache (project-scoped) ─────────────────────────────────────────

const PROJECT_ID = process.env.API_PROJECT_ID || '';
const ARCH_CACHE_FILE = PROJECT_ID
  ? path.join(os.tmpdir(), `tipatask-arch-cache-${PROJECT_ID}.json`)
  : null;
const ARCH_STALE_MS = 86_400_000; // 24 hours
// Project KB dir. The project root is TIPATASK_PROJECT_ROOT (stamped by the Task App into
// every agent spawn), else the hook event's own `cwd` (Claude Code runs hooks from the
// project directory), else this process's cwd — never derived from this checkout's location.
let ARCH_DIR = path.join(process.env.TIPATASK_PROJECT_ROOT || process.cwd(), 'ai', 'architecture');
function bindArchDirToEvent(event) {
  if (!process.env.TIPATASK_PROJECT_ROOT && event && typeof event.cwd === 'string' && event.cwd) {
    ARCH_DIR = path.join(event.cwd, 'ai', 'architecture');
  }
}
const ARCH_TOOLS = new Set(['mcp__tipatask__get_tag_architecture', 'mcp__tipatask__get_tag_architectures']);

// ── list_tasks cache (project-scoped, 5-min TTL) ────────────────────────────

const LIST_TASKS_TOOL = 'mcp__tipatask__list_tasks';
const WRITE_TOOLS = new Set(['mcp__tipatask__create_task', 'mcp__tipatask__update_task', 'mcp__tipatask__delete_task']);
const LIST_TASKS_TTL_MS = 300_000; // 5 minutes
const LIST_TASKS_CACHE_FILE = PROJECT_ID
  ? path.join(os.tmpdir(), `tipatask-list-tasks-cache-${PROJECT_ID}.json`)
  : null;
const LIST_TASKS_VERSION_FILE = PROJECT_ID
  ? path.join(os.tmpdir(), `tipatask-list-tasks-version-${PROJECT_ID}`)
  : null;

// ── batch_grep_tags cache (objective-session-scoped, 10s TTL) ───────────────
// C1382 — batch_grep_tags moved to the local-only 'tipatask-local' server.

const BATCH_GREP_TOOL = 'mcp__tipatask-local__batch_grep_tags';
const BATCH_GREP_TTL_MS = 10_000;
const BATCH_GREP_MAX = 64;
const OBJECTIVE_TASK_ID = process.env.TIPATASK_OBJECTIVE_TASK_ID || '';
const BATCH_GREP_CACHE_FILE = OBJECTIVE_TASK_ID
  ? path.join(os.tmpdir(), `tipatask-batch-grep-cache-${OBJECTIVE_TASK_ID}.json`)
  : null;

// ── list_task_id_meta cache ──────────────────────────────────────────────────
// Objective-session-scoped (preferred): 15-min TTL, partitioned by OBJECTIVE_TASK_ID.
// Project-scoped fallback: 30-s TTL, partitioned by PROJECT_ID.
// Both paths share LIST_TASKS_VERSION_FILE for write-invalidation.

const LIST_META_TOOL = 'mcp__tipatask__list_task_id_meta';
const LIST_META_TTL_MS = 30_000; // 30 seconds — fallback (no objective session)
const LIST_META_OBJSESS_TTL_MS = 900_000; // 15 minutes — within an objective session
const ARCH_OBJSESS_TTL_MS = 900_000; // 15 minutes — arch stat-skip window per session
const LIST_META_CACHE_FILE = OBJECTIVE_TASK_ID
  ? path.join(os.tmpdir(), `tipatask-list-meta-cache-objsess-${OBJECTIVE_TASK_ID}.json`)
  : (PROJECT_ID ? path.join(os.tmpdir(), `tipatask-list-meta-cache-${PROJECT_ID}.json`) : null);

function readListVersion() {
  if (!LIST_TASKS_VERSION_FILE) return '0';
  try { return fs.readFileSync(LIST_TASKS_VERSION_FILE, 'utf8').trim(); } catch { return '0'; }
}

function bumpListVersion() {
  if (!LIST_TASKS_VERSION_FILE) return;
  try { fs.writeFileSync(LIST_TASKS_VERSION_FILE, String(Date.now())); } catch { /* never block */ }
}

function readListTasksCache() {
  if (!LIST_TASKS_CACHE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(LIST_TASKS_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeListTasksCache(cache) {
  if (!LIST_TASKS_CACHE_FILE) return;
  const tmp = `${LIST_TASKS_CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, LIST_TASKS_CACHE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function readListMetaCache() {
  if (!LIST_META_CACHE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(LIST_META_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeListMetaCache(cache) {
  if (!LIST_META_CACHE_FILE) return;
  const tmp = `${LIST_META_CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, LIST_META_CACHE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function resolveTagNames(tool, toolInput) {
  if (tool === 'mcp__tipatask__get_tag_architecture') {
    return toolInput && toolInput.tag_name ? [toolInput.tag_name] : null;
  }
  if (tool === 'mcp__tipatask__get_tag_architectures') {
    return toolInput && Array.isArray(toolInput.tag_names) && toolInput.tag_names.length
      ? [...toolInput.tag_names]
      : null;
  }
  return null;
}

function getTagMtime(tag) {
  try { return fs.statSync(path.join(ARCH_DIR, `${tag}.md`)).mtimeMs; }
  catch { return 0; }
}

function extractResponseText(response) {
  if (typeof response === 'string') return response;
  if (response && Array.isArray(response.content)) {
    const t = response.content.find(c => c.type === 'text');
    if (t) return t.text || '';
  }
  return JSON.stringify(response);
}

function readArchCache() {
  if (!ARCH_CACHE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(ARCH_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeArchCache(cache) {
  if (!ARCH_CACHE_FILE) return;
  const tmp = `${ARCH_CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, ARCH_CACHE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function evictOldestArch(cache) {
  const keys = Object.keys(cache);
  if (keys.length < MAX_ENTRIES) return;
  let oldest = keys[0];
  let oldestTs = cache[keys[0]].ts || 0;
  for (let i = 1; i < keys.length; i++) {
    const ts = cache[keys[i]].ts || 0;
    if (ts < oldestTs) { oldest = keys[i]; oldestTs = ts; }
  }
  delete cache[oldest];
}

function readBatchGrepCache() {
  if (!BATCH_GREP_CACHE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(BATCH_GREP_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeBatchGrepCache(cache) {
  if (!BATCH_GREP_CACHE_FILE) return;
  const tmp = `${BATCH_GREP_CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, BATCH_GREP_CACHE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function evictOldestBatchGrep(cache) {
  const keys = Object.keys(cache);
  if (keys.length < BATCH_GREP_MAX) return;
  let oldest = keys[0];
  let oldestTs = cache[keys[0]].ts || 0;
  for (let i = 1; i < keys.length; i++) {
    const ts = cache[keys[i]].ts || 0;
    if (ts < oldestTs) { oldest = keys[i]; oldestTs = ts; }
  }
  delete cache[oldest];
}

function batchGrepParamsHash(toolInput) {
  const obj = { ...(toolInput || {}) };
  delete obj.tag_names;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

// ── arch tag-set stats (project-scoped JSONL for prewarm selection) ──────────

const ARCH_STATS_MAX_LINES = 200;
const ARCH_STATS_KEEP_LINES = 100;
const ARCH_STATS_FILE = PROJECT_ID
  ? path.join(os.tmpdir(), `tipatask-arch-tag-stats-${PROJECT_ID}.jsonl`)
  : null;

function recordArchTagStats(tagNames) {
  if (!ARCH_STATS_FILE || !tagNames || tagNames.length === 0) return;
  try {
    let content = '';
    try { content = fs.readFileSync(ARCH_STATS_FILE, 'utf8'); } catch { /* new file */ }
    const lines = content ? content.split('\n').filter(Boolean) : [];
    if (lines.length >= ARCH_STATS_MAX_LINES) lines.splice(0, lines.length - ARCH_STATS_KEEP_LINES);
    lines.push(JSON.stringify({ ts: Date.now(), tags: tagNames }));
    fs.writeFileSync(ARCH_STATS_FILE, lines.join('\n') + '\n');
  } catch { /* never block */ }
}

// ── shared helpers ───────────────────────────────────────────────────────────

function sortedKey(toolName, toolInput) {
  const obj = toolInput || {};
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return `${toolName}:${JSON.stringify(sorted)}`;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeCache(cache) {
  const tmp = `${CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function cleanupStale() {
  try {
    const dir = os.tmpdir();
    const turnCutoff = Date.now() - STALE_MS;
    const archCutoff = Date.now() - ARCH_STALE_MS;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      try {
        const mtime = fs.statSync(p).mtimeMs;
        if (f.startsWith('tipatask-tool-cache-') && mtime < turnCutoff) fs.unlinkSync(p);
        if (f.startsWith('tipatask-arch-cache-') && mtime < archCutoff) fs.unlinkSync(p);
        if (f.startsWith('tipatask-list-tasks-cache-') && mtime < archCutoff) fs.unlinkSync(p);
        if ((f.startsWith('tipatask-list-meta-cache-')) && mtime < archCutoff) fs.unlinkSync(p);
        if (f.startsWith('tipatask-batch-grep-cache-') && mtime < archCutoff) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* never block */ }
}

// ── main ─────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    cleanupStale();
    const event = JSON.parse(input);
    const tool = event.tool_name;
    if (!tool) process.exit(0);
    bindArchDirToEvent(event);

    // ── arch-doc tools (project-scoped per-tag cache) ───────────────────────
    if (ARCH_TOOLS.has(tool) && ARCH_CACHE_FILE) {
      const tagNames = resolveTagNames(tool, event.tool_input);
      if (!tagNames) process.exit(0);
      const isBatch = tool === 'mcp__tipatask__get_tag_architectures';

      if (event.hook_event_name === 'PostToolUse') {
        if (event.tool_response == null) process.exit(0);
        if (event.tool_response && event.tool_response.isError) process.exit(0);
        const now = Date.now();
        const cache = readArchCache();

        if (isBatch) {
          // Split batch response into per-tag entries
          let map;
          try { map = JSON.parse(extractResponseText(event.tool_response)); } catch { process.exit(0); }
          for (const [tag, content] of Object.entries(map)) {
            if (content == null) continue;
            evictOldestArch(cache);
            const entry = { content, mtime: getTagMtime(tag), ts: now };
            if (OBJECTIVE_TASK_ID) { entry.mtimeCheckedAt = now; entry.objSessionId = OBJECTIVE_TASK_ID; }
            cache[tag] = entry;
          }
        } else {
          // Single tag — content is the plain text
          const content = extractResponseText(event.tool_response);
          const tag = tagNames[0];
          evictOldestArch(cache);
          const entry = { content, mtime: getTagMtime(tag), ts: now };
          if (OBJECTIVE_TASK_ID) { entry.mtimeCheckedAt = now; entry.objSessionId = OBJECTIVE_TASK_ID; }
          cache[tag] = entry;
        }

        writeArchCache(cache);
        recordArchTagStats(tagNames);
        process.exit(0);
      }

      if (event.hook_event_name === 'PreToolUse') {
        const now = Date.now();
        const cache = readArchCache();
        let responseText;
        let cacheUpdated = false;

        // Returns true if entry is valid (either via session fast-path or mtime check).
        // Refreshes session fields in-place when stat confirms mtime unchanged.
        function validateEntry(tag, entry) {
          if (!entry || !entry.content) return false;
          // Fast-path: same objective session, within 15-min stat-skip window
          if (OBJECTIVE_TASK_ID && entry.objSessionId === OBJECTIVE_TASK_ID &&
              entry.mtimeCheckedAt && (now - entry.mtimeCheckedAt) < ARCH_OBJSESS_TTL_MS) {
            return true;
          }
          // Fallback: mtime-validate via statSync
          const currentMtime = getTagMtime(tag);
          if (currentMtime !== entry.mtime) return false;
          // Mtime unchanged — refresh session window so next call takes fast-path
          if (OBJECTIVE_TASK_ID) {
            entry.mtimeCheckedAt = now;
            entry.objSessionId = OBJECTIVE_TASK_ID;
            cacheUpdated = true;
          }
          return true;
        }

        if (isBatch) {
          // All tags must hit + be valid; any miss → let MCP handle
          const map = {};
          for (const tag of tagNames) {
            if (!validateEntry(tag, cache[tag])) process.exit(0);
            map[tag] = cache[tag].content;
          }
          responseText = JSON.stringify(map, null, 2);
        } else {
          const tag = tagNames[0];
          if (!validateEntry(tag, cache[tag])) process.exit(0);
          responseText = cache[tag].content;
        }

        if (cacheUpdated) writeArchCache(cache);

        const reason =
          `Cached ${tool} result (project ${PROJECT_ID}, mtime-validated). ` +
          `No need to call again — result:\n\n${responseText}`;

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }));
        process.exit(0);
      }

      process.exit(0);
    }

    // ── batch_grep_tags (per-objective-session per-tag cache, 10s TTL) ─────────
    if (tool === BATCH_GREP_TOOL && BATCH_GREP_CACHE_FILE) {
      const tagNames = (event.tool_input && Array.isArray(event.tool_input.tag_names))
        ? event.tool_input.tag_names
        : null;
      if (!tagNames || tagNames.length === 0) process.exit(0);

      // cross_refs/validate_only return non-splittable shapes — skip PreToolUse serve
      const crossRefs = !!(event.tool_input && event.tool_input.cross_refs);
      const validateOnly = !!(event.tool_input && event.tool_input.validate_only);

      if (event.hook_event_name === 'PostToolUse') {
        if (event.tool_response == null) process.exit(0);
        if (event.tool_response && event.tool_response.isError) process.exit(0);
        let parsed;
        try { parsed = JSON.parse(extractResponseText(event.tool_response)); } catch { process.exit(0); }
        if (!parsed || !parsed.results) process.exit(0);

        const paramsHash = batchGrepParamsHash(event.tool_input);
        const now = Date.now();
        const cache = readBatchGrepCache();
        for (const tag of tagNames) {
          const tagHits = Array.isArray(parsed.results[tag]) ? parsed.results[tag] : [];
          const tagPatterns = (parsed.tagPatterns && Array.isArray(parsed.tagPatterns[tag]))
            ? parsed.tagPatterns[tag]
            : [];
          evictOldestBatchGrep(cache);
          cache[tag] = { results: tagHits, tagPatterns, ts: now, paramsHash };
        }
        writeBatchGrepCache(cache);
        process.exit(0);
      }

      if (event.hook_event_name === 'PreToolUse' && !crossRefs && !validateOnly) {
        const paramsHash = batchGrepParamsHash(event.tool_input);
        const now = Date.now();
        const cache = readBatchGrepCache();
        const synth = { results: {}, tagPatterns: {}, totalHits: 0, elapsedMs: 0 };
        for (const tag of tagNames) {
          const entry = cache[tag];
          if (!entry || entry.paramsHash !== paramsHash || (now - entry.ts) >= BATCH_GREP_TTL_MS) {
            process.exit(0); // any miss → fall through to real tool
          }
          synth.results[tag] = entry.results;
          synth.tagPatterns[tag] = entry.tagPatterns;
          synth.totalHits += entry.results.length;
        }
        const responseText = JSON.stringify(synth, null, 2);
        const reason =
          `Cached ${BATCH_GREP_TOOL} result (task ${OBJECTIVE_TASK_ID}, 10s TTL). ` +
          `No need to call again — result:\n\n${responseText}`;
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }));
        process.exit(0);
      }

      process.exit(0);
    }

    // ── list_tasks cache (project-scoped, 5-min TTL + version invalidation) ──
    if (tool === LIST_TASKS_TOOL && LIST_TASKS_CACHE_FILE) {
      const key = sortedKey(tool, event.tool_input);

      if (event.hook_event_name === 'PostToolUse') {
        const response = event.tool_response;
        if (response == null) process.exit(0);
        const version = readListVersion();
        const cache = readListTasksCache();
        const keys = Object.keys(cache);
        if (keys.length >= MAX_ENTRIES) delete cache[keys[0]];
        cache[key] = { response, ts: Date.now(), version };
        writeListTasksCache(cache);
        process.exit(0);
      }

      if (event.hook_event_name === 'PreToolUse') {
        const version = readListVersion();
        const cache = readListTasksCache();
        const hit = cache[key];
        if (hit && (Date.now() - hit.ts) < LIST_TASKS_TTL_MS && hit.version === version) {
          const responseText = typeof hit.response === 'string'
            ? hit.response
            : JSON.stringify(hit.response, null, 2);
          const reason =
            `Cached ${tool} result (project ${PROJECT_ID}, 5-min TTL, version ${version}). ` +
            `No need to call again — result:\n\n${responseText}`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          }));
          process.exit(0);
        }
        process.exit(0);
      }

      process.exit(0);
    }

    // ── list_task_id_meta cache (project-scoped, 30s TTL + shared version file) ─
    if (tool === LIST_META_TOOL && LIST_META_CACHE_FILE) {
      const key = sortedKey(tool, event.tool_input);

      if (event.hook_event_name === 'PostToolUse') {
        const response = event.tool_response;
        if (response == null) process.exit(0);
        const version = readListVersion();
        const cache = readListMetaCache();
        const keys = Object.keys(cache);
        if (keys.length >= MAX_ENTRIES) delete cache[keys[0]];
        cache[key] = { response, ts: Date.now(), version };
        writeListMetaCache(cache);
        process.exit(0);
      }

      if (event.hook_event_name === 'PreToolUse') {
        const version = readListVersion();
        const cache = readListMetaCache();
        const hit = cache[key];
        const ttl = OBJECTIVE_TASK_ID ? LIST_META_OBJSESS_TTL_MS : LIST_META_TTL_MS;
        const ttlLabel = OBJECTIVE_TASK_ID ? '15-min (objective session)' : '30s';
        if (hit && (Date.now() - hit.ts) < ttl && hit.version === version) {
          const responseText = typeof hit.response === 'string'
            ? hit.response
            : JSON.stringify(hit.response, null, 2);
          const reason =
            `Cached ${tool} result (${OBJECTIVE_TASK_ID ? `session ${OBJECTIVE_TASK_ID}` : `project ${PROJECT_ID}`}, ${ttlLabel} TTL, version ${version}). ` +
            `No need to call again — result:\n\n${responseText}`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          }));
          process.exit(0);
        }
        process.exit(0);
      }

      process.exit(0);
    }

    // ── write tools — bump list_tasks cache version ──────────────────────────
    if (WRITE_TOOLS.has(tool)) {
      if (event.hook_event_name === 'PostToolUse') bumpListVersion();
      process.exit(0);
    }

    // ── Glob / Grep (per-turn cache) ─────────────────────────────────────────
    if (!['Glob', 'Grep'].includes(tool)) process.exit(0);

    const key = sortedKey(tool, event.tool_input);

    if (event.hook_event_name === 'PostToolUse') {
      const response = event.tool_response;
      if (response == null) process.exit(0);
      const cache = readCache();
      const keys = Object.keys(cache);
      if (keys.length >= MAX_ENTRIES) delete cache[keys[0]]; // evict oldest
      cache[key] = { response, ts: Date.now() };
      writeCache(cache);
      process.exit(0);
    }

    if (event.hook_event_name === 'PreToolUse') {
      const cache = readCache();
      const hit = cache[key];
      if (!hit) process.exit(0);

      const responseText = typeof hit.response === 'string'
        ? hit.response
        : JSON.stringify(hit.response, null, 2);

      const reason =
        `Cached ${tool} result from earlier in this turn (same arguments). ` +
        `No need to call again — result:\n\n${responseText}`;

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
    }

    process.exit(0);
  } catch { process.exit(0); } // never block the agent
});
