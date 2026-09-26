'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { request } = require('./http');

const SYNC_FILES = ['CLAUDE.md', 'AGENTS.md', 'ai/architecture/GENERAL.md', 'ai/CONVENTIONS.md'];

// Per-project cache under <projectRoot>/.tipatask/knowledge-versions.json.
// Writable in both packaged Electron builds and dev — never writes into the
// read-only app.asar bundle (which caused ENOTDIR on packaged builds when the
// path was computed relative to __dirname inside the asar).
function versionCachePath(rootPath) {
  return path.join(rootPath, '.tipatask', 'knowledge-versions.json');
}

function getLocalVersions(rootPath) {
  try {
    return JSON.parse(fs.readFileSync(versionCachePath(rootPath), 'utf8'));
  } catch {
    return {};
  }
}

// Atomic write (tmp + rename). One hook process per Edit now races the
// forked Task App server and the MCP server on this file (C1037 autopush) —
// a torn read makes getLocalVersions() return {} (its catch), and the next
// saveLocalVersions() would persist that, wiping every cached entry. `.tmp`
// suffix goes LAST so the leftover on a crash matches the installer's
// `.tipatask/*.tmp` gitignore entry. Mirrors writeProjectConfig
// (server/project-config.js:53-60).
function saveLocalVersions(rootPath, map) {
  const p = versionCachePath(rootPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function readEntry(map, key) {
  const v = map[key];
  if (v == null) return { version: 0, hash: null };
  if (typeof v === 'number') return { version: v, hash: null };
  return { version: v.version ?? 0, hash: v.hash ?? null };
}

function writeEntry(map, key, version, hash) {
  map[key] = { version, hash };
}

// C1231 — is the on-disk copy already exactly what the remote holds? Requires all three:
// a cached version equal to remote's, the file actually present, and its real bytes matching
// the cached hash. Version alone is not enough — the cache would happily claim a
// hand-deleted or hand-edited file is current and never restore it.
function isUpToDate(cached, remoteVersion, dest) {
  if (!cached.hash || cached.version === 0 || cached.version !== remoteVersion) return false;
  try { return fs.existsSync(dest) && sha256(fs.readFileSync(dest, 'utf8')) === cached.hash; }
  catch { return false; }
}

function parseSections(content) {
  const lines = content.split('\n');
  let preamble = '';
  const sections = new Map();
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    if (/^## /.test(line)) {
      if (currentHeading === null) {
        preamble = currentLines.join('\n');
      } else {
        sections.set(currentHeading, currentLines.join('\n'));
      }
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentHeading === null) {
    preamble = currentLines.join('\n');
  } else {
    sections.set(currentHeading, currentLines.join('\n'));
  }
  return { preamble, sections };
}

function mergeBySections(localContent, remoteContent) {
  if (localContent === remoteContent) return remoteContent;

  const local  = parseSections(localContent);
  const remote = parseSections(remoteContent);

  if (remote.sections.size === 0) return remoteContent;

  const parts = [remote.preamble];

  for (const [heading, body] of remote.sections) {
    parts.push(heading + '\n' + body);
  }

  for (const [heading, body] of local.sections) {
    if (!remote.sections.has(heading)) {
      parts.push(heading + '\n' + body);
    }
  }

  const merged = parts.join('\n');
  return merged.endsWith('\n') ? merged : merged + '\n';
}

async function fetchRemoteVersions(baseUrl, projectId, token) {
  const { status, data } = await request(
    `${baseUrl}/api/projects/${projectId}/knowledge`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) throw new Error(`fetchRemoteVersions: HTTP ${status}`);
  const map = {};
  for (const f of data.files) map[f.file_key] = f.version;
  return map;
}

// C1220 — list conflict-record metadata (no content) for a project, optionally scoped to
// one fileKey and/or a `since` timestamp. Mirrors fetchRemoteVersions's throw-on-non-200
// contract — callers that want fail-open behavior (checkKnowledgeConflicts) wrap this.
async function fetchConflictRecords(baseUrl, projectId, token, opts = {}) {
  const params = new URLSearchParams();
  if (opts.fileKey) params.set('file_key', opts.fileKey);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  const { status, data } = await request(
    `${baseUrl}/api/projects/${projectId}/knowledge-conflicts${qs ? `?${qs}` : ''}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) throw new Error(`fetchConflictRecords: HTTP ${status}`);
  return data;
}

// C1220 — fetch one full conflict record, including the overwritten content, by id.
async function fetchConflictRecord(baseUrl, projectId, token, recordId) {
  const { status, data } = await request(
    `${baseUrl}/api/projects/${projectId}/knowledge-conflicts/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) throw new Error(`fetchConflictRecord(${recordId}): HTTP ${status}`);
  return data;
}

// C1545 — every write target on the pull/conflict path resolves through here. fileKey
// reaches pullFile straight from an agent (MCP pull_knowledge's file_key arg) or from
// whatever the API's file list returned; neither is validated upstream — the API treats
// file_key as an opaque DB column (api/src/routes/knowledge.js only checks non-empty).
// Without this guard a key like "../../x", "/etc/x", ".git/hooks/pre-commit", or
// ".tipatask/config.json" gets mkdir'd and written to verbatim.
//
// Pure, no fs — shape + allowlist only. Allows exactly: SYNC_FILES (CLAUDE.md, AGENTS.md,
// ai/architecture/GENERAL.md, ai/CONVENTIONS.md), or any "ai/**/*.md" (covers
// ai/architecture/tt-*.md and nested subdirs).
function isKbFileKey(fileKey) {
  if (typeof fileKey !== 'string' || fileKey.length === 0) return false;
  if (fileKey.includes('\0') || fileKey.includes('\\')) return false;
  if (path.isAbsolute(fileKey) || fileKey.startsWith('/')) return false;
  const segments = fileKey.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (SYNC_FILES.includes(fileKey)) return true;
  return fileKey.startsWith('ai/') && fileKey.endsWith('.md');
}

// Resolve fileKey to an absolute path INSIDE rootPath, or throw. Two layers: the shape/
// allowlist check above, then a real path.resolve + containment re-check — defense in
// depth against a future bug in isKbFileKey itself, same idiom as tag-doc-link.js's
// resolveContained() and mcp/server.js's create_system_tag traversal guard.
function resolveKbDest(rootPath, fileKey) {
  if (!isKbFileKey(fileKey)) {
    throw new Error(`Refusing to write KB file outside the allowed roots: ${JSON.stringify(fileKey)}`);
  }
  const resolvedRoot = path.resolve(rootPath);
  const dest = path.resolve(rootPath, fileKey);
  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to write KB file outside project root: ${JSON.stringify(fileKey)}`);
  }
  return dest;
}

// C1231 — opts.remoteVersion lets a caller that already listed remote versions
// (syncOnSessionStart) skip the GET entirely when the cache already matches. Returns
// {written, skipped, version} — written:false means the file was NOT touched on disk;
// skipped names why ('version-match' — no GET was even made; 'content-match' — GET'd but
// bytes were identical, cache re-stamped anyway) or is null on a real write.
async function pullFile(baseUrl, projectId, token, fileKey, rootPath, opts = {}) {
  const dest = resolveKbDest(rootPath, fileKey); // C1545 — throws before any GET on a bad key
  const cached = readEntry(getLocalVersions(rootPath), fileKey);

  if (opts.remoteVersion != null && isUpToDate(cached, opts.remoteVersion, dest)) {
    return { written: false, skipped: 'version-match', version: cached.version };
  }

  const { status, data } = await request(
    `${baseUrl}/api/projects/${projectId}/knowledge/${fileKey}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) throw new Error(`pullFile(${fileKey}): HTTP ${status}`);

  if (isUpToDate(cached, data.version, dest)) {
    return { written: false, skipped: 'version-match', version: cached.version };
  }

  // Version moved but bytes didn't — skip the write, but still stamp the cache to the new
  // version (same pattern as pullArchitectureDocs' identical-content branch below). Without
  // this the file would re-GET on every single sync forever.
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === data.content) {
    const versions = getLocalVersions(rootPath);
    writeEntry(versions, fileKey, data.version, sha256(data.content));
    saveLocalVersions(rootPath, versions);
    return { written: false, skipped: 'content-match', version: data.version };
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data.content, 'utf8');
  const versions = getLocalVersions(rootPath);
  writeEntry(versions, fileKey, data.version, sha256(data.content));
  saveLocalVersions(rootPath, versions);
  return { written: true, skipped: null, version: data.version };
}

