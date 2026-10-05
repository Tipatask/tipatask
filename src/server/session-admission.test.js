'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSessionAdmission } = require('./session-admission');
const { createAdmissionCoordinator, parseServerCensus } = require('./admission-coordinator');
const { resolveAdmissionPolicy, GiB } = require('./admission-policy');
const { createSessionQueue } = require('./session-queue');
const { resolveAgentLimits } = require('./process-group');

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, { mode = 'pressure', config = {}, projectConfigs = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const instances = [], alive = new Set(), clock = { at: 0 }, host = {}, processes = { rows: [], fresh: true, status: 'ok' };
  const cfg = { AGENT_ADMISSION_MODE: mode, ...config };
  const hardware = { totalMemBytes: 48 * GiB, cores: 18 };
  let censusOverride;
  const telemetry = () => ({ host: { status: 'ok', fresh: true, pressure: 'normal', sampledAt: clock.at,
    physicalBytes: 48 * GiB, reclaimableEstimateBytes: 40 * GiB, swapOutBytes: 0, pageSizeBytes: 16384, ...host },
    processes: { sampledAt: clock.at, ...processes }, history: [] });
  function instance(pid, overrides = {}) {
    alive.add(pid);
    const sessions = new Map(), started = [];
    const queue = createSessionQueue({ getSessions: () => sessions, defaultProject: '/a', log: () => {},
      resolveLimits: project => resolveAgentLimits(project, { hardware, env: {}, readConfig: () => projectConfigs[project] || {} }) });
    const coordinator = createAdmissionCoordinator({ directory, pid, alive: pid => alive.has(pid), now: () => clock.at });
    const admission = createSessionAdmission({ getSessions: () => sessions, getTelemetry: telemetry,
      isRunning: queue.isRunning, coordinator, now: () => clock.at,
      readProject: project => projectConfigs[project] || {}, env: {},
      resolvePolicy: () => resolveAdmissionPolicy({ env: {}, hardware, platform: 'darwin', read: () => ({ config: { ...cfg, ...overrides }, status: 'ok' }) }),
      runner: { run: async (file, args) => {
        const text = censusOverride === undefined ? [...alive].map(id => `${id} node /app/todo-server.js`).join('\n') : censusOverride;
        if (text === null || !args[1].includes('comm')) return text;
        return text.split('\n').map(line => line.trim().split(/\s+/).slice(0, 2).join(' ')).join('\n');
      }, stop() {} },
      onChange: () => queue.drain() });
    queue.setAdmission(admission);
    const request = (id, projectPath = '/a', launch) => {
      const session = { taskId: id, type: 'terminal', projectPath, taskAgent: 'codex', alive: false, pending: false };
      sessions.set(id, session);
      const result = queue.submit({ key: id, session, taskId: id, start: launch || (async () => {
        started.push(id); session.alive = true; session._launching = false; session.ptyPid = pid + started.length;
      }) });
      return { session, result };
    };
    const value = { sessions, queue, admission, request, started, coordinator, pid };
    instances.push(value); return value;
  }
  const advance = async at => { clock.at = at; for (const i of instances) await i.admission.poll(); await tick(); };
  const warm = async () => { for (let at = 0; at <= 60000; at += 5000) await advance(at); };
  return { instance, advance, warm, clock, host, processes, config: cfg, alive, directory,
    census(value) { censusOverride = value; } };
}

test('rapid Play All reserves synchronously, spaces starts and never exceeds eight across projects', async t => {
  const h = harness(t); const a = h.instance(1000); await h.warm();
  for (let n = 0; n < 20; n++) a.request(`T${n}`, n % 2 ? '/b' : '/a');
  assert.equal(a.queue.countRunning(), 1);
  assert.equal(a.queue.size(), 19);
  await tick(); assert.deepEqual(a.started, ['T0']);
  for (let at = 65000; at <= 150000; at += 5000) {
    await h.advance(at);
    assert.ok(a.queue.countRunning() <= 8);
    const state = JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
    const slots = Object.values(state.instances).flatMap(o => o.slots);
    assert.ok(slots.filter(s => s.running).length <= 8);
  }
  assert.deepEqual(a.started, Array.from({ length: 8 }, (_, n) => `T${n}`));
});

