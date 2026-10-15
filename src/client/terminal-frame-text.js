// (TPT9002) Text for the server-sent terminal frames the console modal renders itself, and
// (TPT9010) for the error toast a start made without a terminal on screen shows instead.
//
// A terminal `error` frame and a `paste-image-error` frame carry a stable `code` (+ `params`,
// and for EAUTH a `reason`) beside the English `message` / `error` the server always sent.
// A known code renders its `terminal.error.*` / `terminal.pasteError.*` key in the project
// language; an uncoded frame, a code this bundle does not know, or a coded frame missing a
// param its template needs keeps the server text verbatim (older servers, raw fs errors). Keys
// are probed on the en table — the same rule as queue-reason.js — because t() echoes a missing
// key instead of failing. Pure, node-testable.

import { LOCALES, t } from './i18n.js';

// The key's text, or null when the key is unknown or a `{param}` the en template uses is absent
// — so a placeholder, an empty slot or "undefined" never reaches the terminal.
function render(key, params) {
  if (!Object.hasOwn(LOCALES.en, key)) return null;
  const given = params && typeof params === 'object' ? params : {};
  for (const m of String(LOCALES.en[key]).matchAll(/\{(\w+)\}/g)) {
    if (given[m[1]] == null) return null;
  }
  return t(key, given);
}

// (TPT9008) The refresh failure an EAUTH frame names: its `terminal.error.EAUTH.refresh.<code>` text,
// or the server's English sentence when the failure is uncoded or the code unknown.
function refreshErrorText(params) {
  const code = typeof params.refreshCode === 'string' ? params.refreshCode : '';
  return (code && render(`terminal.error.EAUTH.refresh.${code}`, params.refreshParams)) || params.refreshError;
}

export function errorFrameText(msg) {
  const fallback = typeof msg?.message === 'string' ? msg.message : '';
  const code = typeof msg?.code === 'string' ? msg.code : '';
  if (!code) return fallback;
  const base = `terminal.error.${code}`;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const reason = typeof msg.reason === 'string' ? msg.reason : '';
  if (code === 'EAUTH' && reason === 'expiring' && params.refreshError) {
    const text = render(`${base}.expiringNotRefreshed`, { when: params.when, error: refreshErrorText(params) });
    if (text != null) return text;
  }
  // (TPT9008) A reason can have an agent-specific sub-key — an ESTART install hint or login sentence
  // names its own CLI — which wins over the shared `<code>.<reason>` one. A reason sub-key that
  // cannot render (an older server sent no params) keeps the server's own, more specific sentence
  // rather than the generic one; a reason with no sub-key at all renders the plain code text.
  const agent = typeof params.agent === 'string' ? params.agent : '';
  const sub = reason
    ? [agent && `${base}.${reason}.${agent}`, `${base}.${reason}`].find((key) => key && Object.hasOwn(LOCALES.en, key))
    : null;
  if (sub) return render(sub, params) ?? fallback;
  return render(base, params) ?? fallback;
}

export function pasteErrorText(msg) {
  const code = typeof msg?.code === 'string' ? msg.code : '';
  const fallback = typeof msg?.error === 'string' ? msg.error : '';
  if (!code) return fallback;
  return render(`terminal.pasteError.${code}`, msg.params) ?? fallback;
}

// (TPT9010) The error toast text for a batch of starts made without a terminal on screen (sprint
// Play All, the bulk bar's Start). `starts` is [{ id, result }], each result as
// startTerminalSession() resolved it ({ ok, message }; undefined when the start threw). A start
// the server refused with an `error` frame reads "<task key>: <errorFrameText>" — the text the
// terminal's red line shows — and keys refused with the same text share one line. Empty when no
// start was refused that way: a timeout or a dropped socket carries no server text.
export function startFailureText(starts) {
  const keysByText = new Map();
  for (const { id, result } of Array.isArray(starts) ? starts : []) {
    if (!isRefusedStart(result)) continue;
    const text = errorFrameText(result.message) || t('terminal.status.error');
    if (!keysByText.has(text)) keysByText.set(text, []);
    keysByText.get(text).push(id);
  }
  return [...keysByText].map(([text, keys]) => `${keys.join(', ')}: ${text}`).join('\n');
}

// (TPT9013) A start the server refused: startTerminalSession() resolved { ok: false } with an
// `error` frame. A timeout, a socket that dropped without a frame, `session-ended`, or a start
// that threw (no result) is not a refusal — the server may still be starting that task.
export function isRefusedStart(result) {
  return !!result && result.ok === false && result.message?.type === 'error';
}

// (TPT9013) The tasks of one batch whose start was refused. `tasks` and `settled` line up as in
// startFailureText()'s callers: Promise.allSettled() over one start per task.
export function refusedStartTasks(tasks, settled) {
  return (Array.isArray(tasks) ? tasks : []).filter((_, i) => isRefusedStart(settled?.[i]?.value));
}
