'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { READ_TASK_TOOLS, READ_LOCAL_TOOLS } = require('./permission-policy');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'read', 'grep', 'find', 'ls', 'view_image']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'apply_patch']);
const BLOCKED_DELEGATION = new Set(['Agent', 'Task', 'spawn_agent', 'EnterPlanMode', 'ExitPlanMode']);
const PROTECTED = new Set(['.git', '.codex', '.claude', '.pi', '.tipatask', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

// Deliberately small grammar: one read command, no shell programs, substitutions,
// pipelines, redirects, eval, git helpers, find -exec, sed scripts or rg --pre.
function isReadCommand(command) {
  if (typeof command !== 'string' || /[;&|<>$`(){}\n\r\\]/.test(command)) return false;
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) || [];
  if (words.join('').replace(/["']/g, '') !== command.replace(/\s|["']/g, '')) return false;
  if ((command.match(/"/g) || []).length % 2 || (command.match(/'/g) || []).length % 2) return false;
  const args = words.map(w => w.replace(/^(["'])(.*)\1$/, '$2'));
  const cmd = args.shift();
  const allowed = {
    pwd: new Set(['-L', '-P']),
    ls: new Set(['-a', '-l', '-la', '-al', '-A', '-1', '-R', '-h', '--']),
    cat: new Set(['-n', '-b', '--']),
    head: new Set(['-n', '-c', '--']), tail: new Set(['-n', '-c', '--']),
    wc: new Set(['-l', '-w', '-c', '-m', '--']),
    rg: new Set(['--files', '-n', '-i', '-l', '-s', '-S', '-F', '--hidden', '--no-ignore',
      '--no-config', '-g', '--glob', '-t', '--type', '-e', '--regexp', '-m', '--max-count', '--']),
  };
  if (!allowed[cmd]) return false;
  if (cmd === 'pwd' && args.some(a => !allowed.pwd.has(a))) return false;
  return args.every(a => !a.startsWith('-') || allowed[cmd].has(a) || /^-\d+$/.test(a));
}

function knownReadTool(name) {
  if (READ_TOOLS.has(name)) return true;
  const m = name.match(/^(?:mcp__)?(tipatask|tipatask-local|tipatask_local)__(.+)$/);
  return !!m && (m[1] === 'tipatask' ? READ_TASK_TOOLS : READ_LOCAL_TOOLS).includes(m[2]);
}

function workspaceEdit(input, root) {
  const target = input?.file_path ?? input?.path;
  if (typeof target !== 'string' || !root) return false;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch { return false; }
  let absolute = path.resolve(root, target);
  const lexicalRelative = path.relative(root, absolute);
  if (!lexicalRelative.startsWith('..') && !path.isAbsolute(lexicalRelative)) {
    absolute = path.resolve(canonicalRoot, lexicalRelative);
  }
  const relative = path.relative(canonicalRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || relative.split(path.sep).some(p => PROTECTED.has(p))) return false;
  // New files are checked against their nearest existing ancestor. Symlinks may
  // not turn an auto-approved project edit into an out-of-project write.
  let existing = absolute;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  try {
    const real = fs.realpathSync(existing);
    const rel = path.relative(canonicalRoot, real);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).some(p => PROTECTED.has(p));
  } catch { return false; }
}

function assessAction(mode, name, input, root) {
  if (mode === 'bypass') return 'allow';
  // Delegation can create an unguarded child; only Bypass permits it. Plan-mode
  // changes happen through a new launch, never from model output or a tool call.
  if (BLOCKED_DELEGATION.has(name)) return 'deny';
  const read = knownReadTool(name)
    || (['Bash', 'bash', 'exec_command', 'shell_command'].includes(name) && isReadCommand(input?.command ?? input?.cmd));
  // Shell classification is an Auto convenience, not a read-only security boundary.
  // Plan uses native read/search tools so aliases, startup files and interpreter
  // escape flags cannot turn an apparently read-only command into a write.
  if (mode === 'plan') return knownReadTool(name) ? 'allow' : 'deny';
  if (mode === 'always_ask') return 'ask';
  if (EDIT_TOOLS.has(name) && workspaceEdit(input, root)) return 'allow';
  if (mode === 'auto' && read) return 'allow';
  return 'ask';
}

function hookResult(allow, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: reason } };
}

async function createPermissionGate(session, { root, changed = () => {}, timeoutMs = 600000,
  attentionText = 'Permission approval required.' } = {}) {
  const token = randomBytes(32).toString('hex');
  const pending = new Map();
  let closed = false;
  const gate = {
    ready: false,
    snapshot: () => pending.values().next().value?.public || null,
    answer(id, allow) {
      const request = pending.get(id);
      if (!request || typeof allow !== 'boolean' || closed) return false;
      request.finish(allow, allow ? 'Approved for this action.' : 'Denied by user.');
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of [...pending.values()]) request.finish(false, 'Permission session ended.');
      server.close();
      server.closeAllConnections();
    },
  };
  const server = http.createServer(async (req, res) => {
    const reply = (code, data) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (closed || req.method !== 'POST' || req.url !== '/check'
      || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) return reply(403, { error: 'Forbidden' });
    let event;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1048576) return reply(413, { error: 'Too large' });
      }
      event = JSON.parse(body);
    } catch { return reply(400, { error: 'Invalid request' }); }
    if (event.hook_event_name === 'SessionStart') {
      gate.ready = true;
      return reply(200, {});
    }
    if (event.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string') return reply(400, { error: 'Invalid event' });
    const decision = assessAction(session.permissionPolicy.mode, event.tool_name, event.tool_input, root);
    if (decision !== 'ask') return reply(200, hookResult(decision === 'allow', decision === 'allow'
      ? 'Allowed by the run permission policy.' : 'Blocked by the run permission policy.'));
    if (pending.size >= 16) return reply(200, hookResult(false, 'Too many pending permission requests.'));
    const id = randomUUID();
    let timer;
    const request = {
      public: { id, tool: event.tool_name, input: JSON.stringify(event.tool_input ?? {}).slice(0, 12000) },
      finish(allow, reason) {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reply(200, hookResult(allow, reason));
        changed();
      },
    };
    pending.set(id, request);
    timer = setTimeout(() => request.finish(false, 'Approval expired. Retry the action.'), timeoutMs);
    timer.unref?.();
    res.on('close', () => request.finish(false, 'Approval connection closed.'));
    changed();
    session.onAttentionNeeded?.({ kind: 'attention', promptText: attentionText });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  gate.url = `http://127.0.0.1:${server.address().port}/check`;
  gate.token = token;
  return gate;
}

function claudePermissionHooks(gate) {
  const hook = { type: 'http', url: gate.url, headers: { Authorization: `Bearer ${gate.token}` },
    timeout: 660, onFailure: 'block' };
  return { disableAllHooks: false, ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}), hooks: {
    // SessionStart does not support HTTP hooks. Exec form avoids shell quoting and
    // runs through this app's pinned Node/Electron runtime on every platform.
    SessionStart: [{ hooks: [{ type: 'command', command: process.execPath,
      args: [path.join(__dirname, 'permission-gate-ready.cjs'), gate.url, gate.token], timeout: 15 }] }],
    PreToolUse: [{ matcher: '.*', hooks: [hook] }],
  } };
}

module.exports = { createPermissionGate, claudePermissionHooks, assessAction, isReadCommand, workspaceEdit, knownReadTool };
