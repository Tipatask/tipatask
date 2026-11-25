// Project setup wizard — modal triggered by the create-project event, which the Open Project /
// Create Project flow dispatches as soon as the picked folder turns out to be unconfigured
// (TPT557 — there is no separate Link-vs-Create chooser in front of it).
// Collects: auth, API project (Create Project step: create new OR select existing), device
// name and agent selection. Both entries collect work presets for new projects. Software
// projects created through Create Project also choose their A/B/C onboarding mode.
// Reads the applicable policy and previews the identity before device and agent selection.
// The wizard-complete listener in index.js creates or links the confirmed project.
// (TPT564) open({ locked: true }) is the first-run mode for a window with no bound project:
// Escape does nothing, the header has no ×, and the only way out (step 1 Cancel) calls
// onCancel, which index.js routes back to Get Started — never to the empty board. The backdrop
// never dismisses the wizard in either mode.
import { renderAgentSelect, loadAgents, piCredentialsMissing, computePiSaveRows, getAgentDisplayLabel } from './agent-select.js';
import { recheckAgents } from './agent-recheck.js';
import { identityMarkup, policyMarkup, renderSetupProfile } from './project-profile.js';
import { headerHtml, fitHeaderPath, escapeHtml as _esc } from './setup-modal-header.js';
import { DEFAULT_API_BASE_URL } from './constants.js';
import { activateDialogFocus } from './dialog-focus.js';
// (C1388) This module re-renders its whole overlay per step (_render()/_renderStep()),
// so t() calls made INSIDE those render functions are locale-live — never capture one
// in a module-level constant (i18n.js's own rule). PRESETS below uses getters for
// exactly this reason.
import { t } from './i18n.js';

// Work-domain icons accompany the card's localized name. These IDs are independent of
// the A/B/C onboarding choices below.
const PRESET_ICON_PATHS = new Map([
  ['software', 'M8 6l-6 6 6 6 M16 6l6 6-6 6'],
  ['science', 'M8 3h8 M10 3v6L3.7 19.2A1.2 1.2 0 0 0 4.7 21h14.6a1.2 1.2 0 0 0 1-1.8L14 9V3 M7 14h10'],
  ['marketing', 'M3 9h6l11-6v16L9 14H3z M9 9v5 M5 14l2 7h4l-2-7'],
  ['sales', 'M3 3h8l10 10-8 8L3 11z M8.5 7.5a1 1 0 1 1-2 0 1 1 0 1 1 2 0z'],
  ['finance', 'M3 3v18h18 M7 15l4-5 4 2 6-7'],
  ['health', 'M12 21 3.7 12.7C-1.5 7.3 6 0 11 5.4L12 6.5l1-1.1C18 0 25.5 7.3 20.3 12.7Z'],
  ['home', 'M2.5 10.5 12 3l9.5 7.5 M5 9v12h5v-7h4v7h5V9'],
  ['personal-growth', 'M12 21v-4C12 10 7 7 3 7c0 6 3 10 9 10 M12 14C12 7 16 3 21 3c0 6-3 11-9 11'],
]);

