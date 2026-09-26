// C1235 — client twin of api/src/lib/task-group-labels.js. Per-project noun for board
// group containers (sprint/batch/etc), replacing hardcoded "Sprint" across the board.
//
// Sync-read / async-refresh split, same discipline as status-registry.js: most render
// paths (task-board.js, task-card.js, template.html) are synchronous and must stay that
// way. Module state seeded at load with DEFAULT_TASK_GROUP_LABEL, so the very first
// synchronous render — before loadGroupLabel() resolves — matches the migration's own
// column default ('Batches'). Callers kick off loadGroupLabel() (async) at fixed trigger
// points (template.html boot/project-switch); every other call site reads synchronously.
//
// Dependency-light on purpose: only imports i18n.js (dependency-free) and api-client.js
// (already `typeof window !== 'undefined'`-guarded). Keeps this importable under bare
// `node --test`.

import { t, tc } from './i18n.js';
import { api } from './api-client.js';

// Mirrors api/src/lib/task-group-labels.js exactly.
export const TASK_GROUP_LABELS = ['Sprints', 'Batches', 'Bags', 'Jars', 'Groups', 'Steps'];
export const DEFAULT_TASK_GROUP_LABEL = 'Batches';

// Stored value (English plural, e.g. 'Batches') -> i18n key stem used for group.<key>.*.
const LABEL_TO_KEY = {
  Sprints: 'sprint',
  Batches: 'batch',
  Bags: 'bag',
  Jars: 'jar',
  Groups: 'group',
  Steps: 'step',
};

let _label = DEFAULT_TASK_GROUP_LABEL;
// (C1332) Sprints (task group container) visibility — project.sprints_enabled. Lives here
// rather than a dedicated module: same settings bundle (api.project.settings()), same load
// triggers (boot + project switch) as the group label above, one fetch for both. Default
// true matches migration 054's column default and the server's fail-open contract.
let _sprintsEnabled = true;
// (C1558) Objective/parent-task grouping — project.use_objective_grouping. Same settings
// bundle/load-trigger reasoning as sprintsEnabled above. Read SYNCHRONOUSLY by
// objective-parent-task.js's shouldCreateObjectiveParent() (via chat-task-preview.js) and by
// utils.js's buildObjectivePrompt() — both must stay pure/sync, so this cached value (not an
// async re-fetch) is what they consult. Default true matches migration 059's column default.
let _objectiveGroupingEnabled = true;
// (C1577) Board tier display order — project.sprint_sort_order. Same settings
// bundle/load-trigger reasoning as the two flags above. Read SYNCHRONOUSLY by
// task-board.js's renderBoardContent()/renderListContent(). Default 'asc' matches
// migration 064's column default (ascending, lowest sprint first).
let _sprintSortOrder = 'asc';

function _keyFor(label) {
  return LABEL_TO_KEY[label] || LABEL_TO_KEY[DEFAULT_TASK_GROUP_LABEL];
}

// Sets current label. Unknown/blank/null -> DEFAULT (never adopt an invalid value).
export function setGroupLabel(value) {
  _label = TASK_GROUP_LABELS.includes(value) ? value : DEFAULT_TASK_GROUP_LABEL;
}

export function getGroupLabel() {
  return _label;
}

// Project switch -> back to default until the new project's loadGroupLabel() resolves.
export function resetGroupLabel() {
  _label = DEFAULT_TASK_GROUP_LABEL;
  resetSprintsEnabled();
  resetObjectiveGroupingEnabled();
  resetSprintSortOrder();
}

// (C1332) Sets sprints_enabled. Unknown/null/undefined -> true (never adopt a falsy value
// that isn't an explicit false — mirrors setGroupLabel()'s "never adopt invalid" discipline).
export function setSprintsEnabled(value) {
  _sprintsEnabled = value !== false;
}

export function getSprintsEnabled() {
  return _sprintsEnabled;
}

// Project switch -> back to default (shown) until loadGroupLabel() resolves.
export function resetSprintsEnabled() {
  _sprintsEnabled = true;
}

// (C1558) Sets use_objective_grouping. Unknown/null/undefined -> true (never adopt a falsy
// value that isn't an explicit false — mirrors setSprintsEnabled()'s discipline).
export function setObjectiveGroupingEnabled(value) {
  _objectiveGroupingEnabled = value !== false;
}

export function getObjectiveGroupingEnabled() {
  return _objectiveGroupingEnabled;
}

// Project switch -> back to default (grouping on) until loadGroupLabel() resolves.
export function resetObjectiveGroupingEnabled() {
  _objectiveGroupingEnabled = true;
}

// (C1577) Sets sprint_sort_order. Only the literal 'desc' opts into the legacy
// highest-first board order; anything else (unknown/null/undefined/'asc') -> 'asc' —
// mirrors setSprintsEnabled()'s "never adopt invalid" discipline.
export function setSprintSortOrder(value) {
  _sprintSortOrder = value === 'desc' ? 'desc' : 'asc';
}

export function getSprintSortOrder() {
  return _sprintSortOrder;
}

