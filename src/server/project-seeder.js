'use strict';

const path = require('node:path');
const { refreshHarnessTemplates } = require('../cli/install-templates');
const { applyPresetTemplate, applyBaseGeneralTemplate, seedPresetTasks } = require('../cli/seed-setup-tasks');
const { KB_MODE_COMPOSE } = require('./project-config');

// (TPT9316) The creation wizard's preset A, "compose the knowledge base as you go". Its new
// project seeds no starter tasks, gets only the base templates (no preset overlay), and its
// .tipatask/config.json carries KB_MODE: 'compose'. Presets B/C ('original-specification',
// 'existing-code') keep their preset templates and starter tasks.
const COMPOSE_PRESET = 'compose-as-you-go';

function isComposePreset(preset) {
  return preset === COMPOSE_PRESET;
}

/** Config keys a preset adds to the new project's .tipatask/config.json. */
function presetConfigFields(preset) {
  return isComposePreset(preset) ? { KB_MODE: KB_MODE_COMPOSE } : {};
}

/** Whether a preset seeds starter tasks (callSeedPresetTasks). Compose mode starts empty. */
function presetSeedsTasks(preset) {
  return !isComposePreset(preset);
}

/**
 * Copy the project templates into the project root: the harness guides (CLAUDE.md, AGENTS.md,
 * .claude/) for every preset, then the preset's CLAUDE.md overlay + GENERAL.md seed — or, for
 * the compose preset, the base GENERAL.md only.
 * Non-fatal — errors are logged.
 */
function copyTemplates(preset, projectPath, presetDescription) {
  try {
    refreshHarnessTemplates(projectPath, path.resolve(__dirname, '../..'));
    if (isComposePreset(preset)) applyBaseGeneralTemplate(projectPath);
    else applyPresetTemplate(preset, projectPath, presetDescription || null);
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

module.exports = {
  copyTemplates, callSeedPresetTasks,
  COMPOSE_PRESET, isComposePreset, presetConfigFields, presetSeedsTasks,
};
