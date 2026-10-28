// Setup wizard — modal to link an existing Tipatask project to a project directory
// (setup mode: 5 steps, no API URL — the host is a fixed default, not user-entered) or
// to re-authenticate one (reauth mode: 4 steps, no device step — a re-auth never
// registers a new device). Triggered when open-project IPC returns { needsSetup: true }.
// (TPT161) Rebuilt on project-creation-wizard.js's layout/helpers: same header, same
// footer buttons, same Device name step, same t('wizard.*')-keyed device copy.
// (TPT9169) Import mode (openImport()) builds a NEW project from a Project ▸ Export archive:
// project name, folder and agents, then main's project:import-from-wizard does the rest.
import { renderAgentSelect, piCredentialsMissing, normalizePiModels, computePiSaveRows, loadAgents } from './agent-select.js';
import { recheckAgents, notifyServerAgentsSaved } from './agent-recheck.js';
import { headerHtml, fitHeaderPath } from './setup-modal-header.js';
import { DEFAULT_API_BASE_URL } from './constants.js';
import { isUnboundWindow } from './project-open-flow.js';
import { activateDialogFocus } from './dialog-focus.js';
// (C1388) This module re-renders its whole overlay per step (_render()/_renderStep()),
// so t() calls made INSIDE those render functions are naturally locale-live — never
// capture a t() result at module scope (i18n.js's own header rule).
import { t, tc, getLocale } from './i18n.js';

// ── Step navigation (pure, DOM-free — see setup-modal.test.js) ──
// Back navigation is a plain history-stack pop (see _goto/_back below) — no domain logic
// to unit-test there. The one piece of real navigation logic is the forward jump from
// 'signin': reauth with an already-known project (API_PROJECT_ID on existingConfig) skips
// the project picker entirely and goes straight to 'agent'.
const SETUP_STEPS = ['signin', 'project', 'device', 'agent', 'confirm'];
const REAUTH_STEPS = ['signin', 'project', 'agent', 'confirm'];
// 'account' — openReauth({ accountOnly: true }): app-level account swap with no project
// (Change Account on the default empty window). Sign-in runs setup:reauth-account, which
// authenticates and saves the account store itself; Confirm only summarizes the result.
const ACCOUNT_STEPS = ['signin', 'confirm'];
// 'import' — openImport() (TPT9169): a new project from an export archive. No project picker
// and no device step; Sign-in is skipped like setup mode's when an account is stored.
const IMPORT_STEPS = ['signin', 'name', 'folder', 'agent', 'confirm'];

export function stepsFor(mode) {
  if (mode === 'account') return ACCOUNT_STEPS;
  if (mode === 'import') return IMPORT_STEPS;
  return mode === 'reauth' ? REAUTH_STEPS : SETUP_STEPS;
}

export function nextStep(mode, from, { skipProject = false } = {}) {
  if (mode === 'account') return 'confirm';
  if (mode === 'import') return IMPORT_STEPS[IMPORT_STEPS.indexOf(from) + 1] || 'confirm';
  if (from === 'signin') return skipProject ? 'agent' : 'project';
  if (from === 'project') return mode === 'reauth' ? 'agent' : 'device';
  if (from === 'device') return 'agent';
  return 'confirm';
}

// Pure — C1122 persistence filter: only COMPLETE rows are saved — a model id, an API key
// unless the row's provider is keyless, a base URL on a custom-endpoint row (TPT191).
// The implementation lives in agent-select.js so the create wizard shares it; re-exported
// here to keep this module's public surface (and its tests) unchanged.
export { computePiSaveRows };

// Pure — the re-auth savedConfig shape. PI_MODELS is omitted (never written empty) when
// there are no complete rows; the legacy flat PI_MODEL/OPENROUTER_API_KEY are deleted ONLY
// when a fresh non-empty array replaces them — reauthSave is a full-file replace via
// writeProjectConfig, so this is the one place a pre-C1121 project's flat pair actually
// gets cleaned off disk (C1122). An empty agent pick (unreachable past the Agent step's Next gate)
// carries the existing TASK_AGENT/AVAILABLE_AGENTS forward and never invents one (TPT678).
export function buildReauthConfig({ baseCfg, apiBaseUrl, scopedToken, selectedProject, taskAgent, availableAgents, piSaveRows }) {
  const savedConfig = {
    ...baseCfg,
    projectName: selectedProject.name || baseCfg.projectName,
    TASK_BACKEND: 'api',
    API_BASE_URL: apiBaseUrl,
    API_TOKEN: scopedToken,
    API_PROJECT_ID: String(selectedProject.id),
    TASK_AGENT: taskAgent || baseCfg.TASK_AGENT,
    AVAILABLE_AGENTS: availableAgents.length ? availableAgents.join(',') : baseCfg.AVAILABLE_AGENTS,
    ...(piSaveRows.length ? { PI_MODELS: piSaveRows } : {}),
  };
  if (piSaveRows.length) { delete savedConfig.PI_MODEL; delete savedConfig.OPENROUTER_API_KEY; }
  return savedConfig;
}

// ── Import mode copy (pure, t-backed — see setup-modal.test.js) ──

// The Name step's starting value: the exported project's name, else the archive file name
// without archiveFileName()'s "-export.zip" ending.
export function defaultImportName(summary, archiveName) {
  const fromManifest = typeof summary?.projectName === 'string' ? summary.projectName.trim() : '';
  if (fromManifest) return fromManifest.slice(0, 255);
  return String(archiveName || '').replace(/\.zip$/i, '').replace(/-export$/i, '').trim().slice(0, 255);
}

// "Exported from “Acme” on 28 Oct 2026" — null when the manifest carries neither.
export function archiveOriginText(summary) {
  const name = typeof summary?.projectName === 'string' ? summary.projectName.trim() : '';
  const when = summary?.exportedAt ? new Date(summary.exportedAt) : null;
  const date = when && !Number.isNaN(when.getTime())
    ? when.toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  if (name && date) return t('import.exportedFrom', { name, date });
  if (date) return t('import.exportedOn', { date });
  if (name) return t('import.exportedFromName', { name });
  return null;
}

// The archive's contents the wizard reports: tasks, sprints, KB files.
export function archiveCountTexts(summary) {
  return [
    tc('import.tasks', Number(summary?.taskCount) || 0),
    tc('import.sprints', Number(summary?.sprintCount) || 0),
    tc('import.kbFiles', Number(summary?.kbFileCount) || 0),
  ];
}

function _fileList(keys) {
  const shown = keys.slice(0, 3).join(', ');
  return keys.length > 3 ? `${shown} ${t('import.moreFiles', { n: keys.length - 3 })}` : shown;
}

// The Folder step's message for main's project:import-folder-check answer (null while it runs):
// { kind: 'error' | 'warning' | 'muted' | '', text }. An error blocks Next; the warning says the
// folder already has ai/architecture files and which archive files it keeps instead of writing.
export function importFolderNotice(check) {
  if (!check) return { kind: 'muted', text: t('import.checkingFolder') };
  if (check.ok === false) return { kind: 'error', text: check.code === 'expired' ? t('import.errExpired') : t('import.folderInvalid') };
  if (check.blocked === 'configured') return { kind: 'error', text: t('import.folderConfigured') };
  if (check.blocked === 'open') return { kind: 'error', text: t('import.folderOpen') };
  if (check.blocked) return { kind: 'error', text: t('import.folderInvalid') };
  const parts = [];
  const archFiles = Number(check.architectureFiles) || 0;
  const kept = Array.isArray(check.existingKbFiles) ? check.existingKbFiles : [];
  if (archFiles > 0) parts.push(tc('import.folderHasKb', archFiles));
  if (kept.length) parts.push(tc('import.folderKeeps', kept.length, { files: _fileList(kept) }));
  else if (archFiles > 0) parts.push(t('import.folderAddsBeside'));
  return parts.length ? { kind: 'warning', text: parts.join(' ') } : { kind: '', text: '' };
}

