'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAgentLimits, scaleAgentLimitsForConcurrency, evaluateRunaway,
  sweepDescendantWatchdog, parsePsOutput, buildRunawayWarning, describeRunawayReason,
  AGENT_LIMIT_KEYS: K } = require('./process-group');

const hardware = { totalMemBytes: 48 * 1024 ** 3, cores: 18 };
const limits = (config = {}, env = {}) => resolveAgentLimits('/p', { hardware, env, readConfig: () => config });
const fresh = () => ({ threshold: 50, lastCount: 0 });
function replay(rows, opts = limits(), state = fresh()) {
  let time = 0;
  return rows.map(row => {
    time += 30000;
    const sample = { count: 54, rssMb: 800, sampledAt: time, ...row };
    if (typeof sample.host === 'string') sample.host = {
      fresh: true, status: 'ok', sampledAt: sample.sampledAt, pressure: sample.host,
    };
    return evaluateRunaway(state, sample, opts);
  });
}
const noAction = results => assert.ok(results.every(r => !r.pause && !r.kill), JSON.stringify(results));

for (const sessions of [1, 2, 6, 8]) {
  test(`stable 54-process trees survive ${sessions} terminals at low and high RSS`, () => {
    const scaled = scaleAgentLimitsForConcurrency(limits(), sessions);
    assert.equal(scaled.warnDescendants, 50);
    assert.equal(scaled.descendantCeiling, 150);
    assert.equal(scaled.maxTreeRssMb, 6144);
    assert.equal(scaled.rssActionMb, 12288);
    assert.equal(scaled.maxSubagents, Math.max(1, Math.round(3 * Math.max(.25, 2 / sessions))));
    for (const rssMb of [800, 5000, 13000, 20000]) {
      for (const host of ['normal', 'critical', 'unknown']) {
        noAction(replay(Array.from({ length: 12 }, () => ({ rssMb, host })), scaled));
      }
    }
  });
}

test('live concurrency changes never reset growth or lower enforcement', () => {
  const state = fresh();
  for (const [i, sessions] of [1, 2, 6, 8, 2, 8].entries()) {
    const result = evaluateRunaway(state, { count: 54, rssMb: 5000, sampledAt: i * 30000 }, scaleAgentLimitsForConcurrency(limits(), sessions));
    noAction([result]);
    assert.equal(state.threshold, 50);
  }
  const growing = fresh();
  for (const [i, sessions] of [1, 6, 8].entries()) {
    const result = evaluateRunaway(growing, { count: 54 + i * 10, rssMb: 800, sampledAt: i * 30000 }, scaleAgentLimitsForConcurrency(limits(), sessions));
    assert.equal(result.pause, i === 2);
  }
});

test('brief build bursts settle without action; count emergency and growth remain effective', () => {
  noAction(replay([{ count: 54 }, { count: 140, rssMb: 14000 }, { count: 54, rssMb: 7000 }, { rssMb: 800 }]));
  const count = replay([54, 64, 74].map(count => ({ count, rssMb: null })));
  assert.equal(count[0].alert, true);
  assert.equal(count[2].reason, 'count-growth');
  assert.equal(count[2].pause, true);
  const emergency = replay([{ count: 150, rssMb: null }])[0];
  assert.equal(emergency.reason, 'count-ceiling');
  assert.equal(emergency.pause, true);
  noAction(replay([{ count: 149, rssMb: null }]));
});

test('RSS pilot boundary: three high samples and two >=512 MiB growth intervals', () => {
  const high = [12289, 12801, 13313].map(rssMb => ({ rssMb, host: 'normal' }));
  const results = replay(high);
  noAction(results.slice(0, 2));
  assert.equal(results[2].pause, true);
  assert.equal(results[2].reason, 'memory-growth');
  noAction(replay([12289, 12800, 13311].map(rssMb => ({ rssMb }))));
  noAction(replay([12288, 12800, 13312].map(rssMb => ({ rssMb }))));
  noAction(replay([13000, 14000, 1000].map(rssMb => ({ rssMb }))));
});

test('pressure branch requires three fresh pressure samples and two same-tree growth intervals', () => {
  const rows = [13000, 13128, 13256].map(rssMb => ({ rssMb, host: 'warning' }));
  assert.equal(replay(rows)[2].reason, 'memory-pressure');
  assert.equal(replay(rows)[2].pause, true);
  noAction(replay(rows.map(r => ({ ...r, host: 'normal' }))));
  noAction(replay(rows.map(r => ({ ...r, rssMb: 13000 }))));
  noAction(replay(rows.map((r, i) => ({ ...r, rssMb: 13000 + i * 127 }))));
  noAction(replay(rows.map((r, i) => ({ ...r, host: i === 1 ? 'unknown' : 'critical' }))));
});

