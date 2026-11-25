import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_ACCEPT, resolveFileMime } from './file-attach.js';

test('the picker and MIME resolver use the same extension allowlist', () => {
  const extensions = FILE_ACCEPT.split(',');
  for (const extension of extensions) {
    assert.ok(resolveFileMime({ name: `example${extension}`, type: '' }), extension);
  }
  for (const extension of ['.py', '.pyw', '.ts', '.tsx', '.hxx', '.html', '.cfg', '.toml', '.markdown', '.pdf']) {
    assert.ok(extensions.includes(extension), extension);
  }
  assert.equal(resolveFileMime({ name: 'EXAMPLE.PY', type: '' }), 'text/plain');
  assert.equal(resolveFileMime({ name: 'example.ts', type: 'video/mp2t' }), 'text/plain');
  assert.equal(resolveFileMime({ name: 'example.pdf', type: 'application/octet-stream' }), 'application/pdf');
});

test('an allowed browser MIME cannot override an unsupported filename', () => {
  for (const name of ['example.exe', 'example.svg', 'example.zip', 'example.docm', 'example', '.txt']) {
    assert.equal(resolveFileMime({ name, type: 'text/plain' }), null, name);
  }
});
