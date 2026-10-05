// Real Chromium regression for the terminal WebSocket write path.
// Build first, then run with Electron (ELECTRON_RUN_AS_NODE unset).
// --claude-workspace runs only the workspace geometry/redraw regression.
// --reconnect-only runs retained Codex recovery and Claude/Pi replay guards.
// --resume-only exercises production resume handlers/preload with simulated OS events.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { app, BrowserWindow, powerMonitor, ipcMain } = require('electron');
const vm = require('node:vm');
const esbuild = require('esbuild');
const terminal = require('../src/server/terminal-session');
const { getTaskAgent } = require('../src/server/task-agent');
const { reflowChunk } = require('../src/server/screen-reflow');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-terminal-scroll-'));
esbuild.buildSync({
  stdin: {
    contents: `
      import state from './src/client/state.js';
      import { openTerminal } from './src/client/console-modal.js';
      import { notifyTaskCompleted } from './src/client/completion-notifications.js';
      import { connectAttentionWs, closeAttentionWs } from './src/client/attention-ws.js';
      window.fetch = async () => new Response(JSON.stringify({
        sessions: [], statuses: [], tasks: [], notifications: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      class Socket {
        static OPEN = 1;
        static CONNECTING = 0;
        constructor(url) {
          this.url = url;
          this.readyState = 1;
          this.sent = [];
          (window.sockets ||= []).push(this);
          if (!url.includes('taskId=__attention__')) {
            window.socket = this;
            window.socketUrl = url;
          }
          setTimeout(() => this.onopen?.(), 0);
        }
        send(raw) {
          if (this.readyState !== Socket.OPEN) throw new Error('send on closed socket');
          const msg = JSON.parse(raw);
          this.sent.push(msg);
          (window.sent ||= []).push(msg);
          if (msg.type === 'resize') this.onResize?.(msg);
        }
        close() { this.readyState = 3; this.onclose?.(); }
        receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
      }
      window.WebSocket = Socket;
      window.probe = {
        connectAttentionWs, closeAttentionWs,
        open(agent, embedded = false, resume = false, hidden = false) {
          state.activeTerminal?.detach({ persistCodex: false, refreshBoard: false });
          state.activeSessions.delete('SCROLL-PROBE');
          state.taskAgent = agent;
          state.taskAgentLabel = agent;
          state.planApprovalCommand = agent === 'codex' ? null : '/approve-plan';
          document.getElementById('workspace').hidden = !embedded || hidden;
          document.getElementById('other-pane').hidden = !hidden;
          document.getElementById('workspace-frame').hidden = !embedded;
          openTerminal('SCROLL-PROBE', 'Scroll probe', '', 'in_progress', {
            agent, planOnly: true, reconnectOnly: resume, host: embedded ? document.getElementById('workspace') : null,
          });
        },
        pane(visible) {
          document.getElementById('workspace').hidden = !visible;
          document.getElementById('other-pane').hidden = visible;
          if (visible) state.activeTerminal.show({ focus: true });
          else state.activeTerminal.hide();
        },
        minimize() {
          window.retainedTerminal = state.activeTerminal;
          window.retainedSocket = socket;
          state.activeTerminal.detach({ refreshBoard: false });
        },
        reopen(embedded = false) {
          openTerminal('SCROLL-PROBE', 'Scroll probe', '', 'in_progress', {
            host: embedded ? document.getElementById('workspace') : null,
          });
          return state.activeTerminal === window.retainedTerminal;
        },
        get term() { return state.activeTerminal.term; },
        data(data) { socket.receive({ type: 'data', data }); },
        pin() {
          const b = this.term.buffer.active;
          return { viewport: b.viewportY, base: b.baseY };
        },
        topLine() {
          const b = this.term.buffer.active;
          return b.getLine(b.viewportY).translateToString();
        },
        visibleText() {
          const b = this.term.buffer.active;
          return Array.from({ length: this.term.rows }, (_, i) =>
            b.getLine(b.viewportY + i)?.translateToString()).join('\\n');
        },
        burst(n = 200) {
          for (let i = 0; i < n; i++) {
            this.data(Array.from({ length: 12 }, (_, j) =>
              'Burst ' + i + ' line ' + j + '               tail\\r\\n').join(''));
          }
        },
        planReady() {
          socket.receive({ type: 'terminal-state', taskAgent: 'codex',
            planApprovalCommand: null, phase: 'planning', codexPlanReady: true });
          socket.receive({ type: 'plan-ready', codexPlanReady: true });
        },
        completion() {
          state.activeTerminal?.detach({ persistCodex: false, refreshBoard: false });
          state.exitedSessions.add('COMPLETE-PROBE');
          state.sessionMeta.set('COMPLETE-PROBE', { startedAt: 1234 });
          window.editOpens = 0;
          window.TipTask = {
            openTerminal,
            fetchActiveSessions: async () => {},
            openTaskEditModal: () => { window.editOpens++; },
          };
          notifyTaskCompleted('COMPLETE-PROBE', { title: 'Finished agent' });
          document.querySelector('.tt-notif-card[data-tag="completed-COMPLETE-PROBE"]').click();
        },
      };
      probe.open('codex');
    `,
    resolveDir: root,
  },
  bundle: true,
  outfile: path.join(dir, 'probe.js'),
  format: 'iife',
  platform: 'browser',
});
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head>
  <link rel="stylesheet" href="${root}/dist/bundle.css">
  <link rel="stylesheet" href="./probe.css">
  <style>#workspace-frame[hidden] { display: none; }</style>
  </head><body><div id="app"></div>
  <div id="workspace-frame" class="task-edit-overlay task-edit-overlay--rail" hidden>
    <div class="task-edit-panel task-edit-panel--tabs" data-pane="terminal">
      <div class="modal-top-bar"><div class="modal-head-meta">Terminal probe</div>
        <div class="task-modal-tabs">Edit / Agent Terminal / Chat</div></div>
      <div id="other-pane" class="task-modal-pane" hidden>Edit / Chat</div>
      <div id="workspace" class="task-modal-pane task-modal-pane--terminal" hidden></div>
    </div>
  </div><script src="./probe.js"></script></body></html>`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verifyStickyApprovalTail(win, run) {
  // Use Chromium mouse input, not scrollToBottom(): the DOM scrollbar must reach
  // the same tail as xterm's buffer without a keyboard-triggered TUI repaint.
  const wheel = async deltaY => {
    const point = await run(`(() => {
      const r = probe.term.element.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY, deltaX: 0 });
    await sleep(150);
  };
  const assertTail = async label => {
    const position = await run('probe.pin()');
    assert.equal(position.viewport, position.base, label + ': buffer tail');
    assert.match(await run('probe.visibleText()'), /Working \.\.\./, label + ': active tail visible');
  };
  for (const agent of process.argv.includes('--claude-workspace') ? [] : ['codex', 'claude', 'pi']) {
    await run(`probe.open('${agent}', true)`);
    await sleep(300);
    await run('probe.burst(30)');
    await sleep(300);
    if (agent === 'codex') {
      await run('probe.planReady()');
      await sleep(250);
      await run('document.querySelector(".btn-plan-proceed").click()');
    }
    // Output overlaps the footer's refit and its trailing ResizeObserver pass.
    await run('probe.burst(100); probe.data("Working ...\\r\\n")');
    await sleep(500);
    await assertTail(agent + ' approval/burst');
    for (const width of [850, 1100]) {
      win.setSize(width, width === 850 ? 600 : 800);
      await sleep(300);
      await assertTail(agent + ' idle resize');
      await run('probe.burst(10); probe.data("Working ...\\r\\n")');
      await sleep(400);
      await assertTail(agent + ' resize');
    }
    await wheel(500);
    assert.ok(await run('probe.pin().viewport < probe.pin().base'), agent + ': wheel scrolls up');
    const readingLine = await run('probe.topLine()');
    await run('probe.burst(20); probe.data("Working ...\\r\\n")');
    await sleep(350);
    assert.equal(await run('probe.topLine()'), readingLine, agent + ': output preserves reading position');
    for (let i = 0; i < 10 && await run('probe.pin().viewport < probe.pin().base'); i++) await wheel(-2000);
    await assertTail(agent + ' mouse reaches tail');
    await run('probe.burst(20); probe.data("Working ...\\r\\n")');
    await sleep(350);
    await assertTail(agent + ' mouse re-lock');
    await run('probe.data("\\u001b[1A\\r\\u001b[2KWorking ... redraw\\r\\n")');
    await sleep(200);
    await assertTail(agent + ' cursor redraw');
    console.log('PASS ' + agent + ' workspace approval/resize/mouse re-lock');
  }
  await verifyClaudeWorkspace(win, run, wheel);
}

