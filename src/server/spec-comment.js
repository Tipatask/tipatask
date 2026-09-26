'use strict';

// C1159: original-objective spec comment gets reference-only header.
//
// Problem: overwriteRaw() (api-backend.js) posts the FULL objective text as a
// comment_type='spec' comment on every new task from that objective. Executor
// agent reads it (formatTaskCommentsBlock sorts spec first, see base-agent.js)
// and eagerly implements scope belonging to sibling tasks. Fix: wrap spec text
// in a header telling agent to treat it as reference only, own task desc is
// the real scope.
//
// Dependency-free — no require of project-config/config here. Caller resolves
// project language and passes it in.

const SPEC_COMMENT_HEADERS = {
  en: '## Original Objective (reference only)\n\n'
    + 'This is the full objective this task was split from. Implement ONLY the scope in '
    + 'this task\'s own description — do NOT implement other parts of this objective; '
    + 'those are separate tasks.\n\n---\n\n',
  uk: '## Початкова ціль (лише для довідки)\n\n'
    + 'Це повна ціль, з якої було розбито це завдання. Реалізуй ЛИШЕ обсяг роботи, '
    + 'вказаний в описі цього завдання — НЕ реалізовуй інші частини цієї цілі; '
    + 'вони є окремими завданнями.\n\n---\n\n',
};

function specCommentHeader(lang) {
  return SPEC_COMMENT_HEADERS[lang] || SPEC_COMMENT_HEADERS.en;
}

// header + trimmed spec. Idempotent — a spec already starting with a known
// header is returned unchanged (dedup + revision turns can call this more
// than once on the same source text).
function buildSpecCommentBody(spec, lang) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return '';
  const header = specCommentHeader(lang);
  if (trimmed.startsWith(header)) return trimmed;
  for (const h of Object.values(SPEC_COMMENT_HEADERS)) {
    if (trimmed.startsWith(h)) return trimmed;
  }
  return header + trimmed;
}

// Strips any known header, any language — used so the dedup check in
// overwriteRaw() still matches a pre-C1159 raw comment (no header at all)
// and a comment posted under a different project language than the current
// save.
function stripSpecCommentHeader(content) {
  const trimmed = String(content || '').trim();
  for (const h of Object.values(SPEC_COMMENT_HEADERS)) {
    if (trimmed.startsWith(h)) return trimmed.slice(h.length).trim();
  }
  return trimmed;
}

// TPT29: attachment manifest appended to a captured origin spec comment
// (origin-spec-capture.js). H3, so it nests under buildSpecCommentBody()'s own
// H2 header rather than competing with it.
const ATTACHMENT_BLOCK_HEADERS = { en: '### Attachments', uk: '### Вкладення' };

function attachmentBlockHeader(lang) {
  return ATTACHMENT_BLOCK_HEADERS[lang] || ATTACHMENT_BLOCK_HEADERS.en;
}

const MAX_REFS_PER_KIND = 20;

// Every `](target)` markdown link/image destination in text, exact string match —
// deliberately not a substring test, so a ref to /images/12 can't wrongly suppress
// a distinct /images/1 attachment.
function extractRefTargets(text) {
  const targets = new Set();
  const re = /\]\(([^)]+)\)/g;
  let m;
  const str = String(text || '');
  while ((m = re.exec(str))) targets.add(m[1]);
  return targets;
}

function _refLabel(row, kind, index) {
  const raw = String((row && row.filename) || '').replace(/[[\]]/g, '').trim();
  return raw || `${kind}-${(row && row.id) || index + 1}`;
}

function _renderRefs(rows, kind, excludeTargets) {
  const lines = [];
  let shown = 0;
  let skippedByCap = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const url = row && row.url;
    if (!url || excludeTargets.has(url)) continue;
    if (shown >= MAX_REFS_PER_KIND) { skippedByCap++; continue; }
    const label = _refLabel(row, kind, i);
    lines.push(kind === 'image' ? `![${label}](${url})` : `- [${label}](${url})`);
    shown++;
  }
  return { lines, skippedByCap };
}

// Builds a markdown block listing task_images/task_files rows not already referenced
// in `excludeRefsIn` (the preserved title+description text) — the common case, since
// the web composer inlines pasted attachments directly, is that every row is already
// referenced and this returns ''. Never emits a bare heading. Never throws — bad
// input (non-array, null) degrades to '' rather than erroring.
function buildAttachmentRefsBlock(images, files, lang, opts) {
  const excludeTargets = extractRefTargets((opts && opts.excludeRefsIn) || '');
  const imgRows = Array.isArray(images) ? images : [];
  const fileRows = Array.isArray(files) ? files : [];
  const { lines: imgLines, skippedByCap: imgSkipped } = _renderRefs(imgRows, 'image', excludeTargets);
  const { lines: fileLines, skippedByCap: fileSkipped } = _renderRefs(fileRows, 'file', excludeTargets);
  if (imgLines.length === 0 && fileLines.length === 0) return '';
  const parts = [attachmentBlockHeader(lang)];
  if (imgLines.length > 0) {
    parts.push(imgLines.join('\n\n'));
    if (imgSkipped > 0) parts.push(`… and ${imgSkipped} more`);
  }
  if (fileLines.length > 0) {
    parts.push(fileLines.join('\n'));
    if (fileSkipped > 0) parts.push(`… and ${fileSkipped} more`);
  }
  return '\n\n' + parts.join('\n\n');
}

module.exports = {
  specCommentHeader,
  buildSpecCommentBody,
  stripSpecCommentHeader,
  attachmentBlockHeader,
  buildAttachmentRefsBlock,
  SPEC_COMMENT_HEADERS,
  ATTACHMENT_BLOCK_HEADERS,
};
