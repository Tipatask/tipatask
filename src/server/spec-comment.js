'use strict';

// Original-objective spec comments define whether the objective is reference
// for sibling tasks or the binding full spec for a sole task. Executors read
// spec comments first (formatTaskCommentsBlock in base-agent.js).
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

const SOLE_TASK_SPEC_COMMENT_HEADERS = {
  en: '## Original Objective (full specification)\n\n'
    + 'This task covers the whole objective below. Treat every link, image, copy line '
    + 'and data hint in it as binding requirements, including details omitted from '
    + 'this task\'s description.\n\n---\n\n',
  uk: '## Початкова ціль (повна специфікація)\n\n'
    + 'Це завдання охоплює всю ціль нижче. Вважай кожне посилання, зображення, рядок тексту '
    + 'та підказку щодо даних у ній обов\'язковими вимогами, включно з деталями, '
    + 'пропущеними в описі цього завдання.\n\n---\n\n',
};

const ALL_SPEC_COMMENT_HEADERS = [
  ...Object.values(SPEC_COMMENT_HEADERS),
  ...Object.values(SOLE_TASK_SPEC_COMMENT_HEADERS),
];

function specCommentHeader(lang, opts) {
  const headers = opts && opts.soleTask ? SOLE_TASK_SPEC_COMMENT_HEADERS : SPEC_COMMENT_HEADERS;
  return headers[lang] || headers.en;
}

// header + trimmed spec. Idempotent — a spec already starting with a known
// header is returned unchanged (dedup + revision turns can call this more
// than once on the same source text).
function buildSpecCommentBody(spec, lang, opts) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return '';
  const header = specCommentHeader(lang, opts);
  for (const h of ALL_SPEC_COMMENT_HEADERS) {
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
  for (const h of ALL_SPEC_COMMENT_HEADERS) {
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

// Keep images whole (including relative attachment URLs), without emitting their
// embedded HTTP URL a second time. Bare URLs may end in prose/Markdown punctuation.
function extractSourceRefs(text) {
  const refs = [];
  const re = /!\[[^\]\r\n]*\]\((?:[^()\r\n]|\([^()\r\n]*\))+\)|https?:\/\/[^\s<>"'`]+/gi;
  for (const match of String(text || '').matchAll(re)) {
    let ref = match[0];
    if (!ref.startsWith('![')) {
      ref = ref.replace(/[.,;:!?]+$/, '');
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (ref.endsWith(close) && ref.split(close).length > ref.split(open).length) {
          ref = ref.slice(0, -1);
        }
      }
      ref = ref.replace(/[.,;:!?]+$/, '');
    }
    refs.push(ref);
  }
  return refs;
}

function sourceRefTarget(ref) {
  const image = /^!\[[\s\S]*?\]\(\s*(?:<([^>]+)>|(\S+?))(?:\s+["'][\s\S]*["'])?\s*\)$/.exec(ref);
  return image ? (image[1] || image[2]) : ref;
}

// Only restore sources absent from every proposed description. Compare whole
// destinations, so /images/12 or a different Figma node cannot hide /images/1.
function missingSourceRefsBlock(objectiveText, descriptions, lang) {
  const texts = (Array.isArray(descriptions) ? descriptions : [descriptions]).map(text => String(text || ''));
  const present = new Set(texts.flatMap(text => [
    ...extractRefTargets(text),
    ...extractSourceRefs(text).map(sourceRefTarget),
  ]));
  const missing = [...new Set(extractSourceRefs(objectiveText))]
    .filter(ref => !present.has(sourceRefTarget(ref)));
  if (!missing.length) return '';
  const heading = lang === 'uk' ? '### Джерельні матеріали' : '### Source material';
  return '\n\n' + heading + '\n\n' + missing.map(ref => `- ${ref}`).join('\n');
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
  extractSourceRefs,
  missingSourceRefsBlock,
  SPEC_COMMENT_HEADERS,
  ATTACHMENT_BLOCK_HEADERS,
};
