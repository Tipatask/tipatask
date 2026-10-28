'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CodexLivePty, supported, rolloutState, trackRollout } = require('./codex-live-mode');
const CodexAgent = require('./codex-agent');
const { getTaskAgent } = require('./index');
const { createSession } = require('../session-state');
const { buildPermissionPolicy } = require('../permission-policy');
const { requestPermissionMode, emitTerminalState, handleTerminalInput } = require('../terminal-session');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = '11111111-2222-4333-8444-555555555555';

function fixture(t, from, to, { hold = false, running = false } = {}) {
  const agent = getTaskAgent('codex');
  const prepare = agent.prepareKickoff.bind(agent);
  t.mock.method(agent, 'prepareKickoff', (cfg, prompt, task) => prepare(cfg, prompt, task, { isWin: false }));
  t.mock.method(agent, 'wrapsBracketedPaste', () => true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '.codex');
  const date = new Date();
  const dir = path.join(home, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  const file = path.join(dir, `rollout-${date.toISOString().slice(0, 10)}-${id}.jsonl`);
  const append = (type, payload) => fs.appendFileSync(file, JSON.stringify({ type, payload }) + '\n');
  append('session_meta', { id, cwd: root, timestamp: date.toISOString() });
  append('event_msg', { type: 'user_message', message: 'Work on task TPT9137' });
  append('event_msg', { type: 'task_started' });
  const triple = mode => ({ approval_policy: mode === 'bypass' ? 'never' : 'on-request',
    approvals_reviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox_policy: { type: mode === 'bypass' ? 'danger-full-access' : 'workspace-write' } });
  append('turn_context', triple(from));
  const settings = mode => ({ ...triple(mode), permission_profile: mode === 'bypass' ? { type: 'disabled' }
    : { type: 'managed', file_system: { type: 'restricted' }, network: 'restricted' } });
  append('event_msg', { type: 'thread_settings_applied', thread_settings: settings(from) });
  if (running) append('event_msg', { type: 'exec_command_begin', call_id: 'running' });
  else append('event_msg', { type: 'task_complete' });
  const frames = [];
  const ws = { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  const session = createSession(ws, false, 'TPT9137', root);
  Object.assign(session, { alive: true, taskId: 'TPT9137', taskAgent: 'codex', _injectDone: true,
    terminalPhase: from === 'plan' ? 'planning' : 'executing',
    permissionPolicy: buildPermissionPolicy({ mode: from, source: 'task' }, 'codex'),
    permissionMode: { requested: from, confirmed: from, pending: false, error: null },
    _transcriptHint: { taskId: 'TPT9137', cwd: root, spawnedAt: date.getTime() - 1000, env: { CODEX_HOME: home } },
    descendantWatchdog: { pid: 1 } });
  let pid = 100;
  class Pty {
    constructor() { this.pid = pid++; this.events = new EventEmitter(); this.writes = []; this.composer = ''; }
    onData(fn) { this.events.on('data', fn); }
    onExit(fn) { this.events.on('exit', event => { this.exited = true; fn(event); }); }
    out(data) { this.events.emit('data', data); }
    write(data) {
      this.writes.push(data);
      if (data.startsWith('\x15')) this.composer = data.slice(1);
      else if (data.startsWith('\x1b[200~')) this.composer = data.slice(6, -6);
      else if (data === '\r') {
        if (this.composer === '/quit') this.events.emit('exit', { exitCode: 0 });
        else if (this.composer === '/status') {
          this.out('\r\n• Permission selection requested: Full Access\r\n');
          if (!hold) this.out(`\r\n  Permissions: ${to === 'auto' ? 'Approve for me' : 'Full Access'}\r\n`);
        } else if (this.composer.includes('The user selected')) {
          append('event_msg', { type: 'user_message', message: this.composer });
          append('turn_context', triple(to));
        } else this.onSubmit?.(this.composer);
        this.composer = '';
      } else this.composer += data;
    }
    resize() {}
    kill() { this.events.emit('exit', { exitCode: 1 }); }
  }
  const children = [];
  const specs = [];
  const spec = { command: 'codex', args: ['--no-daemon'], cwd: root, env: { CODEX_HOME: home },
    codexSwitch: { baseHome: home, effort: 'low' } };
  const native = new Pty();
  const wrapper = new CodexLivePty(native, { session, version: '0.164.0', spec, waitMs: 2000,
    spawn(command, args, opts) {
      specs.push({ command, args, opts });
      const child = new Pty(); children.push(child);
      setTimeout(() => {
        if (child.exited) return;
        const mode = /approvals_reviewer="auto_review"/.test(args.join(' ')) ? 'auto'
          : /sandbox_mode="danger-full-access"/.test(args.join(' ')) ? 'bypass' : 'plan';
        append('event_msg', { type: 'thread_settings_applied', thread_settings: settings(mode) });
        child.out('GPT-6.1-Sol low · scratch');
      }, 10);
      return child;
    } });
  session.pty = wrapper;
  return { session, wrapper, native, children, specs, frames, file, append, sessions: new Map([['key', session]]) };
}

test('stub PTY: all four transitions stay pending until native confirmation and directive acceptance; reconnect retains policy', async t => {
  for (const [from, to] of [['plan', 'auto'], ['plan', 'bypass'], ['auto', 'bypass'], ['bypass', 'auto']]) {
    const f = fixture(t, from, to, { hold: true });
    let exits = 0;
    f.wrapper.onExit(() => exits++);
    const result = requestPermissionMode('key', to, f.sessions);
    while (!f.children[0]?.writes.includes('\r') || !f.children[0].writes.some(s => s.includes('/status'))) await sleep(10);
    assert.equal(f.session.permissionMode.pending, true);
    assert.equal(f.session.permissionMode.confirmed, from);
    handleTerminalInput(f.session, 'y\r');
    assert.equal(f.children[0].writes.includes('y\r'), false, 'old native approval cannot be answered while pending');
    f.children[0].out(`\r\n  Permissions: ${to === 'auto' ? 'Approve for me' : 'Full Access'}\r\n`);
    assert.equal((await result).confirmed, to);
    assert.equal(exits, 0, 'replacement is not a task exit');
    assert.equal(f.session.pty, f.wrapper);
    assert.equal(f.session.ptyPid, f.children[0].pid);
    assert.equal(f.session.descendantWatchdog.pid, f.children[0].pid);
    assert.deepEqual(f.specs[0].args.slice(0, 2), ['resume', id]);
    const overrides = f.specs[0].args.join(' ');
    assert.match(overrides, new RegExp(`sandbox_mode="${to === 'auto' ? 'workspace-write' : 'danger-full-access'}"`));
    assert.match(overrides, new RegExp(`approvals_reviewer="${to === 'auto' ? 'auto_review' : 'user'}"`));
    assert.match(fs.readFileSync(f.file, 'utf8'), /does not cancel or reverse/);
    emitTerminalState(f.session);
    assert.equal(f.frames.at(-1).permissionModeState.confirmed, to);
    assert.equal(f.frames.at(-1).permissionModeState.pending, false);
  }
});

test('running command finishes before quit; a native approval is rejected only with no running commands', async t => {
  const f = fixture(t, 'plan', 'auto', { running: true });
  f.session._attentionState = { kind: 'toolApproval' };
  f.native.out('\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\');
  const result = requestPermissionMode('key', 'auto', f.sessions);
  await sleep(200);
  assert.deepEqual(f.native.writes, [], 'neither Esc nor quit interrupts a running command');
  f.append('event_msg', { type: 'exec_command_end', call_id: 'running' });
  await sleep(200);
  assert.deepEqual(f.native.writes, ['\x1b']);
  f.append('event_msg', { type: 'turn_aborted' });
  assert.equal((await result).confirmed, 'auto');
  assert.match(fs.readFileSync(f.file, 'utf8'), /obtain fresh approval/);
});

test('unconfirmed resumed preset rolls back exact prior configuration without changing confirmed mode', async t => {
  const f = fixture(t, 'bypass', 'auto', { hold: true });
  const until = f.wrapper.until.bind(f.wrapper);
  f.wrapper.until = (check, timeout) => until(check, Math.min(timeout || 1000, 1000));
  const state = await requestPermissionMode('key', 'auto', f.sessions);
  assert.equal(state.error.reason, 'unconfirmed');
  assert.equal(state.confirmed, 'bypass');
  assert.equal(f.specs.length, 2);
  assert.deepEqual(f.specs[1].args.slice(0, 3), ['resume', id, '--no-daemon']);
  assert.match(f.specs[1].args.join(' '), /approvals_reviewer="user"/);
  assert.match(f.specs[1].args.join(' '), /sandbox_mode="danger-full-access"/);
  assert.equal(f.session.alive, true);
});

test('unknown or older CLI and unwrapped PTYs cannot offer live switching; incomplete rollout fails closed', async t => {
  const f = fixture(t, 'plan', 'auto');
  const agent = new CodexAgent();
  for (const version of [null, '0.163.0']) {
    f.wrapper.version = version;
    assert.equal(supported(f.session), false);
    assert.deepEqual(await agent.switchPermissionMode(f.session, 'auto'), { supported: false });
  }
  assert.equal(supported({ pty: {} }), false);
  assert.deepEqual(rolloutState('garbled\n'), { ended: false, canRejectApproval: false });
});

test('code-mode rollout replay holds concurrent calls and yielded jobs until their matching completion', () => {
  const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const start = row('event_msg', { type: 'task_started' });
  const call = (id, input = 'await tools.exec_command({cmd:"echo test"});') =>
    row('response_item', { type: 'custom_tool_call', call_id: id, name: 'exec', input });
  const output = (id, output) => row('response_item', { type: 'custom_tool_call_output', call_id: id, output });
  const end = row('event_msg', { type: 'task_complete' });
  assert.equal(rolloutState(start + call('one')).canRejectApproval, true);
  assert.equal(rolloutState(start + call('one') + call('two')).canRejectApproval, false);
  assert.equal(rolloutState(start + call('one', 'await Promise.all([tools.exec_command({})]);')).canRejectApproval, false);
  const yielded = start + call('one') + output('one', 'Script completed\n{"session_id":123}') + end;
  assert.equal(rolloutState(yielded).ended, false);
  const unrelated = yielded + call('two') + output('two', 'Script completed');
  assert.equal(rolloutState(unrelated + end).ended, false, 'another completed command cannot clear the background job');
  const finished = unrelated + call('three', 'await tools.write_stdin({session_id:123});')
    + output('three', 'Script completed\nProcess exited with code 0') + end;
  assert.equal(rolloutState(finished).ended, true);
});

test('a resumed CLI startup failure restores the old run instead of publishing a terminal exit', async t => {
  const f = fixture(t, 'auto', 'bypass');
  const spawn = f.wrapper.spawn;
  f.wrapper.spawn = (...args) => {
    const child = spawn(...args);
    if (f.specs.length === 1) setTimeout(() => child.events.emit('exit', { exitCode: 1 }), 5);
    return child;
  };
  let exits = 0;
  f.wrapper.onExit(() => exits++);
  const state = await requestPermissionMode('key', 'bypass', f.sessions);
  assert.equal(state.confirmed, 'auto');
  assert.equal(state.error.reason, 'session_changed');
  assert.equal(f.specs.length, 2);
  assert.equal(f.session.alive, true);
  assert.equal(exits, 0);
});

test('incremental rollout tracking remembers old background work beyond a megabyte and handles partial rows', t => {
  const f = fixture(t, 'auto', 'bypass');
  f.append('response_item', { type: 'custom_tool_call', call_id: 'background', name: 'exec', input: 'await tools.exec_command({});' });
  f.append('response_item', { type: 'custom_tool_call_output', call_id: 'background', output: 'Script completed\n{"session_id":123}' });
  f.append('response_item', { type: 'message', role: 'assistant', content: [{ text: 'ї'.repeat(600000) }] });
  const tracker = trackRollout(f.file);
  assert.equal(tracker.poll().ended, false);
  assert.equal(tracker.state.id, id);
  fs.appendFileSync(f.file, '{"type":"event_msg",');
  assert.equal(tracker.poll().ended, false);
  fs.appendFileSync(f.file, '"payload":{"type":"task_complete"}}\n');
  assert.equal(tracker.poll().ended, false, 'turn end cannot discard a known background job');
  f.append('response_item', { type: 'custom_tool_call', call_id: 'wait', name: 'exec', input: 'await tools.write_stdin({session_id:123});' });
  f.append('response_item', { type: 'custom_tool_call_output', call_id: 'wait', output: 'Script completed\nProcess exited with code 0' });
  assert.equal(tracker.poll().ended, true);
});

test('Windows short handoff remains pending until the full directive is read under the confirmed native policy', async t => {
  const f = fixture(t, 'auto', 'bypass');
  const agent = getTaskAgent('codex');
  let directive;
  t.mock.method(agent, 'prepareKickoff', (cfg, text) => {
    directive = text;
    return { initialPrompt: 'Read mode directive file.', kickoffTypedLine: ' Begin.', kickoffFile: 'mode.md' };
  });
  t.mock.method(agent, 'wrapsBracketedPaste', () => false);
  const spawn = f.wrapper.spawn;
  f.wrapper.spawn = (...args) => {
    const child = spawn(...args);
    child.onSubmit = text => {
      f.append('response_item', { type: 'message', role: 'user', content: [{ text }] });
      f.append('turn_context', { approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' } });
    };
    return child;
  };
  const result = requestPermissionMode('key', 'bypass', f.sessions);
  while (!fs.readFileSync(f.file, 'utf8').includes('Read mode directive file. Begin.')) await sleep(10);
  assert.equal(f.session.permissionMode.pending, true);
  assert.equal(f.session.permissionMode.confirmed, 'auto');
  assert.equal(f.children[0].writes.some(text => text.includes('\x1b[200~')), false);
  for (const line of directive.split('\n')) {
    f.append('response_item', { type: 'custom_tool_call_output', output: `1: ${line}` });
  }
  assert.equal((await result).confirmed, 'bypass');
});

test('native permission state clears on working output and cannot be forged by a quoted dialog row', t => {
  const f = fixture(t, 'plan', 'auto');
  f.native.out('Would you like to run the following command?');
  assert.equal(f.wrapper.nativeApprovalPending(), false);
  f.native.out('\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\');
  assert.equal(f.wrapper.nativeApprovalPending(), true);
  f.native.out('\x1b]7501;state=working:app=codex\x1b\\');
  assert.equal(f.wrapper.nativeApprovalPending(), false);
});
