'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'workspace.json';
const DEFAULT = { openProjects: [], activeProjectPath: null };

function loadWorkspace(userDataPath) {
  try {
    const raw = fs.readFileSync(path.join(userDataPath, FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      openProjects: Array.isArray(parsed.openProjects) ? parsed.openProjects : [],
      activeProjectPath: parsed.activeProjectPath || null,
    };
  } catch {
    return { ...DEFAULT };
  }
}

function saveWorkspace(userDataPath, state) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const safe = {
    openProjects: Array.isArray(state?.openProjects) ? state.openProjects : [],
    activeProjectPath: state?.activeProjectPath || null,
  };
  const tmp = path.join(userDataPath, FILE + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, path.join(userDataPath, FILE));
}

module.exports = { loadWorkspace, saveWorkspace };