for (const ceiling of [6, 8, 12]) test(`replay ${ceiling} ordinary slots across independent registries and projects`, async t => {
  const h = harness(t, { config: { AGENT_ADMISSION_CEILING: ceiling }, projectConfigs: {
    '/a': { AGENT_ADMISSION_WORKLOAD_CLASS: 'ordinary' }, '/b': { AGENT_ADMISSION_WORKLOAD_CLASS: 'ordinary' },
  } });
  const a = h.instance(1000), b = h.instance(2000); await h.warm();
  for (let n = 0; n < ceiling + 4; n++) (n % 2 ? b : a).request(`R${n}`, n % 2 ? '/b' : '/a');
  for (let at = 65000; at <= 250000; at += 5000) {
    await h.advance(at);
    assert.ok(a.queue.countRunning() + b.queue.countRunning() <= ceiling);
  }
  assert.equal(a.started.length + b.started.length, ceiling);
  assert.equal(a.queue.size() + b.queue.size(), 4);
  assert.equal(b.admission.snapshot().reservedBytes, ceiling * 2 * GiB);
});

test('twelve-slot ceiling does not promise twelve unknown unobserved launches', async t => {
  const h = harness(t, { config: { AGENT_ADMISSION_CEILING: 12 } });
  const a = h.instance(1000); await h.warm();
  for (let n = 0; n < 12; n++) a.request(`R${n}`);
  for (let at = 65000; at <= 250000; at += 5000) await h.advance(at);
  assert.equal(a.started.length, 8); // 40 GiB proxy cannot cover 6 + 1 + 9 * 4 GiB.
  assert.equal(a.queue.snapshot().queued[0].reason, 'headroom');
});

test('different watchdog RSS budgets cannot change shared ceiling; lower project cap does not block others', async t => {
  const h = harness(t, { mode: 'static', projectConfigs: {
    '/a': { AGENT_LIMITS_MAX_TREE_RSS_MB: 128, AGENT_LIMITS_MAX_CONCURRENT_SESSIONS: 1 },
    '/b': { AGENT_LIMITS_MAX_TREE_RSS_MB: 32768 } } });
  const a = h.instance(1000); await h.advance(0);
  a.request('A1'); a.request('A2'); a.request('B1', '/b'); await tick();
  assert.deepEqual(a.started, ['A1', 'B1']);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'project-cap');
  assert.equal(a.queue.snapshot('/b').cap, 6);
});

test('independent registries share launch spacing, reservations and FIFO tickets', async t => {
  const h = harness(t); const a = h.instance(1000), b = h.instance(2000); await h.warm();
  a.request('A1'); a.request('A2'); b.request('B1'); await tick();
  assert.deepEqual(b.started, []);
  // B polls first but cannot jump A2's older eligible ticket.
  h.clock.at = 70000; await b.admission.poll(); assert.deepEqual(b.started, []);
  await a.admission.poll(); await tick(); assert.deepEqual(a.started, ['A1', 'A2']);
  for (let at = 75000; at <= 80000; at += 5000) await h.advance(at);
  assert.deepEqual(b.started, ['B1']);
  assert.equal(b.queue.snapshot('/a').running, 3);
});

test('completed memory holders keep gaps, paused holders keep slots, observed memory retires reservation without double counting', async t => {
  const h = harness(t); const a = h.instance(1000); await h.warm();
  const { session } = a.request('A'); await tick(); session._memoryRunId = 'run-a';
  h.processes.sampledAt = 60001;
  h.processes.rows = [{ id: 'run-a', currentRssBytes: 3 * GiB, observableRssBytes: 3 * GiB, peakMinusCurrentBytes: GiB }];
  await a.admission.poll();
  assert.equal(a.admission.snapshot().reservedBytes, 4 * GiB); // host predates observation
  await h.advance(65000);
  assert.equal(a.admission.snapshot().reservedBytes, GiB);
  await a.admission.poll(); assert.equal(a.admission.snapshot().reservedBytes, GiB); // repeated sample stable
  session._pause = {}; assert.equal(a.queue.countRunning(), 1);
  session._completionEmitted = true;
  await h.advance(70000); assert.equal(a.queue.countRunning(), 0);
  assert.equal(a.admission.snapshot().reservedBytes, 0);
  h.host.reclaimableEstimateBytes = 11 * GiB;
  a.request('B');
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'headroom'); // 6 + 1 + retained 1 + new 4
  assert.equal(session.alive, true);
});

