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
import { t } from './i18n.js';
import { FILE_ACCEPT, uploadAttachmentFile } from './file-attach.js';
import { escapeAttr, insertAtCursor, showToast } from './utils.js';
import { api } from './api-client.js';

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
