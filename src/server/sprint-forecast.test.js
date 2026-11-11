'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forecastSprintDates, parseForecast } = require('./sprint-forecast');

const row = (number = 2, start_date = '2026-11-02', end_date = '2026-11-08') => ({ number, start_date, end_date, rationale: 'Seven calendar days of work' });
const input = () => ({ targetSprints: [{ number: 2 }, { number: 3 }],
  tasksBySprint: new Map([[2, [{ title: 'Build scheduler', effort: 'high', story_points: 3 }]]]),
  previousSprint: { number: 1, end_date: '2026-11-01' }, durationDays: 14,
  memberCount: 2, agents: [{ id: 'claude', plan: 'max', usage: null }], today: '2026-11-02' });
const json = (...sprints) => JSON.stringify({ sprints });

test('forecast uses the project provider with a 60s deadline, no tools or Claude retry, and compact workload context', async () => {
  const result = await forecastSprintDates(input(), { projectRoot: '/selected-project', runOneShotPrompt: async (prompt, opts) => {
    assert.equal(opts.timeoutMs, 60000);
    assert.equal(opts.toolless, true);
    assert.equal(opts.fallbackToClaude, false);
    assert.equal(opts.projectRoot, '/selected-project');
    assert.equal(opts.parseJson, undefined, 'strict JSON is parsed locally');
    const context = JSON.parse(prompt.split('\n').at(-1));
    assert.equal(context.durationDays, 14);
    assert.equal(context.memberCount, 2);
    assert.equal(context.agents[0].plan, 'max');
    assert.equal(context.sprints[0].task_count, 1);
    assert.equal(context.sprints[0].tasks[0].effort, 'high');
    return json(row(), row(3, '2026-11-09', '2026-11-09'));
  } });
  assert.deepEqual([...result.keys()], [2, 3]);
});

test('invalid, failed and late provider replies return an empty map', async () => {
  for (const reply of [null, '', 'no JSON', '```json\n' + json(row()) + '\n```', 'prefix ' + json(row()),
    '{}', '{"sprints":{}}', json(row(2, '2026-02-30')), json(row(2, '2026-11-01')),
    json(row(2, '2026-11-03', '2026-11-02')), json(row(2, '2026-11-02', '2027-02-01')),
    json(row(9)), json({ ...row(), rationale: null }), json(row(), row())]) {
    const result = await forecastSprintDates(input(), { runOneShotPrompt: async () => reply });
    assert.equal(result.size, 0, String(reply));
  }
  assert.equal((await forecastSprintDates(input(), { runOneShotPrompt: async () => { throw Error('offline'); } })).size, 0);
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const result = await forecastSprintDates(input(), { timeoutMs: 10, runOneShotPrompt: () => late });
  resolveLate(json(row()));
  await late;
  assert.equal(result.size, 0, 'late completion cannot mutate the returned map');
});

test('inclusive 1 and 90 day limits, overlap, sprint order, fixed anchors and partial answers', () => {
  assert.equal(parseForecast(json(row(2, '2026-11-02', '2027-01-30')), input()).size, 1);
  assert.equal(parseForecast(json(row(2, '2026-11-02', '2026-11-02')), input()).size, 1);
  assert.deepEqual([...parseForecast(json(row(), row(3, '2026-11-08', '2026-11-10')), input()).keys()], [2]);
  assert.deepEqual([...parseForecast(json(row(3, '2026-11-02', '2026-11-03'), row(2, '2026-11-04', '2026-11-05')), input()).keys()], [2]);
  const anchored = { ...input(), datedSprints: [{ number: 4, start_date: '2026-11-06' }] };
  assert.equal(parseForecast(json(row()), anchored).size, 0);
  assert.equal(parseForecast(json(row(2, '2026-11-02', '2026-11-05')), anchored).size, 1);
  assert.equal(parseForecast(json(row()), { ...input(), previousSprint: { number: 1, end_date: '2026-11-02' } }).size, 0);
});

test('manual, partially dated, closed and backlog targets are never forecast', async () => {
  for (const target of [{ number: 2, date_source: 'manual' }, { number: 2, start_date: '2026-11-02' },
    { number: 2, end_date: '2026-11-08' }, { number: 2, status: 'closed' }, { number: 0 }]) {
    const result = await forecastSprintDates({ ...input(), targetSprints: [target] }, {
      runOneShotPrompt: () => assert.fail('ineligible sprint must not call provider'),
    });
    assert.equal(result.size, 0);
  }
});
