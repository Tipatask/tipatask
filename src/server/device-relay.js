'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const WebSocket = require('ws');
const { normalizeBaseUrl, onAccountChange } = require('./account-store');

const terminalEvents = new EventEmitter();
const COMMANDS = ['start', 'attach', 'input', 'resize', 'stop', 'detach', 'approve', 'take_control'];
// Task kinds beyond a plain coding task that this build's `start` runs, announced in the hello's
// `capabilities.task_kinds` so the web offers Start for them only on a device that can. An
// objective runs in parent-objective preparation mode (remote-start-guard.js, spawnTerminal()).
// An API that predates the field drops it; an older Task App never sends it.
const OBJECTIVE_TASK_KIND = 'objective';
const TASK_KINDS = Object.freeze([OBJECTIVE_TASK_KIND]);
const DEDUPE_MS = 10 * 60 * 1000;
const MAX_COMMANDS = 512;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
// Includes network round-trip and local consumption; never extend on a late reply.
const START_AUTH_MS = 5000;

// What a terminal sends by itself rather than for a key or a paste: focus in/out, mouse reports,
// and answers to the agent's own queries (device attributes, cursor position, mode reports, DCS
// and OSC replies, window and keyboard-protocol reports). Agent TUIs turn focus and mouse
// reporting on, so a Task App terminal merely gaining focus, losing it or being crossed by the
// pointer sends these; none of that is the person taking the keyboard back.
const TERMINAL_REPORT = new RegExp(`\\x1b(?:${[
  '\\[[IO]',
  '\\[<\\d+;\\d+;\\d+[Mm]',
  '\\[M[\\x20-\\uffff]{3}',
  '\\[[?>=][\\d;]*c',
  '\\[\\??\\d+(?:;\\d+)+R',
  '\\[\\d+n',
  '\\[\\??\\d+;\\d+\\$y',
  '\\[\\d+(?:;\\d+)*t',
  '\\[\\?\\d+u',
  'P[^\\x1b]*\\x1b\\\\',
  '\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
].join('|')})`, 'g');

function isTerminalReport(data) {
  return typeof data === 'string' && data.length > 0 && data.replace(TERMINAL_REPORT, '') === '';
}

// Human approvals belong to one live run/request. A new plan-ready interval gets a new id;
// neither a reconnect nor a second viewer can turn an old answer into a different approval.
function remoteApprovalRequest(session) {
  const waiting = session.alive && !session.permissionMode?.pending;
  const tool = waiting && session._permissionGate?.snapshot();
  const plan = waiting && session.terminalPhase === 'planning' && session._planReadySent;
  if (!plan) session._remotePlanApprovalId = null;
  if (tool) return { id: tool.id, kind: 'tool', tool: tool.tool, input: tool.input };
  if (plan) return { id: session._remotePlanApprovalId ||= randomUUID(), kind: 'plan' };
  return null;
}

function runId(session) {
  return session._relayRunId ||= randomUUID();
}

