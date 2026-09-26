import assert from 'node:assert/strict';
import { test } from 'node:test';

const { hydrateModifiedCard, buildModifiedTaskPatch, reconcileModifiedCards, MODIFIED_HYDRATE_FIELDS, parseSnapshotPayload, applyModifiedCardToLiveTask } =
  await import('./modified-task-merge.js');
const { seedStatuses, resetStatuses } = await import('./status-registry.js');

// C1071: a `modified` proposal that only names the fields it's actually changing
// (e.g. tags-only) must not lose title/description/priority/etc when merged onto
// the live task via Object.assign(existing, card.task) downstream.
test('hydrateModifiedCard fills only the fields the proposal omitted', () => {
  const card = { type: 'modified', task: { id: 'C42', tags: ['tt-api-tasks', 'bugfix'] } };
  const existing = {
    id: 'C42', title: 'Existing title', description: 'Existing description', priority: 3,
    dependencies: ['C10'], status: 'in_progress',
  };

  const filled = hydrateModifiedCard(card, existing);

  assert.equal(filled, true);
  assert.equal(card.task.title, 'Existing title');
  assert.equal(card.task.description, 'Existing description');
  assert.equal(card.task.priority, 3);
  assert.deepEqual(card.task.dependencies, ['C10']);
  // tags stays the proposal's own value — not overwritten by hydration
  assert.deepEqual(card.task.tags, ['tt-api-tasks', 'bugfix']);
  // status is deliberately excluded from MODIFIED_HYDRATE_FIELDS by design (C1072) —
  // a modified card never carries status unless the user explicitly edited it.
  assert.equal(card.task.status, undefined);
});

test('hydrateModifiedCard copies array fields, not aliases', () => {
  const card = { type: 'modified', task: { id: 'C42' } };
  const existing = { id: 'C42', dependencies: ['C10'], tags: ['tt-api-tasks'] };

  hydrateModifiedCard(card, existing);
  card.task.dependencies.push('C11');
  card.task.tags.push('feature');

  assert.deepEqual(existing.dependencies, ['C10'], 'mutating the card must not mutate the live task');
  assert.deepEqual(existing.tags, ['tt-api-tasks']);
});

test('hydrateModifiedCard is a no-op for a fully-specified card', () => {
  const card = { type: 'modified', task: { id: 'C42', title: 'New title' } };
  const existing = { id: 'C42', title: 'Old title', description: 'D' };

  const filled = hydrateModifiedCard(card, existing);

  assert.equal(filled, true); // description still gets filled in
  assert.equal(card.task.title, 'New title'); // proposal's own value wins, never overwritten
  assert.equal(card.task.description, 'D');
});

test('hydrateModifiedCard is a no-op / false for non-modified cards, missing task, or missing existing', () => {
  assert.equal(hydrateModifiedCard(null, {}), false);
  assert.equal(hydrateModifiedCard({ type: 'new', task: {} }, { title: 'x' }), false);
  assert.equal(hydrateModifiedCard({ type: 'modified' }, { title: 'x' }), false);
  assert.equal(hydrateModifiedCard({ type: 'modified', task: { id: 'C1' } }, null), false);
});

test('MODIFIED_HYDRATE_FIELDS excludes status', () => {
  assert.equal(MODIFIED_HYDRATE_FIELDS.includes('status'), false);
});

// buildModifiedTaskPatch — the fallback PATCH path when a modified card's target
// is absent from the scoped TODO.md. Regression coverage for the bug this task
// exists to prevent: an omitted field must never become '' / [] on the wire.
test('buildModifiedTaskPatch omits fields the proposal never set (the C1071 regression)', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', tags: ['tt-api-tasks', 'bugfix'] });

  // C1165: reopen_if_closed is expected here too — no explicit status was set.
  assert.deepEqual(patch, { tags: ['tt-api-tasks', 'bugfix'], reopen_if_closed: true });
  assert.equal('description' in patch, false, 'description must be entirely absent, not sent as \'\'');
  assert.equal('title' in patch, false);
});