export function presetIcon(presetId) {
  const path = PRESET_ICON_PATHS.get(presetId);
  if (!path) return '';
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

// (TPT9316) The preset value main.js / project-seeder.js branch on for "compose the knowledge
// base as you go": no starter tasks, base templates only, KB_MODE: 'compose' in config.json.
export const COMPOSE_PRESET = 'compose-as-you-go';

// Display order = letter order. `letter` is display-only (summary row, wizard-complete detail);
// `value` is the contract the main process branches on.
export const PRESETS = [
  {
    letter: 'A',
    get name() { return t('wizard.presetComposeName'); },
    mode: 'compose',
    value: COMPOSE_PRESET,
    get desc() { return t('wizard.presetComposeDesc'); },
  },
  {
    letter: 'B',
    get name() { return t('wizard.presetSpecName'); },
    mode: 'new',
    value: 'original-specification',
    get desc() { return t('wizard.presetSpecDesc'); },
  },
  {
    letter: 'C',
    get name() { return t('wizard.presetExistingName'); },
    mode: 'existing',
    value: 'existing-code',
    get desc() { return t('wizard.presetExistingDesc'); },
  },
];

let _projectPath = null;
let _step = 1;
let _apiBaseUrl = DEFAULT_API_BASE_URL;
let _userToken = null;
let _userInfo = null;
let _apiProject = null;
let _profile = null;
let _identityDraft = {};
let _targetKey = null;

function resetProjectChoices(key) {
  _targetKey = key;
  _profile = null;
  _identityDraft = {};
  _taskAgent = '';
  _availableAgents = [];
  _piModels = [{ model: '', apiKey: '' }];
  _workPresets = [];
  _preset = null;
  _deviceName = '';
}
let _deviceName = '';
let _taskAgent = '';
let _availableAgents = [];
// The Agent step's detected agents, kept for their labels: Confirm names the Default the way its
// card did ("Claude Code", not the stored id `claude`).
let _agentList = [];
// C1121 — up to 8 {model, apiKey} rows, replacing the old single piModel/piApiKey pair.
// Always has >= 1 row (normalizePiModels() invariant); row 0 is the mirror used for the
// legacy piModel/piApiKey confirm-payload fields main.js still reads.
let _piModels = [{ model: '', apiKey: '' }];
let _preset = null;
let _workPresets = [];
let _onComplete = null;
// (TPT564) User-dismissal callback (step 1 Cancel, ×, Escape) — never fired by a completed
// run or by open() superseding an earlier session; see _cancel().
let _onCancel = null;
let _locked = false;
// Open Project fixes onboarding to compose-as-you-go, regardless of the work presets.
let _presetLocked = false;
let _overlay = null;
let _keyHandler = null;
// (TPT561) The wizard's dialog-focus.js layer. An open Task Edit Modal owns a layer that inerts
// every other <body> child, so without one of its own the wizard paints on top but takes no
// clicks. Bound to ONE overlay root for the wizard's whole life — _render() repaints its
// contents, never replaces it (a fresh body child would be inerted by the lower layer).
let _focusHandle = null;

export function visibleSteps({ existing = false, presetLocked = false, software = false } = {}) {
  if (existing) return [1, 2, 'profile', 3, 4, 7];
  return software && !presetLocked ? [1, 2, 'profile', 3, 4, 5, 6, 7] : [1, 2, 'profile', 3, 4, 5, 7];
}

function _isExisting() {
  return !!_apiProject && !_apiProject.isNew;
}

function _steps() {
  return visibleSteps({ existing: _isExisting(), presetLocked: _presetLocked, software: _workPresets.includes('software') });
}

function _move(offset) {
  const steps = _steps();
  _goto(steps[steps.indexOf(_step) + offset]);
}

// Each visibleSteps() id's name, shown beside the progress dots and as each dot's tooltip.
const STEP_NAME_KEYS = {
  1: 'wizard.stepSignIn', 2: 'wizard.stepApiProject', profile: 'profile.title', 3: 'wizard.stepDevice',
  4: 'wizard.stepAgent', 5: 'wizard.workPresets', 6: 'wizard.stepPreset', 7: 'wizard.stepConfirm',
};

// (TPT9388) The progress row: one dot per visible step (done, current, still to come), then the
// current step's name and "Step n of N". The dots stay direct children of .setup-modal-steps, as in
// setup-modal.js. The count follows visibleSteps(), so a pick that adds or drops a step (an
// existing project, Software's onboarding) repaints it at once.
function _renderProgress() {
  const steps = _steps();
  const current = steps.indexOf(_step);
  const dots = steps.map((n, index) => {
    const cls = index < current ? 'is-done' : index === current ? 'is-active' : '';
    return `<span class="setup-modal-dot ${cls}" title="${_esc(t(STEP_NAME_KEYS[n]))}" aria-hidden="true"></span>`;
  }).join('');
  _overlay.querySelector('.setup-modal-steps').innerHTML = dots +
    `<span class="setup-modal-step-name">${_esc(t(STEP_NAME_KEYS[_step]))}</span>` +
    `<span class="setup-modal-step-count">${_esc(t('wizard.stepCount', { n: current + 1, total: steps.length }))}</span>`;
}

// (TPT9388) Every step opens the same way: its heading, then an optional hint under it. `aside`
// sits at the far end of the heading row (Work presets' Select all). The heading's id labels the
// step's own field or card group; the hint's id describes it.
function stepHead(heading, { hint = '', hintHtml = '', aside = '', center = false } = {}) {
  const hintMarkup = hintHtml || _esc(hint);
  return `
    <div class="setup-modal-step-head${center ? ' setup-modal-step-head--center' : ''}">
      <div class="setup-modal-step-head-text">
        <h2 class="setup-modal-label" id="wiz-step-heading">${_esc(heading)}</h2>
        ${hintMarkup ? `<p class="setup-modal-hint" id="wiz-step-hint">${hintMarkup}</p>` : ''}
      </div>
      ${aside}
    </div>`;
}
// Bumped by open()/close() — invalidates the in-flight stored-account check of a superseded session.
let _openId = 0;
// True while open() checks the account store for a live sign-in (setup:stored-account);
// Step 1 shows a spinner until it resolves.
let _storedAccountPending = false;
// Set by "Use a different account" so the web sign-in page offers its account chooser
// instead of silently handing back the browser's current session.
let _chooseAccount = false;

// opts.chooseAccount is forwarded to setup:auth-web unchanged.
export async function setupAuthWeb(apiBaseUrl, invoke, opts) {
  const authInvoker = invoke === undefined ? globalThis.window?.electronAPI?.setupAuthWeb : invoke;
  if (typeof authInvoker !== 'function') {
    throw new Error(t('wizard.desktopSignInUnavailable'));
  }

  try {
    return await authInvoker(apiBaseUrl, opts);
  } catch (error) {
    const raw = typeof error?.message === 'string' ? error.message.trim() : '';
    const detail = raw
      .replace(/^Error invoking remote method ['"]setup:auth-web['"]:\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    const retry = t('wizard.desktopSignInRetry');
    throw new Error(detail ? t('wizard.desktopSignInFailedDetail', { detail, retry }) : t('wizard.desktopSignInFailed', { retry }), { cause: error });
  }
}

export function open({ projectPath, onComplete, onCancel, locked = false, presetLocked = false }) {
  if (_overlay) close();
  _projectPath = projectPath;
  _step = 1;
  resetProjectChoices(null);
  _apiProject = null;
  _deviceName = '';
  _taskAgent = '';
  _availableAgents = [];
  _piModels = [{ model: '', apiKey: '' }];
  _presetLocked = !!presetLocked;
  _preset = null;
  _workPresets = [];
  _onComplete = onComplete || null;
  _onCancel = typeof onCancel === 'function' ? onCancel : null;
  _locked = !!locked;
  _openId++;
  _chooseAccount = false;
  // An in-memory sign-in from an earlier session of this wizard still wins (Step 1 shows it).
  _storedAccountPending = !_userToken && !!window.electronAPI?.setupStoredAccount;
  _render();
  // Capture-phase + stopPropagation: Escape closes only the wizard, never also reaching
  // template.html's document-level Task Edit Modal closer underneath. Locked (TPT564): Escape
  // is swallowed on every step — it must not reach Get Started's closer either.
  _keyHandler = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (_locked) { e.preventDefault(); return; }
    _cancel();
  };
  document.addEventListener('keydown', _keyHandler, { capture: true });
  if (_storedAccountPending) _adoptStoredAccount();
}

// Already signed in before the wizard opened (account store holds a live account-wide token
// for this server) → skip Sign-in and start on Step 2. Back still reaches Step 1's
// "Signed in as X / Use a different account" variant. Any miss or failure shows Sign-in.
async function _adoptStoredAccount() {
  const gen = _openId;
  let acct = null;
  try { acct = await window.electronAPI.setupStoredAccount(_apiBaseUrl); } catch {}
  if (gen !== _openId || _step !== 1) return;
  _storedAccountPending = false;
  if (acct && acct.token && !_userToken) {
    _userToken = acct.token;
    _userInfo = acct.user || {};
    _goto(2);
    return;
  }
  _render();
}

export function close() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  document.documentElement.style.overflowY = '';
  document.body.style.paddingRight = '';
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, { capture: true }); _keyHandler = null; }
  _focusHandle?.close();
  _focusHandle = null;
  _onComplete = null;
  _onCancel = null;
  _locked = false;
  _presetLocked = false;
  _storedAccountPending = false;
  _openId++;
}