// A width-aware TUI draws for the dimensions sent to the PTY, not whatever width
// the browser happens to have now. Include styled spans, a full-width rule and a
// cursor-addressed prompt so wrong wrapping cannot pass a buffer-tail-only check.
async function verifyClaudeWorkspace(win, run, wheel) {
  const geometry = () => run(`(() => {
    const term = probe.term, body = term.element.parentElement;
    const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const rect = body.getBoundingClientRect(), css = getComputedStyle(body);
    const cell = term._core._renderService.dimensions.css.cell;
    const cursor = term.element.querySelector('.xterm-cursor')?.getBoundingClientRect();
    return { cols: term.cols, rows: term.rows, last: sent.filter(m => m.type === 'resize').at(-1),
      availableWidth: body.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      availableHeight: body.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom),
      screenWidth: screen.width, screenHeight: screen.height,
      bottom: screen.bottom, bodyBottom: rect.bottom - parseFloat(css.paddingBottom),
      cell, cursorX: cursor && (cursor.x - screen.x), cursorY: cursor && (cursor.y - screen.y),
      bufferX: term.buffer.active.cursorX, bufferY: term.buffer.active.cursorY,
      domRows: Array.from(term.element.querySelector('.xterm-rows').children, row => row.textContent),
      spans: Array.from(term.element.querySelector('.xterm-rows').children, row =>
        Array.from(row.children, span => {
          const r = span.getBoundingClientRect();
          return { x: r.x - screen.x, y: r.y - screen.y, right: r.right - screen.x };
        })),
      text: probe.visibleText() };
  })()`);
  const assertGeometry = async label => {
    const g = await geometry();
    assert.deepEqual(g.last, { type: 'resize', cols: g.cols, rows: g.rows }, label + ': PTY size');
    assert.ok(g.screenWidth <= g.availableWidth + 1, label + ': screen width ' + JSON.stringify(g));
    assert.ok(g.screenHeight <= g.availableHeight + 1, label + ': screen height ' + JSON.stringify(g));
    assert.ok(g.bottom <= g.bodyBottom + 1, label + ': last row contained');
    assert.ok(g.availableHeight - g.screenHeight < g.cell.height + 1, label + ': fills available rows');
    return g;
  };
  const redraw = async label => {
    await assertGeometry(label);
    await run(`(() => {
      const size = sent.filter(m => m.type === 'resize').at(-1);
      const rule = '─'.repeat(size.cols - 1);
      window.claudeRows = ['Claude redraw: ' + '${label}', rule,
        'Read console-modal.js', 'Words and cursor stay aligned.'];
      probe.data('\\x1b[?1047l\\x1b[?25h\\x1b[2J\\x1b[H' + '\\x1b[36m' + claudeRows[0] + '\\x1b[0m\\r\\n' +
        claudeRows.slice(1).join('\\r\\n') + '\\x1b[' + size.rows + ';1H> ready ');
      probe.term.focus();
    })()`);
    await sleep(200);
    const g = await assertGeometry(label);
    const expected = await run('claudeRows');
    for (let i = 0; i < expected.length; i++) {
      assert.equal(g.text.split('\n')[i].trimEnd(), expected[i], label + ': buffer row ' + i);
      assert.equal(g.domRows[i].trimEnd(), expected[i], label + ': rendered row ' + i);
      for (const span of g.spans[i]) {
        assert.ok(span.x >= -1 && span.right <= g.screenWidth + 1, label + ': spans fit row ' + i);
        assert.ok(Math.abs(span.y - g.spans[i][0].y) <= 1, label + ': spans share row ' + i);
      }
    }
    assert.ok(Math.abs(g.cursorX - g.bufferX * g.cell.width) <= 1, label + ': cursor column ' + JSON.stringify(g));
    assert.ok(Math.abs(g.cursorY - g.bufferY * g.cell.height) <= 1, label + ': cursor row ' + JSON.stringify(g));
  };
  await run("probe.open('claude', true)");
  await sleep(300);
  for (const width of [375, 850, 1400, 700, 1100]) {
    win.setSize(width, 800);
    await sleep(350);
    await redraw('width ' + width);
    await run('probe.pane(false); window.resizeCount = sent.filter(m => m.type === "resize").length');
    win.setSize(width + 70, 700);
    await run('probe.data("\\r\\nHidden Claude output\\r\\n")');
    await sleep(300);
    assert.equal(await run('sent.filter(m => m.type === "resize").length'), await run('resizeCount'),
      'hidden pane must not resize PTY');
    await run('probe.pane(true)');
    await sleep(350);
    await redraw('shown ' + width);
  }
  await run('probe.burst(30)');
  await sleep(250);
  await wheel(500);
  const readingLine = await run('probe.topLine()');
  await run('probe.pane(false); probe.burst(10)');
  await sleep(200);
  await run('probe.pane(true)');
  await sleep(300);
  assert.equal(await run('probe.topLine()'), readingLine, 'Claude tab return preserves reading position');
  await run("probe.open('claude', true, true)");
  await sleep(300);
  assert.equal(await run('socketUrl.includes("prompt=")'), false, 'reopen reconnects without a new prompt');
  await run('probe.data("Replayed Claude session\\r\\n")');
  await sleep(200);
  assert.match(await run('probe.visibleText()'), /Replayed Claude session/);
  await redraw('reopened');
  await run("probe.open('claude', true, false, true)");
  await sleep(250);
  const beforeShow = await run('sent.filter(m => m.type === "resize").length');
  await run('probe.pane(true)');
  await sleep(350);
  assert.ok(await run('sent.filter(m => m.type === "resize").length') > beforeShow,
    'initially hidden terminal sends its measured dimensions on show');
  await redraw('first shown');
  console.log('PASS Claude workspace rows/cursor/PTY size, hidden resize, tab scroll, reopen');
}

