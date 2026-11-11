'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAndAssign } = require('./sprint-assign');
const forecast = require('./sprint-forecast');
const registry = require('./task-agent');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const dates = (start, end) => ({ start_date: day(start), end_date: day(end), rationale: 'Workload' });

function fixture(t, { sprints = [], tasks = [], result = new Map(), afterForecast } = {}) {
  let input, scope;
  const writes = [];
  const backend = {
    getTasksUnfiltered: async () => tasks,
    getSprints: async () => structuredClone(sprints),
    getProjectSettings: async () => ({ sprint_duration_days: 21 }),
    getProjectMembers: async () => [{ id: 1 }, { id: 2 }],
    getProjectRoot: () => '/selected-project',
    createSprint: async (name, number, extra) => {
      writes.push({ number, extra });
      sprints.push({ id: number * 10, number, ...(extra || dates(0, 20)), date_source: 'auto' });
    },
    applySprintForecast: async (id, extra) => { writes.push({ id, extra }); Object.assign(sprints.find(s => s.id === id), extra); },
  };
  t.mock.method(registry, 'getAgentForecastSummary', cfg => {
    assert.equal(cfg.PROJECT_ROOT, '/selected-project');
    return [{ id: 'claude', plan: 'max', usage: null }];
  });
  t.mock.method(forecast, 'forecastSprintDates', async (value, opts) => {
    input = value; scope = opts;
    afterForecast?.();
    return result;
  });
  return { backend, writes, input: () => input, scope: () => scope };
}

const change = (id, priority, extra = {}) => ({ type: 'new', task: { id, priority, title: id, ...extra } });

test('assignment gathers full workload, metadata, highest dated sprint and selected project; forecasts new and undated rows only', async t => {
  const sprints = [{ id: 10, number: 1, ...dates(-10, -1), date_source: 'manual' },
    { id: 20, number: 2, status: 'active' }, { id: 40, number: 4, status: 'closed' },
    { id: 50, number: 5, start_date: day(60), end_date: day(65), date_source: 'manual' }];
  const f = fixture(t, { sprints, tasks: [
    { id: 'old', priority: 2, status: 'pending', category: 'CODING', effort: 'high' },
    { id: 'done', priority: 2, status: 'completed' }, { id: 'reserved', priority: 2, isReservation: true },
  ], result: new Map([[2, dates(0, 3)], [3, dates(4, 10)]]) });
  const changes = [change('a', 2), change('b', 3), change('c', 4), change('d', 5)];
  await resolveAndAssign(changes, f.backend, { PROJECT_ROOT: '/wrong' }, new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(f.input().targetSprints.map(s => s.number).sort(), [2, 3]);
  assert.equal(f.input().previousSprint.number, 5);
  assert.equal(f.input().durationDays, 21);
  assert.equal(f.input().memberCount, 2);
  assert.equal(f.input().agents[0].plan, 'max');
  assert.deepEqual(f.input().tasksBySprint.get(2).map(t => t.id), ['old', 'a']);
  assert.equal(f.scope().projectRoot, '/selected-project');
  assert.deepEqual(f.writes, [{ id: 20, extra: dates(0, 3) }, { number: 3, extra: dates(4, 10) }]);
});

test('forecast failure still creates missing sprints without dates, leaving undated rows to the API rule', async t => {
  const f = fixture(t, { sprints: [{ id: 20, number: 2 }] });
  await resolveAndAssign([change('a', 2), change('b', 3)], f.backend, {}, new Set(['a', 'b']));
  assert.deepEqual(f.writes, [{ number: 3, extra: undefined }]);
});

test('a concurrent manual or automatic date write during the provider call is preserved', async t => {
  for (const source of ['manual', 'auto']) {
    const sprints = [{ id: 20, number: 2 }];
    const f = fixture(t, { sprints, result: new Map([[2, dates(0, 5)]]), afterForecast: () => {
      Object.assign(sprints[0], dates(10, 20), { date_source: source });
    } });
    await resolveAndAssign([change('a', 2)], f.backend, {}, new Set(['a']));
    assert.deepEqual(f.writes, []);
    t.mock.restoreAll();
  }
});

test('an earlier fallback allocation invalidates a later overlapping forecast', async t => {
  const f = fixture(t, { result: new Map([[3, dates(4, 10)]]) });
  await resolveAndAssign([change('a', 2), change('b', 3)], f.backend, {}, new Set(['a', 'b']));
  assert.deepEqual(f.writes, [{ number: 2, extra: undefined }, { number: 3, extra: undefined }]);
});

test('manual-only assignments avoid the model; missing metadata degrades to automatic creation', async t => {
  const f = fixture(t, { sprints: [{ id: 20, number: 2, ...dates(0, 4), date_source: 'manual' }] });
  await resolveAndAssign([change('a', 2)], f.backend, {}, new Set(['a']));
  assert.equal(f.input(), undefined);
  f.backend.getProjectSettings = async () => { throw Error('offline'); };
  await resolveAndAssign([change('b', 3)], f.backend, {}, new Set(['b']));
  assert.deepEqual(f.writes, [{ number: 3, extra: undefined }]);
});

test('moving existing tasks into an undated sprint forecasts their resulting workload', async t => {
  const f = fixture(t, { sprints: [{ id: 20, number: 2 }], tasks: [{ id: 'old', priority: 1, effort: 'max', status: 'pending' }],
    result: new Map([[2, dates(0, 6)]]) });
  await resolveAndAssign([{ type: 'modified', task: { id: 'old', priority: 2 } }], f.backend, {});
  assert.equal(f.input().tasksBySprint.get(2)[0].effort, 'max');
  assert.deepEqual(f.writes, [{ id: 20, extra: dates(0, 6) }]);
});

test('failure of the last freshness read still creates the sprint using automatic allocation', async t => {
  const f = fixture(t, { result: new Map([[2, dates(0, 6)]]) });
  let reads = 0;
  f.backend.getSprints = async () => { if (++reads === 3) throw Error('read failed'); return []; };
  await resolveAndAssign([change('a', 2)], f.backend, {}, new Set(['a']));
  assert.deepEqual(f.writes, [{ number: 2, extra: undefined }]);
});
