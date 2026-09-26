// Unified connection-state subscriber for both Electron and browser modes.
// Dispatches window events:
//   auth:expired  — when backend reports 'unauthorized'
//   auth:refreshed — when backend reports 'connected' (after re-auth)

import { showApiStatusBanner } from './utils.js';

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
