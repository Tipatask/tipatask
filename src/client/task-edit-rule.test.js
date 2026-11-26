// (TPT9417) The Task App's side of the API's task edit rule: the lock follows the API's can_edit
// (mapped to canEdit) and nothing else, the reason key names the rule or the role, and a refused
// write is recognised on every transport shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TASK_EDIT_REFUSAL, taskEditLocked, taskEditLockKey, taskEditLockText, isTaskEditRefusal } from './task-edit-rule.js';
import { LOCALES } from './i18n.js';

// The body of a top-level `function name(` in a source file, up to its closing `\n}`.
function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `${name}() not found`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name}() has no closing brace`);
  return source.slice(start, end + 2);
}

test('only an explicit canEdit false locks a task', () => {
  assert.equal(taskEditLocked({ id: 'A', canEdit: false }), true);
  assert.equal(taskEditLocked({ id: 'A', canEdit: true }), false);
  // No flag (an API without can_edit, an offline stub, a proposal): the API stays the authority.
  assert.equal(taskEditLocked({ id: 'A' }), false);
  assert.equal(taskEditLocked({ id: 'A', canEdit: null }), false);
  assert.equal(taskEditLocked(null), false);
  assert.equal(taskEditLocked(undefined), false);
});

test('the assignee alone no longer decides: creator, owner and higher role keep another member\'s task editable', () => {
  // The API answers can_edit true for the task's creator, the project owner and a higher role, even
  // when the task is assigned to someone else; the old assignee comparison locked all three.
  for (const viewer of ['creator', 'owner', 'higher role']) {
    assert.equal(taskEditLocked({ id: 'T', assignee: 7, createdBy: 1, canEdit: true }), false, viewer);
  }
  // And a same- or lower-role member sees false for the same task.
  assert.equal(taskEditLocked({ id: 'T', assignee: 7, createdBy: 9, canEdit: false }), true);
});

test('the reason key names the rule for another member\'s task and the role otherwise', () => {
  assert.equal(taskEditLockKey({ assignee: 7, canEdit: false }, 1), 'task.editLocked');
  assert.equal(taskEditLockKey({ assignee: '7', canEdit: false }, 1), 'task.editLocked');
  // Unassigned, or the user's own: only a role without write access can lock it.
  assert.equal(taskEditLockKey({ assignee: null, canEdit: false }, 1), 'task.editLockedRole');
  assert.equal(taskEditLockKey({ canEdit: false }, 1), 'task.editLockedRole');
  assert.equal(taskEditLockKey({ assignee: 1, canEdit: false }, '1'), 'task.editLockedRole');
  // An unknown current user counts as another member.
  assert.equal(taskEditLockKey({ assignee: 7, canEdit: false }, null), 'task.editLocked');
  const t = (key) => `<${key}>`;
  assert.equal(taskEditLockText({ assignee: 7 }, 1, t), '<task.editLocked>');
  assert.equal(taskEditLockText({ assignee: 1 }, 1, t), '<task.editLockedRole>');
});

test('a refused write is recognised by its code, its API body or its message', () => {
  assert.equal(TASK_EDIT_REFUSAL, 'task_role_rank');
  // IPC envelope / local HTTP route: the code api-backend.js puts on the error.
  assert.equal(isTaskEditRefusal(Object.assign(new Error('x'), { statusCode: 403, code: 'task_role_rank' })), true);
  // api-backend.js's own error: the API body.
  assert.equal(isTaskEditRefusal({ statusCode: 403, body: { error: 'forbidden', reason: 'task_role_rank' } }), true);
  // A path that kept only the message.
  assert.equal(isTaskEditRefusal(new Error('API 403: {"error":"forbidden","reason":"task_role_rank","blocked_by":["T1"]}')), true);
  // Anything else is not the rule: an auth 403, the author-only comment 403, a network error.
  assert.equal(isTaskEditRefusal(Object.assign(new Error('Access denied'), { statusCode: 403 })), false);
  assert.equal(isTaskEditRefusal({ statusCode: 403, body: { error: 'forbidden' } }), false);
  assert.equal(isTaskEditRefusal(Object.assign(new Error('fetch failed'), { networkError: true })), false);
  assert.equal(isTaskEditRefusal(null), false);
  assert.equal(isTaskEditRefusal('task_role_rank'), false);
});

// template.html is the page shell, outside any module a DOM test can import: its To-Do drawer is
// checked by its source. The drawer's status select uses the card's predicate and reason.
test('the To-Do drawer locks its status select with the card\'s rule and reason', () => {
  const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const drawer = functionBody(template, 'openTodoDrawer');
  assert.match(drawer, /const statusLock = isTaskReadOnly\(task\) \? ` disabled title="\$\{escapeAttr\(taskEditLockReason\(task\)\)\}"` : '';/);
  assert.match(drawer, /<select class="drawer-status"[^>]*\$\{statusLock\}>/);
  assert.match(template, /dependencyKeysMarkup, isTaskReadOnly, taskEditLockReason,\n\} = taskCard;/);
});

test('every reason and bulk string exists in every locale with its placeholders', () => {
  const keys = {
    'task.editLocked': [], 'task.editLockedRole': [], 'modal.readOnlyAssignee': ['{name}'], 'modal.readOnlyRole': [],
    'bulk.viewOnly': ['{n}'], 'bulk.viewOnlyHint.one': ['{n}'], 'bulk.viewOnlyHint.many': ['{n}'],
    'bulk.skippedViewOnly.one': ['{n}', '{ids}'], 'bulk.skippedViewOnly.many': ['{n}', '{ids}'], 'bulk.allViewOnly': [],
  };
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const [key, placeholders] of Object.entries(keys)) {
      assert.equal(typeof table[key], 'string', `${locale}.${key} is missing`);
      for (const placeholder of placeholders) assert.ok(table[key].includes(placeholder), `${locale}.${key} must keep ${placeholder}`);
      if (locale !== 'en') assert.notEqual(table[key], LOCALES.en[key], `${locale}.${key} is the English text`);
    }
  }
  // Ukrainian has a few form wherever English has a plural.
  for (const key of ['bulk.viewOnlyHint', 'bulk.skippedViewOnly']) {
    assert.equal(typeof LOCALES.uk[`${key}.few`], 'string', `uk.${key}.few is missing`);
    assert.ok(LOCALES.uk[`${key}.few`].includes('{n}'));
  }
});
