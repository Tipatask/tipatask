'use strict';

// (TPT9167) Project ▸ Export… — saves the focused project window's project as one portable .zip
// built by src/server/project-archive.js buildProjectArchive(). Main owns the save dialog and the
// file write; the window shows progress and the outcome from the `project:export` frames sent
// here (src/client/project-export.js):
//   { state: 'started', fileName }
//   { state: 'done', fileName, filePath, counts }
//   { state: 'failed', code: 'setup' | 'auth' | 'network' | 'failed', error }
// A cancelled dialog sends nothing.

const fs = require('node:fs');
const path = require('node:path');
const { mt } = require('./menu-i18n');

const EXPORT_MENU_ITEM_ID = 'project-export';

// The focused window when it is a configured project window: bound to a project directory and
// holding a backend. Null for no focused window, the splash, the notification banner, About,
// an unbound Get Started window or a project still waiting for setup — Export is disabled then.
function focusedProjectWindow({ BrowserWindow, projectDirs, hasBackend }) {
  const w = BrowserWindow.getFocusedWindow();
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return null;
  if (!projectDirs.get(w.webContents.id)) return null;
  return hasBackend(w) ? w : null;
}

function withZipExtension(filePath) {
  return /\.zip$/i.test(filePath) ? filePath : `${filePath}.zip`;
}

// Temp file next to the target, then rename: a failed write never leaves a truncated archive
// under the chosen name.
async function writeFileAtomic(filePath, buffer) {
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Failure code + one-line message for the toast. Auth and transport failures get their own
// localized text, so the API's response body never reaches the screen for them.
function describeExportError(err) {
  if (err && (err.authError || err.missingCredentials || err.statusCode === 401 || err.statusCode === 403)) {
    return { code: 'auth', error: '' };
  }
  if (err && err.networkError) return { code: 'network', error: '' };
  const message = String((err && err.message) || err || '').split('\n')[0].trim().slice(0, 300);
  return { code: 'failed', error: message };
}

// deps: dialog (Electron's), buildArchive(projectDir, backend) -> { buffer, manifest },
// fileNameFor(projectName) -> default file name, writeFile(filePath, buffer).
function createProjectExporter({ dialog, buildArchive, fileNameFor, writeFile = writeFileAtomic, log = console }) {
  const running = new Set(); // webContents ids with an export in flight

  function send(win, payload) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('project:export', payload);
  }

  // One export per window at a time; a second request while one runs is ignored.
  return async function exportProject(win, { projectDir, projectName, backend } = {}) {
    if (!win || win.isDestroyed() || !projectDir) return { ok: false, reason: 'no-project' };
    const id = win.webContents.id;
    if (running.has(id)) return { ok: false, reason: 'busy' };
    running.add(id);
    try {
      if (!backend) {
        send(win, { state: 'failed', code: 'setup', error: '' });
        return { ok: false, reason: 'setup' };
      }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: mt('dialog.exportProjectTitle'),
        defaultPath: fileNameFor(projectName),
        filters: [{ name: mt('dialog.zipArchive'), extensions: ['zip'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (canceled || !filePath) return { ok: false, reason: 'canceled' };
      const target = withZipExtension(filePath);
      send(win, { state: 'started', fileName: path.basename(target) });
      const { buffer, manifest } = await buildArchive(projectDir, backend);
      await writeFile(target, buffer);
      send(win, { state: 'done', fileName: path.basename(target), filePath: target, counts: manifest.counts });
      return { ok: true, filePath: target, counts: manifest.counts };
    } catch (err) {
      log.warn(`[project-export] ${projectDir}: ${err && err.message}`);
      send(win, { state: 'failed', ...describeExportError(err) });
      return { ok: false, reason: 'failed' };
    } finally {
      running.delete(id);
    }
  };
}

module.exports = {
  EXPORT_MENU_ITEM_ID,
  focusedProjectWindow,
  createProjectExporter,
  describeExportError,
  writeFileAtomic,
  withZipExtension,
};
