// ── File control ──
// The File dropdown (Image / Other file), its two hidden pickers and file drop, shared by every
// host that takes attachments into a textarea: the objective chat composer (chat-ui.js), the task /
// project chat composer (task-chat.js) and the descriptions in New Task and Task Edit.
// Uploads always go through the one upload path each kind already has —
// images through task-board.js (`uploadImageFile`, a `![img](blob:…)` placeholder swapped for the
// real URL once the board socket answers), other files through file-attach.js
// (`uploadAttachmentFile`, a `[name](url)` link) — so a host only says which textarea receives the
// reference. The board hands its image upload to this module (configureEmbedUploads()) instead of
// being imported here: an import would pull the board into every host's bundle, and the Task Edit
// modal must load without it.
// (TPT9410) The same hosts show what their text holds in an attachment strip under the textarea
// (renderAttachmentStrip()), whose tile lights up while the pointer is over its reference in the
// text (syncStripHover()).
import { t } from './i18n.js';
import { FILE_ACCEPT, uploadAttachmentFile } from './file-attach.js';
import { escapeAttr, insertAtCursor, showToast } from './utils.js';
import { api } from './api-client.js';
import { fileRefFromHref } from './task-chat-model.js';

// (TPT280) Shared 12px chevron caret for the composer's File and Import dropdown triggers —
// one svg (not a text glyph) so both carets render at an identical size on every platform font.
export const DROPDOWN_CARET_SVG = '<svg class="embed-menu-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const PAPERCLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

// Match the raster formats in api/src/lib/task-image-types.js.
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'],
]);
const IMAGE_MIMES = new Set(IMAGE_MIME_BY_EXTENSION.values());
const IMAGE_ACCEPT = [...IMAGE_MIMES, ...IMAGE_MIME_BY_EXTENSION.keys()].join(',');

function imageMimeFromName(file) {
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? IMAGE_MIME_BY_EXTENSION.get(name.slice(dot).toLowerCase()) : undefined;
}

// task-board.js uploadImageFile(file, textarea, wsClient, opts), handed over once by the board.
let uploadImageFile = null;

export function configureEmbedUploads({ uploadImage } = {}) {
  uploadImageFile = typeof uploadImage === 'function' ? uploadImage : null;
}

// (C1241) Paperclip + label trigger opening a dropdown with Image / Other file rows, each backed
// by its own hidden picker — (TPT9361) one that takes several files at once; each goes through its
// own upload. Ids are optional: the objective chat keeps its historic ids
// (#btn-obj-img-upload, #obj-img-file-input, #obj-file-input) for its tooltip and disabled-state
// wiring; other hosts find the parts by class inside the wrap. `title` is the trigger's tooltip.
export function embedMenuHtml({ label = t('nav.embed'), disabled = false, triggerId = '', imageInputId = '', fileInputId = '', title = '' } = {}) {
  const id = value => (value ? ` id="${escapeAttr(value)}"` : '');
  return `
    <div class="embed-menu-wrap">
      <input type="file" class="embed-image-input"${id(imageInputId)} accept="${IMAGE_ACCEPT}" multiple style="display:none">
      <input type="file" class="embed-file-input"${id(fileInputId)} accept="${FILE_ACCEPT}" multiple style="display:none">
      <button class="embed-menu-trigger"${id(triggerId)} type="button" aria-haspopup="true" aria-expanded="false"${title ? ` title="${escapeAttr(title)}"` : ''}${disabled ? ' disabled' : ''}>
        ${PAPERCLIP_SVG}
        <span class="embed-menu-label">${escapeAttr(label)}</span>
        ${DROPDOWN_CARET_SVG}
      </button>
    </div>`;
}

// (C1241 fix, C1248) Teardown of the one open menu: the panel, the trigger's expanded state and
// the document-level outside-click / key listeners. Every close path goes through it, and a host
// re-render or teardown calls closeOpenEmbedMenu() so those listeners never outlive the DOM they
// were attached for.
let openMenuState = null;

export function closeOpenEmbedMenu({ detachedOnly = false } = {}) {
  if (!openMenuState || (detachedOnly && openMenuState.trigger.isConnected)) return;
  const { cleanup } = openMenuState;
  openMenuState = null;
  cleanup();
}

// (TPT9346) Where a reference goes in. A host passes the textarea, or a function returning it when
// the reference is inserted — for a host whose textarea comes and goes, like the Task Edit
// description editor. That moment is the pick or drop for an image (its placeholder goes in
// first), and the end of the upload for any other file. Null: there is nowhere to put it any more,
// and the reference is dropped.
function resolveTextarea(target) {
  return typeof target === 'function' ? target() : target;
}

