// (TPT9139) The terminal header's permission-mode control, mounted next to the agent caption.
// A running task whose agent can switch live (the server's `supported`) gets a selector
// (permission-mode-select.js) offering only the allowed targets — never Plan once left; any other
// run keeps a static chip. Nothing here ever shows a mode the server has not confirmed: a request
// reads "Switching to {mode}…" with a spinner until the server's state frame lands, a confirmed
// switch toasts that the new mode applies, and a refused or failed one toasts why and falls back
// to the confirmed mode, its edge marked as failed while that toast is up.
import { renderPermissionModeSelect, bindPermissionModeSelect } from './permission-mode-select.js';
import { liveModeState, liveModeLabel, buildLiveModeOptions, liveModeErrorText, permissionModeIcon, permissionModeLabel } from './permission-mode.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const SPINNER = '<span class="session-spinner" aria-hidden="true"></span>';
// Outcome toasts carry a reason or a note to read: longer than showToast()'s 2s default.
const APPLIED_TOAST_MS = 5000;
const ERROR_TOAST_MS = 9000;

let nextName = 0;

// t: the i18n lookup. request(mode): requestPermissionMode()'s { ok, state } or { ok: false,
// reason }. toast(text, type, opts): showToast(). Feed update() every state the server sends —
// terminal-state's permissionModeState, session:permission-mode-changed, a sessionMeta seed on
// reattach — and call stop() once the process is gone.
export function createSessionModeControl({ t, request, toast }) {
  const name = `session-mode-${++nextName}`;
  const root = document.createElement('span');
  root.className = 'session-mode';
  root.hidden = true;
  const body = document.createElement('span');
  body.className = 'session-mode-body';
  // Announces "Switching to …"; the outcome toasts announce themselves.
  const status = document.createElement('span');
  status.className = 'session-mode-status';
  status.setAttribute('role', 'status');
  root.append(body, status);

  let live = liveModeState(null);
  let run = null;
  let running = false;
  let source = null;
  let select = null;
  let painted = null;
  let errorEdgeUntil = 0;
  let errorTimer = 0;

  function paint({ force = false } = {}) {
    const interactive = running && (live.supported || live.pending);
    const shown = interactive || !!live.confirmed;
    const pending = interactive && live.pending;
    // The chip of a stopped run names its confirmed mode, never a request it can no longer finish.
    const label = interactive ? liveModeLabel(live, t) : permissionModeLabel(live.confirmed, t);
    root.hidden = !shown;
    root.classList.toggle('session-mode-pending', pending);
    root.classList.toggle('session-mode-error', interactive && !pending && !!live.error && Date.now() < errorEdgeUntil);
    if (pending) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
    const key = [shown, interactive, label, live.confirmed, pending, live.error?.reason, live.error?.message, source].join('|');
    if (!force && key === painted) return;
    painted = key;
    const hadFocus = root.contains(document.activeElement);
    select?.destroy();
    select = null;
    status.textContent = pending ? label : '';
    if (!shown) { body.innerHTML = ''; return; }
    if (!interactive) {
      const fixed = t(source === 'project' ? 'terminal.permission.inherited' : 'terminal.permission.fixed');
      body.innerHTML = `<span class="session-mode-chip terminal-permission-mode" title="${escape(`${t('terminal.permission.run', { mode: label })}. ${fixed}`)}">${permissionModeIcon(live.confirmed)}<span class="session-mode-label">${escape(label)}</span></span>`;
      return;
    }
    const pendingTip = pending ? t('terminal.permission.pendingTip', {
      current: permissionModeLabel(live.confirmed, t), mode: permissionModeLabel(live.requested, t),
    }) : '';
    // While pending the only row is disabled: the trigger keeps focus but cannot open.
    const options = pending
      ? [{ value: '', label, hint: `${pendingTip} ${t('terminal.permission.notCancelled')}`, icon: SPINNER, selected: true, disabled: true }]
      : buildLiveModeOptions(live.confirmed, t, live.native);
    body.innerHTML = renderPermissionModeSelect({ name, options, t });
    body.querySelector('[role="listbox"]').classList.add('session-mode-menu');
    const trigger = body.querySelector('.permission-mode-select-trigger');
    trigger.setAttribute('aria-label', t('terminal.permission.control', { mode: label }));
    trigger.title = pending ? pendingTip : live.error ? liveModeErrorText(live, t) : t('terminal.permission.switchTip');
    if (pending) trigger.setAttribute('aria-disabled', 'true');
    select = bindPermissionModeSelect(body, choose);
    if (hadFocus) trigger.focus({ preventScroll: true });
  }

  function failed(text) {
    toast(text, 'error', { durationMs: ERROR_TOAST_MS });
    errorEdgeUntil = Date.now() + ERROR_TOAST_MS;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => paint(), ERROR_TOAST_MS + 50);
  }

  // The widget has already put the picked row on its trigger; repainting before this handler
  // returns swaps in "Switching to …" (or the confirmed mode again) before the next frame paints.
  function choose(mode) {
    const result = request(mode);
    if (result?.ok) {
      announce(result.state, run);
      return;
    }
    if (result?.reason && result.reason !== 'unchanged') {
      failed(liveModeErrorText({ ...live, requested: mode, pending: false, error: { reason: result.reason } }, t));
    }
    paint({ force: true });
  }

  // Toast the end of a request this view saw pending: an error says why and which mode stays in
  // force; a confirmation names the new mode and that a running action is not cancelled. Later
  // frames repeating that outcome, and an outcome replayed to a view that never saw the request,
  // stay quiet. (A pending frame with an error is the server refusing a second request: `busy`.)
  function announce(raw, startedAt) {
    const next = liveModeState(raw);
    const sameRun = !run || !startedAt || startedAt === run;
    if (sameRun && next.error && (live.pending || next.pending)) {
      failed(liveModeErrorText(next, t));
    } else if (sameRun && live.pending && !next.pending && !next.error && next.confirmed && next.confirmed === live.requested) {
      toast(`${t('terminal.permission.applied', { mode: permissionModeLabel(next.confirmed, t) })} ${t('terminal.permission.notCancelled')}`,
        'success', { durationMs: APPLIED_TOAST_MS });
    }
    live = next;
    if (startedAt) run = startedAt;
    paint();
  }

  return {
    root,
    get state() { return { ...live }; },
    get interactive() { return !!select; },
    update(raw, { startedAt = null, running: isRunning = running, source: runSource = source } = {}) {
      running = !!isRunning;
      source = runSource;
      announce(raw, Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null);
    },
    // The process is gone (exit, loss, error): the last confirmed mode stays as a static chip.
    stop() {
      running = false;
      paint();
    },
    destroy() {
      clearTimeout(errorTimer);
      select?.destroy();
      select = null;
      root.remove();
    },
  };
}