// Project switch -> back to default (ascending) until loadGroupLabel() resolves.
export function resetSprintSortOrder() {
  _sprintSortOrder = 'asc';
}

// Fetches this project's task_group_label + sprints_enabled + use_objective_grouping via
// api.project.settings() (IPC in Electron, same-origin GET /api/project/settings in browser
// — see ws-handlers.js). Never throws — api.project.settings() itself degrades to the
// default on any failure (mirrors getProjectSettings()'s fail-open contract server-side).
export async function loadGroupLabel() {
  try {
    const result = await api.project.settings();
    setGroupLabel(result?.taskGroupLabel);
    setSprintsEnabled(result?.sprintsEnabled);
    setObjectiveGroupingEnabled(result?.useObjectiveGrouping);
    setSprintSortOrder(result?.sprintSortOrder);
  } catch {
    setGroupLabel(null); // -> DEFAULT
    setSprintsEnabled(null); // -> true
    setObjectiveGroupingEnabled(null); // -> true
    setSprintSortOrder(null); // -> 'asc'
  }
  return _label;
}

// Singular noun in current locale, e.g. 'Batch' / 'Партія'.
export function groupNoun() {
  return t(`group.${_keyFor(_label)}.noun`);
}

// (C1271) Plural label for an arbitrary stored value, e.g. groupPluralFor('Bags') ->
// 'Bags' / 'Сумки'. Unlike the other helpers above (which read the *current* _label),
// this takes the label as an argument — the Settings modal's Group Tasks Into <select>
// renders an option for every enum value, not just the active one.
export function groupPluralFor(label) {
  return t(`group.${_keyFor(label)}.plural`);
}

// Noun + numeral, e.g. 'Batch 237' / 'Партія 237'. Composed rather than a dedicated key —
// mirrors the pre-existing board.sprint = 'Спринт {n}' pattern.
export function groupTitle(n) {
  return `${groupNoun()} ${n}`;
}

// 'New Batch (238)' / 'Нова партія (238)'.
export function groupNewLabel(n) {
  return t(`group.${_keyFor(_label)}.new`, { n });
}

// Plural-aware 'Show More (N earlier batches)'.
export function groupShowMore(n) {
  return tc(`group.${_keyFor(_label)}.showMore`, n);
}

// 'No tasks in this batch.' — To-Do tab empty-sprint message.
export function groupEmpty() {
  return t(`group.${_keyFor(_label)}.empty`);
}

// (C1259) 'Load Earlier Batches' — Show More button label when every already-fetched
// tier is already visible but the server-side sprint window (see task-board.js
// updateShowMoreButton()) says older sprints exist. No count: unlike groupShowMore(n),
// the size of the next window page isn't known until it's fetched.
export function groupLoadMore() {
  return t(`group.${_keyFor(_label)}.loadMore`);
}

// 'Priority / Batch' — New Task form field label.
export function groupPriorityFieldLabel() {
  return t('group.priorityFieldLabel', { label: groupNoun() });
}

// ── Boilerplate sprint-name detection (C1395) ──
//
// Every auto-created sprint row (sprint-assign.js's resolveAndAssign(), mcp/server.js's
// create_task/update_task dep-heal paths, cli/migrate-tasks.js) writes the literal English
// name `Sprint ${n}` — never the project's own noun, never localized. Pre-C1395,
// task-board.js's _tierTitleFor() treated ANY stored name as custom and rendered it
// verbatim, so a group whose row happened to exist (the common case) kept showing
// "Sprint 237" forever regardless of the project's task_group_label — only a
// never-materialized tier (post "Load Earlier") ever fell through to the real noun. A
// boilerplate name isn't a custom name: strip it and fall back to the live noun instead.
//
// Alternation covers the legacy literal 'Sprint' (what every writer above actually emits)
// plus all six English singular nouns and the current locale's own noun — defensive
// against a row named under a since-changed label, or (future-proofing only — no writer
// does this today) a localized auto-name.
const _escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let _boilerplateReCache = null;
let _boilerplateReNoun = null;
function _boilerplateNameRe() {
  const noun = groupNoun();
  if (_boilerplateReCache && _boilerplateReNoun === noun) return _boilerplateReCache;
  _boilerplateReNoun = noun;
  const nouns = new Set([
    'Sprint',
    ...Object.values(LABEL_TO_KEY).map((key) => key.charAt(0).toUpperCase() + key.slice(1)),
    noun,
  ]);
  const alt = [...nouns].map(_escapeRe).join('|');
  _boilerplateReCache = new RegExp(`^\\s*(?:${alt})\\s*#?\\s*(\\d+)\\s*$`, 'i');
  return _boilerplateReCache;
}

// True when `name` is exactly an auto-generated "<noun> <n>" name for THIS n — a genuinely
// custom name (including one that merely leads with the noun, e.g. "Sprint 5 — Auth
// revamp") or a mismatched number returns false. Consumed by task-board.js's
// _tierTitleFor() ahead of its existing lead-noun check (_tierTitleLeadRe).
export function isGeneratedGroupName(name, n) {
  if (!name) return false;
  const m = _boilerplateNameRe().exec(name);
  return !!m && Number(m[1]) === n;
}