function uploadImage(file, target, imageOpts) {
  const mime = IMAGE_MIMES.has(file.type) ? file.type : imageMimeFromName(file);
  if (!mime) {
    showToast(t('toast.fileTypeUnsupported'), 'error');
    return;
  }
  if (!uploadImageFile) {
    console.error('[embed-menu] no image upload configured (task-board.js configureEmbedUploads)');
    return;
  }
  const textarea = resolveTextarea(target);
  if (textarea) {
    const image = file.type === mime ? file : new File([file], file.name, { type: mime });
    uploadImageFile(image, textarea, null, imageOpts);
  }
}

function uploadFile(file, target, fileOpts, onFileUpload) {
  const upload = uploadAttachmentFile(file, target, fileOpts);
  if (typeof onFileUpload === 'function') onFileUpload(upload, file);
}

// Images to the image upload, everything else to the file upload. `imageOpts` is passed to
// uploadImageFile() as is (taskKey, onFileDetected, onUploaded, onUploadError), `fileOpts` to
// uploadAttachmentFile() (taskKey); `onFileUpload` receives the promise of each file upload, so a
// host can tell when it has settled.
export function uploadComposerFiles(files, target, { imageOpts = {}, fileOpts = {}, onFileUpload } = {}) {
  for (const file of Array.from(files || [])) {
    if (!file) continue;
    if (file.type?.startsWith('image/') || imageMimeFromName(file)) uploadImage(file, target, imageOpts);
    else uploadFile(file, target, fileOpts, onFileUpload);
  }
}

// Fixed placement for a menu moved to <body> (`portal`): under the trigger, right edges aligned,
// or above it when the viewport has more room there; kept 8px inside the viewport.
function placeMenu(menu, trigger) {
  const r = trigger.getBoundingClientRect();
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - margin;
  const above = r.top - margin;
  const top = height + 4 <= below || below >= above ? r.bottom + 4 : r.top - 4 - height;
  menu.style.top = `${Math.round(Math.max(margin, Math.min(top, window.innerHeight - height - margin)))}px`;
  menu.style.left = `${Math.round(Math.max(margin, Math.min(r.right - width, window.innerWidth - width - margin)))}px`;
}

let _menuSeq = 0;

