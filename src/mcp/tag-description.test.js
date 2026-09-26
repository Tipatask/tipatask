'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPlaceholderDescription, placeholderError, PLACEHOLDER_DESCRIPTIONS } = require('./tag-description');

test('rejects both exact placeholder literals', () => {
  for (const literal of PLACEHOLDER_DESCRIPTIONS) {
    assert.equal(isPlaceholderDescription(literal), true, literal);
  }
});

test('rejects case-insensitively and with surrounding whitespace', () => {
  assert.equal(isPlaceholderDescription('  auto-registered by objective save  '), true);
  assert.equal(isPlaceholderDescription('AUTO-REGISTERED BY CREATETASK'), true);
});

test('rejects any Auto-registered-prefixed variant', () => {
  assert.equal(isPlaceholderDescription('Auto-registered by importer'), true);
  assert.equal(isPlaceholderDescription('auto-registered'), true);
});

test('accepts a real description that merely starts with "Auto"', () => {
  assert.equal(isPlaceholderDescription('Auto-scaling worker pool config'), false);
  assert.equal(isPlaceholderDescription('Automated deploy pipeline tags'), false);
});

test('accepts a normal one-line description', () => {
  assert.equal(isPlaceholderDescription('Webhook routes, hmac signing, event dispatch'), false);
});

test('non-strings and empty/blank strings are not placeholders (caller enforces required-ness separately)', () => {
  assert.equal(isPlaceholderDescription(''), false);
  assert.equal(isPlaceholderDescription('   '), false);
  assert.equal(isPlaceholderDescription(undefined), false);
  assert.equal(isPlaceholderDescription(null), false);
});

test('placeholderError names both rejected literals', () => {
  const msg = placeholderError('tt-example');
  for (const literal of PLACEHOLDER_DESCRIPTIONS) {
    assert.ok(msg.includes(literal), `expected error to name "${literal}": ${msg}`);
  }
  assert.ok(msg.includes('tt-example'));
});
