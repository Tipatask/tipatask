import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocale } from './i18n.js';

const {
  TASK_GROUP_LABELS, DEFAULT_TASK_GROUP_LABEL,
  setGroupLabel, getGroupLabel, resetGroupLabel,
  groupNoun, groupTitle, groupNewLabel, groupShowMore, groupEmpty, groupPriorityFieldLabel,
  groupPluralFor, isGeneratedGroupName,
  setSprintsEnabled, getSprintsEnabled, resetSprintsEnabled,
  setObjectiveGroupingEnabled, getObjectiveGroupingEnabled, resetObjectiveGroupingEnabled,
  setSprintSortOrder, getSprintSortOrder, resetSprintSortOrder,
} = await import('./group-label.js');

test('default seed is Batches', () => {
  resetGroupLabel();
  assert.equal(getGroupLabel(), DEFAULT_TASK_GROUP_LABEL);
  assert.equal(groupNoun(), 'Batch');
});

test('setGroupLabel rejects invalid/blank/null -> falls back to default', () => {
  setGroupLabel('Sprints');
  assert.equal(getGroupLabel(), 'Sprints');
  setGroupLabel('Nonsense');
  assert.equal(getGroupLabel(), DEFAULT_TASK_GROUP_LABEL);
  setGroupLabel(null);
  assert.equal(getGroupLabel(), DEFAULT_TASK_GROUP_LABEL);
  setGroupLabel('');
  assert.equal(getGroupLabel(), DEFAULT_TASK_GROUP_LABEL);
});

test('all 6 labels resolve a noun (en)', () => {
  setLocale('en');
  const nouns = TASK_GROUP_LABELS.map(l => { setGroupLabel(l); return groupNoun(); });
  assert.deepEqual(nouns, ['Sprint', 'Batch', 'Bag', 'Jar', 'Group', 'Step']);
});

test('groupTitle composes noun + numeral', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.equal(groupTitle(237), 'Batch 237');
});

test('setLocale(uk) switches nouns', () => {
  setLocale('uk');
  const nouns = TASK_GROUP_LABELS.map(l => { setGroupLabel(l); return groupNoun(); });
  assert.deepEqual(nouns, ['Спринт', 'Партія', 'Сумка', 'Банка', 'Група', 'Крок']);
  setLocale('en');
});

test('groupNewLabel interpolates n', () => {
  setLocale('en');
  setGroupLabel('Steps');
  assert.equal(groupNewLabel(5), 'New Step (5)');
});

test('groupShowMore uk plural boundaries (1/3/5/11/21)', () => {
  setLocale('uk');
  setGroupLabel('Sprints');
  assert.match(groupShowMore(1), /попередній спринт\)$/);
  assert.match(groupShowMore(3), /попередні спринти\)$/);
  assert.match(groupShowMore(5), /попередніх спринтів\)$/);
  assert.match(groupShowMore(11), /попередніх спринтів\)$/);
  assert.match(groupShowMore(21), /попередній спринт\)$/);
  setLocale('en');
});

test('groupShowMore en one/many', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.match(groupShowMore(1), /1 earlier batch\)$/);
  assert.match(groupShowMore(3), /3 earlier batches\)$/);
  resetGroupLabel();
});

test('groupEmpty resolves per-stem sentence in both locales', () => {
  setLocale('en');
  setGroupLabel('Jars');
  assert.equal(groupEmpty(), 'No tasks in this jar.');
  setLocale('uk');
  assert.equal(groupEmpty(), 'У цій банці немає задач.');
  setLocale('en');
  resetGroupLabel();
});

test('groupPriorityFieldLabel interpolates the noun', () => {
  setLocale('en');
  setGroupLabel('Steps');
  assert.equal(groupPriorityFieldLabel(), 'Priority / Step');
  setLocale('uk');
  assert.equal(groupPriorityFieldLabel(), 'Пріоритет / Крок');
  setLocale('en');
  resetGroupLabel();
});

// (C1271) groupPluralFor — Group Tasks Into select option labels. Takes the label as an
// argument (unlike the other helpers, which read the current _label), independent of
// setGroupLabel()/getGroupLabel() state.
test('groupPluralFor resolves every stored value to its plural noun, both locales', () => {
  setLocale('en');
  assert.deepEqual(
    TASK_GROUP_LABELS.map(groupPluralFor),
    ['Sprints', 'Batches', 'Bags', 'Jars', 'Groups', 'Steps'],
  );
  setLocale('uk');
  assert.deepEqual(
    TASK_GROUP_LABELS.map(groupPluralFor),
    ['Спринти', 'Партії', 'Сумки', 'Банки', 'Групи', 'Кроки'],
  );
  setLocale('en');
});

test('groupPluralFor falls back to the default stem for unknown/null', () => {
  setLocale('en');
  assert.equal(groupPluralFor('Nonsense'), groupPluralFor(DEFAULT_TASK_GROUP_LABEL));
  assert.equal(groupPluralFor(null), groupPluralFor(DEFAULT_TASK_GROUP_LABEL));
});

// (C1332) sprints_enabled — defaults true (migration 054's column default); only an
// explicit false turns it off, everything else (including null/undefined/0/'') is true.
test('default seed for sprintsEnabled is true', () => {
  resetSprintsEnabled();
  assert.equal(getSprintsEnabled(), true);
});

test('setSprintsEnabled: only explicit false is false, everything else -> true', () => {
  setSprintsEnabled(false);
  assert.equal(getSprintsEnabled(), false);
  setSprintsEnabled(true);
  assert.equal(getSprintsEnabled(), true);
  setSprintsEnabled(false);
  assert.equal(getSprintsEnabled(), false);
  setSprintsEnabled(null);
  assert.equal(getSprintsEnabled(), true);
  setSprintsEnabled(false);
  setSprintsEnabled(undefined);
  assert.equal(getSprintsEnabled(), true);
  setSprintsEnabled(false);
  setSprintsEnabled(0);
  assert.equal(getSprintsEnabled(), true);
  setSprintsEnabled(false);
  setSprintsEnabled(1);
  assert.equal(getSprintsEnabled(), true);
  resetSprintsEnabled();
});

