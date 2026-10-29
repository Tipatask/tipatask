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
// Unless `pinned: false`, a harness pins the thresholds these replays are written against
// (five-minute ramp steps up to a ceiling of eight, ten-second spacing, a max(6 GiB, 12.5%)
// reserve, 1 GiB burst, 2 GiB ordinary and 4 GiB unknown estimates), so tuning a default
// never moves their arithmetic; admission-policy.test.js covers the defaults themselves.
const PINNED = { AGENT_ADMISSION_RAMP_STEP_MS: 300000, AGENT_ADMISSION_RAMP_CEILING: 8,
  AGENT_ADMISSION_START_INTERVAL_MS: 10000, AGENT_ADMISSION_RESERVE_MIB: 6144, AGENT_ADMISSION_RESERVE_FRACTION: 0.125,
  AGENT_ADMISSION_BURST_MIB: 1024, AGENT_ADMISSION_ORDINARY_MIB: 2048, AGENT_ADMISSION_UNKNOWN_MIB: 4096 };
// The default host is RAM-bound (8 GiB: static cap 6, pinned ramp ceiling 8) so slot counts
// stay small; pressure mode opts in at a ceiling of eight. Telemetry models a 48 GiB machine.
function harness(t, { mode = 'pressure', pinned = true, config = {}, projectConfigs = {}, hardware = { totalMemBytes: 8 * GiB, cores: 16 } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const instances = [], alive = new Set(), clock = { at: 0 }, host = {}, processes = { rows: [], fresh: true, status: 'ok' };
  const cfg = { ...(pinned ? PINNED : {}), AGENT_ADMISSION_MODE: mode,
    ...(mode === 'pressure' ? { AGENT_ADMISSION_CEILING: 8 } : {}), ...config };
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
      resolvePolicy: () => resolveAdmissionPolicy({ env: {}, hardware, read: () => ({ config: { ...cfg, ...overrides }, status: 'ok' }) }),
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

test('replay ramp 6→8 ordinary slots across independent registries under quiet telemetry; a warning sample resets to 6', async t => {
  const ordinary = { AGENT_ADMISSION_WORKLOAD_CLASS: 'ordinary' };
  const h = harness(t, { mode: 'ramp', projectConfigs: { '/a': ordinary, '/b': ordinary } });
  const a = h.instance(1000), b = h.instance(2000); await h.advance(0);
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  const running = () => a.queue.countRunning() + b.queue.countRunning();
  for (let n = 0; n < 10; n++) (n % 2 ? b : a).request(`R${n}`, n % 2 ? '/b' : '/a');
  await tick();
  assert.equal(running(), 6); // the static floor needs neither memory checks nor spacing
  const caps = [], nextSteps = [];
  for (let at = 5000; at <= 600000; at += 5000) {
    await h.advance(at);
    const snap = a.admission.snapshot();
    assert.equal(b.admission.snapshot().cap, snap.cap); // one shared number
    assert.equal(b.admission.snapshot().rampNextStepAt, snap.rampNextStepAt);
    assert.ok(running() <= snap.cap);
    if (caps.at(-1) !== snap.cap) { caps.push(snap.cap); nextSteps.push(snap.rampNextStepAt); }
  }
  assert.deepEqual(caps, [6, 7, 8]); // every step needs its own full window: no instance steps twice
  assert.deepEqual(nextSteps, [300000, 600000, null]);
  assert.equal(running(), 8);
  assert.equal(a.queue.size() + b.queue.size(), 2);
  assert.equal(read().pressure.rampCap, 8);
  h.host.pressure = 'warning';
  await h.advance(605000);
  for (const i of [a, b]) {
    const snap = i.admission.snapshot();
    assert.deepEqual([snap.cap, snap.alarm, snap.rampNextStepAt], [6, 'pressure', null]);
  }
  assert.equal(read().pressure.rampCap, null);
  assert.equal(running(), 8); // closing admission never terminates sessions
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
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

test('an unavailable census is coordination doubt: no pressure expansion and no ramp step', async t => {
  const h = harness(t); const a = h.instance(1000); h.census(null); await h.warm();
  for (let n = 0; n < 7; n++) a.request(`T${n}`);
  for (let at = 65000; at <= 150000; at += 5000) await h.advance(at);
  assert.equal(a.started.length, 6); // shared fallback cap, never the pressure ceiling
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
  const snap = a.admission.snapshot();
  assert.deepEqual([snap.cap, snap.fallback, snap.coordinated, snap.coordinationReason], [6, true, false, 'census-unavailable']);
  const r = harness(t, { mode: 'ramp' }); const b = r.instance(2000); r.census(null);
  for (let at = 0; at <= 600000; at += 5000) await r.advance(at);
  assert.deepEqual([b.admission.snapshot().cap, b.admission.snapshot().rampNextStepAt], [6, null]);
});

test('ramp default steps the shared cap to seven after a quiet window, persists rampCap and spaces the seventh start', async t => {
  const h = harness(t, { mode: 'ramp' }); const a = h.instance(1000);
  for (let at = 0; at < 300000; at += 5000) await h.advance(at);
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  assert.equal(a.admission.snapshot().mode, 'ramp');
  assert.equal(a.admission.snapshot().cap, 6);
  assert.equal(a.admission.snapshot().rampCeiling, 8);
  assert.equal(a.admission.snapshot().rampNextStepAt, 300000); // window opened at the first normal sample
  assert.equal(read().pressure.rampCap, null);
  await h.advance(300000);
  assert.equal(a.admission.snapshot().cap, 7);
  assert.equal(a.admission.snapshot().rampCap, 7);
  assert.equal(a.admission.snapshot().rampCeiling, 8);
  assert.equal(a.admission.snapshot().rampNextStepAt, 600000); // the step restarted the window
  assert.equal(read().pressure.rampCap, 7);
  for (let n = 0; n < 8; n++) a.request(`T${n}`);
  await tick();
  assert.equal(a.queue.countRunning(), 6); // floor starts need no spacing; the seventh waits ten seconds
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'spacing');
  await h.advance(305000);
  assert.equal(a.queue.countRunning(), 6);
  await h.advance(310000);
  assert.equal(a.queue.countRunning(), 7);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
  // Queue frames carry the ramp state globally and per waiting task.
  const frame = a.queue.snapshot('/a');
  assert.deepEqual([frame.admission.rampCap, frame.admission.rampCeiling, frame.admission.rampNextStepAt], [7, 8, 600000]);
  assert.deepEqual([frame.queued[0].rampCap, frame.queued[0].rampCeiling, frame.queued[0].rampNextStepAt], [7, 8, 600000]);
  assert.equal(a.admission.snapshot().coordinationReason, null);
  h.host.pressure = 'critical';
  await h.advance(315000);
  assert.equal(a.admission.snapshot().cap, 6);
  assert.equal(a.admission.snapshot().alarm, 'pressure');
  assert.equal(a.admission.snapshot().rampNextStepAt, null); // no step while an alarm is latched
  assert.equal(a.queue.snapshot('/a').queued[0].rampNextStepAt, null);
  assert.equal(read().pressure.rampCap, null);
  assert.equal(a.queue.countRunning(), 7); // closing admission never terminates sessions
});

test('unknown-class reservations allow both ramp steps and preserve headroom diagnostics per waiting task', async t => {
  const h = harness(t, { mode: 'ramp' }); const a = h.instance(1000);
  // Six 4-GiB reservations exceed this proxy once the full reserve/burst/new
  // session budget is included; the one-session ramp threshold is only 13 GiB.
  h.host.reclaimableEstimateBytes = 30 * GiB;
  await h.advance(0);
  for (let n = 0; n < 7; n++) a.request(`U${n}`);
  await tick();
  assert.equal(a.queue.countRunning(), 6);
  const first = a.queue.snapshot('/a');
  assert.equal(first.admission.requiredBytes, 35 * GiB);
  assert.deepEqual([first.queued[0].alarm, first.queued[0].requiredBytes, first.queued[0].headroomBytes],
    [null, 35 * GiB, 30 * GiB]);
  for (let at = 5000; at <= 300000; at += 5000) await h.advance(at);
  assert.equal(a.admission.snapshot().rampCap, 7);
  assert.equal(a.queue.countRunning(), 7);
  for (let at = 305000; at <= 600000; at += 5000) await h.advance(at);
  assert.equal(a.admission.snapshot().rampCap, 8);
  assert.equal(a.admission.snapshot().alarm, null);
});

test('cap-blocked queue diagnostics expose headroom alarms and recovery without borrowing the global decision', async t => {
  const h = harness(t, { mode: 'ramp', projectConfigs: { '/b': { AGENT_ADMISSION_WORKLOAD_CLASS: 'ordinary' } } });
  const a = h.instance(1000); await h.warm();
  for (let n = 0; n < 7; n++) a.request(`U${n}`);
  a.request('ordinary', '/b'); await tick();
  h.host.reclaimableEstimateBytes = 10 * GiB;
  await h.advance(65000);
  const frame = a.queue.snapshot();
  assert.equal(frame.admission.alarm, 'headroom');
  assert.deepEqual(frame.queued.map(row => [row.reason, row.alarm, row.requiredBytes, row.headroomBytes]),
    [['device-cap', 'headroom', 35 * GiB, 10 * GiB], ['device-cap', 'headroom', 33 * GiB, 10 * GiB]]);
  // Exercise the actual GET handler's JSON response using the live admission
  // controller; no production server or socket is needed.
  const { createHttpHandler, sessionQueue } = require('./ws-handlers');
  sessionQueue.setAdmission(a.admission);
  try {
    let status, body;
    await createHttpHandler(a.sessions, () => ({}))(
      { method: 'GET', url: '/api/sessions', headers: { 'x-tipatask-project': '/a' } },
      { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } });
    assert.equal(status, 200);
    assert.deepEqual([body.admission.alarm, body.admission.requiredBytes, body.admission.headroomBytes],
      ['headroom', 33 * GiB, 10 * GiB]);
  } finally { sessionQueue.setAdmission(null); }
  h.host.reclaimableEstimateBytes = 13 * GiB;
  for (let at = 70000; at < 100000; at += 5000) {
    await h.advance(at);
    assert.equal(a.queue.snapshot().queued[0].alarm, 'headroom');
  }
  await h.advance(100000);
  assert.equal(a.admission.snapshot().alarm, null);
  assert.ok(a.queue.snapshot().queued.every(row => row.alarm === null));
  a.coordinator.transaction = () => ({ ok: false, detail: 'lock-busy' });
  a.queue.drain();
  const failed = a.queue.snapshot();
  assert.deepEqual([failed.admission.alarm, failed.admission.requiredBytes, failed.admission.headroomBytes],
    [null, null, 13 * GiB]);
  assert.ok(failed.queued.every(row => row.alarm === null && row.requiredBytes === null && row.headroomBytes === 13 * GiB));
});

test('one shared ramp cap: other instances and a late server adopt a raise, and any instance resets it for all', async t => {
  const h = harness(t, { mode: 'ramp' }); const a = h.instance(1000), b = h.instance(2000);
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  for (let at = 0; at < 300000; at += 5000) await h.advance(at);
  for (const i of [a, b]) assert.equal(i.admission.snapshot().cap, 6);
  h.clock.at = 300000; await a.admission.poll(); // only A sees the window close
  assert.equal(read().pressure.rampCap, 7);
  await b.admission.poll(); // B adopts the raise instead of stepping again on its own
  for (const i of [a, b]) {
    const snap = i.admission.snapshot();
    assert.deepEqual([snap.cap, snap.rampCap, snap.rampCeiling, snap.rampNextStepAt], [7, 7, 8, 600000]);
  }
  assert.equal(read().pressure.rampCap, 7);
  // A server started later never observed the window, yet admits against the same cap.
  const c = h.instance(3000); h.clock.at = 305000; await c.admission.poll();
  assert.equal(c.admission.snapshot().coordinationReason, null);
  assert.deepEqual([c.admission.snapshot().cap, c.admission.snapshot().rampNextStepAt], [7, 600000]);
  // B alone loses its census: its coordination doubt drops the shared cap for A and C too.
  h.clock.at = 310000; h.census(null); await b.admission.poll();
  assert.equal(b.admission.snapshot().coordinationReason, 'census-unavailable');
  assert.equal(read().pressure.rampCap, null);
  h.census(undefined); await a.admission.poll(); await c.admission.poll();
  for (const i of [a, c]) {
    const snap = i.admission.snapshot();
    assert.equal(snap.coordinationReason, null);
    assert.deepEqual([snap.cap, snap.rampCap], [6, 6]);
  }
});

test('one instance census failure restarts the shared ramp window: the other instance waits a full window for its next step', async t => {
  const h = harness(t, { mode: 'ramp' }); const a = h.instance(1000), b = h.instance(2000);
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  for (let at = 0; at < 400000; at += 5000) await h.advance(at);
  for (const i of [a, b]) assert.deepEqual([i.admission.snapshot().cap, i.admission.snapshot().rampNextStepAt], [7, 600000]);
  // B alone loses its census at 400 s: its doubt drops the shared cap AND closes the shared window.
  h.clock.at = 400000; h.census(null); await b.admission.poll();
  assert.equal(b.admission.snapshot().coordinationReason, 'census-unavailable');
  assert.deepEqual([read().pressure.rampCap, read().pressure.normalSince], [null, null]);
  // A's own census never failed, yet the window reopens only at the next coordinated sample (405 s).
  h.census(undefined); await h.advance(405000);
  for (const i of [a, b]) {
    const snap = i.admission.snapshot();
    assert.equal(snap.coordinationReason, null);
    assert.deepEqual([snap.cap, snap.rampCap, snap.rampNextStepAt], [6, 6, 705000]);
  }
  assert.equal(read().pressure.normalSince, 405000);
  for (let at = 410000; at < 705000; at += 5000) {
    await h.advance(at); // 600 s, the old window's end, passes without a step
    for (const i of [a, b]) assert.equal(i.admission.snapshot().cap, 6, `no step at ${at}`);
  }
  await h.advance(705000);
  for (const i of [a, b]) assert.deepEqual([i.admission.snapshot().cap, i.admission.snapshot().rampNextStepAt], [7, 1005000]);
});

test('one instance census failure restarts the shared pressure recovery window: the other instance clears its alarm and starts a full window later', async t => {
  const h = harness(t); const a = h.instance(1000), b = h.instance(2000);
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  await h.warm();
  h.host.pressure = 'warning'; await h.advance(65000);
  a.request('A1'); await tick();
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'pressure');
  h.host.pressure = 'normal';
  for (let at = 70000; at < 95000; at += 5000) await h.advance(at);
  assert.deepEqual([read().pressure.alarm, read().pressure.normalSince], ['pressure', 70000]); // recovery due at 100 s
  // B alone loses its census at 95 s: its doubt closes the shared recovery window.
  h.clock.at = 95000; h.census(null); await b.admission.poll();
  assert.equal(b.admission.snapshot().coordinationReason, 'census-unavailable');
  assert.deepEqual([read().pressure.alarm, read().pressure.normalSince], ['pressure', null]);
  // A's own census never failed, yet the window reopens only at the next coordinated sample (100 s):
  // the old window's end passes with the alarm latched and A's start still waiting.
  h.census(undefined);
  for (let at = 100000; at < 130000; at += 5000) {
    await h.advance(at);
    for (const i of [a, b]) assert.equal(i.admission.snapshot().alarm, 'pressure', `alarm at ${at}`);
  }
  assert.equal(read().pressure.normalSince, 100000);
  assert.deepEqual(a.started, []);
  await h.advance(130000);
  for (const i of [a, b]) assert.equal(i.admission.snapshot().alarm, null);
  assert.deepEqual(a.started, ['A1']);
});

test('admission state written before ramp loads at the static cap; a malformed rampCap fails closed', async t => {
  const h = harness(t, { mode: 'ramp' });
  const file = path.join(h.directory, 'admission-state.json');
  const legacy = { version: 1, instances: {}, nextTicket: 3,
    pressure: { alarm: null, normalSince: null, samples: [], lastStartAt: null } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const a = h.instance(1000); await h.advance(0);
  const snap = a.admission.snapshot();
  assert.equal(snap.detail, null); assert.equal(snap.mode, 'ramp');
  assert.deepEqual([snap.cap, snap.rampCap, snap.rampCeiling], [6, 6, 8]);
  assert.equal(JSON.parse(fs.readFileSync(file)).pressure.rampCap ?? null, null);
  for (const rampCap of [0, -1, 1.5, 33, '7', true, {}]) {
    fs.writeFileSync(file, JSON.stringify({ ...legacy, pressure: { ...legacy.pressure, rampCap } }));
    assert.deepEqual(a.coordinator.transaction(() => assert.fail('must not run')),
      { ok: false, reason: 'coordination', detail: 'state-invalid' }, JSON.stringify(rampCap));
  }
  await a.admission.poll();
  const failed = a.admission.snapshot();
  assert.equal(failed.detail, 'state-invalid');
  assert.deepEqual([failed.rampCap, failed.rampCeiling, failed.rampNextStepAt], [null, null, null]);
});

// ── Explicit project cap above the hardware static cap (TPT9190) ──

const HOST_16 = { totalMemBytes: 16 * GiB, cores: 8 }; // hardware static cap 14
const RAISED = { '/a': { AGENT_LIMITS_MAX_CONCURRENT_SESSIONS: 20 } };

test('AGENT_LIMITS_MAX_CONCURRENT_SESSIONS=20 admits 20 terminals on a 16 GiB host in static mode', async t => {
  const h = harness(t, { mode: 'static', hardware: HOST_16, projectConfigs: RAISED });
  const a = h.instance(1000); await h.advance(0);
  for (let n = 0; n < 22; n++) a.request(`A${n}`);
  await tick();
  assert.equal(a.started.length, 20);
  assert.equal(a.queue.countRunning(), 20);
  const own = a.queue.snapshot('/a').queued[0];
  assert.deepEqual([own.reason, own.cap], ['project-cap', 20]);
  // A project without its own cap keeps the hardware cap, which the twenty already exceed.
  a.request('B0', '/b'); await tick();
  const other = a.queue.snapshot('/b').queued.find(row => row.taskId === 'B0');
  assert.deepEqual([other.reason, other.cap], ['device-cap', 14]);
});

test('ramp mode: a raised project cap starts its terminals like the static floor, alarm or not', async t => {
  const h = harness(t, { mode: 'ramp', hardware: HOST_16, projectConfigs: RAISED });
  const a = h.instance(1000); await h.advance(0);
  h.host.pressure = 'warning'; await h.advance(5000);
  assert.equal(a.admission.snapshot().alarm, 'pressure');
  for (let n = 0; n < 20; n++) a.request(`A${n}`);
  await tick();
  assert.equal(a.started.length, 20);
  const read = JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  assert.equal(read.pressure.rampCap, null); // the shared ramp never inherits a project's cap
});

test('a request waiting at the device cap does not hold up a later request whose project raised its cap', async t => {
  const h = harness(t, { mode: 'static', hardware: HOST_16, projectConfigs: RAISED });
  const a = h.instance(1000); await h.advance(0);
  for (let n = 0; n < 15; n++) a.request(`B${n}`, '/b');
  await tick();
  assert.equal(a.started.length, 14);
  a.request('A0'); await tick();
  assert.deepEqual(a.started.slice(14), ['A0']);
  assert.equal(a.queue.snapshot('/b').queued[0].reason, 'device-cap');
});

test('coordination doubt holds a raised project cap to the shared fallback count', async t => {
  const h = harness(t, { mode: 'static', hardware: HOST_16, projectConfigs: RAISED });
  const a = h.instance(1000);
  h.census('1000 node /app/todo-server.js\n9999 node /other/todo-server.js');
  await h.advance(0);
  for (let n = 0; n < 20; n++) a.request(`A${n}`);
  await tick();
  assert.equal(a.started.length, 13); // 13 local + 1 unregistered server = fallback cap 14
  const row = a.queue.snapshot('/a').queued[0];
  assert.deepEqual([row.reason, row.cap], ['device-cap', 14]);
  h.census(undefined); await h.advance(5000);
  assert.equal(a.started.length, 20);
});

// ── Default thresholds on a quiet 16 GiB host ──

test('default ramp on a quiet 16 GiB host admits one more terminal a minute past the static cap; a warning sample resets it', async t => {
  const h = harness(t, { mode: 'ramp', pinned: false, hardware: HOST_16 });
  // 6 of 16 GiB reclaimable covers one more unknown session: 2 GiB reserve + 512 MiB burst
  // + 1 GiB estimate + 2 GiB recovery margin.
  Object.assign(h.host, { physicalBytes: 16 * GiB, reclaimableEstimateBytes: 6 * GiB });
  const read = () => JSON.parse(fs.readFileSync(path.join(h.directory, 'admission-state.json')));
  const a = h.instance(1000); await h.advance(0);
  for (let n = 0; n < 14; n++) a.request(`D${n}`);
  await tick();
  assert.equal(a.queue.countRunning(), 14); // the static floor needs neither memory checks nor spacing
  const first = a.admission.snapshot();
  assert.deepEqual([first.cap, first.rampCeiling, first.rampNextStepAt], [14, 22, 60000]);
  for (let at = 5000; at <= 180000; at += 5000) await h.advance(at);
  const raised = a.admission.snapshot();
  assert.deepEqual([raised.cap, raised.alarm, raised.rampNextStepAt], [17, null, 240000]);
  assert.equal(read().pressure.rampCap, 17);
  // Three slots are open at once: starts above the floor go three seconds apart, so each
  // waiting one starts at the next five-second poll.
  for (let n = 14; n < 18; n++) a.request(`D${n}`);
  await tick();
  assert.equal(a.queue.countRunning(), 15);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'spacing');
  await h.advance(185000);
  assert.equal(a.queue.countRunning(), 16);
  await h.advance(190000);
  assert.equal(a.queue.countRunning(), 17);
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
  h.host.pressure = 'warning'; await h.advance(195000);
  const warned = a.admission.snapshot();
  assert.deepEqual([warned.cap, warned.alarm, warned.rampNextStepAt], [14, 'pressure', null]);
  assert.equal(read().pressure.rampCap, null);
  assert.equal(a.queue.countRunning(), 17); // closing admission never terminates sessions
  assert.equal(a.queue.snapshot('/a').queued[0].reason, 'device-cap');
});
