'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppVersion, cleanVersion } = require('./app-version');

test('uses getVersion when valid', () => {
  assert.equal(resolveAppVersion({ getVersion: () => '1.2.3', readPackageVersion: () => '9.9.9' }), '1.2.3');
});

test('trims whitespace', () => {
  assert.equal(resolveAppVersion({ getVersion: () => ' 1.2.3\n' }), '1.2.3');
});

test('falls back to package version when getVersion throws or is empty', () => {
  assert.equal(resolveAppVersion({ getVersion: () => { throw new Error('x'); }, readPackageVersion: () => '0.9.0' }), '0.9.0');
  assert.equal(resolveAppVersion({ getVersion: () => '', readPackageVersion: () => '0.9.0' }), '0.9.0');
});

test('returns empty string, never throws, when every source fails', () => {
  const boom = () => { throw new Error('nope'); };
  assert.equal(resolveAppVersion({ getVersion: boom, readPackageVersion: boom }), '');
  assert.equal(resolveAppVersion({}), '');
  assert.equal(resolveAppVersion(), '');
});

test('rejects non-string and unsafe values', () => {
  assert.equal(cleanVersion(undefined), '');
  assert.equal(cleanVersion(123), '');
  assert.equal(cleanVersion('<script>alert(1)</script>'), '');
  assert.equal(cleanVersion('a'.repeat(33)), '');
  assert.equal(resolveAppVersion({ getVersion: () => '<b>', readPackageVersion: () => '1.0.0-beta.1' }), '1.0.0-beta.1');
});
