import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  resolveOriginPlan, attachSplitOriginPayload, adoptOriginKey, originConflictCardIndexes, previewOriginSingleTarget,
  originSubtreeKeys, outOfSubtreeModifiedIndexes, buildInitialAcceptedMask, buildObjectiveSeed,
} = await import('./objective-origin-task.js');

test('resolveOriginPlan: split returns its origin and child ids even though parentTaskKey is set', () => {
  const cs = { rehashIntent: 'split', taskKey: 'TPT42', parentTaskKey: 'TPT42' };
  assert.deepEqual(resolveOriginPlan(cs, 2, ['TPT43', 'TPT44']), {
    mode: 'split', originKey: 'TPT42', childIds: ['TPT43', 'TPT44'],
  });
  assert.deepEqual(resolveOriginPlan({ ...cs, parentTaskKey: null }, 2, ['TPT43']), {
    mode: 'none', originTaskKey: null,
  });
});

test('attachSplitOriginPayload promotes a scoped snapshot and names only saved children', () => {
  const data = { tasks: [{ id: 'TPT42', isObjective: false }, { id: 'TPT43', parentId: 'TPT42' }] };
  attachSplitOriginPayload(data, resolveOriginPlan(
    { rehashIntent: 'split', taskKey: 'TPT42', parentTaskKey: 'TPT42' }, 2, ['TPT43']
  ));
  assert.deepEqual(data.splitOrigin, { originKey: 'TPT42', childIds: ['TPT43'] });
  assert.equal(data.tasks[0].isObjective, true);
});

// ── resolveOriginPlan ──

test('resolveOriginPlan: no originTaskKey -> none', () => {
  assert.deepEqual(resolveOriginPlan({}, 3), { mode: 'none', originTaskKey: null });
  assert.deepEqual(resolveOriginPlan(null, 1), { mode: 'none', originTaskKey: null });
});

test('resolveOriginPlan: 1 proposed new task -> single', () => {
  assert.deepEqual(resolveOriginPlan({ originTaskKey: 'C900' }, 1), { mode: 'single', originTaskKey: 'C900' });
});

test('resolveOriginPlan: >=2 proposed new tasks -> parent', () => {
  assert.deepEqual(resolveOriginPlan({ originTaskKey: 'C900' }, 2), { mode: 'parent', originTaskKey: 'C900' });
  assert.deepEqual(resolveOriginPlan({ originTaskKey: 'C900' }, 5), { mode: 'parent', originTaskKey: 'C900' });
});

test('resolveOriginPlan: 0 proposed new tasks -> none', () => {
  assert.deepEqual(resolveOriginPlan({ originTaskKey: 'C900' }, 0), { mode: 'none', originTaskKey: 'C900' });
});

test('resolveOriginPlan: cs.parentTaskKey (subtask mode) wins over origin — precedence guard', () => {
  assert.deepEqual(
    resolveOriginPlan({ originTaskKey: 'C900', parentTaskKey: 'C500' }, 3),
    { mode: 'none', originTaskKey: 'C900' }
  );
});

test('resolveOriginPlan: originResolution already "single" -> none (consumed)', () => {
  assert.deepEqual(
    resolveOriginPlan({ originTaskKey: 'C900', originResolution: 'single' }, 1),
    { mode: 'none', originTaskKey: 'C900' }
  );
});

test('resolveOriginPlan: objectiveParentKey already memoized -> none (reuse it, do not re-resolve)', () => {
  assert.deepEqual(
    resolveOriginPlan({ originTaskKey: 'C900', objectiveParentKey: 'C900' }, 2),
    { mode: 'none', originTaskKey: 'C900' }
  );
});

// ── adoptOriginKey ──