// Wire one embedMenuHtml() wrap to `target` (see resolveTextarea()). Options:
// - imageOpts / fileOpts / onFileUpload — as for uploadComposerFiles().
// - labels — the two rows' text and the file row's tooltip (functions, so a language switch is
//   picked up the next time it opens).
// - portal — the open menu moves to <body> at a fixed position, for a host whose layout would
//   clip it (data-portaled="1", which dialog-focus.js layers and Task Edit's cleanup know).
// - keepFocus — pressing the trigger or a row leaves the focus where it is, so an open editor
//   keeps it (and its caret) while the menu is used.
// - onPickerOpen / onPickerClose — around each native file dialog: some engines blur the focused
//   field while it is up.
// The menu opened from the keyboard takes focus on its first row: arrows move between rows, Enter
// or Space picks one, Tab leaves it, Escape closes it.
export function attachEmbedMenu(wrap, target, {
  imageOpts = {}, fileOpts = {}, onFileUpload, labels = {}, portal = false, keepFocus = false, onPickerOpen, onPickerClose,
} = {}) {
  const trigger = wrap && wrap.querySelector('.embed-menu-trigger');
  const imageInput = wrap && wrap.querySelector('.embed-image-input');
  const fileInput = wrap && wrap.querySelector('.embed-file-input');
  if (!trigger || !imageInput || !target) return;
  const label = (key, fallback) => (typeof labels[key] === 'function' ? labels[key]() : t(fallback));

  // Opens a hidden picker and reports when its dialog is gone: a pick (`change`), a dismissal
  // (`cancel`), or — on engines without `cancel` — the window getting focus back.
  let pickerClosed = null;
  const openPicker = (input) => {
    if (!input) return;
    pickerClosed?.();
    let open = true;
    const onWindowFocus = () => setTimeout(done, 300);
    function done() {
      if (!open) return;
      open = false;
      if (pickerClosed === done) pickerClosed = null;
      input.removeEventListener('cancel', done);
      window.removeEventListener('focus', onWindowFocus);
      if (typeof onPickerClose === 'function') onPickerClose();
    }
    pickerClosed = done;
    input.addEventListener('cancel', done);
    window.addEventListener('focus', onWindowFocus);
    if (typeof onPickerOpen === 'function') onPickerOpen();
    input.click();
  };

  const openMenu = ({ fromKeyboard = false } = {}) => {
    closeOpenEmbedMenu();
    const returnFocus = document.activeElement;
    const menu = document.createElement('div');
    menu.className = portal ? 'import-submenu import-submenu--portal' : 'import-submenu import-submenu--up';
    menu.id = `embed-menu-${++_menuSeq}`;
    menu.setAttribute('role', 'menu');
    if (portal) menu.dataset.portaled = '1';

    const addRow = (text, title, action) => {
      const row = document.createElement('div');
      row.className = 'import-submenu-item';
      row.setAttribute('role', 'menuitem');
      row.tabIndex = -1;
      row.textContent = text;
      if (title) row.title = title;
      if (keepFocus) row.addEventListener('mousedown', e => e.preventDefault());
      row.addEventListener('click', event => { event.stopPropagation(); action(); });
      menu.appendChild(row);
      return row;
    };
    const pickFile = input => () => { closeOpenEmbedMenu(); openPicker(input); };
    addRow(label('image', 'embed.image'), '', pickFile(imageInput));
    addRow(label('file', 'embed.otherFile'), label('fileTitle', 'tooltip.embedFile'), pickFile(fileInput));
    addRow(t('embed.artifact'), '', () => showArtifacts());

    // Fetch metadata only. Each choice inserts a project-relative immutable link, so
    // canceling a description edit or chat draft never creates an input assignment.
    async function showArtifacts(before = null) {
      const moveFocus = menu.contains(document.activeElement);
      const previousCount = before == null ? 0 : menu.children.length - 1;
      if (before == null) menu.replaceChildren();
      else menu.lastElementChild?.remove(); // the More or Retry row
      menu.classList.add('artifact-menu');
      const status = document.createElement('div');
      status.className = 'import-submenu-item loading';
      status.setAttribute('role', 'status');
      status.textContent = t('common.loading');
      status.tabIndex = -1;
      menu.appendChild(status);
      if (moveFocus) status.focus();
      if (portal) place();
      try {
        const page = await api.artifacts.list(before);
        if (!menu.isConnected) return;
        status.remove();
        for (const entry of page.revisions) {
          const row = addRow(entry.filename, '', () => {
            closeOpenEmbedMenu();
            const textarea = resolveTextarea(target);
            if (!textarea) return;
            const name = entry.filename.replace(/[\\[\]]/g, '\\$&');
            insertAtCursor(textarea, `[${name} · r${entry.revision}](${entry.url})`);
          });
          const metadata = document.createElement('small');
          metadata.textContent = `#${entry.artifact_id} · r${entry.revision} ${entry.revision_name} · ${entry.mime_type} · ${new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'unit', unit: 'byte', unitDisplay: 'narrow' }).format(entry.size_bytes)}`;
          row.appendChild(metadata);
        }
        if (page.next) addRow(t('embed.moreRevisions'), '', () => showArtifacts(page.next));
        if (!menu.children.length) {
          status.textContent = t('embed.noArtifacts');
          menu.appendChild(status);
        }
      } catch {
        if (!menu.isConnected) return;
        status.remove();
        addRow(t('embed.artifactRetry'), '', () => showArtifacts(before));
      }
      if (portal) place();
      if (moveFocus) (menu.children[previousCount] || trigger).focus();
    }

    (portal ? document.body : wrap).appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', menu.id);
    const place = () => placeMenu(menu, trigger);
    if (portal) place();
    if (fromKeyboard) menu.firstElementChild.focus();

    const onOutsideClick = (ev) => { if (!wrap.contains(ev.target) && !menu.contains(ev.target)) closeOpenEmbedMenu(); };
    // Window capture: ahead of every document-level handler — dialog-focus.js's Tab trap, a
    // host's own Escape (closing the chat window or the task workspace around it).
    const onKeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeOpenEmbedMenu();
        const back = returnFocus && returnFocus !== document.body && returnFocus.isConnected ? returnFocus : trigger;
        back.focus({ preventScroll: true });
        return;
      }
      const rows = [...menu.querySelectorAll('[role="menuitem"]')];
      const at = rows.indexOf(document.activeElement);
      if (ev.key === 'Tab' && menu.contains(document.activeElement)) {
        // Back on the trigger, the key moves on from there.
        closeOpenEmbedMenu();
        trigger.focus({ preventScroll: true });
        return;
      }
      if (at < 0) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        rows[at].click();
        return;
      }
      const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[ev.key];
      if (next === undefined) return;
      ev.preventDefault();
      rows[(next + rows.length) % rows.length].focus();
    };
    const timer = setTimeout(() => {
      // A rapid open→close (toggle re-click) can run before this deferred attach fires.
      if (!menu.isConnected) return;
      document.addEventListener('click', onOutsideClick);
    }, 0);
    window.addEventListener('keydown', onKeydown, true);
    if (portal) {
      window.addEventListener('resize', place);
      document.addEventListener('scroll', place, true);
    }
    const cleanup = () => {
      clearTimeout(timer);
      // A row holding the focus hands it back before it goes, never to <body>.
      if (menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      menu.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      document.removeEventListener('click', onOutsideClick);
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
    openMenuState = { trigger, cleanup };
  };

  if (keepFocus) trigger.addEventListener('mousedown', e => e.preventDefault());
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (trigger.getAttribute('aria-expanded') === 'true') { closeOpenEmbedMenu(); return; }
    // detail 0: Enter or Space on the trigger rather than a pointer click.
    openMenu({ fromKeyboard: e.detail === 0 });
  });
  imageInput.addEventListener('change', () => {
    pickerClosed?.();
    const files = Array.from(imageInput.files || []);
    imageInput.value = ''; // reset so the same file can be picked again
    files.forEach(file => uploadImage(file, target, imageOpts));
  });
  // (C1246) "Other file": uploadAttachmentFile does its own checks, read, upload and link insert.
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      pickerClosed?.();
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const file of files) uploadFile(file, target, fileOpts, onFileUpload);
    });
  }
}

