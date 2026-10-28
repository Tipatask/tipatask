import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { renderTerminalPermissions } from './terminal-permissions.js';
import { errorFrameText } from './terminal-frame-text.js';
import { setLocale } from './i18n.js';

test('permission controls survive repeated state, escape tool input, send one answer and clear on completion', t => {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  t.after(() => { globalThis.document = previous; window.happyDOM.close(); setLocale('en'); });
  const overlay = document.createElement('div');
  overlay.innerHTML = '<div class="terminal-header"></div><div class="terminal-container"></div>';
  const sent = [];
  const message = { permissionMode: 'auto', permissionSource: 'project',
    permissionRequest: { id: 'one', tool: 'Write', input: '<img src=x onerror=alert(1)>' } };
  renderTerminalPermissions(overlay, message, m => sent.push(m));
  assert.equal(overlay.querySelector('.terminal-permission-mode'), null, 'the run mode is session-mode-control.js\'s (TPT9139)');
  assert.equal(overlay.querySelector('img'), null);
  const buttons = overlay.querySelectorAll('button');
  buttons[1].click(); buttons[1].click();
  assert.deepEqual(sent, [{ type: 'permission-answer', id: 'one', allow: true }]);
  renderTerminalPermissions(overlay, message, m => sent.push(m));
  assert.equal(overlay.querySelectorAll('button').length, 2);
  assert.equal(overlay.querySelector('button').disabled, false, 'replayed pending requests can be retried after reconnect');
  renderTerminalPermissions(overlay, { ...message, permissionRequest: null }, () => {});
  assert.equal(overlay.querySelector('.terminal-permission-request'), null);
  setLocale('uk');
  renderTerminalPermissions(overlay, { ...message, permissionRequest: { id: 'two', tool: 'Bash', input: '{}' } }, m => sent.push(m));
  assert.match(overlay.querySelector('button').textContent, /Відхилити/);
  overlay.querySelector('button').click();
  assert.deepEqual(sent[1], { type: 'permission-answer', id: 'two', allow: false });
});

test('unsupported permission errors localize the mode and the actionable reason', () => {
  try {
    setLocale('uk');
    const text = errorFrameText({ code: 'EPERMISSION', reason: 'unsupported', params: {
      mode: 'auto', agent: 'codex', supportReason: 'codexVersion', detail: 'English fallback',
    } });
    assert.match(text, /Автоматичний режим/);
    assert.match(text, /0\.163\.0/);
    assert.doesNotMatch(text, /English fallback|auto/);
  } finally { setLocale('en'); }
});