test('adoptOriginKey: rewrites the card into a modified card targeting the origin key', () => {
  const card = {
    type: 'new',
    task: {
      id: 'new-abc123-1', title: 'Refined title', description: 'Refined desc',
      status: 'pending', priority: 3, order: 1, assignee: 7, parentId: null,
      isObjective: true, tags: ['feature'], dependencies: ['C100'], category: 'CODING',
    },
  };
  adoptOriginKey(card, 'C900');
  assert.equal(card.type, 'modified');
  assert.equal(card._originAdopted, true);
  assert.equal(card.task.id, 'C900');
  assert.equal(card.task.isObjective, false);
  assert.equal('status' in card.task, false);
  assert.equal('priority' in card.task, false);
  assert.equal('order' in card.task, false);
  assert.equal('assignee' in card.task, false);
  assert.equal('parentId' in card.task, false);
  // preserved
  assert.equal(card.task.title, 'Refined title');
  assert.equal(card.task.description, 'Refined desc');
  assert.deepEqual(card.task.tags, ['feature']);
  assert.deepEqual(card.task.dependencies, ['C100']);
  assert.equal(card.task.category, 'CODING');
});

test('adoptOriginKey: no-op on a card with no task', () => {
  const card = { type: 'new' };
  const result = adoptOriginKey(card, 'C900');
  assert.equal(result, card);
  assert.equal(card.type, 'new'); // untouched — nothing to adopt
});

// ── originConflictCardIndexes ──

test('originConflictCardIndexes: finds modified cards targeting the origin key', () => {
  const cards = [
    { type: 'new', task: { id: 'new-1' } },
    { type: 'modified', task: { id: 'C900' } }, // planner-proposed, targets origin — stray
    { type: 'modified', task: { id: 'C500' } }, // targets something else — fine
  ];
  assert.deepEqual(originConflictCardIndexes(cards, 'C900'), [1]);
});

test('originConflictCardIndexes: empty when no originTaskKey or no cards', () => {
  assert.deepEqual(originConflictCardIndexes([{ type: 'modified', task: { id: 'C900' } }], null), []);
  assert.deepEqual(originConflictCardIndexes(null, 'C900'), []);
});

// ── previewOriginSingleTarget ──

test('previewOriginSingleTarget: returns the lone new card index in single mode', () => {
  const cs = { originTaskKey: 'C900' };
  const msg = { cards: [{ type: 'modified', task: { id: 'C1' } }, { type: 'new', task: { id: 'new-1' } }] };
  assert.equal(previewOriginSingleTarget(cs, msg), 1);
});

test('previewOriginSingleTarget: null when >=2 new cards proposed (parent mode, no single target)', () => {
  const cs = { originTaskKey: 'C900' };
  const msg = { cards: [{ type: 'new', task: { id: 'new-1' } }, { type: 'new', task: { id: 'new-2' } }] };
  assert.equal(previewOriginSingleTarget(cs, msg), null);
});

test('previewOriginSingleTarget: null with no originTaskKey', () => {
  const msg = { cards: [{ type: 'new', task: { id: 'new-1' } }] };
  assert.equal(previewOriginSingleTarget({}, msg), null);
});

// ── originSubtreeKeys / outOfSubtreeModifiedIndexes / buildInitialAcceptedMask (TPT15) ──

test('originSubtreeKeys: null outside origin mode', () => {
  assert.equal(originSubtreeKeys({}), null);
  assert.equal(originSubtreeKeys(null), null);
});

test('originSubtreeKeys: origin key alone when no child confirmed yet', () => {
  const cs = { originTaskKey: 'C900', messages: [
    { cards: [{ type: 'new', task: { id: 'C901' } }], confirmedMask: [false] },
  ] };
  assert.deepEqual(originSubtreeKeys(cs), new Set(['C900']));
});

test('originSubtreeKeys: includes confirmed new-card ids across every message', () => {
  const cs = { originTaskKey: 'C900', messages: [
    { cards: [{ type: 'new', task: { id: 'C901' } }, { type: 'new', task: { id: 'C902' } }], confirmedMask: [true, false] },
    { cards: [{ type: 'modified', task: { id: 'C901' } }], confirmedMask: [false] },
  ] };
  assert.deepEqual(originSubtreeKeys(cs), new Set(['C900', 'C901']));
});

