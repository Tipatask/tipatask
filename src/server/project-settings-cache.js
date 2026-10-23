'use strict';

// A local mirror of API preferences, never a source of permission to run Git.
// Keep this dependency-light: project-config and the credential resolver both use it.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readAccount, decodeTokenPayload, normalizeBaseUrl, userDataRoot, assertTokenProject } = require('./account-store');

const PROJECT_SETTING_FIELDS = Object.freeze([
  'language', 'vcs_type', 'vcs_worktree_enabled', 'vcs_commit_enabled',
  'vcs_pr_enabled', 'vcs_merge_enabled', 'task_group_label', 'color_scheme',
  'sprints_enabled', 'kb_sync_as_you_go', 'use_objective_grouping', 'sprint_sort_order',
  'agent_permission_mode',
]);

function settingsContext(cfg) {
  const baseUrl = normalizeBaseUrl(cfg?.API_BASE_URL);
  const projectId = String(cfg?.API_PROJECT_ID || '');
  if (!baseUrl || !projectId) return null;
  const account = readAccount(baseUrl);
  if (!account) return null;
  try { assertTokenProject(account.token, projectId); } catch { return null; }
  const userId = account.userId ?? decodeTokenPayload(account.token)?.id;
  if (userId == null) return null;
  return JSON.stringify([baseUrl, projectId, String(userId)]);
}

function cachePath(context) {
  const key = createHash('sha256').update(context).digest('hex');
  return path.join(userDataRoot(), 'project-settings', `${key}.json`);
}

function pickSettings(settings) {
  return Object.fromEntries(PROJECT_SETTING_FIELDS.filter(field => Object.hasOwn(settings, field))
    .map(field => [field, settings[field]]));
}

function settingsResult(data) {
  if (!data?.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)
    || !['global', 'personal'].includes(data.source) || typeof data.is_creator !== 'boolean') return null;
  return { settings: pickSettings(data.settings), source: data.source, is_creator: data.is_creator };
}

function readSettingsCache(cfg) {
  try {
    const context = settingsContext(cfg);
    if (!context) return null;
    const data = JSON.parse(fs.readFileSync(cachePath(context), 'utf8'));
    return data.context === context ? settingsResult(data) : null;
  } catch { return null; }
}

function writeSettingsCache(cfg, data) {
  const context = settingsContext(cfg);
  const result = settingsResult(data);
  if (!context || !result) return;
  const file = cachePath(context);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ context, ...result }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or write failed */ }
  }
}

// Legacy language/theme mirrors cannot be attributed to an account. A configured
// checkout uses only its current account's mirror, otherwise neutral defaults.
function displayPreferences(cfg = {}) {
  if (!cfg.API_BASE_URL || !cfg.API_PROJECT_ID) return { language: cfg.language || 'en', theme: cfg.theme || '' };
  const settings = readSettingsCache(cfg)?.settings;
  return { language: settings?.language || 'en', theme: settings?.color_scheme === 'default' ? '' : settings?.color_scheme || '' };
}

module.exports = { PROJECT_SETTING_FIELDS, settingsContext, settingsResult, pickSettings, readSettingsCache, writeSettingsCache, displayPreferences };