test('buildModifiedTaskPatch includes present fields verbatim', () => {
  const patch = buildModifiedTaskPatch({
    id: 'C42', title: 'T', description: 'D', tags: ['a'], assignee: 7, priority: 3,
  });

  // C1165: reopen_if_closed is expected here too — no explicit status was set.
  assert.deepEqual(patch, { title: 'T', description: 'D', tags: ['a'], assignee: 7, priority: 3, reopen_if_closed: true });
});

test('buildModifiedTaskPatch maps priority 0 to sprint_id:null (backlog) and null assignee', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', priority: 0, assignee: null });

  assert.equal(patch.sprint_id, null);
  assert.equal('priority' in patch, false);
  assert.equal(patch.assignee, null);
});

// C1559: adoptOriginKey() (objective-origin-task.js) sets isObjective:false on the card
// it adopts — the absent-origin PATCH fallback (buildModifiedTaskPatch) must carry that
// through as is_objective, or the C1341 stamp survives the "turn it into a regular task"
// resolution.
test('buildModifiedTaskPatch passes isObjective through as is_objective (C1559)', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', title: 'T', isObjective: false });
  assert.equal(patch.is_objective, false);
});

test('buildModifiedTaskPatch omits is_objective when the card never set isObjective (additive, no pre-C1559 caller does)', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', tags: ['a'] });
  assert.equal('is_objective' in patch, false);
});

// ── TPT197: agent + model + design mode, settable from the proposal-edit modal ──

test('MODIFIED_HYDRATE_FIELDS includes piModel (mirrors DIFF_FIELDS in api-backend.js)', () => {
  assert.equal(MODIFIED_HYDRATE_FIELDS.includes('piModel'), true);
});

test('hydrateModifiedCard fills a Pi-pinned live task\'s piModel onto a card that omitted it', () => {
  const card = { type: 'modified', task: { id: 'C42', tags: ['a'] } };
  const filled = hydrateModifiedCard(card, { id: 'C42', agentAssignee: 'pi', piModel: 'anthropic/claude-sonnet-5' });
  assert.equal(filled, true);
  assert.equal(card.task.agentAssignee, 'pi');
  assert.equal(card.task.piModel, 'anthropic/claude-sonnet-5');
});

test('buildModifiedTaskPatch carries agent, per-agent models and design mode as snake_case', () => {
  const patch = buildModifiedTaskPatch({
    id: 'C42', agentAssignee: 'pi', claudeModel: 'opus', codexModel: 'gpt-5', piModel: 'anthropic/claude-sonnet-5',
    claudeDesignMode: true,
  });
  assert.equal(patch.agent_assignee, 'pi');
  assert.equal(patch.claude_model, 'opus');
  assert.equal(patch.codex_model, 'gpt-5');
  assert.equal(patch.pi_model, 'anthropic/claude-sonnet-5');
  assert.equal(patch.claude_design_mode, true);
});

test('buildModifiedTaskPatch maps a cleared agent/model to null and design mode to a boolean', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', agentAssignee: '', claudeModel: '', claudeDesignMode: 0 });
  assert.equal(patch.agent_assignee, null);
  assert.equal(patch.claude_model, null);
  assert.equal(patch.claude_design_mode, false);
});

test('buildModifiedTaskPatch omits agent/model keys the card never set (no accidental clear)', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', tags: ['a'] });
  for (const k of ['agent_assignee', 'claude_model', 'codex_model', 'pi_model', 'effort', 'claude_design_mode']) {
    assert.equal(k in patch, false, `${k} must be absent`);
  }
});

// ── TPT285: per-task effort level ──

test('MODIFIED_HYDRATE_FIELDS includes effort (mirrors DIFF_FIELDS in api-backend.js)', () => {
  assert.equal(MODIFIED_HYDRATE_FIELDS.includes('effort'), true);
});