test('outOfSubtreeModifiedIndexes: flags a modified card targeting an unrelated task', () => {
  const cs = { originTaskKey: 'C900', messages: [] };
  const cards = [
    { type: 'new', task: { id: 'C901' } },
    { type: 'modified', task: { id: 'C42' } }, // unrelated pending task — the reported bug
  ];
  assert.deepEqual(outOfSubtreeModifiedIndexes(cs, cards), [1]);
});

test('outOfSubtreeModifiedIndexes: does not flag a card targeting the origin itself (owned by originConflictCardIndexes instead)', () => {
  const cs = { originTaskKey: 'C900', messages: [] };
  const cards = [{ type: 'modified', task: { id: 'C900' } }];
  assert.deepEqual(outOfSubtreeModifiedIndexes(cs, cards), []);
});

test('outOfSubtreeModifiedIndexes: does not flag a card targeting an already-confirmed child', () => {
  const cs = { originTaskKey: 'C900', messages: [
    { cards: [{ type: 'new', task: { id: 'C901' } }], confirmedMask: [true] },
  ] };
  const cards = [{ type: 'modified', task: { id: 'C901' } }];
  assert.deepEqual(outOfSubtreeModifiedIndexes(cs, cards), []);
});

test('outOfSubtreeModifiedIndexes: [] outside origin mode — no false flags on a normal chat', () => {
  const cards = [{ type: 'modified', task: { id: 'C42' } }];
  assert.deepEqual(outOfSubtreeModifiedIndexes({}, cards), []);
});

test('buildInitialAcceptedMask: unrelated modified card starts unchecked, new card stays checked', () => {
  const cs = { originTaskKey: 'C900', messages: [] };
  const cards = [
    { type: 'new', task: { id: 'C901' } },
    { type: 'modified', task: { id: 'C42' } },
  ];
  assert.deepEqual(buildInitialAcceptedMask(cs, cards), [true, false]);
});

test('buildInitialAcceptedMask: identical to all-true outside origin mode (no behavior change)', () => {
  const cards = [{ type: 'new', task: { id: 'new-1' } }, { type: 'modified', task: { id: 'C1' } }];
  assert.deepEqual(buildInitialAcceptedMask({}, cards), [true, true]);
  assert.deepEqual(buildInitialAcceptedMask(null, cards), cards.map(() => true));
});

// ── buildObjectiveSeed (TPT16) ──

test('buildObjectiveSeed: title + description', () => {
  const task = { title: 'Fix login bug', description: 'Users cannot log in on Safari.' };
  assert.equal(buildObjectiveSeed(task, 'C900'), '### Fix login bug\n\nUsers cannot log in on Safari.');
});

test('buildObjectiveSeed: description carries embedded image/file markdown verbatim', () => {
  const task = {
    title: 'Add avatar upload',
    description: 'See mock: ![mock](/api/projects/2/images/9) and spec ![spec](/api/files/2/4).',
  };
  assert.equal(
    buildObjectiveSeed(task, 'C901'),
    '### Add avatar upload\n\nSee mock: ![mock](/api/projects/2/images/9) and spec ![spec](/api/files/2/4).'
  );
});

test('buildObjectiveSeed: empty description -> heading only, trimmed', () => {
  assert.equal(buildObjectiveSeed({ title: 'No details yet', description: '' }, 'C902'), '### No details yet');
  assert.equal(buildObjectiveSeed({ title: 'No details yet' }, 'C902'), '### No details yet');
});

test('buildObjectiveSeed: missing/blank title falls back to the task key', () => {
  assert.equal(buildObjectiveSeed({ description: 'body text' }, 'C903'), '### C903\n\nbody text');
  assert.equal(buildObjectiveSeed(null, 'C904'), '### C904');
});