// Files dragged onto `zone` upload into `target` (uploadComposerFiles). Only a drag that carries
// files is taken over — dragged text still drops into a textarea as usual. `activeClass` marks
// `zone` while files are held over it.
export function attachFileDrop(zone, target, { imageOpts = {}, fileOpts = {}, onFileUpload, activeClass = 'img-drop-active' } = {}) {
  if (!zone || !target) return;
  const hasFiles = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  let depth = 0;
  const reset = () => { depth = 0; zone.classList.remove(activeClass); };
  zone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add(activeClass);
  });
  zone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove(activeClass);
  });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    reset();
    uploadComposerFiles(e.dataTransfer.files, target, { imageOpts, fileOpts, onFileUpload });
  });
}

// ── Attachment strip (TPT9410) ──
// Under a textarea that takes attachments, while it is edited: a thumbnail for every image its text
// references and a chip for every other file (an uploaded file, a project artifact revision). The
// strip is the text's own reading, never an upload's bookkeeping, so a paste, a drop, a File pick,
// typing, undo and a restored draft all show the same way, and a reference deleted from the text
// takes its tile with it. A tile's × takes its reference out of the text (the browser's undo brings
// it back); a click on a tile selects its reference in the text.

// A Markdown link or image, `[label](url)` / `![label](url)`. The label may carry `\]` escapes (the
// artifact rows escape brackets in file names); a link title is allowed and ignored.
const STRIP_REF_RE = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
// A Trello card's image loaded into the objective composer (task-board.js trelloImageProxyUrl()).
const TRELLO_IMAGE_RE = /^\/api\/trello\/image-proxy\?url=[^\s#]+$/;
// The artifact picker's label: `<file name> · r<revision>`.
const ARTIFACT_LABEL_RE = /^(.*\S)\s+·\s+r(\d+)$/;

// This page's own `blob:` URL — the placeholder of an image still uploading (task-board.js
// uploadImageFile()). Another origin's blob URL is not an attachment of this text.
function isOwnBlobUrl(url, origin) {
  if (!origin || !/^blob:/i.test(url)) return false;
  try { return new URL(url.slice(5)).origin === origin; } catch { return false; }
}

// The attachments `text` references, in the order they first appear there:
// `{ key, kind, name, src, href, pending, artifact, revision, ranges }`. `kind` is 'image' (an
// uploaded image, a Trello card's image, or — `pending` — the placeholder of an image still
// uploading) or 'file' (an uploaded file, or a project artifact revision — `artifact`, its
// `revision` read from the picker's label). `key` is the attachment's address, the same-origin one
// for an upload, so every reference to one attachment is one entry; `ranges` holds the
// [start, end) offsets of each. `name` is the label as written (none for a pasted image's `img`).
// Other links — web pages, project paths — are not attachments.
export function attachmentRefs(text, { origin = globalThis.location?.origin } = {}) {
  const source = typeof text === 'string' ? text : '';
  if (!source.includes('](')) return [];
  const byKey = new Map();
  for (const match of source.matchAll(STRIP_REF_RE)) {
    const [whole, bang, rawLabel, url] = match;
    const label = rawLabel.replace(/\\(.)/g, '$1').trim();
    let entry = null;
    if (bang && isOwnBlobUrl(url, origin)) {
      entry = { key: url, kind: 'image', src: url, pending: true };
    } else if (bang && TRELLO_IMAGE_RE.test(url)) {
      entry = { key: url, kind: 'image', src: url };
    } else {
      const ref = fileRefFromHref(url);
      if (ref?.href?.startsWith('/api/images/')) {
        entry = { key: ref.href, kind: 'image', src: ref.href };
      } else if (ref?.href) {
        const artifact = ref.href.includes('/files/artifacts/');
        const named = artifact ? ARTIFACT_LABEL_RE.exec(label) : null;
        entry = {
          key: ref.href, kind: 'file', href: ref.href, artifact,
          name: named ? named[1] : label, revision: named ? Number(named[2]) : null,
        };
      }
    }
    if (!entry) continue;
    const range = [match.index, match.index + whole.length];
    const known = byKey.get(entry.key);
    if (known) {
      known.ranges.push(range);
      continue;
    }
    const name = entry.kind === 'image' ? (label === 'img' ? '' : label) : entry.name;
    byKey.set(entry.key, { pending: false, artifact: false, revision: null, ...entry, name, ranges: [range] });
  }
  return [...byKey.values()];
}

// The span a reference takes out of `text`: alone on its line it takes the line break too, between
// words one of the spaces around it — so no blank line or double space is left where it was.
function removalSpan(text, start, end) {
  const lineStart = start === 0 || text[start - 1] === '\n';
  const lineEnd = end === text.length || text[end] === '\n';
  if (lineStart && lineEnd) {
    if (end < text.length) return [start, end + 1];
    return start > 0 ? [start - 1, end] : [start, end];
  }
  if (text[start - 1] === ' ' && (lineEnd || text[end] === ' ')) return [start - 1, end];
  if (lineStart && text[end] === ' ') return [start, end + 1];
  return [start, end];
}

// `text` with the references at `ranges` taken out (removalSpan()): `{ text, spans, map }`, where
// `spans` are the [start, end) spans removed, in order, and `map(offset)` is where an offset in the
// old text lands in the new one — an offset inside a removed span lands where that span was.
export function textWithoutRanges(text, ranges) {
  const source = typeof text === 'string' ? text : '';
  const spans = [];
  for (const [start, end] of [...(ranges || [])].sort((a, b) => a[0] - b[0])) {
    const span = removalSpan(source, start, end);
    const last = spans[spans.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else spans.push(span);
  }
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    out += source.slice(at, start);
    at = end;
  }
  out += source.slice(at);
  const map = (offset) => {
    let removed = 0;
    for (const [start, end] of spans) {
      if (offset <= start) break;
      if (offset < end) return start - removed;
      removed += end - start;
    }
    return offset - removed;
  };
  return { text: out, spans, map };
}

const _strips = new WeakMap();

const STRIP_REMOVE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
const STRIP_FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const STRIP_ARTIFACT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/></svg>';
const STRIP_IMAGE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

// Mount the attachment strip of `textarea` on the first call, bring it up to date on every later
// one, and return it. It goes right after the textarea — after the mic wrap attachAudioRecorder()
// put the textarea in, when that is its parent — or at the end of `container`. It follows the text
// by itself on every `input` event and when the field takes focus; a host that writes the value
// without an `input` event (clearing it after a send) calls this again. Hidden while the text
// references nothing; the × buttons go while the field is disabled or read-only.
export function renderAttachmentStrip(textarea, { container = null } = {}) {
  if (!textarea?.ownerDocument) return null;
  let st = _strips.get(textarea);
  if (!st) {
    st = createStrip(textarea);
    _strips.set(textarea, st);
  }
  if (container) {
    if (st.strip.parentNode !== container) container.appendChild(st.strip);
  } else if (!st.strip.parentNode) {
    const wrap = textarea.parentElement?.classList.contains('audio-rec-wrap') ? textarea.parentElement : null;
    const box = wrap || textarea;
    box.parentNode?.insertBefore(st.strip, box.nextSibling);
  }
  reconcileStrip(st);
  return st.strip;
}

function createStrip(textarea) {
  const strip = textarea.ownerDocument.createElement('div');
  strip.className = 'attachment-strip';
  strip.setAttribute('role', 'list');
  strip.hidden = true;
  const st = { textarea, strip, tiles: new Map(), entries: [], value: null, hoverKey: null, pointer: null, frame: 0, layout: null };
  textarea.addEventListener('input', () => reconcileStrip(st));
  textarea.addEventListener('focus', () => { if (textarea.value !== st.value) reconcileStrip(st); });
  textarea.addEventListener('mousemove', (e) => {
    st.pointer = { clientX: e.clientX, clientY: e.clientY };
    scheduleStripHover(st);
  });
  textarea.addEventListener('mouseleave', () => syncStripHover(textarea, null));
  textarea.addEventListener('scroll', () => { if (st.pointer) scheduleStripHover(st); });
  return st;
}

function reconcileStrip(st) {
  const { textarea, strip } = st;
  st.value = textarea.value || '';
  st.entries = attachmentRefs(st.value);
  const wanted = new Set(st.entries.map(entry => entry.key));
  const left = [];
  for (const [key, tile] of st.tiles) {
    if (wanted.has(key)) continue;
    st.tiles.delete(key);
    left.push(tile);
  }
  let previous = null;
  for (const entry of st.entries) {
    let tile = st.tiles.get(entry.key);
    if (!tile && entry.kind === 'image') {
      // An upload that just landed: its URL took the placeholder's place in the text, and the
      // placeholder's tile carries on with the picture it already shows.
      const start = String(entry.ranges[0][0]);
      const at = left.findIndex(old => old.classList.contains('attachment-tile--pending') && old.dataset.start === start);
      if (at >= 0) [tile] = left.splice(at, 1);
    }
    if (!tile) tile = createTile(st, entry);
    st.tiles.set(entry.key, tile);
    updateTile(tile, entry);
    const slot = previous ? previous.nextSibling : strip.firstChild;
    if (slot !== tile) strip.insertBefore(tile, slot);
    previous = tile;
  }
  for (const tile of left) tile.remove();
  strip.hidden = !st.entries.length;
  strip.setAttribute('aria-label', t('embed.strip.label'));
  strip.classList.toggle('attachment-strip--locked', !!(textarea.disabled || textarea.readOnly));
  if (st.hoverKey && !wanted.has(st.hoverKey)) st.hoverKey = null;
  for (const [key, tile] of st.tiles) tile.classList.toggle('attachment-tile--hover', key === st.hoverKey);
  if (st.pointer) scheduleStripHover(st);
}

function stripTileLabel(entry) {
  return entry.name || t(entry.kind === 'image' ? 'embed.image' : 'embed.strip.file');
}

function stripFileKind(entry) {
  if (entry.artifact) return entry.revision ? `${t('embed.artifact')} · r${entry.revision}` : t('embed.artifact');
  const extension = /\.([a-z0-9]{1,10})$/i.exec(entry.name || '');
  return extension ? extension[1].toUpperCase() : t('embed.strip.file');
}

function createTile(st, entry) {
  const doc = st.textarea.ownerDocument;
  const tile = doc.createElement('div');
  tile.setAttribute('role', 'listitem');
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'attachment-tile-remove';
  remove.innerHTML = STRIP_REMOVE_SVG;
  if (entry.kind === 'image') {
    tile.className = 'attachment-tile attachment-tile--image';
    const img = doc.createElement('img');
    img.className = 'attachment-tile-thumb';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('load', () => tile.classList.remove('attachment-tile--broken'));
    img.addEventListener('error', () => tile.classList.add('attachment-tile--broken'));
    const fallback = doc.createElement('span');
    fallback.className = 'attachment-tile-fallback';
    fallback.innerHTML = STRIP_IMAGE_SVG;
    tile.append(img, fallback, remove);
  } else {
    tile.className = 'attachment-tile attachment-tile--file';
    const icon = doc.createElement('span');
    icon.className = 'attachment-tile-icon';
    icon.innerHTML = entry.artifact ? STRIP_ARTIFACT_SVG : STRIP_FILE_SVG;
    const text = doc.createElement('span');
    text.className = 'attachment-tile-text';
    const name = doc.createElement('span');
    name.className = 'attachment-tile-name';
    const kind = doc.createElement('span');
    kind.className = 'attachment-tile-kind';
    text.append(name, kind);
    tile.append(icon, text, remove);
  }
  // Pressing a tile or its × leaves the focus where it is, so an open editor keeps its caret.
  tile.addEventListener('mousedown', e => e.preventDefault());
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeStripAttachment(st, tile.dataset.key, remove);
  });
  tile.addEventListener('click', () => selectStripAttachment(st, tile.dataset.key));
  return tile;
}

