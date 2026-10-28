'use strict';

// (TPT9169) Project ▸ Import… — rebuilds a Project ▸ Export archive (TPT9167) into a new
// project. Main owns the file dialog, the archive check and the import itself; the window's
// setup modal (src/client/setup-modal.js, import mode) collects the project name, the folder
// and the agents in between:
//   menu click → chooseArchive(win): open dialog (.zip) → validateArchive()
//     invalid → native error dialog naming the reason; nothing else happens
//     valid   → a pending import { zipPath, summary } under a random id, then
//               `project:import-open` { importId, archiveName, summary } to the window
//   project:import-folder-check → checkFolder(importId, folder)
//   project:import-from-wizard  → run(sender, detail)
//   project:import-cancel       → cancel(importId)
// run() sends `project:import-progress` { importId, step, done, total } frames to the wizard:
// 'project', then importProjectArchive()'s kb / statuses / tags / sprints / tasks, then 'finish'.
// No electron import: the dialog and every project step are injected by main.js, so
// src/server/project-import-menu.test.js drives this module with fakes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mt } = require('./menu-i18n');

const CONFIG_REL = path.join('.tipatask', 'config.json');
const META_REL = path.join('.tipatask', 'project.json');
const NAME_MAX = 255; // POST /api/projects rejects longer names