test('buildModifiedTaskPatch carries effort, and maps a cleared effort to null (inherit)', () => {
  assert.equal(buildModifiedTaskPatch({ id: 'C42', effort: 'high' }).effort, 'high');
  assert.equal(buildModifiedTaskPatch({ id: 'C42', effort: '' }).effort, null);
  assert.equal(buildModifiedTaskPatch({ id: 'C42', effort: null }).effort, null);
});

test('hydrateModifiedCard fills the live task\'s effort onto a card that omitted it', () => {
  const card = { type: 'modified', task: { id: 'C42', tags: ['a'] } };
  hydrateModifiedCard(card, { id: 'C42', agentAssignee: 'claude', effort: 'max' });
  assert.equal(card.task.effort, 'max');
});

// ── C1165: reopen a closed task on a chat-driven edit ──

test('buildModifiedTaskPatch sets reopen_if_closed when the card has no explicit status', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', tags: ['a'] });
  assert.equal(patch.reopen_if_closed, true);
});

test('buildModifiedTaskPatch omits reopen_if_closed when the card carries an explicit status (_statusEdited)', () => {
  const patch = buildModifiedTaskPatch({ id: 'C42', status: 'completed' });
  assert.equal('reopen_if_closed' in patch, false);
});

test('applyModifiedCardToLiveTask merges card.task onto existing, same as Object.assign, for non-status fields', () => {
  const existing = { id: 'C1', title: 'Old', status: 'pending', tags: ['a'] };
  const card = { type: 'modified', task: { title: 'New', tags: ['b'] } };
  const result = applyModifiedCardToLiveTask(existing, card);
  assert.equal(result, existing);
  assert.equal(existing.title, 'New');
  assert.deepEqual(existing.tags, ['b']);
  assert.equal(existing.status, 'pending', 'non-closed status is left alone');
});

test('applyModifiedCardToLiveTask reopens a completed task to in_progress', () => {
  const existing = { id: 'C1', status: 'completed' };
  applyModifiedCardToLiveTask(existing, { task: {} });
  assert.equal(existing.status, 'in_progress');
});

test('applyModifiedCardToLiveTask reopens a canceled task to in_progress', () => {
  const existing = { id: 'C1', status: 'canceled' };
  applyModifiedCardToLiveTask(existing, { task: {} });
  assert.equal(existing.status, 'in_progress');
});

test('applyModifiedCardToLiveTask leaves pending/in_progress/on_fire status untouched', () => {
  for (const status of ['pending', 'in_progress', 'on_fire']) {
    const existing = { id: 'C1', status };
    applyModifiedCardToLiveTask(existing, { task: {} });
    assert.equal(existing.status, status);
  }
});

test('applyModifiedCardToLiveTask defers to an explicit user-chosen status (_statusEdited) even if it re-closes the task', () => {
  const existing = { id: 'C1', status: 'completed' };
  applyModifiedCardToLiveTask(existing, { task: { status: 'completed' }, _statusEdited: true });
  assert.equal(existing.status, 'completed', '_statusEdited means the user meant it — reopen rule must not override');
});

test('applyModifiedCardToLiveTask: card.task itself never acquires a status (C1072 contract intact)', () => {
  const existing = { id: 'C1', status: 'completed' };
  const card = { task: { title: 'x' } };
  applyModifiedCardToLiveTask(existing, card);
  assert.equal(card.task.status, undefined, 'the write lands on existing, never on card.task');
});