test('launch failure, cancellation and exit release reservations and drain later requests', async t => {
  const h = harness(t, { mode: 'static' }); const a = h.instance(1000); await h.advance(0);
  a.request('bad', '/a', async () => { throw Error('spawn failed'); });
  await tick();
  for (let n = 0; n < 7; n++) a.request(`T${n}`);
  await tick(); assert.equal(a.started.length, 6);
  a.sessions.get('T0').alive = false; a.queue.drain(); await tick();
  assert.equal(a.started.length, 7);
  a.request('canceled'); a.queue.remove('canceled'); a.sessions.delete('canceled');
  await h.advance(5000);
  assert.equal(a.admission.snapshot().reservedBytes, 6 * 4 * GiB);
});

test('foreign or stale independent instances close admission without touching healthy terminals', async t => {
  const h = harness(t); const a = h.instance(1000); await h.warm();
  const { session } = a.request('A'); await tick();
  h.census('1000 node /app/todo-server.js\n9999 node /other/todo-server.js');
  await h.advance(65000); a.request('B');
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'coordination');
  assert.equal(session.alive, true);
  h.census(undefined); const b = h.instance(2000); await h.advance(70000);
  h.clock.at = 90000; await a.admission.poll();
  assert.equal(a.admission.snapshot().reason, 'coordination');
  assert.equal(b.started.length, 0);
});

test('live ceiling and project setting changes apply while waiting; lowering never kills current holders', async t => {
  const projectConfigs = { '/a': { AGENT_LIMITS_MAX_CONCURRENT_SESSIONS: 1 } };
  const h = harness(t, { projectConfigs }); const a = h.instance(1000); await h.warm();
  a.request('A'); a.request('B'); await tick();
  projectConfigs['/a'].AGENT_LIMITS_MAX_CONCURRENT_SESSIONS = 12;
  await h.advance(65000); await h.advance(70000);
  assert.deepEqual(a.started, ['A', 'B']);
  h.config.AGENT_ADMISSION_CEILING = 1;
  a.request('C'); await h.advance(75000);
  assert.equal(a.queue.snapshot('/a').cap, 1);
  assert.equal(a.queue.countRunning(), 2);
  assert.equal(a.queue.size(), 1);
});

test('failed census refuses expansion and unknown pressure falls back to shared static count', async t => {
  const h = harness(t); const a = h.instance(1000); h.census(null);
  h.host.fresh = false;
  for (let n = 0; n < 7; n++) a.request(`T${n}`);
  for (let at = 0; at <= 70000; at += 5000) await h.advance(at);
  assert.equal(a.started.length, 6);
  assert.equal(a.queue.size(), 1);
});

test('coordinator lock is atomic across a real independent process; corrupt state fails closed', t => {
  const h = harness(t);
  const coordinator = createAdmissionCoordinator({ directory: h.directory });
  const child = () => spawnSync(process.execPath, ['-e', `
    const { createAdmissionCoordinator } = require(process.argv[1]);
    const c = createAdmissionCoordinator({ directory: process.argv[2] });
    const result = c.transaction(state => { state.counter = (state.counter || 0) + 1; return state.counter; });
    process.stdout.write(JSON.stringify(result));
  `, require.resolve('./admission-coordinator'), h.directory], { encoding: 'utf8', timeout: 5000 });
  const first = coordinator.transaction(state => {
    state.counter = 1;
    const other = child(); assert.equal(other.status, 0);
    assert.equal(JSON.parse(other.stdout).ok, false);
  });
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(child().stdout).result, 2);
  fs.writeFileSync(path.join(h.directory, 'admission-state.json'), '{}');
  assert.equal(coordinator.transaction(() => assert.fail('must not run')).ok, false);
});

test('dead server reservations retain live children and unobserved launches; no heartbeat expiry steals slots', t => {
  const h = harness(t); h.alive.add(42); h.alive.add(101);
  const c = createAdmissionCoordinator({ directory: h.directory, pid: 42, alive: pid => h.alive.has(pid) });
  c.transaction((s, id) => { s.instances[id] = { pid: 42, at: 0, fingerprint: 'test', mode: 'pressure', staticCap: 6, fallbackCap: 6, queued: [], extraGapBytes: 0, slots: [101, null].map((pid, n) => ({ id: String(n), project: 'p', pid, running: true, reservedBytes: 4 * GiB, gapBytes: 0 })) }; });
  h.alive.delete(42);
  const result = c.transaction(s => Object.values(s.instances)[0]);
  assert.equal(result.result.orphaned, true); assert.equal(result.result.slots.length, 2);
  h.alive.delete(101);
  assert.equal(c.transaction(s => Object.values(s.instances)[0].slots.length).result, 1);
});