function utf8Tail(value, max) {
  const bytes = Buffer.from(value || '');
  let start = Math.max(0, bytes.length - max);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function utf8Head(value, max) {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, max);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function relayUrl(baseUrl, deviceId, instanceId) {
  const url = new URL(baseUrl);
  // Plaintext is useful only for an isolated loopback API. Never send bearer auth over LAN HTTP.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('Device relay requires HTTPS');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/device-relay/device';
  url.search = '';
  url.hash = '';
  url.searchParams.set('device_id', deviceId);
  url.searchParams.set('instance_id', instanceId);
  return url.toString();
}

function accountIdentity(credentials) {
  try {
    const payload = JSON.parse(Buffer.from(credentials.token.split('.')[1], 'base64url'));
    if (!payload.id) return null;
    return JSON.stringify([normalizeBaseUrl(credentials.baseUrl), payload.id, payload.project_id ?? null]);
  } catch { return null; }
}

// (TPT9217) Why the API answered a relay upgrade with plain HTTP, for one log line. A 2xx or
// 426 means the Upgrade header never reached the relay: a reverse proxy in front of the API is
// not forwarding WebSocket upgrades (the API answers 426 itself; an older one serves its SPA).
function refusalText(origin, status) {
  const reason = status === 401 ? 'the account token was refused; renewing it'
    : status === 403 ? 'the signed-in account does not own this device or its link to the project; remote control stays off until Task App restarts'
      : status === 426 || (status >= 200 && status < 300)
        ? 'the WebSocket upgrade never reached the relay, so a reverse proxy in front of the API is not forwarding WebSocket upgrades; retrying'
        : 'retrying';
  return `[device-relay] ${origin} refused the relay connection (HTTP ${status}): ${reason}`;
}

function captureSessionOwner(session, backend) {
  try {
    const credentials = backend.getCredentials();
    const identity = accountIdentity(credentials);
    session._relayOwner = identity ? JSON.stringify([identity, Number(credentials.projectId)]) : null;
  } catch { session._relayOwner = null; }
}

// One connection per API/account/device, multiplexing only explicitly enabled local projects.
// All timers, sockets and terminal-event subscriptions belong to the returned manager.
function connectDeviceRelay({ getProjects, getSessions, handleCommand, events = terminalEvents,
  WebSocketImpl = WebSocket, refreshToken = require('./token-refresh').refreshProjectToken,
  now = Date.now, random = Math.random, instanceId = randomUUID(), pollMs = 30000,
  monotonicNow = () => performance.now(),
  subscribeAccountChanges = onAccountChange,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console } = {}) {
  const connections = new Map();
  let stopped = false;
  let pollTimer;
  let syncing = false;
  let syncAgain = false;

  function projects() {
    const result = [];
    let configured;
    try { configured = getProjects() || []; } catch { return result; }
    for (const project of configured) {
      if (project.enabled !== true || !Number.isSafeInteger(project.deviceId) || project.deviceId <= 0) continue;
      try {
        const credentials = project.backend.getCredentials();
        const identity = accountIdentity(credentials);
        if (!identity || !Number.isSafeInteger(Number(credentials.projectId)) || Number(credentials.projectId) <= 0) continue;
        relayUrl(credentials.baseUrl, project.deviceId, instanceId);
        result.push({ ...project, ...credentials, projectId: Number(credentials.projectId),
          owner: JSON.stringify([identity, Number(credentials.projectId)]),
          key: `${identity}:${project.deviceId}` });
      } catch { /* Disabled, signed out, invalid target or account: no relay traffic. */ }
    }
    return result;
  }

  function sync() {
    if (stopped) return;
    // Legacy credential migration can publish a store change during getProjects().
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const groups = new Map();
        for (const project of projects()) {
          if (!groups.has(project.key)) groups.set(project.key, []);
          groups.get(project.key).push(project);
        }
        for (const [key, connection] of connections) {
          if (!groups.has(key)) { connection.close(); connections.delete(key); }
        }
        for (const [key, group] of groups) {
          let connection = connections.get(key);
          if (!connection) {
            connection = createConnection(key, group);
            connections.set(key, connection);
            connection.open();
          } else connection.update(group);
        }
      } while (syncAgain && !stopped);
    } finally { syncing = false; }
  }

  function createConnection(key, initialProjects) {
    // Distinct configured origins can be aliases of one API. They must not replace
    // each other's sockets there; reconnects of this group must retain their identity.
    const connectionInstanceId = createHash('sha256').update(JSON.stringify([instanceId, key])).digest('hex');
    let group = initialProjects;
    let socket = null;
    let ready = false;
    let closed = false;
    let halted = false;
    let retries = 0;
    let retryTimer;
    let flushTimer;
    let heartbeatTimer;
    let refreshTimer;
    let generation = 0;
    let allowed = new Set();
    let queue = [];
    let queuedBytes = 0;
    let windowAt = 0;
    let frames = 0;
    let outputBytes = 0;
    let limits = {};
    let refusal = null; // last logged HTTP refusal; every retry of a stuck proxy answers the same
    const attachments = new Map(); // run id -> Map(attachment id -> last input seq)
    const remoteControllers = new Map(); // explicit owner choice, released by local interaction
    const sequences = new Map();
    const commands = new Map(); // includes pending starts; never evict an unexpired receipt
    const reported = new Map();
    const started = new Set();

    const liveGroup = () => projects().filter(project => project.key === key);
    const signature = entries => JSON.stringify(entries.map(p => [p.projectPath, p.projectId, p.token, p.consentGrant]).sort());
    function currentGroup() {
      if (!ready || closed || halted) return false;
      if (signature(group) === signature(liveGroup())) return true;
      // Local consent may change in another process before its IPC/watch notification.
      // Invalidate queued starts, output and attachment authority at the actual boundary.
      disconnect();
      return false;
    }
    const authorized = project => currentGroup() && allowed.has(project.projectId)
      && group.some(p => p.projectPath === project.projectPath && p.projectId === project.projectId && p.consentGrant === project.consentGrant);
    const projectFor = session => currentGroup()
      ? group.find(p => p.projectPath === session.projectPath && p.owner === session._relayOwner && allowed.has(p.projectId)) : null;
    const sessions = () => [...getSessions().values()].filter(s => s.type === 'terminal' && s.taskId
      && (s.alive || s._starting || s._launching || s._queued) && !s._imageOperation && projectFor(s));
    const findSession = id => sessions().find(s => runId(s) === id);

    function resetStream() {
      ready = false;
      for (const receipt of commands.values()) cancelStart(receipt);
      clearTimer(flushTimer); clearTimer(heartbeatTimer); clearTimer(refreshTimer);
      flushTimer = heartbeatTimer = refreshTimer = null;
      attachments.clear(); sequences.clear(); reported.clear();
      remoteControllers.clear();
      queue = []; queuedBytes = 0;
    }

    function disconnect() {
      const ws = socket;
      socket = null; generation++; resetStream();
      // Detach callbacks before closing: a late ready/open/close belongs to this
      // old credential generation, even when the account identity is unchanged.
      ws?.close(1001, 'project_settings_changed');
      ws?.terminate();
      reconnect();
    }

    function scheduleFlush(delay = 10) {
      if (!flushTimer && ready) {
        const scheduledGeneration = generation;
        flushTimer = setTimer(() => {
          if (generation !== scheduledGeneration) return;
          flushTimer = null; flush();
        }, delay);
        flushTimer.unref?.();
      }
    }

    function send(frame, projectId = frame.project_id) {
      if (!currentGroup() || socket?.readyState !== 1) return;
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (queuedBytes + bytes > MAX_QUEUE_BYTES || queue.length >= 1024) {
        // The relay has no device-side output_gap frame. Reconnect resets attachments and
        // requests bounded replay, instead of silently corrupting the terminal stream.
        socket.close(1013, 'device_output_backpressure');
        resetStream();
        return;
      }
      queue.push({ frame, bytes, projectId }); queuedBytes += bytes;
      scheduleFlush();
    }

    function flush() {
      if (!currentGroup() || socket?.readyState !== 1) return;
      if (now() - windowAt >= 1100) { windowAt = now(); frames = 0; outputBytes = 0; }
      const frameBudget = Math.max(1, Math.floor(limits.frames_per_second * 0.8));
      const byteBudget = Math.max(4, Math.floor(limits.output_bytes_per_second * 0.8));
      while (queue.length && frames < frameBudget && socket.bufferedAmount < 256 * 1024) {
        if (!currentGroup()) return;
        const item = queue[0];
        const bytes = item.frame.type === 'output' ? Buffer.byteLength(item.frame.data) : 0;
        if (outputBytes + bytes > byteBudget) break;
        queue.shift(); queuedBytes -= item.bytes;
        try { socket.send(JSON.stringify(item.frame)); }
        catch { socket.terminate(); return; }
        frames++; outputBytes += bytes;
      }
      if (queue.length) scheduleFlush(frames >= frameBudget || outputBytes >= byteBudget ? 1100 : 50);
    }

    function output(session, text, attachmentId) {
      const id = runId(session);
      if (!projectFor(session) || !attachments.get(id)?.size) return;
      // Coalesce raw PTY writes before pacing; each frame remains within UTF-8 and JSON limits.
      const max = Math.max(4, Math.min(limits.max_output_data_bytes,
        Math.floor(limits.max_device_frame_bytes / 8), Math.floor(limits.output_bytes_per_second * 0.8)));
      let data = text;
      while (data) {
        const last = queue.at(-1);
        if (last?.frame.type === 'output' && last.frame.local_id === id
          && last.frame.attachment_id === attachmentId && Buffer.byteLength(last.frame.data) < max) {
          const head = utf8Head(data, max - Buffer.byteLength(last.frame.data));
          if (head) {
            queuedBytes -= last.bytes;
            last.frame.data += head;
            last.bytes = Buffer.byteLength(JSON.stringify(last.frame)); queuedBytes += last.bytes;
            data = data.slice(head.length);
            continue;
          }
        }
        const head = utf8Head(data, max);
        if (!head || !ready) break;
        const seq = (sequences.get(id) || 0) + 1;
        sequences.set(id, seq);
        const project = projectFor(session);
        if (!project) return;
        send({ type: 'output', local_id: id, seq, data: head, ...(attachmentId ? { attachment_id: attachmentId } : {}) }, project.projectId);
        data = data.slice(head.length);
      }
    }

    function report(session, state) {
      const project = projectFor(session);
      if (!project) return;
      const frame = { type: 'session', local_id: runId(session), project_id: project.projectId,
        task_key: session.taskId, state, agent: session.taskAgent,
        ...(state === 'exited' && Number.isSafeInteger(session.exitCode) ? { exit_code: session.exitCode } : {}) };
      const stamp = JSON.stringify(frame);
      if (reported.get(frame.local_id) === stamp) return;
      if (state !== 'exited' && !started.has(frame.local_id) && started.size >= Math.min(64, limits.max_sessions)) return;
      if (state !== 'exited') started.add(frame.local_id);
      else if (!started.has(frame.local_id)) return;
      reported.set(frame.local_id, stamp);
      send(frame);
      if (state === 'exited') { attachments.delete(frame.local_id); remoteControllers.delete(frame.local_id); sequences.delete(frame.local_id); reported.delete(frame.local_id); started.delete(frame.local_id); }
    }

    function controller(session) {
      const viewers = attachments.get(runId(session));
      const chosen = remoteControllers.get(runId(session));
      if (viewers?.has(chosen)) return chosen;
      return session.ws?.readyState === 1 ? 'local' : viewers?.keys().next().value || null;
    }

    function announceController(session) {
      if (attachments.get(runId(session))?.size) {
        send({ type: 'controller', local_id: runId(session), attachment_id: controller(session) }, projectFor(session)?.projectId);
      }
    }

    function approval(session) {
      if (!limits.approval_controls || !attachments.get(runId(session))?.size) return;
      send({ type: 'approval', local_id: runId(session), request: remoteApprovalRequest(session) }, projectFor(session)?.projectId);
    }

    function clearProjectStreams() {
      for (const receipt of commands.values()) {
        if (receipt.project && !authorized(receipt.project)) cancelStart(receipt);
      }
      for (const id of attachments.keys()) if (!findSession(id)) { attachments.delete(id); remoteControllers.delete(id); }
      for (const id of started) if (!findSession(id)) started.delete(id);
      queue = queue.filter(item => !item.projectId || allowed.has(item.projectId));
      queuedBytes = queue.reduce((sum, item) => sum + item.bytes, 0);
    }

    function finishStart(receipt, result) {
      clearTimer(receipt.expiryTimer);
      receipt.onCancel = null;
      if (receipt.cancelled && receipt.result?.ok === false) result = receipt.result;
      receipt.result = result;
      if (receipt.generation === generation) send({ type: 'command_result', command_id: receipt.id, ...result });
    }

    function cancelStart(receipt, code = 'remote_control_disabled') {
      if (!receipt.project || receipt.launched || receipt.cancelled) return;
      receipt.cancelled = true;
      receipt.authorization?.(false);
      const cancel = receipt.onCancel;
      finishStart(receipt, { ok: false, code });
      cancel?.(); // Only removes an unspawned run, never stops a running agent.
    }

    async function authorizeStart(receipt, current) {
      if (!limits.start_authorization || receipt.requested || receipt.cancelled || !current()) {
        throw Object.assign(new Error('Remote start authorization unavailable'), { code: 'EAUTH' });
      }
      receipt.requested = true;
      const deadline = monotonicNow() + START_AUTH_MS;
      const allowed = await new Promise(resolve => {
        const timer = setTimer(() => receipt.authorization?.(false), START_AUTH_MS);
        receipt.authorization = value => {
          clearTimer(timer); receipt.authorization = null; resolve(value);
        };
        send({ type: 'authorize_start', command_id: receipt.id });
      });
      // Returned closure is consumed synchronously next to pty.spawn, after every await.
      return () => {
        if (!allowed || receipt.launched || receipt.cancelled || !current() || monotonicNow() >= deadline) {
          throw Object.assign(new Error('Remote start authorization ended'), { code: 'EAUTH' });
        }
        receipt.launched = true;
        clearTimer(receipt.expiryTimer);
        receipt.onCancel = null;
      };
    }

    async function command(frame) {
      const commandGeneration = generation;
      const isCurrent = () => currentGroup() && generation === commandGeneration;
      if (!isCurrent()) return;
      if (!COMMANDS.includes(frame.action)) return;
      if (!['start', 'attach', 'stop', 'approve', 'take_control'].includes(frame.action)) {
        const session = findSession(frame.local_id);
        if (!session || !authorized(projectFor(session) || {})) return;
        const sessionIsCurrent = () => isCurrent() && authorized(projectFor(session) || {});
        const viewers = attachments.get(frame.local_id);
        if (frame.action === 'detach') {
          await handleCommand(frame, { session, isCurrent: sessionIsCurrent, detach() {
            viewers?.delete(frame.attachment_id);
            if (remoteControllers.get(frame.local_id) === frame.attachment_id) remoteControllers.delete(frame.local_id);
            announceController(session);
            dropOutput(frame.local_id, frame.attachment_id);
            if (!viewers?.size) dropOutput(frame.local_id);
          } });
        } else if (viewers?.has(frame.attachment_id) && controller(session) === frame.attachment_id) {
          if (frame.action === 'input' && Number.isSafeInteger(frame.seq) && frame.seq > viewers.get(frame.attachment_id)
            && typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 8192) {
            viewers.set(frame.attachment_id, frame.seq);
            await handleCommand(frame, { session, isCurrent: sessionIsCurrent });
          } else if (frame.action === 'resize' && Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows)
            && frame.cols > 0 && frame.rows > 0 && frame.cols <= 1000 && frame.rows <= 1000) {
            await handleCommand(frame, { session, isCurrent: sessionIsCurrent });
          }
        }
        return;
      }
      if (!/^[\w.:-]{8,64}$/.test(frame.command_id || '')) return;
      if (frame.action === 'start' && !group.some(p => p.projectId === frame.project_id && authorized(p))) {
        send({ type: 'command_result', command_id: frame.command_id, ok: false, code: 'project_not_allowed' });
        return;
      }
      for (const [id, receipt] of commands) if (receipt.result && receipt.until <= now()) commands.delete(id);
      const fingerprint = createHash('sha256').update(JSON.stringify([frame.action, frame.project_id,
        frame.task_key, frame.agent ?? null, frame.local_id, frame.attachment_id, frame.replay_bytes, frame.request_id, frame.allow])).digest('hex');
      const respond = result => { if (isCurrent()) send({ type: 'command_result', command_id: frame.command_id, ...result }); };
      const previous = commands.get(frame.command_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return respond({ ok: false, code: 'command_id_reused' });
        // Start/stop receipts survive API restarts. Attach must recreate a cleared stream
        // after reconnect, even if the relay reuses the command id.
        if (frame.action !== 'attach' || previous.generation === generation) {
          const result = previous.result || await previous.promise;
          return respond(previous.result || result); // Cancellation may have replaced the receipt during the await.
        }
        commands.delete(frame.command_id);
      }
      if (commands.size >= MAX_COMMANDS) return respond({ ok: false, code: 'device_busy' });
      const receipt = { id: frame.command_id, fingerprint, generation, until: now() + DEDUPE_MS };
      commands.set(frame.command_id, receipt);
      receipt.promise = (async () => {
        try {
          if (frame.action === 'start') {
            const project = group.find(p => p.projectId === frame.project_id && authorized(p));
            if (!project) return { ok: false, code: 'project_not_allowed' };
            if (sessions().length >= Math.min(64, limits.max_sessions)) return { ok: false, code: 'device_busy' };
            if (!limits.start_authorization) return { ok: false, code: 'authentication_required' };
            receipt.project = project;
            receipt.expiryTimer = setTimer(() => cancelStart(receipt), DEDUPE_MS);
            receipt.expiryTimer.unref?.();
            const current = () => isCurrent() && !receipt.cancelled && authorized(project);
            return await handleCommand(frame, { project, isCurrent: current,
              authorizeStart: () => authorizeStart(receipt, current),
              onCancel: callback => { receipt.onCancel = callback; if (receipt.cancelled) callback(); },
              finish: result => finishStart(receipt, result),
              report: session => report(session, session.alive ? 'running' : 'starting') });
          }
          const session = findSession(frame.local_id);
          if (!session || !authorized(projectFor(session) || {})) return { ok: false, code: 'session_not_found' };
          if (frame.action === 'take_control') {
            if (!limits.approval_controls || !attachments.get(frame.local_id)?.has(frame.attachment_id)) return { ok: false, code: 'not_attached' };
            remoteControllers.set(frame.local_id, frame.attachment_id);
            announceController(session);
            return { ok: true };
          }
          if (frame.action === 'approve') {
            if (!limits.approval_controls || !attachments.get(frame.local_id)?.has(frame.attachment_id)
              || typeof frame.allow !== 'boolean' || typeof frame.request_id !== 'string') return { ok: false, code: 'not_attached' };
            return await handleCommand(frame, { session, isCurrent: () => isCurrent() && authorized(projectFor(session) || {}) });
          }
          if (frame.action === 'stop') return await handleCommand(frame, { session, isCurrent: () => isCurrent() && authorized(projectFor(session) || {}) });
          return await handleCommand(frame, { session, isCurrent: () => isCurrent() && authorized(projectFor(session) || {}), attach() {
            if (!isCurrent() || !projectFor(session)) return { ok: false, code: 'session_not_found' };
            if (!/^att_[\w-]{1,64}$/.test(frame.attachment_id || '') || !session.alive) return { ok: false, code: 'session_not_found' };
            let viewers = attachments.get(frame.local_id);
            if (!viewers) { viewers = new Map(); attachments.set(frame.local_id, viewers); }
            if (!viewers.has(frame.attachment_id) && viewers.size >= 8) return { ok: false, code: 'too_many_attachments' };
            viewers.set(frame.attachment_id, 0);
            const replay = Number.isSafeInteger(frame.replay_bytes) ? Math.min(Math.max(0, frame.replay_bytes), limits.max_replay_bytes) : 0;
            // Queue success before replay. Other viewers never receive this attachment's history.
            respond({ ok: true, local_id: frame.local_id });
            announceController(session);
            approval(session);
            if (replay) output(session, utf8Tail(session.buffer, replay), frame.attachment_id);
            return { ok: true, local_id: frame.local_id };
          } });
        } catch (err) {
          return { ok: false, code: /^[a-z0-9_]{1,64}$/.test(err.code || '') ? err.code : 'command_failed' };
        }
      })();
      const result = await receipt.promise;
      receipt.result ||= result;
      if (receipt.result.code !== 'queued') { clearTimer(receipt.expiryTimer); receipt.onCancel = null; }
      if (frame.action !== 'attach' || !receipt.result.ok) respond(receipt.result);
    }

    function dropOutput(id, attachmentId) {
      queue = queue.filter(item => item.frame.type !== 'output' || item.frame.local_id !== id
        || (attachmentId && item.frame.attachment_id !== attachmentId));
      queuedBytes = queue.reduce((sum, item) => sum + item.bytes, 0);
    }

    function touchHeartbeat() {
      clearTimer(heartbeatTimer);
      const ws = socket;
      heartbeatTimer = setTimer(() => { if (socket === ws) ws?.terminate(); }, Math.min(600000, limits.expiry_ms || 180000));
      heartbeatTimer.unref?.();
    }

    async function renew() {
      const project = liveGroup()[0];
      if (!project) return false;
      try { await refreshToken({ ...project, projectRoot: project.projectPath }); return true; }
      catch { return false; } // No token values or URLs in logs.
    }

    function reconnect(delay) {
      if (closed || halted || retryTimer) return;
      const backoff = delay ?? Math.min(60000, 1000 * 2 ** Math.min(retries++, 6));
      retryTimer = setTimer(() => { retryTimer = null; open(); }, backoff * (0.75 + random() * 0.5));
      retryTimer.unref?.();
    }

    function open() {
      if (closed || halted) return;
      group = liveGroup();
      const project = group[0];
      if (!project) return;
      let ws;
      try {
        ws = new WebSocketImpl(relayUrl(project.baseUrl, project.deviceId, connectionInstanceId), 'tipatask-relay.v1', {
          headers: { Authorization: `Bearer ${project.token}` }, perMessageDeflate: false,
          handshakeTimeout: 10000, maxPayload: 262144, followRedirects: false,
        });
      } catch { reconnect(); return; }
      socket = ws;
      generation++;
      const socketGeneration = generation;
      const currentSocket = () => socket === ws && generation === socketGeneration && !closed;
      let renewOnClose = false;
      ws.on('error', () => {}); // close owns retry; never log headers or credential-bearing errors
      ws.on('open', () => {
        if (!currentSocket()) return;
        heartbeatTimer = setTimer(() => ws.terminate(), 10000);
        heartbeatTimer.unref?.();
      });
      ws.on('unexpected-response', (_request, response) => {
        const status = response.statusCode;
        response.resume();
        if (!currentSocket()) return;
        if (refusal !== status) {
          refusal = status;
          let origin = 'the API';
          try { origin = new URL(project.baseUrl).origin; } catch { /* relayUrl() accepted it */ }
          log.warn(refusalText(origin, status)); // Status and origin only: never headers or the URL query.
        }
        if (status === 401 || status === 403) halted = true;
        renewOnClose = status === 401;
        ws.terminate();
      });
      ws.on('ping', () => { if (currentSocket()) touchHeartbeat(); }); // ws answers automatically
      ws.on('message', (raw, binary) => {
        if (!currentSocket() || halted) return;
        let frame;
        try {
          if (binary) throw new Error();
          frame = JSON.parse(raw.toString());
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
        } catch { ws.close(4400, 'invalid_frame'); return; }
        touchHeartbeat();
        if (frame.type === 'ready' && !ready) {
          if (frame.protocol !== 1 || !Array.isArray(frame.project_ids) || !frame.limits) { ws.close(4400, 'unsupported_protocol'); return; }
          limits = { ...frame.limits, expiry_ms: frame.expiry_ms, approval_controls: frame.approval_controls === true,
            start_authorization: frame.start_authorization === true };
          for (const name of ['frames_per_second', 'output_bytes_per_second', 'max_output_data_bytes', 'max_device_frame_bytes', 'max_replay_bytes', 'max_sessions']) {
            if (!Number.isSafeInteger(limits[name]) || limits[name] < 8) { ws.close(4400, 'invalid_limits'); return; }
          }
          allowed = new Set(frame.project_ids);
          ready = true; retries = 0; refusal = null; windowAt = now(); frames = 1; outputBytes = 0;
          started.clear();
          // A hello is bounded by both max_sessions and the complete JSON frame size.
          const reports = [];
          const hello = { type: 'hello', protocol: 1, project_ids: [...new Set(group.map(p => p.projectId))],
            capabilities: { agents: ['claude', 'codex', 'pi'], commands: COMMANDS.filter(action => !['approve', 'take_control'].includes(action) || limits.approval_controls),
              task_kinds: [...TASK_KINDS], platform: process.platform }, sessions: reports };
          for (const session of sessions()) {
            if (reports.length >= Math.min(64, limits.max_sessions)) break;
            const p = projectFor(session);
            if (!p) return;
            const reportFrame = { local_id: runId(session), project_id: p.projectId, task_key: session.taskId,
              state: session.alive ? 'running' : 'starting', agent: session.taskAgent };
            reports.push(reportFrame);
            if (Buffer.byteLength(JSON.stringify(hello)) > limits.max_device_frame_bytes) { reports.pop(); break; }
            started.add(reportFrame.local_id);
            reported.set(reportFrame.local_id, JSON.stringify({ type: 'session', ...reportFrame }));
          }
          if (!currentGroup()) return;
          ws.send(JSON.stringify(hello));
          touchHeartbeat();
          // Renew before expiry while the current token can still authorize renewal.
          try {
            const exp = JSON.parse(Buffer.from(project.token.split('.')[1], 'base64url')).exp * 1000;
            if (Number.isFinite(exp)) {
              refreshTimer = setTimer(async () => {
                if (await renew() && currentSocket()) disconnect();
              }, Math.max(1000, Math.min(2147483647, exp - now() - 5 * 60000)));
              refreshTimer.unref?.();
            }
          } catch { /* credential resolver handles malformed tokens */ }
        } else if (ready && frame.type === 'command') {
          command(frame).catch(() => { /* commands fail closed */ });
        } else if (ready && frame.type === 'command_cancelled') {
          const receipt = commands.get(frame.command_id);
          if (receipt?.generation === generation) cancelStart(receipt);
        } else if (ready && frame.type === 'start_authorization') {
          const receipt = commands.get(frame.command_id);
          if (receipt?.generation === generation) receipt.authorization?.(frame.allowed === true);
        } else if (ready && frame.type === 'projects') {
          allowed = new Set(Array.isArray(frame.project_ids) ? frame.project_ids : []);
          clearProjectStreams();
        } else if (ready && frame.type === 'stream_stop') {
          attachments.delete(frame.local_id); dropOutput(frame.local_id);
        }
      });
      ws.on('close', code => {
        if (!currentSocket()) return;
        generation++; resetStream(); socket = null;
        if ([4403, 4409, 4400, 1009].includes(code)) halted = true;
        if (code === 4401 || renewOnClose) {
          halted = true;
          retryRenewal();
        } else reconnect(code === 4429 ? 60000 : undefined);
      });
    }

    function retryRenewal() {
      const renewingGeneration = generation;
      renew().then(ok => {
        if (ok && !closed && generation === renewingGeneration) { halted = false; reconnect(); }
      });
    }

    return {
      open,
      update(next) {
        const changed = signature(group) !== signature(next);
        group = next;
        if (changed) {
          halted = false;
          disconnect();
        } else clearProjectStreams();
      },
      state(session, state) { if (ready) report(session, state); },
      output(session, data) { if (ready && projectFor(session)) output(session, data); },
      local(session) { if (ready && projectFor(session)) { remoteControllers.delete(runId(session)); announceController(session); } },
      approval(session) { if (ready && projectFor(session)) approval(session); },
      close() {
        closed = true; generation++; clearTimer(retryTimer); resetStream();
        commands.clear(); started.clear(); allowed.clear();
        if (socket) { const ws = socket; socket = null; ws.close(1001, 'remote_control_disabled'); ws.terminate(); }
      },
    };
  }

  const onState = (session, state) => { for (const connection of connections.values()) connection.state(session, state); };
  const onOutput = (session, data) => { for (const connection of connections.values()) connection.output(session, data); };
  const onLocal = session => { for (const connection of connections.values()) connection.local(session); };
  const onApproval = session => { for (const connection of connections.values()) connection.approval(session); };
  events.on('state', onState); events.on('output', onOutput); events.on('local', onLocal);
  events.on('approval', onApproval);
  events.on('config', sync);
  const stopAccountWatch = subscribeAccountChanges(sync);
  const poll = () => { sync(); if (!stopped) { pollTimer = setTimer(poll, pollMs); pollTimer.unref?.(); } };
  poll();
  return {
    sync,
    close() {
      stopped = true; clearTimer(pollTimer);
      stopAccountWatch();
      events.off('state', onState); events.off('output', onOutput); events.off('local', onLocal);
      events.off('approval', onApproval);
      events.off('config', sync);
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}

module.exports = { connectDeviceRelay, terminalEvents, runId, captureSessionOwner, accountIdentity, utf8Tail, relayUrl, remoteApprovalRequest, isTerminalReport,
  OBJECTIVE_TASK_KIND, TASK_KINDS };
