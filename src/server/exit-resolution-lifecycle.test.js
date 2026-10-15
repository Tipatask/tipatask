'use strict';

// (TPT354) End-to-end for ws-handlers.js's session.onSessionExit: the REAL handler, the REAL
// ClaudeAgent#readFinalMessage reading a REAL transcript file from a temp CLAUDE_CONFIG_DIR, and
// a fake backend that records what would be posted. No PTY, no network. The `completed` wait for
// an unfinished turn (up to 90 s) is covered by exit-resolution.test.js with a fake clock and is
// deliberately not exercised here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wireSessionLifecycle, terminateTerminalSession, terminateObjectiveSessions } = require('./ws-handlers');
const { claudeProjectDirName } = require('./task-agent/final-message');
const { AGENT_EXIT_MARKER, isAgentLogTailComment } = require('./resolution-payload');

const ESC = '\x1b';
const BEL = '\x07';
const CWD = '/work/proj';
const SESSION_ID = 'cccccccc-1111-2222-3333-444444444444';
const TASK = 'TPT354';

// Claude Code's noisy title bar + spinner + status chrome, as raw PTY bytes.
function noisyBuffer(withReadableLine) {
  let s = '';
  for (let i = 0; i < 60; i++) {
    s += `${ESC}]0;${i % 2 ? '◑' : '◐'} Ahrefs 76→88 score gain attribution${BEL}${ESC}[2K✻ Sock-hopping…${ESC}[30G${i}\r\n`;
  }
  s += 'Too many changed files to show diff\r\n5 new messages (click) ↓\r\n';
  if (withReadableLine) s += 'Wired the exit comment builder into the session lifecycle handler.\r\n';
  s += `${ESC}]0;◐ Ahrefs 76→88 score gain attribution${BEL}`;
  return s;
}

function transcript(t, lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-life-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'projects', claudeProjectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), lines.map(o => JSON.stringify(o)).join('\n') + '\n');
  return { cwd: CWD, spawnedAt: Date.now() - 1000, taskId: TASK, agentSessionId: SESSION_ID, env: { CLAUDE_CONFIG_DIR: home } };
}

const asst = (stop, text) => ({ type: 'assistant', message: { id: `m-${stop}`, stop_reason: stop, content: [{ type: 'text', text }] } });

function makeBackend({ comments = [], secondComments, failComments = false } = {}) {
  const posted = [];
  let fetches = 0;
  return {
    posted,
    fetches: () => fetches,
    async getTaskComments() {
      fetches++;
      if (failComments) throw new Error('api down');
      return fetches > 1 && secondComments ? secondComments : comments;
    },
    async createTaskComment(taskId, content, type) { posted.push({ taskId, content, type }); return { id: 999 }; },
    async addTokenUsage() {},
  };
}

function makeSession(overrides = {}) {
  return { taskAgent: 'claude', _resolutionPosted: false, _commentBaselineId: 10, _transcriptHint: null, ...overrides };
}

const report = (id, extra = {}) => ({ id, comment_type: 'resolution', content: 'Changed the exit comment builder. Files: ws-handlers.js. Verify: npm test. Follow-ups: none.', ...extra });

async function exit(session, backend, args) {
  wireSessionLifecycle(session, TASK, backend);
  await session.onSessionExit(args);
}

test('noisy title-bar session + transcript → concise readable comment, no garbage', async (t) => {
  const hint = transcript(t, [
    { type: 'user', message: { role: 'user', content: `Work on task ${TASK}: fix it` } },
    asst('end_turn', 'Fixed the garbled exit comment. It now posts the agent\'s final message.'),
    { type: 'last-prompt' },
  ]);
  const backend = makeBackend();
  await exit(makeSession({ _transcriptHint: hint }), backend, { reason: 'completed', buffer: noisyBuffer(true) });
  assert.equal(backend.posted.length, 1);
  const { taskId, content, type } = backend.posted[0];
  assert.equal(taskId, TASK);
  assert.equal(type, 'resolution');
  assert.equal(content, `Agent completed the task\n\nFixed the garbled exit comment. It now posts the agent's final message.\n\n${AGENT_EXIT_MARKER}`);
  assert.doesNotMatch(content, /Ahrefs|Sock-hopping|0;◐|new messages|Too many changed/);
  assert.equal(isAgentLogTailComment(content), true);
});

