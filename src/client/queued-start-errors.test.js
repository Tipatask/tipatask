import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

// (TPT9014) A queued start the server refuses when it leaves the start queue reaches the board
// only as a `session-ended` broadcast (`reason: 'start-failed'`) carrying the `error` frame the
// terminal would have shown — Play All / bulk Start closed their socket on `session-queued`. The
// Electron __attention__ handler (attention-ws.js) toasts it with the terminal's own text, and
// refusals arriving together share one toast. The real modules run under happy-dom.
const window = new Window({ url: 'http://localhost:4455/' });
const globals = new Map();
function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
for (const key of ['document', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'CSS', 'localStorage', 'sessionStorage', 'navigator']) install(key, window[key]);
install('window', window);
install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
after(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { default: state } = await import('./state.js');
const { setLocale } = await import('./i18n.js');
const { handleAttentionMessage } = await import('./attention-ws.js');

const EASSIGNEE = { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' };
const ESTART = { type: 'error', code: 'ESTART', params: { label: 'Claude Code', message: 'spawn claude ENOENT' }, message: 'Failed to start Claude Code: spawn claude ENOENT' };
// Literal expected copy: the terminal.error.* text the terminal's own red line shows.
const COPY = {
  en: {
    EASSIGNEE: 'Cannot start a task assigned to another member.',
    ESTART: 'Failed to start Claude Code: spawn claude ENOENT',
  },
  uk: {
    EASSIGNEE: 'Не можна запустити задачу, призначену іншому учаснику.',
    ESTART: 'Не вдалося запустити Claude Code: spawn claude ENOENT',
  },
};

function ended(taskId, extra = {}) {
  return { type: 'session-ended', taskId, tabId: taskId, reason: 'start-failed', ...extra };
}

function errorToasts() {
  return [...document.querySelectorAll('.tt-toast--error .tt-saving-label')].map(label => label.textContent);
}

async function settle() {
  // Past the coalescing window, so every toast that is coming is up.
  await new Promise(resolve => setTimeout(resolve, 400));
}

function reset() {
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
}

for (const lang of ['en', 'uk']) {
  test(`a queued start refused on drain is toasted with the terminal's text (${lang})`, async (t) => {
    setLocale(lang);
    const copy = COPY[lang];

    await t.test('refusals arriving together share one toast', async () => {
      reset();
      for (const id of ['TPT1', 'TPT2']) state.activeSessions.add(id);
      handleAttentionMessage(ended('TPT1', { error: EASSIGNEE }));
      handleAttentionMessage(ended('TPT2', { error: EASSIGNEE }));
      assert.ok(!state.activeSessions.has('TPT1') && !state.activeSessions.has('TPT2'), 'the sessions are dropped at once');
      await settle();
      assert.deepEqual(errorToasts(), [`TPT1, TPT2: ${copy.EASSIGNEE}`]);
    });

    await t.test('one line per distinct reason', async () => {
      reset();
      handleAttentionMessage(ended('TPT3', { error: ESTART }));
      handleAttentionMessage(ended('TPT4', { error: EASSIGNEE }));
      await settle();
      assert.deepEqual(errorToasts(), [`TPT3: ${copy.ESTART}\nTPT4: ${copy.EASSIGNEE}`]);
    });

    await t.test('no toast without a refusal frame', async () => {
      reset();
      handleAttentionMessage(ended('TPT5')); // an older server: no `error`
      handleAttentionMessage({ type: 'session-ended', taskId: 'TPT6', tabId: 'TPT6', reason: 'terminated', error: EASSIGNEE });
      handleAttentionMessage({ type: 'session-ended', taskId: 'TPT7', tabId: 'TPT7', reason: 'user-terminated' });
      await settle();
      assert.deepEqual(errorToasts(), []);
    });
  });
}

test('the browser __board__ session-ended branch reports through the same handler', () => {
  const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const branch = html.slice(html.indexOf("if (msg.type === 'session-ended') {"));
  assert.match(branch.slice(0, branch.indexOf('return;')), /TipTask\.attentionWs\.reportStartFailure\(msg\)/);
});
