import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  collectObjectivePrompts, formatObjectivePromptHistory, deriveObjectiveTitle,
  buildObjectiveParentTask, insertObjectiveParent, shouldCreateObjectiveParent,
  newObjectiveParentClientId, OBJECTIVE_PROMPT_SEPARATOR,
} = await import('./objective-parent-task.js');

// ── collectObjectivePrompts ──

test('collectObjectivePrompts: user messages only, chronological, with timestamps', () => {
  const cs = {
    messages: [
      { role: 'user', content: 'First prompt', timestamp: 100 },
      { role: 'assistant', content: 'reply', timestamp: 150 },
      { role: 'system', content: '(auto-retry)', timestamp: 175 },
      { role: 'user', content: '', timestamp: 180 }, // blank — dropped
      { role: 'user', content: 'Second prompt', timestamp: 200 },
    ],
  };
  assert.deepEqual(collectObjectivePrompts(cs), [
    { content: 'First prompt', timestamp: 100 },
    { content: 'Second prompt', timestamp: 200 },
  ]);
});

test('collectObjectivePrompts: collapses consecutive duplicate contents', () => {
  const cs = {
    messages: [
      { role: 'user', content: 'Same text', timestamp: 100 },
      { role: 'assistant', content: '', timestamp: 110 },
      { role: 'user', content: 'Same text', timestamp: 200 }, // auto-retry re-push — collapsed
      { role: 'user', content: 'Different text', timestamp: 300 },
    ],
  };
  assert.deepEqual(collectObjectivePrompts(cs), [
    { content: 'Same text', timestamp: 100 },
    { content: 'Different text', timestamp: 300 },
  ]);
});

test('collectObjectivePrompts: prepends originalUserText when history windowing dropped the true first prompt', () => {
  const cs = {
    originalUserText: 'The very first prompt',
    messages: [
      { role: 'user', content: 'A later prompt still in the window', timestamp: 500 },
    ],
  };
  assert.deepEqual(collectObjectivePrompts(cs), [
    { content: 'The very first prompt', timestamp: null },
    { content: 'A later prompt still in the window', timestamp: 500 },
  ]);
});

test('collectObjectivePrompts: does not duplicate originalUserText when it already matches the first message', () => {
  const cs = {
    originalUserText: 'Same as first',
    messages: [{ role: 'user', content: 'Same as first', timestamp: 100 }],
  };
  assert.deepEqual(collectObjectivePrompts(cs), [{ content: 'Same as first', timestamp: 100 }]);
});

test('collectObjectivePrompts: empty for missing/malformed cs', () => {
  assert.deepEqual(collectObjectivePrompts(null), []);
  assert.deepEqual(collectObjectivePrompts({}), []);
});

// ── formatObjectivePromptHistory ──

test('formatObjectivePromptHistory: joins with <hr>, bold timestamp heading per entry', () => {
  const out = formatObjectivePromptHistory(
    [{ content: 'Prompt one', timestamp: 1000 }, { content: 'Prompt two', timestamp: 2000 }],
    { formatTimestamp: ms => `TS${ms}` }
  );
  assert.equal(
    out,
    `**TS1000**\n\nPrompt one${OBJECTIVE_PROMPT_SEPARATOR}**TS2000**\n\nPrompt two`
  );
  assert.ok(out.includes('<hr>'));
});

test('formatObjectivePromptHistory: omits the heading line when timestamp is null', () => {
  const out = formatObjectivePromptHistory([{ content: 'No timestamp here', timestamp: null }]);
  assert.equal(out, 'No timestamp here');
});

test('formatObjectivePromptHistory: empty string for no prompts', () => {
  assert.equal(formatObjectivePromptHistory([]), '');
  assert.equal(formatObjectivePromptHistory(null), '');
});

// ── deriveObjectiveTitle ──

test('deriveObjectiveTitle: summary wins when present', () => {
  const cs = { messages: [{ role: 'user', content: 'Some long prompt text', timestamp: 1 }] };
  assert.equal(deriveObjectiveTitle(cs, { summary: 'LLM scope summary' }), 'LLM scope summary');
});

test('deriveObjectiveTitle: falls back to first prompt when summary absent', () => {
  const cs = { messages: [{ role: 'user', content: 'First prompt as fallback title', timestamp: 1 }] };
  assert.equal(deriveObjectiveTitle(cs), 'First prompt as fallback title');
});

test('deriveObjectiveTitle: falls back to originalUserText when messages carry nothing usable', () => {
  const cs = { originalUserText: 'Original text fallback', messages: [] };
  assert.equal(deriveObjectiveTitle(cs), 'Original text fallback');
});

test('deriveObjectiveTitle: "New objective" when everything is empty', () => {
  assert.equal(deriveObjectiveTitle({ messages: [] }), 'New objective');
  assert.equal(deriveObjectiveTitle(null), 'New objective');
});