test('no transcript, noisy buffer with one real line → concise fenced sanitized tail', async () => {
  const backend = makeBackend();
  await exit(makeSession(), backend, { reason: 'completed', buffer: noisyBuffer(true) });
  const { content } = backend.posted[0];
  assert.match(content, /^Agent completed the task\n\n```\nWired the exit comment builder into the session lifecycle handler\.\n```\n\n<!-- tipatask:agent-exit -->$/);
  assert.ok(content.length < 250, `expected a concise comment, got ${content.length} chars`);
});

test('no transcript, pure garbage buffer → header + marker only, never the garbage', async () => {
  const backend = makeBackend();
  await exit(makeSession(), backend, { reason: 'completed', buffer: noisyBuffer(false) });
  assert.equal(backend.posted[0].content, `Agent completed the task\n\n${AGENT_EXIT_MARKER}`);
});

test('Codex-style chrome-only buffer → header only', async () => {
  const backend = makeBackend();
  const buffer = '\n\n◦ Working (8m 12s • esc to interrupt)\n\n\n› Ask Codex to do anything\n\n  GPT-5.6-Sol medium · ~/Projects/Tipatask · Review system architecture        ⚠ 1 warning · f2 to view';
  await exit(makeSession({ taskAgent: 'codex' }), backend, { reason: 'user-terminated', buffer });
  assert.equal(backend.posted[0].content, `Agent session terminated by user\n\n${AGENT_EXIT_MARKER}`);
});

test('agent posted its own resolution report this run → nothing is posted', async (t) => {
  const hint = transcript(t, [asst('end_turn', 'All done here and verified.')]);
  const backend = makeBackend({ comments: [report(11)] });
  await exit(makeSession({ _transcriptHint: hint, _commentBaselineId: 10 }), backend, { reason: 'completed', buffer: noisyBuffer(true) });
  assert.equal(backend.posted.length, 0);
});

test('report from a PREVIOUS run (id ≤ baseline) does not suppress', async (t) => {
  const hint = transcript(t, [asst('end_turn', 'Second run finished the follow-up work.')]);
  const backend = makeBackend({ comments: [report(10)] });
  await exit(makeSession({ _transcriptHint: hint, _commentBaselineId: 10 }), backend, { reason: 'completed', buffer: '' });
  assert.equal(backend.posted.length, 1);
  assert.match(backend.posted[0].content, /Second run finished the follow-up work\./);
});

test('unknown baseline (null) fails toward posting even when a resolution comment exists', async (t) => {
  const hint = transcript(t, [asst('end_turn', 'Finished, baseline was unknown.')]);
  const backend = makeBackend({ comments: [report(50)] });
  await exit(makeSession({ _transcriptHint: hint, _commentBaselineId: null }), backend, { reason: 'completed', buffer: '' });
  assert.equal(backend.posted.length, 1);
});

test('comments fetch failing fails toward posting', async (t) => {
  const hint = transcript(t, [asst('end_turn', 'Finished while the API was flaky.')]);
  const backend = makeBackend({ failComments: true });
  await exit(makeSession({ _transcriptHint: hint }), backend, { reason: 'completed', buffer: '' });
  assert.equal(backend.posted.length, 1);
});

