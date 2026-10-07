#!/usr/bin/env node
'use strict';

// ── Chat history (native session resume) probe ──
// Runs REAL task-chat and project-chat turns per provider through providers/dispatch.js
// spawnTurn(), with the same history hook and resume code the WS handlers use
// (ws-handlers.js recordChatHistory / resumeChatFromHistory), and checks that a closed chat
// continues the provider's own saved session after a restart:
//   1. RECORDED     — each chat's native session lands in the history index (one entry per
//                     chat; two chats on one task are two entries), with no message text.
//   2. RESUMED      — a SEPARATE process (a restarted Task App: empty memory, index on disk)
//                     resumes the task chat and the project chat by historyId and asks for a
//                     fact told only in the first process; the reply contains it.
//   3. SAME SESSION — the provider answered from the recorded native session id.
//   4. FENCE HELD   — after resume, an edit request still leaves the working tree untouched
//                     and a task update still works.
//   5. ISOLATION    — another project path lists nothing; GET /api/project/chat-history lists
//                     the entries as available, metadata only.
//   6. MISSING      — an entry whose native session does not exist answers history-unavailable
//                     and starts no turn.
//   7. SEARCHABLE   — (TPT539) a word said in a follow-up turn is in the entry's keywords and
//                     GET /api/project/chat-history?q=<word> finds that chat only; the long first
//                     excerpt is clipped.
//   8. RESTORED     — after resume, session.messages holds that follow-up's user text and the
//                     assistant's replies, read back from the provider's own session file, ahead
//                     of the hidden marker.
//   9. ONLY NEW     — the next turn's prompt is a `resume` prompt carrying only the new message;
//                     no restored text is sent.
//
// No server is started and port 4455 is never touched; the WS connect path (which syncs the
// KB) is not used. Turns run in a throwaway scratch project with a copy of this project's
// credentials. One scratch task is created in the configured API project and deleted at the end,
// and the providers' session stores for the scratch directory are removed unless --keep.
//
// Usage: npm run probe:chat-history -- --yes [--provider claude,codex,pi] [--keep] [--verbose]
// Exit codes: 0 = every provider that ran passed · 1 = a check failed · 2 = refused to run ·
//             3 = nothing could run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const TURN_TIMEOUT_MS = 6 * 60 * 1000;

function parseArgs(argv) {
  const opts = { yes: false, keep: false, verbose: false, providers: ['claude', 'codex', 'pi'], phase: 'record', state: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') opts.yes = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--provider') opts.providers = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--phase') opts.phase = String(argv[++i] || '');
    else if (a === '--state') opts.state = String(argv[++i] || '');
  }
  return opts;
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.tipatask', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const KB_SYNCED = new Set(['ai', 'CLAUDE.md', 'AGENTS.md']);
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      const top = rel.split(path.sep)[0];
      if (top.startsWith('.') || KB_SYNCED.has(top)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function scrubEnv() {
  for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDECODE' || /^CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)$/.test(key)) delete process.env[key];
    if (/^(API_BASE_URL|API_TOKEN|API_PROJECT_ID|TIPATASK_TASK_ID|TIPATASK_TRACK_DIR|TIPATASK_ELECTRON_HOST)$/.test(key)) delete process.env[key];
  }
}

// Shared by both phases: the modules are required only after the scratch env is set.
function loadRuntime() {
  const config = require('../src/server/config');
  return {
    config,
    createSession: require('../src/server/session-state').createSession,
    spawnTurn: require('../src/server/providers/dispatch').spawnTurn,
    teardownObjectiveSession: require('../src/server/claude-session').teardownObjectiveSession,
    task: require('../src/server/task-chat'),
    resolvePiMcpBridge: require('../src/server/providers/pi-task-tools').resolvePiMcpBridge,
    readPiEntries: require('../src/server/project-config').readPiEntries,
    ws: require('../src/server/ws-handlers'),
    persistence: require('../src/server/chat-persistence'),
  };
}

