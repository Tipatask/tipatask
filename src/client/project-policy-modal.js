// Project policy dialog, opened from Settings ▸ General ▸ Policy (desktop-project-profile.js).
// A policy rule fixes a project setting for every member: company mandates first, then the
// project owner's rules. Everyone can read them here; the project owner (`policyEditable`,
// API capability policy:manage) edits the owner layer, and Save replaces that whole layer
// through api.project.savePolicy() (PUT /api/projects/:id/policy). Company mandates stay
// read-only — company executives change them in the web app's Policies tab.
//
// Like Edit Agents, the dialog sits above #settings-modal on the setup-modal panel chrome
// but never takes the .setup-modal class: setup-modal.js removes that element on repaint.
import { getLocale, t } from './i18n.js';
import { api } from './api-client.js';
import { activateDialogFocus } from './dialog-focus.js';
import { escapeHtml as esc } from './setup-modal-header.js';
import { POLICY_FIELDS, policyFieldLabel, policyValueText } from './project-profile.js';
import { TASK_GROUP_LABELS, groupPluralFor, getGroupLabel, getSprintsEnabled, getObjectiveGroupingEnabled, getSprintSortOrder, projectPermissionMode } from './group-label.js';
import { AGENT_PERMISSION_MODES } from './permission-mode.js';

const TOGGLE = [true, false];
const LANGUAGES = ['en', 'uk', 'zh', 'es'];
const GIT_FLAGS = ['vcs_worktree_enabled', 'vcs_commit_enabled', 'vcs_pr_enabled', 'vcs_merge_enabled'];
// The API's color schemes in the Theme select's order, for when that select is not mounted.
const COLOR_SCHEMES = ['paper', 'parchment', 'latte', 'meadow', 'arctic', 'terracotta', 'sakura', 'citrus', 'slate', 'lagoon', 'iris',
  'ink', 'mocha', 'ocean', 'ember', 'forest', 'nord', 'rose', 'graphite', 'espresso', 'neon'];

let _overlay = null;
let _keyHandler = null;
let _focusHandle = null;

function themeOptions() {
  return [...(document.getElementById('settings-theme-select')?.options || [])];
}

// Wire values a rule can take, as the API stores them; null means a 1–90 number field.
export function policyChoices(field) {
  switch (field) {
    case 'language': return LANGUAGES;
    case 'color_scheme': {
      const ids = themeOptions().map(option => option.value).filter(Boolean);
      return ids.length ? ids : COLOR_SCHEMES;
    }
    case 'task_group_label': return TASK_GROUP_LABELS;
    case 'agent_permission_mode': return [null, ...AGENT_PERMISSION_MODES];
    case 'vcs_type': return [null, 'git', 'svn'];
    case 'sprint_sort_order': return ['asc', 'desc'];
    case 'sprint_duration_days': return null;
    default: return TOGGLE;
  }
}

export function ruleValueText(field, value) {
  if (field === 'task_group_label' && TASK_GROUP_LABELS.includes(value)) return groupPluralFor(value);
  if (field === 'color_scheme') {
    if (value === 'default') return t('policy.defaultTheme');
    const option = themeOptions().find(item => item.value === value);
    if (option) return option.textContent.trim();
  }
  return policyValueText(field, value);
}

// The value a newly added rule starts with: the project's current setting where the window
// knows it, so adding a rule never changes anything until the owner picks another value.
function startValue(field) {
  switch (field) {
    case 'language': return LANGUAGES.includes(getLocale()) ? getLocale() : 'en';
    case 'color_scheme': return document.documentElement.getAttribute('data-theme') || policyChoices(field)[0];
    case 'task_group_label': return getGroupLabel();
    case 'sprints_enabled': return getSprintsEnabled();
    case 'use_objective_grouping': return getObjectiveGroupingEnabled();
    case 'sprint_sort_order': return getSprintSortOrder();
    case 'agent_permission_mode': return projectPermissionMode() ?? null;
    case 'sprint_duration_days': return 14;
    case 'vcs_type': return 'git';
    default: return true;
  }
}