function updateTile(tile, entry) {
  tile.dataset.key = entry.key;
  tile.dataset.start = String(entry.ranges[0][0]);
  tile.classList.toggle('attachment-tile--pending', !!entry.pending);
  const label = stripTileLabel(entry);
  const remove = tile.querySelector('.attachment-tile-remove');
  remove.setAttribute('aria-label', t('embed.strip.remove', { name: label }));
  remove.title = t('embed.strip.remove', { name: label });
  if (entry.kind === 'image') {
    const title = entry.pending ? t('embed.strip.uploading', { name: label }) : label;
    tile.title = title;
    tile.setAttribute('aria-label', title);
    setStripThumb(tile.querySelector('.attachment-tile-thumb'), entry.src);
    return;
  }
  tile.title = entry.revision ? `${label} · r${entry.revision}` : label;
  tile.querySelector('.attachment-tile-name').textContent = label;
  tile.querySelector('.attachment-tile-kind').textContent = stripFileKind(entry);
}

// A new address for a thumbnail loads beside it and replaces it once loaded (or failed): a tile
// goes from its upload placeholder to the uploaded image without showing empty in between.
function setStripThumb(img, src) {
  if (!img || img.dataset.src === src) return;
  img.dataset.src = src;
  if (!img.getAttribute('src')) {
    img.src = src;
    return;
  }
  const next = img.ownerDocument.createElement('img');
  const swap = () => { if (img.dataset.src === src) img.src = src; };
  next.addEventListener('load', swap, { once: true });
  next.addEventListener('error', swap, { once: true });
  next.src = src;
}