// (C1187) applyModifiedCardToLiveTask now resolves closed/reopen roles via the shared
// status-registry.js cache instead of a fixed CLOSED_STATUSES literal — this test replaces
// the old "CLOSED_STATUSES contains exactly completed and canceled" existence check.
test('applyModifiedCardToLiveTask: on a renamed registry, reopens the complete/canceled role to this project\'s in-progress-role name', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false, display_order: 1 },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false, display_order: 2 },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true, display_order: 3 },
  ]);
  try {
    const shipped = { id: 'C1', status: 'Shipped' };
    applyModifiedCardToLiveTask(shipped, { task: {} });
    assert.equal(shipped.status, 'Doing');

    const dropped = { id: 'C2', status: 'Dropped' };
    applyModifiedCardToLiveTask(dropped, { task: {} });
    assert.equal(dropped.status, 'Doing');

    // The old literal-name 'completed'/'canceled' no longer means anything on this
    // registry — a task literally named 'completed' is NOT closed here.
    const literal = { id: 'C3', status: 'completed' };
    applyModifiedCardToLiveTask(literal, { task: {} });
    assert.equal(literal.status, 'completed', 'not this project\'s complete-role name — left alone');
  } finally {
    resetStatuses();
  }
});

// ── reconcileModifiedCards (C1109) ──
// Hydration must run on every call (so cards replaced wholesale by a WS frame after the
// snapshot Map already exists still get backfilled — the C1109 bug). The absent-target
// modified->new flip must stay opt-in (`flip: true`) — it is only safe on the single
// fresh-fetch pass in ensureExistingSnapshot(); every other caller (bulk-save Phase 2.4,
// commitPreviewStep, the step-selector handler) must get hydrate-only behavior. Since C1110,
// ensureExistingSnapshot() itself only ever passes `flip: parsed.scope === 'all'` — i.e.
// `flip: true` reaching this function is meant to mean "the Map is provably unscoped", not
// just "this is the fresh-fetch pass". These tests exercise the function's own contract
// (flip is opt-in, gated on the boolean the caller passes in); parseSnapshotPayload tests
// below cover the caller-side half of that gate.

test('reconcileModifiedCards: no snapshot Map is "unknown", not "target absent" — never flips, never throws', () => {
  const cases = [
    { cards: [{ type: 'modified', task: { id: 'C1' } }] }, // _existingTasksSnapshot undefined
    { _existingTasksSnapshot: {}, cards: [{ type: 'modified', task: { id: 'C1' } }] }, // JSON round-trip of a persisted Map
    { _existingTasksSnapshot: null, cards: [{ type: 'modified', task: { id: 'C1' } }] },
  ];
  for (const msg of cases) {
    assert.equal(reconcileModifiedCards(msg, { flip: true }), false);
    assert.equal(msg.cards[0].type, 'modified');
    assert.equal(msg.cards[0].task.title, undefined);
  }
  assert.equal(reconcileModifiedCards(null, { flip: true }), false);
  assert.equal(reconcileModifiedCards({ _existingTasksSnapshot: new Map(), cards: undefined }), false);
  assert.equal(reconcileModifiedCards({ _existingTasksSnapshot: new Map(), cards: [] }), false);
});

test('reconcileModifiedCards: hydrates a card whose target is present in the snapshot', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live title', description: 'Live desc' }]]),
    cards: [{ type: 'modified', task: { id: 'C1', tags: ['x'] } }],
    confirmedMask: [],
  };
  const changed = reconcileModifiedCards(msg);
  assert.equal(changed, true);
  assert.equal(msg.cards[0].task.title, 'Live title');
  assert.equal(msg.cards[0].task.description, 'Live desc');
  assert.equal(msg.cards[0].type, 'modified');
});

test('reconcileModifiedCards: absent target flips to new only when flip:true', () => {
  const msg = {
    _existingTasksSnapshot: new Map(), // C1 not in it
    cards: [{ type: 'modified', task: { id: 'C1', tags: ['x'] } }],
    confirmedMask: [],
  };
  assert.equal(reconcileModifiedCards(msg), false); // hydrate-only call: no-op, no flip
  assert.equal(msg.cards[0].type, 'modified');

  assert.equal(reconcileModifiedCards(msg, { flip: true }), true);
  assert.equal(msg.cards[0].type, 'new');
});

