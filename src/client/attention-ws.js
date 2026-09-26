// Electron uses this project-scoped WS instead of the board WS, avoiding per-window
// config clobbering and KB sync on reconnect. It also carries voice-model progress.
// Use window.TipTask for board/terminal callbacks: static imports would pull CSS and
// xterm into this module and break plain-node tests.
import state from './state.js';
import { buildWsUrl } from './ws-client.js';
import { clearDebounce, debugNotifyLog } from './notifications.js';
import { notifyTaskNeedsAttention, forgetTaskAttention } from './attention-notifications.js';
import { dismissNotification } from './notification-center.js';
import { raiseAttention, clearAttention, isTerminalOpenFor } from './attention-state.js';
import { applyActivitySnapshot, syncActivityChips } from './task-activity.js';
import { notifyTaskActivity } from './activity-notifications.js';

let _ws = null;
let _reconnectTimer = null;
let _backoffMs = 1000;
const BACKOFF_MAX_MS = 30000;

// Shared with the browser board WS. Notify here, independently of card rendering,
// and funnel all network attention-state changes through this handler. Unrelated frames
// leave attention state untouched.
export function handleAttentionMessage(msg) {
  if (msg.type === 'attention-needed') {
    debugNotifyLog('attention-needed', msg.taskId, msg.kind, msg.promptText);
    const prevDetail = state.attentionDetails.get(msg.taskId);
    // A different question inside the 30s debounce window re-notifies; a repaint of the
    // same one (identical promptText) does not. Must run BEFORE notifyTaskNeedsAttention()
    // below, whose notify() call is what actually consults the debounce.
    if (prevDetail && msg.promptText && prevDetail.promptText !== msg.promptText) {
      clearDebounce(msg.taskId);
      debugNotifyLog('debounce cleared (promptText changed)', msg.taskId);
    }
    raiseAttention(msg.taskId, { kind: msg.kind, promptText: msg.promptText, agent: msg.agent });
    window.TipTask?.taskBoard?.updateClaudeButtons?.();
    // Guarded: a notification failure must never break state bookkeeping or the repaint above.
    // (C1125) The catch used to swallow a throw here with zero trace — logged now under the
    // same debug flag instead of staying invisible.
    try { notifyTaskNeedsAttention(msg.taskId); } catch (err) { debugNotifyLog('notifyTaskNeedsAttention threw', msg.taskId, err); }
    return true;
  }
  if (msg.type === 'attention-cleared') {
    // (C1387) Sticky by design — a server clear alone must NOT put the ring out; only the user
    // opening the terminal (or the session ending) does. The one exception: the user IS
    // currently looking at this task's terminal, in which case the server clear is trustworthy
    // (they just answered it) and matches what _markAttentionSeen() would do anyway.
    if (isTerminalOpenFor(msg.taskId)) clearAttention(msg.taskId, 'server');
    window.TipTask?.taskBoard?.updateClaudeButtons?.();
    forgetTaskAttention(msg.taskId);
    // (C1137) Prompt genuinely resolved — a persistent in-app card demanding input for an
    // already-answered question is worse than no card. Called here, not inside
    // forgetTaskAttention() itself, since that fn is ALSO invoked from onNotifyFailed()
    // (attention-notifications.js) for a dropped OS send — there the in-app card is the only
    // surviving surface and must NOT be dismissed.
    dismissNotification(msg.taskId);
    return true;
  }
  if (msg.type === 'session-ended') {
    if (msg.taskId) {
      clearAttention(msg.taskId, 'session-ended');
      forgetTaskAttention(msg.taskId);
      dismissNotification(msg.taskId); // (C1137) same reasoning as attention-cleared above
    }
    window.TipTask?.taskBoard?.updateClaudeButtons?.();
    return true;
  }
  // (C1565) Descendant-count watchdog alert — deliberately a fourth frame type, not folded
  // into attention-needed: it can fire on a still-running, still-producing-output session
  // (a runaway build is BY DEFINITION active), which is exactly what attention-needed's own
  // server-side broadcastAttentionFor() refuses, and it must survive the normal
  // ATTENTION_STALE_MS auto-clear a genuine prompt match is subject to. Rides this same
  // socket for free (see tt-websocket.md); reuses the identical raise+notify sequence
  // attention-needed uses above so it renders/dismisses/notifies exactly like any other
  // attention ring — opening the task's terminal (console-modal.js's _markAttentionSeen(),
  // the single clear trigger) clears it the same way, at which point the terminal's own
  // printed notice (emitTerminalNotice, server-side) and the existing Terminate button (now
  // a process-group kill) are what the user acts on. (TPT357) `killed: true` means the watchdog
  // already terminated the tree (the session then ends via its normal exit path, which sends no
  // session-ended frame, so this ring survives until the user opens the terminal).
  if (msg.type === 'session-runaway') {
    debugNotifyLog('session-runaway', msg.taskId, msg.count, msg.threshold);
    // (TPT357) The kill frame lands one 30s sweep after the warn frame — exactly notify()'s own
    // 30s per-task debounce — so without this the kill's OS banner can be dropped as a repeat of
    // the warn's. Same rationale as the attention-needed branch's promptText-changed clear above.
    if (msg.killed) clearDebounce(msg.taskId);
    raiseAttention(msg.taskId, { kind: 'runaway', promptText: msg.promptText, agent: msg.agent, killed: !!msg.killed });
    window.TipTask?.taskBoard?.updateClaudeButtons?.();
    try { notifyTaskNeedsAttention(msg.taskId); } catch (err) { debugNotifyLog('notifyTaskNeedsAttention threw', msg.taskId, err); }
    return true;
  }
  return false;
}

