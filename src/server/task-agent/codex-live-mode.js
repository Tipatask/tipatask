'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { codexTerminalLaunchOptions, policyToCodexConfig } = require('../codex-env');
const { tomlValue } = require('../../codex-mcp-config');
const { modeSwitchError, versionAtLeast } = require('../permission-policy');
const { matchCodexPermissionLine } = require('../plan-approval-detect');
const { locateCodexRollout } = require('./final-message');
const { CODEX_COMPOSER_READY_RE } = require('./prompt-detect');

const SWITCH_VERSION = [0, 164, 0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function newRolloutState() {
  return { ended: false, sawStart: false, commands: new Set(), calls: new Map(), background: new Set(),
    policy: null, id: null, settings: null, settingsRevision: 0 };
}

function feedRollout(state, text) {
  const { commands, calls, background } = state;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    if (row.type === 'session_meta') state.id = p.id;
    if (row.type === 'turn_context') state.policy = p;
    if (row.type === 'response_item') {
      if (p.type === 'custom_tool_call' || p.type === 'function_call') calls.set(p.call_id, p);
      if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const call = calls.get(p.call_id);
        calls.delete(p.call_id);
        // Yielded jobs can outlive a turn. Only their own completed wait clears them.
        const output = String(p.output);
        for (const m of output.matchAll(/(?:Process running with session ID|"session_id"\s*:)\s*(\d+)|Script running with cell ID\s+(\S+)/g)) {
          background.add(m[1] ? `session:${m[1]}` : `cell:${m[2]}`);
        }
        if (/Process exited with code|Script completed/.test(output) && !/Process running with session ID|Script running with cell ID|"session_id"\s*:\s*\d+/.test(output)) {
          const input = call?.input || call?.arguments || '';
          for (const m of input.matchAll(/(?:session_id["']?\s*:\s*(\d+)|cell_id["']?\s*:\s*["']([^"']+)["'])/g)) {
            background.delete(m[1] ? `session:${m[1]}` : `cell:${m[2]}`);
          }
        }
      }
    }
    if (row.type !== 'event_msg') continue;
    if (p.type === 'thread_settings_applied') { state.settings = p.thread_settings; state.settingsRevision++; }
    if (p.type === 'task_started') { state.ended = false; state.sawStart = true; }
    if (p.type === 'task_complete' || p.type === 'turn_aborted') state.ended = true;
    if (p.type === 'exec_command_begin') commands.add(p.call_id);
    if (p.type === 'exec_command_end') commands.delete(p.call_id);
  }
}

function summarizeRollout({ ended, sawStart, commands, calls, background }) {
  const call = calls.size === 1 ? [...calls.values()][0] : null;
  const singleCommand = call && (call.name === 'exec_command' || (call.name === 'exec'
    && (call.input?.match(/tools\.\w+\s*\(/g) || []).length === 1
    && !/Promise\.|\b(?:for|while)\s*\(|\bfunction\b|=>|setTimeout/.test(call.input)
    && /tools\.exec_command\s*\(/.test(call.input)));
  return { ended: ended && commands.size === 0 && calls.size === 0 && background.size === 0,
    canRejectApproval: sawStart && !ended && commands.size === 0 && background.size === 0
      && (calls.size === 0 || !!singleCommand) };
}

function rolloutState(text) {
  const state = newRolloutState();
  feedRollout(state, text);
  return summarizeRollout(state);
}

// Read once from the beginning, then only appended bytes. Old background jobs and
// pending calls remain known even after their records fall outside a bounded tail.
function trackRollout(file) {
  const state = newRolloutState();
  let offset = 0;
  let carry = '';
  const decoder = new StringDecoder('utf8');
  return {
    state,
    poll() {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) throw modeSwitchError('unconfirmed');
        while (offset < size) {
          const bytes = Buffer.alloc(Math.min(65536, size - offset));
          const read = fs.readSync(fd, bytes, 0, bytes.length, offset);
          if (!read) break;
          offset += read;
          carry += decoder.write(bytes.subarray(0, read));
          const end = carry.lastIndexOf('\n');
          if (end >= 0) { feedRollout(state, carry.slice(0, end)); carry = carry.slice(end + 1); }
          if (carry.length > 4 * 1024 * 1024) throw modeSwitchError('unconfirmed');
        }
      } finally { fs.closeSync(fd); }
      return summarizeRollout(state);
    },
  };
}

function lastTurnPolicy(text) {
  let policy;
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'turn_context') policy = row.payload;
    } catch { /* partial row */ }
  }
  return policy;
}

function policyMatches(text, mode) {
  const actual = lastTurnPolicy(text);
  const expected = policyToCodexConfig(mode);
  return actual?.approval_policy === expected.approval_policy
    && actual.approvals_reviewer === expected.approvals_reviewer
    && actual.sandbox_policy?.type === expected.sandbox_mode;
}

function settingsMatch(actual, expected) {
  if (actual?.approval_policy !== expected?.approval_policy
    || actual?.approvals_reviewer !== expected?.approvals_reviewer) return false;
  return expected.sandbox_mode === 'danger-full-access'
    ? actual.permission_profile?.type === 'disabled'
    : actual.permission_profile?.type === 'managed'
      && actual.permission_profile.file_system?.type === 'restricted'
      && actual.permission_profile.network === 'restricted';
}

// Keep the public PTY identity stable across an idle /quit + resume. Existing terminal
// listeners, input epoch guards and reconnect buffers continue to own the same run.
class CodexLivePty {
  constructor(native, { spawn, spec, session, version, waitMs = 300000 }) {
    Object.assign(this, { spawn, spec, session, version, waitMs });
    this.events = new EventEmitter();
    this.replacing = false;
    this.output = '';
    this.bind(native);
  }
  get pid() { return this.native.pid; }
  write(data) { return this.native.write(data); }
  resize(cols, rows) { return this.native.resize(cols, rows); }
  kill(signal) { return this.native.kill(signal); }
  onData(fn) { this.events.on('data', fn); return { dispose: () => this.events.off('data', fn) }; }
  onExit(fn) { this.events.on('exit', fn); return { dispose: () => this.events.off('exit', fn) }; }
  bind(native) {
    this.native = native;
    this.exited = false;
    this.output = '';
    native.onData(data => {
      if (this.native !== native) return;
      this.output = (this.output + data).slice(-65536);
      this.events.emit('data', data);
    });
    native.onExit(event => {
      if (this.native !== native) return;
      this.exited = true;
      this.lastExit = event;
      if (!this.replacing && !this.switching) this.events.emit('exit', event);
    });
    // Watchdog and teardown must always target the current native child.
    this.session.ptyPid = native.pid;
    if (this.session.descendantWatchdog) this.session.descendantWatchdog.pid = native.pid;
  }
  current() {
    if (this.session.pty !== this || this.session._terminated || !this.session.alive) {
      throw modeSwitchError('session_changed');
    }
  }
  async until(check, timeout = this.waitMs) {
    const deadline = Date.now() + timeout;
    do {
      this.current();
      if (this.exited && !this.replacing) throw modeSwitchError('session_changed');
      const result = check();
      if (result) return result;
      await delay(100);
    } while (Date.now() < deadline);
    throw modeSwitchError('unconfirmed');
  }
  cleanOutput() {
    return this.output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  }
  nativeApprovalPending() {
    // 0.164's native OSC state distinguishes an actual permission dialog from
    // generic attention and command-dialog text echoed through a tool response.
    const states = [...this.output.matchAll(/\x1b\]7501;([^\x1b\x07]*)(?:\x07|\x1b\\)/g)];
    return /(?:^|:)state=blocked(?:[:]|$)/.test(states.at(-1)?.[1] || '')
      && /(?:^|:)kind=permission(?:[:]|$)/.test(states.at(-1)?.[1] || '');
  }
  async command(text) {
    this.current();
    this.write('\x15' + text);
    // Codex's paste/key-burst detector treats Enter in the same write as text.
    await delay(250);
    this.current();
    this.write('\r');
  }
  async boundary(tracker) {
    let rejected = false;
    await this.until(() => {
      const state = tracker.poll();
      if (state.ended) return true;
      // Never interrupt a running command. Esc rejects an unanswered native request;
      // the resumed directive asks the model to reconsider it under the new policy.
      if (!rejected && state.canRejectApproval && this.nativeApprovalPending()) {
        rejected = true;
        this.write('\x1b');
      }
      return false;
    });
  }
  async restart(spec, id) {
    this.replacing = true;
    try {
      if (!this.exited) {
        await this.command('/quit');
        await this.until(() => this.exited, 15000);
      }
      this.current();
      const native = this.spawn(spec.command, ['resume', id, ...spec.args], {
        name: 'xterm-256color', cols: this.session.cols || 120, rows: this.session.rows || 40,
        cwd: spec.cwd, env: spec.env,
      });
      this.bind(native);
      this.session._transcriptHint.env.CODEX_HOME = spec.env.CODEX_HOME;
      this.session._attentionTail = '';
      this.session._attentionState = null;
      this.session._attentionLineCarry = '';
      this.session._attentionRowCarry = '';
    } finally { this.replacing = false; }
    await this.until(() => CODEX_COMPOSER_READY_RE.test(this.cleanOutput()), 90000);
  }
  async confirm(mode) {
    this.output = '';
    await this.command('/status');
    await this.until(() => this.cleanOutput().split(/\r?\n/)
      .some(line => [mode, 'custom'].includes(matchCodexPermissionLine(line))), 15000);
  }
  async switchMode(agent, mode) {
    const file = locateCodexRollout(this.session._transcriptHint);
    if (!file) throw modeSwitchError('unconfirmed');
    const tracker = trackRollout(file);
    tracker.poll();
    const id = tracker.state.id;
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw modeSwitchError('unconfirmed');
    clearTimeout(this.session._submitCheckTimer);
    this.session._submitCheckTimer = null;
    // Prepare all configuration before stopping the old TUI. No shared config writes.
    const policy = agent.buildPermissionPolicy({ mode, source: 'session', inherited: false });
    const launch = codexTerminalLaunchOptions(this.spec.cwd, this.spec.codexSwitch.baseHome,
      this.spec.codexSwitch.effort, this.spec.env, policy);
    const next = { ...this.spec, args: [...launch.args, '--no-alt-screen',
      ...(this.spec.model ? ['--model', this.spec.model] : [])],
      env: { ...this.spec.env, CODEX_HOME: launch.codexHome } };
    await this.boundary(tracker);
    let previous = this.spec;
    const baseline = tracker.state.policy;
    const baselineSettings = tracker.state.settings;
    if (!baseline?.sandbox_policy?.type || !baseline.approval_policy || !baseline.approvals_reviewer || !baselineSettings) {
      throw modeSwitchError('unconfirmed');
    }
    // Resume otherwise inherits saved thread policy even with a different home.
    // Pin the original policy too, including legacy Plan's inherited sandbox.
    previous = { ...previous, args: [...previous.args.filter(arg => arg !== '--no-daemon'), '--no-daemon',
      '-c', `sandbox_mode=${tomlValue(baseline.sandbox_policy.type)}`,
      '-c', `approval_policy=${tomlValue(baseline.approval_policy)}`,
      '-c', `approvals_reviewer=${tomlValue(baseline.approvals_reviewer)}`] };
    this.switching = true;
    try {
      const revision = tracker.state.settingsRevision;
      await this.restart(next, id);
      await this.until(() => {
        tracker.poll();
        return tracker.state.settingsRevision > revision && settingsMatch(tracker.state.settings, policyToCodexConfig(mode));
      }, 15000);
      await this.confirm(mode);
      const directive = agent.buildModeSwitchDirective(mode)
        + '\nIf the previous turn stopped awaiting approval, reconsider that proposed action under the new policy and obtain fresh approval if required.';
      // Reuse the verified Windows short-file handoff instead of sending a large
      // bracketed paste through ConPTY. POSIX sends the directive itself.
      const kickoff = agent.prepareKickoff(require('../config'), directive, this.session.taskId);
      const offset = fs.statSync(file).size;
      this.write(agent.wrapsBracketedPaste() ? `\x1b[200~${kickoff.initialPrompt}\x1b[201~` : kickoff.initialPrompt);
      await delay(700);
      this.current();
      if (kickoff.kickoffTypedLine) {
        this.write(kickoff.kickoffTypedLine);
        await delay(700);
        this.current();
      }
      this.write('\r');
      // The native preset acknowledgement AND the accepted user turn are required.
      await this.until(() => {
        const fd = fs.openSync(file, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(262144, Math.max(0, fs.fstatSync(fd).size - offset)));
          fs.readSync(fd, bytes, 0, bytes.length, offset);
          const text = bytes.toString('utf8');
          const submitted = kickoff.initialPrompt + (kickoff.kickoffTypedLine || '');
          const accepted = text.split('\n').some(line => {
            try {
              const row = JSON.parse(line);
              return (row.type === 'event_msg' && row.payload?.type === 'user_message' && row.payload.message === submitted)
                || (row.type === 'response_item' && row.payload?.role === 'user'
                  && row.payload.content?.some(item => item.text === submitted));
            } catch { return false; }
          });
          const toolOutputs = text.split('\n').flatMap(line => {
            try {
              const row = JSON.parse(line);
              const p = row.payload;
              return row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type)
                ? [String(p.output)] : [];
            } catch { return []; }
          });
          const directiveRead = !kickoff.kickoffFile || directive.split('\n').filter(Boolean).every(line =>
            toolOutputs.some(output => output.includes(line) || output.includes(JSON.stringify(line).slice(1, -1))));
          return accepted && directiveRead && policyMatches(text, mode);
        } finally { fs.closeSync(fd); }
      }, 15000);
      this.spec = next;
      return { supported: true, confirmed: mode };
    } catch (error) {
      // Before changing policy the old TUI is untouched; after replacement, restore
      // its exact launch configuration and same rollout before reporting failure.
      if (!this.session._terminated && this.session.pty === this && this.session.alive) {
        try {
          if (!this.exited) await this.boundary(tracker);
          const revision = tracker.state.settingsRevision;
          await this.restart(previous, id);
          await this.until(() => {
            tracker.poll();
            const actual = tracker.state.settings;
            return tracker.state.settingsRevision > revision
              && actual?.approval_policy === baselineSettings.approval_policy
              && actual.approvals_reviewer === baselineSettings.approvals_reviewer
              && JSON.stringify(actual.permission_profile) === JSON.stringify(baselineSettings.permission_profile);
          }, 15000);
        } catch {
          // An unverified process must not keep executing after rollback failed.
          this.kill();
        }
      }
      throw error;
    } finally {
      this.switching = false;
      if (this.exited && this.session.alive) this.events.emit('exit', this.lastExit || { exitCode: 1 });
    }
  }
}

function supported(session) {
  return session?.pty instanceof CodexLivePty && !!session.pty.spec.codexSwitch
    && versionAtLeast(session.pty.version, SWITCH_VERSION);
}

module.exports = { CodexLivePty, supported, rolloutState, policyMatches, settingsMatch, trackRollout, SWITCH_VERSION };
