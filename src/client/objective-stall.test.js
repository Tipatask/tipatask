import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { t, setLocale } from './i18n.js';

// Execute the production error branch without chat-ui's boot-time network/DOM
// imports. Browser verification covers the rendered Retry control and spinner.
const source = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
function client() {
  const other = { messages: [{ role: 'assistant', content: '', streaming: true }] };
  const cs = { messages: [
    { role: 'user', content: 'Plan this' },
    { role: 'assistant', content: '', cards: [], streaming: true },
  ], clientBuffer: 'partial', cleanContent: 'partial', progressStage: 'Reading architecture…',
  thinkingPreview: 'Thinking', processExited: false, pendingCardsUpdate: true };
  const tab = { chatState: cs, status: 'streaming' };
  const env = { cs, tab, state: { chatState: other }, t,
    appendProgressLog() {}, notifyObjectiveStatusChanged() {},
  };
  vm.createContext(env);
  for (const name of ['objectiveIsStreaming', 'computeTabStatus', 'providerLabelFor',
    'objectiveErrorCategory', 'objectiveErrorMessage', 'objectiveRetryBannerText']) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
  }
  vm.runInContext('function repaint() { tab.status = computeTabStatus(cs); }', env);
  const marker = "} else if (msg.type === 'objective-error') {";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("} else if (msg.type === 'chat-history')", start);
  vm.runInContext(`function handleError(msg) {${source.slice(start, end)}}`, env);
  return { ...env, other };
}

test('stall error replaces empty typing bubble and stops only the owning tab', () => {
  const h = client();
  h.handleError({ reason: 'stream-stalled', provider: 'claude', attempts: 1 });
  assert.equal(h.cs.messages.length, 2);
  assert.equal(h.cs.messages[1].role, 'system');
  assert.match(h.cs.messages[1].content, /2 minutes.*Retry/);
  assert.equal(h.cs.messages.some(m => m.streaming), false);
  assert.equal(h.tab.status, 'error');
  assert.equal(h.cs.progressStage, null);
  assert.equal(h.cs.thinkingPreview, '');
  assert.equal(h.cs.clientBuffer, '');
  assert.equal(h.cs.processExited, true);
  assert.equal(h.cs.pendingCardsUpdate, false);
  assert.equal(h.cs.retryable, true);
  assert.equal(h.state.chatState, h.other);
  assert.equal(h.objectiveIsStreaming(), true, 'visible sibling still streams');
  h.state.chatState = h.cs;
  assert.equal(h.objectiveIsStreaming(), false, 'returning to failed tab enables Retry');
});

test('error preserves partial text and proposal cards while ending their streaming state', () => {
  const h = client();
  h.cs.messages[1].content = 'Partial plan';
  h.cs.messages.push({ role: 'assistant', content: '', cards: [{ task: { id: 'T1' } }], streaming: true });
  h.handleError({ reason: 'stream-stalled', provider: 'claude' });
  assert.equal(h.cs.messages[1].content, 'Partial plan');
  assert.equal(h.cs.messages[2].cards[0].task.id, 'T1');
  assert.equal(h.cs.messages.some(m => m.streaming), false);
});

test('stall message and Retry banner use Ukrainian locale', () => {
  setLocale('uk');
  try {
    const h = client();
    h.handleError({ reason: 'stream-stalled', provider: 'claude' });
    assert.match(h.cs.messages.at(-1).content, /2 хвилин/);
    assert.match(h.objectiveRetryBannerText(h.cs, ''), /Повторити/);
  } finally { setLocale('en'); }
});
