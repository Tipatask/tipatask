import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT700) The real terminal modal (console-modal.js) in English and Ukrainian: the status-dot
// tooltip through a session's life, the lines written into the xterm, the token footer, the
// plan-ready bar, the MCP auth dialog, the header labels and the Debug Console. Only xterm and
// the socket are replaced (the session-loss.test.js doubles; this xterm also records writes).
// Each run bundles a fresh client, so the locale and module state never leak between languages.
// (TPT9007) The bundle also carries the objective chat (chat-ui.js) and the api-status banner
// (utils.js), driven by the tests at the end of this file.
async function withClient(lang, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-terminal-i18n-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  // (TPT9007) chat-ui.js opens a BroadcastChannel at import; Node's own would keep this process alive.
  install('BroadcastChannel', undefined);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    sent = [];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    error() { this.onerror?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  install('WebSocket', Socket);
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  let state;
  let modal;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as chat from './src/client/chat-ui.js';
        export { showApiStatusBanner } from './src/client/utils.js';
        export { setLocale } from './src/client/i18n.js';
        export { writes } from '@xterm/xterm';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export const writes = [];
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {} focus() {}
            clear() {} reset() {} scrollToBottom() {} dispose() {}
            write(data, done) { writes.push(String(data)); done?.(); }
            open(parent) { this.element = document.createElement('div'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    ({ state, modal } = api);
    api.setLocale(lang);
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    await run({ ...api, window, sockets, until });
  } finally {
    modal?.closeConsoleIfOpen();
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Literal expected copy, so a wrong key, a dropped placeholder or an untranslated string fails here.
const COPY = {
  en: {
    connected: 'Connected',
    planningCommand: 'Planning — type /approve-plan to continue',
    planningDialog: 'Planning — awaiting approval dialog',
    executing: 'Executing',
    connectionError: 'Connection error',
    disconnected: 'Disconnected',
    exited: 'Exited (code 3)',
    exitLine: '--- Process exited (code 3) ---',
    tokens: 'Tokens: 120 in / 45 out · $0.50',
    error: 'Error',
    errorLine: 'Error: boom',
    errorCoded: 'Error: Cannot start a task assigned to another member.',
    errorStart: 'Error: Failed to start Claude Code: Claude CLI not found. Install claude or ensure its directory is on PATH.',
    planReady: ['Agent has a plan ready. Proceed with implementation?', 'Discard', 'Proceed with Implementation'],
    mcpAuth: ['Session not authenticated', 'No API token configured — run initial setup to connect.', 'Dismiss', 'Open Settings'],
    mcpReauth: 'Your API token is invalid or expired — please re-authenticate.',
    pasteServer: '[image paste failed: upload rejected]',
    pasteCoded: '[image paste failed: Unsupported image type: image/bmp]',
    pasteLocal: '[image paste failed: clipboard unreadable]',
    newObjective: 'New Objective',
    discussion: 'Claude Code · Discussion',
    debugConsole: 'Debug Console',
    waiting: 'waiting for first signal…',
  },
  uk: {
    connected: 'Підключено',
    planningCommand: 'Планування — введіть /approve-plan, щоб продовжити',
    planningDialog: 'Планування — очікується діалог схвалення',
    executing: 'Виконання',
    connectionError: 'Помилка з’єднання',
    disconnected: 'Від’єднано',
    exited: 'Завершено (код 3)',
    exitLine: '--- Процес завершено (код 3) ---',
    tokens: 'Токени: 120 на вході / 45 на виході · $0.50',
    error: 'Помилка',
    errorLine: 'Помилка: boom',
    errorCoded: 'Помилка: Не можна запустити задачу, призначену іншому учаснику.',
    errorStart: 'Помилка: Не вдалося запустити Claude Code: Claude CLI не знайдено. Установіть claude або переконайтеся, що його каталог є в PATH.',
    planReady: ['Агент підготував план. Перейти до реалізації?', 'Відхилити', 'Перейти до реалізації'],
    mcpAuth: ['Сесію не автентифіковано', 'API-токен не налаштовано — запустіть початкове налаштування, щоб підключитися.', 'Закрити', 'Відкрити налаштування'],
    mcpReauth: 'Ваш API-токен недійсний або його термін дії минув — пройдіть повторну автентифікацію.',
    pasteServer: '[не вдалося вставити зображення: upload rejected]',
    pasteCoded: '[не вдалося вставити зображення: непідтримуваний тип зображення: image/bmp]',
    pasteLocal: '[не вдалося вставити зображення: буфер обміну недоступний]',
    newObjective: 'Нова ціль',
    discussion: 'Claude Code · Обговорення',
    debugConsole: 'Консоль налагодження',
    waiting: 'очікування першого сигналу…',
  },
};

for (const lang of ['en', 'uk']) {
  test(`terminal modal copy follows the project language (${lang})`, async () => {
    const copy = COPY[lang];
    await withClient(lang, async ({ state, modal, writes, window, sockets, until }) => {
      const wrote = text => writes.some(line => line.includes(text));
      modal.openTerminal('TPT1', 'Translate me', '', 'in_progress');
      await until(() => sockets.length === 1);
      const overlay = document.querySelector('.terminal-overlay--task');
      const dot = overlay.querySelector('.status-dot');
      assert.equal(dot.title, copy.connected, 'the header renders its first tooltip before the socket opens');
      const socket = sockets[0];
      socket.open();
      assert.equal(dot.title, copy.connected);

      socket.frame({ type: 'config', showAiStats: true, taskAgent: 'claude', planApprovalCommand: '/approve-plan' });
      socket.frame({ type: 'terminal-state', phase: 'planning', taskAgent: 'claude', permissionMode: 'plan', planApprovalCommand: '/approve-plan' });
      assert.equal(dot.title, copy.planningCommand);
      socket.frame({ type: 'terminal-state', phase: 'planning', taskAgent: 'claude', permissionMode: 'plan', planApprovalCommand: null });
      assert.equal(dot.title, copy.planningDialog);

      socket.frame({ type: 'plan-ready' });
      const bar = overlay.querySelector('.plan-ready-dialog');
      assert.deepEqual([
        bar.querySelector('.plan-ready-text').textContent,
        bar.querySelector('.btn-plan-discard').textContent,
        bar.querySelector('.btn-plan-proceed').textContent,
      ], copy.planReady);
      bar.querySelector('.btn-plan-proceed').click();
      assert.equal(overlay.querySelector('.plan-ready-dialog'), null, 'Proceed removes the bar');
      assert.ok(socket.sent.some(frame => frame.type === 'plan-approve'), 'explicit Plan approves in place');

      // Missing token, then an invalid or expired one.
      const authCopy = () => {
        const dialog = overlay.querySelector('[data-mcp-auth]');
        return [
          dialog.querySelector('.mcp-auth-title').textContent,
          dialog.querySelector('.mcp-auth-body').textContent,
          dialog.querySelector('.btn-mcp-auth-dismiss').textContent,
          dialog.querySelector('.btn-mcp-auth-settings').textContent,
        ];
      };
      socket.frame({ type: 'mcp-auth-failure', authState: 'initial' });
      assert.deepEqual(authCopy(), copy.mcpAuth);
      overlay.querySelector('.btn-mcp-auth-dismiss').click();
      assert.equal(overlay.querySelector('[data-mcp-auth]'), null, 'Dismiss removes the dialog');
      socket.frame({ type: 'mcp-auth-failure', authState: 'expired' });
      assert.equal(authCopy()[1], copy.mcpReauth);
      overlay.querySelector('.btn-mcp-auth-dismiss').click();

      socket.frame({ type: 'terminal-state', phase: 'executing', taskAgent: 'claude' });
      assert.equal(dot.title, copy.executing);

      // The server's paste error stays verbatim inside the translated line; a local reason is translated.
      socket.frame({ type: 'paste-image-error', error: 'upload rejected' });
      assert.ok(wrote(copy.pasteServer), `missing ${copy.pasteServer}`);
      // (TPT9002) A coded paste error renders its terminal.pasteError.* key instead.
      socket.frame({ type: 'paste-image-error', code: 'EIMAGE_TYPE', params: { type: 'image/bmp' }, error: 'Unsupported image type: image/bmp' });
      assert.ok(wrote(copy.pasteCoded), `missing ${copy.pasteCoded}`);
      const xtermInput = overlay.querySelector('.terminal-body').firstElementChild.appendChild(document.createElement('textarea'));
      const paste = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] },
      });
      xtermInput.dispatchEvent(paste);
      assert.ok(wrote(copy.pasteLocal), `missing ${copy.pasteLocal}`);

      socket.error();
      assert.equal(dot.title, copy.connectionError);
      socket.close();
      assert.equal(dot.title, copy.disconnected);

      socket.frame({ type: 'exit', code: 3, tokens: { input: 120, output: 45, costUsd: 0.5 } });
      assert.equal(dot.title, copy.exited);
      assert.ok(wrote(copy.exitLine), `missing ${copy.exitLine}`);
      assert.equal(overlay.querySelector('.terminal-footer').textContent, copy.tokens);

      socket.frame({ type: 'error', message: 'boom' });
      assert.equal(dot.title, copy.error);
      assert.ok(wrote(copy.errorLine), `missing ${copy.errorLine}`);
      // (TPT9002) A coded error frame renders its terminal.error.* key; the message is only a fallback.
      socket.frame({ type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' });
      assert.ok(wrote(copy.errorCoded), `missing ${copy.errorCoded}`);
      // (TPT9008) A start that failed agent detection (the Claude CLI renamed away): the whole line,
      // the CLI's install hint included, is in the project language.
      const cliNotFound = 'Claude CLI not found. Install claude or ensure its directory is on PATH.';
      socket.frame({
        type: 'error', code: 'ESTART', reason: 'cli_not_found',
        params: { agent: 'claude', label: 'Claude Code', message: cliNotFound },
        message: `Failed to start Claude Code: ${cliNotFound}`,
      });
      assert.ok(wrote(copy.errorStart), `missing ${copy.errorStart}`);

      // Header labels: an objective terminal, then a discussion launch.
      modal.openTerminal('obj-1', 'Objective', '', 'in_progress');
      await until(() => sockets.length === 2);
      assert.equal(document.querySelector('.terminal-overlay--task .task-label').textContent, copy.newObjective);
      modal.openTerminal('TPT2', 'Discuss me', '', 'in_progress', { discussionMode: true });
      await until(() => sockets.length === 3);
      const caption = document.querySelector('.terminal-overlay--task .terminal-task-caption');
      assert.equal(caption.querySelector('.terminal-task-caption-text').textContent, copy.discussion);
      assert.equal(caption.title, copy.discussion);
      state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });

      state.chatState = {};
      modal.openObjectiveConsole();
      const debugConsole = document.getElementById('objective-console');
      assert.equal(debugConsole.querySelector('.task-label').textContent, copy.debugConsole);
      assert.equal(debugConsole.querySelector('.status-dot').title, copy.connected);
      await until(() => wrote(copy.waiting));
      modal.closeConsoleIfOpen();
      assert.equal(document.getElementById('objective-console'), null);
    });
  });
}

