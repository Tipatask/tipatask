// ── WebSocket shared helpers ──

export function buildWsUrl(taskId, extraParams) {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${wsProto}//${location.host}/?taskId=${encodeURIComponent(taskId)}`;
  // Forward per-project context so the WS handler can scope chat-draft reads.
  const projectPath = new URLSearchParams(location.search).get('projectPath');
  if (projectPath) url += `&projectPath=${encodeURIComponent(projectPath)}`;
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }
  return url;
}

export function wsSend(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

export function startTerminalSession(taskId, extraParams, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(buildWsUrl(taskId, extraParams));
    let settled = false;
    let sawConfig = false;
    let terminalState = null;
    const timeout = setTimeout(() => finish(false), opts.timeoutMs || 15000);

    function finish(ok, message = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve({ ok, message });
    }

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'config') {
        sawConfig = true;
        if (terminalState) finish(true, terminalState);
      } else if (msg.type === 'terminal-state') {
        terminalState = msg;
        if (sawConfig) finish(true, msg);
      } else if (msg.type === 'error' || msg.type === 'session-ended') {
        finish(false, msg);
      }
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

export function terminateTaskSession(taskId, opts = {}) {
  return new Promise((resolve) => {
    const useExistingWs = opts.useExistingWs === true && opts.ws && opts.ws.readyState === WebSocket.OPEN;
    const ownedWs = !useExistingWs;
    const ws = ownedWs ? new WebSocket(buildWsUrl(taskId, { terminate: '1' })) : opts.ws;
    let settled = false;
    let killSent = false;
    const timeout = setTimeout(() => finish(false), opts.timeoutMs || 5000);

    function cleanup() {
      clearTimeout(timeout);
      if (ws.removeEventListener) {
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('open', onOpen);
      }
      if (ownedWs && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    }

    function finish(ok, message = null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok, message });
    }

    function sendKill() {
      if (killSent || ws.readyState !== WebSocket.OPEN) return;
      killSent = true;
      ws.send(JSON.stringify({ type: 'kill' }));
    }

    function onOpen() {
      if (!ownedWs) sendKill();
    }

    function onMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'session-ended' && (!msg.taskId || msg.taskId === taskId)) finish(true, msg);
      else if (msg.type === 'error') finish(false, msg);
    }

    function onError() {
      finish(false);
    }

    function onClose() {
      if (killSent) finish(false);
    }

    if (ws.addEventListener) {
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('open', onOpen);
    } else {
      ws.onmessage = onMessage;
      ws.onerror = onError;
      ws.onclose = onClose;
      ws.onopen = onOpen;
    }

    if (!ownedWs && ws.readyState === WebSocket.OPEN) sendKill();
  });
}

// (C1463) Objective tab close — teardown of every running terminal session under an
// objective's whole descendant tree, gated server-side by a fresh, unscoped, role-derived
// "every descendant closed" check (see ws-handlers.js's terminateChildren connect branch;
// never trust the client's own cosmetic tab tick for this decision — see objective-tabs.js's
// isObjectiveTabDone() doc comment). Two-phase: call with confirmed:false first — a
// { needsConfirm: true } reply means work is still open and the caller must show its own
// confirm dialog before re-calling with confirmed:true to actually kill anything.
//
// A dedicated short-lived socket (mirroring terminateTaskSession() below), not a message on
// the board socket: Electron never opens __board__, and __attention__ accepts no inbound
// messages, so neither transport would reach every client.
export function terminateObjectiveSessions(parentKey, { confirmed = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(buildWsUrl(parentKey, { terminateChildren: '1', confirmed: confirmed ? '1' : '0' }));
    let settled = false;
    // 15s, not terminateTaskSession()'s 5s default — the server-side check walks a full
    // unfiltered task-list fetch (getTasksUnfiltered(), api-backend.js) before it can even
    // answer the confirm question, on top of however many sessions the kill phase stops.
    const timeout = setTimeout(() => finish({ ok: false }), 15000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(result);
    }

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'objective-close-needs-confirm') finish({ needsConfirm: true });
      else if (msg.type === 'objective-sessions-terminated') finish({ ok: true, taskIds: msg.taskIds || [] });
      else if (msg.type === 'error') finish({ ok: false, message: msg.message });
      // Any other frame (e.g. a session-ended broadcast reaching this same unfiltered
      // socket — see websocket.js's broadcastToProject(), which this connection is never
      // scoped out of) is deliberately ignored — only the two frames above settle this call.
    };
    ws.onerror = () => finish({ ok: false });
    ws.onclose = () => finish({ ok: false });
  });
}

// Types the client sends to the server
export const WS_SEND_TYPES = {
  DATA: 'data',
  RESIZE: 'resize',
  KILL: 'kill',
  START: 'start',
  ABORT: 'abort',
  RESTART: 'restart',
  START_SPEC_CHAT: 'start-spec-chat',
  SPEC_CHAT_MESSAGE: 'spec-chat-message',
  APPLY_SPEC_UPDATE: 'apply-spec-update',
};

// ── api-status subscription ──
const _apiStatusSubscribers = new Set();

export function onApiStatus(cb) {
  _apiStatusSubscribers.add(cb);
  return () => _apiStatusSubscribers.delete(cb);
}

export function _notifyApiStatus(state, message, pendingCount = 0, pendingTaskIds = []) {
  for (const cb of _apiStatusSubscribers) {
    try { cb(state, message, pendingCount, pendingTaskIds); } catch (e) { console.error('[onApiStatus] subscriber error', e); }
  }
}

// Types the client receives from the server
export const WS_RECV_TYPES = {
  DATA: 'data',
  EXIT: 'exit',
  SESSION_ENDED: 'session-ended',
  ERROR: 'error',
  DETACHED: 'detached',
  OBJECTIVE_RESULT: 'objective-result',
  CHAT_HISTORY: 'chat-history',
  CHAT_HISTORY_RESET: 'chat-history-reset',
  CHAT_READY: 'chat-ready',
  TASK_CARDS: 'task-cards',
  GENERATION_ABORTED: 'generation-aborted',
  RESTARTED: 'restarted',
  TASKS_UPDATED: 'tasks-updated',
  CONTEXT_TRIMMED: 'context-trimmed',
  SPEC_SUGGESTION: 'spec-suggestion',
  SPEC_APPLIED: 'spec-applied',
  SPEC_APPLY_ERROR: 'spec-apply-error',
  // Granular task mutation events
  TASK_CREATED: 'task:created',
  TASK_UPDATED: 'task:updated',
  TASK_DELETED: 'task:deleted',
  TASKS_FINALIZED: 'tasks:finalized',
  // API connectivity state broadcasts
  API_STATUS: 'api-status',
  // (C1463) Objective tab close — see terminateObjectiveSessions() above
  OBJECTIVE_CLOSE_NEEDS_CONFIRM: 'objective-close-needs-confirm',
  OBJECTIVE_SESSIONS_TERMINATED: 'objective-sessions-terminated',
};
