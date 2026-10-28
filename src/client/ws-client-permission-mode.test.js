import test from 'node:test';
import assert from 'node:assert/strict';

// (TPT9139) requestPermissionMode() / applyPermissionModeChanged(): the terminal's socket carries
// the request, the request reads as pending at once, and only a server frame changes `confirmed`.
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
}
globalThis.WebSocket = Socket;
const { default: state } = await import('./state.js');
const { bindSessionSocket, requestPermissionMode, applyPermissionModeChanged, WS_SEND_TYPES, WS_RECV_TYPES } = await import('./ws-client.js');

const RUN = 1790780000000;

function seed(id, permissionMode, extra = {}) {
  state.sessionMeta.set(id, { agent: 'claude', type: 'terminal', alive: true, startedAt: RUN, permissionMode, ...extra });
}

test('frame types are the server contract', () => {
  assert.equal(WS_SEND_TYPES.SESSION_PERMISSION_MODE, 'session:permission-mode');
  assert.equal(WS_RECV_TYPES.SESSION_PERMISSION_MODE_CHANGED, 'session:permission-mode-changed');
});

test('requestPermissionMode sends on the bound socket and records only a pending request', () => {
  seed('T1', { requested: 'plan', confirmed: 'plan', pending: false, error: null, supported: true });
  assert.deepEqual(requestPermissionMode('T1', 'bypass'), { ok: false, reason: 'offline' }, 'no terminal socket yet');
  const ws = new Socket();
  const unbind = bindSessionSocket('T1', ws);
  const result = requestPermissionMode('T1', 'bypass');
  assert.equal(result.ok, true);
  assert.deepEqual(ws.sent, [{ type: 'session:permission-mode', mode: 'bypass' }]);
  const meta = state.sessionMeta.get('T1');
  assert.deepEqual(meta.permissionMode, { requested: 'bypass', confirmed: 'plan', pending: true, error: null, supported: true });
  assert.deepEqual(result.state, meta.permissionMode);
  assert.equal(meta.agent, 'claude', 'the rest of the session row is kept');
  assert.deepEqual(requestPermissionMode('T1', 'auto'), { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 1, 'a pending request blocks a second one');
  unbind();
  assert.deepEqual(requestPermissionMode('T1', 'auto'), { ok: false, reason: 'busy' });
});

test('requestPermissionMode refuses Plan, unknown targets, the current mode and a closed or unbound socket without sending', () => {
  seed('T2', { requested: 'auto', confirmed: 'auto', pending: false, error: null, supported: true });
  const ws = new Socket();
  const unbind = bindSessionSocket('T2', ws);
  assert.deepEqual(requestPermissionMode('T2', 'plan'), { ok: false, reason: 'plan_target' });
  assert.deepEqual(requestPermissionMode('T2', 'yolo'), { ok: false, reason: 'invalid_target' });
  assert.deepEqual(requestPermissionMode('T2', 'auto'), { ok: false, reason: 'unchanged' });
  ws.readyState = 3;
  assert.deepEqual(requestPermissionMode('T2', 'bypass'), { ok: false, reason: 'offline' });
  assert.deepEqual(ws.sent, []);
  assert.equal(state.sessionMeta.get('T2').permissionMode.pending, false);
  // A reconnect binds its new socket; the old socket's late unbind must not drop it.
  const next = new Socket();
  bindSessionSocket('T2', next);
  unbind();
  assert.equal(requestPermissionMode('T2', 'bypass').ok, true);
  assert.deepEqual(next.sent, [{ type: 'session:permission-mode', mode: 'bypass' }]);
});

test('applyPermissionModeChanged updates the session row from the frame and ignores other frames and earlier runs', () => {
  seed('T3', { requested: 'bypass', confirmed: 'plan', pending: true, error: null, supported: true }, { paused: null, label: 'Claude Code' });
  assert.equal(applyPermissionModeChanged({ type: 'terminal-state', taskId: 'T3', confirmed: 'auto' }), null);
  assert.equal(applyPermissionModeChanged({ type: 'session:permission-mode-changed', confirmed: 'auto' }), null, 'no task id');
  const confirmed = applyPermissionModeChanged({ type: 'session:permission-mode-changed', taskId: 'T3', tabId: 'T3', startedAt: RUN,
    requested: 'bypass', confirmed: 'bypass', pending: false, error: null, supported: true });
  assert.deepEqual(confirmed, { requested: 'bypass', confirmed: 'bypass', pending: false, error: null, supported: true });
  const meta = state.sessionMeta.get('T3');
  assert.deepEqual(meta.permissionMode, confirmed);
  assert.equal(meta.label, 'Claude Code');
  assert.equal(meta.startedAt, RUN);

  assert.equal(applyPermissionModeChanged({ type: 'session:permission-mode-changed', taskId: 'T3', startedAt: RUN - 1,
    requested: 'auto', confirmed: 'plan', pending: false, error: null, supported: true }), null, 'an earlier run never overwrites');
  assert.equal(state.sessionMeta.get('T3').permissionMode.confirmed, 'bypass');

  const failed = applyPermissionModeChanged({ type: 'session:permission-mode-changed', taskId: 'T3', startedAt: RUN,
    requested: 'auto', confirmed: 'bypass', pending: false, supported: true,
    error: { code: 'EPERMISSION_MODE', reason: 'unconfirmed', message: 'The provider did not confirm the requested permission mode.' } });
  assert.equal(failed.confirmed, 'bypass', 'a failure keeps the confirmed mode');
  assert.equal(failed.error.reason, 'unconfirmed');

  const relaunched = applyPermissionModeChanged({ type: 'session:permission-mode-changed', taskId: 'T3', startedAt: RUN + 5,
    requested: 'plan', confirmed: 'plan', pending: false, error: null, supported: false });
  assert.equal(relaunched.confirmed, 'plan');
  assert.equal(state.sessionMeta.get('T3').startedAt, RUN + 5, 'a newer run takes over the row');

  assert.equal(applyPermissionModeChanged({ type: 'session:permission-mode-changed', taskId: 'T4', requested: 'auto',
    confirmed: 'auto', pending: false, error: null, supported: true }).confirmed, 'auto', 'a first frame creates the row');
});