test('server census detects supported entry points and rejects failed input without persisting argv', () => {
  const own = path.join(__dirname, 'index.js');
  assert.deepEqual(parseServerCensus(`10 node /app/todo-server.js\n11 node ${own}\n12 node /project/other.js\n13 node /x/src/server/index.js`), [10, 11]);
  assert.equal(parseServerCensus(null), null);
  assert.equal(parseServerCensus('bad'), null);
  assert.equal(parseServerCensus('10 node /app/todo-server.js', 'bad'), null);
});

test('server census ignores grep, tail, editors and agent argv that merely mention the server script', () => {
  assert.deepEqual(parseServerCensus('20 grep todo-server.js'), []);
  assert.deepEqual(parseServerCensus('21 tail -f /x/ai/todo/server/todo-server.js\n22 vim todo-server.js'), []);
  assert.deepEqual(parseServerCensus('23 /bin/zsh -c node ai/todo/server/todo-server.js'), []);
  const claude = '24 /Users/me/.local/bin/claude --model x Serve Task App: node ai/todo/server/todo-server.js and open it';
  assert.deepEqual(parseServerCensus(claude, '24 /Users/me/.local/bin/claude'), []);
  assert.deepEqual(parseServerCensus('25 node /x/other.js /y/todo-server.js'), []);
  assert.deepEqual(parseServerCensus('26 /usr/local/bin/node --max-old-space-size=4096 /y/todo-server.js'), [26]);
  const helper = '/Applications/TipATask.app/Contents/Frameworks/TipATask Helper.app/Contents/MacOS/TipATask Helper';
  assert.deepEqual(parseServerCensus(`27 ${helper} /Applications/TipATask.app/Contents/Resources/app.asar/todo-server.js`,
    `27 ${helper}`), [27]);
  const spaced = '/Users/me/My Projects/server/todo-server.js';
  assert.deepEqual(parseServerCensus(`28 node ${spaced}`, '28 node', { scripts: [spaced] }), [28]);
});

test('static mode counts a stopped owner with live holders instead of refusing a fourth session', async t => {
  const h = harness(t, { mode: 'static' }); const a = h.instance(1000), b = h.instance(2000); await h.advance(0);
  for (const id of ['B1', 'B2', 'B3']) b.request(id);
  await tick(); assert.equal(b.started.length, 3);
  for (const s of b.sessions.values()) h.alive.add(s.ptyPid);
  await h.advance(1000);
  b.admission.stop(); h.alive.delete(2000);
  for (const id of ['A1', 'A2', 'A3', 'A4']) a.request(id);
  await tick();
  assert.deepEqual(a.started, ['A1', 'A2', 'A3']);
  const snap = a.admission.snapshot();
  assert.equal(snap.coordinationReason, 'stale-or-orphaned-owner');
  assert.equal(snap.cap, 6); assert.equal(snap.running, 6);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
});

test('static mode counts an unregistered server pid conservatively and ignores non-server census lines', async t => {
  const h = harness(t, { mode: 'static' }); const a = h.instance(1000);
  h.census('1000 node /app/todo-server.js\n9998 grep todo-server.js\n9997 tail -f /app/todo-server.js');
  await h.advance(0);
  a.request('A0'); await tick();
  assert.equal(a.admission.snapshot().coordinationReason, null);
  h.census('1000 node /app/todo-server.js\n9999 node /other/todo-server.js');
  await h.advance(5000);
  for (let n = 1; n < 7; n++) a.request(`A${n}`);
  await tick();
  assert.equal(a.started.length, 5); // 5 local + 1 unregistered = fallback cap 6
  const snap = a.admission.snapshot();
  assert.equal(snap.coordinationReason, 'unregistered-server');
  assert.equal(snap.detail, null);
  assert.equal(snap.instances, 1);
  assert.equal(snap.censusPidCount, 2);
  assert.equal(snap.unregisteredCount, 1);
  assert.deepEqual(snap.unregisteredPids, [9999]);
  assert.equal(snap.cap, 6);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
});

