'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read the registration as source: requiring server.js starts the stdio transport.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('create_task_comment sends completion reports through complete_task and keeps blocked reports available', () => {
  const match = source.match(/server\.tool\(\s*'create_task_comment',\s*`([^`]*)`/);
  assert.ok(match, 'create_task_comment must have a tool description');
  const description = match[1];
  assert.match(description, /complete_task\(task_key, resolution\)/);
  assert.match(description, /type: "resolution".*completion status after verification/);
  assert.match(description, /only when completion is blocked.*on_fire/);
  assert.doesNotMatch(description, /SAME tool-call batch/i);
  assert.match(description, /plain English prose/);
  assert.match(description, /never in a compressed\/caveman style/);
  assert.match(description, /type='comment'/);
  assert.match(description, /type='spec'/);
});
