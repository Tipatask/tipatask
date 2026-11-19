// ── File attachments (C1246) ──
// Generic (non-image) file upload for the Embed ▾ "Other file" row and file drop (embed-menu.js),
// backed by the task_files API store. Deliberately simpler than task-board.js's image upload path
// (uploadImageFile/_readFileBase64/_imagePasteTargets): no WS blob-swap optimistic preview,
// because there is nothing to preview — a successful upload becomes a plain
// `[filename](url)` markdown link in the host's textarea, not inline content. A coding agent gets
// the file itself at session start: task-agent/file-attach.js (C1247) downloads every linked file.

import { api } from './api-client.js';
import { insertAtCursor, showToast } from './utils.js';
import { t } from './i18n.js';

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — mirrors api/src/routes/files.js MAX_FILE_BYTES

// Mirrors api/src/routes/files.js FILE_MIME_EXT — the API is the real enforcement point, this
// is only for a fast, friendly client-side reject before spending a round trip.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'application/yaml',
  'text/yaml',
  'application/rtf',
  'text/rtf',
]);

// Browsers frequently report file.type === '' for plain-text-ish dev files (macOS reports no
// type for .log/.diff/.patch/.sql/.yml/.ini/.conf). Fall back to extension when that happens.
const EXT_MIME_FALLBACK = {
  txt: 'text/plain', log: 'text/plain', diff: 'text/plain', patch: 'text/plain',
  sql: 'text/plain', ini: 'text/plain', conf: 'text/plain',
  md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yml: 'text/yaml', yaml: 'text/yaml',
  rtf: 'application/rtf',
};

export const FILE_ACCEPT = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.rtf',
  '.log', '.diff', '.patch', '.sql', '.ini', '.conf',
].join(',');

export function resolveFileMime(file) {
  if (file.type && ALLOWED_MIME.has(file.type)) return file.type;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return EXT_MIME_FALLBACK[ext] || null;
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
