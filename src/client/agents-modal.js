// Edit Agents shares wizard controls and CSS, but keeps its own modal state. Do not use
// .setup-modal: setup-modal.js removes that element whenever it repaints.
import {
  renderAgentSelect, piCredentialsMissing, loadAgents,
  normalizePiModels, computePiSaveRows,
} from './agent-select.js';
import { recheckAgents, fetchAgentStatusesFromServer, refreshObjectiveProviders } from './agent-recheck.js';
import { agentModelOptions, ensureAgentModels, agentModelsSignature } from './constants.js';
import { escapeAttr, projectHeader } from './utils.js';
import { t } from './i18n.js';
import state from './state.js';
import { activateDialogFocus } from './dialog-focus.js';

let _overlay = null;
let _keyHandler = null;
let _focusHandle = null;
let _onSaved = null;
let _draft = { taskAgent: '', availableAgents: [], piModels: [], clearPiModels: false, claudeModel: '', codexModel: '' };
// Selection as first loaded from disk, before renderAgentSelect()'s own stale-agent pruning
// or any user edit — diffed against the live _draft to show the "some agents were removed"
// note instead of a silent surprise at Save time.
let _loadedSnapshot = null;
// Raw [{id,label,available,reason}] from the last loadAgents() call — Save pushes this
// straight into state.agentStatuses so the renderer reflects it without a reload.
let _lastAgentStatuses = [];

export function openAgentsModal({ onSaved } = {}) {
  if (_overlay) close();
  _onSaved = onSaved || null;
  _render();
  _focusHandle = activateDialogFocus({
    root: _overlay,
    initialFocus: '.setup-modal-close',
  });
  // Capture-phase + stopPropagation so this doesn't also trigger the underlying
  // #settings-modal's own bubble-phase Escape listener (task-board.js initSettingsModal()).
  _keyHandler = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', _keyHandler, { capture: true });
  _load();
}

export function closeAgentsModal() { close(); }

function close() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, { capture: true }); _keyHandler = null; }
  _focusHandle?.close();
  _focusHandle = null;
  _onSaved = null;
  _loadedSnapshot = null;
}

function _render() {
  const existing = document.querySelector('.agents-modal');
  if (existing) existing.remove();

  _overlay = document.createElement('div');
  _overlay.className = 'agents-modal';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'agents-modal-title');

  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel">
      <div class="setup-modal-header">
        <span class="setup-modal-title" id="agents-modal-title">${escapeAttr(t('agentsModal.title'))}</span>
        <button class="setup-modal-close" type="button" aria-label="${escapeAttr(t('agentsModal.cancel'))}">&times;</button>
      </div>
      <div class="setup-modal-step-body" id="agents-modal-body">
        <span class="setup-modal-hint">…</span>
      </div>
      <div class="setup-modal-footer" id="agents-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(_overlay);
  _overlay.querySelector('.setup-modal-close').addEventListener('click', close);
  _overlay.querySelector('.setup-modal-backdrop').addEventListener('click', close);
}

// Load current selection: Electron via api:project.config() (re-reads disk — see
// api-router.js), browser via GET /api/agents-config. (TPT173) The PI_MODELS-array-vs-legacy-
// flat-pair choice and the openrouter/ strip both belong to normalizePiModels() — the same seed
// the create wizard and setup-modal use — so _draft.piModels lands in DISPLAY form and
// _save()'s computePiSaveRows() is the single place the prefix goes back on.
async function _load() {
  const owningOverlay = _overlay;
  let selection = null;
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      if (ctx?.config) {
        const cfg = ctx.config;
        selection = {
          // ctx.agents.taskAgent is the LAST_AGENT-resolved EFFECTIVE default (C1131),
          // matching the Settings row summary — pre-fill "what will actually run next".
          taskAgent: ctx.agents?.taskAgent || cfg.TASK_AGENT || '',
          availableAgents: ctx.agents?.availableAgents
            || String(cfg.AVAILABLE_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean),
          piModels: normalizePiModels({
            piModels: Array.isArray(cfg.PI_MODELS) && cfg.PI_MODELS.length ? cfg.PI_MODELS : null,
            piModel: cfg.PI_MODEL,
            piApiKey: cfg.OPENROUTER_API_KEY,
          }),
          claudeModel: cfg.CLAUDE_MODEL || '',
          codexModel: cfg.CODEX_MODEL || '',
        };
      }
    } else {
      const r = await fetch('/api/agents-config', { cache: 'no-store', headers: projectHeader() });
      if (r.ok) selection = (await r.json()).selection;
    }
  } catch (err) { console.error('[agents-modal] load failed:', err.message); }

  if (_overlay !== owningOverlay) return; // closed or replaced while this was in flight

  _draft = {
    taskAgent: selection?.taskAgent || '',
    availableAgents: selection?.availableAgents || [],
    // Display form (openrouter/ stripped) — same seed the wizards use; _save() re-applies the
    // prefix through computePiSaveRows(), so an untouched Save (onChange never fires) is lossless.
    piModels: normalizePiModels(selection || {}),
    clearPiModels: false,
    claudeModel: selection?.claudeModel || '',
    codexModel: selection?.codexModel || '',
  };
  _loadedSnapshot = { taskAgent: _draft.taskAgent, availableAgents: [..._draft.availableAgents] };
  _renderBody();
}