// (TPT9007) The objective chat's own socket (chat-ui.js) in English and Ukrainian: the lines it
// writes into the open Debug Console, the progress chip (also the console status bar's stage), the
// system messages it pushes into the transcript, the Close button it relabels on exit, and the
// composer renderObjectiveContent() builds. Literal expected copy, as above.
const OBJECTIVE_COPY = {
  en: {
    spawned: '▸ spawned',
    chipSpawned: 'Starting model…',
    elapsed: '[+1.5s]',
    retryStage: '⟳ provider retry: 429',
    chipTool: 'Loading task…',
    chipOtherTool: 'Tool: mcp__other__thing…',
    chipThinking: 'Thinking: Weighing the options',
    result: '✔ 2 cards · 10/5 tokens',
    trimmedLog: 'context trimmed (12 messages kept)',
    trimmed: 'Context trimmed to 12 messages for optimal performance.',
    retryLog: 'attempt 2 — stream-idle-timeout',
    retrying: 'Retrying Claude (attempt 2) — stream-idle-timeout. Press Stop to cancel.',
    retryDefaultLog: 'attempt 3 — stream interrupted',
    turnFailed: 'turn failed: boom',
    error: 'Error: boom',
    turnFailedTries: 'turn failed: circuit-open (0 tries)',
    circuitOpen: 'The server paused new AI turns after repeated failures. Wait about 30 seconds and Retry, or pick a different model.',
    exitLine: '--- Process exited ---',
    close: 'Close',
    restarted: '--- Restarted ---',
    divider: '═══ turn 2 ═══',
    placeholderFollowUp: 'Send feedback to refine tasks...',
    loadEarlier: 'Load 3 earlier messages',
    olderHidden: '3 older hidden',
    throttleRetry: 'The server is busy right now. Wait a moment, then Retry.',
    retry: 'Retry',
    send: 'Send',
    history: 'History',
    newObjective: 'New objective',
    closeTab: 'Close tab',
    planning: 'Planning',
    exitPlanning: 'Exit planning mode',
    placeholderBriefStart: 'What do you want to build or fix?',
    briefHint: '0 words — aim for 40+ words for detailed task cards',
  },
  uk: {
    spawned: '▸ запущено',
    chipSpawned: 'Запуск моделі…',
    elapsed: '[+1.5с]',
    retryStage: '⟳ повтор запиту до провайдера: 429',
    chipTool: 'Завантаження задачі…',
    chipOtherTool: 'Інструмент: mcp__other__thing…',
    chipThinking: 'Думає: Weighing the options',
    result: '✔ 2 картки · токени: 10/5',
    trimmedLog: 'контекст скорочено (залишено повідомлень: 12)',
    trimmed: 'Контекст скорочено для кращої продуктивності (залишено повідомлень: 12).',
    retryLog: 'спроба 2 — stream-idle-timeout',
    retrying: 'Повторний запит до Claude (спроба 2) — stream-idle-timeout. Натисніть «Зупинити», щоб скасувати.',
    retryDefaultLog: 'спроба 3 — потік перервано',
    turnFailed: 'хід не вдався: boom',
    error: 'Помилка: boom',
    turnFailedTries: 'хід не вдався: circuit-open (0 спроб)',
    circuitOpen: 'Сервер призупинив нові ходи ШІ після кількох збоїв поспіль. Зачекайте близько 30 секунд і натисніть «Повторити» або оберіть іншу модель.',
    exitLine: '--- Процес завершено ---',
    close: 'Закрити',
    restarted: '--- Перезапущено ---',
    divider: '═══ хід 2 ═══',
    placeholderFollowUp: 'Надішліть відгук, щоб уточнити задачі...',
    loadEarlier: 'Завантажити 3 попередні повідомлення',
    olderHidden: 'приховано старіших: 3',
    throttleRetry: 'Сервер зараз зайнятий. Зачекайте трохи, потім натисніть «Повторити».',
    retry: 'Повторити',
    send: 'Надіслати',
    history: 'Історія',
    newObjective: 'Нова ціль',
    closeTab: 'Закрити вкладку',
    planning: 'Планування',
    exitPlanning: 'Вийти з режиму планування',
    placeholderBriefStart: 'Що потрібно побудувати або виправити?',
    briefHint: '0 слів — для детальних карток задач пишіть 40+ слів',
  },
};

