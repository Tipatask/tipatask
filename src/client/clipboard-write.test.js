import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// (TPT9296) writeClipboardText(): the Async Clipboard API first; when it rejects or is missing, the
// logged fallback through a hidden textarea + document.execCommand('copy') beside the button.
const { writeClipboardText } = await import('./clipboard-write.js');

// Electron's rejection when the session's permission handler denies 'clipboard-sanitized-write'.
const DENIED = Object.assign(new Error("Failed to execute 'writeText' on 'Clipboard': Write permission denied."), { name: 'NotAllowedError' });

function page() {
  const window = new Window({ url: 'http://127.0.0.1:4455/todo.html' });
  const doc = window.document;
  doc.body.innerHTML = '<div class="task-chat"><p id="para">Some reply text</p>'
    + '<div class="task-chat-msg"><button id="copy" type="button">Copy</button></div>'
    + '<textarea id="composer"></textarea></div>';
  const logs = { warn: [], error: [] };
  const log = { warn: (msg) => logs.warn.push(String(msg)), error: (msg) => logs.error.push(String(msg)) };
  // What execCommand('copy') would put on the clipboard: the focused, selected text control's
  // selection. Records where that control sat and whether it was the active element.
  const copies = [];
  let execResult = true;
  doc.execCommand = (command) => {
    const el = doc.activeElement;
    const selected = el && typeof el.value === 'string' ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
    copies.push({ command, selected, tag: el && el.tagName, readOnly: !!(el && el.readOnly), parentId: el && el.parentNode && el.parentNode.className });
    if (execResult instanceof Error) throw execResult;
    return execResult;
  };
  return {
    window, doc, logs, log, copies,
    setExecResult(value) { execResult = value; },
    button: doc.getElementById('copy'),
    close: () => window.happyDOM.abort(),
  };
}

function fakeClipboard(behaviour) {
  const writes = [];
  return {
    writes,
    writeText: async (text) => {
      writes.push(text);
      if (behaviour instanceof Error) throw behaviour;
    },
  };
}

test('the Async Clipboard API is used when it works: no fallback, nothing logged', async () => {
  const p = page();
  try {
    const clipboard = fakeClipboard(null);
    const result = await writeClipboardText('const a = 1;', { anchor: p.button, doc: p.doc, clipboard, log: p.log });
    assert.deepEqual(result, { ok: true, method: 'clipboard-api' });
    assert.deepEqual(clipboard.writes, ['const a = 1;']);
    assert.equal(p.copies.length, 0, 'execCommand untouched');
    assert.deepEqual(p.logs, { warn: [], error: [] });
  } finally { await p.close(); }
});

test('a rejected write is logged with its real reason and copied through execCommand beside the button', async () => {
  const p = page();
  try {
    p.button.focus();
    const clipboard = fakeClipboard(DENIED);
    const text = 'Line one\n\n```js\nconst a = 1;\n```';
    const result = await writeClipboardText(text, { anchor: p.button, doc: p.doc, clipboard, log: p.log });
    assert.deepEqual(result, { ok: true, method: 'exec-command' });
    assert.deepEqual(clipboard.writes, [text], 'the first path was tried');
    assert.deepEqual(p.copies, [{ command: 'copy', selected: text, tag: 'TEXTAREA', readOnly: true, parentId: 'task-chat-msg' }],
      'a read-only textarea next to the button held exactly the text, focused and fully selected');
    assert.equal(p.logs.warn.length, 1);
    assert.match(p.logs.warn[0], /NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied\./);
    assert.deepEqual(p.logs.error, []);
    assert.equal(p.doc.querySelectorAll('textarea').length, 1, 'the copy buffer is gone again (only the composer is left)');
    // Identity as a boolean: a failing assert.equal() on two happy-dom nodes inspects their whole
    // object graph and never returns.
    assert.equal(p.doc.activeElement === p.button, true, 'keyboard focus is back on the button');
  } finally { await p.close(); }
});

