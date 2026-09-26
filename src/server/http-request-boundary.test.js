'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { wrapHttpHandler } = require('./http-request-boundary');
const { createHttpHandler } = require('./ws-handlers');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let status = null;
    let body = '';
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path, agent: false }, (res) => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => done({ status, body, aborted: false }));
      res.on('aborted', () => done({ status, body, aborted: true }));
      res.on('error', () => done({ status, body, aborted: true }));
    });
    req.on('error', () => done({ status, body, aborted: true }));
    const deadline = setTimeout(() => {
      req.destroy();
      reject(new Error(`HTTP request did not settle: ${path}`));
    }, 1000);
  });
}

test('malformed escapes return 400 and do not poison the next request', async () => {
  const handler = createHttpHandler(new Map(), () => ({}));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await withServer(handler, async (port) => {
      for (const path of ['/%ZZ', '/api/tasks/%ZZ', '/%E0%A4%A']) {
        const response = await request(port, path);
        assert.equal(response.status, 400, path);
        assert.equal(response.body, 'Bad request', path);
        assert.equal(response.aborted, false, path);
      }
      const next = await request(port, '/api/pi/providers');
      assert.equal(next.status, 200);
      assert.equal(next.aborted, false);
    });
    await new Promise(setImmediate);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('backend failure before headers returns safe 500 and next request succeeds', async () => {
  let fail = true;
  const handler = createHttpHandler(new Map(), () => {
    if (fail) throw new Error('secret backend failure');
    return {};
  });
  await withServer(handler, async (port) => {
    const failed = await request(port, '/api/sessions');
    assert.deepEqual(failed, { status: 500, body: 'Internal server error', aborted: false });
    fail = false;
    const next = await request(port, '/api/sessions');
    assert.equal(next.status, 200);
    assert.deepEqual(JSON.parse(next.body).sessions, []);
  });
});

test('read and write failures before headers finish once; failure after headers closes socket', async () => {
  const counts = { beforeHeads: 0, beforeEnds: 0, afterHeads: 0, afterEnds: 0, afterDestroys: 0 };
  const handler = wrapHttpHandler(async (req, res) => {
    if (req.url === '/read') {
      await Promise.reject(new Error('secret read failure'));
    }
    if (req.url === '/write') {
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (...args) => {
        res.writeHead = writeHead;
        throw new Error('secret write failure');
      };
      res.writeHead(200);
    }
    if (req.url === '/after-headers') {
      const writeHead = res.writeHead.bind(res);
      const end = res.end.bind(res);
      const destroy = res.destroy.bind(res);
      res.writeHead = (...args) => { counts.afterHeads++; return writeHead(...args); };
      res.end = (...args) => { counts.afterEnds++; return end(...args); };
      res.destroy = (...args) => { counts.afterDestroys++; return destroy(...args); };
      res.writeHead(200);
      res.write('partial');
      res.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await Promise.reject(new Error('secret backend failure after headers'));
    }
    res.end('ok');
  });
  await withServer((req, res) => {
    if (req.url === '/read' || req.url === '/write') {
      const writeHead = res.writeHead.bind(res);
      const end = res.end.bind(res);
      res.writeHead = (...args) => { counts.beforeHeads++; return writeHead(...args); };
      res.end = (...args) => { counts.beforeEnds++; return end(...args); };
    }
    handler(req, res);
  }, async (port) => {
    for (const path of ['/read', '/write']) {
      const failed = await request(port, path);
      assert.deepEqual(failed, { status: 500, body: 'Internal server error', aborted: false });
    }
    const partial = await request(port, '/after-headers');
    assert.equal(partial.status, 200);
    assert.equal(partial.aborted, true);
    assert.equal(counts.afterHeads, 1);
    assert.equal(counts.afterEnds, 0);
    assert.equal(counts.afterDestroys, 1);
    assert.equal(counts.beforeHeads, 2);
    assert.equal(counts.beforeEnds, 2);
    const next = await request(port, '/ok');
    assert.deepEqual(next, { status: 200, body: 'ok', aborted: false });
  });
});