function _renderBody() {
  const owningOverlay = _overlay;
  const body = _overlay?.querySelector('#agents-modal-body');
  const footer = _overlay?.querySelector('#agents-modal-footer');
  if (!body || !footer) return;

  body.innerHTML = `
    <div id="agents-modal-grid"><span class="setup-modal-hint">${escapeAttr(t('setup.detectingAgents'))}</span></div>
    <p class="setup-modal-hint" id="agents-modal-pruned-note" hidden>${escapeAttr(t('agentsModal.prunedNote'))}</p>
    <div class="setup-modal-msg setup-modal-msg--error" id="agents-modal-msg"></div>
  `;

  footer.innerHTML = `
    <button class="setup-modal-btn setup-modal-btn--secondary" id="agents-modal-cancel">${escapeAttr(t('agentsModal.cancel'))}</button>
    <button class="setup-modal-btn setup-modal-btn--primary" id="agents-modal-save">${escapeAttr(t('agentsModal.save'))}</button>
  `;
  footer.querySelector('#agents-modal-cancel').addEventListener('click', close);
  const saveBtn = footer.querySelector('#agents-modal-save');
  const msg = body.querySelector('#agents-modal-msg');
  saveBtn.addEventListener('click', () => _save(saveBtn, msg));

  // C1161 — Claude/Codex model pickers render as a sibling block directly under their own
  // agent card (renderAgentSelect()'s opt-in `modelSelects`) instead of a detached section
  // below the grid. (TPT173) The Pi models sit in the SAME grid as their own top-level cards,
  // so this option is what interleaves the two kinds of row.
  // (C1505) `options` is rebuilt on every applyAgents() call from the live per-agent registry
  // (agentModelOptions() — falls back to constants.js's static CLAUDE_MODELS/CODEX_MODELS
  // until ensureAgentModels() resolves), not a fixed object, so a warm registry repaints these
  // project-default pickers the same way it repaints the task edit modal's Model select.
  const buildModelSelects = () => ({
    claude: { label: t('agentsModal.claudeModel'), options: agentModelOptions('claude'), defaultValue: 'opusplan' },
    codex: { label: t('agentsModal.codexModel'), options: agentModelOptions('codex'), placeholder: { value: '', label: t('modal.codexDefault') } },
  });

  const gridEl = body.querySelector('#agents-modal-grid');
  const applyAgents = (agents) => {
    if (_overlay !== owningOverlay) return;
    _lastAgentStatuses = agents;
    renderAgentSelect(gridEl, {
      agents,
      value: _draft,
      modelSelects: buildModelSelects(),
      onChange: ({ availableAgents, taskAgent, piModels, clearPiModels, claudeModel, codexModel }) => {
        _draft.availableAgents = availableAgents;
        _draft.taskAgent = taskAgent;
        _draft.piModels = piModels;
        _draft.clearPiModels = clearPiModels;
        _draft.claudeModel = claudeModel;
        _draft.codexModel = codexModel;
        _syncSaveGate(agents, saveBtn, msg);
      },
      onReCheck: reCheck,
    });
    _syncPrunedNote(body);
    _syncSaveGate(agents, saveBtn, msg);
  };

  // Server-first Re-Check (agent-recheck.js) — the forked server's detection caches are separate
  // from Electron main's, and it is the process that serves every objective-provider list.
  async function reCheck() {
    applyAgents(await recheckAgents());
  }

  (async () => { applyAgents(await loadAgents({ browserFallback: fetchAgentStatusesFromServer })); })();

  // (C1505) Warm the live model registry once and repaint the grid only if the list actually
  // changed — a signature match means the static fallback already matched the live list (or
  // the registry was already warm from an earlier open), so skip a needless re-render out from
  // under the user's in-progress edits. `applyAgents` renders from `_draft`, so a repaint here
  // never loses anything already picked.
  const modelsSigBefore = () => `${agentModelsSignature('claude')}|${agentModelsSignature('codex')}`;
  const _sigBeforeWarm = modelsSigBefore();
  void ensureAgentModels().then(() => {
    if (_overlay === owningOverlay && _lastAgentStatuses && modelsSigBefore() !== _sigBeforeWarm) applyAgents(_lastAgentStatuses);
  });
}