// One `project:import-progress` frame → the Confirm step's status line.
export function importProgressText({ step, done, total } = {}) {
  if (step === 'tasks' && Number(total) > 0) return t('import.progress.tasksCount', { done: Number(done) || 0, total });
  const key = `import.progress.${step}`;
  const text = t(key);
  return text === key ? t('common.working') : text;
}

// project:import-from-wizard's { ok: false, code, … } answer → one message for the Confirm step.
export function importErrorText(res) {
  const r = res || {};
  const msg = r.error || t('project.unknownError');
  switch (r.code) {
    case 'expired': return t('import.errExpired');
    case 'busy': return t('import.errBusy');
    case 'name': return t('wizard.projectNameRequired');
    case 'signin': return t('import.errSignin');
    case 'folder': return importFolderNotice({ blocked: r.blocked || 'invalid' }).text;
    case 'archive': return t('import.errArchive');
    case 'create': return t('import.errCreate', { msg });
    case 'import': {
      const stepKey = `import.step.${r.step}`;
      const head = r.step && t(stepKey) !== stepKey ? t('import.errStep', { step: t(stepKey), msg }) : t('import.errFailed', { msg });
      return `${head} ${r.removed ? t('import.errRemoved') : t('import.errNotRemoved', { name: r.projectName || '' })}`;
    }
    default: return t('import.errFailed', { msg });
  }
}

let _projectPath = null;
let _step = 'signin';
let _history = []; // stack of previously-visited step ids, for _back()
let _openId = 0; // bumped by open()/openReauth()/close() — invalidates in-flight async callbacks from a superseded session
let _apiBaseUrl = DEFAULT_API_BASE_URL;
let _userToken = null;
let _userInfo = null;
let _projects = [];
let _selectedProject = null;
let _deviceName = '';
let _onComplete = null;
let _overlay = null;
let _keyHandler = null;
// (TPT561) dialog-focus.js layer — same contract as project-creation-wizard.js: an open Task Edit
// Modal's layer inerts every other <body> child, so this modal owns a layer on ONE overlay root
// that _render() repaints in place for the modal's whole life.
let _focusHandle = null;
let _busy = false;
let _mode = 'setup'; // 'setup' | 'reauth' | 'account'
// Setup mode only: true while open() checks the account store for a live sign-in
// (setup:stored-account). The Sign-in step shows a spinner until it resolves.
let _storedAccountPending = false;
// Account mode only: setup:reauth-account's { ok, user, apiBaseUrl } once the swap succeeded.
let _accountResult = null;
// Ask the web sign-in page for an account chooser (continue as the browser's current account vs.
// pick another) instead of silently handing back its existing session. True for the Project ▸
// Re-authenticate / Change Account menu path and once the user clicks "Use a different account".
let _chooseAccount = false;
let _existingConfig = null;
let _onCancel = null;
let _completed = false;
let _taskAgent = '';
let _availableAgents = [];
// C1122 — up to PI_MAX_MODELS {model,apiKey} rows, replacing the C1100 single-pair
// scalars. Mirror of project-creation-wizard.js's _piModels; always >= 1 row
// (normalizePiModels() invariant).
let _piModels = [{ model: '', apiKey: '' }];
// Import mode only (TPT9169): the pending import main checked — { importId, archiveName,
// summary } — the project name typed on the Name step, and main's answer about the chosen
// folder (_projectPath doubles as that folder; null until one is picked).
let _import = null;
let _importName = '';
let _folderCheck = null;

// (C1388) onCancel added — fires on any non-completed close() (mirrors openReauth's
// existing contract below). Lets a caller distinguish "cancelled" from "adopted" —
// used by template.html's _openSetupWizardForPath() to show a retry banner instead
// of silently leaving a real project window on a blank board when its wizard is
// dismissed without finishing.
export function open({ projectPath, onComplete, onCancel }) {
  if (_overlay) close();
  _mode = 'setup';
  _chooseAccount = false;
  _existingConfig = null;
  _projectPath = projectPath;
  _step = 'signin';
  _history = [];
  _openId++;
  _apiBaseUrl = DEFAULT_API_BASE_URL;
  _userToken = null;
  _userInfo = null;
  _projects = [];
  _selectedProject = null;
  _deviceName = '';
  _taskAgent = '';
  _availableAgents = [];
  _piModels = [{ model: '', apiKey: '' }];
  _onComplete = onComplete;
  // (C1388) Reset both explicitly — previously left whatever a prior openReauth()
  // call had set, so a stale _onCancel/_completed could survive into this flow.
  _onCancel = onCancel || null;
  _completed = false;
  _busy = false;
  _accountResult = null;
  _storedAccountPending = !!window.electronAPI?.setupStoredAccount;
  _render();
  _keyHandler = _escapeHandler;
  document.addEventListener('keydown', _keyHandler, { capture: true });
  if (_storedAccountPending) _adoptStoredAccount();
}

// (TPT9169) Project ▸ Import…: main checked the archive the user picked (main/project-import.js)
// and sent its summary with the pending import's id. Steps: Sign-in (skipped when an account is
// stored, as in setup mode), project name (the exported name, editable), folder, agents,
// Confirm. Confirm calls project:import-from-wizard, which creates the API project, imports the
// archive into the folder and opens the project window. onComplete({ projectPath, projectName,
// opened, report }) after a successful import; onCancel on any other close, which also releases
// the pending import in main (project:import-cancel) — Cancel creates nothing.
export function openImport({ importId, archiveName, summary, onComplete, onCancel }) {
  if (_overlay) close();
  _mode = 'import';
  _chooseAccount = false;
  _existingConfig = null;
  _projectPath = null;
  _step = 'signin';
  _history = [];
  _openId++;
  _apiBaseUrl = DEFAULT_API_BASE_URL;
  _userToken = null;
  _userInfo = null;
  _projects = [];
  _selectedProject = null;
  _deviceName = '';
  _taskAgent = '';
  _availableAgents = [];
  _piModels = [{ model: '', apiKey: '' }];
  _import = { importId, archiveName: archiveName || '', summary: summary || {} };
  _importName = defaultImportName(summary, archiveName);
  _folderCheck = null;
  _onComplete = onComplete || null;
  _onCancel = onCancel || null;
  _completed = false;
  _busy = false;
  _accountResult = null;
  _storedAccountPending = !!window.electronAPI?.setupStoredAccount;
  _render();
  _keyHandler = _escapeHandler;
  document.addEventListener('keydown', _keyHandler, { capture: true });
  if (_storedAccountPending) _adoptStoredAccount();
}

// Already signed in before the wizard opened (account store holds a live account-wide token
// for this server) → skip Sign-in and start on the project picker (import mode: the Name
// step). Back still reaches the "Signed in as X / Use a different account" variant of
// Sign-in. Any miss or failure falls back to the normal Sign-in step.
async function _adoptStoredAccount() {
  const gen = _openId;
  let acct = null;
  try { acct = await window.electronAPI.setupStoredAccount(_apiBaseUrl); } catch {}
  if (gen !== _openId || (_mode !== 'setup' && _mode !== 'import') || _step !== 'signin') return;
  _storedAccountPending = false;
  if (acct && acct.token && !_userToken) {
    _userToken = acct.token;
    _userInfo = acct.user || {};
    _history = ['signin'];
    _step = nextStep(_mode, 'signin');
  }
  _render();
}