// × on a tile: its reference leaves the text — every occurrence — as an edit of the field's own.
// From the keyboard the focus moves on to the next tile's × (the previous one after the last, the
// field after the only one) before the tile goes, so it never falls back to the page.
function removeStripAttachment(st, key, button) {
  const { textarea } = st;
  if (textarea.disabled || textarea.readOnly) return;
  const entry = attachmentRefs(textarea.value).find(ref => ref.key === key);
  if (!entry) {
    reconcileStrip(st);
    return;
  }
  if (textarea.ownerDocument.activeElement === button) {
    const keys = [...st.tiles.keys()];
    const others = keys.filter(other => other !== key);
    const neighbour = others[Math.min(Math.max(keys.indexOf(key), 0), others.length - 1)];
    const next = neighbour ? st.tiles.get(neighbour).querySelector('.attachment-tile-remove') : textarea;
    next.focus({ preventScroll: true });
  }
  editOutRanges(textarea, entry.ranges);
  if (textarea.value !== st.value) reconcileStrip(st);
}

// The references at `ranges` go out of the field's text through the browser's own delete, so its
// undo brings them back; a plain value write (with an `input` event) is the fallback where that is
// not available. The caret stays on the text it was on, and the focus where it was.
function editOutRanges(textarea, ranges) {
  const doc = textarea.ownerDocument;
  const before = textarea.value;
  const { text, spans, map } = textWithoutRanges(before, ranges);
  if (text === before) return;
  const { selectionStart, selectionEnd, selectionDirection } = textarea;
  const active = doc.activeElement;
  let edited = false;
  if (typeof doc.execCommand === 'function') {
    try {
      if (active !== textarea) textarea.focus({ preventScroll: true });
      if (doc.activeElement === textarea) {
        for (let i = spans.length - 1; i >= 0; i--) {
          textarea.setSelectionRange(spans[i][0], spans[i][1]);
          if (!doc.execCommand('delete', false)) break;
        }
      }
      edited = textarea.value === text;
    } catch {
      edited = false;
    }
  }
  if (!edited) {
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
    textarea.setSelectionRange(map(selectionStart), map(selectionEnd), selectionDirection || 'none');
  }
  if (active && active !== textarea && active !== doc.body && active.isConnected) active.focus({ preventScroll: true });
}

