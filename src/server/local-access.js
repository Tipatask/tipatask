'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'tipatask_local_session';
const CAPABILITY_HEADER = 'x-tipatask-capability';
const MAX_LOGIN_BYTES = 1024;
const LOCAL_HOST = '127.0.0.1';

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function electronCapability(secret, projectPath = '') {
  return crypto.createHmac('sha256', secret)
    .update('tipatask-electron-project\0' + (projectPath || ''))
    .digest('base64url');
}

function stampElectronRequest(headers, { requestUrl, port, secret, projectPath = '', knownWindow = false }) {
  for (const key of Object.keys(headers)) {
    if ([CAPABILITY_HEADER, 'x-tipatask-project', 'x-tiptask-project-path'].includes(key.toLowerCase())) delete headers[key];
  }
  let url;
  try { url = new URL(requestUrl); } catch { return headers; }
  // WebSocket handshakes reach onBeforeSendHeaders as ws:// URLs and need the same
  // capability as HTTP. Secure schemes never target the plain local listener.
  const local = (url.protocol === 'http:' || url.protocol === 'ws:')
    && ['localhost', '127.0.0.1'].includes(url.hostname)
    && url.port === String(port);
  if (local && knownWindow) {
    headers[CAPABILITY_HEADER] = electronCapability(secret, projectPath);
    if (projectPath) {
      headers['X-TipTask-Project-Path'] = projectPath;
      headers['x-tipatask-project'] = projectPath;
    }
  }
  return headers;
}

function headerCount(req, name) {
  let count = 0;
  for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function writeError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/todo.html';
  try {
    const url = new URL(value, 'http://localhost');
    if (url.pathname !== '/start-task' && url.pathname !== '/open-objective') return '/todo.html';
    return url.pathname + url.search;
  } catch { return '/todo.html'; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function createLocalAccess({ port, secret = crypto.randomBytes(32).toString('base64url'),
  electron = false, getActiveProjectPath = () => '' } = {}) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const loginCode = electron ? null : crypto.randomBytes(18).toString('base64url');
  let loginCodeAvailable = !!loginCode;
  const browserSessions = new Set();

  function validateAddress(req, { upgrade = false } = {}) {
    if (headerCount(req, 'host') !== 1 || !allowedHosts.has(req.headers.host)) return 403;
    if (headerCount(req, 'origin') > 1) return 403;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return 403;
    if (upgrade && !origin) return 403;
    return 0;
  }

  function authorize(req, { upgrade = false } = {}) {
    const badAddress = validateAddress(req, { upgrade });
    if (badAddress) return { status: badAddress };
    const url = new URL(req.url, `http://${req.headers.host}`);
    const capability = req.headers[CAPABILITY_HEADER];
    const selectorA = req.headers['x-tipatask-project'];
    const selectorB = req.headers['x-tiptask-project-path'];
    const queryPath = url.searchParams.get('projectPath');
    let projectPath;
    let kind;

    if (capability) {
      if (!electron || typeof capability !== 'string') return { status: 401 };
      if (selectorA && selectorB && selectorA !== selectorB) return { status: 403 };
      projectPath = selectorA || selectorB || '';
      if (!equalSecret(capability, electronCapability(secret, projectPath))) return { status: 401 };
      kind = 'electron';
    } else {
      const session = cookieValue(req, COOKIE_NAME);
      if (session && browserSessions.has(session)) {
        projectPath = getActiveProjectPath() || '';
        kind = 'browser';
      } else if (!upgrade && electron && req.method === 'GET'
        && (url.pathname === '/start-task' || url.pathname === '/open-objective')) {
        // External web navigation has no local capability. Native confirmation is required
        // before the bridge reads project data or dispatches a task.
        return { kind: 'handoff', projectPath: '' };
      } else {
        return { status: 401 };
      }
      if ((selectorA && selectorA !== projectPath) || (selectorB && selectorB !== projectPath)) return { status: 403 };
    }

    // A project path in a socket URL is only a compatibility hint. It cannot choose a
    // backend. The signed Electron scope or the active browser scope owns that choice.
    if (queryPath && queryPath !== projectPath) return { status: 403 };
    req.headers['x-tipatask-project'] = projectPath || undefined;
    req.headers['x-tiptask-project-path'] = projectPath || undefined;
    req.localAccess = { kind, projectPath };
    return req.localAccess;
  }

  async function handleLogin(req, res) {
    if (!loginCode) return writeError(res, 404, 'Not found');
    if (req.method === 'GET' && req.url.split('?')[0] === '/login') {
      const next = safeReturnPath(new URL(req.url, `http://${req.headers.host}`).searchParams.get('next'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>TipATask sign in</title><p><a href="${escapeHtml(next)}">Continue with existing session</a></p><form method="post" action="/api/local-auth"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Launch code <input name="code" autocomplete="off" autofocus></label><button>Open Task App</button></form>`);
    }
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/local-auth') return false;
    if (req.headers.origin !== `http://${req.headers.host}`) return writeError(res, 403, 'Forbidden');
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > MAX_LOGIN_BYTES) return writeError(res, 413, 'Too large');
    }
    const supplied = new URLSearchParams(body).get('code');
    if (!loginCodeAvailable || !equalSecret(supplied, loginCode)) return writeError(res, 401, 'Invalid launch code');
    loginCodeAvailable = false;
    const session = crypto.randomBytes(32).toString('base64url');
    browserSessions.add(session);
    res.writeHead(303, {
      Location: safeReturnPath(new URLSearchParams(body).get('next')),
      'Set-Cookie': `${COOKIE_NAME}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
    return true;
  }

  async function guardHttp(req, res, handler) {
    const badAddress = validateAddress(req);
    if (badAddress) return writeError(res, badAddress, 'Forbidden');
    if (req.headers.host === `localhost:${port}`) {
      // The website links to localhost, while the app and browser login use 127.0.0.1.
      // Cookies are host-scoped, so canonicalize before authentication. Never redirect
      // a mutation or a request-target that names another authority.
      if (req.method !== 'GET') return writeError(res, 403, 'Forbidden');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.origin !== `http://${req.headers.host}`) return writeError(res, 403, 'Forbidden');
      res.writeHead(303, {
        Location: `http://${LOCAL_HOST}:${port}${url.pathname}${url.search}`,
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      });
      return res.end();
    }
    const path = req.url.split('?')[0];
    if (!electron && (path === '/login' || path === '/api/local-auth')) {
      return handleLogin(req, res);
    }
    const result = authorize(req);
    if (result.status) {
      if (result.status === 401 && !electron && req.method === 'GET' && (path === '/' || path === '/todo.html')) {
        res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (result.status === 401 && !electron && req.method === 'GET'
        && (path === '/start-task' || path === '/open-objective')) {
        res.writeHead(303, { Location: `/login?next=${encodeURIComponent(req.url)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return writeError(res, result.status, result.status === 401 ? 'Unauthorized' : 'Forbidden');
    }
    if (result.kind === 'handoff') req.localAccess = result;
    return handler(req, res);
  }

  function guardUpgrade(req, socket, head, wss) {
    const result = authorize(req, { upgrade: true });
    if (result.status) {
      socket.write(`HTTP/1.1 ${result.status} ${result.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return false;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    return true;
  }

  return { guardHttp, guardUpgrade, authorize, loginCode, secret };
}

module.exports = { createLocalAccess, electronCapability, stampElectronRequest, CAPABILITY_HEADER, LOCAL_HOST };