// One line for the Settings row: the locked fields by name, or "None".
export function policySummary(policy) {
  const fields = Object.keys(policy?.rules || {});
  if (!fields.length) return t('policy.none');
  const names = fields.map(policyFieldLabel);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

export function policyErrorText(err) {
  const message = String(err?.message || '');
  const conflict = message.match(/\bpolicy_conflict:([a-z_]+)/);
  if (conflict) return t('policy.conflict', { field: policyFieldLabel(conflict[1]) });
  if (/\bpolicy_conflict\b/.test(message)) return t('policy.conflict', { field: t('policy.thisSetting') });
  if (/\bpolicy_stale\b/.test(message)) return t('policy.stale');
  if (/\bforbidden\b/.test(message)) return t('policy.forbidden');
  return t('common.error', { msg: message || t('policy.failed') });
}

function readOnlyList(rules, source) {
  const entries = Object.entries(rules);
  if (!entries.length) return `<p class="policy-modal-empty">${esc(t('policy.none'))}</p>`;
  return `<dl class="policy-modal-list">${entries.map(([field, value]) => `<div class="policy-modal-item">`
    + `<dt>${esc(policyFieldLabel(field))}</dt><dd>${esc(ruleValueText(field, value))}${source
      ? ` <small>${esc(source(field))}</small>` : ''}</dd></div>`).join('')}</dl>`;
}

function editorRows(draft, companyRules, companyName) {
  const rows = Object.entries(draft).map(([field, value]) => {
    const id = `policy-rule-${field}`;
    const locked = Object.hasOwn(companyRules, field);
    let options = locked ? [companyRules[field]] : policyChoices(field);
    if (options && !options.some(choice => choice === value)) options = [value, ...options];
    const control = options
      ? `<select id="${id}" data-rule="${esc(field)}">${options.map(choice => `<option value="${esc(JSON.stringify(choice))}"`
        + `${choice === value ? ' selected' : ''}>${esc(ruleValueText(field, choice))}</option>`).join('')}</select>`
      : `<input id="${id}" data-rule="${esc(field)}" type="number" min="1" max="90" step="1" required value="${esc(String(value ?? ''))}">`;
    const lock = locked ? `<small class="policy-modal-lock">${esc(t('policy.companySets', { value: ruleValueText(field, companyRules[field]), name: companyName }))}</small>` : '';
    return `<div class="policy-modal-rule"><label for="${id}">${esc(policyFieldLabel(field))}${lock}</label>${control}`
      + `<button type="button" class="setup-modal-btn policy-modal-remove" data-remove="${esc(field)}" `
      + `aria-label="${esc(t('policy.removeRule', { field: policyFieldLabel(field) }))}">${esc(t('policy.remove'))}</button></div>`;
  }).join('');
  const available = POLICY_FIELDS.filter(field => !Object.hasOwn(draft, field));
  const add = `<select class="policy-modal-add" data-add aria-label="${esc(t('policy.add'))}"${available.length ? '' : ' disabled'}>`
    + `<option value="">${esc(t('policy.add'))}</option>${available.map(field =>
      `<option value="${esc(field)}">${esc(policyFieldLabel(field))}</option>`).join('')}</select>`;
  return `${rows ? `<div class="policy-modal-rules">${rows}</div>` : `<p class="policy-modal-empty">${esc(t('policy.none'))}</p>`}${add}`;
}

function close() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_keyHandler) { window.removeEventListener('keydown', _keyHandler, { capture: true }); _keyHandler = null; }
  _focusHandle?.close();
  _focusHandle = null;
}

export function closeProjectPolicyModal() { close(); }