// C1110 regression: a `modified` card targeting a task PRESENT in the snapshot but owned by
// a teammate (assignee !== current user) must stay `modified` and hydrate the real assignee —
// locks both halves of the bug (no duplicate task, no assignee theft). Before the fix, the
// snapshot itself was built from an assignee-scoped read, so this case never reached
// reconcileModifiedCards with `existing` populated at all — it always hit the absent branch
// and flipped. reconcileModifiedCards's own logic (present -> hydrate, never flip) was always
// correct; what was broken was the caller feeding it a scoped Map. This test locks the
// present-target behavior so a future scoping regression upstream is the only way to reopen
// C1110 without also breaking this test.
test('reconcileModifiedCards: a present target owned by a teammate stays modified and hydrates their assignee', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Teammate task', assignee: 9 }]]),
    cards: [{ type: 'modified', task: { id: 'C1', tags: ['x'] } }],
    confirmedMask: [],
  };
  assert.equal(reconcileModifiedCards(msg, { flip: true }), true);
  assert.equal(msg.cards[0].type, 'modified', 'must not flip — the target exists, just isn\'t mine');
  assert.equal(msg.cards[0].task.assignee, 9, 'assignee hydrated from the live task, not left for the currentUser default to steal');
});

test('reconcileModifiedCards: a flipped card is not also hydrated', () => {
  const msg = {
    _existingTasksSnapshot: new Map(),
    cards: [{ type: 'modified', task: { id: 'C1' } }],
    confirmedMask: [],
  };
  reconcileModifiedCards(msg, { flip: true });
  assert.equal(msg.cards[0].type, 'new');
  assert.equal(msg.cards[0].task.title, undefined, 'no live task existed to hydrate from');
});

test('reconcileModifiedCards: leaves already-`new` cards and cards with no/null task untouched', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live' }]]),
    cards: [
      { type: 'new', task: { id: 'new-1', title: 'Brand new' } },
      { type: 'modified', task: null },
      null,
    ],
    confirmedMask: [],
  };
  assert.equal(reconcileModifiedCards(msg, { flip: true }), false);
  assert.equal(msg.cards[0].task.title, 'Brand new');
});

test('reconcileModifiedCards: idempotent — second call is a no-op, proposal values always win', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live title', description: 'Live desc' }]]),
    cards: [{ type: 'modified', task: { id: 'C1', title: 'Proposal title' } }],
    confirmedMask: [],
  };
  assert.equal(reconcileModifiedCards(msg), true);
  assert.equal(msg.cards[0].task.title, 'Proposal title', "proposal's own value must never be overwritten");
  assert.equal(msg.cards[0].task.description, 'Live desc');

  assert.equal(reconcileModifiedCards(msg), false, 'second call must be a no-op');
  assert.equal(msg.cards[0].task.title, 'Proposal title');
});

test('reconcileModifiedCards: confirmed cards are hydrated but never flipped', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live title' }]]), // C1 present -> hydrate case
    cards: [
      { type: 'modified', task: { id: 'C1' } }, // confirmed, target present
      { type: 'modified', task: { id: 'C2' } }, // confirmed, target absent -> must NOT flip
    ],
    confirmedMask: [true, true],
  };
  assert.equal(reconcileModifiedCards(msg, { flip: true }), true);
  assert.equal(msg.cards[0].task.title, 'Live title', 'confirmed card still gets hydrated');
  assert.equal(msg.cards[1].type, 'modified', 'confirmed card is never flipped even with an absent target');
});

test('reconcileModifiedCards: confirmedMask shorter than cards treats uncovered indexes as unconfirmed', () => {
  const msg = {
    _existingTasksSnapshot: new Map(), // absent target for every card
    cards: [
      { type: 'modified', task: { id: 'C1' } },
      { type: 'modified', task: { id: 'C2' } },
    ],
    confirmedMask: [true], // index 1 uncovered
  };
  reconcileModifiedCards(msg, { flip: true });
  assert.equal(msg.cards[0].type, 'modified', 'confirmed (mask[0]=true) — not flipped');
  assert.equal(msg.cards[1].type, 'new', 'uncovered index falls back to unconfirmed — flipped');
});

