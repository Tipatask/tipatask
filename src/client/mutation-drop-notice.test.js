import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDroppedMutation, droppedMutationTag } from './mutation-drop-notice.js';

const t = (key, params = {}) => {
  const table = {
    'queue.droppedTitle': 'Offline edit was not saved',
    'queue.droppedBody': '{task}: {msg}',
    'queue.droppedCreate': 'New task "{task}" was not created: {msg}',
    'queue.droppedTagHint': 'tt-* hint',
  };
  return Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), table[key] || key);
};

test('update entry: key + title label, message, one tag per task', () => {
  const entry = { op: 'update', taskId: 'TPT1', title: 'Fix thing', code: 'E400', statusCode: 400, message: 'Bad request' };
  assert.deepEqual(describeDroppedMutation(entry, t), {
    tag: 'mutation-dropped-TPT1',
    title: 'Offline edit was not saved',
    body: 'TPT1 · Fix thing: Bad request',
  });
  assert.equal(droppedMutationTag(entry), 'mutation-dropped-TPT1');
});

test('tt-* tag hint is appended only for the tag gate code', () => {
  const gate = describeDroppedMutation({ op: 'update', taskId: 'TPT2', code: 'TAGS_UNREGISTERED', message: 'Unregistered tag(s): "tt-x"' }, t);
  assert.equal(gate.body, 'TPT2: Unregistered tag(s): "tt-x"\ntt-* hint');
  const other = describeDroppedMutation({ op: 'update', taskId: 'TPT2', code: 'E500', message: 'boom' }, t);
  assert.equal(other.body, 'TPT2: boom');
});

test('create entry hides the tmp id and uses the create wording', () => {
  const r = describeDroppedMutation({ op: 'create', taskId: 'tmp-1-2', title: 'New one', message: 'nope' }, t);
  assert.equal(r.body, 'New task "New one" was not created: nope');
  assert.equal(r.tag, 'mutation-dropped-tmp-1-2');
});

test('tolerates missing fields', () => {
  const r = describeDroppedMutation(null, t);
  assert.equal(r.tag, 'mutation-dropped-unknown');
  assert.equal(r.body, ': rejected');
});
