'use strict';

// Regression test for the false "Claude is not logged in" fix: cachedDetect()
// must never serve a stale NEGATIVE result. Pre-fix, stale-while-revalidate
// served a startup-poisoned failure (keychain locked at login / CLI mid-auto-
// update) at every gate for the full 5-min TTL — and re-served it for hours
// because each background refresh re-failed during the transient window.
// Negatives expire after NEGATIVE_DETECT_TTL_MS (30s); gates await the retry.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const BaseTaskAgent = require('./base-agent');

const AVAILABLE = { id: 'fake', label: 'Fake', available: true };
const UNAVAILABLE = { id: 'fake', label: 'Fake', available: false, reason: 'Fake is not logged in' };

// Agent whose detect() returns queued results (last one repeats when queue empties).
class FakeAgent extends BaseTaskAgent {
  constructor(results) {
    super('fake', 'Fake');
    this.results = [...results];
    this.detectCalls = 0;
  }
  detect() {
    this.detectCalls += 1;
    return this.results.length > 1 ? this.results.shift() : this.results[0];
  }
}

test('cold miss awaits one probe and caches', async () => {
  const agent = new FakeAgent([AVAILABLE]);
  const res = await agent.cachedDetect({});
  assert.strictEqual(res.available, true);
  assert.strictEqual(agent.detectCalls, 1);
  await agent.cachedDetect({});
  assert.strictEqual(agent.detectCalls, 1, 'fresh positive served from cache');
});

test('force=true awaits fresh detection', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  assert.strictEqual((await agent.cachedDetect({})).available, false);
  const res = await agent.cachedDetect({}, true);
  assert.strictEqual(res.available, true);
  assert.strictEqual(agent.detectCalls, 2);
});

test('fresh negative served from cache within negative TTL (no probe spam)', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect({});
  const res = await agent.cachedDetect({}); // immediately after — inside 30s window
  assert.strictEqual(res.available, false);
  assert.strictEqual(agent.detectCalls, 1);
});

test('expired negative awaits a fresh probe before gate returns', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect({});
  agent._detectTs = Date.now() - 31_000; // age past NEGATIVE_DETECT_TTL_MS
  const res = await agent.cachedDetect({});
  assert.strictEqual(res.available, true, 'stale negative must NOT be served');
  assert.strictEqual(agent.detectCalls, 2);
});

test('expired positive is stale-while-revalidate — served stale, refreshed in background', async () => {
  const agent = new FakeAgent([AVAILABLE, UNAVAILABLE]);
  await agent.cachedDetect({});
  agent._detectTs = Date.now() - 301_000; // age past DETECT_TTL_MS
  const res = await agent.cachedDetect({});
  assert.strictEqual(res.available, true, 'stale positive IS served (fast path)');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(agent.detectCalls, 2, 'background refresh ran');
  assert.strictEqual((await agent.cachedDetect({})).available, false, 'refreshed result cached');
});

// ── peekDetect(): non-blocking, but a stale NEGATIVE must not live for the whole process ──

test('peekDetect: fresh negative is served with no re-probe', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect({});
  assert.strictEqual(agent.peekDetect({}).available, false);
  assert.strictEqual(agent.detectCalls, 1);
});

test('peekDetect: expired negative is served stale, then refreshed in background (once)', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect({});
  agent._detectTs = Date.now() - 31_000;
  assert.strictEqual(agent.peekDetect({}).available, false, 'this caller still gets the stale result, never blocks');
  agent.peekDetect({}); // second read before the refresh runs must not queue another probe
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(agent.detectCalls, 2);
  assert.strictEqual(agent.peekDetect({}).available, true);
});

