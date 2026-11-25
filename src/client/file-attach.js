// ── File attachments (C1246) ──
// Generic (non-image) file upload for the File dropdown's "Other file" row and file drop,
// backed by the task_files API store. Deliberately simpler than task-board.js's image upload path
// (uploadImageFile/_readFileBase64/_imagePasteTargets): no WS blob-swap optimistic preview,
// because there is nothing to preview — a successful upload becomes a plain
// `[filename](url)` markdown link in the host's textarea, not inline content. A coding agent gets
// the file itself at session start: task-agent/file-attach.js (C1247) downloads every linked file.

import { api } from './api-client.js';
import { insertAtCursor, showToast } from './utils.js';
import { t } from './i18n.js';

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — mirrors api/src/routes/files.js MAX_FILE_BYTES

// Match the extensions in api/src/lib/file-validation.js. Browser MIME labels vary by OS
// (for example .ts may be video/mp2t). Send the API's canonical MIME and let it validate the bytes.
const FILE_MIME_EXTENSIONS = {
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['ods'],
  'text/markdown': ['md', 'markdown'],
  'text/csv': ['csv'],
  'text/tab-separated-values': ['tsv'],
  'application/json': ['json'],
  'application/xml': ['xml'],
  'application/yaml': ['yaml', 'yml'],
  'application/rtf': ['rtf'],
  'text/plain': [
    'txt', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'pyw',
    'php', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx',
    'sh', 'bash', 'zsh', 'sql', 'css', 'html', 'htm', 'log', 'diff', 'patch',
    'ini', 'conf', 'cfg', 'toml',
  ],
};

const MIME_BY_EXTENSION = new Map(Object.entries(FILE_MIME_EXTENSIONS)
  .flatMap(([mime, extensions]) => extensions.map(ext => [`.${ext}`, mime])));

export const FILE_ACCEPT = [...MIME_BY_EXTENSION.keys()].join(',');

export function resolveFileMime(file) {
  const name = String(file.name || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? MIME_BY_EXTENSION.get(name.slice(dot).toLowerCase()) || null : null;
}

function _readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(String(e.target.result || '').split(',')[1] || '');
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsDataURL(file);
  });
}

// `target` is the textarea that receives the link, or a function returning it once the upload has
// landed (embed-menu.js; null when the host is gone — the link is dropped). `taskKey` links the
// file to a task (GET /files/task/:key); without it the link in the text is the only reference.
export async function uploadAttachmentFile(file, target, { taskKey = null } = {}) {
  if (!file) return;
  if (!file.size || file.size > MAX_FILE_BYTES) {
    showToast(t('toast.fileTooLarge', { max: '1 MB' }), 'error');
    return;
  }
  const mime = resolveFileMime(file);
  if (!mime) {
    showToast(t('toast.fileTypeUnsupported'), 'error');
    return;
  }
  showToast(t('toast.fileUploading', { name: file.name }));
  try {
    const data = await _readFileBase64(file);
    const r = await api.files.upload(file.name, mime, data, taskKey || null);
    const name = r?.filename || file.name;
    const textarea = typeof target === 'function' ? target() : target;
    if (!textarea) return;
    insertAtCursor(textarea, `[${name}](${r.url})`);
    showToast(t('toast.fileAttached', { name }), 'success');
  } catch (err) {
    showToast(err.message || t('toast.fileTypeUnsupported'), 'error');
  }
}

// One delegated document-level click handler for every rendered file-attachment link. There is
// no global anchor handler anywhere else in the app, so an unhandled click would navigate the
// Electron renderer itself away from the app instead of downloading. Idempotent — safe to call
// on every render cycle.
let _fileLinkHandlerBound = false;
export function ensureFileLinkHandler() {
  if (_fileLinkHandlerBound) return;
  _fileLinkHandlerBound = true;
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('a.file-attachment-link');
    if (!link) return;
    e.preventDefault();
    const href = link.href;
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(href);
    } else {
      window.open(href, '_blank');
    }
  });
}
