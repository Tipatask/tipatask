// Project creation wizard — 6-step modal triggered by the create-project event.
// Collects: auth, API project (select/create), device name, agent selection, preset (A/B).
// Emits wizard-complete with all data. Does NOT write configs or call APIs — that
// is handled by a downstream listener.
import { renderAgentSelect, loadAgents, piCredentialsMissing, computePiSaveRows } from './agent-select.js';
import { recheckAgents } from './agent-recheck.js';
import { headerHtml, fitHeaderPath } from './setup-modal-header.js';
import { DEFAULT_API_BASE_URL } from './constants.js';
// (C1388) This module re-renders its whole overlay per step (_render()/_renderStep()),
// so t() calls made INSIDE those render functions are locale-live — never capture one
// in a module-level constant (i18n.js's own rule). PRESETS below uses getters for
// exactly this reason.
import { t } from './i18n.js';

const PRESETS = [
  {
    letter: 'A',
    get name() { return t('wizard.presetSpecName'); },
    mode: 'new',
    value: 'original-specification',
    get desc() { return t('wizard.presetSpecDesc'); },
  },
  {
    letter: 'B',
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
let _deviceName = '';
let _taskAgent = '';
let _availableAgents = [];
// C1121 — up to 8 {model, apiKey} rows, replacing the old single piModel/piApiKey pair.
// Always has >= 1 row (normalizePiModels() invariant); row 0 is the mirror used for the
// legacy piModel/piApiKey confirm-payload fields main.js still reads.
let _piModels = [{ model: '', apiKey: '' }];
let _preset = null;
let _onComplete = null;
let _overlay = null;
let _keyHandler = null;
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

export function open({ projectPath, onComplete }) {
  if (_overlay) close();
  _projectPath = projectPath;
  _step = 1;
  _apiProject = null;
  _deviceName = '';
  _taskAgent = '';
  _availableAgents = [];
  _piModels = [{ model: '', apiKey: '' }];
  _preset = null;
  _onComplete = onComplete || null;
  _openId++;
  _chooseAccount = false;
  // An in-memory sign-in from an earlier session of this wizard still wins (Step 1 shows it).
  _storedAccountPending = !_userToken && !!window.electronAPI?.setupStoredAccount;
  _render();
  _keyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', _keyHandler);
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
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  _onComplete = null;
  _storedAccountPending = false;
  _openId++;
}

function _goto(step) {
  _step = step;
  _render();
}

function _render() {
  const existing = document.querySelector('.wizard-modal');
  if (existing) existing.remove();

  _overlay = document.createElement('div');
  _overlay.className = 'wizard-modal setup-modal';

  const STEP_LABELS = [t('wizard.stepSignIn'), t('wizard.stepApiProject'), t('wizard.stepDevice'), t('wizard.stepAgent'), t('wizard.stepPreset'), t('wizard.stepConfirm')];
  const dots = STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n < _step ? 'is-done' : n === _step ? 'is-active' : '';
    return `<span class="setup-modal-dot ${cls}" title="${label}"></span>`;
  }).join('');

  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel">
      ${headerHtml({ title: t('wizard.headerTitle'), projectPath: _projectPath })}
      <div class="setup-modal-steps">${dots}</div>
      <div class="setup-modal-step-body" id="wiz-step-body"></div>
      <div class="setup-modal-footer" id="wiz-footer"></div>
    </div>
  `;

  document.body.appendChild(_overlay);
  fitHeaderPath(_overlay);

  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.paddingRight = scrollbarWidth + 'px';
  document.documentElement.style.overflowY = 'hidden';

  _overlay.querySelector('.setup-modal-close').addEventListener('click', close);
  _renderStep();
}

function _renderStep() {
  const body = _overlay.querySelector('#wiz-step-body');
  const footer = _overlay.querySelector('#wiz-footer');
  if (_step === 1) _renderStep1(body, footer);
  else if (_step === 2) _renderStep2(body, footer);
  else if (_step === 3) _renderStep3(body, footer);
  else if (_step === 4) _renderStep4(body, footer);  // Agent
  else if (_step === 5) _renderStep5(body, footer);  // Preset
  else if (_step === 6) _renderStep6(body, footer);  // Confirm
}

// ── Step 1: Sign in ──────────────────────────────────────────────────────────

function _renderStep1(body, footer) {
  if (_storedAccountPending) {
    body.innerHTML = `<div class="setup-modal-spinner">${_esc(t('setup.checkingSignIn'))}</div>`;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-cancel-btn">${_esc(t('common.cancel'))}</button>
    `;
    footer.querySelector('#wiz-cancel-btn').addEventListener('click', close);
    return;
  }

  if (_userToken) {
    const email = _userInfo?.email || t('setup.userFallback');
    body.innerHTML = `
      <p class="setup-modal-label">${_esc(t('wizard.signedIn'))}</p>
      <p class="setup-modal-hint">${t('setup.signedInAs', { email: `<strong>${_esc(email)}</strong>` })}</p>
      <div class="setup-modal-msg" id="wiz-auth-msg"></div>
    `;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-switch-btn">${_esc(t('wizard.useDifferentAccount'))}</button>
      <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn">${_esc(t('common.next'))}</button>
    `;
    footer.querySelector('#wiz-next-btn').addEventListener('click', () => _goto(2));
    footer.querySelector('#wiz-switch-btn').addEventListener('click', () => {
      _userToken = null;
      _userInfo = null;
      _chooseAccount = true;
      _render();
    });
    return;
  }

  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('setup.signIn'))}</p>
    <div class="setup-modal-row setup-modal-row--center" id="wiz-auth-actions">
      <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-signin-btn">${_esc(t('setup.signIn'))}</button>
    </div>
    <p class="setup-modal-hint" id="wiz-auth-hint"></p>
    <div class="setup-modal-spinner" id="wiz-auth-spinner" style="display:none">${_esc(t('wizard.openingBrowserEllipsis'))}</div>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-auth-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-cancel-btn">${_esc(t('common.cancel'))}</button>
  `;
  footer.querySelector('#wiz-cancel-btn').addEventListener('click', close);

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
    hint.textContent = t('setup.openingBrowserSignIn');
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

// ── Step 2: API project select / create ──────────────────────────────────────

function _renderStep2(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('wizard.selectOrCreateProject'))}</p>
    <div class="setup-modal-project-list" id="wiz-proj-list">
      <div class="setup-modal-spinner">${_esc(t('setup.loadingProjects'))}</div>
    </div>
    <div class="setup-modal-create-project-form" id="wiz-create-form">
      <label class="setup-modal-form-label" for="wiz-proj-name">${_esc(t('wizard.projectName'))}</label>
      <input class="setup-modal-input" id="wiz-proj-name" type="text" maxlength="255" placeholder="${_esc(t('wizard.projectNamePlaceholder'))}" spellcheck="false" />
      <label class="setup-modal-form-label" style="margin-top:0.6rem" for="wiz-proj-desc">${_esc(t('wizard.descriptionOptional'))}</label>
      <textarea class="setup-modal-textarea" id="wiz-proj-desc" maxlength="2000" rows="3" placeholder="${_esc(t('wizard.descriptionPlaceholder'))}"></textarea>
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

  let creatingNew = false;

  const selectCard = (card, proj) => {
    list.querySelectorAll('.setup-modal-project-card').forEach(c => c.classList.remove('is-selected'));
    if (card) card.classList.add('is-selected');
    creatingNew = !proj;
    createForm.classList.toggle('is-visible', creatingNew);
    if (creatingNew) {
      _apiProject = null;
      nextBtn.disabled = nameInput.value.trim().length === 0;
      setTimeout(() => nameInput.focus(), 50);
    } else {
      _apiProject = { id: proj.id, name: proj.name, isNew: false };
      nextBtn.disabled = false;
    }
  };

  nextBtn.addEventListener('click', () => {
    if (creatingNew) {
      const name = nameInput.value.trim();
      if (!name) { msg.textContent = t('wizard.projectNameRequired'); return; }
      _apiProject = { id: null, name, description: descInput.value.trim() || null, isNew: true };
    }
    if (_apiProject) _goto(3);
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
      list.innerHTML = '';
      msg.textContent = t('setup.failedToLoadProjects', { msg: e.message });
      return;
    }

    const newCard = `
      <div class="setup-modal-project-card" id="wiz-new-card" data-new="1">
        <span class="setup-modal-project-name">+ ${_esc(t('wizard.createNewProject'))}</span>
      </div>
    `;
    const existingCards = projects.map((p) => `
      <div class="setup-modal-project-card" data-id="${_esc(String(p.id))}" data-name="${_esc(p.name || '')}">
        <span class="setup-modal-project-name">${_esc(p.name || t('setup.unnamedProject'))}</span>
        <span class="setup-modal-project-id">#${_esc(String(p.id))}</span>
      </div>
    `).join('');
    list.innerHTML = newCard + existingCards;

    list.querySelector('#wiz-new-card').addEventListener('click', (e) => {
      selectCard(e.currentTarget, null);
    });

    list.querySelectorAll('.setup-modal-project-card:not(#wiz-new-card)').forEach((card) => {
      card.addEventListener('click', () => {
        selectCard(card, { id: Number(card.dataset.id), name: card.dataset.name });
      });
    });

    if (_apiProject && !_apiProject.isNew) {
      const prev = list.querySelector(`[data-id="${_apiProject.id}"]`);
      if (prev) selectCard(prev, { id: _apiProject.id, name: _apiProject.name });
    }
  })();
}

