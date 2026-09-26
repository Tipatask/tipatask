'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { WS_LIMITS } = require('./ws-upgrade');

const CHILD_CODE = `
  const http = require('node:http');
  const { createWebSocketGate } = require('./ws-upgrade');
  const websocket = require('./websocket');
  const server = http.createServer();
  const gate = createWebSocketGate(server, (ws, req) => {
    ws._taskId = new URL(req.url, 'http://localhost').searchParams.get('taskId');
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  websocket.init(gate);
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
  process.on('message', msg => {
    if (msg === 'count') process.send({ type: 'count', count: gate.clients.size });
    if (msg === 'broadcast') websocket.broadcast('tasks-updated', {});
    if (msg === 'terminal-output') {
      for (const ws of gate.clients) if (ws._taskId === 'TPT338') {
        ws.send(JSON.stringify({ type: 'data', data: 'PTY output' }));
      }
    }
    if (msg === 'stop') { for (const ws of gate.clients) ws.terminate(); server.close(() => process.exit(0)); }
  });
`;

async function fixture(t) {
  const child = spawn(process.execPath, ['--max-old-space-size=64', '-e', CHILD_CODE], {
    cwd: __dirname, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const ready = await new Promise((resolve, reject) => {
    child.on('message', msg => { if (msg.type === 'ready') resolve(msg.port); });
    child.once('exit', code => reject(new Error(`WS fixture exited ${code}: ${stderr}`)));
  });
  return { child, url: `ws://127.0.0.1:${ready}` };
}

function connect(url, taskId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/?taskId=${encodeURIComponent(taskId)}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => resolve({ data, isBinary }));
    ws.once('error', reject);
  });
}

function nextClose(ws) {
  return new Promise(resolve => {
    ws.on('error', () => {});
    ws.once('close', code => resolve(code));
  });
}

test('bounded voice receiver rejects oversized and empty-fragment messages without killing server', { timeout: 7000 }, async t => {
  const { child, url } = await fixture(t);
  assert.equal(WS_LIMITS.voice.maxPayload, 64 * 1024);
  const large = await connect(url, '__voice__');
  const largeClosed = nextClose(large);
  large.send(Buffer.alloc(WS_LIMITS.voice.maxPayload + 1));
  assert.equal(await largeClosed, 1009);

  const fragments = await connect(url, '__voice__');
  const fragmentsClosed = nextClose(fragments);
  for (let i = 0; i <= WS_LIMITS.voice.maxFragments; i++) {
    if (fragments.readyState !== WebSocket.OPEN) break;
    fragments.send(Buffer.alloc(0), { fin: false });
  }
  assert.equal(await fragmentsClosed, 1008);

  const good = await connect(url, '__voice__');
  const reply = nextMessage(good);
  good.send(Buffer.alloc(1600, 7));
  assert.equal((await reply).data.length, 1600);
  good.close();
  assert.equal(child.exitCode, null);
});

test('terminal, objective and simultaneous board sockets retain normal messages', { timeout: 7000 }, async t => {
  const { child, url } = await fixture(t);
  const sockets = await Promise.all(['TPT338', 'obj-338', '__board__', '__board__'].map(id => connect(url, id)));
  t.after(() => sockets.forEach(ws => ws.terminate()));
  const payloads = [
    { type: 'data', data: 'terminal input' },
    { type: 'chat', content: 'objective text' },
    { type: 'sync-kb' },
    { type: 'upload-image', data: 'small' },
  ];
  const replies = sockets.map(nextMessage);
  sockets.forEach((ws, i) => ws.send(JSON.stringify(payloads[i])));
  assert.deepEqual((await Promise.all(replies)).map(r => JSON.parse(r.data)), payloads);
  const count = new Promise(resolve => child.on('message', msg => { if (msg.type === 'count') resolve(msg.count); }));
  child.send('count');
  assert.equal(await count, 4);
  const broadcastReplies = sockets.map(nextMessage);
  child.send('broadcast');
  assert.deepEqual((await Promise.all(broadcastReplies)).map(r => JSON.parse(r.data)),
    Array(4).fill({ type: 'tasks-updated' }));
  const terminalOutput = nextMessage(sockets[0]);
  child.send('terminal-output');
  assert.deepEqual(JSON.parse((await terminalOutput).data), { type: 'data', data: 'PTY output' });
  sockets.forEach(ws => ws.close());
});