// User dismissal (step 1 Cancel, ×, Escape when not locked): tear down, then tell the caller.
function _cancel() {
  const onCancel = _onCancel;
  close();
  if (onCancel) try { onCancel(); } catch (err) { console.warn('[wizard] onCancel failed', err); }
}

function _goto(step) {
  _step = step;
  _render();
}

function _render() {
  document.querySelectorAll('.wizard-modal').forEach((el) => { if (el !== _overlay) el.remove(); });
  const fresh = !_overlay || !_overlay.isConnected;
  if (fresh) {
    _focusHandle?.close();
    _focusHandle = null;
    _overlay = document.createElement('div');
    _overlay.className = 'wizard-modal setup-modal';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
  }

  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel">
      ${headerHtml({ title: t('wizard.headerTitle'), projectPath: _projectPath, closable: !_locked })}
      <div class="setup-modal-steps"></div>
      <div class="setup-modal-step-body" id="wiz-step-body"></div>
      <div class="setup-modal-footer" id="wiz-footer"></div>
    </div>
  `;

  if (fresh) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = scrollbarWidth + 'px';
    document.documentElement.style.overflowY = 'hidden';
    document.body.appendChild(_overlay);
    // .sma-pi-suggest — agent-select.js portals its model typeahead to <body>.
    _focusHandle = activateDialogFocus({ root: _overlay, portals: '.sma-pi-suggest' });
  }
  fitHeaderPath(_overlay);
  _renderProgress();

  // No × in locked mode (TPT564); .setup-modal-backdrop deliberately has no click handler.
  _overlay.querySelector('.setup-modal-close')?.addEventListener('click', _cancel);
  _renderStep();
  // Repainting drops the focused element; steps that focus their own input already did.
  if (!_overlay.contains(document.activeElement)) _focusHandle.focusFirst();
}

function _renderStep() {
  const body = _overlay.querySelector('#wiz-step-body');
  const footer = _overlay.querySelector('#wiz-footer');
  if (_step === 1) _renderStep1(body, footer);
  else if (_step === 2) _renderStep2(body, footer);
  else if (_step === 'profile') {
    // The shared profile renderer fills its own host, so the step's heading stays above it.
    body.innerHTML = stepHead(t('profile.title'), { hint: t('wizard.profileHint') }) + '<div class="setup-modal-profile"></div>';
    renderSetupProfile({ body: body.querySelector('.setup-modal-profile'), footer, prefix: 'wiz', baseUrl: _apiBaseUrl,
      token: _userToken, project: _apiProject, draft: _identityDraft, loaded: profile => { _profile = profile; },
      back: () => _move(-1), next: () => _move(1) });
  }
  else if (_step === 3) _renderStep3(body, footer);
  else if (_step === 4) _renderStep4(body, footer);  // Agent
  else if (_step === 5) _renderWorkPresets(body, footer);
  else if (_step === 6) _renderOnboarding(body, footer);
  else if (_step === 7) _renderConfirm(body, footer);
}

// ── Step 1: Sign in ──────────────────────────────────────────────────────────

// (TPT9388) The Sign in step's mark: a person in a tinted circle, a tick once signed in. Decorative.
const signInMark = (path) => `<span class="setup-modal-signin-mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${path}</svg></span>`;
const SIGN_IN_MARK = signInMark('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.4-3.2 4-4.8 7-4.8s5.6 1.6 7 4.8"/>');
const SIGNED_IN_MARK = signInMark('<path d="M5.5 12.5l4.2 4.2 8.8-9.4"/>');

function _renderStep1(body, footer) {
  // Centred in the body, in every state: checking, signed out, signing in, signed in.
  body.classList.add('setup-modal-step-body--center');
  if (_storedAccountPending) {
    body.innerHTML = `<div class="setup-modal-signin">${SIGN_IN_MARK}<div class="setup-modal-spinner">${_esc(t('setup.checkingSignIn'))}</div></div>`;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-cancel-btn">${_esc(t('common.cancel'))}</button>
    `;
    footer.querySelector('#wiz-cancel-btn').addEventListener('click', _cancel);
    return;
  }

  if (_userToken) {
    const email = _userInfo?.email || t('setup.userFallback');
    body.innerHTML = `
      <div class="setup-modal-signin">
        ${SIGNED_IN_MARK}
        ${stepHead(t('wizard.signedIn'), { hintHtml: t('setup.signedInAs', { email: `<strong>${_esc(email)}</strong>` }), center: true })}
        <div class="setup-modal-msg" id="wiz-auth-msg"></div>
      </div>
    `;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-switch-btn">${_esc(t('wizard.useDifferentAccount'))}</button>
      <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn">${_esc(t('common.next'))}</button>
    `;
    footer.querySelector('#wiz-next-btn').addEventListener('click', () => _goto(2));
    footer.querySelector('#wiz-switch-btn').addEventListener('click', () => {
      resetProjectChoices(null);
      _apiProject = null;
      _userToken = null;
      _userInfo = null;
      _chooseAccount = true;
      _render();
    });
    return;
  }

  body.innerHTML = `
    <div class="setup-modal-signin">
      ${SIGN_IN_MARK}
      ${stepHead(t('setup.signIn'), { hint: t('wizard.signInHint'), center: true })}
      <div class="setup-modal-row setup-modal-row--center" id="wiz-auth-actions">
        <button class="setup-modal-btn setup-modal-btn--primary setup-modal-btn--wide" id="wiz-signin-btn">${_esc(t('setup.signIn'))}</button>
      </div>
      <div class="setup-modal-spinner" id="wiz-auth-spinner" style="display:none">${_esc(t('wizard.openingBrowserEllipsis'))}</div>
      <p class="setup-modal-hint" id="wiz-auth-hint"></p>
      <div class="setup-modal-msg setup-modal-msg--error" id="wiz-auth-msg"></div>
    </div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-cancel-btn">${_esc(t('common.cancel'))}</button>
  `;
  footer.querySelector('#wiz-cancel-btn').addEventListener('click', _cancel);

  const actions = body.querySelector('#wiz-auth-actions');
  const spinner = body.querySelector('#wiz-auth-spinner');
  const hint = body.querySelector('#wiz-auth-hint');
  const msg = body.querySelector('#wiz-auth-msg');
  const signinBtn = body.querySelector('#wiz-signin-btn');

  // C1249: opens the web sign-in page in the system browser (Google SSO or
  // email+password, user's choice there) and waits on a loopback callback —
  // see authenticate() in src/cli/auth.js.
  signinBtn.addEventListener('click', async () => {
    signinBtn.disabled = true;
    actions.style.display = 'none';
    spinner.style.display = '';
    msg.textContent = '';
    // The spinner says it; the step's own hint already says the browser finishes the sign-in.
    hint.textContent = '';
    try {
      const result = await setupAuthWeb(_apiBaseUrl, undefined, { chooseAccount: _chooseAccount });
      _userToken = result.token;
      _userInfo = result.user || {};
      spinner.style.display = 'none';
      hint.textContent = t('setup.signedInAs', { email: _userInfo.email || t('setup.userFallback') });
      setTimeout(() => _goto(2), 400);
    } catch (e) {
      spinner.style.display = 'none';
      msg.textContent = e.message || t('setup.signInFailed');
      hint.textContent = t('wizard.signInDidNotStart');
      actions.style.display = '';
      signinBtn.disabled = false;
    }
  });
}

// ── Step 2: Create Project — create a new API project or select an existing one ──
// (TPT557) This step is the one place the Open / Create flow decides between the two
// outcomes; "+ Create new project" card first, then the account's existing projects.

function _renderStep2(body, footer) {
  body.innerHTML = `
    ${stepHead(t('wizard.selectOrCreateProject'))}
    <div class="setup-modal-project-list" id="wiz-proj-list">
      <div class="setup-modal-spinner">${_esc(t('setup.loadingProjects'))}</div>
    </div>
    <div class="setup-modal-create-project-form" id="wiz-create-form">
      <div class="setup-modal-field">
        <label class="setup-modal-form-label" for="wiz-proj-name">${_esc(t('wizard.projectName'))}</label>
        <input class="setup-modal-input" id="wiz-proj-name" type="text" maxlength="255" placeholder="${_esc(t('wizard.projectNamePlaceholder'))}" spellcheck="false" />
      </div>
      <div class="setup-modal-field">
        <label class="setup-modal-form-label" for="wiz-proj-desc">${_esc(t('wizard.descriptionOptional'))}</label>
        <textarea class="setup-modal-input setup-modal-input--multiline" id="wiz-proj-desc" maxlength="2000" rows="3" placeholder="${_esc(t('wizard.descriptionPlaceholder'))}"></textarea>
      </div>
    </div>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-proj-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn" disabled>${_esc(t('common.next'))}</button>
  `;

  const nextBtn = footer.querySelector('#wiz-next-btn');
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _goto(1));

  const list = body.querySelector('#wiz-proj-list');
  const createForm = body.querySelector('#wiz-create-form');
  const nameInput = body.querySelector('#wiz-proj-name');
  const descInput = body.querySelector('#wiz-proj-desc');
  const msg = body.querySelector('#wiz-proj-msg');
  const gen = _openId;

  let creatingNew = false;

  const selectCard = (card, proj) => {
    for (const option of list.querySelectorAll('.setup-modal-project-card')) {
      option.classList.toggle('is-selected', option === card);
      option.setAttribute('aria-pressed', String(option === card));
    }
    const key = proj?.id ?? 'new';
    if (_targetKey !== key) resetProjectChoices(key);
    creatingNew = !proj;
    createForm.classList.toggle('is-visible', creatingNew);
    if (creatingNew) {
      _apiProject = null;
      nextBtn.disabled = nameInput.value.trim().length === 0;
      nameInput.focus();
    } else {
      const projectPresets = Array.isArray(proj.projectPresets) && proj.projectPresets.length ? proj.projectPresets : ['software'];
      _apiProject = { id: proj.id, name: proj.name, projectPresets, isNew: false };
      nextBtn.disabled = false;
    }
    _renderProgress();
  };

  nextBtn.addEventListener('click', () => {
    if (creatingNew) {
      const name = nameInput.value.trim();
      if (!name) { msg.textContent = t('wizard.projectNameRequired'); return; }
      _apiProject = { id: null, name, description: descInput.value.trim() || null, isNew: true };
    }
    if (_apiProject) _move(1);
  });

  nameInput?.addEventListener('input', () => {
    nextBtn.disabled = creatingNew && nameInput.value.trim().length === 0;
  });

  (async () => {
    let projects = [];
    try {
      let raw;
      if (window.electronAPI?.setupListProjects) {
        raw = await window.electronAPI.setupListProjects(_apiBaseUrl, _userToken);
      } else {
        const res = await fetch(`${_apiBaseUrl}/api/projects`, {
          headers: { Authorization: `Bearer ${_userToken}` },
        });
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        raw = await res.json();
      }
      projects = Array.isArray(raw) ? raw : (raw?.projects || raw?.data || []);
    } catch (e) {
      if (gen !== _openId || !list.isConnected) return;
      list.innerHTML = '';
      msg.textContent = t('setup.failedToLoadProjects', { msg: e.message });
      return;
    }

    if (gen !== _openId || !list.isConnected) return;
    const newCard = `
      <button type="button" class="setup-modal-project-card setup-modal-project-card--new" id="wiz-new-card" aria-pressed="false" aria-controls="wiz-create-form">
        <span class="setup-modal-project-plus" aria-hidden="true">+</span>
        <span class="setup-modal-project-name">${_esc(t('wizard.createNewProject'))}</span>
      </button>
    `;
    const existingCards = projects.map((p) => `
      <button type="button" class="setup-modal-project-card" data-id="${_esc(String(p.id))}" aria-pressed="false">
        <span class="setup-modal-project-name">${_esc(p.name || t('setup.unnamedProject'))}</span>
        <span class="setup-modal-project-id">#${_esc(String(p.id))}</span>
      </button>
    `).join('');
    list.innerHTML = newCard + (projects.length
      ? `<p class="setup-modal-section-label">${_esc(t('wizard.existingProjects'))}</p>${existingCards}` : '');
    // (TPT9388) The name/description form opens right under its card, never below a long project
    // list. Moved, not re-rendered, so typed text and listeners survive.
    list.querySelector('#wiz-new-card').after(createForm);

    list.querySelector('#wiz-new-card').addEventListener('click', (e) => {
      selectCard(e.currentTarget, null);
    });

    list.querySelectorAll('.setup-modal-project-card:not(#wiz-new-card)').forEach((card, index) => {
      card.addEventListener('click', () => {
        selectCard(card, projects[index]);
      });
    });

    if (_apiProject?.isNew) {
      nameInput.value = _apiProject.name;
      descInput.value = _apiProject.description || '';
      selectCard(list.querySelector('#wiz-new-card'), null);
    } else if (_apiProject) {
      const prev = list.querySelector(`[data-id="${_apiProject.id}"]`);
      if (prev) prev.click();
    }
  })();
}