test('peekDetect: a positive is never re-probed by a peek', async () => {
  const agent = new FakeAgent([AVAILABLE, UNAVAILABLE]);
  await agent.cachedDetect({});
  agent._detectTs = Date.now() - 10 * 60_000;
  agent.peekDetect({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(agent.detectCalls, 1);
});

// ── unavailable→available flip re-probes the model registry ──
//
// A CLI absent at boot leaves model-registry.js on its static fallback list, and peekModels() is
// cache-only by design, so the availability flip is the event that triggers the live probe.

const REAL_CONFIG = { USER_DATA_ROOT: '/tmp/tt-flip-userdata' };

// Records every getAvailableModels() call instead of probing anything for real.
class ProbeSpyAgent extends FakeAgent {
  constructor(results, { reject = false } = {}) {
    super(results);
    this.modelCalls = [];
    this.reject = reject;
  }
  async getAvailableModels(config, opts) {
    this.modelCalls.push({ config, opts });
    if (this.reject) throw new Error('probe blew up');
    return { models: [], source: 'fallback' };
  }
}

test('flip: unavailable→available fires exactly one forced model re-probe', async () => {
  const agent = new ProbeSpyAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect(REAL_CONFIG); // boot-time negative — first detect can't be a flip
  assert.strictEqual(agent.modelCalls.length, 0);
  await agent.cachedDetect(REAL_CONFIG, true); // Re-Check finds the CLI
  assert.strictEqual(agent.modelCalls.length, 1);
  assert.deepStrictEqual(agent.modelCalls[0].opts, { force: true });
  assert.strictEqual(agent.modelCalls[0].config, REAL_CONFIG);
});

test('flip: a background peekDetect re-detect that finds the CLI re-probes too', async () => {
  const agent = new ProbeSpyAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect(REAL_CONFIG);
  agent._detectTs = Date.now() - 31_000;
  agent.peekDetect(REAL_CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(agent.modelCalls.length, 1);
});

test('flip: no re-probe for a cold available detect, a steady state, or available→unavailable', async () => {
  const cold = new ProbeSpyAgent([AVAILABLE]);
  await cold.cachedDetect(REAL_CONFIG);
  assert.strictEqual(cold.modelCalls.length, 0, 'first-ever detect is not a flip');

  const steady = new ProbeSpyAgent([AVAILABLE, AVAILABLE]);
  await steady.cachedDetect(REAL_CONFIG);
  await steady.cachedDetect(REAL_CONFIG, true);
  assert.strictEqual(steady.modelCalls.length, 0, 'available→available is not a flip');

  const lost = new ProbeSpyAgent([AVAILABLE, UNAVAILABLE]);
  await lost.cachedDetect(REAL_CONFIG);
  await lost.cachedDetect(REAL_CONFIG, true);
  assert.strictEqual(lost.modelCalls.length, 0, 'losing an agent never probes');

  const stillDown = new ProbeSpyAgent([UNAVAILABLE, UNAVAILABLE]);
  await stillDown.cachedDetect(REAL_CONFIG);
  await stillDown.cachedDetect(REAL_CONFIG, true);
  assert.strictEqual(stillDown.modelCalls.length, 0, 'unavailable→unavailable is not a flip');
});

test('flip: skipped without a real server config (no USER_DATA_ROOT to persist into)', async () => {
  const agent = new ProbeSpyAgent([UNAVAILABLE, AVAILABLE]);
  await agent.cachedDetect({});
  await agent.cachedDetect({}, true);
  await agent.cachedDetect(undefined, true);
  assert.strictEqual(agent.modelCalls.length, 0);
});

test('flip: a rejecting probe is swallowed — the detect result is still stored and returned', async () => {
  const agent = new ProbeSpyAgent([UNAVAILABLE, AVAILABLE], { reject: true });
  await agent.cachedDetect(REAL_CONFIG);
  const res = await agent.cachedDetect(REAL_CONFIG, true);
  assert.strictEqual(res.available, true);
  assert.strictEqual(agent.modelCalls.length, 1);
  await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection would fail the run here
});

test('cold concurrent gate reads and stale positive reads each share one in-flight probe', async () => {
  const agent = new FakeAgent([]);
  const releases = [];
  agent.detect = () => {
    agent.detectCalls += 1;
    return new Promise((resolve) => releases.push(resolve));
  };
  const cold = Array.from({ length: 5 }, () => agent.cachedDetect({}));
  await Promise.resolve();
  assert.equal(agent.detectCalls, 1);
  releases.shift()(AVAILABLE);
  assert.ok((await Promise.all(cold)).every((r) => r.available));

  agent._detectTs = Date.now() - 301_000;
  const stale = await Promise.all(Array.from({ length: 5 }, () => agent.cachedDetect({})));
  assert.ok(stale.every((r) => r.available));
  assert.equal(agent.detectCalls, 2, 'one refresh for five stale positive reads');
  releases.shift()(UNAVAILABLE);
  await agent._detectInflight;
  assert.equal(agent.peekDetect({}).available, false);

  agent._detectTs = Date.now() - 31_000;
  const negative = Array.from({ length: 5 }, () => agent.cachedDetect({}));
  await Promise.resolve();
  assert.equal(agent.detectCalls, 3, 'one probe for five expired negative gate reads');
  releases.shift()(AVAILABLE);
  assert.ok((await Promise.all(negative)).every((r) => r.available));
});

test('cold peek is pending, but a start gate awaits its negative and can force retry', async () => {
  const agent = new FakeAgent([UNAVAILABLE, AVAILABLE]);
  assert.match(agent.peekDetect({}).reason, /pending/);
  assert.equal((await agent.cachedDetect({})).available, false);
  assert.equal((await agent.cachedDetect({}, true)).available, true);
  assert.equal(agent.detectCalls, 2);
});

test('forced Re-Check during a stale-positive refresh shares one post-invalidation probe', async () => {
  const agent = new FakeAgent([AVAILABLE]);
  await agent.cachedDetect({});
  const releases = [];
  agent.detect = () => {
    agent.detectCalls += 1;
    return new Promise((resolve) => releases.push(resolve));
  };
  agent._detectTs = Date.now() - 301_000;
  assert.equal((await agent.cachedDetect({})).available, true);
  await Promise.resolve();
  const first = agent.cachedDetect({}, true);
  const second = agent.cachedDetect({}, true);
  assert.equal(agent.detectCalls, 2);
  releases.shift()(UNAVAILABLE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.detectCalls, 3, 'one fresh probe follows the old in-flight refresh');
  releases.shift()(AVAILABLE);
  assert.ok((await Promise.all([first, second])).every((r) => r.available));
  assert.equal(agent.detectCalls, 3);
});

test('probe rejection is cached briefly and retried after the negative TTL', async () => {
  const agent = new FakeAgent([]);
  agent.detect = () => {
    agent.detectCalls += 1;
    if (agent.detectCalls === 1) throw new Error('temporary failure');
    return AVAILABLE;
  };
  assert.equal((await agent.cachedDetect({})).available, false);
  assert.equal((await agent.cachedDetect({})).available, false);
  assert.equal(agent.detectCalls, 1);
  agent._detectTs = Date.now() - 31_000;
  assert.equal((await agent.cachedDetect({})).available, true);
  assert.equal(agent.detectCalls, 2);
});

test('slow CLI probe leaves an unrelated HTTP heartbeat responsive', async () => {
  const server = http.createServer((_req, res) => res.end('alive'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    class SlowCliAgent extends BaseTaskAgent {
      constructor() { super('slow', 'Slow'); }
      async detect() {
        const probe = await BaseTaskAgent.runCliProbe(process.execPath,
          ['-e', "setTimeout(() => process.stdout.write('ready'), 500)"], { timeout: 2000 });
        return { id: this.id, label: this.label, available: !probe.error && probe.output === 'ready' };
      }
    }
    const agent = new SlowCliAgent();
    let finished = false;
    const probe = agent.cachedDetect({}).then((result) => { finished = true; return result; });
    const heartbeat = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.address().port}/`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(heartbeat, 'alive');
    assert.equal(finished, false, 'HTTP response completed while CLI still ran');
    assert.equal((await probe).available, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CLI probe timeout, abort, and output cap cancel the child', async () => {
  const sleeper = ['-e', 'setInterval(() => {}, 1000)'];
  const timeout = await BaseTaskAgent.runCliProbe(process.execPath, sleeper, { timeout: 60 });
  assert.equal(timeout.error?.code, 'ETIMEDOUT');
  const controller = new AbortController();
  const aborted = BaseTaskAgent.runCliProbe(process.execPath, sleeper, { signal: controller.signal });
  controller.abort();
  assert.equal((await aborted).error?.code, 'ABORT_ERR');
  const overflow = await BaseTaskAgent.runCliProbe(process.execPath,
    ['-e', "process.stdout.write('x'.repeat(100000))"], { maxOutputBytes: 1024 });
  assert.equal(overflow.error?.code, 'ENOBUFS');
  assert.ok(overflow.output.length <= 1024);
});
