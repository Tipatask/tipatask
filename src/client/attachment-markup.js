// Attachments in read-only text (TPT9411). Text the Task App shows without editing it — task
// descriptions, comments and chat replies (renderMarkdown(), utils.js), and the user turns of the
// task, project and objective chats (userMessageHtml(), task-chat-model.js) — draws every image
// and file it references with the markup built here, so one reference looks the same everywhere:
// - an image is `span.md-image`, a block: it always starts on a new line, and the text after it
//   goes on the line below (styles.css § Read-only attachments);
// - a file is `a.file-attachment-link`, a chip in the line of text: a file icon and its name.
// The URL decides what a reference is (attachmentFromUrl()): an uploaded image shows as an image,
// an uploaded file or a project artifact revision as a chip, whether it was written as a link or
// as an image. Pure and import-free: utils.js, task-chat-model.js and embed-menu.js import it, and
// so do the tests, under plain node.

// Read the authored href, before the browser resolves it against the Task App's URL. An uploaded
// image or file (absolute API URL, the API's relative path, or the Task App's own proxy path) and
// a pinned artifact revision give `{ href, line }` with `href` the same-origin address; a
// project-relative path gives `{ path, line }` (the chat file viewer opens either); anything else
// gives null. `line` is the source line of a trailing `#L<n>` anchor, else null.
export function fileRefFromHref(href) {
  if (typeof href !== 'string' || !href || /[\x00-\x1f\x7f\\]/.test(href)) return null;
  const lineMatch = /#L([1-9]\d*)$/.exec(href);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  if (line !== null && !Number.isSafeInteger(line)) return null;
  const raw = lineMatch ? href.slice(0, lineMatch.index) : href;
  const attachment = /^(?:https?:\/\/[^/?#\s]+)?\/api\/projects\/(\d+)\/(files|images)\/(\d+)(?:\?[^#]*)?$/i.exec(raw);
  if (attachment) return { href: '/api/' + attachment[2] + '/' + attachment[1] + '/' + attachment[3], line };
  if (/^\/api\/(?:files|images)\/\d+\/\d+$/.test(raw)) return { href: raw, line };
  const artifact = /^(?:https?:\/\/[^/?#\s]+)?(\/api\/projects\/\d+\/files\/artifacts\/\d+\/revisions\/\d+\/content)$/i.exec(raw);
  if (artifact) return { href: artifact[1], line };
  if (/[?#]/.test(raw)) return null;
  let path;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (!path.trim() || /^(?:\/|[a-z][a-z0-9+.-]*:)|[\x00-\x1f\x7f\\]/i.test(path) || path.endsWith('/')) return null;
  const parts = path.split('/');
  if (parts.includes('..')) return null;
  path = parts.filter(part => part && part !== '.').join('/');
  return path ? { path, line } : null;
}

// The attachment a link or image URL names, at its same-origin address, or null for any other
// URL: `{ kind: 'image', src, href }` for an uploaded image; `{ kind: 'file', href, artifact }` for
// an uploaded file (a `#L` line anchor kept on `href`) or a project artifact revision (`artifact`).
export function attachmentFromUrl(url) {
  const ref = fileRefFromHref(url);
  if (!ref || !ref.href) return null;
  const href = ref.href + (ref.line ? `#L${ref.line}` : '');
  if (ref.href.startsWith('/api/images/')) return { kind: 'image', src: ref.href, href };
  return { kind: 'file', href, artifact: ref.href.includes('/files/artifacts/') };
}

// Text and attribute escaping. An entity reference already in the text stays, the way Markdown
// reads one (`&amp;` is one ampersand); every other `&`, and `<`, `>`, `"` and `'`, are escaped.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[<>"']|&(?!#\d{1,7};|#[xX][\da-fA-F]{1,6};|\w+;)/g, ch => ESCAPES[ch]);
}

// An image: a block of its own (`.md-image`), so it starts on a new line wherever its reference
// stood, mid-sentence included. Lazy: a long description or transcript loads what is in view.
export function imageBlockHtml({ src, alt = '', title = '' } = {}) {
  return `<span class="md-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`
    + (title ? ` title="${escapeHtml(title)}"` : '')
    + ' loading="lazy"></span>';
}

// A file: a chip in the line of text, its icon (a package for a project artifact) then its name —
// `nameHtml` when the caller rendered it already (Markdown link text), else the escaped `name`.
// A project artifact downloads in the window that shows it (`download`): its address needs that
// window's project session, which the system browser does not have (file-attach.js).
export function fileChipHtml({ href, name = '', nameHtml, title, artifact = false } = {}) {
  const tip = title === undefined ? name : title;
  return `<a class="file-attachment-link" href="${escapeHtml(href)}"`
    + (tip ? ` title="${escapeHtml(tip)}"` : '')
    + (artifact ? ' download' : '')
    + '><span class="file-attachment-icon"></span>'
    + `<span class="file-attachment-name">${nameHtml === undefined ? escapeHtml(name) : nameHtml}</span></a>`;
}

// An image block is lines of its own: a line break or blanks next to it would only add an empty
// line or an indent (comments and chat turns keep whitespace). Takes the rendered HTML; the
// pattern matches the exact markup imageBlockHtml() writes, attribute values escaped.
const IMAGE_BLOCK_GAPS_RE = /[ \t]*(?:<br>[ \t\n]*)?(<span class="md-image"><img [^>]*><\/span>)(?:[ \t\n]*<br>)?[ \t]*/g;
export function tidyImageBlocks(html) {
  return String(html ?? '').replace(IMAGE_BLOCK_GAPS_RE, '$1');
}
