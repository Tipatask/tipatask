// Real Chromium regression for the terminal WebSocket write path.
// Build first, then run with Electron (ELECTRON_RUN_AS_NODE unset).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
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
      window.fetch = async () => new Response(JSON.stringify({
        sessions: [], statuses: [], tasks: [], notifications: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      class Socket {
        static OPEN = 1;
        static CONNECTING = 0;
        constructor(url) {
          this.readyState = 1;
          window.socket = this;
          window.socketUrl = url;
          setTimeout(() => this.onopen?.(), 0);
        }
        send(raw) { (window.sent ||= []).push(JSON.parse(raw)); }
        close() { this.readyState = 3; }
        receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
      }
      window.WebSocket = Socket;
      window.probe = {
        open(agent, embedded = false) {
          state.activeTerminal?.detach({ persistCodex: false, refreshBoard: false });
          state.activeSessions.delete('SCROLL-PROBE');
          state.taskAgent = agent;
          state.taskAgentLabel = agent;
          state.planApprovalCommand = agent === 'codex' ? null : '/approve-plan';
          document.getElementById('workspace').hidden = !embedded;
          openTerminal('SCROLL-PROBE', 'Scroll probe', '', 'in_progress', {
            agent, planOnly: true, host: embedded ? document.getElementById('workspace') : null,
          });
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
  <style>#workspace { position: fixed; inset: 60px 30px 30px 220px; }</style>
  </head><body><div id="app"></div><div id="workspace" class="task-modal-pane task-modal-pane--terminal" hidden></div><script src="./probe.js"></script></body></html>`);

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
  for (const agent of ['codex', 'claude', 'pi']) {
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

async function main() {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 850,
    webPreferences: { backgroundThrottling: false },
  });
  const run = expression => win.webContents.executeJavaScript(expression);
  await win.loadFile(path.join(dir, 'index.html'));
  await sleep(400);
  assert.equal(await run('!!window.socket'), true);
  await verifyStickyApprovalTail(win, run);
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
