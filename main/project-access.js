'use strict';

const { LOCALES } = require('./menu-i18n');

// Native dialogs are needed before a renderer or project backend exists.
function projectAccessDialog(config, projectPath, kind = 'denied') {
  const strings = LOCALES[config?.language] || LOCALES.en;
  const t = (key) => strings[`projectAccess.${key}`];
  const denied = kind === 'denied' || kind === 'signin';
  return {
    type: 'warning',
    title: t('title'),
    message: t(kind),
    detail: `${t(denied ? 'detail' : 'retryDetail')}\n\n${projectPath}`,
    buttons: denied ? [t('reauthenticate'), t('cancel')] : [t('close')],
    defaultId: 0,
    cancelId: denied ? 1 : 0,
    noLink: true,
  };
}

// Serialize opens so restore/rapid clicks cannot stack dialogs or browser handoffs.
// Duplicate requests for a path share the pending result; nothing is cached after it.
function createProjectAccessGate({ readConfig, getCredentials, request, reauthenticate,
  prompt, showError, onAccountChanged = () => {} }) {
  const pending = new Map();
  let queue = Promise.resolve();

  async function check(projectPath) {
    let config;
    let phase = 'unavailable';
    try {
      config = readConfig(projectPath);
      if (!config?.API_BASE_URL || !config.API_PROJECT_ID) return true; // setup flow
      for (;;) {
        phase = 'unavailable';
        let status;
        try {
          const { baseUrl, projectId, token } = getCredentials(projectPath);
          ({ status } = await request(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
            headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000,
          }));
        } catch (error) {
          if (!error.missingCredentials) throw error;
          status = 401;
        }
        if (status === 200) return true;
        if (![401, 403, 404].includes(status)) throw new Error('Project access check failed');
        if (!await prompt(config, projectPath, status === 401 ? 'signin' : 'denied')) return false;
        phase = 'signinFailed';
        await reauthenticate(String(config.API_BASE_URL).replace(/\/+$/, ''));
        await onAccountChanged();
        // Always probe again: signing in does not imply access to this project.
      }
    } catch {
      // Do not surface raw auth/network responses (which can contain credentials).
      await showError(config, projectPath, phase);
      return false;
    }
  }

  return function ensureProjectAccess(projectPath) {
    if (!projectPath) return Promise.resolve(true);
    if (pending.has(projectPath)) return pending.get(projectPath);
    const result = queue.then(() => check(projectPath)).finally(() => pending.delete(projectPath));
    pending.set(projectPath, result);
    queue = result.catch(() => {});
    return result;
  };
}

module.exports = { createProjectAccessGate, projectAccessDialog };