for (const lang of ['en', 'uk']) {
  test(`objective chat and Debug Console copy follows the project language (${lang})`, async () => {
    const copy = OBJECTIVE_COPY[lang];
    await withClient(lang, async ({ state, modal, chat, writes, sockets, until }) => {
      const wrote = text => writes.some(line => line.includes(text));
      const cs = { taskId: 'obj-i18n', messages: [], originalUserText: 'Plan the release', clientBuffer: '',
        cleanContent: null, allChanges: [], historyWindowStart: 1 };
      const tab = { tabId: 'obj-i18n', title: '', status: 'streaming', chatState: cs, originTaskKey: 'TPT1' };
      state.tabsState = [tab];
      state.activeTabId = tab.tabId;
      state.chatState = cs;
      chat.connectObjectiveWS(tab.tabId, 'Plan the release');
      const socket = sockets.at(-1);
      socket.open();
      modal.openObjectiveConsole();
      await until(() => cs.term);

      socket.frame({ type: 'objective-progress', stage: 'spawned', elapsedMs: 100 });
      assert.equal(cs.progressStage, copy.chipSpawned);
      assert.ok(wrote(copy.spawned), `missing ${copy.spawned}`);
      socket.frame({ type: 'objective-progress', stage: 'pi-retry', detail: '429', elapsedMs: 1500 });
      assert.ok(wrote(copy.elapsed), `missing ${copy.elapsed}`);
      assert.ok(wrote(copy.retryStage), `missing ${copy.retryStage}`);
      socket.frame({ type: 'objective-progress', stage: 'tool', name: 'mcp__tipatask__get_task', elapsedMs: 1600 });
      assert.equal(cs.progressStage, copy.chipTool);
      socket.frame({ type: 'objective-progress', stage: 'tool', name: 'mcp__other__thing', elapsedMs: 1700 });
      assert.equal(cs.progressStage, copy.chipOtherTool);
      socket.frame({ type: 'objective-thinking', data: 'Weighing the options' });
      assert.equal(cs.progressStage, copy.chipThinking);
      socket.frame({ type: 'objective-result', cards: [{}, {}], tokens: { input: 10, output: 5 } });
      assert.ok(wrote(copy.result), `missing ${copy.result}`);

      socket.frame({ type: 'context-trimmed', messagesKept: 12 });
      assert.ok(wrote(copy.trimmedLog), `missing ${copy.trimmedLog}`);
      assert.equal(cs.messages.at(-1).content, copy.trimmed);
      socket.frame({ type: 'objective-retry', attempt: 2, reason: 'stream-idle-timeout' });
      assert.ok(wrote(copy.retryLog), `missing ${copy.retryLog}`);
      assert.equal(cs.messages.at(-1).content, copy.retrying);
      socket.frame({ type: 'objective-retry', attempt: 3 });
      assert.ok(wrote(copy.retryDefaultLog), `missing ${copy.retryDefaultLog}`);
      socket.frame({ type: 'error', message: 'boom' });
      assert.ok(wrote(copy.turnFailed), `missing ${copy.turnFailed}`);
      assert.equal(cs.messages.at(-1).content, copy.error);
      socket.frame({ type: 'objective-error', reason: 'circuit-open', attempts: 0, provider: 'claude' });
      assert.ok(wrote(copy.turnFailedTries), `missing ${copy.turnFailedTries}`);
      assert.equal(cs.messages.at(-1).content, copy.circuitOpen);

      const closeBtn = document.querySelector('#objective-console .btn-close-terminal');
      closeBtn.textContent = '';
      socket.frame({ type: 'exit', code: 1 });
      assert.ok(wrote(copy.exitLine), `missing ${copy.exitLine}`);
      assert.equal(closeBtn.textContent, copy.close, 'exit relabels the console Close button');
      socket.frame({ type: 'restarted' });
      assert.ok(wrote(copy.restarted), `missing ${copy.restarted}`);
      socket.frame({ type: 'objective-progress', stage: 'spawned', elapsedMs: 0 });
      assert.ok(wrote(copy.divider), `missing ${copy.divider}`);
      modal.closeConsoleIfOpen(); // clears this chat's status ticker while it is still state.chatState

      // The composer: a follow-up turn with a retryable failure and hidden older history.
      const parse = html => {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        return tpl.content;
      };
      const followUp = { taskId: 'obj-i18n', messages: [{ role: 'user', content: 'Plan the release', timestamp: 1 }],
        retryable: true, _lastErrorReason: 'queue-full', _lastErrorProvider: 'claude', historyWindowStart: 4,
        historyTotalCount: 5 };
      tab.chatState = followUp;
      state.chatState = followUp;
      let view = parse(chat.renderObjectiveContent());
      assert.equal(view.querySelector('#chat-input').getAttribute('placeholder'), copy.placeholderFollowUp);
      assert.equal(view.querySelector('#btn-load-earlier-history').textContent.trim(), copy.loadEarlier);
      assert.equal(view.querySelector('.chat-history-meta').textContent.trim(), copy.olderHidden);
      assert.equal(view.querySelector('.chat-retry-banner span').textContent, copy.throttleRetry);
      assert.equal(view.querySelector('#btn-chat-retry').textContent.trim(), copy.retry);
      assert.equal(view.querySelector('#btn-chat-send').textContent.trim(), copy.send);
      assert.equal(view.querySelector('#btn-archive').textContent.trim(), copy.history);
      assert.equal(view.querySelector('.chat-tab-title').textContent, copy.newObjective, 'an untitled tab');
      assert.equal(view.querySelector('.chat-tab-close').getAttribute('title'), copy.closeTab);
      const origin = view.querySelector('.origin-context-banner');
      assert.equal(origin.firstChild.textContent.trim(), copy.planning);
      assert.equal(origin.querySelector('.btn-clear-origin-ctx').getAttribute('title'), copy.exitPlanning);

      // The empty first-turn composer.
      tab.chatState = null;
      state.chatState = null;
      view = parse(chat.renderObjectiveContent());
      assert.ok(view.querySelector('#chat-input').getAttribute('placeholder').startsWith(copy.placeholderBriefStart));
      assert.equal(view.querySelector('#chat-brief-hint').textContent, copy.briefHint);
      state.cleanupInProgress = true; // the exit frame's debounced draft save must not outlive the run
    });
  });
}