// Exercise the real readiness detector as well as xterm. A fake plan-ready frame
// alone cannot catch a resize replay dismissing the dialog that caused the resize.
async function verifyCodexResizeReplay(run) {
  let writes = Promise.resolve();
  const send = msg => {
    writes = writes.then(() => run(`socket.receive(${JSON.stringify(msg)})`));
  };
  const session = {
    taskAgent: 'codex', planApprovalCommand: null, terminalPhase: 'planning',
    alive: true, buffer: 'x'.repeat(501), tabId: 'SCROLL-PROBE', _attentionTail: '',
    ws: { OPEN: 1, readyState: 1, send: raw => send(JSON.parse(raw)) },
  };
  const agent = getTaskAgent('codex');
  const feed = raw => {
    const osc = terminal.stripOscChunk(session, raw);
    const clean = terminal.stripAnsi(osc);
    const rows = reflowChunk(session, osc);
    if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(raw)) session._attentionTail = '';
    session._attentionTail = (session._attentionTail + clean).slice(-1024);
    terminal.feedAttentionChunk(session, agent, osc, clean, undefined, rows);
    send({ type: 'data', data: raw });
  };
  try {
    feed('Plan ready.\r\n');
    await sleep(terminal.CODEX_PLAN_QUIET_MS + 100);
    await writes;
    const repaint = fs.readFileSync(path.join(root, 'fixtures/attention/codex-plan-resize.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const chunk of repaint) {
        feed(chunk);
        terminal.emitTerminalState(session);
        await writes;
        assert.equal(await run('!!document.querySelector(".btn-plan-proceed")'), true,
          'approval must survive historical submissions in a resize repaint');
      }
      await sleep(terminal.CODEX_PLAN_QUIET_MS + 100);
      await writes;
      assert.equal(terminal.codexPlanReadyIsFresh(session), true);
      const position = await run('probe.pin()');
      assert.equal(position.viewport, position.base);
      assert.equal(await run(`(() => {
        const button = document.querySelector('.btn-plan-proceed');
        const r = button.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button;
      })()`), true, 'approval remains visible and clickable');
    }
    console.log('PASS Codex resize replay keeps approval and tail stable');
  } finally {
    clearTimeout(session._planIdleTimer);
  }
}

