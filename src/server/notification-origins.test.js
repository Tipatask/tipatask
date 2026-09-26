'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationOriginRegistry } = require('../../main/notification-origins');

test('equal completion tags from separate projects keep their own native click origins', () => {
  const origins = createNotificationOriginRegistry();
  const projectA = { windowId: 1, projectPath: '/project/A' };
  const projectB = { windowId: 2, projectPath: '/project/B' };
  origins.remember('completed-C1', projectA);
  origins.remember('completed-C1', projectB);
  assert.equal(origins.get('completed-C1', '/project/A'), projectA);
  assert.equal(origins.get('completed-C1', '/project/B'), projectB);
  origins.forget('completed-C1', '/project/A', projectA);
  assert.equal(origins.get('completed-C1', '/project/A'), undefined);
  assert.equal(origins.get('completed-C1', '/project/B'), projectB);
});

test('late close of an older banner cannot remove a newer origin in the same project', () => {
  const origins = createNotificationOriginRegistry();
  const older = { windowId: 1, projectPath: '/project/A' };
  const newer = { windowId: 3, projectPath: '/project/A' };
  origins.remember('completed-C1', older);
  origins.remember('completed-C1', newer);
  origins.forget('completed-C1', '/project/A', older);
  assert.equal(origins.get('completed-C1', '/project/A'), newer);
});
