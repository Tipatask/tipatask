import { getLocale, t } from './i18n.js';
import { LOGO_LIMIT, LOGO_TYPES, readSetupProfile } from '../project-profile.mjs';
import { escapeHtml as esc } from './setup-modal-header.js';
import { mountBrandColorPicker } from './brand-color-picker.js';
import { identityBrandColors, normalizeBrandColors, sameBrandColors } from '../brand-colors.mjs';

const fieldLabels = {
  language: 'settings.language', color_scheme: 'settings.theme', task_group_label: 'settings.workflow.groupLabel',
  agent_permission_mode: 'settings.workflow.agentPermissions', kb_sync_as_you_go: 'settings.memory.syncAsYouGo',
  use_objective_grouping: 'settings.workflow.objectiveGrouping', sprints_enabled: 'settings.workflow.sprintsEnabled',
  vcs_type: 'settings.vcs.tab', vcs_worktree_enabled: 'settings.vcs.worktreeLabel', vcs_commit_enabled: 'settings.vcs.commitLabel',
  vcs_pr_enabled: 'settings.vcs.prLabel', vcs_merge_enabled: 'settings.vcs.mergeLabel',
  sprint_duration_days: 'profile.duration', sprint_sort_order: 'profile.order',
};

// Every field a policy rule can lock, in the order the policy editor lists them.
export const POLICY_FIELDS = Object.freeze(Object.keys(fieldLabels));

const UPLOAD_ICON = '<svg class="project-upload-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/>'
  + '<line x1="12" y1="3" x2="12" y2="15"/></svg>';

function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return (words.length === 1 ? words : [words[0], words.at(-1)])
    .map(word => segmenter.segment(word).containing(0)?.segment || '').join('').toUpperCase() || '?';
}

export function policyFieldLabel(field) {
  return fieldLabels[field] ? t(fieldLabels[field], { label: t('group.sprint.plural') }) : field;
}

// A rule's value as text: switches as Enabled/Disabled, languages by name, codes by label.
export function policyValueText(field, value) {
  if (field === 'vcs_type') return { git: 'Git', svn: 'SVN' }[value] || t('settings.vcs.typeDisabled');
  if (value === null || value === undefined) return t('permissionMode.notSet');
  if (typeof value === 'boolean') return t(value ? 'profile.on' : 'profile.off');
  if (field === 'agent_permission_mode') return t('permissionMode.' + value);
  if (field === 'sprint_sort_order') return t(value === 'desc' ? 'board.sprintOrderDesc' : 'board.sprintOrderAsc');
  if (field === 'language' && /^[a-z]{2,3}$/i.test(value)) {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(value);
  }
  return String(value);
}

export function policySource(policy, rule) {
  if (rule.source !== 'company') return t('profile.owner');
  return [t('profile.company'), policy.company?.name].filter(Boolean).join(' · ');
}

// The setup wizards list the rules a project will start under. No rules, no block.
export function policyMarkup(policy) {
  const rules = Object.entries(policy?.rules || {});
  if (!rules.length) return '';
  const rows = rules.map(([field, rule]) => `<li><strong>${esc(policyFieldLabel(field))}</strong> · `
    + `${esc(policyValueText(field, rule.value))} <small>(${esc(policySource(policy, rule))})</small></li>`);
  return `<div class="project-rules"><strong>${esc(t('profile.policy'))}</strong><ul>${rows.join('')}</ul></div>`;
}