// ── Step 3: Device name ───────────────────────────────────────────────────────

function _renderStep3(body, footer) {
  body.innerHTML = `
    ${stepHead(t('wizard.deviceName'), { hint: t('wizard.deviceNameHint') })}
    <div class="setup-modal-field">
      <input class="setup-modal-input" id="wiz-device-input" type="text" maxlength="100"
        aria-labelledby="wiz-step-heading" aria-describedby="wiz-step-hint"
        value="${_esc(_deviceName)}" placeholder="${_esc(t('wizard.deviceNamePlaceholder'))}" spellcheck="false" />
    </div>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-device-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn">${_esc(t('common.next'))}</button>
  `;

  const input = body.querySelector('#wiz-device-input');
  const nextBtn = footer.querySelector('#wiz-next-btn');
  const msg = body.querySelector('#wiz-device-msg');
  nextBtn.disabled = input.value.trim().length === 0;
  input.addEventListener('input', () => { nextBtn.disabled = input.value.trim().length === 0; });
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _move(-1));
  nextBtn.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val) { msg.textContent = t('wizard.deviceNameRequired'); return; }
    _deviceName = val;
    _goto(4);
  });
  input.focus();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !nextBtn.disabled) nextBtn.click(); });

  // Async prefill: look up this machine's previously used device name from the API.
  // Only fires when the field is still empty (user hasn't typed and _deviceName is blank).
  if (!_deviceName && window.electronAPI?.setupGetDeviceName) {
    window.electronAPI.setupGetDeviceName(_apiBaseUrl, _userToken).then((name) => {
      if (!name) return;
      const el = body.querySelector('#wiz-device-input');
      if (el && el.value.trim().length === 0) { el.value = name; nextBtn.disabled = false; }
    }).catch(() => {});
  }
}