test('reconcileModifiedCards: index alignment on a mixed new/modified array', () => {
  const msg = {
    _existingTasksSnapshot: new Map(), // absent target for both modified cards
    cards: [
      { type: 'modified', task: { id: 'C1' } },  // index 0, unconfirmed -> flip
      { type: 'new', task: { id: 'new-1' } },     // index 1, untouched regardless
      { type: 'modified', task: { id: 'C2' } },  // index 2, confirmed -> no flip
    ],
    confirmedMask: [false, false, true],
  };
  reconcileModifiedCards(msg, { flip: true });
  assert.equal(msg.cards[0].type, 'new');
  assert.equal(msg.cards[1].type, 'new'); // unchanged, was already 'new'
  assert.equal(msg.cards[2].type, 'modified');
});

test('reconcileModifiedCards: status is never added, even when the live task has one (C1072)', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live', status: 'in_progress' }]]),
    cards: [{ type: 'modified', task: { id: 'C1' } }],
    confirmedMask: [],
  };
  reconcileModifiedCards(msg);
  assert.equal(msg.cards[0].task.status, undefined);
});

test('reconcileModifiedCards: internal flags survive reconcile untouched', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live' }]]),
    cards: [{ type: 'modified', task: { id: 'C1' }, _stepPinned: true, _efficiencyHint: true, _statusEdited: true }],
    confirmedMask: [],
  };
  reconcileModifiedCards(msg);
  const card = msg.cards[0];
  assert.equal(card._stepPinned, true);
  assert.equal(card._efficiencyHint, true);
  assert.equal(card._statusEdited, true);
});

test('reconcileModifiedCards: hydrated arrays are copies, not aliases onto the snapshot task', () => {
  const liveTags = ['tt-api-tasks'];
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', tags: liveTags }]]),
    cards: [{ type: 'modified', task: { id: 'C1' } }],
    confirmedMask: [],
  };
  reconcileModifiedCards(msg);
  msg.cards[0].task.tags.push('feature');
  assert.deepEqual(liveTags, ['tt-api-tasks'], 'mutating the hydrated card must not mutate the snapshot');
});

// Regression for the C1109 bug itself: a Map that was already built (earlier turn) plus a
// wholesale card replacement (a task-cards/cards-update WS frame landing after that) must still
// get hydrated — this is exactly the "second call, no re-fetch, but new unhydrated cards" shape
// that ensureExistingSnapshot's early-return-on-Map used to skip.
test('reconcileModifiedCards: hydrates fresh unhydrated cards even when the snapshot Map already existed', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live title', description: 'Live desc' }]]),
    cards: [], // first pass: nothing to reconcile yet
    confirmedMask: [],
  };
  assert.equal(reconcileModifiedCards(msg), false);

  // A task-cards/cards-update frame replaces msg.cards wholesale with fresh, unhydrated cards —
  // no new fetch happens, the Map above is reused as-is.
  msg.cards = [{ type: 'modified', task: { id: 'C1', tags: ['bugfix'] } }];
  msg.confirmedMask = [false];
  assert.equal(reconcileModifiedCards(msg), true);
  assert.equal(msg.cards[0].task.title, 'Live title');
  assert.equal(msg.cards[0].task.description, 'Live desc');
});