// Re-auth flow: skip API-URL step, skip project pick when existing project is reusable.
// accountOnly — no project at all (default empty window): Sign-in → Confirm summary only,
// through setup:reauth-account. onComplete({ user, apiBaseUrl }) fires on the first close
// after a successful swap (Done, X or Escape alike); onCancel when closed before one.
// (TPT556) An unbound caller (no projectPath, or no API_PROJECT_ID on existingConfig —
// isUnboundWindow()) is forced into the account-only mode whatever accountOnly says: project
// re-auth would end in api:auth.reauth-save / reconfigureWindowBackend, which have nothing to
// write to for such a window. The caller's onComplete/onCancel are expected to bring Get
// Started back (template.html _openAccountReauth()).
export function openReauth({ projectPath, existingConfig, onComplete, onCancel, chooseAccount, accountOnly }) {
  if (_overlay) close();
  const unbound = isUnboundWindow({ projectPath, config: existingConfig });
  _mode = (accountOnly || unbound) ? 'account' : 'reauth';
  _storedAccountPending = false;
  _accountResult = null;
  _chooseAccount = !!chooseAccount;
  _existingConfig = existingConfig || {};
  _projectPath = projectPath;
  _apiBaseUrl = (_existingConfig.API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  _userToken = null;
  _userInfo = null;
  _projects = [];
  _deviceName = '';
  // Pre-select the previously linked project so Sign-in can skip the Project step.
  if (_existingConfig.API_PROJECT_ID) {
    _selectedProject = {
      id: Number(_existingConfig.API_PROJECT_ID),
      name: _existingConfig.projectName || `Project #${_existingConfig.API_PROJECT_ID}`,
    };
  } else {
    _selectedProject = null;
  }
  _step = 'signin';
  _history = [];
  _openId++;
  // Seed agent state from existing config so reauth pre-fills the picker
  _availableAgents = (_existingConfig?.AVAILABLE_AGENTS || '').split(',').filter(Boolean);
  _taskAgent = _existingConfig?.TASK_AGENT || '';
  // C1122 — full multi-row parity: PI_MODELS array wins (every row), legacy flat
  // PI_MODEL/OPENROUTER_API_KEY pair is the one-row fallback for pre-C1121 projects.
  // normalizePiModels() guarantees >= 1 row either way.
  _piModels = normalizePiModels({
    piModels: Array.isArray(_existingConfig?.PI_MODELS) ? _existingConfig.PI_MODELS : null,
    piModel: _existingConfig?.PI_MODEL,
    piApiKey: _existingConfig?.OPENROUTER_API_KEY,
  });
  _onComplete = onComplete;
  _onCancel = onCancel || null;
  _completed = false;
  _busy = false;
  _render();
  _keyHandler = _escapeHandler;
  document.addEventListener('keydown', _keyHandler, { capture: true });
}

// Capture-phase + stopPropagation: Escape closes only this modal, never also reaching
// template.html's document-level Task Edit Modal closer underneath.
function _escapeHandler(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  // (TPT9169) A running import cannot be abandoned midway: the wizard stays until it ends.
  if (_busy) { e.preventDefault(); return; }
  close();
}

export function close() {
  const wasOpen = !!_overlay;
  const completed = _completed; // capture before reset
  const accountDone = wasOpen && completed && _mode === 'account' ? _accountResult : null;
  const completeCb = accountDone ? _onComplete : null;
  // (TPT9169) An import wizard closed before its import ran releases the pending import in main.
  const releaseImportId = wasOpen && !completed && _mode === 'import' ? _import?.importId : null;
  if (_overlay) { _overlay.remove(); _overlay = null; }
  document.documentElement.style.overflowY = '';
  document.body.style.paddingRight = '';
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, { capture: true }); _keyHandler = null; }
  // Released before the callbacks run, so whatever they open lands on the layer below.
  _focusHandle?.close();
  _focusHandle = null;
  const cancelCb = (!completed && wasOpen) ? _onCancel : null;
  _projectPath = null;
  _onComplete = null;
  _onCancel = null;
  _completed = false;
  _busy = false;
  _history = [];
  _accountResult = null;
  _storedAccountPending = false;
  _import = null;
  _folderCheck = null;
  _openId++; // invalidate any in-flight timer/async callback from this session
  if (releaseImportId) { try { window.electronAPI?.cancelProjectImport?.(releaseImportId); } catch {} }
  if (cancelCb) { try { cancelCb(); } catch {} }
  if (completeCb) { try { completeCb({ user: accountDone.user || {}, apiBaseUrl: accountDone.apiBaseUrl }); } catch {} }
  // Dedicated setup window: cancel before completion closes the window.
  if (wasOpen && window._isSetupWindow) {
    window._isSetupWindow = false;
    if (!completed) window.electronAPI?.closeCurrentProject?.();
  }
}

// Forward navigation — pushes the current step onto the history stack so _back() can
// retrace the actual path taken (not a fixed prior step), which matters here because
// 'project' is reachable from both 'signin' and the Confirm step's "Change project…" link.
function _goto(step) {
  _history.push(_step);
  _step = step;
  _render();
}

// Back navigation — pops the history stack. An empty stack (Back from the first step ever
// shown this session) closes the modal, same as the X button/Escape.
function _back() {
  const prev = _history.pop();
  if (prev) { _step = prev; _render(); }
  else close();
}

function _render() {
  // A stray copy of this modal goes; this modal's own root stays. The create wizard
  // (.wizard-modal.setup-modal) is left alone: it owns its own dialog-focus layer, and removing
  // its root behind its back would leave that layer pointing at a detached element.
  document.querySelectorAll('.setup-modal:not(.wizard-modal)').forEach((el) => { if (el !== _overlay) el.remove(); });
  const fresh = !_overlay || !_overlay.isConnected;
  if (fresh) {
    _focusHandle?.close();
    _focusHandle = null;
    _overlay = document.createElement('div');
    _overlay.className = 'setup-modal';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
  }

  const STEP_LABELS = {
    signin: t('setup.stepSignIn'), project: t('setup.stepProject'), device: t('wizard.stepDevice'),
    name: t('import.stepName'), folder: t('import.stepFolder'),
    agent: t('setup.stepAgent'), confirm: t('setup.stepConfirm'),
  };
  const title = _mode === 'account' ? t('reauth.accountHeaderTitle')
    : _mode === 'import' ? t('import.headerTitle') : t('setup.headerTitle');
  const steps = stepsFor(_mode);
  const activeIdx = steps.indexOf(_step);
  const dots = steps.map((id, i) => {
    const cls = i < activeIdx ? 'is-done' : i === activeIdx ? 'is-active' : '';
    return `<span class="setup-modal-dot ${cls}" title="${STEP_LABELS[id]}"></span>`;
  }).join('');

  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel">
      ${headerHtml({ title, projectPath: _projectPath })}
      <div class="setup-modal-steps">${dots}</div>
      <div class="setup-modal-step-body" id="setup-step-body"></div>
      <div class="setup-modal-footer" id="setup-footer"></div>
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

  _overlay.querySelector('.setup-modal-close').addEventListener('click', () => { if (!_busy) close(); });

  _renderStep();
  // Repainting drops the focused element; steps that focus their own input already did.
  if (!_overlay.contains(document.activeElement)) _focusHandle.focusFirst();
}