async function verifyReconnectAfterClose(run) {
  for (const embedded of [false, true]) {
    await run(`probe.open('codex', ${embedded})`);
    await sleep(300);
    await run(`socket.receive({ type: 'terminal-state', taskAgent: 'codex',
      planApprovalCommand: null, phase: 'planning', codexPlanReady: true, startedAt: 123456 });
      probe.data('Stale retained glyphs\\r\\n'); probe.planReady()`);
    await sleep(200);
    // An OPEN retained socket keeps both the existing xterm and its scrollback.
    await run('probe.minimize(); window.socketCount = sockets.length');
    assert.equal(await run(`probe.reopen(${embedded})`), true);
    await sleep(150);
    assert.equal(await run('sockets.length'), await run('socketCount'));
    await run('probe.minimize(); retainedSocket.close()');
    assert.equal(await run('retainedTerminal.disposed'), false, 'closed socket must not dispose parked xterm');
    assert.equal(await run(`probe.reopen(${embedded})`), true, 'reopen reuses retained xterm');
    await sleep(200);
    assert.equal(await run('sockets.length'), await run('socketCount + 1'));
    assert.equal(await run('new URLSearchParams(socketUrl.split("?")[1]).has("prompt")'), false);
    assert.equal(await run('new URLSearchParams(socketUrl.split("?")[1]).get("startedAt")'), '123456');
    // Messages and close callbacks from the replaced socket cannot touch this run.
    await run('retainedSocket.receive({ type: "exit", code: 99 }); retainedSocket.onclose()');
    assert.equal(await run('retainedTerminal.processRunning'), true);
    await run(`socket.receive({ type: 'terminal-state', taskAgent: 'codex',
      planApprovalCommand: null, phase: 'planning', codexPlanReady: true, startedAt: 123456 });
      window.repaintEvents = [];
      socket.onResize = size => {
        if (size.cols === probe.term.cols - 1) {
          repaintEvents.push({ kind: 'down', parsed: probe.visibleText().includes('Replayed Codex plan'), at: performance.now() });
        } else if (repaintEvents.length && size.cols === probe.term.cols) {
          repaintEvents.push({ kind: 'restore', at: performance.now() });
          probe.data('\\x1b[?1049h\\x1b[2J\\x1b[HFull Codex TUI repainted\\r\\nPlan ready.');
        }
      }; undefined`);
    const replay = [];
    const session = { alive: true, taskAgent: 'codex', tabId: 'SCROLL-PROBE',
      terminalPhase: 'planning', codexPlanReady: true, _codexPlan: { ready: true },
      buffer: 'History appears once\r\n\x1b[?1049h\x1b[2J\x1b[HReplayed Codex plan\r\nPlan ready.\x1b[?1049lBlank approval tail',
      ws: { OPEN: 1, readyState: 1, send: raw => replay.push(JSON.parse(raw)) } };
    terminal.replayLiveTerminal(session);
    assert.equal(replay.length, 1, 'server sends the retained buffer in one frame');
    await run(`socket.receive(${JSON.stringify(replay[0])});
      socket.receive({ type: 'plan-ready', codexPlanReady: true })`);
    await sleep(400);
    const events = await run('repaintEvents');
    assert.deepEqual(events.map(event => event.kind), ['down', 'restore']);
    assert.equal(events[0].parsed, true, 'nudge waits for xterm replay parsing');
    assert.ok(events[1].at - events[0].at >= 100, 'actual resize changes stay separated');
    assert.match(await run('probe.visibleText()'), /Full Codex TUI repainted/);
    assert.equal(await run('probe.term.buffer.active === probe.term.buffer.alternate'), true);
    assert.equal(await run('!!document.querySelector(".btn-plan-proceed")'), true);
    const normal = await run(`Array.from({length: probe.term.buffer.normal.length}, (_, i) =>
      probe.term.buffer.normal.getLine(i)?.translateToString()).join('\\n')`);
    assert.doesNotMatch(normal, /Stale retained glyphs/);
    assert.equal(replay[0].data.match(/Replayed Codex plan/g)?.length, 1, 'plan snapshot is sent once');
    assert.equal(await run('socket.sent.some(msg => msg.type === "data" && msg.data === "\\x0c")'), false,
      'planning repaint never injects a key into the approval prompt');
    await run('socket.onResize = null');
    // A second reconnect resets the first-replay bookkeeping, even after executing.
    await run('probe.minimize(); retainedSocket.close()');
    assert.equal(await run(`probe.reopen(${embedded})`), true);
    await sleep(150);
    await run(`socket.receive({ type: 'terminal-state', taskAgent: 'codex',
      planApprovalCommand: null, phase: 'executing', codexPlanReady: false, startedAt: 123456 });
      window.executingNudges = 0;
      socket.onResize = size => {
        if (size.cols === probe.term.cols - 1) executingNudges++;
      }; undefined`);
    await sleep(200);
    assert.equal(await run('executingNudges'), 0, 'no repaint before execution replay');
    session.terminalPhase = 'executing';
    session.buffer = 'History appears once\r\nExecuting Codex TUI\r\nWorking ...';
    replay.length = 0;
    terminal.replayLiveTerminal(session);
    await run(`socket.receive(${JSON.stringify(replay[0])})`);
    await sleep(350);
    assert.match(await run('probe.visibleText()'), /Executing Codex TUI/);
    await run('probe.data("\\r\\nLive output once\\r\\n")');
    await sleep(150);
    const history = await run(`Array.from({length: probe.term.buffer.normal.length}, (_, i) =>
      probe.term.buffer.normal.getLine(i)?.translateToString()).join('\\n')`);
    assert.equal(history.match(/History appears once/g)?.length, 1, 'history is replayed once');
    assert.equal(history.match(/Live output once/g)?.length, 1, 'live chunks are appended once');
    assert.equal(await run('executingNudges'), 1, 'execution reconnect nudges exactly once');
    assert.equal(await run('socket.sent.filter(msg => msg.type === "resize").at(-1).cols'), await run('probe.term.cols'));
    console.log('PASS Codex retained reconnect after close: ' + (embedded ? 'workspace' : 'standalone'));
  }
  for (const agent of ['claude', 'pi']) {
    await run(`probe.open('${agent}', false, true)`);
    await sleep(150);
    await run(`window.otherNudges = 0;
      socket.onResize = size => { if (size.cols === probe.term.cols - 1) otherNudges++; };
      socket.receive({ type: 'terminal-state', taskAgent: '${agent}',
      planApprovalCommand: '${agent === 'claude' ? '/approve-plan' : ''}', phase: 'executing' });
      probe.data('Replayed ${agent} output\\r\\n')`);
    await sleep(250);
    assert.match(await run('probe.visibleText()'), new RegExp('Replayed ' + agent));
    assert.equal(await run('otherNudges'), 0,
      agent + ': client must not send a Codex repaint nudge');
    assert.equal(await run('socket.sent.some(msg => msg.type === "data" && msg.data === "\\x0c")'), false);
    console.log('PASS ' + agent + ' replay without Codex repaint input');
  }
}

