'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

// Shared storage-location resolver for materialized task attachments (images, generic
// files). Both localizers (task-agent/image-attach.js, task-agent/file-attach.js) and the
// terminal paste-image path (terminal-session.js saveBase64Image) go through this so the
// "where do attachments live" decision is made in exactly one place.
//
// Preferred location is inside the project working tree — <projectRoot>/.tipatask/<kind>/<id>/
// — so a coding agent's own filesystem tools (which are sandboxed/permission-gated to the
// project root by Claude/Codex/Pi alike) can actually read what got downloaded. This only
// applies when the project is already configured (<projectRoot>/.tipatask/config.json
// exists) — never materialize .tipatask/ in an unconfigured root (same invariant
// project-config.js's recordLastUsedAgent() documents at its own call site). Falls back to
// config.USER_DATA_ROOT/.task-<kind>/<id>/ (the pre-C1247 location) when there is no usable
// project root, e.g. a project-less session or one whose config.json vanished mid-run.

const KIND_LEGACY_DIR = {
  images: '.task-images',
  files: '.task-files',
};

// Directory *segments* here are task keys / tab ids, not user-authored strings, but
// specChat:C123-style ids contain a colon and objective-chat ids are otherwise free-form —
// sanitize before it becomes a path component so nothing this module writes can escape its
// own directory or fail on a platform that rejects colons in filenames.
function safeSegment(id) {
  const s = String(id == null ? 'unknown' : id).trim();
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'unknown';
}

// Best-effort — a missing .gitignore must never block a download. Only seeds it, never
// overwrites an existing one (a user could plausibly hand-edit it).
function seedGitignore(dirPath) {
  const gitignorePath = path.join(dirPath, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, '*\n', 'utf8');
  } catch { /* non-fatal — the root .gitignore / installer backfill still cover this */ }
}

function hasProjectConfig(projectRoot) {
  if (!projectRoot) return false;
  try {
    return fs.existsSync(path.join(projectRoot, '.tipatask', 'config.json'));
  } catch {
    return false;
  }
}

// resolveAttachmentDir('images'|'files', projectRoot, id) → absolute dir path, created.
function resolveAttachmentDir(kind, projectRoot, id) {
  const seg = safeSegment(id);
  const inProject = hasProjectConfig(projectRoot);
  const dir = inProject
    ? path.join(projectRoot, '.tipatask', kind, seg)
    : path.join(config.USER_DATA_ROOT, KIND_LEGACY_DIR[kind] || `.task-${kind}`, seg);
  fs.mkdirSync(dir, { recursive: true });
  seedGitignore(path.dirname(dir)); // <root>/.tipatask/<kind>/.gitignore — one per kind, not per task
  return dir;
}

module.exports = { resolveAttachmentDir, safeSegment };
