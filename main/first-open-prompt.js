'use strict';

// (TPT9319) The one-time first-open prompt of a new project ("create your first objective or
// discuss the project?"). project:create-from-wizard (main.js) writes `firstOpenPrompt: true`
// into a NEW project's .tipatask/project.json through writeProjectMeta(); a linked existing
// project never gets it. Once the project window's board has rendered, the renderer
// (src/client/first-project-prompt.js) reads the marker over IPC, clears it and shows the
// prompt — only when the clear removed it, so the prompt appears on the first opening only.
//
// Both channels act on the SENDER window's project (projectDirs), never on a path from the
// payload. Electron-free, so src/server/first-open-prompt.test.js runs it for real.

const fs = require('node:fs');
const path = require('node:path');

const FIRST_OPEN_PROMPT_KEY = 'firstOpenPrompt';
const FIRST_OPEN_PROMPT_CHANNEL = 'project:first-open-prompt';
const FIRST_OPEN_PROMPT_CLEAR_CHANNEL = 'project:first-open-prompt-clear';
const META_REL = path.join('.tipatask', 'project.json');

function readMeta(projectRoot) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectRoot, META_REL), 'utf8'));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch {
    return null;
  }
}

// Same file format as main.js writeProjectMeta(), which main passes in as `writeMeta`.
function defaultWriteMeta(projectRoot, meta) {
  fs.writeFileSync(path.join(projectRoot, META_REL), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** Whether the project's first-open prompt is still due. */
function hasFirstOpenPrompt(projectRoot) {
  if (!projectRoot) return false;
  return readMeta(projectRoot)?.[FIRST_OPEN_PROMPT_KEY] === true;
}

/**
 * Removes the marker, keeping every other project.json field. Returns true only when this
 * call removed a due marker — the renderer shows the prompt only then. Never creates a
 * project.json and never writes one that carries no marker.
 */
function clearFirstOpenPrompt(projectRoot, { writeMeta = defaultWriteMeta } = {}) {
  if (!projectRoot) return false;
  const meta = readMeta(projectRoot);
  if (!meta || !Object.hasOwn(meta, FIRST_OPEN_PROMPT_KEY)) return false;
  const wasDue = meta[FIRST_OPEN_PROMPT_KEY] === true;
  delete meta[FIRST_OPEN_PROMPT_KEY];
  writeMeta(projectRoot, meta);
  return wasDue;
}

/**
 * Registers the read and clear channels. `isTrusted(event)` is main.js's top-frame check,
 * `projectDirOf(event)` the sender window's project folder (null for an unbound window).
 * Both answer a plain boolean; a failed read or write answers false, so a marker that cannot
 * be cleared never brings the prompt back on every load.
 */
function registerFirstOpenPromptIpc({ ipcMain, isTrusted, projectDirOf, writeMeta, warn = console.warn }) {
  ipcMain.handle(FIRST_OPEN_PROMPT_CHANNEL, (event) => {
    if (!isTrusted(event)) return false;
    try { return hasFirstOpenPrompt(projectDirOf(event)); } catch { return false; }
  });
  ipcMain.handle(FIRST_OPEN_PROMPT_CLEAR_CHANNEL, (event) => {
    if (!isTrusted(event)) return false;
    try {
      return clearFirstOpenPrompt(projectDirOf(event), writeMeta ? { writeMeta } : undefined);
    } catch (err) {
      warn('[first-open-prompt] clear failed:', err.message);
      return false;
    }
  });
}

module.exports = {
  FIRST_OPEN_PROMPT_KEY,
  FIRST_OPEN_PROMPT_CHANNEL,
  FIRST_OPEN_PROMPT_CLEAR_CHANNEL,
  hasFirstOpenPrompt,
  clearFirstOpenPrompt,
  registerFirstOpenPromptIpc,
};
