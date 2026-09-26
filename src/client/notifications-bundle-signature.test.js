import { test } from 'node:test';
import assert from 'node:assert/strict';

// (C1141) getNotificationStatus()'s signed/valid handling is driven by a ONE-SHOT
// window.electronAPI.notifyStatus() promise resolved once at module load (see
// notifications.js's top-level `if (typeof window !== 'undefined' && ...)` block) — so unlike
// every other branch in notifications.test.js, it can't be exercised by mutating
// globalThis.window inside a test after import. This file mocks window.electronAPI.notifyStatus
// BEFORE the dynamic import so the module-load promise resolves against it, then awaits a
// microtask tick before asserting — mirroring notifications.test.js's own top-of-file
// globalThis.Notification mock-before-import pattern.

globalThis.Notification = class MockNotification {
  constructor() {}
  static get permission() { return 'default'; }
};

let notifyStatusResult = { signed: true, valid: false, reason: 'seal-broken' };
globalThis.window = {
  electronAPI: {
    notify: () => Promise.resolve({ ok: true }),
    notifyStatus: () => Promise.resolve(notifyStatusResult),
  },
};

const { getNotificationStatus } = await import('./notifications.js');

// Let the module-load .then() run — it's already queued by the time the import above resolves.
await Promise.resolve();
await Promise.resolve();

test('seal-broken bundle (signed but codesign --verify failed): canDeliver false, lastError seal-broken', () => {
  const status = getNotificationStatus();
  assert.equal(status.transport, 'electron');
  assert.equal(status.canDeliver, false);
  assert.equal(status.lastError, 'seal-broken');
});