function _renderStep() {
  const body = _overlay.querySelector('#setup-step-body');
  const footer = _overlay.querySelector('#setup-footer');

  if (_mode === 'account') {
    if (_step === 'confirm') _renderAccountConfirm(body, footer);
    else _renderAccountSignIn(body, footer);
    return;
  }
  if (_step === 'signin') _renderSignIn(body, footer);
  else if (_step === 'project') _renderProject(body, footer);
  else if (_step === 'device') _renderDevice(body, footer);
  else if (_step === 'name') _renderImportName(body, footer);
  else if (_step === 'folder') _renderImportFolder(body, footer);
  else if (_step === 'agent') _renderAgent(body, footer);
  else if (_step === 'confirm' && _mode === 'import') _renderImportConfirm(body, footer);
  else if (_step === 'confirm') _renderConfirm(body, footer);
}

// ── Sign in ──────────────────────────────────────────────────────────────────
// C1249: one plain "Sign in" button. Electron opens the web sign-in page in
// the system browser (Google SSO or email+password, user's choice there) and
// waits on a loopback callback — see authenticate() in src/cli/auth.js. The
// browser-mode branch (Task App opened in a plain browser, no Electron) keeps
// the existing Google-popup handoff, which is a different, project-scoped
// token path unrelated to this change.
// (TPT161) Always the first step in both modes — no API URL step precedes it — so it
// needs an "already signed in" variant (ported from project-creation-wizard.js's Step 1)
// for when Back returns here after a successful sign-in earlier in the same session.

function _renderSignIn(body, footer) {
  const isReauth = _mode === 'reauth';
  // skipProject: reauth already knows which project this is (API_PROJECT_ID on the
  // existing config) — skip straight to Agent. Recomputed on every entry (not just once)
  // since _refreshSelectedProjectName() can only run once a token exists.
  const skipProject = isReauth && !!(_selectedProject && _selectedProject.id);

  if (_storedAccountPending) {
    body.innerHTML = `<div class="setup-modal-spinner">${_esc(t('setup.checkingSignIn'))}</div>`;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-cancel-btn">${_esc(t('common.cancel'))}</button>
    `;
    footer.querySelector('#setup-cancel-btn').addEventListener('click', close);
    return;
  }

  if (_userToken) {
    const email = _userInfo?.email || t('setup.userFallback');
    body.innerHTML = `
      <p class="setup-modal-label">${_esc(t('wizard.signedIn'))}</p>
      <p class="setup-modal-hint">${t('setup.signedInAs', { email: `<strong>${_esc(email)}</strong>` })}</p>
      <div class="setup-modal-msg" id="setup-auth-msg"></div>
    `;
    footer.innerHTML = `
      <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-switch-btn">${_esc(t('wizard.useDifferentAccount'))}</button>
      <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn">${_esc(t('common.next'))}</button>
    `;
    footer.querySelector('#setup-switch-btn').addEventListener('click', () => {
      _userToken = null;
      _userInfo = null;
      _chooseAccount = true; // the user explicitly wants another account — don't auto-reuse the browser session
      _render();
    });
    footer.querySelector('#setup-next-btn').addEventListener('click', async () => {
      if (skipProject) await _refreshSelectedProjectName();
      _goto(nextStep(_mode, 'signin', { skipProject }));
    });
    return;
  }

  const heading = isReauth || _mode === 'import' ? t('setup.signInToContinue') : t('setup.signIn');
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(heading)}</p>
    <div class="setup-modal-row setup-modal-row--center" id="setup-auth-actions">
      <button class="setup-modal-btn setup-modal-btn--primary" id="setup-signin-btn">${_esc(t('setup.signIn'))}</button>
    </div>
    <p class="setup-modal-hint" id="setup-oauth-hint"></p>
    <div class="setup-modal-spinner" id="setup-oauth-spinner" style="display:none">${_esc(t('common.working'))}</div>
    <div class="setup-modal-msg" id="setup-oauth-msg"></div>
  `;

  // Sign-in is always the first step shown — there is nothing before it to go Back to.
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-cancel-btn">${_esc(t('common.cancel'))}</button>
  `;
  footer.querySelector('#setup-cancel-btn').addEventListener('click', close);

  const actions = body.querySelector('#setup-auth-actions');
  const spinner = body.querySelector('#setup-oauth-spinner');
  const hint = body.querySelector('#setup-oauth-hint');
  const msg = body.querySelector('#setup-oauth-msg');
  const signinBtn = body.querySelector('#setup-signin-btn');

  const runAuth = async () => {
    const gen = _openId; // guard: bail if the modal was closed/reopened while awaiting
    signinBtn.disabled = true;
    actions.style.display = 'none';
    spinner.style.display = '';
    msg.textContent = '';
    hint.textContent = t('setup.openingBrowserSignIn');

    if (window.electronAPI?.setupAuthWeb) {
      // Electron mode: opens the web sign-in page and waits on a loopback callback.
      try {
        const result = await window.electronAPI.setupAuthWeb(_apiBaseUrl, { chooseAccount: _chooseAccount });
        if (gen !== _openId) return;
        _userToken = result.token;
        _userInfo = result.user || {};
        spinner.style.display = 'none';
        hint.textContent = t('setup.signedInAs', { email: _userInfo.email || t('setup.userFallback') });
        hint.className = 'setup-modal-label';
        // In re-auth mode (skipping project picker), refresh name from API before confirm.
        if (skipProject) await _refreshSelectedProjectName();
        if (gen !== _openId) return;
        setTimeout(() => { if (gen === _openId) _goto(nextStep(_mode, 'signin', { skipProject })); }, 400);
      } catch (e) {
        if (gen !== _openId) return;
        spinner.style.display = 'none';
        msg.textContent = e.message || t('setup.signInFailed');
        msg.className = 'setup-modal-msg setup-modal-msg--error';
        hint.textContent = t('setup.signInFailedRetry');
        actions.style.display = '';
        signinBtn.disabled = false;
      }
    } else {
      // Browser mode (Task App opened in a plain browser, no Electron): Google
      // OAuth popup, unchanged — mints a project-scoped token directly.
      hint.textContent = t('setup.openingGoogleSignIn');
      try {
        // (TPT161) Only scope the popup's token to _selectedProject when this session
        // will actually skip the picker — otherwise a project chosen in an EARLIER
        // sign-in attempt (before "Use different account") would silently scope a
        // fresh browser-mode token to the wrong project.
        const projectId = skipProject ? _selectedProject.id : null;
        const qs = `popup=1${projectId ? `&project_id=${projectId}` : ''}`;
        const popupUrl = `${_apiBaseUrl}/api/auth/google/login?${qs}`;
        const popup = window.open(popupUrl, 'tipatask-reauth', 'width=520,height=640,left=100,top=100');

        const token = await new Promise((resolve, reject) => {
          let interval;
          const msgHandler = (event) => {
            if (event.data?.type !== 'tipatask-reauth-done') return;
            clearInterval(interval);
            window.removeEventListener('message', msgHandler);
            if (event.data.token) resolve(event.data.token);
            else reject(new Error(t('setup.noTokenInResponse')));
          };
          window.addEventListener('message', msgHandler);
          interval = setInterval(() => {
            if (popup && popup.closed) {
              clearInterval(interval);
              window.removeEventListener('message', msgHandler);
              reject(new Error(t('setup.signInWindowClosed')));
            }
          }, 500);
        });
        if (gen !== _openId) return;

        // In browser mode, _userToken holds the project-scoped token directly
        _userToken = token;
        _userInfo = {};
        spinner.style.display = 'none';
        hint.textContent = t('setup.signedIn');
        hint.className = 'setup-modal-label';
        // In re-auth mode (skipping project picker), refresh name from API before confirm.
        if (skipProject) await _refreshSelectedProjectName();
        if (gen !== _openId) return;
        setTimeout(() => { if (gen === _openId) _goto(nextStep(_mode, 'signin', { skipProject })); }, 400);
      } catch (e) {
        if (gen !== _openId) return;
        spinner.style.display = 'none';
        msg.textContent = e.message || t('setup.signInFailed');
        msg.className = 'setup-modal-msg setup-modal-msg--error';
        hint.textContent = t('setup.signInFailedRetry');
        actions.style.display = '';
        signinBtn.disabled = false;
      }
    }
  };

  signinBtn.addEventListener('click', runAuth);
}

// ── Project pick ──────────────────────────────────────────────────────────────

function _renderProject(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('setup.selectProject'))}</p>
    <div class="setup-modal-project-list" id="setup-proj-list">
      <div class="setup-modal-spinner">${_esc(t('setup.loadingProjects'))}</div>
    </div>
    <div class="setup-modal-msg" id="setup-proj-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn" disabled>${_esc(t('common.next'))}</button>
  `;
  const nextBtn = footer.querySelector('#setup-next-btn');
  // Back retraces the actual path here (history stack) — this step is reachable both
  // from Sign-in and from Confirm's "Change project…" link.
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);
  nextBtn.addEventListener('click', () => { if (_selectedProject) _goto(nextStep(_mode, 'project')); });

  const list = body.querySelector('#setup-proj-list');
  const msg = body.querySelector('#setup-proj-msg');
  const gen = _openId;

  (async () => {
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
      // API returns { projects: [...] } — unwrap to bare array (mirrors src/cli/setup.js:992).
      _projects = Array.isArray(raw) ? raw : (raw?.projects || raw?.data || []);
    } catch (e) {
      if (gen !== _openId) return;
      list.innerHTML = '';
      msg.textContent = t('setup.failedToLoadProjects', { msg: e.message });
      msg.className = 'setup-modal-msg setup-modal-msg--error';
      return;
    }
    if (gen !== _openId) return;

    if (!_projects.length) {
      list.innerHTML = `<p class="setup-modal-hint">${t('setup.noProjectsYet')}</p>`;
      return;
    }

    list.innerHTML = _projects.map((p) => `
      <div class="setup-modal-project-card" data-id="${_esc(String(p.id))}" data-name="${_esc(p.name || '')}">
        <span class="setup-modal-project-name">${_esc(p.name || t('setup.unnamedProject'))}</span>
        <span class="setup-modal-project-id">#${_esc(String(p.id))}</span>
      </div>
    `).join('');

    list.querySelectorAll('.setup-modal-project-card').forEach((card) => {
      card.addEventListener('click', () => {
        list.querySelectorAll('.setup-modal-project-card').forEach(c => c.classList.remove('is-selected'));
        card.classList.add('is-selected');
        _selectedProject = { id: Number(card.dataset.id), name: card.dataset.name };
        nextBtn.disabled = false;
      });
    });

    if (_selectedProject) {
      const prev = list.querySelector(`[data-id="${_selectedProject.id}"]`);
      if (prev) { prev.classList.add('is-selected'); nextBtn.disabled = false; }
    }
  })();
}

