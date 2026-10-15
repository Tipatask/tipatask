import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unregisteredTagNames } from './tag-registration.js';

test('unregisteredTagNames returns names missing from the registry, folded and deduped', () => {
  const registry = ['feature', { name: 'Config', description: 'x' }];
  assert.deepEqual(unregisteredTagNames(['feature', ' config ', 'logo-design', 'Logo-Design', ''], registry), ['logo-design']);
});

test('unregisteredTagNames handles empty inputs', () => {
  assert.deepEqual(unregisteredTagNames(null, null), []);
  assert.deepEqual(unregisteredTagNames(['a'], []), ['a']);
});
