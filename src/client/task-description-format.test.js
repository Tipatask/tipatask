import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./task-edit-modal.js', import.meta.url), 'utf8');

test('task edit modal preserves description whitespace from textarea through PATCH', () => {
  assert.match(source, /const rawDesc = st\.draft\.description \|\| '';/);
  assert.match(source, /ta\.value = rawDesc;/);
  // (TPT9346) The editor's close() commits too — an attachment insert closes it without a blur.
  assert.equal((source.match(/\b(?:_modalState|st)\.draft\.description = ta\.value;/g) || []).length, 3,
    'input, blur and close must all store the textarea value verbatim');
  assert.match(source, /descDisplay\.innerHTML = _renderDescriptionHtml\(ta\.value\);/);
  assert.match(source, /if \(draft\.description !== original\.description\) patch\.description = draft\.description;/);
});
