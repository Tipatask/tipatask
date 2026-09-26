'use strict';

// C1237 — best-effort KB-doc linking for new tt-* tags at objective-save time
// (api-backend.js overwriteRaw()). All network I/O here goes through cli/http's
// request() (via knowledge-sync.js helpers), NEVER api-backend.js's apiRequest() —
// a 401/403/network failure through apiRequest latches the whole backend's connection
// state (_markUnauthorized/_markDisconnected), and this feature must never be able to
// trigger that. Every exported function that does I/O is best-effort: it returns a
// {..., skipped/failed} shape and never throws for a per-tag problem, so a KB-linking
// hiccup can never break a task save. See ai/architecture/tt-api-backend.md §
// "tt-* tag ↔ KB doc linking at save (C1237)".

const fs = require('node:fs');
const path = require('node:path');
const { pushFile, fetchRemoteVersions, getLocalVersions, readEntry } = require('../cli/knowledge-sync');
const { request } = require('../cli/http');

const LINK_TIMEOUT_MS = 5000;
const PUSH_TIMEOUT_MS = 8000; // mirrors knowledge-sync.js's AUTOPUSH_TIMEOUT_MS

function archFileKey(tag) {
  return `ai/architecture/${tag}.md`;
}

// Same stub shape create_system_tag (mcp/server.js) has always written — factored out
// here so both creation paths can never drift apart.
function buildTagStub(tag, description, hint) {
  return `# ${tag} — ${description}\n\n${hint}\n\n## Files\n\n| File | Purpose |\n|---|---|\n\n## Behavior\n\n_(expand with specific schema, endpoints, state, and interaction details)_\n`;
}

function normalizeTagName(t) {
  return typeof t === 'string' ? t : (t && t.name);
}

// Pure — no I/O. Decides which tt-* tags from this save are worth a KB-doc-link
// attempt, and rules out the cases that would be wasted or unsafe work.
function selectLinkCandidates(tagRegistrations, ttHints, existingTagRows) {
  if (!Array.isArray(tagRegistrations) || tagRegistrations.length === 0) return [];

  // A project with ZERO existing tags (brand-new project, or the very first tt-* tag
  // ever registered) is common and must NOT disable linking — an empty array carries no
  // evidence either way, so it's treated as "assume supported, try it" (a real
  // pre-046 API would just 404 the PUT /link call, caught and skipped downstream like
  // any other failure). Only a NON-empty row set where nothing carries the
  // knowledge_file_key property at all is real evidence the connected API predates
  // migration 046, and skips the whole feature rather than guessing.
  const linkFeatureSupported = existingTagRows.length === 0 || existingTagRows.some(
    (r) => r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'knowledge_file_key'),
  );
  if (!linkFeatureSupported) return [];

  const byName = new Map();
  for (const row of existingTagRows) {
    const name = normalizeTagName(row);
    if (name) byName.set(name, row);
  }
  const fileKeyOwner = new Map(); // fileKey -> tag name that currently owns it
  for (const row of existingTagRows) {
    const name = normalizeTagName(row);
    const fk = row && typeof row === 'object' ? row.knowledge_file_key : null;
    if (name && fk) fileKeyOwner.set(fk, name);
  }

  const out = [];
  const seen = new Set();
  for (const t of tagRegistrations) {
    const name = normalizeTagName(t);
    if (!name || !name.startsWith('tt-') || seen.has(name)) continue;
    seen.add(name);

    const fileKey = archFileKey(name);
    const existing = byName.get(name);
    if (existing && existing.knowledge_file_key === fileKey) continue; // already correct

    const owner = fileKeyOwner.get(fileKey);
    if (owner && owner !== name) continue; // fileKey already linked to a different tag

    out.push({
      tag: name,
      fileKey,
      description: typeof t === 'object' ? t.description : undefined,
      hint: ttHints.get(name),
    });
  }
  return out;
}