// ── Device name ────────────────────────────────────────────────────────────────
// (TPT161) Setup mode only — reauth never registers a new device (REAUTH_STEPS has no
// 'device' entry). Behavioral copy of project-creation-wizard.js's own Device name step:
// required, Enter submits, async prefill from setupGetDeviceName() only while still blank.

function _renderDevice(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('wizard.deviceName'))}</p>
    <p class="setup-modal-hint">${_esc(t('wizard.deviceNameHint'))}</p>
    <div class="setup-modal-row">
      <input class="setup-modal-input" id="setup-device-input" type="text" maxlength="100"
        value="${_esc(_deviceName)}" placeholder="${_esc(t('wizard.deviceNamePlaceholder'))}" spellcheck="false" />
    </div>
    <div class="setup-modal-msg setup-modal-msg--error" id="setup-device-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn">${_esc(t('common.next'))}</button>
  `;

  const input = body.querySelector('#setup-device-input');
  const nextBtn = footer.querySelector('#setup-next-btn');
  const msg = body.querySelector('#setup-device-msg');
  nextBtn.disabled = input.value.trim().length === 0;
  input.addEventListener('input', () => { nextBtn.disabled = input.value.trim().length === 0; });
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);
  nextBtn.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val) { msg.textContent = t('wizard.deviceNameRequired'); return; }
    _deviceName = val;
    _goto(nextStep(_mode, 'device'));
  });
  input.focus();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !nextBtn.disabled) nextBtn.click(); });

  // Async prefill: look up this machine's previously used device name from the API.
  // Only fires when the field is still empty (user hasn't typed and _deviceName is blank).
  if (!_deviceName && window.electronAPI?.setupGetDeviceName) {
    const gen = _openId;
    window.electronAPI.setupGetDeviceName(_apiBaseUrl, _userToken).then((name) => {
      if (gen !== _openId || !name) return;
      const el = body.querySelector('#setup-device-input');
      if (el && el.value.trim().length === 0) { el.value = name; nextBtn.disabled = false; }
    }).catch(() => {});
  }
}

// ── Agent selection ──────────────────────────────────────────────────────────

function _renderAgent(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('setup.selectAgent'))}</p>
    <div id="setup-agent-select"><span class="setup-modal-hint">${_esc(t('setup.detectingAgents'))}</span></div>
    <div class="setup-modal-msg setup-modal-msg--error" id="setup-agent-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn">${_esc(t('common.next'))}</button>
  `;
  const nextBtn = footer.querySelector('#setup-next-btn');
  const msgEl = body.querySelector('#setup-agent-msg');
  // Back retraces the actual path (history stack): 'device' in setup mode, 'signin' or
  // 'project' in reauth depending on whether the project picker was skipped.
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);
  // Same contract as project-creation-wizard.js _renderStep4() (TPT174): Next stays enabled and
  // validates on click; the message answers that blocked click and any edit clears it. Every agent
  // unchecked leaves no Default — Confirm must never save an agent the user didn't pick.
  nextBtn.addEventListener('click', () => {
    if (!_taskAgent) { msgEl.textContent = t('wizard.selectDefaultAgent'); return; }
    if (piCredentialsMissing({ availableAgents: _availableAgents, piModels: _piModels })) {
      msgEl.textContent = t('agentSelect.fixOtherModelRows');
      return;
    }
    _goto('confirm');
  });

  const agentContainer = body.querySelector('#setup-agent-select');
  if (!agentContainer) return;

  const applyAgents = (agents) => {
    // Seed from reauth existing config or auto-init on first visit.
    // Guard: skip seeding when _taskAgent already set (reauth pre-fills from existingConfig).
    if (!_taskAgent) {
      const avail = agents.filter(a => a.available);
      _availableAgents = avail.map(a => a.id);
      _taskAgent = avail[0]?.id || '';
    }
    renderAgentSelect(agentContainer, {
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
  };

  // Server-first (agent-recheck.js): Electron main's detection cache is not the forked server's,
  // and the forked server is what serves the chat model selector.
  async function reCheck() {
    applyAgents(await recheckAgents());
  }

  (async () => { applyAgents(await loadAgents()); })();
}

// ── Confirm + save ───────────────────────────────────────────────────────────

// Product names stay untranslated (Claude Code, Codex) — "Other Model" is a
// description, not a product name, so it's the one entry that goes through i18n.
// project-creation-wizard.js has the identical table with the same treatment.
const _AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex', get pi() { return t('agentSelect.namePi'); } };

function _renderConfirm(body, footer) {
  const email = _userInfo?.email || '—';
  const projName = _selectedProject?.name || '—';
  const projId = _selectedProject?.id ?? '—';
  const isReauth = _mode === 'reauth';
  const titleLabel = isReauth ? t('setup.confirmReauth') : t('setup.confirmSetup');
  const agentLabel = _AGENT_LABELS[_taskAgent] || _taskAgent || '—';
  const piEnabled = _availableAgents.includes('pi');
  // C1122 — one row per configured model, mirroring project-creation-wizard.js's Step 6.
  // API keys are never shown in the summary.
  // C1130 — render the row only when Pi ("Other Model") is the selected DEFAULT agent,
  // not merely enabled: a Pi-only model id (openrouter/…) must never appear next to
  // "Agent: Claude Code"/"Codex". Saved rows are unaffected (piSaveRows below still
  // keys off piEnabled), so switching the default back to Pi restores the row.
  // (TPT172) computePiSaveRows() — the filter the save below uses — so the summary lists exactly
  // what lands on disk (a reauth seed from normalizePiModels() is display-form, prefix stripped).
  const piRows = computePiSaveRows(_piModels);
  const modelRow = piEnabled && _taskAgent === 'pi'
    ? `<tr><td class="setup-modal-summary-key">${_esc(piRows.length > 1 ? t('agentSelect.models') : t('agentSelect.model'))}</td>` +
      `<td class="setup-modal-summary-val">${piRows.length ? piRows.map(m => _esc(m.model.trim())).join('<br>') : '—'}</td></tr>`
    : '';
  // (TPT161) No API row — the host is no longer user-entered, so it's not part of the
  // summary either (matches project-creation-wizard.js's Confirm, which never showed one).
  const deviceRow = !isReauth
    ? `<tr><td class="setup-modal-summary-key">${_esc(t('wizard.summaryDevice'))}</td><td class="setup-modal-summary-val">${_esc(_deviceName || '—')}</td></tr>`
    : '';
  const changeProjectLink = isReauth
    ? `<div class="setup-modal-hint" style="margin-top:0.5rem"><a href="#" id="setup-change-project">${_esc(t('setup.changeProject'))}</a></div>`
    : '';

  body.innerHTML = `
    <p class="setup-modal-label">${_esc(titleLabel)}</p>
    <table class="setup-modal-summary">
      <tr><td class="setup-modal-summary-key">${_esc(t('wizard.summaryFolder'))}</td><td class="setup-modal-summary-val">${_esc(_projectPath || '—')}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryAccount'))}</td><td class="setup-modal-summary-val">${_esc(email)}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryProject'))}</td><td class="setup-modal-summary-val">${_esc(projName)} <span class="setup-modal-project-id">#${_esc(String(projId))}</span></td></tr>
      ${deviceRow}
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryAgent'))}</td><td class="setup-modal-summary-val">${_esc(agentLabel)}</td></tr>
      ${modelRow}
    </table>
    ${changeProjectLink}
    <div class="setup-modal-msg" id="setup-confirm-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-confirm-btn">${_esc(t('common.confirm'))}</button>
  `;
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);

  const changeLink = body.querySelector('#setup-change-project');
  if (changeLink) changeLink.addEventListener('click', (e) => { e.preventDefault(); _goto('project'); });

  const confirmBtn = footer.querySelector('#setup-confirm-btn');
  const msg = body.querySelector('#setup-confirm-msg');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    footer.querySelector('#setup-back-btn').disabled = true;
    msg.textContent = t('common.saving');
    msg.className = 'setup-modal-msg setup-modal-msg--muted';
    try {
      const baseCfg = isReauth && _existingConfig ? { ..._existingConfig } : {};
      let savedConfig;
      const piSaveRows = piEnabled ? computePiSaveRows(_piModels) : [];

      if (window.electronAPI?.setupExchangeProjectToken) {
        // Electron mode
        if (isReauth) {
          // Re-auth: exchange token only — skip device registration (device already registered).
          const scopedToken = await window.electronAPI.setupExchangeProjectToken(
            _apiBaseUrl, _userToken, _selectedProject.id
          );
          savedConfig = buildReauthConfig({
            baseCfg, apiBaseUrl: _apiBaseUrl, scopedToken, selectedProject: _selectedProject,
            taskAgent: _taskAgent, availableAgents: _availableAgents, piSaveRows,
          });
          await window.electronAPI.api.auth.reauthSave(savedConfig);
        } else {
          // Open-existing: full setup (device register + token exchange + config + KB) in main process.
          const res = await window.electronAPI.openExistingProject({
            projectPath: _projectPath,
            apiBaseUrl: _apiBaseUrl,
            userToken: _userToken,
            apiProject: { id: _selectedProject.id, name: _selectedProject.name },
            deviceName: _deviceName,
            taskAgent: _taskAgent,
            availableAgents: _availableAgents,
            piModels: piSaveRows,
          });
          if (!res?.ok) throw new Error(res?.error || t('setup.setupFailed'));
          // Build a minimal savedConfig for the onComplete({ path, config }) summary only.
          savedConfig = {
            ...baseCfg,
            projectName: _selectedProject.name || baseCfg.projectName,
            TASK_BACKEND: 'api',
            API_BASE_URL: _apiBaseUrl,
            API_PROJECT_ID: String(_selectedProject.id),
            TASK_AGENT: _taskAgent,
            AVAILABLE_AGENTS: _availableAgents.join(','),
          };
        }
      } else {
        // Browser mode: _userToken is already the project-scoped token from popup step
        savedConfig = {
          ...baseCfg,
          projectName: _selectedProject.name || baseCfg.projectName,
          TASK_BACKEND: 'api',
          API_BASE_URL: _apiBaseUrl,
          API_TOKEN: _userToken,
          API_PROJECT_ID: String(_selectedProject.id),
          TASK_AGENT: _taskAgent,
          AVAILABLE_AGENTS: _availableAgents.join(','),
          // C1122 — PI_MODELS array. This route is a {...existing, ...parsed} merge
          // (ws-handlers.js POST /api/project-config), so a stale flat PI_MODEL/
          // OPENROUTER_API_KEY on disk can survive here — harmless, every reader prefers
          // PI_MODELS. Omit (never write an empty array) when there's nothing to save.
          ...(piSaveRows.length ? { PI_MODELS: piSaveRows } : {}),
        };
        const saveRes = await fetch('/api/project-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(savedConfig),
        });
        if (!saveRes.ok) throw new Error(t('setup.configSaveFailed', { status: saveRes.status }));
      }

      // None of the save branches above leaves the FORKED server's agent detection fresh: the
      // Electron ones write from main (separate detect caches, and main's `websocket` can't reach
      // the server's clients), the browser one writes config.json with no re-detect. This is the
      // same zero-fs re-detect + broadcast agents-modal.js triggers after its own IPC write.
      // _projectPath explicitly — a dedicated setup window has no ?projectPath= in location.search
      // until project:changed rewrites it. Fire-and-forget: nothing below depends on it.
      void notifyServerAgentsSaved(_projectPath, {
        taskAgent: _taskAgent,
        availableAgents: _availableAgents,
      });

      msg.textContent = isReauth ? t('setup.reauthenticatedOk') : t('setup.setupCompleteOk');
      msg.className = 'setup-modal-msg setup-modal-msg--ok';
      const cb = _onComplete;
      const path = _projectPath;
      _completed = true;
      setTimeout(() => {
        close();
        if (cb) cb({ path, config: savedConfig });
      }, 300);
    } catch (e) {
      msg.textContent = t('common.error', { msg: e.message });
      msg.className = 'setup-modal-msg setup-modal-msg--error';
      confirmBtn.disabled = false;
      footer.querySelector('#setup-back-btn').disabled = false;
    }
  });
}