test('no navigator.clipboard (not a secure context): straight to the fallback', async () => {
  const p = page();
  try {
    const result = await writeClipboardText('plain', { anchor: p.button, doc: p.doc, clipboard: undefined, log: p.log });
    assert.deepEqual(result, { ok: true, method: 'exec-command' });
    assert.equal(p.copies[0].selected, 'plain');
    assert.match(p.logs.warn[0], /navigator\.clipboard\.writeText is not available/);
  } finally { await p.close(); }
});

test('only a copy neither path could make is a failure, and both reasons are logged', async () => {
  const p = page();
  try {
    p.setExecResult(false);
    const refused = await writeClipboardText('x', { anchor: p.button, doc: p.doc, clipboard: fakeClipboard(DENIED), log: p.log });
    assert.equal(refused.ok, false);
    assert.match(String(refused.error && refused.error.message), /execCommand\("copy"\) returned false/);
    assert.match(p.logs.warn[0], /Write permission denied/);
    assert.match(p.logs.error[0], /execCommand\('copy'\) failed too \(Error: document\.execCommand\("copy"\) returned false\)/);

    p.setExecResult(Object.assign(new Error('blocked'), { name: 'SecurityError' }));
    const thrown = await writeClipboardText('x', { anchor: p.button, doc: p.doc, clipboard: fakeClipboard(DENIED), log: p.log });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error.name, 'SecurityError');
    assert.match(p.logs.error[1], /SecurityError: blocked/);
    assert.equal(p.doc.querySelectorAll('textarea').length, 1, 'no copy buffer left behind after a throw');

    const noExec = await writeClipboardText('x', { anchor: p.button, doc: {}, clipboard: fakeClipboard(DENIED), log: p.log });
    assert.equal(noExec.ok, false);
    assert.match(noExec.error.message, /execCommand is not available/);
  } finally { await p.close(); }
});

test('nothing to copy touches neither path', async () => {
  const p = page();
  try {
    const clipboard = fakeClipboard(null);
    for (const empty of ['', null, undefined, 42]) {
      const result = await writeClipboardText(empty, { anchor: p.button, doc: p.doc, clipboard, log: p.log });
      assert.equal(result.ok, false);
    }
    assert.deepEqual(clipboard.writes, []);
    assert.equal(p.copies.length, 0);
    assert.deepEqual(p.logs, { warn: [], error: [] });
  } finally { await p.close(); }
});

test('the page selection the user had is put back after the fallback', async () => {
  const p = page();
  try {
    const selection = p.doc.getSelection();
    const range = p.doc.createRange();
    range.selectNodeContents(p.doc.getElementById('para'));
    selection.removeAllRanges();
    selection.addRange(range);
    const result = await writeClipboardText('code', { anchor: p.button, doc: p.doc, clipboard: fakeClipboard(DENIED), log: p.log });
    assert.equal(result.ok, true);
    assert.equal(p.doc.getSelection().toString(), 'Some reply text');
  } finally { await p.close(); }
});

test('inside a modal focus layer the copy buffer stays in the layer, so its focus guard leaves it alone', async () => {
  const p = page();
  const previous = {};
  for (const key of ['document', 'getComputedStyle', 'MutationObserver']) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: key === 'document' ? p.doc : p.window[key], configurable: true, writable: true });
  }
  try {
    const { activateDialogFocus } = await import('./dialog-focus.js');
    p.doc.body.insertAdjacentHTML('beforeend', '<div id="outside"><button type="button">Board</button></div>');
    const layer = activateDialogFocus({ root: p.doc.querySelector('.task-chat'), initialFocus: () => p.doc.getElementById('composer') });
    try {
      p.button.focus();
      const result = await writeClipboardText('in the layer', { anchor: p.button, doc: p.doc, clipboard: fakeClipboard(DENIED), log: p.log });
      assert.equal(result.ok, true);
      assert.deepEqual(p.copies.map(c => [c.tag, c.selected]), [['TEXTAREA', 'in the layer']],
        'the focused element at copy time was the buffer, not the layer\'s first control');
      assert.equal(p.doc.activeElement === p.button, true, 'focus back on the button');
    } finally { layer.close(); }
  } finally {
    for (const [key, desc] of Object.entries(previous)) {
      if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key];
    }
    await p.close();
  }
});