// Persist a successful push's {version, hash} into the local cache. Shared
// by both pushFile branches (success path, both conflict policies).
function recordPushed(rootPath, fileKey, version, content) {
  const versions = getLocalVersions(rootPath);
  writeEntry(versions, fileKey, version, sha256(content));
  saveLocalVersions(rootPath, versions);
}

// fileKey with path separators replaced, safe for use as a flat filename
// under .tipatask/conflicts/.
function conflictSidecarName(fileKey, version) {
  return `${fileKey.replace(/\//g, '__')}.remote.v${version}.md`;
}

// C1105 — client half of the C1103/C1104 KB file lease. This process's identity for the
// per-(user, instance) lock (see api/src/routes/knowledge.js isSameHolder) — one PID per
// hook invocation, so two concurrent push-kb-on-write.js runs genuinely contend even when
// they share one API_TOKEN/user. Override for tests/probes via TIPATASK_INSTANCE_ID.
const INSTANCE_ID = process.env.TIPATASK_INSTANCE_ID
  || `${process.pid.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

const DEFAULT_LOCK_TTL_SECONDS = 600;
const LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_WAIT_MS = 30000;
const CONFLICT_RECORD_TIMEOUT_MS = 5000;

// Wraps a 409 lock_held response body into a throwable Error carrying the fields callers
// need to decide whether to keep waiting, log, or surface to the agent — never the raw
// {conflict, current_version, current_content} shape, so callers can tell a lock 409 apart
// from a version 409 with a single `err.lockHeld` check instead of inspecting the body.
function lockHeldError(data) {
  const err = new Error((data && data.error) || 'File is locked by another holder');
  err.lockHeld = true;
  err.retryAfterSeconds = (data && typeof data.retry_after_seconds === 'number') ? data.retry_after_seconds : 5;
  err.lockExpiresAt = data ? data.lock_expires_at : null;
  err.lockedByEmail = data ? data.locked_by_email : null;
  err.sameUser = !!(data && data.same_user);
  return err;
}

/**
 * Acquire (or renew) a lease on fileKey. Fails OPEN — resolves null, never throws — on
 * anything but a 200 or a 409 lock_held: a 404 means the API predates C1104 (production,
 * pre-deploy), and a 5xx/timeout shouldn't block a KB write the server-side PUT lock check
 * will enforce anyway. Only a genuine "someone else holds it" throws, so callers can
 * distinguish "no lease available" from "lease unavailable because contended".
 * @returns {Promise<{fileKey, version, content, lockedAt, lockExpiresAt, ttlSeconds}|null>}
 */
async function acquireLock(baseUrl, projectId, token, fileKey, opts = {}) {
  const url = `${baseUrl}/api/projects/${projectId}/knowledge/${fileKey}/lock`;
  // opts.instanceId lets a caller impersonate a different client instance than this
  // process's own INSTANCE_ID — used only by scripts/probe-kb-lock.js to prove two
  // instances sharing one token actually contend, without spawning a second process.
  const headers = { Authorization: `Bearer ${token}`, 'X-Tipatask-Instance': opts.instanceId || INSTANCE_ID };
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;

  let status, data;
  try {
    ({ status, data } = await request(url, {
      method: 'POST',
      headers,
      body: { ttl_seconds: opts.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS },
      timeoutMs,
    }));
  } catch {
    return null; // transport error/timeout — fail open
  }

  if (status === 200) {
    return {
      fileKey,
      version: data.version,
      content: data.content,
      // C1221 — the server echoes back the locked_instance it actually stored; surfacing it
      // is the only way a caller can verify the X-Tipatask-Instance header it sent actually
      // reached and was honored by the server, rather than being stripped/renamed by a proxy
      // in between (a silent no-op that would leave every hook line reading `[lease]` while
      // the C1105 per-instance narrowing quietly stopped applying).
      lockedInstance: data.locked_instance,
      lockedAt: data.locked_at,
      lockExpiresAt: data.lock_expires_at,
      ttlSeconds: data.ttl_seconds,
    };
  }
  if (status === 409 && data && data.lock_held) throw lockHeldError(data);
  return null; // un-upgraded API (404) or unexpected status — fail open
}

/**
 * Release a held lease. Best-effort: resolves null on transport failure rather than
 * throwing, since it's normally awaited from a `finally` block where a release failure
 * must never mask (or replace) the real result/error of the push it guarded.
 * @returns {Promise<{released, reason?, stolen?, placeholderRemoved?}|null>}
 */
async function releaseLock(baseUrl, projectId, token, fileKey, opts = {}) {
  const url = `${baseUrl}/api/projects/${projectId}/knowledge/${fileKey}/lock`;
  const headers = { Authorization: `Bearer ${token}`, 'X-Tipatask-Instance': opts.instanceId || INSTANCE_ID };
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;

  let status, data;
  try {
    ({ status, data } = await request(url, { method: 'DELETE', headers, timeoutMs }));
  } catch {
    return null;
  }
  if (status === 409 && data && data.lock_held) throw lockHeldError(data);
  if (status === 200) {
    return { released: !!data.released, reason: data.reason, stolen: !!data.stolen, placeholderRemoved: !!data.placeholder_removed };
  }
  return null;
}

// Retries acquireLock with jittered backoff (honoring the server's Retry-After) while the
// lease is held by someone else, up to opts.lockWaitMs total (default 30s). Resolves null
// immediately (no retry) when acquireLock itself fails open — nothing to wait on. Throws
// the last lockHeldError once the wait budget is exhausted.
async function acquireLockWithWait(baseUrl, projectId, token, fileKey, opts = {}) {
  const waitBudgetMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitBudgetMs;
  for (;;) {
    try {
      return await acquireLock(baseUrl, projectId, token, fileKey, opts);
    } catch (err) {
      if (!err.lockHeld) throw err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw err;
      const base = Math.min(Math.max(err.retryAfterSeconds * 1000, 500), 5000);
      const sleepMs = Math.min(base * (0.8 + Math.random() * 0.4), remaining);
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }
}

// C1220 — POST the pre-overwrite remote content to the server so the writer who's about to
// get clobbered can recover it via GET /:id/knowledge-conflicts (or the MCP
// list_knowledge_conflicts/get_knowledge_conflict tools) instead of depending on the
// overwriting machine's local .tipatask/conflicts/ sidecar. Same "never block the push"
// discipline as the sidecar write: swallows every failure, never throws, resolves null on
// anything but a clean 200/201. ctx carries what resolveConflict doesn't otherwise have
// (only pushFile holds baseUrl/projectId/token). instanceId defaults to this process's own
// INSTANCE_ID but must be the SAME id pushFile acquired/PUT/released under (C1221) — otherwise
// an impersonated-instance push (only scripts/probe-kb-lock.js today) would record the
// conflict under the wrong instance, and checkKnowledgeConflicts' own-instance filter
// (`overwritten_instance !== INSTANCE_ID`) would then silently fail to exclude it as "mine".
async function recordConflict(ctx, fileKey, overwrittenContent, overwrittenVersion, instanceId = INSTANCE_ID) {
  try {
    const { status, data } = await request(
      `${ctx.baseUrl}/api/projects/${ctx.projectId}/knowledge-conflicts`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token}`, 'X-Tipatask-Instance': instanceId },
        body: {
          file_key: fileKey,
          overwritten_content: overwrittenContent,
          overwritten_version: overwrittenVersion,
        },
        timeoutMs: ctx.timeoutMs || CONFLICT_RECORD_TIMEOUT_MS,
      },
    );
    if ((status === 200 || status === 201) && data && typeof data.id === 'number') return data.id;
    return null;
  } catch {
    return null; // transport error/timeout/un-upgraded API — never block the push on this
  }
}

