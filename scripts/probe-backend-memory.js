#!/usr/bin/env node
'use strict';

// Per-project api-backend retained-memory probe + idle-eviction check.
//
// Creates K real createApiBackend() instances against a local stub API (127.0.0.1, random
// port — never the real API, never port 4455), warms every cache the board and agent paths
// fill (unfiltered list, scoped list, three board-window entries, statuses, project
// settings), and reports heapUsed after a forced GC: baseline → K backends warm → after
// the idle evictor (backend-eviction.js, same dispose() the registries call) released them.
// Then an offline leg: a write queued while the API is down keeps its backend through a
// sweep, replays once the API is back, and only then is the backend evicted.
//
//   npm run probe:backend-memory [-- --projects=K --tasks=N]
//
// Needs --expose-gc (the npm script passes it). Scratch dirs only; removed on exit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

if (typeof global.gc !== 'function') {
  console.error('Run with --expose-gc (npm run probe:backend-memory does).');
  process.exit(2);
}

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const PROJECTS = arg('projects', 8);
const TASKS = arg('tasks', 600);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-probe-backend-memory-'));
process.env.TIPATASK_PROJECT_ROOT = path.join(scratch, 'global');
fs.mkdirSync(process.env.TIPATASK_PROJECT_ROOT);
process.env.TIPATASK_USER_DATA = path.join(scratch, 'user-data');
fs.mkdirSync(process.env.TIPATASK_USER_DATA);
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });

// Quiet the backend's own connect/reset log lines; keep this probe's output readable.
const realLog = console.log;
console.log = () => {};
const out = (...a) => realLog(...a);

const { createApiBackend } = require('../src/server/api-backend');
const { createBackendEvictor } = require('../src/server/backend-eviction');

const LOREM = 'Step: read the module, change the handler, add a regression test, update the KB. '.repeat(8);
function rawTasks(projectId) {
  const rows = [];
  for (let i = 1; i <= TASKS; i++) {
    rows.push({
      id: projectId * 100000 + i, task_key: `P${projectId}-${i}`, title: `Task ${i} of project ${projectId}`,
      description: `${LOREM}${i}`, status: i % 5 === 0 ? 'completed' : 'pending', priority: 1 + (i % 12),
      category: 'CODING', assignee: i % 3 === 0 ? null : 42, tags: ['tt-api-backend', 'performance', 'bugfix'],
      dependencies: i > 1 && i % 4 === 0 ? [`P${projectId}-${i - 1}`] : [], display_order: i,
      created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
    });
  }
  return rows;
}

function stubApi() {
  const state = { patches: [], tasksByProject: new Map() };
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/auth/me') return json(res, 200, { user: { id: 42 } });
    const m = url.pathname.match(/^\/api\/projects\/(\d+)(\/.*)?$/);
    if (!m) return json(res, 404, { error: 'not found' });
    const pid = Number(m[1]);
    const rest = m[2] || '';
    if (!state.tasksByProject.has(pid)) state.tasksByProject.set(pid, rawTasks(pid));
    const tasks = state.tasksByProject.get(pid);
    if (req.method === 'GET' && rest === '') return json(res, 200, { project: { id: pid, name: `P${pid}`, vcs_type: 'off' }, is_owner: true });
    if (req.method === 'GET' && rest === '/statuses') {
      return json(res, 200, { statuses: ['pending', 'in_progress', 'on_fire', 'completed', 'canceled'].map((name, i) => ({ id: i + 1, name, display_order: i, is_default: i === 0, is_complete: name === 'completed', is_canceled: name === 'canceled' })) });
    }
    if (req.method === 'GET' && rest === '/tasks/changes') return json(res, 200, { count: tasks.length, max_id: tasks.length, max_updated_at: '2026-10-02T00:00:00.000Z' });
    if (req.method === 'GET' && rest === '/tasks') {
      const windowed = url.searchParams.get('window') === 'active';
      return json(res, 200, windowed ? { tasks, window: { floor: 1, has_older: false, extended: 0 } } : { tasks });
    }
    const p = rest.match(/^\/tasks\/([^/]+)$/);
    if (p && req.method === 'GET') {
      const row = tasks.find(t => t.task_key === decodeURIComponent(p[1]));
      return row ? json(res, 200, { task: row }) : json(res, 404, { error: 'not found' });
    }
    if (p && req.method === 'PATCH') {
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => {
        const patch = JSON.parse(body || '{}');
        state.patches.push({ key: decodeURIComponent(p[1]), patch });
        const row = tasks.find(t => t.task_key === decodeURIComponent(p[1]));
        if (row) Object.assign(row, patch.title ? { title: patch.title } : {});
        json(res, 200, { task: row });
      });
    }
    return json(res, 404, { error: 'not found' });
  };
  return { state, handler };
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}
function stop(server) {
  return new Promise(r => { server.close(() => r()); server.closeAllConnections(); });
}