async function verifySystemResume(win, run) {
  const other = new BrowserWindow({ show: false, webPreferences: {
    backgroundThrottling: false, preload: path.join(root, 'preload.js'),
  } });
  try {
    await other.loadFile(path.join(dir, 'index.html'));
    await sleep(200);
    await other.webContents.executeJavaScript(`window.resumeCount = 0;
      document.addEventListener('tiptask:system-resume', () => resumeCount++); undefined`);
    await run(`window.resumeCount = 0; window.boardRefreshes = 0; window.sessionFetches = 0;
      window.TipTask = {
        fetchActiveSessions: async () => { sessionFetches++; },
        taskBoard: { updateClaudeButtons() {} },
      };
      document.addEventListener('tiptask:system-resume', () => resumeCount++);
      document.addEventListener('tiptask:task-state-update', () => boardRefreshes++);
      probe.connectAttentionWs(); undefined`);
    await sleep(100);
    for (const mode of ['open', 'closed', 'hidden', 'retained']) {
      await run(`probe.open('codex', true)`);
      await sleep(150);
      await run(`socket.receive({ type: 'terminal-state', taskAgent: 'codex',
          planApprovalCommand: null, phase: 'planning', codexPlanReady: true, startedAt: 123456 }); undefined`);
      await sleep(150);
      await run(`probe.data('Stale before wake\\r\\n'); probe.planReady();
        window.beforeResume = socket; window.beforeBoard = sockets.filter(s => s.url.includes('__attention__')).at(-1);
        window.beforeXterm = probe.term; window.beforeFocus = document.activeElement;
        window.beforeSessionFetches = sessionFetches; window.beforeBoardRefreshes = boardRefreshes;
        window.wakeAt = performance.now(); window.repaintAt = null; undefined`);
      if (mode === 'closed') await run('socket.close()');
      if (mode === 'hidden') await run('probe.pane(false)');
      if (mode === 'retained') await run('probe.minimize()');
      await run('window.focusAtWake = document.activeElement; undefined');
      powerMonitor.emit('resume');
      await sleep(120);
      assert.equal(await run('socket !== beforeResume'), true, mode + ': terminal socket replaced');
      assert.equal(await run('beforeResume.readyState'), 3);
      assert.equal(await run('beforeBoard.readyState'), 3, 'board socket force-closed');
      assert.equal(await run('sessionFetches > beforeSessionFetches && boardRefreshes > beforeBoardRefreshes'), true,
        'board tasks and sessions refresh after resume');
      assert.equal(await run('document.activeElement === focusAtWake'), true, 'resume must not take focus');
      assert.equal(await run('new URLSearchParams(socketUrl.split("?")[1]).has("prompt")'), false);
      assert.equal(await run('new URLSearchParams(socketUrl.split("?")[1]).get("startedAt")'), '123456');
      await run(`window.resumeTerm = ${mode === 'retained' ? 'retainedTerminal' : 'probe'}.term;
        window.sawResumeNudge = false;
        socket.onResize = size => {
          if (size.cols === resumeTerm.cols - 1) sawResumeNudge = true;
          else if (sawResumeNudge && size.cols === resumeTerm.cols) {
            repaintAt = performance.now();
            socket.receive({ type: 'data', data: '\\x1b[?1049h\\x1b[2J\\x1b[HAwake Codex TUI\\r\\nPlan ready.' });
          }
        };
        socket.receive({ type: 'terminal-state', taskAgent: 'codex',
          planApprovalCommand: null, phase: 'planning', codexPlanReady: true, startedAt: 123456 });
        socket.receive({ type: 'data', data: '\\x1b[!p\\x1b[?1049l\\x1b[2J\\x1b[HWake replay' });
        socket.receive({ type: 'plan-ready', codexPlanReady: true }); undefined`);
      if (mode === 'hidden' || mode === 'retained') {
        await sleep(160);
        assert.equal(await run('repaintAt'), null, 'invisible xterm defers repaint');
        assert.equal(await run('document.querySelector(".terminal-embed")?.isConnected || false'), mode === 'hidden');
        if (mode === 'retained') assert.equal(await run('probe.reopen(true)'), true);
        else await run('probe.pane(true)');
      }
      await sleep(260);
      assert.match(await run('probe.visibleText()'), /Awake Codex TUI/);
      const latency = await run('repaintAt - wakeAt');
      assert.ok(latency > 0 && latency < 1000, mode + ': repaint within one second, got ' + latency);
      assert.equal(await run('probe.term === beforeXterm'), true, 'resume keeps xterm instance');
      assert.equal(await run('!!document.querySelector(".btn-plan-proceed")'), true, 'approval preserved');
      assert.equal(await run('document.querySelector(".status-dot").classList.contains("disconnected")'), false);
      assert.equal(await run('socket.sent.some(m => m.type === "data")'), false, 'resume injects no key');
      assert.equal(await run('socket.sent.some(m => m.type === "attention-seen")'), mode === 'open' || mode === 'closed',
        'invisible terminal does not mark unseen attention as read');
      await run('beforeResume.receive({ type: "exit", code: 1 }); beforeResume.onclose()');
      assert.equal(await run('document.querySelector(".status-dot").classList.contains("disconnected")'), false,
        'old callbacks cannot change current status');
      console.log('PASS Electron resume ' + mode + ': IPC → board refresh + Codex repaint in ' + Math.round(latency) + 'ms');
      await run('socket.onResize = null');
    }
    await run('window.beforeUnlock = socket; undefined');
    powerMonitor.emit('resume');
    powerMonitor.emit('unlock-screen');
    await sleep(150);
    assert.equal(await run('socket !== beforeUnlock'), true);
    assert.equal(await run('resumeCount'), 6);
    assert.equal(await other.webContents.executeJavaScript('resumeCount'), 6, 'every window receives both OS events');
    await run('probe.minimize(); retainedTerminal.dispose(); window.beforeDisposeCount = sockets.length; probe.closeAttentionWs(); undefined');
    powerMonitor.emit('unlock-screen');
    await sleep(120);
    assert.equal(await run('sockets.length - beforeDisposeCount'), 1, 'disposed xterm creates no socket; board reconnects');
    await run('probe.closeAttentionWs()');
    console.log('PASS repeated resume/unlock, multi-window IPC, deferred repaint and disposed-terminal cleanup');
  } finally {
    other.destroy();
  }
}