function apiClient(base, projectId, token) {
  return async (method, p, body) => {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/api/projects/${projectId}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    return { status: res.status, json, text };
  };
}

// A chat session wired like ws-handlers.js start-task-chat / start-project-chat, minus the socket.
function makeChat(rt, { provider, scratch, projectId, task, verbose, tracked }) {
  const id = task ? `taskChat:${task.id}` : `projectChat:${projectId}:${crypto.randomBytes(4).toString('hex')}`;
  const frames = [];
  let waiter = null;
  const ws = {
    OPEN: 1, readyState: 1, close() {},
    send: (raw) => {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (verbose && frame.type !== 'data' && frame.type !== 'objective-thinking') console.log(`  [${provider}] ${frame.type}${frame.reason ? ` ${frame.reason}` : ''}`);
      if (waiter && (frame.type === 'chat-ready' || frame.type === 'objective-error')) waiter(frame);
    },
  };
  const session = rt.createSession(ws, false, id, scratch);
  Object.assign(session, {
    type: 'taskChat',
    taskKey: task ? task.id : null,
    chatProjectId: task ? null : String(projectId),
    toolProfile: rt.task.TASK_CHAT,
    projectPath: scratch,
    providerType: provider,
    selectedModel: null,
    backend: { getCredentials: () => ({ projectId: String(projectId) }) },
    _taskChatTask: task ? { id: task.id, title: task.title } : null,
    _taskChatProject: task ? null : { id: String(projectId), name: 'Probe project' },
  });
  session.onTaskChatMutation = () => null;
  session.onNativeSession = () => { rt.ws.recordChatHistory(session); };
  tracked.push({ session, id });
  // `inspect(session)` runs after the user message is pushed, right before the spawn.
  const turn = (content, { seed = false, push = true, inspect = null } = {}) => new Promise((resolve) => {
    const from = frames.length;
    const timer = setTimeout(() => { waiter = null; resolve({ timedOut: true, frames: frames.slice(from) }); }, TURN_TIMEOUT_MS);
    waiter = (frame) => { clearTimeout(timer); waiter = null; resolve({ frame, frames: frames.slice(from) }); };
    if (push) session.messages.push({ role: 'user', content, ...(seed ? { seed: true } : {}), timestamp: Date.now() });
    if (seed) session.firstPrompt = content;
    if (inspect) inspect(session);
    rt.spawnTurn(session, id);
  });
  const reply = () => ([...session.messages].reverse().find(m => m.role === 'assistant') || {}).content || '';
  const systemPrompt = () => {
    const piMcpBridge = provider === 'pi' && !!rt.resolvePiMcpBridge({ projectRoot: scratch, userDataRoot: rt.config.USER_DATA_ROOT });
    session.systemPrompt = rt.task.buildTaskChatSystemPrompt({ provider, task: task || null, project: task ? null : session._taskChatProject, piMcpBridge });
  };
  return { id, session, frames, turn, reply, systemPrompt };
}

const failedTurn = t => (t.timedOut ? 'timed out' : t.frame.type === 'objective-error' ? `${t.frame.reason}${t.frame.detail ? ` — ${String(t.frame.detail).slice(0, 300)}` : ''}` : null);

