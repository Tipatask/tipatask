import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./task-edit-modal.js', import.meta.url), 'utf8');

test('task edit modal preserves description whitespace from textarea through PATCH', () => {
  assert.match(source, /const rawDesc = _modalState\.draft\.description \|\| '';/);
  assert.match(source, /ta\.value = rawDesc;/);
  assert.equal((source.match(/_modalState\.draft\.description = ta\.value;/g) || []).length, 2,
    'input and blur must both store the textarea value verbatim');
  assert.match(source, /descDisplay\.innerHTML = _renderDescriptionHtml\(ta\.value\);/);
  assert.match(source, /if \(draft\.description !== original\.description\) patch\.description = draft\.description;/);
});