// (TPT9007) The corner api-status banner (utils.js showApiStatusBanner()) in English and Ukrainian.
// The frame's `message` (a raw transport error) stays verbatim and is never parsed as HTML.
const BANNER_COPY = {
  en: {
    reconnecting: 'Reconnecting…',
    queued: ['Reconnecting… (1 update queued)', 'Reconnecting… (2 updates queued)', 'Reconnecting… (5 updates queued)'],
    offline: 'Offline — fetch failed',
    unreachable: 'Offline — API unreachable',
    reconnected: 'Reconnected',
    dismiss: 'Dismiss',
  },
  uk: {
    reconnecting: 'Перепідключення…',
    queued: ['Перепідключення… (1 зміна в черзі)', 'Перепідключення… (2 зміни в черзі)', 'Перепідключення… (5 змін у черзі)'],
    offline: 'Офлайн — fetch failed',
    unreachable: 'Офлайн — API недоступний',
    reconnected: 'Підключення відновлено',
    dismiss: 'Закрити',
  },
};

for (const lang of ['en', 'uk']) {
  test(`api-status banner follows the project language (${lang})`, async () => {
    const copy = BANNER_COPY[lang];
    await withClient(lang, async ({ showApiStatusBanner }) => {
      const banner = () => document.getElementById('api-status-banner');
      const label = () => banner().textContent.replace(/×$/, '');
      showApiStatusBanner('reconnecting');
      assert.equal(label(), copy.reconnecting);
      assert.equal(banner().querySelector('button').getAttribute('aria-label'), copy.dismiss);
      assert.deepEqual([1, 2, 5].map((n) => { showApiStatusBanner('reconnecting', null, n); return label(); }), copy.queued);
      showApiStatusBanner('disconnected', 'fetch failed');
      assert.equal(label(), copy.offline);
      showApiStatusBanner('disconnected');
      assert.equal(label(), copy.unreachable);
      showApiStatusBanner('disconnected', '<b>bad gateway</b>');
      assert.equal(banner().querySelector('b'), null, 'the transport error is text, not markup');
      assert.ok(label().endsWith('<b>bad gateway</b>'));
      showApiStatusBanner('reconnecting', '<i>retrying</i>');
      assert.equal(banner().querySelector('i'), null);
      showApiStatusBanner('connected');
      assert.equal(banner().textContent, copy.reconnected);
      clearTimeout(banner()._dismissTimer);
      banner().remove();
    });
  });
}