// ── Phase 1 (parent): create scratch project + task, hold the first conversations ──
async function recordPhase(opts) {
  const sourceRoot = findProjectRoot(process.env.TIPATASK_PROJECT_ROOT || process.cwd());
  if (!sourceRoot) { console.error('No .tipatask/config.json found above the current directory.'); process.exit(2); }
  const sourceCfg = JSON.parse(fs.readFileSync(path.join(sourceRoot, '.tipatask', 'config.json'), 'utf8'));
  const { baseUrl: base, projectId, token } = require('../src/server/api-credentials').getApiCredentials(sourceRoot);
  delete sourceCfg.API_TOKEN;
  if (!base || !projectId || !token) { console.error('The selected project or signed-in account is unavailable.'); process.exit(2); }
  if (!opts.yes) {
    console.error([
      'This probe runs real agent turns and writes to a real API:',
      `  API:      ${base} (project ${projectId})`,
      '  Creates:  one scratch task, deleted again when the probe ends',
      `  Spends:   about 9 model turns per provider (${opts.providers.join(', ')})`,
      'Re-run with --yes to proceed.',
    ].join('\n'));
    process.exit(2);
  }

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-chat-history-probe-')));
  const userData = path.join(scratch, '.userdata');
  fs.mkdirSync(path.join(scratch, '.tipatask'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(scratch, '.tipatask', 'config.json'), JSON.stringify(sourceCfg, null, 2));
  fs.writeFileSync(path.join(scratch, 'target.txt'), 'original line\n');
  scrubEnv();
  process.env.TIPATASK_PROJECT_ROOT = scratch;
  process.env.TIPATASK_USER_DATA = userData;
  process.env.TIPATASK_SERVER_ROOT = SERVER_ROOT;
  process.env.TIPATASK_NO_BANNER = '1';
  require('../src/server/account-store').writeAccountToken(base, token, { userDataRoot: userData });
  const rt = loadRuntime();
  require('../src/server/project-config').writeProjectMcpConfig(scratch, SERVER_ROOT);
  const api = apiClient(base, projectId, token);

  const tracked = [];
  let taskKey = null;
  const results = [];
  try {
    const created = await api('POST', '/tasks', {
      title: '[probe] chat-history scratch task (safe to delete)',
      description: 'Created by scripts/probe-chat-history.js. It deletes this task when it finishes.',
      category: 'CODING',
      priority: 0,
    });
    taskKey = created.json && created.json.task && created.json.task.task_key;
    if (created.status !== 201 || !taskKey) throw new Error(`could not create the scratch task (HTTP ${created.status}): ${created.text.slice(0, 200)}`);
    const task = { id: taskKey, title: created.json.task.title, description: created.json.task.description, status: created.json.task.status };
    console.log(`Scratch project: ${scratch}\nScratch task:    ${taskKey} @ ${base} (project ${projectId})\n`);

    const state = { scratch, taskKey, projectId: String(projectId), task, providers: [] };
    for (const provider of opts.providers) {
      const result = { provider, ran: false, recorded: null, searchable: null, notes: [] };
      results.push(result);
      if (!['claude', 'codex', 'pi'].includes(provider)) { result.notes.push('unknown provider'); continue; }
      if (provider === 'pi' && rt.readPiEntries(sourceCfg).length === 0) { result.notes.push('no PI_MODELS row configured'); continue; }
      console.log(`── ${provider}: first conversations ──`);
      const taskWord = `TASKWORD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const projectWord = `PROJWORD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      const chatA = makeChat(rt, { provider, scratch, projectId, task, verbose: opts.verbose, tracked });
      chatA.systemPrompt();
      const tA = await chatA.turn(rt.task.buildTaskChatSeed({ task, comments: [], openingMessage: `Remember this for later in our conversation: the secret codeword is ${taskWord}. Do not use any tools. Reply with just the word "noted".` }), { seed: true });
      if (failedTurn(tA)) { result.notes.push(`task chat: ${failedTurn(tA)}`); continue; }
      // A fact told in a follow-up (not the seed): what the read-back and the keyword index must hold.
      const fruitWord = `FRUITWORD${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const factText = `One more fact to keep: my favourite fruit is called ${fruitWord}. `
        + 'This sentence is padding so the first excerpt is long enough to be clipped by the history index, '
        + 'which keeps only about two hundred characters of it. Do not use any tools. Reply with just the word "noted".';
      const tA2 = await chatA.turn(factText);
      if (failedTurn(tA2)) { result.notes.push(`task chat follow-up: ${failedTurn(tA2)}`); continue; }
      const chatB = makeChat(rt, { provider, scratch, projectId, task, verbose: opts.verbose, tracked });
      chatB.systemPrompt();
      const tB = await chatB.turn(rt.task.buildTaskChatSeed({ task, comments: [], openingMessage: 'Do not use any tools. Reply with just the word "ok".' }), { seed: true });
      if (failedTurn(tB)) { result.notes.push(`second task chat: ${failedTurn(tB)}`); continue; }
      const chatP = makeChat(rt, { provider, scratch, projectId, task: null, verbose: opts.verbose, tracked });
      chatP.systemPrompt();
      const tP = await chatP.turn(rt.task.buildTaskChatSeed({ project: chatP.session._taskChatProject, tasks: [], openingMessage: `Remember this: the project codeword is ${projectWord}. Do not use any tools. Reply with just the word "noted".` }), { seed: true });
      if (failedTurn(tP)) { result.notes.push(`project chat: ${failedTurn(tP)}`); continue; }
      result.ran = true;
      // Close all three the way kill does: the entry is stamped ended, nothing is deleted.
      for (const chat of [chatA, chatB, chatP]) {
        await rt.ws.recordChatHistory(chat.session, { ended: true });
        rt.teardownObjectiveSession(chat.session, chat.id, 'probe-close');
      }
      const entries = await rt.persistence.readChatHistory(scratch);
      const fieldOf = { claude: 'claudeSessionId', codex: 'codexSessionId', pi: 'piSessionId' }[provider];
      const find = chat => entries.find(e => e.provider === provider && e.nativeSessionId === chat.session[fieldOf]);
      const eA = find(chatA);
      const eB = find(chatB);
      const eP = find(chatP);
      result.recorded = !!(eA && eB && eP && eA.historyId !== eB.historyId && eA.kind === 'task' && eP.kind === 'project' && eA.endedAt);
      // (TPT539) Search data: the follow-up's word is a keyword, the long first excerpt is clipped.
      const kw = (eA && eA.keywords) || [];
      const first = (eA && eA.excerpts && eA.excerpts.first) || '';
      result.searchable = kw.includes(fruitWord.toLowerCase()) && !((eB && eB.keywords) || []).includes(fruitWord.toLowerCase())
        && first.length <= 200 && first.endsWith('…') && first.includes(fruitWord) && kw.length <= 40;
      console.log(`  search data  -> ${kw.length} keywords, ${fruitWord.toLowerCase()} ${kw.includes(fruitWord.toLowerCase()) ? 'present' : 'MISSING'}, first excerpt ${first.length} chars${first.endsWith('…') ? ' (clipped)' : ''}`);
      console.log(`  index        -> task chat ${eA ? 'recorded' : 'MISSING'}, second task chat ${eB ? 'recorded' : 'MISSING'}, project chat ${eP ? 'recorded' : 'MISSING'}`);
      if (!result.recorded) { result.notes.push('history entries missing or wrong'); continue; }
      state.providers.push({ provider, taskWord, projectWord, fruitWord, taskHistoryId: eA.historyId, projectHistoryId: eP.historyId, taskNativeId: eA.nativeSessionId, projectNativeId: eP.nativeSessionId });
    }

    const indexFile = fs.readdirSync(userData).find(n => n.startsWith('chat-history'));
    const raw = indexFile ? fs.readFileSync(path.join(userData, indexFile), 'utf8') : '';
    const leaked = state.providers.some(p => raw.includes(p.taskWord) || raw.includes(p.projectWord));
    console.log(`\nindex file holds message text: ${leaked ? 'YES (fail)' : 'no'}`);

    // ── Phase 2: a separate process stands in for a restarted Task App ──
    let resumeResults = [];
    if (state.providers.length) {
      const statePath = path.join(scratch, '.probe-state.json');
      fs.writeFileSync(statePath, JSON.stringify(state));
      console.log('\n── restart: resuming in a new process ──');
      const child = spawnSync(process.execPath, [__filename, '--phase', 'resume', '--state', statePath, ...(opts.verbose ? ['--verbose'] : [])], {
        env: process.env, stdio: ['ignore', 'inherit', 'inherit'], timeout: TURN_TIMEOUT_MS * 6 * state.providers.length,
      });
      try { resumeResults = JSON.parse(fs.readFileSync(`${statePath}.out`, 'utf8')); }
      catch { resumeResults = state.providers.map(p => ({ provider: p.provider, notes: [`resume process failed (exit ${child.status})`] })); }
    }

    console.log('\nprovider  ran   recorded  resumed-task  resumed-project  same-session  fence-held  task-updated  isolated  missing-refused  searchable  restored  only-new  notes');
    let pass = results.some(r => r.ran) && !leaked;
    for (const r of results) {
      const rr = resumeResults.find(x => x.provider === r.provider) || {};
      const row = [r.provider.padEnd(8), String(r.ran).padEnd(4), String(r.recorded).padEnd(8), String(rr.resumedTask).padEnd(12), String(rr.resumedProject).padEnd(15),
        String(rr.sameSession).padEnd(12), String(rr.fenceHeld).padEnd(10), String(rr.taskUpdated).padEnd(12), String(rr.isolated).padEnd(8), String(rr.missingRefused).padEnd(15),
        String(!!(r.searchable && rr.searchFound)).padEnd(10), String(rr.restored).padEnd(8), String(rr.onlyNew).padEnd(8),
        [...r.notes, ...(rr.notes || [])].join('; ')];
      console.log(row.join('  '));
      if (r.ran && !(r.recorded && rr.resumedTask && rr.resumedProject && rr.sameSession && rr.fenceHeld && rr.taskUpdated && rr.isolated && rr.missingRefused
        && r.searchable && rr.searchFound && rr.restored && rr.onlyNew)) pass = false;
    }
    return { exit: results.some(r => r.ran) ? (pass ? 0 : 1) : 3, cleanup: { api, taskKey, scratch, tracked, rt } };
  } catch (err) {
    console.error(`\nProbe aborted: ${err.message}`);
    return { exit: 1, cleanup: { api, taskKey, scratch, tracked, rt } };
  }
}

// ── Phase 2 (child): empty memory, the history index on disk ──
async function resumePhase(opts) {
  const state = JSON.parse(fs.readFileSync(opts.state, 'utf8'));
  const rt = loadRuntime();
  const { scratch, task } = state;
  const projectId = state.projectId;
  const { baseUrl: base, token } = require('../src/server/api-credentials').getApiCredentials(scratch);
  const api = apiClient(base, projectId, token);
  const tracked = [];
  const out = [];

  for (const p of state.providers) {
    const r = { provider: p.provider, resumedTask: null, resumedProject: null, sameSession: null, fenceHeld: null, taskUpdated: null, isolated: null, missingRefused: null, searchFound: null, restored: null, onlyNew: null, notes: [] };
    out.push(r);
    console.log(`── ${p.provider}: after restart ──`);
    const fieldOf = { claude: 'claudeSessionId', codex: 'codexSessionId', pi: 'piSessionId' }[p.provider];
    const resume = async (chat, historyId) => {
      const sessions = new Map([[chat.id, chat.session]]);
      // The provider the server would start with is not the recorded one: resume must switch it.
      chat.session.providerType = p.provider === 'claude' ? 'codex' : 'claude';
      const ok = await rt.ws.resumeChatFromHistory(chat.session, { sessions, sessionKey: chat.id, taskId: chat.id, historyId });
      return { ok, error: chat.frames.find(f => f.type === 'objective-error') };
    };
    try {
      // Task chat: the codeword was only ever said in the first process.
      const chatA = makeChat(rt, { provider: p.provider, scratch, projectId, task, verbose: opts.verbose, tracked });
      const resA = await resume(chatA, p.taskHistoryId);
      if (!resA.ok) { r.notes.push(`task resume refused: ${resA.error && resA.error.message}`); continue; }
      // (TPT539) The earlier conversation, read back from the provider's file, sits ahead of the marker.
      const msgs = chatA.session.messages;
      const markerAt = msgs.findIndex(m => m.resumed);
      const restored = msgs.filter(m => m.restored);
      const resumedFrame = chatA.frames.find(f => f.type === 'chat-history-resumed') || {};
      r.restored = markerAt === msgs.length - 1 && restored.length >= 2 && msgs.slice(0, markerAt).every(m => m.restored)
        && restored.some(m => m.role === 'user' && m.content.includes(p.fruitWord)) && restored.some(m => m.role === 'assistant')
        && !restored.some(m => m.content.includes(p.taskWord) && m.role === 'user') // the seed is left out
        && resumedFrame.transcriptUnavailable === false && (resumedFrame.messages || []).length === restored.length;
      console.log(`  read-back    -> ${restored.length} restored messages${r.restored ? '' : ' (WRONG)'}: ${restored.map(m => `${m.role}:${m.content.replace(/\s+/g, ' ').slice(0, 40)}`).join(' | ')}`);
      const question = 'What is the secret codeword I gave you earlier? Answer with just the codeword.';
      const { buildTurnPrompt } = require('../src/server/providers/transcript');
      const askA = await chatA.turn(question, {
        inspect: (session) => {
          const built = buildTurnPrompt(session, { includeSystemPrompt: p.provider !== 'claude', hasProviderSession: true });
          r.onlyNew = built.mode === 'resume' && built.prompt.startsWith(question) && !built.prompt.includes(p.fruitWord)
            && !restored.some(m => m.content.length > 20 && built.prompt.includes(m.content));
        },
      });
      if (failedTurn(askA)) { r.notes.push(`task follow-up: ${failedTurn(askA)}`); continue; }
      r.resumedTask = chatA.reply().includes(p.taskWord);
      console.log(`  task chat    -> ${r.resumedTask ? 'REMEMBERED' : 'forgot'} (${chatA.reply().replace(/\s+/g, ' ').slice(0, 120)})`);
      r.sameSession = chatA.session[fieldOf] === p.taskNativeId;

      // Fence after resume: refuse the edit, still able to update the task.
      const before = snapshotTree(scratch);
      const edit = await chatA.turn('Append the line "PROBE_EDIT" to target.txt in the current directory using any tool you have, then say whether it changed.');
      r.fenceHeld = !failedTurn(edit) && JSON.stringify(snapshotTree(scratch)) === JSON.stringify(before);
      const marker = `PROBE_RESUMED_${p.provider}_${crypto.randomBytes(3).toString('hex')}`;
      const upd = await chatA.turn(`Set the description of task ${task.id} to exactly this text: ${marker}\nDo it now, then confirm in one sentence.`);
      if (!failedTurn(upd)) {
        const fresh = await api('GET', `/tasks/${encodeURIComponent(task.id)}`);
        r.taskUpdated = String(fresh.json && fresh.json.task && fresh.json.task.description || '').includes(marker);
      }
      r.sameSession = r.sameSession && chatA.session[fieldOf] === p.taskNativeId;
      console.log(`  fence        -> working tree ${r.fenceHeld ? 'UNCHANGED' : 'CHANGED'}, task update ${r.taskUpdated ? 'DONE' : 'NOT done'}, native id ${r.sameSession ? 'unchanged' : 'CHANGED'}`);

      // Project chat.
      const chatP = makeChat(rt, { provider: p.provider, scratch, projectId, task: null, verbose: opts.verbose, tracked });
      const resP = await resume(chatP, p.projectHistoryId);
      if (!resP.ok) { r.notes.push(`project resume refused: ${resP.error && resP.error.message}`); continue; }
      const askP = await chatP.turn('What is the project codeword I gave you earlier? Answer with just the codeword.');
      if (!failedTurn(askP)) r.resumedProject = chatP.reply().includes(p.projectWord);
      r.sameSession = r.sameSession && chatP.session[fieldOf] === p.projectNativeId;
      console.log(`  project chat -> ${r.resumedProject ? 'REMEMBERED' : 'forgot'} (${chatP.reply().replace(/\s+/g, ' ').slice(0, 120)})`);

      // Isolation + endpoint.
      const otherPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-chat-history-other-')));
      const otherEntries = await rt.persistence.readChatHistory(otherPath);
      fs.rmSync(otherPath, { recursive: true, force: true });
      const list = async (asProjectId, query) => {
        const { Readable } = require('node:stream');
        const handler = rt.ws.createHttpHandler(new Map(), () => ({ getCredentials: () => ({ projectId: asProjectId }) }));
        const req = Readable.from([]);
        Object.assign(req, { method: 'GET', url: `/api/project/chat-history${query}`, headers: { 'x-tipatask-project': scratch } });
        const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
        await handler(req, res);
        return (res.body && res.body.entries) || [];
      };
      const mine = (await list(projectId, `?taskKey=${task.id}`)).find(e => e.historyId === p.taskHistoryId);
      const found = await list(projectId, `?taskKey=${task.id}&q=${encodeURIComponent(p.fruitWord.toLowerCase())}`);
      r.searchFound = found.length === 1 && found[0].historyId === p.taskHistoryId;
      console.log(`  search       -> q=${p.fruitWord.toLowerCase()} lists ${found.length} chat(s)${r.searchFound ? ' (the right one)' : ''}`);
      const otherProject = await list('999999', '');
      r.isolated = otherEntries.length === 0 && otherProject.length === 0 && !!mine && mine.available === true && !('nativeSessionId' in mine);
      console.log(`  isolation    -> other path ${otherEntries.length} entries, other project id ${otherProject.length}, endpoint lists this chat ${mine ? (mine.available ? 'available' : 'unavailable') : 'NOT'}`);

      // Missing native session.
      const ghostId = crypto.randomUUID();
      const real = (await rt.persistence.readChatHistory(scratch)).find(e => e.historyId === p.taskHistoryId);
      await rt.persistence.upsertChatHistory(scratch, { ...real, historyId: ghostId, nativeSessionId: crypto.randomUUID() });
      const ghost = makeChat(rt, { provider: p.provider, scratch, projectId, task, verbose: opts.verbose, tracked });
      const resG = await resume(ghost, ghostId);
      r.missingRefused = !resG.ok && !!resG.error && resG.error.reason === 'history-unavailable' && ghost.session.messages.length === 0 && !ghost.session.proc;
      console.log(`  missing      -> ${r.missingRefused ? `refused (${resG.error.message})` : 'NOT refused'}`);
    } catch (err) {
      r.notes.push(`resume phase error: ${err.message}`);
    }
  }
  for (const { session, id } of tracked) {
    try { rt.teardownObjectiveSession(session, id, 'probe-end'); } catch { /* best effort */ }
  }
  fs.writeFileSync(`${opts.state}.out`, JSON.stringify(out));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.phase === 'resume') {
    await resumePhase(opts);
    process.exit(0);
  }
  const { exit, cleanup } = await recordPhase(opts);
  const { api, taskKey, scratch, tracked, rt } = cleanup;
  for (const { session, id } of tracked || []) {
    try { rt.teardownObjectiveSession(session, id, 'probe-end'); } catch { /* best effort */ }
  }
  if (taskKey) {
    const del = await api('DELETE', `/tasks/${encodeURIComponent(taskKey)}`).catch(err => ({ status: `error: ${err.message}` }));
    console.log(`\nScratch task ${taskKey} delete -> ${del.status}`);
  }
  if (opts.keep) console.log(`Scratch dir kept: ${scratch}`);
  else if (scratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
    // The providers' own stores for the scratch cwd (Codex kept its sessions inside the scratch dir).
    const { claudeProjectDirName } = require('../src/server/task-agent/final-message');
    const { piDefaultSessionDir } = require('../src/server/pi-custom-endpoint');
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    for (const dir of [path.join(claudeHome, 'projects', claudeProjectDirName(scratch)), piDefaultSessionDir(scratch, process.env)]) {
      if (dir.includes('tt-chat-history-probe-')) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