// profile: the desktop project profile ({ context, name, policy, policyEditable }).
// onSaved(policy) runs after a successful save, once the dialog has closed. `save(rules)`
// replaces the API write — the setup wizard keeps a new project's rules as a draft.
export function openProjectPolicyModal({ profile, onSaved, save: persist } = {}) {
  close();
  const policy = profile?.policy || { rules: {} };
  const editable = !!profile?.policyEditable;
  const companyRules = policy.company_rules || Object.fromEntries(Object.entries(policy.rules || {})
    .filter(([, rule]) => rule.source === 'company').map(([field, rule]) => [field, rule.value]));
  const ownerRules = policy.owner_rules || Object.fromEntries(Object.entries(policy.rules || {})
    .filter(([, rule]) => rule.source !== 'company').map(([field, rule]) => [field, rule.value]));
  const base = { ...ownerRules };
  const draft = { ...ownerRules };
  const companyName = policy.company?.name || t('profile.company');
  const companyTitle = [t('profile.company'), policy.company?.name].filter(Boolean).join(' · ');
  // A company rule outranks an owner rule on the same field.
  const ownerSource = field => (Object.hasOwn(companyRules, field) ? t('policy.overridden', { name: companyName }) : '');

  _overlay = document.createElement('div');
  _overlay.className = 'policy-modal';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'policy-modal-title');
  const companySection = Object.keys(companyRules).length ? `<section class="policy-modal-layer" aria-labelledby="policy-modal-company">
      <h3 class="policy-modal-layer-title" id="policy-modal-company">${esc(companyTitle)}</h3>
      ${readOnlyList(companyRules)}</section>` : '';
  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel">
      <div class="setup-modal-header">
        <span class="setup-modal-title" id="policy-modal-title">${esc(t('policy.title'))}</span>
        <button class="setup-modal-close" type="button" aria-label="${esc(t('common.close'))}">&times;</button>
      </div>
      <form class="setup-modal-step-body policy-modal-body" novalidate>
        <p class="setup-modal-hint">${esc(t('policy.intro'))}</p>
        ${companySection}
        <section class="policy-modal-layer" aria-labelledby="policy-modal-owner">
          <h3 class="policy-modal-layer-title" id="policy-modal-owner">${esc(t('profile.owner'))}</h3>
          <p class="policy-modal-scope">${esc(t(editable ? 'policy.ownerScope' : 'policy.ownerOnly'))}</p>
          <div class="policy-modal-owner" data-owner-rules></div>
        </section>
        <p class="setup-modal-msg setup-modal-msg--error" data-policy-error role="alert"></p>
      </form>
      <div class="setup-modal-footer">${editable
        ? `<button type="button" class="setup-modal-btn setup-modal-btn--secondary" data-cancel>${esc(t('btn.cancel'))}</button>
           <button type="button" class="setup-modal-btn setup-modal-btn--primary" data-save>${esc(t('btn.save'))}</button>`
        : `<button type="button" class="setup-modal-btn setup-modal-btn--secondary" data-cancel>${esc(t('btn.close'))}</button>`}</div>
    </div>`;
  document.body.appendChild(_overlay);
  const overlay = _overlay;
  const form = overlay.querySelector('form');
  const host = overlay.querySelector('[data-owner-rules]');
  const error = overlay.querySelector('[data-policy-error]');
  const save = overlay.querySelector('[data-save]');
  const render = () => {
    host.innerHTML = editable ? editorRows(draft, companyRules, companyName) : readOnlyList(ownerRules, ownerSource);
  };
  render();

  overlay.querySelector('.setup-modal-close').onclick = close;
  overlay.querySelector('[data-cancel]').onclick = close;
  overlay.querySelector('.setup-modal-backdrop').onclick = close;
  form.onsubmit = e => e.preventDefault();
  if (editable) {
    form.oninput = e => {
      const field = e.target.dataset.rule;
      if (!field) return;
      draft[field] = e.target.type === 'number' ? e.target.valueAsNumber : JSON.parse(e.target.value);
      error.textContent = '';
    };
    form.onchange = e => {
      if (!e.target.hasAttribute('data-add') || !e.target.value) return;
      const field = e.target.value;
      draft[field] = Object.hasOwn(companyRules, field) ? companyRules[field] : startValue(field);
      error.textContent = '';
      render();
      host.querySelector(`[data-rule="${field}"]`)?.focus();
    };
    form.onclick = e => {
      const field = e.target.closest('[data-remove]')?.dataset.remove;
      if (!field) return;
      delete draft[field];
      error.textContent = '';
      render();
      host.querySelector('[data-add]')?.focus();
    };
    save.onclick = async () => {
      const duration = draft.sprint_duration_days;
      if (duration !== undefined && !(Number.isInteger(duration) && duration >= 1 && duration <= 90)) {
        error.textContent = t('policy.durationRange');
        host.querySelector('[data-rule="sprint_duration_days"]')?.focus();
        return;
      }
      if (GIT_FLAGS.some(field => draft[field] === true) && draft.vcs_type !== 'git' && companyRules.vcs_type !== 'git') {
        error.textContent = t('policy.gitRequired');
        return;
      }
      const controls = [...overlay.querySelectorAll('button, select, input')].filter(el => !el.disabled);
      controls.forEach(el => { el.disabled = true; });
      error.textContent = '';
      try {
        const result = persist ? await persist({ ...draft }) : await api.project.savePolicy({ ...draft }, base, profile.context);
        if (overlay !== _overlay) return;
        close();
        onSaved?.(result?.policy ?? null);
      } catch (err) {
        if (overlay !== _overlay) return;
        controls.forEach(el => { el.disabled = false; });
        error.textContent = policyErrorText(err);
        save.focus();
      }
    };
  }

  _focusHandle = activateDialogFocus({
    root: overlay,
    initialFocus: () => host.querySelector('select, input') || overlay.querySelector('[data-save], [data-cancel]'),
  });
  // Window capture phase + stopPropagation: Escape closes this dialog and never reaches the
  // document-level Escape handlers of the dialog under it (Settings, the setup wizard).
  _keyHandler = e => {
    if (e.key !== 'Escape' || overlay !== _overlay) return;
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', _keyHandler, { capture: true });
}
