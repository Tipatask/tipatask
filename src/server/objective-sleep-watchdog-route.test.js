'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fakeReq(url) {
  return { method: 'GET', url, headers: { host: 'localhost' } };
}

function fakeRes() {
  return {
    statusCode: null,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body = chunk || ''; },
  };
}

test('timing endpoint reports zero heartbeat activity after simulated wake', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_790_000_000_000 });
  process.env.OBJECTIVE_HEARTBEAT_ENABLED = 'true';

  const { armHeartbeat } = require('./claude-session');
  const { createHttpHandler } = require('./ws-handlers');
  const session = {
    tabId: 'obj-sleep-route',
    type: 'objective',
    providerType: 'claude',
    claudeSessionId: 'sess-route',
    proc: null,
    _aborted: false,
    _closed: false,
    _heartbeatTimer: null,
    _heartbeatProc: null,
    _heartbeatKillTimer: null,
    _heartbeatSleepBlocked: false,
    _heartbeatDueAt: 0,
    _lastCacheTouchAt: Date.now(),
    _heartbeatPings: 0,
    timingMilestones: { turnStart: null, turnEnd: null, spans: {}, bottleneck: null, lastSignalAt: null, contextSize: null },
  };
  const sessions = new Map([['obj-sleep-route', session]]);
  const handler = createHttpHandler(sessions, () => ({}), null);

  armHeartbeat(session, 'obj-sleep-route');
  assert.notEqual(session._heartbeatTimer, null);
  t.mock.timers.setTime(Date.now() + 46000);
  t.mock.timers.tick(1);

  const res = fakeRes();
  await handler(fakeReq('/api/objective/timing?taskId=obj-sleep-route'), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.exists, true);
  assert.equal(body.activeHeartbeats, 0);
  assert.equal(body.prewarmCount, 0);
});
