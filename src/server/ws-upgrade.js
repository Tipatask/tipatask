'use strict';

const { WebSocketServer } = require('ws');

// Limits apply before a complete message reaches any application handler. The general lane
// allows a 10 MiB image after base64/JSON encoding; voice sends 1,600-byte PCM frames.
const WS_LIMITS = Object.freeze({
  general: Object.freeze({ maxPayload: 16 * 1024 * 1024, maxFragments: 128, maxBufferedChunks: 4096 }),
  voice: Object.freeze({ maxPayload: 64 * 1024, maxFragments: 16, maxBufferedChunks: 128 }),
  attention: Object.freeze({ maxPayload: 4 * 1024, maxFragments: 8, maxBufferedChunks: 32 }),
});

// `guardUpgrade(req, socket, head, wss)` (optional) authorizes the upgrade and completes it
// on the lane's server, or rejects the socket. Without it the lane accepts directly.
function createWebSocketGate(server, onConnection, { guardUpgrade = null } = {}) {
  const servers = Object.fromEntries(Object.entries(WS_LIMITS).map(([name, limits]) => {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, ...limits });
    wss.on('connection', (ws, req) => {
      // ws emits 'error' when it rejects an oversized/fragmented message. Without a listener,
      // one bad peer would crash the entire Task App server process.
      ws.on('error', (err) => {
        if (!String(err && err.code || '').startsWith('WS_ERR_')) {
          console.warn('[ws] Socket error:', err && err.message || err);
        }
      });
      onConnection(ws, req);
    });
    wss.on('error', () => {});
    return [name, wss];
  }));

  server.on('upgrade', (req, socket, head) => {
    let taskId = '';
    try { taskId = new URL(req.url, 'http://localhost').searchParams.get('taskId') || ''; }
    catch { socket.destroy(); return; }
    const lane = taskId === '__voice__' ? 'voice'
      : taskId === '__attention__' ? 'attention' : 'general';
    const wss = servers[lane];
    if (guardUpgrade) guardUpgrade(req, socket, head, wss);
    else wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  server.on('close', () => {
    for (const wss of Object.values(servers)) wss.close();
  });

  // Existing broadcast and task-poll code consumes one wss.clients set. Keep that contract
  // while each lane uses its own receiver limits.
  return {
    get clients() { return new Set(Object.values(servers).flatMap(wss => [...wss.clients])); },
  };
}

module.exports = { WS_LIMITS, createWebSocketGate };
