import { getLocale, t } from './i18n.js';
import { LOGO_LIMIT, LOGO_TYPES, readSetupProfile } from '../project-profile.mjs';
import { escapeHtml as esc } from './setup-modal-header.js';

const fieldLabels = {
  language: 'settings.language', color_scheme: 'settings.theme', task_group_label: 'settings.workflow.groupLabel',
  agent_permission_mode: 'settings.workflow.agentPermissions', kb_sync_as_you_go: 'settings.memory.syncAsYouGo',
  use_objective_grouping: 'settings.workflow.objectiveGrouping', sprints_enabled: 'settings.workflow.sprintsEnabled',
  vcs_type: 'settings.vcs.tab', vcs_worktree_enabled: 'settings.vcs.worktreeLabel', vcs_commit_enabled: 'settings.vcs.commitLabel',
  vcs_pr_enabled: 'settings.vcs.prLabel', vcs_merge_enabled: 'settings.vcs.mergeLabel',
  sprint_duration_days: 'profile.duration', sprint_sort_order: 'profile.order',
};

function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return (words.length === 1 ? words : [words[0], words.at(-1)])
    .map(word => segmenter.segment(word).containing(0)?.segment || '').join('').toUpperCase() || '?';
}

export function policySource(policy, rule) {
  if (rule.source !== 'company') return t('profile.owner');
  return [t('profile.company'), policy.company?.name].filter(Boolean).join(' · ');
}

export function policyMarkup(policy) {
  if (!policy) return '';
  const rows = Object.entries(policy.rules).map(([field, rule]) => {
    const source = policySource(policy, rule);
    const label = fieldLabels[field] ? t(fieldLabels[field], { label: t('group.sprint.plural') }) : field;
    let value = rule.value ?? t('permissionMode.notSet');
    if (typeof value === 'boolean') value = t(value ? 'profile.on' : 'profile.off');
    if (field === 'agent_permission_mode' && rule.value) value = t('permissionMode.' + rule.value);
    if (field === 'vcs_type') value = { git: 'Git', svn: 'SVN' }[rule.value] || t('settings.vcs.typeDisabled');
    if (field === 'language' && /^[a-z]{2,3}$/i.test(value)) {
      value = new Intl.DisplayNames([getLocale()], { type: 'language' }).of(value);
    }
    return `<li><strong>${esc(label)}</strong> · ${esc(value)} <small>(${esc(source)})</small></li>`;
  });
  return `<div class="project-rules"><strong>${esc(t('profile.policy'))}</strong>${rows.length
    ? `<ul>${rows.join('')}</ul>` : `<p>${esc(t('profile.noRules'))}</p>`}</div>`;
}

export function identityMarkup(name, profile, draft = {}, details = false) {
  const identity = profile?.identity || {};
  const initials = (Object.hasOwn(draft, 'display_initials') ? draft.display_initials : identity.display_initials ?? identity.initials) || initialsFor(name);
  const color = Object.hasOwn(draft, 'brand_color') ? draft.brand_color : identity.brand_color;
  const logo = Object.hasOwn(draft, 'logo') ? draft.logo : profile?.logo;
  const background = /^#[\da-f]{6}$/i.test(color) ? color : null;
  // Pick the higher-contrast foreground for arbitrary brand colors.
  const rgb = background && background.slice(1).match(/../g).map(pair => {
    const v = parseInt(pair, 16) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  const light = rgb && .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179;
  const style = background ? ` style="background:${background};color:${light ? '#000' : '#fff'}"` : '';
  const monogram = `<span class="project-monogram"${style}>${esc(initials)}</span>`;
  const mark = logo ? `<span class="project-monogram"${style}><img src="${esc(logo)}" alt=""></span>` : monogram;
  const fallback = details && logo ? monogram : '';
  const hex = details && background ? `<small>${esc(background)}</small>` : '';
  return `<span class="project-identity">${mark}${fallback}<strong>${esc(name)}</strong>${hex}</span>`;
}

// Keep a partial patch. An untouched logo is never uploaded or removed on a text-only save.
export function renderProfile(host, { name, profile, draft = {}, editable, onValidity = () => {} }) {
  const identity = profile.identity || {};
  host.innerHTML = `<div data-preview></div>${editable ? `
    <div class="project-identity-fields">
      <label>${esc(t('profile.initials'))}<input data-initials class="setup-modal-input" type="text" placeholder="${esc(initialsFor(name))}"></label>
      <label>${esc(t('profile.color'))}<input data-color type="color"></label>
      <button data-reset type="button" class="setup-modal-btn">${esc(t('btn.reset'))}</button>
      <label>${esc(t('profile.logo'))}<input data-file type="file" accept="${LOGO_TYPES.join(',')}"></label>
      <button data-remove type="button" class="setup-modal-btn">${esc(t('chat.image.remove'))}</button>
    </div><p data-error class="setup-modal-msg setup-modal-msg--error" role="status"></p>` : ''}${policyMarkup(profile.policy)}`;
  const preview = host.querySelector('[data-preview]');
  const paint = () => { preview.innerHTML = identityMarkup(name, profile, draft, true); };
  paint();
  if (!editable) { onValidity(true); return; }
  const initials = host.querySelector('[data-initials]');
  const color = host.querySelector('[data-color]');
  const file = host.querySelector('[data-file]');
  const remove = host.querySelector('[data-remove]');
  const reset = host.querySelector('[data-reset]');
  const error = host.querySelector('[data-error]');
  const value = field => Object.hasOwn(draft, field) ? draft[field] : identity[field];
  initials.value = value('display_initials') || '';
  let reading = false;
  let logoError = '';
  function sync() {
    const text = initials.value.trim().normalize('NFC');
    const valid = !text || /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]{0,3}$/u.test(text);
    initials.setAttribute('aria-invalid', String(!valid));
    error.textContent = valid ? logoError : t('profile.invalidInitials');
    reset.disabled = !value('brand_color');
    color.value = value('brand_color') || '#0e8377';
    remove.hidden = !file.value && !(Object.hasOwn(draft, 'logo') ? draft.logo : profile.logo);
    paint();
    onValidity(valid && !reading && !logoError);
  }
  initials.oninput = () => { draft.display_initials = initials.value.trim().normalize('NFC') || null; sync(); };
  color.oninput = () => { draft.brand_color = color.value.toUpperCase(); sync(); };
  reset.onclick = () => { draft.brand_color = null; sync(); };
  let fileVersion = 0;
  remove.onclick = () => { fileVersion++; reading = false; logoError = ''; file.value = ''; draft.logo = null; sync(); };
  file.onchange = async () => {
    const version = ++fileVersion;
    const image = file.files[0];
    reading = !!image;
    logoError = '';
    sync();
    if (!image) return;
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
      if (version === fileVersion) logoError = t('profile.invalidLogo');
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