test('completed: a report that lands DURING the transcript read is caught by the re-check', async (t) => {
  const hint = transcript(t, [asst('end_turn', 'Closing message after the report.')]);
  // 1st fetch (before): nothing yet. 2nd fetch (re-check after the read): the agent's report.
  const backend = makeBackend({ comments: [], secondComments: [report(11)] });
  await exit(makeSession({ _transcriptHint: hint, _commentBaselineId: 10 }), backend, { reason: 'completed', buffer: '' });
  assert.equal(backend.fetches(), 2);
  assert.equal(backend.posted.length, 0);
});

test('user-terminated mid-turn: the last thing the agent said is still used, no wait', async (t) => {
  const hint = transcript(t, [asst('tool_use', 'Now let me run the test suite to confirm.')]);
  const backend = makeBackend();
  const started = Date.now();
  await exit(makeSession({ _transcriptHint: hint }), backend, { reason: 'user-terminated', buffer: '' });
  assert.ok(Date.now() - started < 2000, 'must not sit in the 90 s completion wait');
  assert.equal(backend.posted[0].content, `Agent session terminated by user\n\nNow let me run the test suite to confirm.\n\n${AGENT_EXIT_MARKER}`);
});

test('natural exit header carries the exit code', async () => {
  const backend = makeBackend();
  await exit(makeSession(), backend, { exitCode: 137, buffer: '' });
  assert.equal(backend.posted[0].content, `Agent session ended (exit code 137)\n\n${AGENT_EXIT_MARKER}`);
});

test('exactly one comment per run: a second exit trigger is a no-op', async () => {
  const backend = makeBackend();
  const session = makeSession();
  wireSessionLifecycle(session, TASK, backend);
  await session.onSessionExit({ reason: 'completed', buffer: '' });
  await session.onSessionExit({ reason: 'user-terminated', buffer: '' });
  assert.equal(backend.posted.length, 1);
});

test('no backend → resolves without posting or throwing', async () => {
  const session = makeSession();
  wireSessionLifecycle(session, TASK, null);
  await session.onSessionExit({ reason: 'completed', buffer: noisyBuffer(true) });
  assert.equal(session._resolutionPosted, false, 'dedup flag untouched when there is no backend to post to');
});

test('a posting failure is swallowed (logged), never thrown into the exit path', async () => {
  const backend = makeBackend();
  backend.createTaskComment = async () => { throw new Error('POST failed'); };
  await assert.doesNotReject(exit(makeSession(), backend, { reason: 'completed', buffer: '' }));
});

// ── Exit backstop (TPT613) ──
// The real onSessionExit, with the backstop's live reads injected through wireSessionLifecycle's
// `deps`. Sessions above have no type/phase, so the backstop never touches their backends.
const BACKSTOP_ROLES = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };
const BACKSTOP_CHECK = {
  verified: true, vcs: { type: 'git', worktree: false, commit: true, pr: false, merge: false }, ready: false,
  blockers: [{ code: 'TASK_COMMIT_MISSING', message: `no commit starting with ${TASK}` }],
};
const BACKSTOP_HEADER = 'Agent exited without committing / completing: no task commit found';

function backstopBackend(opts) {
  const backend = makeBackend(opts);
  backend.getTask = async (id) => ({ id, status: 'in_progress' });
  backend.getStatuses = async () => [{ name: 'in_progress' }, { name: 'on_fire' }];
  backend.updateTask = async (id, fields) => { backend.posted.push({ taskId: id, status: fields.status }); return { id, ...fields }; };
  return backend;
}

function backstopDeps(frames) {
  return {
    fetchStatusRoles: async () => BACKSTOP_ROLES,
    checkTaskCommit: async () => BACKSTOP_CHECK,
    websocket: { emitTaskUpdated() {}, emitTaskLeftUncommitted: (...args) => frames.push(args) },
  };
}

function executingSession(overrides = {}) {
  return makeSession({ type: 'terminal', terminalPhase: 'executing', _injectDone: true, nudgeCount: 0, ...overrides });
}

// First line of each comment, or the status a write set — the order things landed in.
const writes = (backend) => backend.posted.map(p => p.status || p.content.split('\n')[0]);

