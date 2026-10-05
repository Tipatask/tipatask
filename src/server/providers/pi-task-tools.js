'use strict';

// Puts the Pi task-chat extension (providers/pi-ext/) where the Pi CLI can load it. In a
// packaged build the sources live inside app.asar, which a separately spawned CLI cannot be
// relied on to read, so both files are copied to USER_DATA_ROOT/pi-ext/ and Pi is pointed at
// the copy. Same idea as mcp-spawn-config.js: derived, app-owned, never inside the project.

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, 'pi-ext');
const FILES = ['task-tools.mjs', 'tipatask-request.cjs', 'live-credentials.cjs'];
const ENTRY = 'task-tools.mjs';

// Returns the absolute path of the copied extension entry, or null when it cannot be written —
// the caller must then refuse the turn rather than run Pi without its only task tool.
function materializePiTaskTools(userDataRoot) {
  if (!userDataRoot) return null;
  const dir = path.join(userDataRoot, 'pi-ext');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FILES) {
      const content = fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8');
      const target = path.join(dir, name);
      let unchanged = false;
      try { unchanged = fs.readFileSync(target, 'utf8') === content; } catch { /* absent */ }
      if (unchanged) continue;
      const tmp = `${target}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    console.warn(`[pi-task-tools] could not stage the task-chat extension: ${err.message}`);
    return null;
  }
  return path.join(dir, ENTRY);
}

module.exports = { materializePiTaskTools, SOURCE_DIR, FILES, ENTRY };