// ── Step 4: Agent selection (new) ────────────────────────────────────────────

function _renderStep4(body, footer) {
  body.innerHTML = `
    ${stepHead(t('wizard.chooseAgent'))}
    <div id="wiz-agent-select"><span class="setup-modal-spinner">${_esc(t('setup.detectingAgents'))}</span></div>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-agent-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn" disabled>${_esc(t('common.next'))}</button>
  `;

  const nextBtn = footer.querySelector('#wiz-next-btn');
  const msgEl = body.querySelector('#wiz-agent-msg');
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _goto(3));

  // (TPT174) The validation message is a RESPONSE to a blocked Next click, never first-paint
  // chrome: it is empty until that click, and cleared again as soon as the user edits anything
  // (onChange) or re-detects agents (applyAgents), so it never lingers past the state it described.
  // Next is therefore enabled once agents have loaded and validates here on click — disabling it
  // under the very condition the message explains (the pre-TPT174 behavior) made the message
  // unreachable and left a dead button with no reason.
  nextBtn.addEventListener('click', () => {
    if (!_taskAgent) { msgEl.textContent = t('wizard.selectDefaultAgent'); return; }
    if (piCredentialsMissing({ availableAgents: _availableAgents, piModels: _piModels })) {
      msgEl.textContent = t('agentSelect.fixOtherModelRows');
      return;
    }
    _move(1);
  });

  const container = body.querySelector('#wiz-agent-select');

  // Fetch + apply agents. force=true busts the main-process detection caches
  // (resolveBin null-cache + cachedDetect TTL) so a just-installed agent is seen.
  const applyAgents = (agents) => {
    if (!container.isConnected) return;
    _agentList = agents;
    // Seed from existing state if returning from a later step; otherwise auto-init.
    if (!_taskAgent) {
      const avail = agents.filter(a => a.available);
      _availableAgents = avail.map(a => a.id);
      _taskAgent = avail[0]?.id || '';
    }
    renderAgentSelect(container, {
      agents,
      value: { availableAgents: _availableAgents, taskAgent: _taskAgent, piModels: _piModels },
      onChange: ({ availableAgents, taskAgent, piModels }) => {
        _availableAgents = availableAgents;
        _taskAgent = taskAgent;
        _piModels = piModels;
        msgEl.textContent = '';
      },
      onReCheck: reCheck,
    });
    msgEl.textContent = '';
    nextBtn.disabled = false;
  };

  // Server-first (agent-recheck.js): Electron main's detection cache is not the forked server's,
  // and the forked server is what serves the chat model selector. No post-save server notify
  // here (unlike setup-modal.js): this wizard's completion ends in project:open, which does a
  // full loadURL of the new project's window — a fresh page load re-fetches the providers.
  async function reCheck() {
    applyAgents(await recheckAgents());
  }

  (async () => { applyAgents(await loadAgents()); })();
}

