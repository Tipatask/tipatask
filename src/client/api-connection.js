// Unified connection-state subscriber for both Electron and browser modes.
// Dispatches window events:
//   auth:expired  — when backend reports 'unauthorized'
//   auth:refreshed — when backend reports 'connected' (after re-auth)

import { showApiStatusBanner, showToast } from './utils.js';
import { pushNotification } from './notification-center.js';
import { describeDroppedMutation } from './mutation-drop-notice.js';
import { t } from './i18n.js';

let _reauthInFlight = false;

function _onStateChange(state) {
  if (state === 'unauthorized') {
    window.dispatchEvent(new CustomEvent('auth:expired', { detail: { source: 'connection-state' } }));
    // In browser mode, also open the reauth modal directly (no Electron IPC listener)
    if (!window.electronAPI?.api?.connection) {
      _openBrowserReauthModal();
    }
  } else if (state === 'connected') {
    _reauthInFlight = false;
    showApiStatusBanner('connected');
    window.dispatchEvent(new CustomEvent('auth:refreshed', { detail: {} }));
  }
}

async function _openBrowserReauthModal() {
  if (_reauthInFlight) return;
  _reauthInFlight = true;
  try {
    const res = await fetch('/api/project-config');
    if (!res.ok) { _reauthInFlight = false; return; }
    const { projectPath, config } = await res.json();
    window.TipTask?.setupModal?.openReauth({
      projectPath,
      existingConfig: config || {},
      onComplete: () => { _reauthInFlight = false; showApiStatusBanner('connected'); },
      onCancel: () => { _reauthInFlight = false; },
    });
  } catch {
    _reauthInFlight = false;
  }
}

// (TPT662) Offline-queued writes the reconnect drain could not replay — one persistent
// notification card per task plus a toast, so a save the user already saw succeed
// optimistically never vanishes silently. entries: [{ op, taskId, title, code, statusCode,
// message }], arriving as the `mutations-dropped` WS frame (browser mode / forked server) or
// the `api:mutations-dropped` IPC push (Electron main-process backend) — both wired in
// template.html, which also clears the pending-sync marks and re-reads the board.
export function handleMutationsDropped(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return;
  for (const entry of list) {
    const { tag, title, body } = describeDroppedMutation(entry, t);
    pushNotification({ tag, title, body, category: 'attention' });
  }
  const first = describeDroppedMutation(list[0], t);
  showToast(list.length === 1 ? `${first.title} — ${first.body.split('\n')[0]}` : `${first.title} (${list.length})`, 'error', { durationMs: 8000 });
}

let _initialized = false;

export function initApiConnection() {
  if (_initialized) return;
  _initialized = true;

  if (window.electronAPI?.api?.connection?.onChanged) {
    // Electron mode: IPC already handles the modal (template.html:2088-2126).
    // Still dispatch window events so chat-ui.js can react.
    window.electronAPI.api.connection.onChanged(({ state }) => _onStateChange(state));
    // Cover startup race: check current state before listener registered
    (async () => {
      try {
        const cur = await window.electronAPI.api.connection.state();
        if (cur === 'unauthorized') _onStateChange('unauthorized');
      } catch {}
    })();
    return;
  }

  // Browser mode: subscribe via SSE
  _connectSSE();
}

function _connectSSE() {
  let es = null;
  let _reconnectTimer = null;

  const connect = () => {
    es = new EventSource('/api/connection-state');

    es.onmessage = (event) => {
      try {
        const { state } = JSON.parse(event.data);
        if (state) _onStateChange(state);
      } catch {}
    };

    es.onerror = () => {
      es.close();
      clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(connect, 3000);
    };
  };

  connect();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && es && es.readyState === EventSource.CLOSED) {
      clearTimeout(_reconnectTimer);
      connect();
    }
  });
}
