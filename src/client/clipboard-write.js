// Plain-text clipboard write for Copy buttons, with a fallback. No imports, so node tests load it
// directly with a fake document and clipboard.
//
// 1. navigator.clipboard.writeText() — the Async Clipboard API.
// 2. When that is missing or rejects, the reason is logged and the text goes through the legacy
//    path: a hidden read-only textarea, selected, and document.execCommand('copy'). Chromium
//    allows that during the click's user activation without asking any permission handler or
//    needing window focus, which is exactly what the first path can fail on: an Electron session
//    whose permission handler denies 'clipboard-sanitized-write' ("NotAllowedError: ... Write
//    permission denied."), a page without focus ("Document is not focused."), or a page that is
//    not a secure context (no navigator.clipboard at all).
//
// The textarea goes next to the button that asked (`anchor`), never at the end of <body>: a
// modal layer (dialog-focus.js, <dialog>) makes everything outside it inert and pulls focus back
// into itself, so a textarea there could not hold the selection. Keyboard focus and the page's
// own selection are put back afterwards.

const describe = (error) => {
  if (!error) return 'unknown error';
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error.message === 'string' && error.message ? error.message : String(error);
  return `${name}: ${message}`;
};

function execCommandCopy(text, doc, anchor) {
  if (!doc || typeof doc.execCommand !== 'function' || typeof doc.createElement !== 'function') {
    return { ok: false, error: new Error('document.execCommand is not available') };
  }
  const host = (anchor && anchor.parentNode) || doc.body || doc.documentElement;
  if (!host) return { ok: false, error: new Error('no element to hold the copy buffer') };
  const focused = doc.activeElement;
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
  const ranges = [];
  for (let i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));

  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.tabIndex = -1;
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;'
    + 'opacity:0;pointer-events:none;';
  host.appendChild(area);
  let ok = false;
  let error = null;
  try {
    area.focus({ preventScroll: true });
    area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy') === true;
    if (!ok) error = new Error('document.execCommand("copy") returned false');
  } catch (err) {
    error = err;
  } finally {
    area.remove();
    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      } catch { /* the old selection is gone with its nodes */ }
    }
    if (focused && focused !== doc.body && focused.isConnected !== false && typeof focused.focus === 'function') {
      try { focused.focus({ preventScroll: true }); } catch { /* not focusable any more */ }
    }
  }
  return { ok, error };
}

// Writes `text` to the system clipboard. Resolves `{ ok: true, method }` with method
// 'clipboard-api' or 'exec-command', or `{ ok: false, error }` when both paths failed — the only
// case a caller should report as a failure. Never rejects. `anchor` is the clicked button.
export async function writeClipboardText(text, {
  anchor = null,
  doc = globalThis.document,
  clipboard = globalThis.navigator ? globalThis.navigator.clipboard : undefined,
  log = globalThis.console,
} = {}) {
  if (typeof text !== 'string' || !text) return { ok: false, error: new Error('nothing to copy') };
  let firstError;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api' };
    } catch (err) {
      firstError = err;
    }
  } else {
    firstError = new Error('navigator.clipboard.writeText is not available');
  }
  log?.warn?.(`[clipboard] navigator.clipboard.writeText failed (${describe(firstError)}); trying document.execCommand('copy')`);
  const fallback = execCommandCopy(text, doc, anchor);
  if (fallback.ok) return { ok: true, method: 'exec-command' };
  log?.error?.(`[clipboard] document.execCommand('copy') failed too (${describe(fallback.error)}); nothing was copied`);
  return { ok: false, error: fallback.error || firstError };
}