// ── Import: Name, Folder, Confirm (mode 'import', TPT9169) ─────────────────────────
// The Agent step is _renderAgent() above. Every control is a native button or input, so the
// steps work from the keyboard: Enter on the name moves on, Choose Folder opens the folder
// dialog and hands focus to Next once the folder is usable, Escape cancels (not while the
// import runs).

function _archiveCardHtml() {
  const origin = archiveOriginText(_import.summary);
  return `
    <div class="setup-modal-archive">
      <div class="setup-modal-archive-name">${_esc(_import.archiveName)}</div>
      ${origin ? `<div class="setup-modal-archive-meta">${_esc(origin)}</div>` : ''}
      <div class="setup-modal-archive-counts">
        ${archiveCountTexts(_import.summary).map((text) => `<span class="setup-modal-archive-count">${_esc(text)}</span>`).join('')}
      </div>
    </div>
  `;
}

function _renderImportName(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('import.fromArchive'))}</p>
    ${_archiveCardHtml()}
    <label class="setup-modal-form-label" for="setup-import-name">${_esc(t('wizard.projectName'))}</label>
    <div class="setup-modal-row">
      <input class="setup-modal-input" id="setup-import-name" type="text" maxlength="255"
        value="${_esc(_importName)}" placeholder="${_esc(t('wizard.projectNamePlaceholder'))}" spellcheck="false" />
    </div>
    <p class="setup-modal-hint">${_esc(t('import.nameHint'))}</p>
    <div class="setup-modal-msg setup-modal-msg--error" id="setup-import-name-msg"></div>
  `;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn">${_esc(t('common.next'))}</button>
  `;
  const input = body.querySelector('#setup-import-name');
  const msg = body.querySelector('#setup-import-name-msg');
  const nextBtn = footer.querySelector('#setup-next-btn');
  nextBtn.disabled = !input.value.trim();
  input.addEventListener('input', () => {
    _importName = input.value;
    nextBtn.disabled = !input.value.trim();
    msg.textContent = '';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !nextBtn.disabled) nextBtn.click(); });
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);
  nextBtn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) { msg.textContent = t('wizard.projectNameRequired'); return; }
    _importName = name;
    _goto(nextStep(_mode, 'name'));
  });
  input.focus();
}

