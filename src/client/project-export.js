// (TPT9167) Project ▸ Export… — the window's side of main/project-export.js. Main owns the save
// dialog, the archive build and the file write; it reports through `project:export` frames
// ({ state: 'started' | 'done' | 'failed', ... }) and this module turns them into one
// progress toast that ends in the outcome. Electron only — browser mode has no menu.

import { t } from './i18n.js';
import { showProgressToast } from './utils.js';

// Frame -> toast text in the current locale; null for an unknown frame.
export function exportToastText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const file = msg.fileName || '';
  if (msg.state === 'started') return t('project.exporting', { file });
  if (msg.state === 'done') {
    return t('project.exportDone', { file, tasks: msg.counts?.tasks ?? 0, kb: msg.counts?.kbFiles ?? 0 });
  }
  if (msg.state === 'failed') {
    if (msg.code === 'setup') return t('project.exportNeedsSetup');
    if (msg.code === 'auth') return t('project.exportAuthFailed');
    if (msg.code === 'network') return t('project.exportOffline');
    return t('project.exportFailed', { msg: msg.error || t('project.unknownError') });
  }
  return null;
}

let _exportToast = null;

export function handleProjectExportStatus(msg, { showToast = showProgressToast } = {}) {
  const text = exportToastText(msg);
  if (!text) return;
  if (msg.state === 'started') {
    _exportToast?.close();
    _exportToast = showToast(text);
    return;
  }
  // A failure can arrive with no 'started' before it (project not set up yet).
  const toast = _exportToast || showToast(text);
  _exportToast = null;
  if (msg.state === 'done') toast.done(text);
  else toast.fail(text);
}