function identityParts(name, profile, draft) {
  const identity = profile?.identity || {};
  const initials = (Object.hasOwn(draft, 'display_initials') ? draft.display_initials : identity.display_initials ?? identity.initials) || initialsFor(name);
  // (TPT9422) The first of the 0–3 brand colors fills the tile; the form edits brand_colors.
  const colors = Object.hasOwn(draft, 'brand_colors') ? normalizeBrandColors(draft.brand_colors) : identityBrandColors(identity) || [];
  const background = colors[0] || null;
  const logo = Object.hasOwn(draft, 'logo') ? draft.logo : profile?.logo;
  // Pick the higher-contrast foreground for arbitrary brand colors.
  const rgb = background && background.slice(1).match(/../g).map(pair => {
    const v = parseInt(pair, 16) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  const light = rgb && .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179;
  return { initials, background, colors, foreground: light ? '#000' : '#fff', logo };
}

// One mark: the logo when there is one, otherwise the initials. A brand color fills the tile
// behind either; without one the tile is neutral, never the app accent. `details` adds what the
// mark cannot show — the initials behind a logo and the color codes — for the setup summaries.
export function identityMarkup(name, profile, draft = {}, details = false) {
  const { initials, background, colors, foreground, logo } = identityParts(name, profile, draft);
  const style = background ? ` style="background:${background};color:${foreground}"` : '';
  const mark = `<span class="project-monogram${logo ? ' project-monogram--logo' : ''}"${style}>`
    + `${logo ? `<img src="${esc(logo)}" alt="">` : esc(initials)}</span>`;
  const extra = details ? [logo ? initials : '', ...colors].filter(Boolean).join(' · ') : '';
  return `<span class="project-identity">${mark}<strong>${esc(name)}</strong>${extra ? `<small>${esc(extra)}</small>` : ''}</span>`;
}

let profileSeq = 0;

// Keep a partial patch: only fields that differ from the saved identity stay in `draft`, so an
// untouched logo is never uploaded or removed on a text-only save. layout 'rows' renders
// Settings rows (label column | control column, § Settings sections and rows in styles.css);
// the default lays the three fields side by side for the setup wizards. `policy: false` leaves
// the rule list out (Settings shows it in its own section).
export function renderProfile(host, { name, profile, draft = {}, editable, layout = 'fields', policy = true, onValidity = () => {} }) {
  const identity = profile.identity || {};
  const rows = layout === 'rows';
  const id = `project-profile-${++profileSeq}`;
  const btn = rows ? 'settings-row-btn' : 'setup-modal-btn';
  const field = (key, label, control, hint = '', error = false) => {
    const hintHtml = hint ? `<p class="${rows ? 'settings-row-hint' : 'project-identity-hint'}" id="${id}-${key}-hint">${esc(hint)}</p>` : '';
    const errorHtml = error
      ? `<p class="${rows ? 'settings-notice ' : ''}project-identity-error" id="${id}-${key}-error" data-error="${key}" role="status"></p>` : '';
    return rows
      ? `<div class="settings-row project-identity-row" data-field="${key}"><div class="settings-row-label">${label}${hintHtml}</div>`
        + `<div class="settings-row-control">${control}</div>${errorHtml}</div>`
      : `<div class="project-identity-field" data-field="${key}">${label}<div class="project-identity-control">${control}</div>${hintHtml}${errorHtml}</div>`;
  };
  const fields = editable ? [
    field('initials', `<label for="${id}-initials" id="${id}-initials-label">${esc(t('profile.initials'))}</label>`,
      `<input id="${id}-initials" data-initials class="${rows ? 'project-identity-input' : 'setup-modal-input'}" type="text" `
        + `autocomplete="off" spellcheck="false" placeholder="${esc(initialsFor(name))}" aria-describedby="${id}-initials-hint ${id}-initials-error">`,
      t('profile.initialsHint'), true),
    // (TPT9422) 0–3 brand colors, the window's accent colors: brand-color-picker.js.
    field('color', `<span id="${id}-color-label">${esc(t('profile.color'))}</span>`,
      '<div data-brand-colors></div>', t('profile.colorsHintNone')),
    field('logo', `<span id="${id}-logo-label">${esc(t('profile.logo'))}</span>`,
      `<input data-file type="file" accept="${LOGO_TYPES.join(',')}" hidden>`
        + `<button data-choose type="button" class="${btn} project-upload-btn" aria-describedby="${id}-logo-label ${id}-logo-hint">`
        + `${UPLOAD_ICON}<span>${esc(t('profile.chooseLogo'))}</span></button>`
        + `<span class="project-upload-name" data-file-name hidden></span>`
        + `<button data-remove type="button" class="${btn}">${esc(t('profile.removeLogo'))}</button>`,
      t('profile.logoHint'), true),
  ].join('') : '';
  host.innerHTML = `<div class="project-identity-preview" data-preview></div>`
    + (fields ? `<div class="project-identity-fields${rows ? ' project-identity-fields--rows' : ''}">${fields}</div>` : '')
    + (policy ? policyMarkup(profile.policy) : '');
  const preview = host.querySelector('[data-preview]');
  const paint = () => { preview.innerHTML = identityMarkup(name, profile, draft); };
  paint();
  if (!editable) { onValidity(true); return; }
  const $ = selector => host.querySelector(selector);
  const initials = $('[data-initials]');
  const file = $('[data-file]');
  const choose = $('[data-choose]');
  const fileName = $('[data-file-name]');
  const remove = $('[data-remove]');
  const initialsError = $('[data-error="initials"]');
  const logoError = $('[data-error="logo"]');
  const value = key => (Object.hasOwn(draft, key) ? draft[key] : identity[key]);
  // A field set back to its saved value leaves the patch.
  const put = (key, next, saved) => {
    if (next === saved) delete draft[key];
    else draft[key] = next;
  };
  initials.value = value('display_initials') || '';
  // The list leaves the patch when it is set back to the saved colors, in the same order.
  const savedColors = identityBrandColors(identity) || [];
  const colorsHint = $(`#${id}-color-hint`);
  mountBrandColorPicker($('[data-brand-colors]'), {
    colors: Object.hasOwn(draft, 'brand_colors') ? draft.brand_colors : savedColors,
    labelledBy: `${id}-color-label`, describedBy: `${id}-color-hint`,
    onChange: list => {
      if (sameBrandColors(list, savedColors)) delete draft.brand_colors;
      else draft.brand_colors = list;
      sync();
    },
  });
  let reading = false;
  let logoMessage = '';
  let chosenName = '';
  let fileVersion = 0;
  function sync() {
    const text = initials.value.trim().normalize('NFC');
    const valid = !text || /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]{0,3}$/u.test(text);
    initials.setAttribute('aria-invalid', String(!valid));
    initialsError.textContent = valid ? '' : t('profile.invalidInitials');
    logoError.textContent = logoMessage;
    const colors = Object.hasOwn(draft, 'brand_colors') ? draft.brand_colors : savedColors;
    colorsHint.textContent = t(colors.length ? 'profile.colorsHint' : 'profile.colorsHintNone');
    fileName.hidden = !chosenName;
    fileName.textContent = chosenName;
    fileName.title = chosenName;
    remove.hidden = !chosenName && !(Object.hasOwn(draft, 'logo') ? draft.logo : profile.logo);
    paint();
    onValidity(valid && !reading);
  }
  initials.oninput = () => {
    put('display_initials', initials.value.trim().normalize('NFC') || null, identity.display_initials ?? null);
    sync();
  };
  choose.onclick = () => file.click();
  remove.onclick = () => {
    fileVersion++;
    reading = false;
    logoMessage = '';
    chosenName = '';
    file.value = '';
    put('logo', null, profile.logo ? undefined : null);
    sync();
    choose.focus(); // Remove hides itself.
  };
  file.onchange = async () => {
    const version = ++fileVersion;
    const image = file.files[0];
    if (!image) return; // The picker was dismissed; keep the current choice.
    reading = true;
    logoMessage = '';
    chosenName = image.name || '';
    sync();
    try {
      if (!LOGO_TYPES.includes(image.type) || !image.size || image.size > LOGO_LIMIT) throw new Error();
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(image);
      });
      const decoded = new Image();
      decoded.src = data;
      await decoded.decode();
      if (decoded.naturalWidth * decoded.naturalHeight > 2048 ** 2) throw new Error();
      if (version === fileVersion && preview.isConnected) draft.logo = data;
    } catch {
      // A rejected image is dropped: the preview returns to the saved logo.
      if (version === fileVersion) {
        logoMessage = t('profile.invalidLogo');
        chosenName = '';
        file.value = '';
        delete draft.logo;
      }
    } finally {
      if (version === fileVersion && preview.isConnected) { reading = false; sync(); }
    }
  };
  sync();
}