test('static mode admits under a stale owner heartbeat, counting all its slots', async t => {
  const h = harness(t, { mode: 'static' }); const a = h.instance(1000), b = h.instance(2000); await h.advance(0);
  b.request('B1'); b.request('B2'); await tick(); assert.equal(b.started.length, 2);
  await h.advance(1000);
  h.clock.at = 30000; await a.admission.poll();
  const decision = a.admission.inspect({ projectPath: '/a' }, null);
  assert.equal(decision.allowed, true);
  assert.equal(decision.coordinationReason, 'stale-or-orphaned-owner');
  assert.equal(decision.cap, 6); assert.equal(decision.running, 2);
  for (let n = 0; n < 5; n++) a.request(`A${n}`);
  await tick();
  assert.equal(a.started.length, 4);
});

test('shutdown cancels the timer and census; late completion cannot write state or drain', async () => {
  let complete, starts = 0, clears = 0, stops = 0, writes = 0, drains = 0;
  const admission = createSessionAdmission({ getSessions: () => new Map(), getTelemetry: () => ({}),
    coordinator: { stop() { stops++; }, transaction() { writes++; } },
    runner: { run: () => new Promise(resolve => { complete = resolve; }), stop() {} },
    setIntervalFn: () => { starts++; return 123; }, clearIntervalFn: id => { assert.equal(id, 123); clears++; },
    onChange: () => { drains++; } });
  admission.start(); admission.start(); const pending = admission.poll();
  admission.stop(); admission.stop(); complete('1 node /app/todo-server.js'); await pending;
  assert.deepEqual({ starts, clears, stops, writes, drains }, { starts: 1, clears: 1, stops: 1, writes: 0, drains: 0 });
});

test('conflicting instance policy disables expansion; static peers obey shared pressure spacing', async t => {
  const h = harness(t); const a = h.instance(1000), b = h.instance(2000, { AGENT_ADMISSION_MODE: 'static' });
  await h.warm(); a.request('A'); b.request('B'); await tick();
  assert.equal(b.admission.snapshot().coordinationReason, 'mismatched-policy');
  assert.equal(b.admission.snapshot().cap, 6);
  assert.equal(b.queue.snapshot('/a').queued[0].reason, 'spacing');
  await h.advance(65000); await h.advance(70000);
  assert.deepEqual(b.started, ['B']);
});

test('failed transactions expose current detail and unknown ownership, then clear on recovery', async t => {
  const h = harness(t); const a = h.instance(1000); await h.warm();
  h.census('1000 node /app/todo-server.js\n9999 node /other/todo-server.js');
  await h.advance(65000);
  assert.equal(a.admission.snapshot().unregisteredCount, 1);
  const transaction = a.coordinator.transaction;
  for (const detail of ['lock-busy', 'state-invalid']) {
    a.coordinator.transaction = () => ({ ok: false, detail });
    await a.admission.poll();
    const snap = a.admission.snapshot();
    assert.equal(snap.reason, 'coordination');
    assert.equal(snap.detail, detail);
    assert.equal(snap.coordinationReason, null);
    assert.equal(snap.instances, null);
    assert.equal(snap.censusPidCount, 2);
    assert.equal(snap.unregisteredCount, null);
    assert.equal(snap.unregisteredPids, null);
  }
  a.coordinator.transaction = transaction;
  h.census(undefined); await h.advance(70000);
  assert.equal(a.admission.snapshot().detail, null);
  assert.equal(a.admission.snapshot().coordinationReason, null);
  assert.equal(a.admission.snapshot().unregisteredCount, 0);
});

test('unavailable census stays unknown in successful and failed transactions', async t => {
  const h = harness(t); const a = h.instance(1000); h.census(null); await h.advance(0);
  const snap = a.admission.snapshot();
  assert.equal(snap.coordinationReason, 'census-unavailable');
  assert.equal(snap.censusPidCount, null);
  assert.equal(snap.unregisteredCount, null);
  assert.equal(snap.instances, 1);
  a.coordinator.transaction = () => ({ ok: false, detail: 'lock-busy' });
  await a.admission.poll();
  assert.equal(a.admission.snapshot().censusPidCount, null);
});
