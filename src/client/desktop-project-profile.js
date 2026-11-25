import { api } from './api-client.js';
import { identityMarkup, policySource, renderProfile } from './project-profile.js';
import { t } from './i18n.js';

let readVersion = 0;
let current = null;

const policyRows = {
  language: 'settings-language-row', color_scheme: 'settings-theme-row',
  agent_permission_mode: 'settings-permission-mode-row', kb_sync_as_you_go: 'settings-kb-sync-row',
  sprints_enabled: 'settings-sprints-enabled-row', use_objective_grouping: 'settings-objective-grouping-row',
  task_group_label: 'settings-task-group-label-row', vcs_type: 'settings-vcs-type-row',
};

export function syncPolicyControls() {
  for (const row of document.querySelectorAll('#settings-modal [data-project-rule]')) {
    row.querySelector('.settings-row-control').inert = false;
    row.querySelector('[data-policy-source]')?.remove();
    delete row.dataset.projectRule;
  }
  for (const [field, rule] of Object.entries(current?.policy?.rules || {})) {
    const row = document.getElementById(policyRows[field]) || document.getElementById('settings-vcs-flag-' + field)?.closest('.settings-row');
    if (!row) continue;
    row.dataset.projectRule = field;
    row.querySelector('.settings-row-control').inert = true;
    const source = document.createElement('small');
    source.className = 'settings-row-note';
    source.dataset.policySource = '';
    source.textContent = policySource(current.policy, rule);
    row.querySelector('.settings-row-label').append(source);
  }
}

function paintBadge() {
  const badge = document.getElementById('sidebar-project-identity');
  if (!badge) return;
  badge.hidden = !current?.identity;
  badge.innerHTML = badge.hidden ? '' : identityMarkup(current.name, current);
}

function paintSettings(profile) {
  const section = document.getElementById('settings-profile-section');
  const host = document.getElementById('settings-project-profile');
  const save = document.getElementById('settings-identity-save');
  const msg = document.getElementById('settings-profile-msg');
  if (!host) return;
  section.hidden = !profile;
  host.replaceChildren();
  msg.hidden = true;
  msg.textContent = '';
  save.disabled = true;
  save.hidden = !profile?.editable;
  if (!profile) return;
  save.textContent = t('btn.save');
  const draft = {};
  renderProfile(host, { name: profile.name, profile, draft, editable: profile.editable,
    onValidity: valid => { save.disabled = !valid || !Object.keys(draft).length; } });
  save.onclick = async () => {
    if (profile !== current) return;
    save.disabled = true;
    host.inert = true;
    try {
      await api.project.update({ ...draft }, profile.context);
      if (profile === current) await refreshDesktopProfile(true);
    } catch (err) {
      if (profile === current) {
        msg.hidden = false;
        msg.textContent = t('common.error', { msg: err.message });
        save.disabled = false;
      }
    } finally {
      host.inert = false;
    }
  };
}

// A project/account change clears mounted controls before its asynchronous read.
// Reads finishing out of order never replace the current project's badge or draft.
export async function refreshDesktopProfile(settings = false) {
  const version = ++readVersion;
  current = null;
  paintBadge();
  paintSettings(null);
  syncPolicyControls();
  try {
    const profile = await api.project.profile();
    if (version !== readVersion) return false;
    current = profile;
    paintBadge();
    if (settings) paintSettings(profile);
    syncPolicyControls();
  } catch (err) {
    if (version !== readVersion) return false;
    if (settings) {
      document.getElementById('settings-profile-section').hidden = false;
      document.getElementById('settings-profile-msg').hidden = false;
      document.getElementById('settings-profile-msg').textContent = t('profile.loadFailed', { msg: err.message });
    }
  }
  return true;
}
