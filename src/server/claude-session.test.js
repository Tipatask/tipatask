'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeProposals, classifyNoJsonTurn, buildSplitDirective } = require('./claude-session');

test('normalizeProposals forces status to pending on new tasks only', () => {
  const parsed = normalizeProposals({
    changes: [
      { type: 'new', task: { id: 'C999', title: 'Done already', description: 'x', status: 'completed' } },
      { type: 'modified', task: { task_key: 'C998', title: 'In progress', status: 'in_progress' } },
      { type: 'new', task: { id: 'H997', title: 'Missing status' } },
    ],
  });

  assert.deepEqual(parsed.changes.map(c => c.task.status), ['pending', undefined, 'pending']);
  assert.equal(parsed.changes[1].task.id, 'C998');
  // C1072: modified card never had a description — must stay absent, not defaulted
  // from title (that default is new-only; a modified default here would wipe a live
  // task's real description via Object.assign downstream — the C1071 failure class).
  assert.equal(parsed.changes[1].task.description, undefined);
});

// C1072: a modified card that only changes tags must not acquire status/title/
// description it never mentioned — Object.assign(existing, card.task) downstream
// would otherwise wipe those fields on a live task (C1071 half-fix on this path).
test('normalizeProposals leaves title/description/status absent on a tags-only modified card', () => {
  const parsed = normalizeProposals({
    changes: [
      { type: 'modified', task: { task_key: 'C42', tags: ['tt-api-tasks', 'bugfix'] } },
    ],
  });

  const task = parsed.changes[0].task;
  assert.equal(task.id, 'C42');
  assert.equal(task.title, undefined);
  assert.equal(task.description, undefined);
  assert.equal(task.status, undefined);
  assert.deepEqual(task.tags, ['tt-api-tasks', 'bugfix']);
});

test('normalizeProposals preserves blank-line paragraph breaks in descriptions', () => {
  const description = 'Context paragraph.\n\n1. First step.\n\n2. Second step.\n\n3. Verify.';
  const parsed = normalizeProposals({
    changes: [{ type: 'new', task: { id: 'C43', title: 'Paragraphs', description } }],
  });

  assert.equal(parsed.changes[0].task.description, description);
});

// C1410: classifyNoJsonTurn() is the diagnostic behind the [objective:no-json-prose] log —
// tryEmitTaskCards() itself only ever silently swallows a parse failure (bare catch), so
// this is the one place that says WHY a turn ended with no cards.
test('classifyNoJsonTurn: empty turnBuffer classifies as empty', () => {
  assert.deepEqual(classifyNoJsonTurn(''), { kind: 'empty', chars: 0, preview: '' });
  assert.deepEqual(classifyNoJsonTurn('   \n  '), { kind: 'empty', chars: 6, preview: '' });
});

test('classifyNoJsonTurn: prose with no ```json fence classifies as prose', () => {
  const text = 'Understood — applying that rule now.';
  const result = classifyNoJsonTurn(text);
  assert.equal(result.kind, 'prose');
  assert.equal(result.chars, text.length);
  assert.equal(result.preview, text);
});

test('classifyNoJsonTurn: a ```json fence with unparseable content classifies as unparsed-json', () => {
  const result = classifyNoJsonTurn('Here you go:\n```json\n{ "changes": [ BROKEN\n```');
  assert.equal(result.kind, 'unparsed-json');
});

test('classifyNoJsonTurn: preview truncates to 200 chars and escapes newlines', () => {
  const long = 'a'.repeat(250) + '\nmore text';
  const result = classifyNoJsonTurn(long);
  assert.equal(result.kind, 'prose');
  assert.equal(result.chars, long.length);
  assert.equal(result.preview.length, 200);
  assert.equal(result.preview, 'a'.repeat(200));
});

const { applyRehashIntent, buildObjectiveArgs } = require('./claude-session');
const { buildTurnPrompt } = require('./providers/transcript');
const config = require('./config');

function splitSession() {
  const calls = [];
  return {
    calls, systemPrompt: 'READ-ONLY PLANNER', messages: [{ role: 'user', content: 'Split the task' }],
    firstPrompt: 'Split the task',
    backend: { async getTask(key) {
      calls.push(key);
      return { id: key, title: 'Upload attachments', description: 'Validate files and show upload progress.', tags: ['feature'] };
    } },
  };
}