test('missing/partial/stale/unsupported host data never supplies pressure; RSS growth still acts', () => {
  for (const host of [null, {}, { fresh: false, status: 'ok', pressure: 'critical', sampledAt: 0 },
    { fresh: true, status: 'partial', pressure: 'critical', sampledAt: 0 },
    { fresh: true, status: 'unsupported', pressure: 'unknown', sampledAt: 0 },
    { fresh: true, status: 'ok', pressure: 'critical', sampledAt: 999999 }]) {
    noAction(replay([13000, 13128, 13256].map(rssMb => ({ rssMb, host }))));
    assert.equal(replay([13000, 13512, 14024].map(rssMb => ({ rssMb, host })))[2].pause, true);
  }
});

test('missing RSS, gaps, clock jumps and rapid calls break memory evidence', () => {
  for (const rssMb of [null, undefined, NaN, Infinity, -1]) {
    const results = replay([{ rssMb: 13000 }, { rssMb }, { rssMb: 15000 }]);
    noAction(results);
    assert.equal(results[1].rssMb, null);
  }
  for (const times of [[0, 1, 2], [0, 30000, 90000], [90000, 60000, 30000], [0, 25000, 50000]]) {
    noAction(replay(times.map((sampledAt, i) => ({ sampledAt, rssMb: 13000 + i * 1024 }))));
  }
  const state = fresh();
  for (const rssMb of [13000, 14000, 15000]) noAction([evaluateRunaway(state, { count: 54, rssMb }, limits())]);
});

test('enforcement changes grant warning grace and discard old memory evidence', () => {
  const state = fresh();
  replay([{ rssMb: 13000 }, { rssMb: 14000 }], limits(), state);
  const tighter = limits({ [K.rssActionMb]: 10000, [K.descendantCeiling]: 54 });
  const grace = evaluateRunaway(state, { count: 54, rssMb: 15000, sampledAt: 90000 }, tighter);
  assert.equal(grace.alert, true);
  noAction([grace]);
  assert.equal(state.rssStreak, 0);
  const next = evaluateRunaway(state, { count: 54, rssMb: 15000, sampledAt: 120000 }, tighter);
  assert.equal(next.reason, 'count-ceiling');
  assert.equal(next.pause, true); // explicit configured ceiling, not concurrency
});

test('custom limits, fallback precedence and admission independence', () => {
  const config = { [K.warnDescendants]: 20, [K.maxTreeRssMb]: 2048,
    [K.descendantCeiling]: 90, [K.rssActionMb]: 9000, [K.rssGrowthMb]: 256,
    [K.rssPressureGrowthMb]: 64, [K.rssSamples]: 4 };
  const configured = limits(config);
  assert.equal(configured.deviceSessionCap, limits().deviceSessionCap);
  for (const n of [1, 2, 6, 8]) {
    const scaled = scaleAgentLimitsForConcurrency(configured, n);
    assert.equal(scaled.warnDescendants, 20);
    assert.equal(scaled.descendantCeiling, 90);
    assert.equal(scaled.rssActionMb, 9000);
    assert.equal(scaled.maxTreeRssMb, 2048);
    noAction(replay(Array.from({ length: 4 }, () => ({ rssMb: 10000 })), scaled, { threshold: 20 }));
  }
  assert.equal(limits({ [K.warnDescendants]: 20 }).descendantCeiling, 60);
  assert.equal(limits({ [K.maxTreeRssMb]: 2048 }).rssActionMb, 4096);
  for (const field of ['descendantCeiling', 'rssActionMb', 'rssGrowthMb', 'rssPressureGrowthMb', 'rssSamples']) {
    for (const invalid of [0, -1, '', 'bad', 1.5, Infinity]) {
      assert.equal(limits(config, { [K[field]]: invalid })[field], configured[field]);
    }
    assert.equal(limits(config, { [K[field]]: '5' })[field], 5);
  }
  assert.equal(limits(config, { [K.rssSamples]: '2' }).rssSamples, 4);
  const extended = replay([10000, 10256, 10512, 10768].map(rssMb => ({ rssMb })), configured, { threshold: 20 });
  noAction(extended.slice(0, 3));
  assert.equal(extended[3].pause, true);
});

test('resume grace protects stable trees and requires fresh growth before re-pausing', () => {
  const state = { ...fresh(), resumeBase: { count: 160, rssMb: 14000 } };
  noAction(replay(Array.from({ length: 4 }, () => ({ count: 160, rssMb: 14000, host: 'critical' })), limits(), state));
  const growing = replay([16000, 16512, 17024].map(rssMb => ({ rssMb })), limits(), state);
  assert.equal(growing.at(-1).pause, true);
  const count = { ...fresh(), resumeBase: { count: 160, rssMb: 800 } };
  noAction(replay([{ count: 160 }, { count: 169 }], limits(), count));
  assert.equal(evaluateRunaway(count, { count: 210, rssMb: null, sampledAt: 90000 }, limits()).reason, 'count-ceiling');
  const missing = { ...fresh(), resumeBase: { count: 160, rssMb: 800 } };
  replay([{ count: 10, rssMb: null }], limits(), missing);
  assert.ok(missing.resumeBase, 'missing RSS cannot clear resume grace');
  replay([{ count: 10, rssMb: 100 }], limits(), missing);
  assert.equal(missing.resumeBase, null);
});