// A click on a tile selects its reference in the text (the first, when it is there more than once)
// and scrolls the field to it.
function selectStripAttachment(st, key) {
  const { textarea } = st;
  if (textarea.disabled) return;
  if (textarea.value !== st.value) reconcileStrip(st);
  const entry = st.entries.find(ref => ref.key === key);
  if (!entry) return;
  const [start, end] = entry.ranges[0];
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  if (textarea.scrollHeight <= textarea.clientHeight) return;
  const rect = referenceLayout(st).find(ref => ref.key === key)?.rects[0];
  const top = textarea.scrollTop;
  if (!rect || (rect.top >= top && rect.bottom <= top + textarea.clientHeight)) return;
  textarea.scrollTop = Math.max(0, rect.top - textarea.clientHeight / 3);
}

function scheduleStripHover(st) {
  if (st.frame) return;
  const view = st.textarea.ownerDocument.defaultView || globalThis;
  const frame = typeof view.requestAnimationFrame === 'function'
    ? callback => view.requestAnimationFrame(callback)
    : callback => setTimeout(callback, 16);
  st.frame = frame(() => {
    st.frame = 0;
    syncStripHover(st.textarea);
  });
}

// Light up the tile of the reference under the pointer in `textarea`'s text with the accent
// border — that tile only, and none while the pointer is anywhere else. `point` ({ clientX,
// clientY }) is where the pointer now is, null that it left the field; without it the last point is
// checked again (after a scroll, or an edit under a pointer that stayed put). Returns the key of the
// lit tile, or null.
export function syncStripHover(textarea, point) {
  const st = textarea ? _strips.get(textarea) : null;
  if (!st) return null;
  if (point !== undefined) st.pointer = point;
  if (textarea.value !== st.value) reconcileStrip(st);
  const key = st.pointer && st.entries.length && textarea.isConnected ? referenceAtPoint(st, st.pointer) : null;
  if (key !== st.hoverKey) {
    st.hoverKey = key;
    for (const [tileKey, tile] of st.tiles) tile.classList.toggle('attachment-tile--hover', tileKey === key);
  }
  return key;
}

// The key of the reference whose text is under the client point, or null: the point is taken into
// the field's scrolled text — unscaled, while a scale transform on the way plays (a dialog opening)
// — and matched against where each reference's text lies there.
function referenceAtPoint(st, { clientX, clientY }) {
  const { textarea } = st;
  const { box, scaleX, scaleY } = fieldBox(textarea);
  const left = (clientX - box.left) / scaleX - textarea.clientLeft;
  const top = (clientY - box.top) / scaleY - textarea.clientTop;
  if (!(left >= 0 && top >= 0 && left < textarea.clientWidth && top < textarea.clientHeight)) return null;
  const x = left + textarea.scrollLeft;
  const y = top + textarea.scrollTop;
  for (const { key, rects } of referenceLayout(st)) {
    if (rects.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) return key;
  }
  return null;
}

// The field's box, and the scale a transform on the way applies to it: only a change beyond the
// rounding of offsetWidth / offsetHeight counts.
function fieldBox(textarea) {
  const box = textarea.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = textarea;
  return {
    box,
    scaleX: width && Math.abs(box.width - width) > 1 ? box.width / width : 1,
    scaleY: height && Math.abs(box.height - height) > 1 ? box.height / height : 1,
  };
}