// Defense-in-depth against a malformed tag name traversing out of rootPath — same
// check create_system_tag (mcp/server.js) applies before writing a stub.
function resolveContained(rootPath, relPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(rootPath, relPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

// Ensures a local stub exists (writing one only when nothing is there yet) and pushes
// it to the API for each candidate whose doc isn't already linked remotely. Sequential
// by design — knowledge-sync.js's recordPushed() does a read-modify-write on
// .tipatask/knowledge-versions.json; concurrent pushes would drop entries.
//
// buildStub is passed in by the caller (architecture-docs.js's task-derived fallback)
// rather than required here, so this module has no dependency on task shape.
async function prepareTagDocs({ baseUrl, projectId, token, rootPath, candidates, tasks, buildStub }) {
  const linkable = [];
  const skipped = [];
  if (!Array.isArray(candidates) || candidates.length === 0) return { linkable, skipped };

  let remoteKeys;
  try {
    remoteKeys = await fetchRemoteVersions(baseUrl, projectId, token);
  } catch (err) {
    // Whole-batch GET failed — nothing to link this save, self-heals at next Re-Index.
    for (const c of candidates) skipped.push({ tag: c.tag, reason: `remote-check-failed: ${err.message}` });
    return { linkable, skipped };
  }

  for (const c of candidates) {
    try {
      if (Object.prototype.hasOwnProperty.call(remoteKeys, c.fileKey)) {
        // Doc already exists remotely (legacy heal) — link with no local write, no push.
        linkable.push({ tag: c.tag, fileKey: c.fileKey });
        continue;
      }

      const abs = resolveContained(rootPath, c.fileKey);
      if (!abs) { skipped.push({ tag: c.tag, reason: 'path-outside-root' }); continue; }

      let content;
      if (fs.existsSync(abs)) {
        content = fs.readFileSync(abs, 'utf8'); // never overwrite an existing local doc
      } else {
        if (c.hint && c.description) {
          content = buildTagStub(c.tag, c.description, c.hint);
        } else if (typeof buildStub === 'function') {
          content = buildStub(c.tag, tasks || []);
        }
        if (!content) { skipped.push({ tag: c.tag, reason: 'no-stub-source' }); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }

      const localVersion = readEntry(getLocalVersions(rootPath), c.fileKey).version;
      try {
        await pushFile(baseUrl, projectId, token, c.fileKey, content, localVersion, rootPath, {
          timeoutMs: PUSH_TIMEOUT_MS, lockWaitMs: 0, lockTimeoutMs: 5000,
        });
        linkable.push({ tag: c.tag, fileKey: c.fileKey });
      } catch (err) {
        // C1105 — lease held elsewhere: skip, leave version cache stale on purpose so
        // the next bulk sync (pushArchitectureDocs) retries it, same as that function.
        skipped.push({ tag: c.tag, reason: err.lockHeld ? 'lock-held' : `push-failed: ${err.message}` });
      }
    } catch (err) {
      skipped.push({ tag: c.tag, reason: `prep-failed: ${err.message}` });
    }
  }

  return { linkable, skipped };
}

// Per-tag, best-effort PUT /tags/:name/link. Never throws — a link failure must never
// block the save or the tag registration that already happened via POST /tags.
async function linkTagDocs({ baseUrl, projectId, token, linkable }) {
  const linked = [];
  const failed = [];
  if (!Array.isArray(linkable) || linkable.length === 0) return { linked, failed };

  for (const { tag, fileKey } of linkable) {
    try {
      const url = `${baseUrl}/api/projects/${projectId}/tags/${encodeURIComponent(tag)}/link`;
      const { status, data } = await request(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: { file_key: fileKey },
        timeoutMs: LINK_TIMEOUT_MS,
      });
      if (status === 200) linked.push(tag);
      else failed.push({ tag, reason: `HTTP ${status}${data && data.error ? `: ${data.error}` : ''}` });
    } catch (err) {
      failed.push({ tag, reason: err.message });
    }
  }

  return { linked, failed };
}

module.exports = {
  archFileKey,
  buildTagStub,
  selectLinkCandidates,
  prepareTagDocs,
  linkTagDocs,
};