function _renderImportFolder(body, footer) {
  const notice = _projectPath ? importFolderNotice(_folderCheck) : { kind: '', text: '' };
  const usable = !!_projectPath && !!_folderCheck && _folderCheck.ok !== false && !_folderCheck.blocked;
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('import.folderLabel'))}</p>
    <p class="setup-modal-hint">${_esc(t('import.folderHint'))}</p>
    <div class="setup-modal-row setup-modal-folder-row">
      <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-import-folder-btn">${_esc(_projectPath ? t('import.changeFolder') : t('import.chooseFolder'))}</button>
      <span class="setup-modal-folder-path" id="setup-import-folder-path" title="${_esc(_projectPath || '')}">${_esc(_projectPath || '')}</span>
    </div>
    <div class="setup-modal-msg${notice.kind ? ` setup-modal-msg--${notice.kind}` : ''}" id="setup-import-folder-msg" aria-live="polite">${_esc(notice.text)}</div>
  `;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-next-btn"${usable ? '' : ' disabled'}>${_esc(t('common.next'))}</button>
  `;
  const chooseBtn = body.querySelector('#setup-import-folder-btn');
  const nextBtn = footer.querySelector('#setup-next-btn');
  footer.querySelector('#setup-back-btn').addEventListener('click', _back);
  nextBtn.addEventListener('click', () => { if (usable) _goto(nextStep(_mode, 'folder')); });
  chooseBtn.addEventListener('click', async () => {
    const gen = _openId;
    let folder = null;
    try { folder = await window.electronAPI?.selectFolder?.(); } catch { /* dialog failed — nothing picked */ }
    if (gen !== _openId || _step !== 'folder' || !folder) return;
    _projectPath = folder;
    _folderCheck = null;
    _render();
    let check;
    try { check = await window.electronAPI.checkImportFolder(_import.importId, folder); } catch { check = { ok: false, code: 'failed' }; }
    if (gen !== _openId || _projectPath !== folder) return;
    _folderCheck = check || { ok: false, code: 'failed' };
    if (_step === 'folder') _render();
  });
  (usable ? nextBtn : chooseBtn).focus();
}