// ── Step 5: Work presets ──────────────────────────────────────────────────────
function _renderWorkPresets(body, footer) {
  const cards = [...PRESET_ICON_PATHS.keys()].map(id => `
    <label class="wizard-work-card">
      <span class="wizard-work-icon">${presetIcon(id)}</span>
      <input type="checkbox" value="${id}" ${_workPresets.includes(id) ? 'checked' : ''}
        aria-labelledby="wiz-name-${id}" aria-describedby="wiz-desc-${id}">
      <strong class="wizard-work-name" id="wiz-name-${id}">${_esc(t('wizard.work.' + id))}</strong>
      <span class="wizard-work-desc" id="wiz-desc-${id}">${_esc(t('wizard.workDesc.' + id))}</span>
    </label>`).join('');
  const selectAll = `<label class="wizard-work-all"><input type="checkbox" id="wiz-work-all"> ${_esc(t('board.selectAll'))}</label>`;
  body.innerHTML = `
    ${stepHead(t('wizard.chooseWork'), { aside: selectAll })}
    <div class="wizard-work-grid" role="group" aria-labelledby="wiz-step-heading">${cards}</div>`;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn">${_esc(t('common.next'))}</button>`;

  const all = body.querySelector('#wiz-work-all');
  const grid = body.querySelector('.wizard-work-grid');
  const inputs = [...grid.querySelectorAll('input')];
  const next = footer.querySelector('#wiz-next-btn');
  function syncSelection() {
    _workPresets = inputs.filter(input => input.checked).map(input => input.value);
    all.checked = _workPresets.length === inputs.length;
    all.indeterminate = _workPresets.length > 0 && !all.checked;
    next.disabled = !_workPresets.length;
    _renderProgress();
  }
  all.addEventListener('change', () => {
    for (const input of inputs) input.checked = all.checked;
    syncSelection();
  });
  grid.addEventListener('change', syncSelection);
  syncSelection();
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _move(-1));
  next.addEventListener('click', () => { if (_workPresets.length) _move(1); });
}

