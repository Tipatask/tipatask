'use strict';

// TPT623 — one-shot, non-interactive prompt through the project's default objective-chat
// provider (the same OBJECTIVE_PROVIDER + default model a new objective chat starts with).
// Unlike dispatch.spawnTurn() there is no chat session, transcript, throttle slot or proposal
// parsing: one prompt in, the model's final text out. Used for small server-side generation
// jobs such as describing tags (tag-auto-register.js).
//
// Claude runs through headless-claude.js. Codex, Gemini and Pi run their own CLI with the
// launch spec their session module builds (codexOneShotSpec / geminiOneShotSpec /
// piOneShotSpec), so env and argv stay next to each provider's chat-turn code. A failed or
// empty non-Claude run falls back to one Claude attempt. Never throws.
//
// (TPT701) Callers that feed the model text they do not control (release-notes generation
// from commit messages and task comments) pass `toolless: true`, a neutral `cwd` and
// `sanitizeEnv: stripSensitiveEnv`: no built-in tools, no MCP servers, no project CLAUDE.md or
// settings, and no Tipatask credentials or Claude Code nesting markers in the child env. An
// explicit `selection` (provider + model) replaces the project default; `fallbackToClaude:
// false` turns the Claude retry off for it.

const { spawn: cpSpawn } = require('node:child_process');
const config = require('../config');
const { cliSpawnSpec, augmentPathEnv } = require('../spawn-utils');
const { runHeadlessClaude, trackHeadlessProc, signalProc } = require('../headless-claude');
const registry = require('./registry');

const DEFAULT_TIMEOUT_MS = 120000;

// (TPT701) Env keys a one-shot child must never inherit from the server or from an agent
// terminal: Tipatask credentials and task identity (the child has no Tipatask tools to use
// them with) and the Claude Code nesting markers (an inherited CLAUDECODE / CLAUDE_CODE_*
// changes how a spawned `claude` persists its own session). Provider runtime keys (CODEX_HOME,
// Pi API keys, PATH) are the provider's own mechanism and stay.
const SENSITIVE_ENV_KEYS = Object.freeze([
  'API_TOKEN', 'TIPATASK_API_TOKEN', 'API_BASE_URL', 'API_PROJECT_ID', 'TIPATASK_LOCAL_SECRET',
  'TIPATASK_TASK_ID', 'TIPATASK_TRACK_DIR', 'TIPATASK_OBJECTIVE_TASK_ID', 'TIPATASK_TOOL_EXEC',
  'TIPATASK_TOOL_SCRIPT', 'TIPATASK_ELECTRON_HOST', 'CLAUDECODE',
]);
function stripSensitiveEnv(env) {
  const out = { ...(env || {}) };
  for (const key of Object.keys(out)) {
    if (SENSITIVE_ENV_KEYS.includes(key) || /^CLAUDE_CODE_/.test(key)) delete out[key];
  }
  return out;
}

// Lazy: the session modules pull in claude-session.js and friends, which a backend caller
// that never auto-registers a tag should not load.
const SPEC_BUILDERS = {
  codex: () => require('./codex-session').codexOneShotSpec,
  gemini: () => require('./gemini-session').geminiOneShotSpec,
  pi: () => require('./pi-session').piOneShotSpec,
};

function parseJsonLines(stdout) {
  const events = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* not an event line */ }
  }
  return events;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part && part.type === 'text' && typeof part.text === 'string') ? part.text : '').join('');
}

// The model's final answer from a provider's JSON event stream ('' when there is none).
//   codex  — `codex exec --json`: the last item.completed agent_message.
//   gemini — `--output-format stream-json`: assistant message deltas, concatenated.
//   pi     — `--mode json`: text_delta deltas; else the last assistant message_end content.
function extractFinalText(provider, stdout) {
  const events = parseJsonLines(stdout);
  if (provider === 'codex') {
    let text = '';
    for (const e of events) {
      if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
    }
    return text.trim();
  }
  if (provider === 'gemini') {
    return events
      .filter(e => e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string')
      .map(e => e.content).join('').trim();
  }
  if (provider === 'pi') {
    const deltas = events
      .filter(e => e.type === 'message_update' && e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta')
      .map(e => e.assistantMessageEvent.delta || '').join('');
    if (deltas.trim()) return deltas.trim();
    let last = '';
    for (const e of events) {
      if (e.type === 'message_end' && e.message && e.message.role === 'assistant') last = textOfContent(e.message.content);
    }
    return last.trim();
  }
  return String(stdout || '').trim();
}

// JSON out of a model answer: a ```json fence, else the whole text, else the first
// array/object span in it. null when nothing parses.
function parseJsonAnswer(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : null, text];
  const span = text.match(/[[{][\s\S]*[\]}]/);
  if (span) candidates.push(span[0]);
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()); } catch { /* try the next shape */ }
  }
  return null;
}

// The provider + model a fresh objective chat in this project would use.
function resolveDefaultSelection(projectRoot) {
  const cfg = registry.configForProject(projectRoot || config.PROJECT_ROOT);
  const providerId = registry.SELECTABLE_PROVIDERS.includes(cfg.OBJECTIVE_PROVIDER) ? cfg.OBJECTIVE_PROVIDER : 'claude';
  return { providerId, model: registry.getProviderDefaultModel(providerId, cfg) || '' };
}

