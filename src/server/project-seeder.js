'use strict';

const path = require('node:path');
const { refreshHarnessTemplates } = require('../cli/install-templates');
const { applyPresetTemplate, seedPresetTasks } = require('../cli/seed-setup-tasks');

/**
 * Copy preset template files (CLAUDE.md overlay + GENERAL.md seed) into the project root.
 * Non-fatal — errors are logged.
 */
function copyTemplates(preset, projectPath, presetDescription) {
  try {
    refreshHarnessTemplates(projectPath, path.resolve(__dirname, '../..'));
    applyPresetTemplate(preset, projectPath, presetDescription || null);
  } catch (err) {
    console.warn(`[project-seeder] copyTemplates failed: ${err.message}`);
  }
}

/**
 * Seed preset starter tasks via HTTP (no template copy — copyTemplates handles that).
 * Non-fatal — never throws. Returns `{ seeded, failed }` from seedPresetTasks, or
 * `{ seeded: 0, failed: null, error }` when the call itself threw, so the caller can tell a
 * partial seed apart from a clean one and from a crash (TPT203).
 */
async function callSeedPresetTasks(preset, { apiBaseUrl, token, projectId, presetDescription } = {}) {
  try {
    return await seedPresetTasks(preset, { apiBaseUrl, token, projectId, presetDescription });
  } catch (err) {
    console.warn(`[project-seeder] callSeedPresetTasks failed: ${err.message}`);
    return { seeded: 0, failed: null, error: err.message };
  }
}

module.exports = { copyTemplates, callSeedPresetTasks };