for (const action of ['pause', 'kill', 'warn']) {
  test(`${action} uses the same qualified evidence and retains action latches`, () => {
    const opts = limits({ [K.watchdogAction]: action });
    noAction(replay([{ rssMb: 99999 }], opts));
    const state = fresh();
    const results = replay([13000, 13512, 14024, 100].map(rssMb => ({ rssMb })), opts, state);
    noAction(results.slice(0, 2));
    for (const result of results.slice(2)) {
      assert.equal(result.pause, action === 'pause');
      assert.equal(result.kill, action === 'kill');
    }
  });
}

test('bounded sweep replay isolates trees and handles partial RSS without disabling count protection', () => {
  const sessions = new Map([10, 20].map(pid => [pid, { type: 'terminal', alive: true, ptyPid: pid,
    tabId: String(pid), projectPath: '/p', descendantWatchdog: fresh() }]));
  const pauses = [];
  for (let tick = 0; tick < 3; tick++) {
    const sampledAt = tick * 30000;
    const snapshot = parsePsOutput(`10 10 1 ${13000 * 1024} S\n20 20 1 ${(13000 + tick * 128) * 1024} S`);
    sweepDescendantWatchdog(sessions, snapshot, { resolveLimits: () => limits(), sampledAt,
      host: { sampledAt, status: 'ok', fresh: true, pressure: 'critical' }, log() {},
      emitTerminalNotice() {}, emitSessionRunaway() {},
      pauseRunawaySession(s, opts) { pauses.push([s.ptyPid, opts.reason]); return { first: true, text: 'paused' }; } });
  }
  assert.deepEqual(pauses, [[20, 'memory-pressure']]);
  const root = sessions.get(10);
  for (let tick = 0; tick < 3; tick++) {
    const count = 54 + tick * 10;
    const snapshot = parsePsOutput(['10 10 1 14000000 S',
      ...Array.from({ length: count }, (_, i) => `10 ${1000 + i} 10 S`)].join('\n'));
    sweepDescendantWatchdog(new Map([[10, root]]), snapshot, { resolveLimits: () => limits(), sampledAt: 120000 + tick * 30000,
      log() {}, emitTerminalNotice() {}, emitSessionRunaway() {},
      pauseRunawaySession(s, opts) { assert.equal(opts.rssMb, null); pauses.push([s.ptyPid, opts.reason]); return { first: true, text: 'paused' }; } });
  }
  assert.deepEqual(pauses.at(-1), [10, 'count-growth']);
});

test('notices distinguish evidence and describe configured enforcement, not advisory ceilings', () => {
  for (const reason of ['count-growth', 'count-ceiling', 'memory-growth', 'memory-pressure']) {
    assert.notEqual(describeRunawayReason(reason), 'resource watchdog intervention');
  }
  assert.doesNotMatch(describeRunawayReason('count-ceiling'), /growth|growing/);
  const notice = buildRunawayWarning(54, 50, '', { action: 'pause', limitMb: 6144,
    policy: { ceiling: 180, rssActionMb: 15000, rssGrowthMb: 700, rssPressureGrowthMb: 200, rssSamples: 4 },
    advisoryDescendants: 17, advisoryTreeRssMb: 2048 });
  assert.match(notice, /immediately at ≥180/);
  assert.match(notice, />15000 MiB for 4 30-second samples/);
  assert.match(notice, /≥700 MiB/);
  assert.match(notice, /≥200 MiB/);
  assert.match(notice, /17 descendants, 2048 MiB; these do not trigger intervention/);
});


test('sweep notices respect a legacy emergency override and resume growth grace', () => {
  for (const [state, expected] of [[{ ...fresh(), killCeiling: 180 }, 180],
    [{ ...fresh(), resumeBase: { count: 160, rssMb: 20000 } }, 210]]) {
    const snapshot = parsePsOutput(['10 10 1 20480000 S',
      ...Array.from({ length: 160 }, (_, i) => `10 ${1000 + i} 10 0 S`)].join('\n'));
    const session = { type: 'terminal', alive: true, ptyPid: 10, descendantWatchdog: state };
    let notice;
    sweepDescendantWatchdog(new Map([['one', session]]), snapshot, {
      resolveLimits: () => ({ warnDescendants: 50, maxTreeRssMb: 6144, watchdogAction: 'pause' }),
      sampledAt: 30000, log() {}, emitSessionRunaway() {},
      emitTerminalNotice(s, text) { notice = text; },
      pauseRunawaySession() { assert.fail('stable tree below effective ceiling must not pause'); },
    });
    assert.ok(notice.includes(`immediately at ≥${expected}`));
    if (state.resumeBase) assert.match(notice, />21536 MiB/);
  }
});
