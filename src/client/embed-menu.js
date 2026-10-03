// ── Composer Embed control ──
// The Embed dropdown (Image / Other file), its two hidden pickers and file drop, shared by every
// chat composer: the objective chat (chat-ui.js) and the task / project chat (task-chat.js).
// Uploads always go through the one upload path each kind already has — images through
// task-board.js (`uploadImageFile`, a `![img](blob:…)` placeholder swapped for the real URL once
// the board socket answers), other files through file-attach.js (`uploadAttachmentFile`, a
// `[name](url)` link) — so a composer only says which textarea receives the reference.
import { t } from './i18n.js';
import { uploadImageFile } from './task-board.js';
import { FILE_ACCEPT, uploadAttachmentFile } from './file-attach.js';
import { escapeAttr } from './utils.js';

// (TPT280) Shared 12px chevron caret for the composer's Embed and Import dropdown triggers —
// one svg (not a text glyph) so both carets render at an identical size on every platform font.
export const DROPDOWN_CARET_SVG = '<svg class="embed-menu-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const PAPERCLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

// (C1241) Paperclip + label trigger opening a dropdown with Image / Other file rows, each backed
// by its own hidden picker. Ids are optional: the objective chat keeps its historic ids
// (#btn-obj-img-upload, #obj-img-file-input, #obj-file-input) for its tooltip and disabled-state
// wiring; other composers find the parts by class inside the wrap.
export function embedMenuHtml({ label = t('nav.embed'), disabled = false, triggerId = '', imageInputId = '', fileInputId = '' } = {}) {
  const id = value => (value ? ` id="${escapeAttr(value)}"` : '');
  return `
    <div class="embed-menu-wrap">
      <input type="file" class="embed-image-input"${id(imageInputId)} accept="image/*" style="display:none">
      <input type="file" class="embed-file-input"${id(fileInputId)} accept="${FILE_ACCEPT}" style="display:none">
      <button class="embed-menu-trigger"${id(triggerId)} type="button" aria-haspopup="true" aria-expanded="false"${disabled ? ' disabled' : ''}>
        ${PAPERCLIP_SVG}
        <span class="embed-menu-label">${escapeAttr(label)}</span>
        ${DROPDOWN_CARET_SVG}
      </button>
    </div>`;
}

// (C1241 fix, C1248) Teardown of the one open menu: the panel, the trigger's expanded state and
// the document-level outside-click / Escape listeners. Every close path goes through it, and a
// composer re-render or teardown calls closeOpenEmbedMenu() so those listeners never outlive the
// DOM they were attached for.
let _openMenuCleanup = null;

export function closeOpenEmbedMenu() {
  const cleanup = _openMenuCleanup;
  _openMenuCleanup = null;
  if (cleanup) cleanup();
}

// Images to the image upload, everything else to the file upload. `imageOpts` is passed to
// uploadImageFile() as is (taskKey, onFileDetected, onUploaded, onUploadError); `onFileUpload`
// receives the promise of each file upload, so a composer can tell when it has settled.
export function uploadComposerFiles(files, textarea, { imageOpts = {}, onFileUpload } = {}) {
  for (const file of Array.from(files || [])) {
    if (!file) continue;
    if (file.type && file.type.startsWith('image/')) {
      uploadImageFile(file, textarea, null, imageOpts);
    } else {
      const upload = uploadAttachmentFile(file, textarea);
      if (typeof onFileUpload === 'function') onFileUpload(upload, file);
    }
  }
}

// Wire one embedMenuHtml() wrap to `textarea`. `labels` overrides the two rows' text and the
// file row's tooltip (functions, so a language switch is picked up the next time it opens).
export function attachEmbedMenu(wrap, textarea, { imageOpts = {}, onFileUpload, labels = {} } = {}) {
  const trigger = wrap && wrap.querySelector('.embed-menu-trigger');
  const imageInput = wrap && wrap.querySelector('.embed-image-input');
  const fileInput = wrap && wrap.querySelector('.embed-file-input');
  if (!trigger || !imageInput || !textarea) return;
  const label = (key, fallback) => (typeof labels[key] === 'function' ? labels[key]() : t(fallback));

  const openMenu = () => {
    closeOpenEmbedMenu();
    const menu = document.createElement('div');
    menu.className = 'import-submenu import-submenu--up';

    const imageItem = document.createElement('div');
    imageItem.className = 'import-submenu-item';
    imageItem.textContent = label('image', 'embed.image');
    imageItem.addEventListener('click', () => { closeOpenEmbedMenu(); imageInput.click(); });
    menu.appendChild(imageItem);

    const fileItem = document.createElement('div');
    fileItem.className = 'import-submenu-item';
    fileItem.textContent = label('file', 'embed.otherFile');
    fileItem.title = label('fileTitle', 'tooltip.embedFile');
    fileItem.addEventListener('click', () => { closeOpenEmbedMenu(); fileInput?.click(); });
    menu.appendChild(fileItem);

    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');

    const onOutsideClick = (ev) => { if (!wrap.contains(ev.target)) closeOpenEmbedMenu(); };
    const onKeydown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      // Escape closes the menu only — not also the chat window or task workspace around it.
      ev.stopPropagation();
      closeOpenEmbedMenu();
      trigger.focus();
    };
    const timer = setTimeout(() => {
      // A rapid open→close (toggle re-click) can run before this deferred attach fires.
      if (!menu.isConnected) return;
      document.addEventListener('click', onOutsideClick);
      document.addEventListener('keydown', onKeydown, true);
    }, 0);
    _openMenuCleanup = () => {
      clearTimeout(timer);
      menu.remove();
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeydown, true);
    };
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.querySelector('.import-submenu')) { closeOpenEmbedMenu(); return; }
    openMenu();
  });
  imageInput.addEventListener('change', () => {
    const files = Array.from(imageInput.files || []);
    imageInput.value = ''; // reset so the same file can be picked again
    files.forEach(file => uploadImageFile(file, textarea, null, imageOpts));
  });
  // (C1246) "Other file": uploadAttachmentFile does its own checks, read, upload and link insert.
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const file of files) {
        const upload = uploadAttachmentFile(file, textarea);
        if (typeof onFileUpload === 'function') onFileUpload(upload, file);
      }
    });
  }
}

// Files dragged onto `target` upload into `textarea` (uploadComposerFiles). Only a drag that
// carries files is taken over — dragged text still drops into the textarea as usual.
// `activeClass` marks `target` while files are held over it.
export function attachFileDrop(target, textarea, { imageOpts = {}, onFileUpload, activeClass = 'img-drop-active' } = {}) {
  if (!target || !textarea) return;
  const hasFiles = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  let depth = 0;
  const reset = () => { depth = 0; target.classList.remove(activeClass); };
  target.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    target.classList.add(activeClass);
  });
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) target.classList.remove(activeClass);
  });
  target.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    reset();
    uploadComposerFiles(e.dataTransfer.files, textarea, { imageOpts, onFileUpload });
  });
}