// Save disabled when: no installed agents at all (renderAgentSelect rendered the empty
// state — onChange never fires, so _draft would be stale from disk), nothing enabled
// (user unchecked everything), or Pi is enabled with an incomplete/duplicate row.
function _syncSaveGate(agents, saveBtn, msg) {
  const anyAvailable = (agents || []).some((a) => a.available);
  if (!anyAvailable) {
    saveBtn.disabled = true;
    msg.textContent = t('agentsModal.errNoAgents');
    return;
  }
  if (!_draft.taskAgent || !_draft.availableAgents.length) {
    saveBtn.disabled = true;
    msg.textContent = t('agentsModal.errNoSelection');
    return;
  }
  if (piCredentialsMissing(_draft)) {
    saveBtn.disabled = true;
    msg.textContent = t('agentsModal.errPi');
    return;
  }
  saveBtn.disabled = false;
  msg.textContent = '';
}

// renderAgentSelect() prunes a stale enabled/default agent (uninstalled, logged out) and
// re-emits during its OWN initial render — before the user touches anything — so _draft can
// already differ from what was on disk by the time this runs. Diff against the snapshot
// captured in _load() (before any render) rather than assume silence means no change.
function _syncPrunedNote(body) {
  const note = body.querySelector('#agents-modal-pruned-note');
  if (!note || !_loadedSnapshot) return;
  const pruned = _draft.taskAgent !== _loadedSnapshot.taskAgent
    || _draft.availableAgents.length !== _loadedSnapshot.availableAgents.length
    || _draft.availableAgents.some((id) => !_loadedSnapshot.availableAgents.includes(id));
  note.hidden = !pruned;
}

async function _save(saveBtn, msg) {
  const owningOverlay = _overlay;
  saveBtn.disabled = true;
  const prevLabel = saveBtn.textContent;
  saveBtn.textContent = t('agentsModal.saving');
  msg.textContent = '';
  msg.className = 'setup-modal-msg';

  const selection = {
    taskAgent: _draft.taskAgent,
    availableAgents: _draft.availableAgents,
    piModels: _draft.availableAgents.includes('pi') ? computePiSaveRows(_draft.piModels) : [],
    clearPiModels: _draft.clearPiModels,
    claudeModel: _draft.claudeModel,
    codexModel: _draft.codexModel,
  };

  try {
    let agents;
    if (window.electronAPI?.api?.project?.saveAgents) {
      const res = await window.electronAPI.api.project.saveAgents(selection);
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      agents = res.agents;
      // The real per-window disk write already happened above via IPC — this only
      // refreshes THIS forked server's in-memory config singleton (zero fs, so it can't
      // fail the save even if it errors); see ws-handlers.js POST /api/agents-config.
      // Awaited (errors swallowed) so the providers re-fetch below runs AFTER the server's
      // post-save agent re-detect, not racing it.
      await fetch('/api/agents-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...projectHeader() },
        body: JSON.stringify({ ...selection, applyOnly: true }),
      }).catch(() => {});
    } else {
      const res = await fetch('/api/agents-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...projectHeader() },
        body: JSON.stringify(selection),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      agents = data.agents;
    }

    if (_overlay !== owningOverlay) return;
    // Refresh renderer state directly — no reload, no restart — so the start-task agent
    // picker (console-modal.js openAgentSelectorModal reads state.availableAgents) and
    // the Settings row label are correct immediately.
    state.taskAgent = agents.taskAgent;
    state.taskAgentLabel = agents.taskAgentLabel;
    state.availableAgents = agents.availableAgents;
    if (_lastAgentStatuses.length) state.agentStatuses = _lastAgentStatuses;
    document.dispatchEvent(new Event('tiptask:reload'));
    // Refresh the Pi model caption source for the start-task agent selector — and the
    // objective chat-model-selector, which only repaints on tiptask:providers-changed
    // (chat-ui.js). The server sends the `config` frame on WS connect only, never after a
    // save, so without this event a newly saved model stays invisible until a page reload.
    void refreshObjectiveProviders();

    const onSaved = _onSaved;
    close();
    if (onSaved) onSaved(agents);
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    saveBtn.disabled = false;
    saveBtn.textContent = prevLabel;
    msg.textContent = t('agentsModal.errSave', { msg: err.message });
    msg.className = 'setup-modal-msg setup-modal-msg--error';
  }
}
