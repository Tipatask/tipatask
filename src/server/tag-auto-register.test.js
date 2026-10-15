'use strict';

// TPT623 — tag-auto-register.js: prompt shape and answer mapping. The one-shot runner is stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeTagsWithLlm, buildDescribePrompt, describedMapFrom } = require('./tag-auto-register');

test('buildDescribePrompt lists every name and the task context, asks for JSON', () => {
  const p = buildDescribePrompt(['logo-design', 'branding'], { title: 'Generating a project logo', description: 'Design a logo symbol' });
  assert.match(p, /1\. "logo-design"/);
  assert.match(p, /2\. "branding"/);
  assert.match(p, /Title: Generating a project logo/);
  assert.match(p, /JSON array/);
});

test('describedMapFrom accepts an array, a {tags} wrapper or a name->description object', () => {
  assert.deepEqual([...describedMapFrom([{ name: 'a', description: 'A' }, { name: 'b' }])], [['a', 'A']]);
  assert.deepEqual([...describedMapFrom({ tags: [{ name: 'a', description: 'A' }] })], [['a', 'A']]);
  assert.deepEqual([...describedMapFrom({ a: 'A', b: 3 })], [['a', 'A']]);
  assert.equal(describedMapFrom(null).size, 0);
});

test('describeTagsWithLlm runs one prompt for all names and maps the answer', async () => {
  const calls = [];
  const map = await describeTagsWithLlm(['logo-design', 'logo-design', ''], {
    projectRoot: '/p',
    runOneShotPrompt: async (prompt, opts) => { calls.push({ prompt, opts }); return [{ name: 'logo-design', description: 'Logo work.' }]; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.projectRoot, '/p');
  assert.equal(calls[0].opts.parseJson, true);
  assert.deepEqual([...map], [['logo-design', 'Logo work.']]);
});

test('describeTagsWithLlm resolves an empty map on failure or with nothing to describe', async () => {
  assert.equal((await describeTagsWithLlm(['a'], { runOneShotPrompt: async () => { throw new Error('boom'); } })).size, 0);
  assert.equal((await describeTagsWithLlm(['a'], { runOneShotPrompt: async () => null })).size, 0);
  let called = false;
  assert.equal((await describeTagsWithLlm([], { runOneShotPrompt: async () => { called = true; } })).size, 0);
  assert.equal(called, false);
});