test('resetGroupLabel also resets sprintsEnabled', () => {
  setSprintsEnabled(false);
  resetGroupLabel();
  assert.equal(getSprintsEnabled(), true);
});

// (C1558) use_objective_grouping — defaults true (migration 059's column default); only an
// explicit false turns it off, everything else (including null/undefined/0/'') is true.
// Same discipline as sprintsEnabled above.
test('default seed for objectiveGroupingEnabled is true', () => {
  resetObjectiveGroupingEnabled();
  assert.equal(getObjectiveGroupingEnabled(), true);
});

test('setObjectiveGroupingEnabled: only explicit false is false, everything else -> true', () => {
  setObjectiveGroupingEnabled(false);
  assert.equal(getObjectiveGroupingEnabled(), false);
  setObjectiveGroupingEnabled(true);
  assert.equal(getObjectiveGroupingEnabled(), true);
  setObjectiveGroupingEnabled(false);
  assert.equal(getObjectiveGroupingEnabled(), false);
  setObjectiveGroupingEnabled(null);
  assert.equal(getObjectiveGroupingEnabled(), true);
  setObjectiveGroupingEnabled(false);
  setObjectiveGroupingEnabled(undefined);
  assert.equal(getObjectiveGroupingEnabled(), true);
  setObjectiveGroupingEnabled(false);
  setObjectiveGroupingEnabled(0);
  assert.equal(getObjectiveGroupingEnabled(), true);
  setObjectiveGroupingEnabled(false);
  setObjectiveGroupingEnabled(1);
  assert.equal(getObjectiveGroupingEnabled(), true);
  resetObjectiveGroupingEnabled();
});

test('resetGroupLabel also resets objectiveGroupingEnabled', () => {
  setObjectiveGroupingEnabled(false);
  resetGroupLabel();
  assert.equal(getObjectiveGroupingEnabled(), true);
});

// (C1577) sprint_sort_order — defaults 'asc' (migration 064's column default); only the
// literal 'desc' opts into the legacy highest-first board order, everything else
// (including null/undefined/'') is 'asc'.
test('default seed for sprintSortOrder is asc', () => {
  resetSprintSortOrder();
  assert.equal(getSprintSortOrder(), 'asc');
});

test('setSprintSortOrder: only literal "desc" is desc, everything else -> asc', () => {
  setSprintSortOrder('desc');
  assert.equal(getSprintSortOrder(), 'desc');
  setSprintSortOrder('asc');
  assert.equal(getSprintSortOrder(), 'asc');
  setSprintSortOrder('desc');
  assert.equal(getSprintSortOrder(), 'desc');
  setSprintSortOrder(null);
  assert.equal(getSprintSortOrder(), 'asc');
  setSprintSortOrder('desc');
  setSprintSortOrder(undefined);
  assert.equal(getSprintSortOrder(), 'asc');
  setSprintSortOrder('desc');
  setSprintSortOrder('');
  assert.equal(getSprintSortOrder(), 'asc');
  setSprintSortOrder('desc');
  setSprintSortOrder('DESC');
  assert.equal(getSprintSortOrder(), 'asc');
  resetSprintSortOrder();
});

test('resetGroupLabel also resets sprintSortOrder', () => {
  setSprintSortOrder('desc');
  resetGroupLabel();
  assert.equal(getSprintSortOrder(), 'asc');
});

// (C1395) isGeneratedGroupName — every auto-created sprint row's name is literally
// "Sprint ${n}" (sprint-assign.js/mcp/server.js/cli/migrate-tasks.js), never the
// project's own noun. A boilerplate name isn't a custom name — _tierTitleFor() in
// task-board.js falls back to the live noun for these instead of echoing them verbatim.
test('isGeneratedGroupName: legacy literal "Sprint N" is boilerplate for any active label', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.equal(isGeneratedGroupName('Sprint 237', 237), true);
  setGroupLabel('Jars');
  assert.equal(isGeneratedGroupName('Sprint 5', 5), true);
  resetGroupLabel();
});

test('isGeneratedGroupName: matches the active noun too, and is case-insensitive', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.equal(isGeneratedGroupName('Batch 5', 5), true);
  assert.equal(isGeneratedGroupName('batch 5', 5), true);
  assert.equal(isGeneratedGroupName('BATCH 5', 5), true);
  resetGroupLabel();
});

test('isGeneratedGroupName: matches the active-locale noun too', () => {
  setLocale('uk');
  setGroupLabel('Sprints');
  assert.equal(isGeneratedGroupName('Спринт 5', 5), true);
  setLocale('en');
  resetGroupLabel();
});

test('isGeneratedGroupName: a real custom name is never boilerplate', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.equal(isGeneratedGroupName('Auth revamp', 5), false);
  assert.equal(isGeneratedGroupName('Sprint 5 — Auth revamp', 5), false);
  resetGroupLabel();
});

test('isGeneratedGroupName: mismatched number is never boilerplate', () => {
  setLocale('en');
  setGroupLabel('Batches');
  assert.equal(isGeneratedGroupName('Sprint 237', 5), false);
  resetGroupLabel();
});

test('isGeneratedGroupName: empty/null name is never boilerplate', () => {
  assert.equal(isGeneratedGroupName('', 5), false);
  assert.equal(isGeneratedGroupName(null, 5), false);
  assert.equal(isGeneratedGroupName(undefined, 5), false);
});
