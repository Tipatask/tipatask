'use strict';

// Before objective adoption overwrites a source task, capture original text
// as a spec comment. Capture is idempotent across retries and fail-open so
// comment failure cannot block task save.

const { buildSpecCommentBody, buildAttachmentRefsBlock } = require('./spec-comment');

// Discriminator. MUST mirror _rawUpdateTask()'s own dual-spelling isObjective read
// (api-backend.js) exactly — both read the same `fields` object; if the two drift, this
// capture silently stops firing on a real adoption. camelCase wins over snake_case on a
// conflict, same precedence as that line.
function isObjectiveClearingPatch(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const isObjective = fields.isObjective !== undefined ? fields.isObjective : fields.is_objective;
  if (isObjective === undefined || !!isObjective) return false;
  return typeof fields.description === 'string';
}

async function _listSafe(backend, method, id) {
  if (typeof backend[method] !== 'function') return [];
  try {
    const rows = await backend[method](id);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// PRE-WRITE. Never throws. Returns null for every update this doesn't apply to.
async function readOriginSpecSnapshot(backend, id, fields) {
  try {
    if (!isObjectiveClearingPatch(fields)) return null;

    const live = await backend.getTask(id);
    // Load-bearing, not defensive: overwriteRaw()'s write loop sends an explicit
    // isObjective:false (via fromApi(), never undefined) on every carried-over
    // NON-objective task in a bulk save too — only a real objective->regular
    // transition on the LIVE row means this is the C1559 adoption.
    if (!live || live.isObjective !== true) return null;

    const origTitle = String(live.title || '').trim();
    const origDescription = String(live.description || '').trim();
    if (!origDescription) return null;

    const incomingTitle = fields.title !== undefined ? String(fields.title || '').trim() : origTitle;
    const incomingDescription = String(fields.description).trim();
    if (origTitle === incomingTitle && origDescription === incomingDescription) return null; // nothing lost

    // Idempotent across revision turns. Fail-open on a read error/_notFound — proceeding
    // risks a duplicate spec comment (harmless, same precedent as overwriteRaw()'s own
    // dedup scan); bailing risks permanently losing the original text, which is worse.
    let existing = null;
    try {
      existing = await backend.getTaskComments(id);
    } catch {
      existing = null;
    }
    if (Array.isArray(existing) && existing.some(c => c && c.comment_type === 'spec')) {
      return null;
    }

    const [images, files] = await Promise.all([
      _listSafe(backend, 'listTaskImages', id),
      _listSafe(backend, 'listTaskFiles', id),
    ]);

    return {
      title: origTitle,
      description: origDescription,
      titleChanged: origTitle !== incomingTitle && !!origTitle,
      images,
      files,
    };
  } catch (err) {
    console.warn(`[origin-spec] snapshot failed for ${id}: ${err.message}`);
    return null;
  }
}

// POST-WRITE — call only after the guarded write has succeeded. Never throws.
async function postOriginSpecComment(backend, id, snapshot, lang) {
  try {
    if (!snapshot) return;
    const spec = snapshot.titleChanged
      ? `### ${snapshot.title}\n\n${snapshot.description}` // mirrors buildObjectiveSeed()'s own seed shape
      : snapshot.description;
    const body = buildSpecCommentBody(spec, lang)
      + buildAttachmentRefsBlock(snapshot.images, snapshot.files, lang, { excludeRefsIn: spec });
    const comment = await backend.createTaskComment(id, body, 'spec');
    if (!comment) console.warn(`[origin-spec] ${id}: task not found, spec comment not posted`);
  } catch (err) {
    console.warn(`[origin-spec] post failed for ${id}: ${err.message}`);
  }
}

module.exports = { isObjectiveClearingPatch, readOriginSpecSnapshot, postOriginSpecComment };