test('deriveObjectiveTitle: collapses whitespace and truncates to max with an ellipsis', () => {
  const long = 'word '.repeat(30).trim();
  const title = deriveObjectiveTitle({ messages: [] }, { summary: long, max: 20 });
  assert.equal(title.length, 20);
  assert.ok(title.endsWith('…'));
});

// ── buildObjectiveParentTask ──

test('buildObjectiveParentTask: exact field set', () => {
  const cs = { messages: [{ role: 'user', content: 'Build the widget catalog', timestamp: 42 }] };
  const parent = buildObjectiveParentTask(cs, { id: 'new-obj-x', status: 'pending', assignee: 7, summary: 'Widget catalog' });
  assert.equal(parent.id, 'new-obj-x');
  assert.equal(parent.title, 'Widget catalog');
  assert.ok(parent.description.includes('Build the widget catalog'));
  assert.equal(parent.category, 'CODING');
  assert.equal(parent.status, 'pending');
  assert.deepEqual(parent.dependencies, []);
  assert.deepEqual(parent.tags, []);
  assert.equal(parent.assignee, 7);
  assert.equal(parent.isObjective, true);
});

test('buildObjectiveParentTask: null when there is no prompt text at all', () => {
  assert.equal(buildObjectiveParentTask({ messages: [] }, { id: 'x', status: 'pending' }), null);
});

// ── insertObjectiveParent ──

test('insertObjectiveParent: priority = max(children), order exceeds every same-tier order, parentId stamped', () => {
  const data = {
    tasks: [
      { id: 'C1', priority: 5, order: 3 },
      { id: 'C2', priority: 5, order: 7 },
      { id: 'C3', priority: 6, order: 2 },
    ],
  };
  const parent = { id: 'new-obj-1' };
  const children = [{ id: 'C10', priority: 6 }, { id: 'C11', priority: 5 }];
  insertObjectiveParent(data, parent, children);
  assert.equal(parent.priority, 6); // max(6, 5) — C1425, lands in the LAST child's sprint
  assert.equal(parent.order, 3); // max(2) + 1 — above every same-tier (priority-6) task, C1378-safe upsert
  assert.ok(data.tasks.includes(parent));
  assert.equal(children[0].parentId, 'new-obj-1');
  assert.equal(children[1].parentId, 'new-obj-1');
});

test('insertObjectiveParent: children with undefined priority coerce to 0', () => {
  const data = { tasks: [] };
  const parent = { id: 'new-obj-2' };
  insertObjectiveParent(data, parent, [{ id: 'C1' }, { id: 'C2' }]);
  assert.equal(parent.priority, 0);
  assert.equal(parent.order, 1);
});

test('insertObjectiveParent: no children -> priority 0', () => {
  const data = { tasks: [] };
  const parent = { id: 'new-obj-3' };
  insertObjectiveParent(data, parent, []);
  assert.equal(parent.priority, 0);
});

// ── shouldCreateObjectiveParent ──

test('shouldCreateObjectiveParent: false in subtask mode', () => {
  assert.equal(shouldCreateObjectiveParent({ parentTaskKey: 'C5' }, 3), false);
});

test('shouldCreateObjectiveParent: false when this chat already has a parent', () => {
  assert.equal(shouldCreateObjectiveParent({ objectiveParentKey: 'C99' }, 3), false);
});

test('shouldCreateObjectiveParent: false when there are no new tasks', () => {
  assert.equal(shouldCreateObjectiveParent({}, 0), false);
});

test('shouldCreateObjectiveParent: false when only a single task is proposed (C1415)', () => {
  assert.equal(shouldCreateObjectiveParent({}, 1), false);
});

test('shouldCreateObjectiveParent: true when two or more tasks are proposed', () => {
  assert.equal(shouldCreateObjectiveParent({}, 2), true);
});

test('shouldCreateObjectiveParent: opts default (omitted) still creates a parent at count 2 (C1558)', () => {
  assert.equal(shouldCreateObjectiveParent({}, 2, {}), true);
});

test('shouldCreateObjectiveParent: false when grouping is disabled, even with many new tasks (C1558)', () => {
  assert.equal(shouldCreateObjectiveParent({}, 5, { groupingEnabled: false }), false);
});

test('shouldCreateObjectiveParent: grouping disabled still yields false in subtask mode (C1558)', () => {
  assert.equal(shouldCreateObjectiveParent({ parentTaskKey: 'C5' }, 5, { groupingEnabled: false }), false);
});

// ── newObjectiveParentClientId ──

test('newObjectiveParentClientId: new-obj- prefixed and avoids collisions', () => {
  const id1 = newObjectiveParentClientId(1000, new Set());
  assert.ok(id1.startsWith('new-obj-'));
  const used = new Set([id1]);
  const id2 = newObjectiveParentClientId(1000, used);
  assert.notEqual(id1, id2);
});