// (TPT12) `task-activity` — someone else commented on/changed a task, per-task unread
// snapshot from task-change-poll.js. Deliberately a SIBLING to handleAttentionMessage above,
// not folded into it: it never touches state.attentionSessions/attentionDetails, so it falls
// outside that function's documented four-frame-type contract.
//
// Safe to call from both WS ladders (this socket, AND template.html's __board__ ladder in
// browser mode, which runs simultaneously with this one — see the C1193 comment above) with
// zero extra guarding: applyActivitySnapshot() diffs against the CURRENT state.taskActivity
// and overwrites it before returning, so a duplicate dispatch of the identical frame is a
// no-op on the second call (it diffs against what the first call just wrote). Exported so
// template.html's ladder can reach it via window.TipTask.attentionWs.
export function handleTaskActivityMessage(msg) {
  if (!msg || msg.type !== 'task-activity') return false;
  const rose = applyActivitySnapshot(msg.activity);
  syncActivityChips();
  for (const { taskId, latest } of rose) {
    const taskTitle = state.taskTitleById.get(taskId);
    // Guarded, same reasoning as notifyTaskNeedsAttention() above — a notification failure
    // must never break the chip repaint that already happened.
    try { notifyTaskActivity(taskId, { latest, taskTitle }); } catch (err) { debugNotifyLog('notifyTaskActivity threw', taskId, err); }
  }
  return true;
}

// Electron deliberately uses this narrow socket instead of __board__. Forward task state
// messages to template.html so both the mounted Objective view and the Tasks-section board
// (including the board behind an open terminal) stay current; other board mutations remain
// owned by the full board socket in browser mode.
export function forwardTaskStateMessage(msg) {
  if (!msg || (msg.type !== 'tasks-updated' && msg.type !== 'task:updated')) return false;
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return false;
  if (typeof CustomEvent !== 'function') return false;
  document.dispatchEvent(new CustomEvent('tiptask:task-state-update', { detail: msg }));
  return true;
}

function scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    _backoffMs = Math.min(BACKOFF_MAX_MS, Math.round(_backoffMs * 1.7));
    connectAttentionWs();
  }, _backoffMs + Math.random() * 300);
}

export function connectAttentionWs() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(_reconnectTimer);
  const ws = new WebSocket(buildWsUrl('__attention__'));
  _ws = ws;
  ws.onopen = () => {
    _backoffMs = 1000;
    // Self-heal: pick up anything missed while disconnected (or before this socket existed).
    // (C1058) taskBoard is a NESTED namespace on window.TipTask (only consoleModal and
    // recipeSidebar are spread — see index.js), so the un-nested form used here previously
    // was always undefined: this self-heal recovered state.attentionSessions but never
    // repainted the board, silently dropping anything that arrived while disconnected.
    window.TipTask?.fetchActiveSessions?.()
      .then(() => window.TipTask?.taskBoard?.updateClaudeButtons?.())
      .then(() => forwardTaskStateMessage({ type: 'tasks-updated' }))
      .catch(() => {});
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (handleAttentionMessage(msg)) return;
    if (handleTaskActivityMessage(msg)) return;
    if (forwardTaskStateMessage(msg)) return;
    // `providers:changed` — the server re-detected agents after a Settings ▸ Agents save.
    // Hand the payload to chat-ui.js through the same DOM event the save path itself uses,
    // so an already-open objective chat repaints its model selector. Handled on this socket
    // only (it is open in both Electron and browser mode) to avoid a double repaint. The
    // frame also reaches sockets with no project stamp, so drop one for another project.
    if (msg.type === 'providers:changed') {
      let mine = '';
      try { mine = new URLSearchParams(window.location.search).get('projectPath') || ''; } catch (_) { /* no location */ }
      if (msg.projectPath && mine && msg.projectPath !== mine) return;
      if (Array.isArray(msg.objectiveProviders)) {
        document.dispatchEvent(new CustomEvent('tiptask:providers-changed', { detail: msg }));
      }
      return;
    }
    // (C1193) Gated on Electron: the module-level `online`/`visibilitychange` listeners below
    // call connectAttentionWs() unconditionally, so in browser mode this socket can be open
    // alongside __board__ (which already dispatches voice-model:* via template.html) — without
    // this gate that's a double dispatch, e.g. two completion toasts for one download.
    if (window.electronAPI?.api && typeof msg.type === 'string' && msg.type.startsWith('voice-model:')) {
      window.TipTask?.taskBoard?.handleVoiceModelMessage?.(msg);
    }
    // (TPT345) Same Electron gate for the merge-job frames (merge:*) and the completion-time
    // dirty-worktree warning: browser mode already dispatches them from connectBoardWs().
    if (window.electronAPI?.api && typeof msg.type === 'string' && (msg.type.startsWith('merge:') || msg.type === 'worktree-dirty-on-complete')) {
      window.TipTask?.mergeBranchesModal?.handleMergeWsMessage?.(msg);
    }
  };
  ws.onclose = () => {
    if (_ws === ws) _ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

export function closeAttentionWs() {
  clearTimeout(_reconnectTimer);
  if (_ws) {
    try { _ws.close(); } catch (_) { /* already closed */ }
    _ws = null;
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => connectAttentionWs());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connectAttentionWs();
  });
}