function isLive(win) {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

function errorMessage(err) {
  return String((err && err.message) || err || '').split('\n')[0].trim().slice(0, 300);
}

function lexists(target) {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

// Localized reason for a validateProjectArchive() failure code (ARCHIVE_ERROR_CODES).
function archiveErrorText(code) {
  const key = `importError.${code}`;
  const text = mt(key);
  return text === key ? mt('importError.unknown') : text;
}

// What the wizard's folder step needs to know about `folder`. blocked: 'invalid' (not an
// absolute path to a folder), 'configured' (it already holds .tipatask/config.json: importing
// would re-point an existing project) or 'open' (another window holds it), else null.
// architectureFiles counts the files directly in ai/architecture; existingKbFiles lists the
// archive's KB file keys already present there, which importProjectArchive() keeps unwritten.
function inspectFolder(folder, kbFiles, isFolderOpen = () => false) {
  const result = { folder, blocked: null, architectureFiles: 0, existingKbFiles: [] };
  let stat = null;
  if (typeof folder === 'string' && path.isAbsolute(folder)) {
    try { stat = fs.statSync(folder); } catch { /* missing or unreadable */ }
  }
  if (!stat || !stat.isDirectory()) return { ...result, blocked: 'invalid' };
  if (lexists(path.join(folder, CONFIG_REL))) result.blocked = 'configured';
  else if (isFolderOpen(folder)) result.blocked = 'open';
  try {
    result.architectureFiles = fs.readdirSync(path.join(folder, 'ai', 'architecture'), { withFileTypes: true })
      .filter((entry) => entry.isFile()).length;
  } catch { /* no ai/architecture folder */ }
  result.existingKbFiles = (Array.isArray(kbFiles) ? kbFiles : [])
    .filter((key) => typeof key === 'string' && lexists(path.join(folder, ...key.split('/'))));
  return result;
}

// Undoes the files configureProject() wrote before a failed import: config.json (the folder had
// none, inspectFolder() refuses a configured one), project.json unless it was there before,
// and the .tipatask folder when this import created it and nothing else is left in it.
function removeImportConfig(projectPath, { hadDir, hadMeta }) {
  try { fs.rmSync(path.join(projectPath, CONFIG_REL), { force: true }); } catch { /* best effort */ }
  if (!hadMeta) {
    try { fs.rmSync(path.join(projectPath, META_REL), { force: true }); } catch { /* best effort */ }
  }
  if (!hadDir) {
    try { fs.rmdirSync(path.join(projectPath, '.tipatask')); } catch { /* not empty, or gone */ }
  }
}

// The counts the wizard reports after a successful import, from importProjectArchive()'s result.
function importReport(result) {
  const r = result || {};
  return {
    tasks: r.tasks ? r.tasks.created : 0,
    sprints: r.sprints ? r.sprints.created.length : 0,
    kbWritten: r.kb ? r.kb.written.length : 0,
    kbSkipped: r.kb ? [...r.kb.skipped] : [],
    tagsSkipped: r.tags ? r.tags.skipped.length : 0,
    dropped: { dependencies: 0, parents: 0, tags: 0, ...(r.dropped || {}) },
  };
}

// deps (all supplied by main.js):
//   dialog                     Electron's dialog
//   validateArchive(zipPath)   → validateProjectArchive() result, { ok, summary } | { ok: false, code }
//   isFolderOpen(dir)          → true when a project or setup window holds dir
//   createProject({ apiBaseUrl, token, name }) → { id }
//   configureProject({ projectPath, apiBaseUrl, token, projectId, name, agentPreference })
//                              → { token }: device link, token exchange, config.json, settings,
//                                project.json — the folder is a configured project afterwards
//   importArchive(zipPath, { projectRoot, onProgress }) → importProjectArchive() result
//   finishProject({ projectPath, apiBaseUrl, token, projectId, name }): harness, KB push,
//                                MCP configs — failures there are logged, never fatal
//   removeProject({ apiBaseUrl, token, projectId }): DELETE the API project (rollback)
//   openProject(senderWebContents, projectPath) → 'current' | 'new' | 'focused' | null
function createProjectImporter({
  dialog, validateArchive, isFolderOpen = () => false,
  createProject, configureProject, importArchive, finishProject, removeProject, openProject,
  log = console,
}) {
  const pending = new Map(); // importId -> { zipPath, archiveName, summary, wcId, running }

  async function chooseArchive(win) {
    if (!isLive(win)) return { ok: false, reason: 'no-window' };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: mt('dialog.importProjectTitle'),
      filters: [{ name: mt('dialog.zipArchive'), extensions: ['zip'] }],
      properties: ['openFile'],
    });
    const zipPath = !canceled && Array.isArray(filePaths) ? filePaths[0] : null;
    if (!zipPath) return { ok: false, reason: 'canceled' };
    const archiveName = path.basename(zipPath);

    let check;
    try { check = await validateArchive(zipPath); } catch (err) { check = { ok: false, code: 'unreadable', detail: errorMessage(err) }; }
    if (!check || !check.ok) {
      const code = (check && check.code) || 'unreadable';
      log.warn(`[project-import] ${zipPath}: ${code}${check && check.detail ? ` (${check.detail})` : ''}`);
      if (isLive(win)) {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: mt('dialog.importProjectTitle'),
          message: mt('dialog.importInvalidMessage'),
          detail: `${archiveName}\n\n${archiveErrorText(code)}`,
          buttons: [mt('dialog.ok')],
        });
      }
      return { ok: false, reason: 'invalid', code };
    }
    if (!isLive(win)) return { ok: false, reason: 'no-window' };

    // One pending import per window: a newer pick replaces one the window has not started.
    for (const [id, entry] of pending) {
      if (entry.wcId === win.webContents.id && !entry.running) pending.delete(id);
    }
    const importId = crypto.randomUUID();
    pending.set(importId, { zipPath, archiveName, summary: check.summary, wcId: win.webContents.id, running: false });
    win.webContents.send('project:import-open', { importId, archiveName, summary: check.summary });
    return { ok: true, importId };
  }

  function checkFolder(importId, folder) {
    const entry = pending.get(importId);
    if (!entry) return { ok: false, code: 'expired' };
    return { ok: true, ...inspectFolder(folder, entry.summary.kbFiles, isFolderOpen) };
  }

  // Wizard closed without importing. A running import is not abandoned.
  function cancel(importId) {
    const entry = pending.get(importId);
    if (!entry || entry.running) return false;
    pending.delete(importId);
    return true;
  }

  // project:import-from-wizard. detail: { importId, projectName, projectPath, apiBaseUrl,
  // userToken, agentPreference: { taskAgent, availableAgents, piModels } }.
  // Resolves to { ok: true, projectPath, projectId, opened, report } or { ok: false, code, … }:
  //   expired — no pending import under importId (cancelled, done, or never chosen)
  //   busy    — this import is already running
  //   name    — the project name is empty or longer than 255 characters
  //   signin  — no API server or account token
  //   folder  — inspectFolder() refuses the folder ({ blocked })
  //   archive — the archive no longer passes validateArchive() ({ archiveCode })
  //   create  — the API project could not be created ({ error }); nothing to undo
  //   import  — setting up the folder or importProjectArchive() failed after the project was
  //             created ({ step: 'configure' | an importStep, error, removed }). An import is
  //             not resumable, so the new API project and the config files go again; removed
  //             is false when the API refused the delete. KB files already written stay.
  async function run(sender, detail = {}) {
    const importId = detail.importId;
    const entry = pending.get(importId);
    if (!entry) return { ok: false, code: 'expired' };
    if (entry.running) return { ok: false, code: 'busy' };
    const name = typeof detail.projectName === 'string' ? detail.projectName.trim() : '';
    if (!name || name.length > NAME_MAX) return { ok: false, code: 'name' };
    const apiBaseUrl = String(detail.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const token = typeof detail.userToken === 'string' ? detail.userToken : '';
    if (!apiBaseUrl || !token) return { ok: false, code: 'signin' };
    const projectPath = detail.projectPath;
    const folder = inspectFolder(projectPath, entry.summary.kbFiles, isFolderOpen);
    if (folder.blocked) return { ok: false, code: 'folder', blocked: folder.blocked };

    const send = (frame) => {
      if (sender && !sender.isDestroyed()) sender.send('project:import-progress', { importId, ...frame });
    };
    entry.running = true;
    try {
      const check = await validateArchive(entry.zipPath);
      if (!check || !check.ok) return { ok: false, code: 'archive', archiveCode: (check && check.code) || 'unreadable' };

      send({ step: 'project', done: 0, total: 0 });
      let projectId;
      try {
        const project = await createProject({ apiBaseUrl, token, name });
        projectId = project && project.id;
        if (projectId == null) throw new Error('the API returned no project id');
      } catch (err) {
        log.warn(`[project-import] creating "${name}" failed: ${errorMessage(err)}`);
        return { ok: false, code: 'create', error: errorMessage(err) };
      }

      const had = {
        hadDir: lexists(path.join(projectPath, '.tipatask')),
        hadMeta: lexists(path.join(projectPath, META_REL)),
      };
      let configured = null;
      let result;
      try {
        configured = await configureProject({
          projectPath, apiBaseUrl, token, projectId, name, agentPreference: detail.agentPreference || {},
        });
        result = await importArchive(entry.zipPath, {
          projectRoot: projectPath,
          onProgress: ({ step, done, total }) => send({ step, done, total }),
        });
      } catch (err) {
        const step = (err && err.importStep) || (configured ? null : 'configure');
        log.warn(`[project-import] ${entry.zipPath} → project ${projectId}, ${step || 'import'} step: ${errorMessage(err)}`);
        removeImportConfig(projectPath, had);
        let removed = false;
        try {
          await removeProject({ apiBaseUrl, token, projectId });
          removed = true;
        } catch (rmErr) {
          log.warn(`[project-import] could not remove project ${projectId}: ${errorMessage(rmErr)}`);
        }
        return { ok: false, code: 'import', step, error: errorMessage(err), removed, projectId, projectName: name };
      }

      send({ step: 'finish', done: 0, total: 0 });
      try {
        await finishProject({ projectPath, apiBaseUrl, token: (configured && configured.token) || token, projectId, name });
      } catch (err) {
        log.warn(`[project-import] finishing ${projectPath} failed: ${errorMessage(err)}`);
      }
      pending.delete(importId);
      let opened = null;
      try {
        opened = await openProject(sender, projectPath);
      } catch (err) {
        log.warn(`[project-import] opening ${projectPath} failed: ${errorMessage(err)}`);
      }
      return { ok: true, projectPath, projectId, opened: opened || null, report: importReport(result) };
    } finally {
      entry.running = false;
    }
  }

  return {
    chooseArchive,
    checkFolder,
    cancel,
    run,
    isPending: (importId) => pending.has(importId),
  };
}

module.exports = {
  createProjectImporter,
  inspectFolder,
  archiveErrorText,
  importReport,
};