// ── Step 3: Device name ───────────────────────────────────────────────────────

function _renderStep3(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('wizard.deviceName'))}</p>
    <p class="setup-modal-hint">${_esc(t('wizard.deviceNameHint'))}</p>
    <input class="setup-modal-input" id="wiz-device-input" type="text" maxlength="100"
      value="${_esc(_deviceName)}" placeholder="${_esc(t('wizard.deviceNamePlaceholder'))}" spellcheck="false" />
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
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _goto(2));
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
    <p class="setup-modal-label">${_esc(t('wizard.chooseAgent'))}</p>
    <div id="wiz-agent-select"><span class="setup-modal-hint">${_esc(t('setup.detectingAgents'))}</span></div>
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
    _goto(5);
  });

  const container = body.querySelector('#wiz-agent-select');

  // Fetch + apply agents. force=true busts the main-process detection caches
  // (resolveBin null-cache + cachedDetect TTL) so a just-installed agent is seen.
  const applyAgents = (agents) => {
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

// ── Step 5: Preset (A/B) ──────────────────────────────────────────────────────

function _renderStep5(body, footer) {
  const cards = PRESETS.map((p) => {
    const sel = _preset?.letter === p.letter ? 'is-selected' : '';
    return `
      <div class="setup-modal-preset-card ${sel}" data-letter="${p.letter}">
        <div class="setup-modal-preset-letter">${p.letter}</div>
        <div class="setup-modal-preset-name">${_esc(p.name)}</div>
        <div class="setup-modal-preset-desc">${_esc(p.desc)}</div>
      </div>
    `;
  }).join('');

  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('wizard.choosePreset'))}</p>
    <div class="setup-modal-preset-grid">${cards}</div>
    <p class="setup-modal-hint">${_esc(t('wizard.presetHint'))}</p>
    <div class="setup-modal-msg setup-modal-msg--error" id="wiz-preset-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-next-btn" ${_preset ? '' : 'disabled'}>${_esc(t('common.next'))}</button>
  `;

  const nextBtn = footer.querySelector('#wiz-next-btn');
  const msg = body.querySelector('#wiz-preset-msg');
  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _goto(4));

  body.querySelectorAll('.setup-modal-preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      body.querySelectorAll('.setup-modal-preset-card').forEach(c => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      _preset = PRESETS.find(p => p.letter === card.dataset.letter);
      nextBtn.disabled = false;
      msg.textContent = '';
      _render();
    });
  });

  nextBtn.addEventListener('click', () => {
    if (!_preset) { msg.textContent = t('wizard.selectPreset'); return; }
    _goto(6);
  });
}

// ── Step 6: Confirm ───────────────────────────────────────────────────────────

function _renderStep6(body, footer) {
  const email = _userInfo?.email || '—';
  const projName = _apiProject?.name || '—';
  const projId = _apiProject?.isNew ? 'new' : (String(_apiProject?.id ?? '—'));
  const newBadge = _apiProject?.isNew ? `<span class="setup-modal-summary-badge">${_esc(t('wizard.newBadge'))}</span>` : '';
  const presetLabel = _preset ? `${_preset.letter} — ${_preset.name}` : '—';
  const agentLabel = _taskAgent || '—';
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
    ? `<tr><td class="setup-modal-summary-key">${_esc(piRows.length > 1 ? t('agentSelect.models') : t('agentSelect.model'))}</td>` +
      `<td class="setup-modal-summary-val">${piRows.length ? piRows.map(m => _esc(m.model.trim())).join('<br>') : '—'}</td></tr>`
    : '';

  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('wizard.confirmNewProject'))}</p>
    <table class="setup-modal-summary">
      <tr><td class="setup-modal-summary-key">${_esc(t('wizard.summaryFolder'))}</td><td class="setup-modal-summary-val">${_esc(_projectPath || '—')}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryAccount'))}</td><td class="setup-modal-summary-val">${_esc(email)}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryProject'))}</td><td class="setup-modal-summary-val">${_esc(projName)} <span class="setup-modal-project-id">#${_esc(projId)}</span>${newBadge}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('wizard.summaryDevice'))}</td><td class="setup-modal-summary-val">${_esc(_deviceName || '—')}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryAgent'))}</td><td class="setup-modal-summary-val">${_esc(agentLabel)}</td></tr>
      ${modelRow}
      <tr><td class="setup-modal-summary-key">${_esc(t('wizard.summaryPreset'))}</td><td class="setup-modal-summary-val">${_esc(presetLabel)}</td></tr>
    </table>
    <div class="setup-modal-msg" id="wiz-confirm-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="wiz-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="wiz-confirm-btn">${_esc(t('wizard.createProjectBtn'))}</button>
  `;

  footer.querySelector('#wiz-back-btn').addEventListener('click', () => _goto(5));

  footer.querySelector('#wiz-confirm-btn').addEventListener('click', () => {
    const detail = {
      projectPath: _projectPath,
      apiBaseUrl: _apiBaseUrl,
      userToken: _userToken,
      userInfo: _userInfo,
      apiProject: { ..._apiProject },
      deviceName: _deviceName,
      agentPreference: {
        taskAgent: _taskAgent,
        availableAgents: [..._availableAgents],
        // C1121 — every row, trimmed, incomplete rows dropped, `provider` kept on non-OpenRouter
        // rows. Structured-clone-safe plain objects (this detail crosses IPC via
        // completeProjectWizard → project:create-from-wizard). Same helper setup-modal uses.
        piModels: piEnabled ? computePiSaveRows(_piModels) : [],
      },
      preset: { letter: _preset.letter, mode: _preset.mode, value: _preset.value },
      presetDescription: null,
    };
    window.dispatchEvent(new CustomEvent('wizard-complete', { detail }));
    if (_onComplete) try { _onComplete(detail); } catch {}
    close();
  });
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