// The width the field's text wraps at, unrounded: its laid-out width less borders, a scrollbar and
// padding (clientWidth is rounded, and half a pixel moves where a long URL breaks).
function textWidth(textarea, style) {
  const { box, scaleX } = fieldBox(textarea);
  const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const scrollbar = Math.max(0, textarea.offsetWidth - textarea.clientWidth - Math.round(borders));
  const outer = box.width ? box.width / scaleX : textarea.clientWidth + borders;
  return Math.max(0, outer - borders - scrollbar - padding);
}

// What a textarea's text is laid out with; a mirror with the same values wraps its lines the same.
const MIRROR_STYLE = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'font-kerning', 'font-feature-settings', 'font-variation-settings', 'line-height',
  'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'text-align', 'text-rendering',
  'tab-size', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'direction',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
];

// Where each reference's text lies in the field, unscrolled, relative to its padding box:
// `[{ key, rects }]`, one rect per line a reference runs over, each as tall as its line. Measured on
// a hidden mirror of the field and kept until the text, the width or the type changes.
function referenceLayout(st) {
  const { textarea } = st;
  const style = textarea.ownerDocument.defaultView.getComputedStyle(textarea);
  const width = textWidth(textarea, style);
  const signature = [width.toFixed(2), ...MIRROR_STYLE.map(name => style.getPropertyValue(name))].join('|');
  if (st.layout && st.layout.value === st.value && st.layout.signature === signature) return st.layout.refs;
  const refs = measureReferences(textarea, st.value, st.entries, style, width);
  st.layout = { value: st.value, signature, refs };
  return refs;
}

function measureReferences(textarea, value, entries, style, width) {
  const doc = textarea.ownerDocument;
  const mirror = doc.createElement('div');
  for (const name of MIRROR_STYLE) mirror.style.setProperty(name, style.getPropertyValue(name));
  Object.assign(mirror.style, {
    position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'content-box', width: `${width}px`, height: 'auto',
    minHeight: '0', maxHeight: 'none', margin: '0', border: '0', overflow: 'hidden',
  });
  const marks = entries
    .flatMap(entry => entry.ranges.map(([start, end]) => ({ start, end, key: entry.key })))
    .sort((a, b) => a.start - b.start);
  const spans = [];
  let at = 0;
  for (const { start, end, key } of marks) {
    if (start < at) continue;
    if (start > at) mirror.appendChild(doc.createTextNode(value.slice(at, start)));
    const span = doc.createElement('span');
    span.textContent = value.slice(start, end);
    mirror.appendChild(span);
    spans.push({ span, key });
    at = end;
  }
  if (at < value.length) mirror.appendChild(doc.createTextNode(value.slice(at)));
  doc.body.appendChild(mirror);
  try {
    const origin = mirror.getBoundingClientRect();
    const lines = measureLines(mirror);
    const lineHeight = lines?.pitch || parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2;
    const textTop = lines ? lines.top : (parseFloat(style.paddingTop) || 0);
    const byKey = new Map();
    for (const { span, key } of spans) {
      const rects = byKey.get(key) || [];
      for (const r of Array.from(span.getClientRects())) {
        // An inline box is as tall as its font, not its line: each rect takes its whole line box,
        // so a point anywhere in that line's height is on it, and lines neither overlap nor leave
        // gaps between them.
        const line = Math.max(0, Math.floor((r.top + r.height / 2 - origin.top - textTop) / lineHeight));
        const top = textTop + line * lineHeight;
        rects.push({ left: r.left - origin.left, right: r.right - origin.left, top, bottom: top + lineHeight });
      }
      byKey.set(key, rects);
    }
    return [...byKey].map(([key, rects]) => ({ key, rects }));
  } finally {
    mirror.remove();
  }
}

// The mirror's lines as laid out, measured on copies of it: `top`, where the first line starts
// (its padding, rounded the way layout rounds it), and `pitch`, two lines' height less one line's.
// Layout rounds a line's height (a computed `20.608px` lays out a hair shorter) and `normal` has no
// number at all, so computed values would drift a long text's lower lines off their real place.
// Null where nothing is laid out.
function measureLines(mirror) {
  const doc = mirror.ownerDocument;
  const one = mirror.cloneNode(false);
  const two = mirror.cloneNode(false);
  const start = doc.createElement('div');
  start.style.height = '0';
  one.append(start, 'x');
  two.textContent = 'x\nx';
  mirror.parentNode.append(one, two);
  const box = one.getBoundingClientRect();
  const pitch = two.getBoundingClientRect().height - box.height;
  const top = start.getBoundingClientRect().top - box.top;
  one.remove();
  two.remove();
  return pitch > 0 ? { pitch, top } : null;
}