export async function renderSetupProfile({ body, footer, prefix, baseUrl, token, project, draft, back, next, loaded }) {
  body.textContent = t('common.loading');
  footer.innerHTML = `<button id="${prefix}-back-btn" class="setup-modal-btn setup-modal-btn--secondary">${esc(t('common.back'))}</button>
    <button id="${prefix}-next-btn" class="setup-modal-btn setup-modal-btn--primary" disabled>${esc(t('common.next'))}</button>`;
  const forward = footer.querySelector('#' + prefix + '-next-btn');
  footer.firstElementChild.onclick = back;
  async function load() {
    forward.disabled = true;
    try {
      const reader = window.electronAPI?.setupProjectProfile || readSetupProfile;
      const profile = await reader(baseUrl, token, project.id);
      if (!body.isConnected) return;
      loaded(profile);
      forward.textContent = t('common.next');
      forward.onclick = next;
      renderProfile(body, { name: project.name, profile, draft, editable: !!project.isNew,
        onValidity: valid => { forward.disabled = !valid; } });
    } catch (err) {
      if (!body.isConnected) return;
      body.textContent = t('profile.loadFailed', { msg: err.message });
      forward.textContent = t('btn.retry');
      forward.onclick = load;
      forward.disabled = false;
    }
  }
  await load();
}