// ── Step 6: Onboarding (A/B/C) ────────────────────────────────────────────────────
// (TPT9316) One full-width card per preset, stacked in letter order. Cards are toggle buttons
// (aria-pressed), so Tab/Enter/Space pick a preset; selection updates in place and keeps focus.

function _renderOnboarding(body, footer) {
  const cards = PRESETS.map((p) => {
    const selected = _preset?.value === p.value;
    return `
      <button type="button" class="setup-modal-preset-card${selected ? ' is-selected' : ''}" data-letter="${p.letter}" aria-pressed="${selected}">
        <span class="setup-modal-preset-letter">${p.letter}</span>
        <span class="setup-modal-preset-text">
          <span class="setup-modal-preset-name">${_esc(p.name)}</span>
          <span class="setup-modal-preset-desc">${_esc(p.desc)}</span>
        </span>
      </button>
    `;
  }).join('');

  body.innerHTML = `
    ${stepHead(t('wizard.choosePreset'), { hint: t('wizard.presetHint') })}
    <div class="setup-modal-preset-grid" role="group" aria-labelledby="wiz-step-heading" aria-describedby="wiz-step-hint">${cards}</div>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-preset-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn" ${_preset ? '' : 'disabled'}>${_esc(t('common.next'))}</button>
  `;

  const nextBtn = footer.querySelector('#wiz-next-btn');
  const msg = body.querySelector('#wiz-preset-msg');
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _move(-1));

  const cardEls = [...body.querySelectorAll('.setup-modal-preset-card')];
  cardEls.forEach((card) => {
    card.addEventListener('click', () => {
      _preset = PRESETS.find(p => p.letter === card.dataset.letter) || null;
      for (const c of cardEls) {
        c.classList.toggle('is-selected', c === card);
        c.setAttribute('aria-pressed', String(c === card));
      }
      nextBtn.disabled = !_preset;
      msg.textContent = '';
    });
  });

  nextBtn.addEventListener('click', () => {
    if (!_preset) { msg.textContent = t('wizard.selectPreset'); return; }
    _move(1);
  });
}

// ── Step 7: Confirm ───────────────────────────────────────────────────────────