function _renderImportConfirm(body, footer) {
  const s = _import.summary;
  const kept = Array.isArray(_folderCheck?.existingKbFiles) ? _folderCheck.existingKbFiles.length : 0;
  const kbValue = tc('import.files', Number(s.kbFileCount) || 0) + (kept ? ` · ${tc('import.kept', kept)}` : '');
  const agentLabel = _AGENT_LABELS[_taskAgent] || _taskAgent || '—';
  const piEnabled = _availableAgents.includes('pi');
  // Same Model row rule as _renderConfirm(): only when "Other Model" is the Default.
  const piRows = computePiSaveRows(_piModels);
  const modelRow = piEnabled && _taskAgent === 'pi'
    ? `<tr><td class="setup-modal-summary-key">${_esc(piRows.length > 1 ? t('agentSelect.models') : t('agentSelect.model'))}</td>` +
      `<td class="setup-modal-summary-val">${piRows.length ? piRows.map(m => _esc(m.model.trim())).join('<br>') : '—'}</td></tr>`
    : '';
  const row = (key, value) => `<tr><td class="setup-modal-summary-key">${_esc(key)}</td><td class="setup-modal-summary-val">${value}</td></tr>`;

  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('import.confirmTitle'))}</p>
    <table class="setup-modal-summary">
      ${row(t('import.summaryArchive'), _esc(_import.archiveName))}
      ${row(t('wizard.summaryFolder'), _esc(_projectPath || '—'))}
      ${row(t('setup.summaryAccount'), _esc(_userInfo?.email || '—'))}
      ${row(t('setup.summaryProject'), `${_esc(_importName)}<span class="setup-modal-summary-badge">${_esc(t('wizard.newBadge'))}</span>`)}
      ${row(t('import.summaryKb'), _esc(kbValue))}
      ${row(t('import.summaryTasks'), _esc(String(Number(s.taskCount) || 0)))}
      ${row(t('import.summarySprints'), _esc(String(Number(s.sprintCount) || 0)))}
      ${row(t('setup.summaryAgent'), _esc(agentLabel))}
      ${modelRow}
    </table>
    <div class="setup-modal-msg" id="setup-confirm-msg" aria-live="polite"></div>
  `;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-back-btn">${_esc(t('common.back'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-confirm-btn">${_esc(t('import.importBtn'))}</button>
  `;
  const backBtn = footer.querySelector('#setup-back-btn');
  const confirmBtn = footer.querySelector('#setup-confirm-btn');
  const msg = body.querySelector('#setup-confirm-msg');
  backBtn.addEventListener('click', _back);

  confirmBtn.addEventListener('click', async () => {
    if (_busy) return;
    const gen = _openId;
    const importId = _import.importId;
    _busy = true;
    confirmBtn.disabled = true;
    backBtn.disabled = true;
    msg.className = 'setup-modal-msg setup-modal-msg--muted';
    msg.textContent = importProgressText({ step: 'project' });
    const unsubscribe = window.electronAPI.onProjectImportProgress?.((frame) => {
      if (gen === _openId && frame?.importId === importId) msg.textContent = importProgressText(frame);
    });
    let res;
    try {
      res = await window.electronAPI.importProjectFromWizard({
        importId,
        projectName: _importName,
        projectPath: _projectPath,
        apiBaseUrl: _apiBaseUrl,
        userToken: _userToken,
        agentPreference: {
          taskAgent: _taskAgent,
          availableAgents: [..._availableAgents],
          piModels: piEnabled ? computePiSaveRows(_piModels) : [],
        },
      });
    } catch (e) {
      res = { ok: false, code: 'failed', error: e?.message };
    } finally {
      try { unsubscribe?.(); } catch {}
    }
    if (gen !== _openId) return; // closed meanwhile; main still finishes the import
    _busy = false;
    if (!res?.ok) {
      msg.className = 'setup-modal-msg setup-modal-msg--error';
      msg.textContent = importErrorText(res);
      if (res?.code === 'folder') _folderCheck = { ...(_folderCheck || {}), blocked: res.blocked || 'invalid' };
      // An expired import or a changed archive cannot be retried from here; anything else can,
      // into a new project (a failed import removes the project it created).
      confirmBtn.disabled = res?.code === 'expired' || res?.code === 'archive';
      backBtn.disabled = false;
      return;
    }
    msg.className = 'setup-modal-msg setup-modal-msg--ok';
    msg.textContent = t('import.doneOk');
    // Adopted in place, this window keeps its page: same forked-server re-detect as setup mode's
    // Confirm. A new window loads fresh and needs none.
    if (res.opened === 'current') {
      void notifyServerAgentsSaved(res.projectPath, { taskAgent: _taskAgent, availableAgents: _availableAgents });
    }
    const cb = _onComplete;
    const detail = { projectPath: res.projectPath, projectName: _importName, opened: res.opened || null, report: res.report || null };
    _completed = true;
    setTimeout(() => {
      close();
      if (cb) cb(detail);
    }, 300);
  });
}

// ── Account-only sign-in / summary (mode 'account') ─────────────────────────────
// One browser trip: setup:reauth-account authenticates with the account chooser AND saves the
// account store, so this mode never calls setupAuthWeb, the project-token exchange or
// api:auth.reauth-save. The renderer never sees the token here.

function _renderAccountSignIn(body, footer) {
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('reauth.accountSignInTitle'))}</p>
    <p class="setup-modal-hint">${_esc(t('reauth.accountSignInHint'))}</p>
    <div class="setup-modal-row setup-modal-row--center" id="setup-auth-actions">
      <button class="setup-modal-btn setup-modal-btn--primary" id="setup-signin-btn">${_esc(t('setup.signIn'))}</button>
    </div>
    <div class="setup-modal-spinner" id="setup-oauth-spinner" style="display:none">${_esc(t('setup.openingBrowserSignIn'))}</div>
    <div class="setup-modal-msg" id="setup-oauth-msg"></div>
  `;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-cancel-btn">${_esc(t('common.cancel'))}</button>
  `;
  footer.querySelector('#setup-cancel-btn').addEventListener('click', close);

  const actions = body.querySelector('#setup-auth-actions');
  const spinner = body.querySelector('#setup-oauth-spinner');
  const msg = body.querySelector('#setup-oauth-msg');
  const signinBtn = body.querySelector('#setup-signin-btn');
  const fail = (text) => {
    spinner.style.display = 'none';
    msg.textContent = text;
    msg.className = 'setup-modal-msg setup-modal-msg--error';
    actions.style.display = '';
    signinBtn.disabled = false;
  };

  signinBtn.addEventListener('click', async () => {
    if (!window.electronAPI?.reauthAccount) { fail(t('reauth.accountDesktopOnly')); return; }
    const gen = _openId;
    signinBtn.disabled = true;
    actions.style.display = 'none';
    spinner.style.display = '';
    msg.textContent = '';
    let res;
    try {
      // null → main picks the most recently signed-in server, else production.
      res = await window.electronAPI.reauthAccount(_existingConfig?.API_BASE_URL || null);
    } catch (e) {
      res = { ok: false, error: e?.message };
    }
    if (gen !== _openId) return;
    if (!res?.ok) { fail(res?.error || t('setup.signInFailed')); return; }
    _userInfo = res.user || {};
    _apiBaseUrl = res.apiBaseUrl || _apiBaseUrl;
    _accountResult = res;
    _completed = true; // the account store is already switched — a close from here reports it
    _goto(nextStep('account', 'signin'));
  });
}

function _renderAccountConfirm(body, footer) {
  const email = _userInfo?.email || t('setup.userFallback');
  body.innerHTML = `
    <p class="setup-modal-label">${_esc(t('reauth.accountSwitchedTitle'))}</p>
    <table class="setup-modal-summary">
      <tr><td class="setup-modal-summary-key">${_esc(t('setup.summaryAccount'))}</td><td class="setup-modal-summary-val">${_esc(email)}</td></tr>
      <tr><td class="setup-modal-summary-key">${_esc(t('reauth.summaryServer'))}</td><td class="setup-modal-summary-val">${_esc(_apiBaseUrl)}</td></tr>
    </table>
    <p class="setup-modal-hint">${_esc(t('reauth.accountOnlyHint'))}</p>
  `;
  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="setup-switch-btn">${_esc(t('wizard.useDifferentAccount'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="setup-done-btn">${_esc(t('common.done'))}</button>
  `;
  footer.querySelector('#setup-switch-btn').addEventListener('click', _back);
  footer.querySelector('#setup-done-btn').addEventListener('click', close);
}

// Fetch live project name from the API and update _selectedProject.name.
// Called in re-auth mode after sign-in, before showing the Confirm step,
// so the suggestion reflects the current API name instead of the stale local cache.
// Non-fatal: on any failure the existing cached name is kept.
async function _refreshSelectedProjectName() {
  if (_mode !== 'reauth' || !_selectedProject || !_selectedProject.id) return;
  try {
    let raw;
    if (window.electronAPI?.setupListProjects) {
      raw = await window.electronAPI.setupListProjects(_apiBaseUrl, _userToken);
    } else {
      const res = await fetch(`${_apiBaseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${_userToken}` },
      });
      if (!res.ok) return;
      raw = await res.json();
    }
    const projects = Array.isArray(raw) ? raw : (raw?.projects || raw?.data || []);
    const match = projects.find(p => Number(p.id) === Number(_selectedProject.id));
    if (match && match.name) _selectedProject = { ..._selectedProject, name: match.name };
  } catch { /* non-fatal — keep cached name */ }
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
