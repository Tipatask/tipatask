'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

test('Electron upload handlers reject unlisted MIME types before forwarding to the backend', async () => {
  const handlers = new Map();
  const calls = [];
  const backend = {
    uploadImage: (...args) => calls.push(['image', ...args]),
    uploadFile: (...args) => calls.push(['file', ...args]),
  };
  const routerPath = require.resolve('../../main/ipc/api-router');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} };
    if (request === '../window-state') return { getWindowState: () => ({ backend }) };
    if (request === '../../src/server/config') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(routerPath).registerApiHandlers();
  } finally {
    Module._load = originalLoad;
    delete require.cache[routerPath];
  }

  const event = { sender: { id: 1 } };
  const uploadImage = handlers.get('api:images.upload');
  const uploadFile = handlers.get('api:files.upload');
  const data = 'YQ==';
  await assert.rejects(uploadImage(event, { filename: 'image.svg', mimeType: 'image/svg+xml', data }),
    { code: 'INVALID_MIME', statusCode: 400 });
  await assert.rejects(uploadFile(event, { filename: 'program.exe', mimeType: 'application/x-msdownload', data }),
    { code: 'INVALID_MIME', statusCode: 400 });
  assert.deepEqual(calls, []);

  await uploadImage(event, { filename: 'image.avif', mimeType: 'image/avif', data, taskKey: 'TPT1' });
  await uploadFile(event, { filename: 'source.py', mimeType: 'text/x-python', data });
  assert.deepEqual(calls, [
    ['image', 'image.avif', 'image/avif', data, 'TPT1'],
    ['file', 'source.py', 'text/x-python', data, null],
  ]);
});