// terminateTerminalSession() fires onSessionExit without awaiting it; keep its promise.
function captureExit(session) {
  const wired = session.onSessionExit;
  const box = {};
  session.onSessionExit = (args) => (box.done = wired(args));
  return box;
}

test('exit backstop: runs after the exit comment, once per run', async () => {
  const backend = backstopBackend();
  const frames = [];
  const session = executingSession();
  wireSessionLifecycle(session, TASK, backend, { deps: backstopDeps(frames) });
  await session.onSessionExit({ exitCode: 0, buffer: '' });
  await session.onSessionExit({ reason: 'user-terminated', buffer: '' });
  assert.deepEqual(writes(backend), ['Agent session ended (exit code 0)', 'on_fire', BACKSTOP_HEADER]);
  assert.equal(frames.length, 1);
});

test('exit backstop: still runs when the agent posted its own report and the exit comment is skipped', async () => {
  const backend = backstopBackend({ comments: [report(11)] });
  const frames = [];
  const session = executingSession();
  wireSessionLifecycle(session, TASK, backend, { deps: backstopDeps(frames) });
  await session.onSessionExit({ reason: 'user-terminated', buffer: '' });
  assert.deepEqual(writes(backend), ['on_fire', BACKSTOP_HEADER]);
  assert.equal(frames.length, 1);
});

test('exit backstop: a real Terminate flags the task — the key Terminate just deleted is not a newer run', async () => {
  const backend = backstopBackend();
  const frames = [];
  const sessions = new Map();
  // pid 0: killProcessGroup() refuses it, so no real process is ever signaled.
  const session = executingSession({ alive: true, pty: { pid: 0, kill() {} }, _terminalOutputSeen: true, buffer: '', projectPath: '/projects/a' });
  sessions.set(TASK, session);
  wireSessionLifecycle(session, TASK, backend, { sessions, sessionKey: TASK, deps: backstopDeps(frames) });
  const exited = captureExit(session);
  terminateTerminalSession(session, TASK, TASK, sessions, 'terminated', { ackWs: null, backend });
  assert.equal(sessions.has(TASK), false);
  await exited.done;
  assert.deepEqual(writes(backend), ['Agent session terminated by user', 'on_fire', BACKSTOP_HEADER]);
  assert.match(backend.posted[2].content, /was terminated by the user/);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], '/projects/a');
  assert.equal(frames[0][1], TASK);
});

test('exit backstop: an objective-tab close (a confirmed bulk stop) posts the exit comment but never flags', async () => {
  const backend = backstopBackend();
  const frames = [];
  const sessions = new Map();
  const session = executingSession({ alive: true, pty: { pid: 0, kill() {} }, _terminalOutputSeen: true, buffer: '', tabId: TASK });
  sessions.set(TASK, session);
  wireSessionLifecycle(session, TASK, backend, { sessions, sessionKey: TASK, deps: backstopDeps(frames) });
  const exited = captureExit(session);
  assert.deepEqual(terminateObjectiveSessions(new Set([TASK]), sessions, backend, ''), [TASK]);
  await exited.done;
  assert.deepEqual(writes(backend), ['Agent session terminated by user']);
  assert.equal(frames.length, 0);
});

test('exit backstop: a newer run under the same key (Stop, then Start) is not flagged', async () => {
  const backend = backstopBackend();
  const frames = [];
  const sessions = new Map([[TASK, null]]);
  const session = executingSession();
  sessions.set(TASK, session);
  wireSessionLifecycle(session, TASK, backend, { sessions, sessionKey: TASK, deps: backstopDeps(frames) });
  const done = session.onSessionExit({ reason: 'user-terminated', buffer: '' });
  sessions.set(TASK, { type: 'terminal', pending: true }); // the new run's session object
  await done;
  assert.deepEqual(writes(backend), ['Agent session terminated by user']);
  assert.equal(frames.length, 0);
});