// Builds the {putContent, versionHint, recordContent, resultExtra} a conflict resolution
// (or a fresh-placeholder short-circuit) hands to the actual retry PUT. Factored out of
// pushFile so both the lease pre-check (lease.version !== localVersion — no 409 needed,
// the lease acquire already told us the live version/content) and the PUT's own 409
// fallback (no lease held, or lease acquire failed open) share one implementation of the
// two conflict policies. ctx: {baseUrl, projectId, token, timeoutMs} — only used by the
// local-wins branch's recordConflict call.
async function resolveConflict(ctx, opts, fileKey, content, currentVersion, currentContent, rootPath) {
  if (opts.onConflict === 'local-wins') {
    const priorHash = readEntry(getLocalVersions(rootPath), fileKey).hash;
    const remoteDiverged = priorHash != null && sha256(currentContent) !== priorHash;

    if (remoteDiverged && opts.preserveRemoteOnConflict) {
      try {
        const conflictsDir = path.resolve(rootPath, '.tipatask', 'conflicts');
        fs.mkdirSync(conflictsDir, { recursive: true });
        fs.writeFileSync(
          path.join(conflictsDir, conflictSidecarName(fileKey, currentVersion)),
          currentContent,
          'utf8',
        );
      } catch { /* best-effort — never block the push on sidecar write failure */ }
    }

    // Broader than remoteDiverged: remoteDiverged needs a cached hash (priorHash != null),
    // so a machine that never synced this file (fresh checkout, first push) has no prior
    // hash to compare against and would otherwise overwrite real remote content with NO
    // record at all — sidecar or server-side. This gate only needs the two contents in
    // hand right now: non-empty remote content that differs from what we're about to write.
    const shouldRecord = currentContent !== '' && sha256(currentContent) !== sha256(content);
    const conflictRecordId = shouldRecord
      ? await recordConflict(ctx, fileKey, currentContent, currentVersion, opts.instanceId || INSTANCE_ID)
      : null;

    // Never touch the local file — the caller just authored this content.
    return {
      putContent: content,
      versionHint: currentVersion,
      recordContent: content,
      resultExtra: {
        conflict: true, conflictVersion: currentVersion, remoteDiverged,
        conflictRecorded: conflictRecordId !== null, conflictRecordId,
      },
    };
  }

  // Default policy: 'merge-local-diff' — overwrites the local file on disk.
  const dest = resolveKbDest(rootPath, fileKey); // C1545
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const versions = getLocalVersions(rootPath);
  writeEntry(versions, fileKey, currentVersion, sha256(currentContent));
  saveLocalVersions(rootPath, versions);

  const remoteLines = new Set(currentContent.split('\n'));
  const localOnlyLines = content.split('\n').filter(l => !remoteLines.has(l));
  let merged = currentContent;
  if (localOnlyLines.length > 0) {
    merged += '\n\n<!-- LOCAL DIFF (unmerged) -->\n' + localOnlyLines.join('\n') + '\n<!-- END DIFF -->';
  }
  fs.writeFileSync(dest, merged, 'utf8');

  return { putContent: merged, versionHint: currentVersion, recordContent: merged, resultExtra: {} };
}

// {putContent, versionHint} straight to the wire — used for a fresh lock placeholder
// (version 0, content '') where there is nothing to merge or diverge from.
function placeholderResolved(content) {
  return { putContent: content, versionHint: 0, recordContent: content, resultExtra: {} };
}

async function putResolved(url, headers, timeoutMs, fileKey, resolved, rootPath) {
  const retry = await request(url, {
    method: 'PUT',
    headers,
    body: { content: resolved.putContent, version_hint: resolved.versionHint },
    timeoutMs,
  });
  if (retry.status === 409 && retry.data && retry.data.lock_held) throw lockHeldError(retry.data);
  if (retry.status !== 200) {
    throw new Error(`pushFile(${fileKey}): retry PUT failed with HTTP ${retry.status}`);
  }
  recordPushed(rootPath, fileKey, retry.data.version, resolved.recordContent);
  return { version: retry.data.version, ...resolved.resultExtra };
}

/**
 * @param {object} [opts]
 * @param {'merge-local-diff'|'local-wins'} [opts.onConflict] 409 resolution
 *   policy. Default 'merge-local-diff' (existing behavior): overwrites the
 *   local file on disk with the remote content plus an appended
 *   "<!-- LOCAL DIFF (unmerged) -->" block, then retries. Used by pushAll /
 *   pushArchitectureDocs / discover.js / MCP push_knowledge.
 *   'local-wins' (C1037 autopush): re-PUTs the SAME local content at the
 *   server's current version — never touches the file on disk. Distinguishes
 *   pure version drift (remote content unchanged since our last sync) from
 *   real divergence via the cached hash, and — when opts.preserveRemoteOnConflict
 *   is set and content genuinely diverged — saves the remote copy under
 *   .tipatask/conflicts/ before overwriting it remotely.
 * @param {number} [opts.timeoutMs] forwarded to http.js request() for the PUT
 * @param {boolean} [opts.preserveRemoteOnConflict]
 * @param {number} [opts.lockWaitMs] C1105 — total time to wait while the file's
 *   lease is held by someone else before giving up. Default 30s. 0 waits once
 *   (no retry) before giving up.
 * @param {number} [opts.lockTimeoutMs] per-request timeout for acquire/release. Default 5s.
 * @param {number} [opts.lockTtlSeconds] lease length to request. Default server default (10 min).
 * @returns {Promise<{version:number, locked:boolean, conflict?:boolean, conflictVersion?:number, remoteDiverged?:boolean, conflictRecorded?:boolean, conflictRecordId?:number|null}>}
 * @throws {Error & {lockHeld:true}} when the file's lease is held by someone else and
 *   opts.lockWaitMs is exhausted (or immediately, if lockWaitMs is 0).
 */
async function pushFile(baseUrl, projectId, token, fileKey, content, localVersion, rootPath, opts = {}) {
  const url = `${baseUrl}/api/projects/${projectId}/knowledge/${fileKey}`;
  const timeoutMs = opts.timeoutMs;
  const ctx = { baseUrl, projectId, token, timeoutMs };
  const instanceId = opts.instanceId || INSTANCE_ID;

  const lockingEnabled = process.env.TIPATASK_KB_LOCK !== '0';
  // C1105/C1221 — the PUT itself carries the instance header too, not just acquire/release:
  // isSameHolder() (api/src/routes/knowledge.js) needs it on every lock-aware request to tell
  // "the lease holder's own PUT" from "a different instance of the same user's PUT" — without
  // it here, the PUT-layer check silently degrades to the pre-C1105 per-user rule even though
  // acquire/release already narrowed to per-instance. Gated on lockingEnabled — TIPATASK_KB_LOCK=0
  // must restore the EXACT pre-C1105 plain-PUT flow, including "my own other instance's stale
  // lease never blocks me" — sending the header unconditionally would turn the kill switch into
  // a half-measure that still 409s on a same-user/different-instance PUT.
  const headers = { Authorization: `Bearer ${token}`, ...(lockingEnabled ? { 'X-Tipatask-Instance': instanceId } : {}) };

  const lease = lockingEnabled
    ? await acquireLockWithWait(baseUrl, projectId, token, fileKey, opts)
    : null;
  // C1221 — surfaces to callers (autoPushOnEdit -> kb-autopush.log) whether this push
  // actually acquired a lease or fell through to the pre-C1105 lock-less PUT (locking
  // disabled, or acquireLock failed open on a 404/5xx/transport error — the two are NOT
  // distinguishable from `locked` alone; see the kb-autopush.log doc note). A `pushed` log
  // line was previously indistinguishable from either case.
  const locked = lease !== null;
  const withLease = (r) => ({ ...r, locked });

  try {
    // The lease acquire already told us the live version/content — resolve any
    // divergence from it directly instead of racing a PUT for a 409 we already know
    // is coming. A fresh lock placeholder (version 0, content '') has nothing to
    // merge or diverge from, so it always wins the version_hint outright.
    if (lease && lease.version !== localVersion) {
      const resolved = (lease.version === 0 && lease.content === '')
        ? placeholderResolved(content)
        : await resolveConflict(ctx, opts, fileKey, content, lease.version, lease.content, rootPath);
      return withLease(await putResolved(url, headers, timeoutMs, fileKey, resolved, rootPath));
    }

    const { status, data } = await request(url, {
      method: 'PUT',
      headers,
      body: { content, version_hint: localVersion },
      timeoutMs,
    });

    if (status === 200) {
      recordPushed(rootPath, fileKey, data.version, content);
      return withLease({ version: data.version });
    }

    if (status === 409) {
      // Never let a lock_held 409 fall into conflict resolution — it carries no
      // current_version/current_content, so merge-local-diff would write `undefined`
      // to disk. Can only reach here when lockingEnabled is false, acquire failed open
      // (un-upgraded API / transport hiccup) and another writer's lease then won the race
      // on this PUT, or our own lease expired mid-push (TTL elapsed between acquire and
      // this PUT) and a different instance took it over in between.
      if (data && data.lock_held) throw lockHeldError(data);
      const resolved = await resolveConflict(ctx, opts, fileKey, content, data.current_version, data.current_content, rootPath);
      return withLease(await putResolved(url, headers, timeoutMs, fileKey, resolved, rootPath));
    }

    throw new Error(`pushFile(${fileKey}): HTTP ${status}`);
  } finally {
    // C1105/C1221 — must forward the SAME instanceId used above: without it, this release
    // falls back to this process's own INSTANCE_ID, which mismatches whenever a caller (only
    // scripts/probe-kb-lock.js today) acquired as a different impersonated instance. A
    // mismatched release 409s as lockHeld, is swallowed by .catch(()=>{}) below, and leaks
    // the lease until its TTL (up to 10 min) on a real API.
    if (lease) await releaseLock(baseUrl, projectId, token, fileKey, { instanceId, timeoutMs: opts.lockTimeoutMs }).catch(() => {});
  }
}