// ── Blank-title-as-missing (C1158) ──
// Repairs chatState already poisoned by the pre-fix bug: a stale/unhydrated DOM
// read (captureCardEdits, Accept handler) could write a *defined* '' onto
// card.task.title before this fix, which the old `!== undefined` check treated as
// "the user's real value" and never re-hydrated — permanently blocking Save (an
// empty title 400s at every write endpoint). description intentionally keeps the
// opposite behavior: '' is a legal, deliberate value there (C922).
test('hydrateModifiedCard treats an empty or whitespace-only title as missing, unlike description', () => {
  const existing = { id: 'C1', title: 'Live title', description: 'Live desc' };

  const emptyTitle = { type: 'modified', task: { id: 'C1', title: '', description: '' } };
  assert.equal(hydrateModifiedCard(emptyTitle, existing), true);
  assert.equal(emptyTitle.task.title, 'Live title');
  // description stays '' — an intentional cleared value, not backfilled.
  assert.equal(emptyTitle.task.description, '');

  const whitespaceTitle = { type: 'modified', task: { id: 'C1', title: '   ' } };
  assert.equal(hydrateModifiedCard(whitespaceTitle, existing), true);
  assert.equal(whitespaceTitle.task.title, 'Live title');

  // A real title is left alone; description still hydrates independently since it
  // was never named on this card (filled stays true, but title itself is untouched).
  const realTitle = { type: 'modified', task: { id: 'C1', title: 'User typed this' } };
  assert.equal(hydrateModifiedCard(realTitle, existing), true);
  assert.equal(realTitle.task.title, 'User typed this');
  assert.equal(realTitle.task.description, 'Live desc');
});

// reconcileModifiedCards is the render-path (and snapshot-fetch-path) entry point —
// confirm the blank-title repair reaches through it too, and that a second call is a
// true no-op (idempotency invariant renderCardHtml's per-render call relies on to
// stay cheap — see chat-task-preview.js C1158).
test('reconcileModifiedCards repairs a poisoned blank-title card and is idempotent on re-run', () => {
  const msg = {
    _existingTasksSnapshot: new Map([['C1', { id: 'C1', title: 'Live title' }]]),
    cards: [{ type: 'modified', task: { id: 'C1', title: '', tags: ['x'] } }],
    confirmedMask: [false],
  };
  assert.equal(reconcileModifiedCards(msg), true);
  assert.equal(msg.cards[0].task.title, 'Live title');
  assert.equal(reconcileModifiedCards(msg), false, 'second call must be a no-op');
});

// ── parseSnapshotPayload (C1110) ──
// The caller-side half of the C1110 gate: ensureExistingSnapshot() only passes
// `flip: parsed.scope === 'all'` to reconcileModifiedCards, so this function's `scope`
// value is what ultimately decides whether an absent target may be flipped to `new`.

test('parseSnapshotPayload: a scope=all-marked payload parses tasks and scope', () => {
  const text = '# TODO\n\n```json\n' + JSON.stringify({ scope: 'all', tasks: [{ id: 'C1', title: 'T' }] }) + '\n```\n';
  const parsed = parseSnapshotPayload(text);
  assert.deepEqual(parsed, { tasks: [{ id: 'C1', title: 'T' }], scope: 'all' });
});

test('parseSnapshotPayload: a legacy/unmarked payload parses tasks with scope:null (treated as "unknown", not "all")', () => {
  const text = '# TODO\n\n```json\n' + JSON.stringify({ tasks: [{ id: 'C1', title: 'T' }] }) + '\n```\n';
  const parsed = parseSnapshotPayload(text);
  assert.deepEqual(parsed, { tasks: [{ id: 'C1', title: 'T' }], scope: null });
});

test('parseSnapshotPayload: returns null for missing fence, malformed JSON, or empty/non-string input', () => {
  assert.equal(parseSnapshotPayload('no json fence here'), null);
  assert.equal(parseSnapshotPayload('```json\nnot valid json\n```'), null);
  assert.equal(parseSnapshotPayload(''), null);
  assert.equal(parseSnapshotPayload(undefined), null);
  assert.equal(parseSnapshotPayload(null), null);
});

test('parseSnapshotPayload: tolerates a missing tasks array', () => {
  const text = '```json\n' + JSON.stringify({ scope: 'all' }) + '\n```';
  const parsed = parseSnapshotPayload(text);
  assert.deepEqual(parsed, { tasks: [], scope: 'all' });
});
