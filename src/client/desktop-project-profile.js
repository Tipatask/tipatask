import { api } from './api-client.js';
import { identityMarkup, policySource, renderProfile } from './project-profile.js';
import { openProjectPolicyModal, policySummary } from './project-policy-modal.js';
import { t } from './i18n.js';
import { setBrandColors } from './brand-accents.js';
import { identityBrandColors } from '../brand-colors.mjs';

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

// Settings ▸ General ▸ Policy: its own section under the identity rows — the locked fields by
// name and a button to the policy dialog. A member who can neither see a rule nor edit one
// gets no section at all.
function paintPolicy(profile) {
  const section = document.getElementById('settings-policy-section');
  if (!section) return;
  const rules = Object.keys(profile?.policy?.rules || {});
  const editable = !!profile?.policyEditable;
  section.hidden = !profile?.policy || (!rules.length && !editable);
  if (section.hidden) return;
  document.getElementById('settings-policy-summary').textContent = policySummary(profile.policy);
  const open = document.getElementById('settings-policy-open');
  open.textContent = t(editable ? 'policy.edit' : 'policy.view');
  open.onclick = () => openProjectPolicyModal({
    profile,
    onSaved: () => {
      if (profile !== current) return;
      // The new rules change effective settings across the whole dialog (and maybe the
      // window's language or theme): task-board.js repopulates Settings and reapplies both.
      document.dispatchEvent(new CustomEvent('tiptask:policy-saved'));
    },
  });
}

function paintSettings(profile) {
  const section = document.getElementById('settings-profile-section');
  const host = document.getElementById('settings-project-profile');
  const saveRow = document.getElementById('settings-identity-save-row');
  const save = document.getElementById('settings-identity-save');
  const msg = document.getElementById('settings-profile-msg');
  if (!host) return;
  section.hidden = !profile;
  host.replaceChildren();
  msg.hidden = true;
  msg.textContent = '';
  msg.classList.remove('settings-notice--success');
  msg.removeAttribute('tabindex');
  save.disabled = true;
  if (saveRow) saveRow.hidden = !profile?.editable;
  save.hidden = !profile?.editable;
  paintPolicy(profile);
  if (!profile) return;
  save.textContent = t('btn.save');
  const draft = {};
  renderProfile(host, { name: profile.name, profile, draft, editable: profile.editable, layout: 'rows', policy: false,
    onValidity: valid => { save.disabled = !valid || !Object.keys(draft).length; } });
  save.onclick = async () => {
    if (profile !== current || save.disabled) return;
    save.disabled = true;
    host.inert = true;
    const colorsChanged = Object.hasOwn(draft, 'brand_colors');
    try {
      await api.project.update({ ...draft }, profile.context);
      if (profile !== current) return;
      await refreshDesktopProfile(true);
      // (TPT9422) The window's accent colors follow the saved brand colors at once.
      if (colorsChanged && current) setBrandColors(identityBrandColors(current.identity) ?? []);
      // The fields repaint from the saved identity; Save stays disabled until the next edit,
      // so keyboard focus moves to the confirmation instead of falling to the page.
      const done = document.getElementById('settings-profile-msg');
      if (done && current && document.getElementById('settings-modal')?.classList.contains('open')) {
        done.hidden = false;
        done.classList.add('settings-notice--success');
        done.textContent = t('profile.saved');
        done.tabIndex = -1;
        done.focus();
      }
    } catch (err) {
      if (profile === current) {
        msg.hidden = false;
        msg.textContent = t('common.error', { msg: err.message });
        save.disabled = false;
        save.focus();
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