test('split context reaches the model system prompt without changing visible messages', async () => {
  const session = splitSession();
  const messages = JSON.stringify(session.messages);
  await applyRehashIntent(session, { rehashIntent: 'split', taskKey: 'TPT210', description: 'client spoof' }, 'obj-split');
  assert.deepEqual(session.calls, ['TPT210']);
  assert.match(session.systemPrompt, /Upload attachments/);
  assert.match(session.systemPrompt, /Validate files and show upload progress/);
  assert.match(session.systemPrompt, /concrete, non-overlapping child tasks/);
  assert.doesNotMatch(session.systemPrompt, /client spoof/);
  assert.equal(JSON.stringify(session.messages), messages);
  assert.equal(session.firstPrompt, 'Split the task');
  const args = buildObjectiveArgs(session);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /<rehash-split>/);
  assert.equal(buildTurnPrompt(session, { includeSystemPrompt: false, freshSource: 'firstPrompt' }).prompt, 'Split the task');
  assert.match(buildTurnPrompt(session, { includeSystemPrompt: true }).prompt, /<rehash-split>/);
});

test('split context is stable on follow-up; clearing removes it and invalidates every provider session', async () => {
  const session = splitSession();
  const payload = { rehashIntent: 'split', taskKey: 'TPT210' };
  await applyRehashIntent(session, payload, 'obj-split');
  session.systemPrompt += '\nCached architecture';
  session.codexSessionId = 'existing';
  await applyRehashIntent(session, payload, 'obj-split');
  assert.equal(session.calls.length, 1);
  assert.equal(session.codexSessionId, 'existing');
  assert.equal(session.systemPrompt.split('<rehash-split>').length, 2);
  session.claudeSessionId = session.piSessionId = session.geminiSessionId = 'existing';
  await applyRehashIntent(session, { rehashIntent: null }, 'obj-split');
  assert.equal(session.systemPrompt, 'READ-ONLY PLANNER\nCached architecture');
  for (const provider of ['claude', 'codex', 'pi', 'gemini']) assert.equal(session[provider + 'SessionId'], null);
  assert.equal(session._providerSwitchPending, true);
  assert.equal(session.rehashTaskKey, null);
});

test('ordinary objective and legacy follow-up payloads do not alter prompt or session', async () => {
  const session = splitSession();
  session.codexSessionId = 'ordinary';
  await applyRehashIntent(session, {}, 'obj-normal');
  await applyRehashIntent(session, { rehashIntent: null, taskKey: null }, 'obj-normal');
  assert.equal(session.systemPrompt, 'READ-ONLY PLANNER');
  assert.equal(session.codexSessionId, 'ordinary');
  assert.deepEqual(session.calls, []);
});

for (const [name, payload] of [
  ['omitted intent', {}],
  ['task key without intent', { taskKey: 'TPT210' }],
  ['null intent', { rehashIntent: null, taskKey: 'TPT210' }],
  ['split', { rehashIntent: 'split', taskKey: 'TPT210' }],
  ['discuss', { rehashIntent: 'discuss', taskKey: 'TPT210' }],
]) {
  test(`Rehash directive isolation: ${name} preserves the visible transcript`, async () => {
    const session = splitSession();
    session.firstPrompt = 'Objective from the user:\n\nBuild a calendar';
    session.messages = [{ role: 'user', content: 'Build a calendar' }];
    const basePrompt = session.systemPrompt;
    const visibleBefore = JSON.stringify({ messages: session.messages, firstPrompt: session.firstPrompt });
    const intent = payload.rehashIntent;
    await applyRehashIntent(session, payload, 'obj-isolation');

    if (intent) {
      assert.deepEqual(session.calls, ['TPT210']);
      assert.ok(session._rehashDirective.startsWith(`\n\n<rehash-${intent}>`));
      assert.equal(session.systemPrompt, basePrompt + session._rehashDirective);
      const other = intent === 'split' ? 'discuss' : 'split';
      assert.doesNotMatch(session.systemPrompt, new RegExp(`<rehash-${other}>`));
    } else {
      assert.deepEqual(session.calls, []);
      assert.equal(session.systemPrompt, basePrompt);
      assert.doesNotMatch(session.systemPrompt, /<\/?rehash-(?:split|discuss)>/);
    }
    const args = buildObjectiveArgs(session);
    const systemIndex = args.indexOf('--append-system-prompt');
    if (intent) assert.notEqual(systemIndex, -1);
    if (systemIndex !== -1) {
      assert.equal(args[systemIndex + 1], config.SIMPLE_MODE ? session._rehashDirective : session.systemPrompt);
    }
    assert.equal(JSON.stringify({ messages: session.messages, firstPrompt: session.firstPrompt }), visibleBefore);
    assert.equal(buildTurnPrompt(session, { includeSystemPrompt: false }).prompt, session.firstPrompt);
  });
}

for (const intent of ['split', 'discuss']) {
  test(`omitted intent on an existing ${intent} follow-up retains its hidden directive`, async () => {
    const session = splitSession();
    await applyRehashIntent(session, { rehashIntent: intent, taskKey: 'TPT210' }, 'obj-follow-up');
    const systemPrompt = session.systemPrompt;
    const messages = JSON.stringify(session.messages);
    await applyRehashIntent(session, {}, 'obj-follow-up');
    assert.equal(session.systemPrompt, systemPrompt);
    assert.deepEqual(session.calls, ['TPT210']);
    assert.equal(JSON.stringify(session.messages), messages);
  });
}