function runCliOnce(spec, prompt, { timeoutMs, label, spawn = cpSpawn }) {
  return new Promise((resolve) => {
    let proc;
    let done = false;
    let stdout = '';
    const finish = (value) => { if (done) return; done = true; clearTimeout(killTimer); resolve(value); };
    const killTimer = setTimeout(() => {
      if (done) return;
      console.warn(`[one-shot] ${label} timed out after ${timeoutMs}ms — pid ${proc && proc.pid}`);
      if (proc) {
        signalProc(proc, 'SIGTERM');
        setTimeout(() => signalProc(proc, 'SIGKILL'), 2000);
      }
      finish(null);
    }, timeoutMs);
    try {
      const s = cliSpawnSpec(spec.command, spec.args, { env: spec.env, isWin: process.platform === 'win32' });
      proc = spawn(s.command, s.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...s.options });
    } catch (err) {
      console.warn(`[one-shot] ${label} spawn failed: ${err.message}`);
      finish(null);
      return;
    }
    trackHeadlessProc(proc);
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { console.warn(`[one-shot] ${label} proc error: ${err.message}`); finish(null); });
    proc.on('close', (code) => {
      if (code !== 0) console.warn(`[one-shot] ${label} exited ${code}`);
      finish(stdout);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Run one prompt through the project's default objective-chat provider.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {number} [opts.timeoutMs=120000]
 * @param {boolean} [opts.parseJson=false] - parse the answer as JSON (null when it doesn't parse)
 * @param {{providerId: string, model?: string}} [opts.selection] - explicit provider + model
 *   instead of the project default (an unknown providerId falls back to the default)
 * @param {boolean} [opts.toolless=false] - no built-in tools / MCP servers (Claude: `--tools ''`
 *   + empty strict MCP config; Codex: `-c mcp_servers={}`; Gemini/Pi already run without)
 * @param {string} [opts.cwd] - child working directory (default projectRoot); a neutral empty
 *   directory keeps the cwd project's CLAUDE.md, settings and hooks out of the run
 * @param {(env: object) => object} [opts.sanitizeEnv] - applied to the child env of every leg
 *   (see stripSensitiveEnv)
 * @param {boolean} [opts.fallbackToClaude=true] - retry a failed non-Claude provider with Claude
 * @returns {Promise<string|object|null>} null on any failure
 */
async function runOneShotPrompt(prompt, opts = {}) {
  const projectRoot = opts.projectRoot || config.PROJECT_ROOT;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deps = opts.deps || {};
  const toolless = !!opts.toolless;
  const cwd = opts.cwd || projectRoot;
  const sanitizeEnv = typeof opts.sanitizeEnv === 'function' ? opts.sanitizeEnv : null;
  const fallbackToClaude = opts.fallbackToClaude !== false;
  const finalize = (text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    return opts.parseJson ? parseJsonAnswer(text) : text.trim();
  };

  let selection = null;
  if (opts.selection && registry.SELECTABLE_PROVIDERS.includes(opts.selection.providerId)) {
    selection = { providerId: opts.selection.providerId, model: opts.selection.model || '' };
  } else {
    try { selection = resolveDefaultSelection(projectRoot); }
    catch (err) { console.warn(`[one-shot] provider resolution failed: ${err.message}`); selection = { providerId: 'claude', model: '' }; }
  }

  if (selection.providerId !== 'claude') {
    let result = null;
    try {
      const buildSpec = (deps.specBuilders && deps.specBuilders[selection.providerId]) || SPEC_BUILDERS[selection.providerId]();
      const built = buildSpec({ projectRoot, model: selection.model, toolless, cwd });
      const spec = { ...built, env: sanitizeEnv ? sanitizeEnv(built.env) : built.env, cwd: opts.cwd || built.cwd };
      const stdout = await runCliOnce(spec, prompt, { timeoutMs, label: selection.providerId, spawn: deps.spawn });
      result = finalize(extractFinalText(selection.providerId, stdout));
    } catch (err) {
      console.warn(`[one-shot] ${selection.providerId} failed: ${err.message}`);
    }
    if (result != null) return result;
    if (!fallbackToClaude) {
      console.warn(`[one-shot] ${selection.providerId} gave no usable answer — no Claude fallback for an explicit provider`);
      return null;
    }
    console.warn(`[one-shot] ${selection.providerId} gave no usable answer — falling back to claude`);
  }

  const runClaude = deps.runHeadlessClaude || runHeadlessClaude;
  const claudeModel = selection.providerId === 'claude' && selection.model ? selection.model : undefined;
  const claudeOpts = { model: claudeModel, timeoutMs, cwd, toolless };
  if (sanitizeEnv) claudeOpts.env = sanitizeEnv(augmentPathEnv({ TERM: 'dumb' }));
  const text = await runClaude(prompt, claudeOpts);
  return finalize(text);
}

module.exports = { runOneShotPrompt, extractFinalText, parseJsonAnswer, resolveDefaultSelection, stripSensitiveEnv, SENSITIVE_ENV_KEYS };