// C1220 — <projectRoot>/.tipatask/kb-conflicts-seen.json: {lastCheckedAt}. Marks how far
// checkKnowledgeConflicts has already reported, same atomic tmp+rename pattern as
// saveLocalVersions/writeReindexState above.
function conflictsSeenStatePath(rootPath) {
  return path.join(rootPath, '.tipatask', 'kb-conflicts-seen.json');
}

function readConflictsSeenState(rootPath) {
  try {
    return JSON.parse(fs.readFileSync(conflictsSeenStatePath(rootPath), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeConflictsSeenState(rootPath, patch) {
  const p = conflictsSeenStatePath(rootPath);
  const next = { ...readConflictsSeenState(rootPath), ...patch };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// C1220 — pull-time warning: reports conflict records created since the last check, so a
// writer whose edit was overwritten elsewhere finds out at their next sync instead of
// never. One project-wide metadata GET per call (no content, no per-file round trips).
// Records this process's own overwrites are filtered out — this machine already wrote the
// .tipatask/conflicts/ sidecar for those, it doesn't need to be told about itself.
//
// First call for a project writes the marker and reports nothing — without this, a
// project's entire conflict history would flood the very first sync after this feature
// ships. Fails open on any error (network, un-upgraded API, bad state file): resolves [],
// never throws, matches every other sync-trigger helper in this module.
async function checkKnowledgeConflicts(baseUrl, projectId, token, rootPath) {
  try {
    const state = readConflictsSeenState(rootPath);
    const isFirstRun = !state.lastCheckedAt;

    const data = await fetchConflictRecords(baseUrl, projectId, token, {
      since: isFirstRun ? undefined : state.lastCheckedAt,
      limit: 200,
    });
    const records = (data && Array.isArray(data.conflicts)) ? data.conflicts : [];

    if (records.length > 0) {
      // Advance to the max created_at in THIS response, not Date.now() — the DB clock and
      // this process's clock need not agree (same reasoning as knowledge.js's
      // LOCK_SELECT_COLUMNS comment), and comparing two DB-issued timestamps to each other
      // cancels that offset out.
      const maxCreatedAt = records.reduce(
        (max, r) => (new Date(r.created_at) > new Date(max) ? r.created_at : max),
        records[0].created_at,
      );
      writeConflictsSeenState(rootPath, { lastCheckedAt: maxCreatedAt });
    } else if (isFirstRun) {
      // Nothing to report, but still stamp the marker so a first-ever call doesn't re-scan
      // full history forever on a project with zero conflicts.
      writeConflictsSeenState(rootPath, { lastCheckedAt: new Date(0).toISOString() });
    }

    if (isFirstRun) return [];
    return records.filter(r => r.overwritten_instance !== INSTANCE_ID);
  } catch {
    return [];
  }
}

async function syncOnSessionStart(baseUrl, projectId, token, rootPath) {
  const [remote, local] = await Promise.all([
    fetchRemoteVersions(baseUrl, projectId, token),
    Promise.resolve(getLocalVersions(rootPath)),
  ]);
  const remoteIsEmpty = Object.keys(remote).length === 0;
  let pulledCount = 0;
  const pulledKeys = [];
  for (const [fileKey, remoteVersion] of Object.entries(remote)) {
    // readEntry() unwraps the {version, hash} cache entry shape. Comparing
    // remoteVersion (a number) directly against local[fileKey] (an object)
    // always coerced to NaN and made this condition permanently false — every
    // cache entry has been object-form since the hash upgrade, so this pull
    // path silently pulled nothing. Fixed as part of C1037 (autopush makes a
    // dead pull path far more costly: without it, every machine drifts
    // forever and every push after the first becomes a 409).
    // C1545 — a bad key here would otherwise throw out of pullFile and abort every
    // remaining file in this sync; skip it and keep going instead.
    if (!isKbFileKey(fileKey)) {
      console.error(`[knowledge-sync] syncOnSessionStart: skipping unsafe file_key ${JSON.stringify(fileKey)}`);
      continue;
    }
    if (remoteVersion > readEntry(local, fileKey).version) {
      // C1231 — pass the remote version we already fetched so pullFile can re-verify
      // against it; only count/report a file that was actually written to disk (a
      // 'content-match' skip still stamps the cache but touches nothing on disk).
      const res = await pullFile(baseUrl, projectId, token, fileKey, rootPath, { remoteVersion });
      if (res.written) {
        pulledCount++;
        pulledKeys.push(fileKey);
      }
    }
  }
  // C1220 — best-effort, never blocks/fails the pull it rides along with.
  const conflicts = await checkKnowledgeConflicts(baseUrl, projectId, token, rootPath);
  return { pulledCount, remoteIsEmpty, pulledKeys, conflicts };
}

async function pullArchitectureDocs(baseUrl, projectId, token, rootPath) {
  const remote = await fetchRemoteVersions(baseUrl, projectId, token);
  const local  = getLocalVersions(rootPath);
  const report = { pulled: [], merged: [], skipped: [] };

  for (const [fileKey, remoteVersion] of Object.entries(remote)) {
    if (!fileKey.startsWith('ai/architecture/tt-') || !fileKey.endsWith('.md')) continue;
    // C1545 — the prefix test above stops at "starts with"; it doesn't stop a key like
    // "ai/architecture/tt-../../../x.md" from normalizing out of the tree. Real guard:
    if (!isKbFileKey(fileKey)) {
      console.error(`[knowledge-sync] pullArchitectureDocs: skipping unsafe file_key ${JSON.stringify(fileKey)}`);
      continue;
    }

    const entry = readEntry(local, fileKey);
    if (remoteVersion <= entry.version) { report.skipped.push(fileKey); continue; }

    const { status, data } = await request(
      `${baseUrl}/api/projects/${projectId}/knowledge/${fileKey}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (status !== 200) throw new Error(`pullArchitectureDocs(${fileKey}): HTTP ${status}`);

    const dest = resolveKbDest(rootPath, fileKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    let finalContent = data.content;
    if (fs.existsSync(dest)) {
      const localContent = fs.readFileSync(dest, 'utf8');
      if (localContent === data.content) {
        const versions = getLocalVersions(rootPath);
        writeEntry(versions, fileKey, data.version, sha256(localContent));
        saveLocalVersions(rootPath, versions);
        report.skipped.push(fileKey);
        continue;
      }
      finalContent = mergeBySections(localContent, data.content);
      report.merged.push(fileKey);
    } else {
      report.pulled.push(fileKey);
    }

    fs.writeFileSync(dest, finalContent, 'utf8');
    const versions = getLocalVersions(rootPath);
    writeEntry(versions, fileKey, data.version, sha256(finalContent));
    saveLocalVersions(rootPath, versions);
  }
  return report;
}

async function pushArchitectureDocs(baseUrl, projectId, token, rootPath) {
  const archDir = path.resolve(rootPath, 'ai/architecture');
  if (!fs.existsSync(archDir)) return { pushed: [], skipped: [] };

  const ttFiles = fs.readdirSync(archDir)
    .filter(f => f.startsWith('tt-') && f.endsWith('.md'))
    .map(f => `ai/architecture/${f}`);

  const report = { pushed: [], skipped: [] };

  for (const fileKey of ttFiles) {
    const abs = path.resolve(rootPath, fileKey);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    const hash = sha256(content);
    const versions = getLocalVersions(rootPath);
    const entry = readEntry(versions, fileKey);

    if (entry.hash && entry.hash === hash && entry.version > 0) {
      report.skipped.push(fileKey);
      continue;
    }

    try {
      await pushFile(baseUrl, projectId, token, fileKey, content, entry.version, rootPath);
      report.pushed.push(fileKey);
    } catch (err) {
      // C1105 — a lease held by someone else defers this one file rather than aborting
      // the whole batch; the version cache stays stale so the NEXT bulk push retries it.
      if (err.lockHeld) { report.skipped.push(fileKey); continue; }
      throw err;
    }
  }
  return report;
}

// C1337 — hash-skip unchanged files, same guard pushArchitectureDocs already has (line
// ~721). Without this, wiring pushAll into every project-open trigger (boot, window-bind)
// would bump the remote version of all 4 core files on every single launch — pure churn,
// no content change — and every OTHER machine syncing that project would then see a
// version bump with identical bytes forever.
async function pushAll(baseUrl, projectId, token, rootPath) {
  const versions = getLocalVersions(rootPath);
  const pushed = [];
  const skipped = [];

  for (const fileKey of SYNC_FILES) {
    const absPath = path.resolve(rootPath, fileKey);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, 'utf8');
    const hash = sha256(content);
    const entry = readEntry(versions, fileKey);

    if (entry.hash && entry.hash === hash && entry.version > 0) {
      skipped.push(fileKey);
      continue;
    }

    try {
      await pushFile(baseUrl, projectId, token, fileKey, content, entry.version, rootPath);
      pushed.push(fileKey);
    } catch (err) {
      if (err.lockHeld) { skipped.push(fileKey); continue; } // C1105 — deferred, not lost
      throw err;
    }
  }
  return { pushed, skipped };
}

// rootPath -> { promise, settledAt }. Was a process-global boolean — in a multi-window
// Electron run (one forked server serves every project window) the first project to sync
// permanently latched out every other project sharing this process. Keyed by rootPath
// fixes that (C1062).
//
// C1337 — settledAt turns the latch from PERMANENT into a short reuse window
// (SESSION_SYNC_TTL_MS). Before this, a project opened, closed, and re-opened in the same
// process (same forked server, or Electron main across two `bindWindowToProject` binds)
// returned the original settled promise forever — no new pull ever ran, and
// window-state.js's "pulled N file(s)" log kept reporting the FIRST sync's stale numbers.
// in-flight entries (settledAt still null) are always reused regardless of TTL — this is
// the actual single-flight coalescing C1062 needs, unaffected by the TTL.
const _sessionSyncStarted = new Map();
const SESSION_SYNC_TTL_MS = 60000;

function fireSessionSync(baseUrl, projectId, token, rootPath, label) {
  const key = rootPath || '';
  const cached = _sessionSyncStarted.get(key);
  if (cached && (cached.settledAt === null || Date.now() - cached.settledAt < SESSION_SYNC_TTL_MS)) {
    return cached.promise;
  }
  const entry = { promise: null, settledAt: null };
  entry.promise = syncOnSessionStart(baseUrl, projectId, token, rootPath).then(res => {
    entry.settledAt = Date.now();
    // C1220 — surface a losing writer's overwritten content at the point they'd otherwise
    // never learn about it: their next sync.
    if (res && res.conflicts && res.conflicts.length > 0) {
      process.stderr.write(`[kb-conflict:${label}] ${res.conflicts.length} remote KB edit(s) overwritten — recover with MCP list_knowledge_conflicts\n`);
    }
    return res;
  }).catch(err => {
    _sessionSyncStarted.delete(key); // allow an immediate retry, as before
    process.stderr.write(`[kb-sync:${label}] ${err.message}\n`);
    return null;
  });
  _sessionSyncStarted.set(key, entry);
  return entry.promise;
}

// TEST SEAM (C1323) — clears this module's process-local single-flight state for one root
// (or every root when called with no argument), so a concurrency test can re-run the same
// rootPath without a previously-settled promise/damper leaking into the next case. No
// production call site uses this. Deliberately does NOT touch an entry still in flight in
// _autoReindexInFlight — deleting a live entry would let a second run start alongside the
// first; only settled/idle state is safe to clear.
function __resetSyncState(rootPath) {
  if (rootPath === undefined) {
    _sessionSyncStarted.clear();
    _autoReindexCheckedAt.clear();
    _syncAsYouGoCache.clear();
    for (const [key, entry] of _autoReindexInFlight) {
      if (!entry.promise) _autoReindexInFlight.delete(key);
    }
    return;
  }
  const key = rootPath || '';
  _sessionSyncStarted.delete(key);
  _autoReindexCheckedAt.delete(key);
  const inflight = _autoReindexInFlight.get(key);
  if (inflight && !inflight.promise) _autoReindexInFlight.delete(key);
  // C1490 — _syncAsYouGoCache is keyed by `${baseUrl}|${projectId}`, not rootPath, so a
  // per-root call can't target one entry; a targeted reset just clears the whole cache too
  // (same cost as the process.stderr-free path here — tests call this between cases, not
  // hot-loop).
  _syncAsYouGoCache.clear();
}

const ARCH_DIR_PREFIX = 'ai/architecture/';

// Map an absolute-or-relative path to a watched KB file_key, or null if the
// path isn't one of the files autoPushOnEdit cares about. Watched: SYNC_FILES
// (CLAUDE.md, AGENTS.md, ai/architecture/GENERAL.md, ai/CONVENTIONS.md) plus
// top-level ai/architecture/tt-*.md (nested subdirectories excluded).
function toKbFileKey(filePath, rootPath) {
  const abs = path.resolve(rootPath, filePath);
  const rel = path.relative(rootPath, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside root
  const key = rel.split(path.sep).join('/'); // win32-safe
  if (SYNC_FILES.includes(key)) return key;
  if (key.startsWith(ARCH_DIR_PREFIX) && key.endsWith('.md')) {
    const base = key.slice(ARCH_DIR_PREFIX.length);
    if (!base.includes('/') && base.startsWith('tt-')) return key;
  }
  return null;
}

const AUTOPUSH_TIMEOUT_MS = 8000;
const AUTOPUSH_LOCK_WAIT_MS = 30000; // C1105 — max wait for a contended lease before deferring
const AUTOPUSH_LOCK_TIMEOUT_MS = 5000;

// C1490 — Sync-as-you-go gate. Mirrors src/server/vcs-settings.js's normalize+fetch pair:
// pure normalizer, fail-open fetcher. ON (true) is today's behavior; the project row's
// kb_sync_as_you_go column (migration 056) defaults there.
const SYNC_AS_YOU_GO_TTL_MS = 30000;
const _syncAsYouGoCache = new Map(); // `${baseUrl}|${projectId}` -> { value, at }

// Pure. Raw project row -> boolean. null row (offline/no creds) or a column the API
// predates (pre-C1488 server) both mean "on" — never silently stop syncing because of a
// read failure or an old API.
function normalizeSyncAsYouGo(project) {
  if (!project || project.kb_sync_as_you_go === undefined || project.kb_sync_as_you_go === null) return true;
  return !!project.kb_sync_as_you_go;
}

// Fail-open, never throws — always resolves `true` on any failure (same discipline as
// fetchVcsSettings/fetchStatusRoles). `source` is either:
//  - backend-shaped: has getProjectSettings(opts) (api-backend.js) — reuses that
//    instance's own 30s _projectSettingsEntry cache, no extra cache needed here.
//  - creds-shaped: { baseUrl, projectId, token } (what getApiCredentials(root) returns) —
//    used by autoPushOnEdit, which runs inside the short-lived PostToolUse hook process
//    and has no backend object at all. Memoized here for SYNC_AS_YOU_GO_TTL_MS so a burst
//    of Edit/Write hooks in one session doesn't GET the project row on every write.
async function isSyncAsYouGoEnabled(source, opts = {}) {
  if (!source) return true;
  try {
    if (typeof source.getProjectSettings === 'function') {
      const project = await source.getProjectSettings(opts);
      return normalizeSyncAsYouGo(project);
    }
    if (source.baseUrl && source.projectId && source.token) {
      const cacheKey = `${source.baseUrl}|${source.projectId}`;
      const cached = _syncAsYouGoCache.get(cacheKey);
      if (!opts.refresh && cached && (Date.now() - cached.at) < SYNC_AS_YOU_GO_TTL_MS) return cached.value;
      const res = await request(`${source.baseUrl}/api/projects/${source.projectId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${source.token}` },
        timeoutMs: 5000,
      });
      const value = res.status >= 200 && res.status < 300
        ? normalizeSyncAsYouGo(res.data && res.data.project)
        : true;
      _syncAsYouGoCache.set(cacheKey, { value, at: Date.now() });
      return value;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Push a just-edited KB file to the remote API, immediately after the local
 * write completes. Called from the Claude Code PostToolUse hook
 * (scripts/push-kb-on-write.js) after every Edit/Write/
 * MultiEdit — this is what replaces the "agent must remember to call
 * push_knowledge" reliability gap (C1037).
 *
 * NEVER THROWS — always resolves to a result object so it's safe to call
 * unconditionally from a hook that must never block the agent.
 *
 * Uses onConflict:'local-wins' (see pushFile) — a 409 never overwrites the
 * file the caller just wrote; only the remote copy loses.
 *
 * @param {string} filePath absolute or root-relative path to the written file
 * @param {string} [rootPath] project root; defaults to TIPATASK_PROJECT_ROOT
 * @param {{ignoreSyncFlag?: boolean}} [opts] C1490 — ignoreSyncFlag skips the
 *   kb_sync_as_you_go gate (used by kb-reindex.js's own H1-rewrite push, which is a
 *   boot/manual operation, not "as you go" traffic)
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'pushed'|'conflict-overwrote-remote'|'skipped-not-kb'|
 *           'skipped-unchanged'|'skipped-missing-file'|'skipped-no-root'|
 *           'skipped-no-backend'|'skipped-no-creds'|'skipped-disabled'|
 *           'skipped-lock-held'|'skipped-sync-as-you-go-off'|'dry-run'|'error',
 *   fileKey?: string, version?: number, message?: string, remoteDiverged?: boolean,
 *   locked?: boolean,
 * }>}
 */
async function autoPushOnEdit(filePath, rootPath, opts = {}) {
  let fileKey;
  try {
    const mode = process.env.TIPATASK_KB_AUTOPUSH; // '0'/'false' off, 'dry' log-only
    if (mode === '0' || mode === 'false') return { ok: true, status: 'skipped-disabled' };

    const root = rootPath || process.env.TIPATASK_PROJECT_ROOT;
    if (!root) return { ok: true, status: 'skipped-no-root' };

    fileKey = toKbFileKey(filePath, root);
    if (!fileKey) return { ok: true, status: 'skipped-not-kb' };

    const abs = path.resolve(root, fileKey);
    if (!fs.existsSync(abs)) return { ok: true, status: 'skipped-missing-file', fileKey };

    // Lazy requires: keep knowledge-sync cheap for callers that never
    // auto-push, and avoid a hard dependency for non-server consumers.
    const { readProjectConfig } = require('../server/project-config');
    // (C1353) Coerced — a project whose config still carries the retired TASK_BACKEND="file"
    // (C1352) must get KB sync like every other consumer now, not silently lose it forever
    // because this one gate never coerced.
    const { coerceBackendType } = require('../server/task-backend');
    const backend = coerceBackendType(process.env.TASK_BACKEND || (readProjectConfig(root) || {}).TASK_BACKEND);
    if (backend !== 'api') return { ok: true, status: 'skipped-no-backend', fileKey };

    let creds;
    try {
      creds = require('../server/api-credentials').getApiCredentials(root);
    } catch (err) {
      if (err.missingCredentials) return { ok: true, status: 'skipped-no-creds', fileKey };
      throw err;
    }

    const content = fs.readFileSync(abs, 'utf8');
    const hash = sha256(content);
    const entry = readEntry(getLocalVersions(root), fileKey);

    // Idempotence — same hash-skip pattern as pushArchitectureDocs. This is
    // what keeps repeated no-op writes from spamming the remote version.
    if (entry.hash && entry.hash === hash && entry.version > 0) {
      return { ok: true, status: 'skipped-unchanged', fileKey, version: entry.version };
    }

    // C1490 — project-level "Sync as you go" off: skip the live PUT, backstopped by boot
    // sync / manual Project > Knowledge Base > Sync. Checked after the hash-skip above
    // (an unchanged file needs no HTTP either way) and before the dry-run branch below (a
    // dry probe should report nothing-would-push, not a hypothetical version bump).
    if (!opts.ignoreSyncFlag && !(await isSyncAsYouGoEnabled(creds))) {
      return { ok: true, status: 'skipped-sync-as-you-go-off', fileKey, version: entry.version };
    }

    if (mode === 'dry') {
      return {
        ok: true, status: 'dry-run', fileKey, version: entry.version,
        message: `would PUT v${entry.version} -> v${entry.version + 1}`,
      };
    }

    // Test/ops seam — read fresh per call (not a module-load constant) so a test can set
    // it right before the call it wants fast and unset it after, without a process restart.
    const lockWaitMs = Number(process.env.TIPATASK_KB_AUTOPUSH_LOCK_WAIT_MS) || AUTOPUSH_LOCK_WAIT_MS;

    let r;
    try {
      r = await pushFile(
        creds.baseUrl, creds.projectId, creds.token,
        fileKey, content, entry.version, root,
        {
          onConflict: 'local-wins', timeoutMs: AUTOPUSH_TIMEOUT_MS, preserveRemoteOnConflict: true,
          lockWaitMs, lockTimeoutMs: AUTOPUSH_LOCK_TIMEOUT_MS,
        },
      );
    } catch (err) {
      // C1105 — a lease held by someone else defers this push rather than failing it: the
      // version cache is deliberately left untouched, so the next pushAll/pushArchitectureDocs
      // (WS-close, Project > Knowledge Base > Sync) retries the write.
      if (err.lockHeld) {
        const holder = err.sameUser ? 'another instance of your account' : (err.lockedByEmail || 'another user');
        return {
          ok: true, status: 'skipped-lock-held', fileKey,
          message: `held by ${holder} until ${err.lockExpiresAt}; deferred to next bulk sync`,
        };
      }
      throw err;
    }

    if (r.conflict) {
      return {
        ok: true, status: 'conflict-overwrote-remote', fileKey, version: r.version, locked: r.locked,
        remoteDiverged: r.remoteDiverged, conflictRecorded: r.conflictRecorded, conflictRecordId: r.conflictRecordId,
        message: r.remoteDiverged
          ? `remote had diverged at v${r.conflictVersion}; local content pushed as v${r.version} (remote copy saved under .tipatask/conflicts/${r.conflictRecorded ? ` and to the API as conflict record #${r.conflictRecordId} — recoverable by the other writer` : ''})`
          : `version drift only (remote v${r.conflictVersion}, same content); pushed as v${r.version}`,
      };
    }
    return { ok: true, status: 'pushed', fileKey, version: r.version, locked: r.locked };
  } catch (err) {
    return { ok: false, status: 'error', fileKey, message: err.message };
  }
}

/**
 * Config/credential-gated, never-throwing pull entry point (C1062). Called
 * from `main/window-state.js` `bindWindowToProject` — Electron never runs
 * `fireSessionSync` on WS connect (board WS skipped, see tt-electron-app.md),
 * so this is the only automatic KB pull an Electron project window gets.
 * Same guard ladder as `autoPushOnEdit`, but for the pull side.
 *
 * @param {string} rootPath project root (absolute)
 * @param {string} label passed through to fireSessionSync's stderr tag
 * @returns {Promise<{ok: boolean, status: 'skipped-no-root'|'skipped-no-backend'|
 *   'skipped-no-creds'|'synced'|'error', pulledCount?: number,
 *   pulledKeys?: string[], remoteIsEmpty?: boolean, message?: string}>}
 */
async function syncProjectKb(rootPath, label, opts = {}) {
  try {
    if (!rootPath) return { ok: true, status: 'skipped-no-root' };

    const { readProjectConfig } = require('../server/project-config');
    // (C1353) Coerced — see autoPushOnEdit's identical comment above.
    const { coerceBackendType } = require('../server/task-backend');
    const backend = coerceBackendType(process.env.TASK_BACKEND || (readProjectConfig(rootPath) || {}).TASK_BACKEND);
    if (backend !== 'api') return { ok: true, status: 'skipped-no-backend' };

    let creds;
    try {
      creds = require('../server/api-credentials').getApiCredentials(rootPath);
    } catch (err) {
      if (err.missingCredentials) return { ok: true, status: 'skipped-no-creds' };
      throw err;
    }

    const res = await fireSessionSync(creds.baseUrl, creds.projectId, creds.token, rootPath, label);
    if (!res) return { ok: false, status: 'error', message: 'sync failed (see stderr)' };

    // C1337 — push half, opt-in (default off — keeps the one non-production caller,
    // scripts/probe-kb-lock.js, byte-identical). Runs AFTER the pull resolves, never
    // before — same order kb-reindex.js's presync and setup.js's full-setup flow already
    // use. A push failure never flips the PULL's ok/status — logged and swallowed, same
    // fail-open discipline as every other guard in this ladder.
    let pushResult = {};
    if (opts.push) {
      try {
        const archReport = await pushArchitectureDocs(creds.baseUrl, creds.projectId, creds.token, rootPath);
        const coreReport = await pushAll(creds.baseUrl, creds.projectId, creds.token, rootPath);
        pushResult = {
          pushed: [...archReport.pushed, ...coreReport.pushed],
          pushSkipped: [...archReport.skipped, ...coreReport.skipped],
        };
      } catch (err) {
        process.stderr.write(`[kb-push:${label}] ${err.message}\n`);
      }
    }

    return { ok: true, status: 'synced', ...res, ...pushResult };
  } catch (err) {
    return { ok: false, status: 'error', message: err.message };
  }
}

// All automatic and manual KB reindex triggers share this single-flight, lease,
// and cooldown gate. Manual calls join an in-flight run; auto calls also use a
// recent-clean damper. Disk state prevents duplicate cross-process work and
// repeated retries after restart; kb-reindex.js owns detection and generation.

const AUTO_REINDEX_COOLDOWN_MS = 60 * 60 * 1000; // after a run FINISHES, success or failure
const AUTO_REINDEX_LEASE_MS = 30 * 60 * 1000;    // a started-but-never-finished run is presumed dead after this
const AUTO_REINDEX_RECHECK_MS = 5 * 60 * 1000;   // damper: how often a "clean" project re-checks

function reindexStatePath(rootPath) {
  return path.join(rootPath, '.tipatask', 'kb-reindex-state.json');
}

function readReindexState(rootPath) {
  try {
    return JSON.parse(fs.readFileSync(reindexStatePath(rootPath), 'utf8')) || {};
  } catch {
    return {};
  }
}

// Read-modify-write + atomic tmp/rename — same shape as saveLocalVersions above. A patch
// object is merged onto whatever is currently on disk so a concurrent writer's other
// fields survive (two processes writing at once is a rare, accepted race — see
// tt-knowledge-sync.md's C1218 risk note; worst case is one duplicated Opus run, not data
// loss, since both `.lastRun*` writes are internally self-consistent).
function writeReindexState(rootPath, patch) {
  const p = reindexStatePath(rootPath);
  const current = readReindexState(rootPath);
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// (TPT295) The disk lease only counts while the process that took it is alive. A run cut off by a
// server exit or crash is retried on the next trigger instead of being skipped until
// AUTO_REINDEX_LEASE_MS runs out — safe, because every write a run makes is idempotent, the DB
// persist comes last and scope classification checks the DB descriptions, so an unpersisted run is
// found stale again.
// A state without a usable pid keeps the time-only lease. Our own pid means no run is in flight
// here: the in-memory single-flight check returns before the disk check.
function isLeaseOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal; ESRCH = gone
  }
}

// rootPath -> { promise, listeners:Set<onProgress>, tagCount, fileCount, staleCount } —
// in-memory single-flight for THIS process. rootPath -> ms of the last "clean" or
// "detect-failed" outcome — the damper that keeps a burst of triggers on a healthy
// project from re-issuing the two detect GETs every time.
const _autoReindexInFlight = new Map();
const _autoReindexCheckedAt = new Map();

function _emit(fn, arg) {
  try { fn(arg); } catch { /* a bad listener must never break a reindex run */ }
}

/**
 * NEVER THROWS.
 *
 * @param {string} rootPath
 * @param {string} label — trigger tag for logs/state (e.g. 'ws', 'sync-kb', 'spawn', 'window-bind', 'manual')
 * @param {object} opts
 * @param {object}   opts.backend            duck-typed task backend for this project
 * @param {boolean}  [opts.manual]           user-clicked Re-Index: bypasses the damper, the
 *   disk lease, the disk cooldown, and the needsRun gate — still single-flights (joins an
 *   in-flight run rather than starting a second) and still stamps the disk state.
 * @param {(d:{tagCount:number,fileCount:number,staleCount:number,linkOnlyCount?:number,joined?:boolean})=>void} [opts.onStart]
 * @param {(p:{phase:string,done:number,total:number})=>void} [opts.onProgress]
 * @param {boolean}  [opts.force]            forwarded to detectStaleDescriptions/reindexKnowledge
 * @param {number}   [opts.cooldownMs]       test override
 * @param {number}   [opts.leaseMs]          test override
 * @param {number}   [opts.recheckMs]        test override
 * @param {Function} [opts.runReindex]       TEST SEAM ONLY — defaults to kb-reindex.js's
 *   reindexKnowledge. No production call site passes this.
 * @returns {Promise<{ok:boolean, status:
 *   'skipped-disabled'|'skipped-no-root'|'skipped-in-flight'|'skipped-recently-checked'|
 *   'skipped-no-backend'|'skipped-unsupported-backend'|'skipped-no-creds'|
 *   'skipped-in-flight-other-process'|'skipped-cooldown'|
 *   'clean'|'detect-failed'|'ran'|'joined'|'error',
 *   tagCount?:number, fileCount?:number, staleCount?:number, linkOnlyCount?:number,
 *   cooldownRemainingMs?:number, result?:object, message?:string}>}
 */
async function fireAutoReindex(rootPath, label, opts = {}) {
  try {
    return await _fireAutoReindexInner(rootPath, label, opts);
  } catch (err) {
    return { ok: false, status: 'error', message: err.message };
  }
}

async function _fireAutoReindexInner(rootPath, label, opts) {
  const {
    backend, manual = false, onStart = () => {}, onProgress = () => {}, force = false,
    cooldownMs = AUTO_REINDEX_COOLDOWN_MS, leaseMs = AUTO_REINDEX_LEASE_MS, recheckMs = AUTO_REINDEX_RECHECK_MS,
    runReindex,
  } = opts;

  const mode = process.env.TIPATASK_KB_AUTOREINDEX; // '0'/'false' disables AUTO firing only
  if (!manual && (mode === '0' || mode === 'false')) return { ok: true, status: 'skipped-disabled' };
  if (!rootPath) return { ok: true, status: 'skipped-no-root' };

  const key = rootPath;

  const inflight = _autoReindexInFlight.get(key);
  if (inflight) {
    if (!manual) return { ok: true, status: 'skipped-in-flight' };
    // Manual: attach to the run already in progress instead of starting a second one.
    inflight.listeners.add(onProgress);
    _emit(onStart, { tagCount: inflight.tagCount, fileCount: inflight.fileCount, staleCount: inflight.staleCount, linkOnlyCount: inflight.linkOnlyCount, joined: true });
    try {
      const res = await inflight.promise;
      return { ...res, status: 'joined' };
    } finally {
      inflight.listeners.delete(onProgress);
    }
  }

  if (!manual) {
    const checkedAt = _autoReindexCheckedAt.get(key) || 0;
    if (Date.now() - checkedAt < recheckMs) return { ok: true, status: 'skipped-recently-checked' };
  }

  const { readProjectConfig } = require('../server/project-config');
  // (C1353) Coerced — see autoPushOnEdit's identical comment above.
  const { coerceBackendType } = require('../server/task-backend');
  const taskBackend = coerceBackendType(process.env.TASK_BACKEND || (readProjectConfig(rootPath) || {}).TASK_BACKEND);
  if (taskBackend !== 'api') return { ok: true, status: 'skipped-no-backend' };

  if (!backend || typeof backend.getTagsDetailed !== 'function' || typeof backend.reindexKnowledge !== 'function') {
    return { ok: true, status: 'skipped-unsupported-backend' };
  }

  let creds;
  try {
    creds = require('../server/api-credentials').getApiCredentials(rootPath);
  } catch (err) {
    if (err.missingCredentials) return { ok: true, status: 'skipped-no-creds' };
    throw err;
  }

  // Cross-process guards. NOTE: a manual click deliberately does NOT check these — a click
  // must always do something observable. It still only single-flights within THIS process
  // (the `inflight` check above); a genuinely concurrent second server process holding the
  // disk lease is an accepted, documented edge case (tt-knowledge-sync.md).
  if (!manual) {
    const now0 = Date.now();
    const state = readReindexState(rootPath);
    const startedAt = state.lastRunStartedAt || 0;
    const finishedAt = state.lastRunFinishedAt || 0;
    const leaseActive = startedAt > 0 && finishedAt < startedAt && (now0 - startedAt) < leaseMs
      && isLeaseOwnerAlive(state.lastRunPid);
    if (leaseActive) return { ok: true, status: 'skipped-in-flight-other-process', message: `pid ${state.lastRunPid} started ${now0 - startedAt}ms ago` };
    if (finishedAt > 0 && (now0 - finishedAt) < cooldownMs) {
      return { ok: true, status: 'skipped-cooldown', cooldownRemainingMs: cooldownMs - (now0 - finishedAt) };
    }
  }

  const kb = require('../server/kb-reindex'); // lazy — kb-reindex.js requires THIS module at top (cycle)

  // ── Claim the single-flight slot HERE — synchronously, before the first real await
  // (detectStaleDescriptions/runReindex) — not after detect resolves. Every guard step
  // above this line is synchronous (Map lookups, sync fs reads via readProjectConfig/
  // getApiCredentials/readReindexState), so two calls racing through the ladder in the
  // same JS tick both reach this exact line before either yields to the event loop; the
  // second one's `inflight` check above will find THIS entry. Claiming any later (e.g.
  // after awaiting detect) leaves a window where two concurrent triggers can both pass the
  // in-flight check and both end up running Opus.
  const entry = { listeners: new Set([onProgress]), promise: null, tagCount: 0, fileCount: 0, staleCount: 0, linkOnlyCount: 0 };
  _autoReindexInFlight.set(key, entry);

  entry.promise = (async () => {
    let detected = null;
    if (!manual) {
      try {
        detected = await kb.detectStaleDescriptions({ backend, rootPath, force, baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token });
      } catch (err) {
        _autoReindexCheckedAt.set(key, Date.now()); // damper only — NOT the hour cooldown; a network blip shouldn't cost as much as a broken Opus call
        return { ok: false, status: 'detect-failed', message: err.message };
      }
      // C1244 — needsRun (broader than hasStale) also fires a run for a link-only gap
      // (tags.knowledge_file_id NULL/stale, description already fine): zero Opus calls,
      // just the H96 self-heal. `?? detected.hasStale` keeps a stubbed/legacy detect
      // (no needsRun field) working exactly as before. See kb-reindex.js's
      // detectStaleDescriptions for how needsRun is computed.
      const needsRun = detected.needsRun ?? detected.hasStale;
      if (!needsRun) {
        _autoReindexCheckedAt.set(key, Date.now());
        return { ok: true, status: 'clean', tagCount: 0, fileCount: 0, staleCount: 0, linkOnlyCount: detected.linkOnlyCount };
      }
      entry.tagCount = detected.tagCount;
      entry.fileCount = detected.fileCount;
      entry.staleCount = detected.staleCount;
      entry.linkOnlyCount = detected.linkOnlyCount;
    }

    try {
      writeReindexState(rootPath, { lastRunStartedAt: Date.now(), lastRunFinishedAt: 0, lastRunLabel: label, lastRunPid: process.pid });
    } catch (err) {
      process.stderr.write(`[kb-reindex:${label}] state write failed: ${err.message}\n`);
    }
    _autoReindexCheckedAt.delete(key);
    _emit(onStart, { tagCount: entry.tagCount, fileCount: entry.fileCount, staleCount: entry.staleCount, linkOnlyCount: entry.linkOnlyCount });

    const run = runReindex || kb.reindexKnowledge;
    try {
      const result = await run({
        baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token, rootPath, backend, force,
        onProgress: (p) => { for (const fn of entry.listeners) _emit(fn, p); },
      });
      try {
        writeReindexState(rootPath, {
          lastRunFinishedAt: Date.now(), lastRunOk: true, lastError: null,
          lastResult: { tagsUpdated: result.tagsUpdated || 0, filesUpdated: result.filesUpdated || 0, skipped: result.skipped || 0, errorCount: (result.errors || []).length },
        });
      } catch (err) { process.stderr.write(`[kb-reindex:${label}] state write failed: ${err.message}\n`); }
      return { ok: true, status: 'ran', tagCount: entry.tagCount, fileCount: entry.fileCount, staleCount: entry.staleCount, linkOnlyCount: entry.linkOnlyCount, result };
    } catch (err) {
      try {
        writeReindexState(rootPath, { lastRunFinishedAt: Date.now(), lastRunOk: false, lastError: err.message });
      } catch (err2) { process.stderr.write(`[kb-reindex:${label}] state write failed: ${err2.message}\n`); }
      return { ok: false, status: 'ran', tagCount: entry.tagCount, fileCount: entry.fileCount, staleCount: entry.staleCount, linkOnlyCount: entry.linkOnlyCount, message: err.message };
    }
  })().finally(() => {
    _autoReindexInFlight.delete(key);
  });

  return await entry.promise;
}

module.exports = {
  SYNC_FILES,
  INSTANCE_ID,
  getLocalVersions,
  saveLocalVersions,
  fetchRemoteVersions,
  isKbFileKey,
  resolveKbDest,
  pullFile,
  acquireLock,
  releaseLock,
  pushFile,
  syncOnSessionStart,
  pushAll,
  pullArchitectureDocs,
  pushArchitectureDocs,
  mergeBySections,
  fireSessionSync,
  autoPushOnEdit,
  normalizeSyncAsYouGo,
  isSyncAsYouGoEnabled,
  syncProjectKb,
  readEntry,
  fireAutoReindex,
  fetchConflictRecords,
  fetchConflictRecord,
  checkKnowledgeConflicts,
  __resetSyncState,
};
