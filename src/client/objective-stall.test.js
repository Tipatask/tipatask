import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { t, tc, setLocale } from './i18n.js';

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
  const progressLog = [];
  const env = { cs, tab, state: { chatState: other }, t, tc, progressLog,
    appendProgressLog(_cs, entry) { progressLog.push(entry); }, notifyObjectiveStatusChanged() {},
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

test('cli-error shows the CLI message verbatim, points at the Debug Console, keeps Retry', () => {
  const h = client();
  const message = 'API Error: 400 prompt is too long: 5012345 tokens > 200000 maximum';
  h.handleError({ reason: 'cli-error:error_during_execution', provider: 'claude', attempts: 0, message });
  const sys = h.cs.messages.at(-1);
  assert.equal(sys.role, 'system');
  assert.ok(sys.content.includes(message), 'verbatim API message');
  assert.match(sys.content, /error_during_execution/);
  assert.match(sys.content, /Debug Console/);
  assert.match(sys.content, /^Claude's CLI returned an error/);
  assert.equal(h.cs.retryable, true);
  assert.equal(h.cs.processExited, true);
  assert.equal(h.tab.status, 'error');
  assert.equal(h.cs.messages.some(m => m.streaming), false);
  assert.deepEqual(h.progressLog.map(e => e.kind), ['error', 'error']);
  assert.match(h.progressLog[0].text, /turn failed: cli-error:error_during_execution \(0 tries\)/);
  assert.equal(h.progressLog[1].text, message);
  assert.match(h.objectiveRetryBannerText(h.cs, ''), /Debug Console.*Retry/);
  assert.equal(h.objectiveErrorCategory('cli-error:error_max_turns'), 'cli');
});

test('cli-error without a message falls back to the no-message copy', () => {
  const h = client();
  h.handleError({ reason: 'cli-error:error_max_turns', provider: 'claude' });
  assert.match(h.cs.messages.at(-1).content, /error_max_turns\) with no message/);
  assert.equal(h.progressLog.length, 1);
});

test('cli-error copy uses Ukrainian locale', () => {
  setLocale('uk');
  try {
    const h = client();
    h.handleError({ reason: 'cli-error:error_during_execution', provider: 'claude', message: 'prompt is too long' });
    assert.match(h.cs.messages.at(-1).content, /повернув помилку \(error_during_execution\): prompt is too long/);
    assert.match(h.objectiveRetryBannerText(h.cs, ''), /Повторити/);
  } finally { setLocale('en'); }
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

test('model-no-tools shows the server sentence alone and a pick-another-model banner', () => {
  const h = client();
  const detail = 'Model "openrouter/recraft-ai/recraft-v3" at openrouter.ai does not support tool calls (the endpoint rejected the request). Choose a tool-capable model.';
  h.handleError({ reason: 'model-no-tools', provider: 'pi', attempts: 0, model: 'openrouter/recraft-ai/recraft-v3', detail });
  const sys = h.cs.messages.at(-1);
  assert.equal(sys.role, 'system');
  assert.equal(sys.content, detail, 'the sentence, nothing else — no "stream failed", no provider JSON');
  assert.equal(h.cs.retryable, true);
  assert.equal(h.tab.status, 'error');
  assert.match(h.objectiveRetryBannerText(h.cs), /tool-capable model/);
  // A frame without `detail` still names the model through the i18n fallback.
  const h2 = client();
  h2.handleError({ reason: 'model-no-tools', provider: 'pi', attempts: 0, model: 'x/y' });
  assert.match(h2.cs.messages.at(-1).content, /x\/y.*does not support tool calls/);
});

// (TPT9007) Every objectiveErrorMessage() / objectiveRetryBannerText() category renders an i18n key
// now; the English must stay exactly what the old string literals produced.
test('objective error copy keeps its exact English text for every category', () => {
  const h = client();
  const message = (reason, attempts = 0, detail = null, model = null) =>
    h.objectiveErrorMessage(reason, attempts, detail, 'Codex', model);
  assert.equal(message('provider-unavailable'), 'Model selection failed (provider-unavailable). Retry or pick a different model.');
  assert.equal(message('turn-in-progress', 0, 'Wait for the current turn.'), 'Wait for the current turn.');
  assert.equal(message('circuit-open'), 'The server paused new AI turns after repeated failures. Wait about 30 seconds and Retry, or pick a different model.');
  assert.equal(message('queue-full'), 'The server is busy — too many AI turns are queued. Wait a moment, then Retry.');
  assert.equal(message('spawn-error'), "Codex's CLI could not be started. Check that it is installed and signed in, or pick a different model.");
  assert.equal(message('spawn-error:ENOENT'), "Codex's CLI could not be started (ENOENT). Check that it is installed and signed in, or pick a different model.");
  assert.equal(message('empty-history'), 'This chat lost its message history and could not continue. Retry restarts from your original prompt, or start a new objective.');
  assert.equal(message('finalize-timeout'), 'Saving the task cards timed out. Nothing was lost — Retry.');
  assert.equal(message('exit-code-1'), 'Codex stream failed (exit-code-1). Retry or refine your prompt.');
  assert.equal(message('exit-code-1', 2, 'boom', 'gpt-5'),
    'Codex stream failed after 2 retry attempt(s) (exit-code-1). Model: gpt-5. Details: boom Retry or refine your prompt.');
  assert.equal(h.providerLabelFor({}, null), 'The model');

  const banner = (reason) => h.objectiveRetryBannerText({ _lastErrorReason: reason, _lastErrorProvider: 'codex' }, '');
  assert.equal(h.objectiveRetryBannerText({ _lastErrorProvider: 'codex' }, ''), "Codex didn't produce task cards. Retry or send refined instructions.");
  assert.equal(h.objectiveRetryBannerText({ _lastErrorProvider: 'codex' }, '{"chan'),
    'Codex didn\'t produce task cards. Got: {"chan… Retry or send refined instructions.');
  assert.equal(banner('provider-unavailable'), 'That model selection was rejected. Pick a different model, then Retry.');
  assert.equal(banner('queue-full'), 'The server is busy right now. Wait a moment, then Retry.');
  assert.equal(banner('spawn-error'), "Codex's CLI didn't start. Pick a different model, or Retry.");
  assert.equal(banner('empty-history'), 'This chat lost its history. Retry restarts from your original prompt.');
  assert.equal(banner('finalize-timeout'), 'Saving timed out. Retry to finish.');
  assert.equal(banner('exit-code-1'), "Codex didn't finish this turn (exit-code-1). Retry or send refined instructions.");

  const one = client();
  one.handleError({ reason: 'exit-code-1', provider: 'claude', attempts: 1, model: 'opus' });
  assert.equal(one.progressLog[0].text, 'turn failed: exit-code-1 (1 try) model=opus');
});

test('objective error copy and the Debug Console failure line use the Ukrainian locale', () => {
  setLocale('uk');
  try {
    const h = client();
    h.handleError({ reason: 'circuit-open', provider: 'claude', attempts: 0 });
    assert.equal(h.cs.messages.at(-1).content,
      'Сервер призупинив нові ходи ШІ після кількох збоїв поспіль. Зачекайте близько 30 секунд і натисніть «Повторити» або оберіть іншу модель.');
    assert.equal(h.progressLog[0].text, 'хід не вдався: circuit-open (0 спроб)');
    assert.equal(h.objectiveRetryBannerText(h.cs, ''), 'Сервер зараз зайнятий. Зачекайте трохи, потім натисніть «Повторити».');

    const pi = client();
    pi.handleError({ reason: 'exit-code-1', provider: 'pi', attempts: 2, model: 'm1', detail: 'boom' });
    assert.equal(pi.progressLog[0].text, 'хід не вдався: exit-code-1 (2 спроби) model=m1');
    assert.equal(pi.cs.messages.at(-1).content,
      'Pi: потік перервався (exit-code-1); повторних спроб: 2. Модель: m1. Подробиці: boom Натисніть «Повторити» або уточніть запит.');
    assert.equal(pi.providerLabelFor({}, null), 'Модель');
    assert.equal(pi.objectiveRetryBannerText({ _lastErrorProvider: 'pi' }, 'abc'),
      'Pi: картки задач не створено. Отримано: abc… Натисніть «Повторити» або надішліть уточнені інструкції.');
  } finally { setLocale('en'); }
});