async function main() {
  const resumeOnly = process.argv.includes('--resume-only');
  if (resumeOnly) {
    ipcMain.handle('notify:status', () => ({ supported: false, permission: 'unsupported' }));
    ipcMain.handle('notify:dismiss', () => ({ ok: true }));
  }
  // Use the production main-process handler and preload bridge, with real Electron IPC.
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const resumeStart = mainSource.indexOf('function registerSystemResumeHandlers()');
  vm.runInNewContext(mainSource.slice(resumeStart, mainSource.indexOf('app.whenReady()', resumeStart))
    + '\nregisterSystemResumeHandlers();', { BrowserWindow, powerMonitor, console });
  const win = new BrowserWindow({
    show: false, width: 1200, height: 850,
    webPreferences: { backgroundThrottling: false, ...(resumeOnly ? { preload: path.join(root, 'preload.js') } : {}) },
  });
  const run = expression => win.webContents.executeJavaScript(expression).catch(error => {
    throw new Error(`${error.message}\nRenderer expression: ${expression}`, { cause: error });
  });
  await win.loadFile(path.join(dir, 'index.html'));
  await sleep(400);
  assert.equal(await run('!!window.socket'), true);
  if (resumeOnly) { await verifySystemResume(win, run); win.destroy(); return; }
  if (!process.argv.includes('--reconnect-only')) await verifyStickyApprovalTail(win, run);
  if (process.argv.includes('--claude-workspace')) { win.destroy(); return; }
  await verifyReconnectAfterClose(run);
  if (process.argv.includes('--reconnect-only')) { win.destroy(); return; }
  await run("probe.open('codex')");
  await sleep(300);
  await verifyCodexResizeReplay(run);
  await run('probe.planReady()');
  await sleep(200);
  assert.equal(await run('!!document.querySelector(".btn-plan-proceed")'), true);
  await run('document.querySelector(".btn-plan-proceed").click(); probe.burst()');
  await sleep(600);
  let position = await run('probe.pin()');
  assert.ok(position.base > 900, JSON.stringify(position));
  assert.equal(position.viewport, position.base);
  assert.equal(await run('sent.some(msg => msg.type === "plan-approve")'), true);
  console.log('PASS approval burst', position);

  await run('probe.term.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }))');
  await sleep(200);
  position = await run('probe.pin()');
  assert.ok(position.viewport < position.base, JSON.stringify(position));
  const readingLine = await run('probe.topLine()');
  await run('probe.burst(20)');
  await sleep(350);
  position = await run('probe.pin()');
  // Scrollback is capped; the same old rows move upward when the buffer trims.
  assert.ok(position.viewport < position.base);
  assert.equal(await run('probe.topLine()'), readingLine);
  console.log('PASS scroll up holds', position);

  await run('probe.term.scrollToBottom()');
  await sleep(150);
  await run('probe.burst(20)');
  await sleep(350);
  position = await run('probe.pin()');
  assert.equal(position.viewport, position.base);
  console.log('PASS return to bottom re-locks', position);

  // Queue output and scroll before the parser gets its next turn.
  await run('probe.burst(100); probe.term.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }))');
  await sleep(400);
  position = await run('probe.pin()');
  assert.ok(position.viewport < position.base, JSON.stringify(position));
  console.log('PASS scrolling during queued writes', position);

  for (const agent of ['claude', 'pi']) {
    await run(`probe.open('${agent}')`);
    await sleep(300);
    await run('probe.burst()');
    await sleep(500);
    position = await run('probe.pin()');
    assert.ok(position.base > 900);
    assert.equal(position.viewport, position.base);
    console.log(`PASS ${agent} burst`, position);
  }
  const completionError = await run('(() => { try { probe.completion(); return null; } catch (error) { return error.stack; } })()');
  assert.equal(completionError, null);
  await sleep(300);
  assert.equal(await run('window.editOpens'), 0);
  assert.equal(await run('window.socketUrl.includes("prompt=")'), false);
  await run('socket.receive({ type: "data", data: "Finished agent output\\r\\n" }); socket.receive({ type: "exit", code: 0 })');
  await sleep(300);
  assert.equal(await run('Array.from({length: probe.term.buffer.active.length}, (_, i) => probe.term.buffer.active.getLine(i)?.translateToString()).join("\\n").includes("Finished agent output")'), true);
  console.log('PASS completion card opens xterm output without Edit or a start prompt');
  win.destroy();
}

function finish(code) {
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(main).then(() => finish(0)).catch(error => {
  console.error(error);
  finish(1);
});