test('invalid or missing split targets fail before changing the session', async () => {
  const session = splitSession();
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'execute', taskKey: 'TPT210' }), /Invalid rehash intent/);
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'split', taskKey: '../other-project' }), /Invalid split task key/);
  session.backend.getTask = async () => null;
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'split', taskKey: 'TPT210' }), /was not found/);
  assert.equal(session.systemPrompt, 'READ-ONLY PLANNER');
});

test('split directive remains a system argument in simple mode', async () => {
  const session = splitSession();
  await applyRehashIntent(session, { rehashIntent: 'split', taskKey: 'TPT210' }, 'obj-split');
  const previous = config.SIMPLE_MODE;
  try {
    config.SIMPLE_MODE = true;
    const args = buildObjectiveArgs(session);
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], session._rehashDirective);
  } finally { config.SIMPLE_MODE = previous; }
});

function discussSession() {
  const session = splitSession();
  session.messages = [{ role: 'user', content: 'improve this' }];
  session.firstPrompt = 'improve this';
  session.backend.getTask = async (key) => {
    session.calls.push(key);
    return {
      id: key, title: 'Rehash discuss', description: 'Pin the task card above the chat.', tags: ['feature'],
      category: 'CODING', status: 'in_progress', priority: 341, dependencies: ['TPT210'],
    };
  };
  return session;
}

test('discuss context reaches the model system prompt only, and overrides the active-list guard', async () => {
  const session = discussSession();
  const messages = JSON.stringify(session.messages);
  await applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: 'TPT179', description: 'client spoof' }, 'obj-discuss');
  assert.deepEqual(session.calls, ['TPT179']);
  assert.match(session.systemPrompt, /<rehash-discuss>/);
  assert.match(session.systemPrompt, /Rehash discuss/);
  assert.match(session.systemPrompt, /Pin the task card above the chat/);
  assert.match(session.systemPrompt, /"priority":341/);
  assert.match(session.systemPrompt, /type "modified" and id "TPT179"/);
  // Without this override the planner's generic "id must be in `active`" rule makes it emit a duplicate "new" task.
  assert.match(session.systemPrompt, /even if it is absent from the "active" list/);
  assert.match(session.systemPrompt, /Never include status/);
  assert.doesNotMatch(session.systemPrompt, /client spoof/);
  assert.equal(JSON.stringify(session.messages), messages);
  assert.equal(session.firstPrompt, 'improve this');
  const args = buildObjectiveArgs(session);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /<rehash-discuss>/);
  assert.equal(buildTurnPrompt(session, { includeSystemPrompt: false, freshSource: 'firstPrompt' }).prompt, 'improve this');
});

test('switching split, discuss and cleared swaps the directive instead of stacking', async () => {
  const session = discussSession();
  session.claudeSessionId = 'existing';
  await applyRehashIntent(session, { rehashIntent: 'split', taskKey: 'TPT210' }, 'obj-swap');
  assert.equal(session.systemPrompt.split('<rehash-split>').length, 2);
  await applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: 'TPT179' }, 'obj-swap');
  assert.equal(session.systemPrompt.split('<rehash-split>').length, 1);
  assert.equal(session.systemPrompt.split('<rehash-discuss>').length, 2);
  assert.equal(session.rehashIntent, 'discuss');
  assert.equal(session.rehashTaskKey, 'TPT179');
  assert.equal(session.claudeSessionId, null); // a resumed CLI would keep the old system context
  await applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: 'TPT179' }, 'obj-swap');
  assert.equal(session.calls.filter(k => k === 'TPT179').length, 1); // unchanged follow-up: no refetch, no duplicate
  await applyRehashIntent(session, { rehashIntent: null }, 'obj-swap');
  assert.equal(session.systemPrompt, 'READ-ONLY PLANNER');
  assert.equal(session.rehashIntent, null);
});

test('invalid or missing discuss targets fail before changing the session', async () => {
  const session = discussSession();
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: '../other-project' }), /Invalid discuss task key/);
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: null }), /Invalid discuss task key/);
  session.backend.getTask = async () => null;
  await assert.rejects(applyRehashIntent(session, { rehashIntent: 'discuss', taskKey: 'TPT179' }), /Discuss task TPT179 was not found/);
  assert.equal(session.systemPrompt, 'READ-ONLY PLANNER');
  assert.equal(session.rehashIntent, undefined);
});

// TPT264: split children must not carry a one-entry numbered list.
test('buildSplitDirective carries the 2+ steps numbered-list rule', () => {
  const directive = buildSplitDirective('{}');
  assert.match(directive, /numbered list in a child description only when it holds 2 or more steps/);
  assert.match(directive, /never a lone "1\." item/);
});