function _renderConfirm(body, footer) {
  // The summary and IPC payload use the same onboarding mode, including the implicit
  // compose mode when the user went Back and removed Software after choosing a code seed.
  const existing = _isExisting();
  const email = _userInfo?.email || '—';
  const projName = _apiProject?.name || '—';
  // A new project has no id yet: its badge says so. An existing one shows its #id.
  const projRef = _apiProject?.isNew
    ? `<span class="setup-modal-summary-badge">${_esc(t('wizard.newBadge'))}</span>`
    : `<span class="setup-modal-project-id">#${_esc(String(_apiProject?.id ?? '—'))}</span>`;
  const choseOnboarding = _steps().includes(6);
  const preset = choseOnboarding ? _preset : PRESETS[0];
  const presetLabel = choseOnboarding ? `${preset.letter} — ${preset.name}` : preset.name;
  const projectPresets = existing ? _apiProject.projectPresets : _workPresets;
  // (TPT9388) One aligned summary: every key in one column as wide as its longest label, each
  // value beside it, the project itself first.
  const row = (key, value, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><th scope="row" class="setup-modal-summary-key">${_esc(key)}</th><td class="setup-modal-summary-val">${value}</td></tr>`;
  const presetRow = existing ? '' : row(t('wizard.summaryPreset'), _esc(presetLabel));
  // The Default as its card named it ("Other Model" for Pi); `_taskAgent` stays the stored id.
  const agentLabel = _taskAgent ? getAgentDisplayLabel(_taskAgent, { pi: t('agentSelect.namePi') }, _agentList) : '—';
  const piEnabled = _availableAgents.includes('pi');
  // C1121 — one row per configured model. API keys are never shown in the summary.
  // C1130 — only when Pi ("Other Model") is the selected DEFAULT agent: an enabled
  // secondary Pi agent must not pair its OpenRouter model ids with another default's
  // Agent label. Mirrors setup-modal.js _renderStep5; save path still uses piEnabled.
  // (TPT172) computePiSaveRows() — the same filter the save below uses — so the summary lists
  // exactly what lands on disk (stored `openrouter/…` ids, trimmed, incomplete rows dropped)
  // even when _piModels still holds a display-form seed.
  const piRows = computePiSaveRows(_piModels);
  const modelRow = piEnabled && _taskAgent === 'pi'
    ? row(piRows.length > 1 ? t('agentSelect.models') : t('agentSelect.model'),
      piRows.length ? piRows.map(m => _esc(m.model.trim())).join('<br>') : '—')
    : '';

  body.innerHTML = `
    ${stepHead(existing ? t('wizard.confirmExistingProject') : t('wizard.confirmNewProject'))}
    <table class="setup-modal-summary">
      ${row(t('setup.summaryProject'), `<span class="setup-modal-summary-project">${identityMarkup(projName, _profile, _identityDraft, true)}${projRef}</span>`, 'setup-modal-summary-row--project')}
      ${row(t('wizard.summaryFolder'), `<span class="setup-modal-summary-path">${_esc(_projectPath || '—')}</span>`)}
      ${row(t('setup.summaryAccount'), _esc(email))}
      ${row(t('wizard.workPresets'), projectPresets.map(id => _esc(t('wizard.work.' + id))).join(', '))}
      ${row(t('wizard.summaryDevice'), _esc(_deviceName || '—'))}
      ${row(t('setup.summaryAgent'), _esc(agentLabel))}
      ${modelRow}
      ${presetRow}
    </table>
    ${policyMarkup(_profile?.policy)}
    <div class="setup-modal-msg" id="wiz-confirm-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-confirm-btn">${_esc(existing ? t('wizard.openProjectBtn') : t('wizard.createProjectBtn'))}</button>
  `;

  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _move(-1));

  footer.querySelector('#wiz-confirm-btn').addEventListener('click', () => {
    const detail = {
      projectPath: _projectPath,
      apiBaseUrl: _apiBaseUrl,
      userToken: _userToken,
      userInfo: _userInfo,
      apiProject: {
        ..._apiProject, projectPresets: [...projectPresets],
        ...(!existing && { identity: { ..._identityDraft },
          settings: Object.fromEntries(Object.entries(_profile.policy.rules).map(([field, rule]) => [field, rule.value])) }),
      },
      deviceName: _deviceName,
      agentPreference: {
        taskAgent: _taskAgent,
        availableAgents: [..._availableAgents],
        // C1121 — every row, trimmed, incomplete rows dropped, `provider` kept on non-OpenRouter
        // rows. Structured-clone-safe plain objects (this detail crosses IPC via
        // completeProjectWizard → project:create-from-wizard). Same helper setup-modal uses.
        piModels: piEnabled ? computePiSaveRows(_piModels) : [],
      },
      // (TPT557) null for an existing project — nothing to seed; index.js links the folder
      // via project:open-existing instead of project:create-from-wizard.
      preset: existing ? null : { letter: preset.letter, mode: preset.mode, value: preset.value },
      presetDescription: null,
    };
    window.dispatchEvent(new CustomEvent('wizard-complete', { detail }));
    if (_onComplete) try { _onComplete(detail); } catch {}
    close();
  });
}