function projectRoot(port, projectId) {
  const root = path.join(scratch, `project-${projectId}`);
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api', API_BASE_URL: `http://127.0.0.1:${port}`, API_TOKEN: 'probe-opaque-token', API_PROJECT_ID: String(projectId),
  }));
  return root;
}

async function heapMb() {
  for (let i = 0; i < 4; i++) { global.gc(); await new Promise(r => setImmediate(r)); }
  return process.memoryUsage().heapUsed / 1048576;
}

async function warm(backend) {
  await backend.getTasksUnfiltered();
  await backend.getTasks();
  await backend.getBoardTasks();
  await backend.getBoardTasks({ unscoped: true });
  await backend.getBoardTasks({ fullWindow: true });
  await backend.getStatuses();
  await backend.getProjectSettings();
}

async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const api = stubApi();
  const server = http.createServer(api.handler);
  const port = await listen(server);

  const registry = new Map();
  const clock = { t: 0 };
  const evictor = createBackendEvictor({
    entries: () => registry,
    isInUse: () => false,
    evict: (p, b) => { b.dispose(); registry.delete(p); },
    idleMs: 1000,
    now: () => clock.t,
  });

  // Warm the module code paths once so the baseline doesn't count one-time JIT/require cost.
  {
    const b = createApiBackend(null, projectRoot(port, 999));
    await b.init();
    await warm(b);
    b.dispose();
  }
  // The stub's own rows count toward the heap too — build them all before the baseline,
  // JSON round-tripped so their strings are already flat (a concatenated string that
  // JSON.stringify flattens later would otherwise show up as retained growth).
  const seed = (pid) => api.state.tasksByProject.set(pid, JSON.parse(JSON.stringify(rawTasks(pid))));
  for (let i = 1; i <= PROJECTS; i++) seed(i);
  seed(500);
  const base = await heapMb();

  for (let i = 1; i <= PROJECTS; i++) {
    const root = projectRoot(port, i);
    const b = createApiBackend(null, root);
    await b.init();
    await warm(b);
    registry.set(root, b);
    evictor.touch(root);
  }
  const warmMb = await heapMb();
  const perBackend = (warmMb - base) / PROJECTS;

  clock.t += 1000;
  const evicted = evictor.sweep();
  const afterMb = await heapMb();

  out(`[probe] ${PROJECTS} project backends × ${TASKS} tasks each (stub API on 127.0.0.1:${port})`);
  out(`[probe] heapUsed baseline           ${base.toFixed(2)} MB`);
  out(`[probe] heapUsed with backends warm ${warmMb.toFixed(2)} MB  (+${(warmMb - base).toFixed(2)} MB, ~${perBackend.toFixed(2)} MB per backend)`);
  out(`[probe] heapUsed after eviction     ${afterMb.toFixed(2)} MB  (${evicted.length} evicted, ${(afterMb - base).toFixed(2)} MB above baseline)`);
  if (evicted.length !== PROJECTS) throw new Error(`expected ${PROJECTS} evictions, got ${evicted.length}`);
  if (afterMb - base > Math.max(0.5, (warmMb - base) * 0.05)) throw new Error('retained heap did not return near baseline after eviction');

  // ── Offline leg: a queued write keeps its backend until the reconnect replays it ──
  const root = projectRoot(port, 500);
  const b = createApiBackend(null, root);
  await b.init();
  await warm(b);
  registry.set(root, b);
  evictor.touch(root);
  await stop(server);
  const queued = await b.updateTask('P500-1', { title: 'written while offline' });
  if (!queued || !queued._pendingSync || b.getPendingMutationCount() !== 1) throw new Error('offline write was not queued');
  clock.t += 10_000;
  if (evictor.sweep().length !== 0 || !registry.has(root)) throw new Error('backend with a queued write was evicted');
  out('[probe] offline write queued; sweep kept its backend');

  const server2 = http.createServer(api.handler);
  await listen(server2, port);
  await waitFor(() => b.getConnectionState() === 'connected' && b.getPendingMutationCount() === 0, 40_000, 'reconnect drain');
  const replayed = api.state.patches.find(x => x.key === 'P500-1' && x.patch.title === 'written while offline');
  if (!replayed) throw new Error('queued write never reached the API');
  out('[probe] API back; queued write replayed');
  clock.t += 500;
  if (evictor.sweep().length !== 0) throw new Error('evicted inside the idle window right after the drain');
  clock.t += 1000;
  if (evictor.sweep()[0] !== root) throw new Error('drained backend was not evicted after the idle window');
  out('[probe] drained backend evicted after the idle window');
  await stop(server2);
  out('[probe] OK');
}

main().then(() => process.exit(0), (err) => {
  console.error(`[probe] FAILED: ${err && err.message}`);
  process.exit(1);
});
