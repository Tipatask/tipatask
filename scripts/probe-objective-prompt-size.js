#!/usr/bin/env node
'use strict';

// Real Claude request-size ablation. No Task App server, no port 4455, no task
// writes. --yes authorizes model usage. All five runs use the production argv
// builder, with common diagnostic limits: one model turn, hooks disabled and
// reservation writes denied. Global Claude settings/auth remain in effect.
//
// npm run probe:objective-size -- --yes --prompt /path/objective-prompt.md
//   [--system-prompt-file /path/system.txt] [--project-root /repo]
//   [--model MODEL] [--timeout-ms 180000] [--report /path/report.json]
//
// A dump stores exact stdin, not the appended system text or native history.
// Without --system-prompt-file the current fresh planner + static bundle is
// reconstructed and labeled, never represented as an exact historical replay.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const VARIANTS = ['full', 'no-system', 'no-mcp', 'no-at', 'empty-cwd'];
const SOURCES = {
  'no-system': 'appended system prompt / static KB / supplied cached tag docs',
  'no-mcp': 'MCP schemas and discovery',
  'no-at': 'CLI @path expansion',
  'empty-cwd': 'project CLAUDE.md / snapshotted auto-memory',
};
const TOKEN_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function parseArgs(argv) {
  const opts = { yes: false, timeoutMs: 180000 };
  const flags = { '--prompt': 'prompt', '--system-prompt-file': 'systemPromptFile',
    '--project-root': 'projectRoot', '--model': 'model', '--report': 'report', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') opts.yes = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (flags[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[flags[arg]] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  opts.timeoutMs = Number(opts.timeoutMs);
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 600000) {
    throw new Error('--timeout-ms must be between 1000 and 600000');
  }
  return opts;
}

function parsePromptFile(buffer) {
  const text = buffer.toString('utf8');
  if (!text.trim()) throw new Error('Prompt file is empty');
  if (!text.startsWith('# objective-prompt\n')) return { text, provenance: 'raw file', metadata: {} };
  const separator = Buffer.from('---- stdin (exact) ----\n');
  const boundary = buffer.indexOf(separator);
  if (boundary < 0) throw new Error('Malformed objective dump: missing stdin separator');
  const header = buffer.subarray(0, boundary).toString('utf8');
  const start = Number(header.match(/^body starts at byte (\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(start) || start !== boundary + separator.length) {
    throw new Error('Malformed objective dump: byte offset does not match separator');
  }
  const body = buffer.subarray(start);
  const bytes = Number(header.match(/^- stdin.bytes: (\d+)$/m)?.[1]);
  const chars = Number(header.match(/^- stdin.chars: (\d+)$/m)?.[1]);
  if (body.length !== bytes || body.toString('utf8').length !== chars) {
    throw new Error('Malformed objective dump: stdin byte/character counts do not match');
  }
  return { text: body.toString('utf8'), provenance: 'exact dump stdin', metadata: {
    mode: header.match(/^- mode: (.+)$/m)?.[1],
    written: header.match(/^- written: (.+)$/m)?.[1],
    systemPromptChars: Number(header.match(/^- systemPrompt.chars: (\d+)$/m)?.[1]),
  } };
}

// Resolve existing relative @files once, before varying cwd, so the cwd control
// does not accidentally become a second no-attachments variant. Missing mentions
// are reported; e-mail addresses are never candidates.
function resolveMentions(text, projectRoot) {
  let resolved = 0;
  const missing = new Set();
  const output = text.replace(/(^|[\s([{"'`])@("[^"\n]+"|'[^'\n]+'|[^\s)\]}"'`,;]+)(?=$|[\s)\]}"'`,;])/g,
    (whole, prefix, mention) => {
      const quoted = /^['"]/.test(mention);
      let raw = quoted ? mention.slice(1, -1) : mention;
      const resolve = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(projectRoot, value);
      let file = resolve(raw);
      let suffix = '';
      if (!quoted && !fs.existsSync(file) && /[.!?:]+$/.test(raw)) {
        const trimmed = raw.replace(/[.!?:]+$/, '');
        if (trimmed && fs.existsSync(resolve(trimmed))) {
          suffix = raw.slice(trimmed.length); raw = trimmed; file = resolve(raw);
        }
      }
      if (!fs.existsSync(file)) { missing.add(raw); return whole; }
      if (path.isAbsolute(raw)) return whole;
      resolved++;
      return `${prefix}@${quoted || /\s/.test(file) ? JSON.stringify(file) : file}${suffix}`;
    });
  return { text: output, resolved, missing: [...missing] };
}

function replaceFlag(args, name, value) {
  const out = args.slice();
  const index = out.indexOf(name);
  if (index >= 0) out.splice(index, 2, ...(value === null ? [] : [name, value]));
  else if (value !== null) out.push(name, value);
  return out;
}

function buildVariants(args, stdin, cwd, emptyCwd, neutralize) {
  let noSystem = replaceFlag(args, '--append-system-prompt', null);
  noSystem = replaceFlag(noSystem, '--append-system-prompt-file', null);
  return [
    { name: 'full', args: args.slice(), stdin, cwd },
    { name: 'no-system', args: noSystem, stdin, cwd },
    { name: 'no-mcp', args: replaceFlag(args, '--mcp-config', '{"mcpServers":{}}'), stdin, cwd },
    { name: 'no-at', args: args.slice(), stdin: neutralize(stdin), cwd },
    { name: 'empty-cwd', args: args.slice(), stdin, cwd: emptyCwd },
  ];
}

function inputTotal(usage) {
  if (!usage || !TOKEN_KEYS.some(key => typeof usage[key] === 'number')) return null;
  return TOKEN_KEYS.reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
}

function resultError(event) {
  return [event.result, ...(Array.isArray(event.errors) ? event.errors : []),
    typeof event.error === 'string' ? event.error : event.error?.message]
    .filter(value => typeof value === 'string' && value.trim()).join(' | ');
}

function createCollector() {
  const requests = new Map();
  let result = null;
  let init = null;
  function accept(event) {
    if (event.type === 'system' && event.subtype === 'init') {
      init = { model: event.model, mcp_servers: event.mcp_servers, toolsCount: event.tools?.length };
    }
    if (event.type === 'result') result = event;
    // stream message_start and block-wise assistant events repeat the same usage.
    // A request is identified by message.id, never by the number of SSE events.
    const message = event.type === 'assistant' ? event.message
      : event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message : null;
    if (message?.id && inputTotal(message.usage) > 0 && !event.parent_tool_use_id) {
      const previous = requests.get(message.id) || {};
      requests.set(message.id, { ...previous, ...message.usage });
    }
  }
  function finish() {
    const rows = [...requests].map(([id, usage]) => ({ id, usage, total: inputTotal(usage) }));
    const usage = result?.usage || result;
    const error = result && (result.is_error || (result.subtype && result.subtype !== 'success'));
    return {
      init, requests: rows, firstInput: rows[0]?.total ?? null,
      peakInput: rows.length ? Math.max(...rows.map(row => row.total)) : null,
      usage: usage ? Object.fromEntries([...TOKEN_KEYS, 'output_tokens'].map(key => [key, usage[key] ?? null])) : null,
      totalInput: inputTotal(usage), numTurns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? result?.cost_usd ?? null,
      is_error: result?.is_error ?? null, subtype: result?.subtype ?? null,
      api_error_status: result?.api_error_status ?? null,
      errorText: error ? resultError(result) || `CLI result subtype=${result.subtype}` : null,
      hasResult: result !== null,
    };
  }
  return { accept, finish };
}

function rankVariants(results) {
  const baseline = results.find(row => row.name === 'full');
  const ranked = results.filter(row => row.firstInput !== null)
    .map(row => ({ name: row.name, firstInput: row.firstInput,
      reduction: baseline?.firstInput == null ? null : baseline.firstInput - row.firstInput }))
    .sort((a, b) => b.firstInput - a.firstInput || a.name.localeCompare(b.name));
  const reductions = ranked.filter(row => row.name !== 'full' && row.reduction > 0)
    .sort((a, b) => b.reduction - a.reduction);
  const complete = VARIANTS.every(name => results.some(row => row.name === name && row.firstInput !== null && row.hasResult && !row.failure));
  const winner = reductions[0];
  // A few tokens of cwd/cache protocol variation do not establish a cause.
  const meaningful = winner && winner.reduction >= Math.max(100, baseline.firstInput * 0.01);
  return { ranked, complete, largestContributor: complete && meaningful ? SOURCES[winner.name] : null,
    summary: complete && meaningful
      ? `SUMMARY: largest measured contributor=${SOURCES[winner.name]}; ${winner.name} removes ${winner.reduction} first-request tokens. This does not prove an uncaptured historical failure.`
      : 'SUMMARY: inconclusive — missing comparable measurements or no material first-request reduction.' };
}

function signalTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    require('../src/server/process-group').killWindowsChildTree(child);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already reaped */ } }
  }
}

function cannotContinue(result) {
  // Oversized-request refusals are the point of this probe: keep testing the
  // remaining ablations, which may fit. Even a timeout/E2BIG can be size-related.
  return Boolean(result.failure && (/ENOENT|interrupted/.test(result.failure) ||
    /not logged in|authentication|unauthorized|invalid api key/i.test(result.errorText || '')));
}

async function runVariant(variant, { command, env, timeoutMs, options = {}, onSpawn = () => {} }) {
  return new Promise(resolve => {
    const collector = createCollector();
    let pending = '';
    let stderr = '';
    let failure = null;
    let done = false;
    const child = spawn(command, variant.args, { ...options, cwd: variant.cwd, env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const abort = () => { failure = 'interrupted'; signalTree(child); };
    const timer = setTimeout(() => { failure = 'timeout'; signalTree(child); }, timeoutMs);
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const line = text => { try { collector.accept(JSON.parse(text)); } catch { /* CLI non-JSON diagnostic */ } };
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
      signalTree(child); // Reap MCP descendants even after the CLI has exited.
      if (pending.trim()) line(pending);
      const data = collector.finish();
      const failedServers = (data.init?.mcp_servers || []).filter(server => server.status !== 'connected');
      const cliFailure = data.is_error && data.subtype !== 'error_max_turns' ? 'CLI error' : null;
      resolve({ name: variant.name, pid: child.pid ?? null, exitCode: code,
        ...data, failure: failure || (!data.hasResult ? 'no result event' : null) || cliFailure ||
          (failedServers.length ? `MCP initialization failed: ${failedServers.map(server => server.name).join(', ')}` : null),
        stderr: !data.hasResult ? stderr : undefined });
    };
    onSpawn(child.pid);
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const value of lines) line(value);
      if (pending.length > 16 * 1024 * 1024) { failure = 'oversized stream line'; signalTree(child); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.stdin.on('error', () => {}); // EPIPE after a CLI rejection is reported by close/result.
    child.once('error', err => { failure = err.message; finish(null); });
    child.once('close', finish);
    child.stdin.end(variant.stdin);
  });
}

function stageInstructions(projectRoot, scratchCwd) {
  const sources = [];
  for (const relative of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
    const file = path.join(projectRoot, relative);
    if (fs.existsSync(file)) sources.push({ file, text: fs.readFileSync(file, 'utf8') });
  }
  // Scratch cwd has a different native memory key. Copy the source entry point
  // into the guide instead of writing to the user's Claude state directory.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const memory = path.join(claudeHome, 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
  if (fs.existsSync(memory)) sources.push({ file: memory, text: fs.readFileSync(memory, 'utf8').split('\n').slice(0, 200).join('\n') });
  if (sources.length) fs.writeFileSync(path.join(scratchCwd, 'CLAUDE.md'), sources.map(row => row.text).join('\n\n'));
  return sources.map(row => ({ file: row.file, chars: row.text.length, sha256: hash(row.text) }));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('Usage: npm run probe:objective-size -- --yes [--prompt FILE] [--system-prompt-file FILE] [--project-root DIR] [--model MODEL] [--timeout-ms N] [--report FILE]');
    return 0;
  }
  // No imports of config.js, scratch writes, credentials or child processes before consent.
  if (!opts.yes) { console.error('Requires --yes: five real Claude model requests (billable), in scratch directories. Never uses port 4455.'); return 2; }
  const serverRoot = path.resolve(__dirname, '..');
  const sourceUserData = process.env.TIPATASK_USER_DATA || serverRoot;
  const projectRoot = fs.realpathSync(opts.projectRoot || require('../src/server/project-root').resolveProjectRoot());
  const promptPath = path.resolve(opts.prompt || path.join(sourceUserData, 'objective-prompt.md'));
  const parsed = parsePromptFile(fs.readFileSync(promptPath));
  const explicitSystem = opts.systemPromptFile ? fs.readFileSync(path.resolve(opts.systemPromptFile), 'utf8') : null;
  let sourceConfig = {};
  try { sourceConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tipatask/config.json'), 'utf8')); } catch { /* unconfigured fixture */ }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-objective-size-')));
  const cwd = path.join(scratch, 'project');
  const emptyCwd = path.join(scratch, 'empty');
  const userData = path.join(scratch, 'userdata');
  const originalEnv = { ...process.env };
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    fs.mkdirSync(path.join(cwd, '.tipatask'), { recursive: true });
    fs.mkdirSync(emptyCwd);
    fs.mkdirSync(userData);
    // Copy only the non-secret target/model. Never copy an account token.
    const target = Object.fromEntries(['API_BASE_URL', 'API_PROJECT_ID', 'CLAUDE_MODEL'].filter(key => sourceConfig[key]).map(key => [key, sourceConfig[key]]));
    fs.writeFileSync(path.join(cwd, '.tipatask/config.json'), JSON.stringify(target));
    const mcpSource = path.join(projectRoot, '.mcp.json');
    const mcp = fs.existsSync(mcpSource) ? JSON.parse(fs.readFileSync(mcpSource, 'utf8')) : { mcpServers: {} };
    const remote = mcp.mcpServers?.tipatask;
    const local = mcp.mcpServers?.['tipatask-local'];
    // Reconstruct managed entries without copying arbitrary headers/env secrets.
    const servers = {};
    if (remote && target.API_BASE_URL && target.API_PROJECT_ID) servers.tipatask = { type: 'http', url: `${target.API_BASE_URL}/api/projects/${target.API_PROJECT_ID}/mcp` };
    if (local) servers['tipatask-local'] = { command: process.execPath, args: [path.join(serverRoot, 'src/mcp/server.js')] };
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    const instructions = stageInstructions(projectRoot, cwd);
    for (const key of Object.keys(process.env)) {
      if (/^(API_|TIPATASK_TASK_ID$|TIPATASK_TRACK_DIR$|CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)$)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, { TIPATASK_PROJECT_ROOT: cwd, TIPATASK_USER_DATA: userData, TIPATASK_SERVER_ROOT: serverRoot, SIMPLE_MODE: 'false' });
    const config = require('../src/server/config');
    const { buildObjectiveArgs } = require('../src/server/claude-session');
    const { neutralizeAtMentions, buildTurnPrompt } = require('../src/server/providers/transcript');
    const { measureStdin } = require('../src/server/objective-prompt-dump');
    const { cliSpawnSpec, augmentPathEnv } = require('../src/server/spawn-utils');
    let system = explicitSystem;
    if (system === null) {
      const { buildObjectivePrompt } = await import('../src/client/utils.js');
      const { getStaticBundle } = require('../src/server/static-context');
      system = `${buildObjectivePrompt('', null, null).systemPrompt}\n\n${getStaticBundle(projectRoot)}`;
    }
    const mentions = resolveMentions(parsed.text, projectRoot);
    const session = { type: 'objective', providerType: 'claude', selectedModel: opts.model || sourceConfig.CLAUDE_MODEL || config.CLAUDE_MODEL,
      projectPath: cwd, systemPrompt: system, claudeSessionId: null, firstPrompt: mentions.text, messages: [{ role: 'user', content: mentions.text }] };
    let args = buildObjectiveArgs(session);
    const mcpPath = args[args.indexOf('--mcp-config') + 1];
    if (fs.existsSync(mcpPath)) {
      const scoped = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (scoped.mcpServers?.tipatask) scoped.mcpServers.tipatask.headersHelper = require('../src/server/mcp-spawn-config').buildHeadersHelperCommand({ projectRoot, userDataRoot: sourceUserData });
      fs.writeFileSync(mcpPath, JSON.stringify(scoped));
    }
    const denied = args[args.indexOf('--disallowedTools') + 1];
    args = replaceFlag(args, '--disallowedTools', `${denied},mcp__tipatask__reserve_task_keys`);
    args.push('--max-turns', '1', '--settings', JSON.stringify({ disableAllHooks: true }));
    const env = augmentPathEnv({ ...process.env, TERM: 'dumb' });
    const versionSpec = cliSpawnSpec(config.CLAUDE_BIN, ['--version'], { env, isWin: process.platform === 'win32' });
    const version = spawnSync(versionSpec.command, versionSpec.args, { ...versionSpec.options, env, encoding: 'utf8', timeout: 10000 });
    const report = { cliVersion: version.stdout?.trim(), model: session.selectedModel,
      prompt: { file: promptPath, provenance: parsed.provenance, ...parsed.metadata, sha256: hash(parsed.text), metrics: measureStdin(parsed.text) },
      system: { provenance: explicitSystem === null ? 'reconstructed current fresh planner + static bundle; cached tags/history not recovered' : 'supplied system-prompt file', chars: system.length, sha256: hash(system) },
      instructions, resolvedMentions: mentions.resolved, missingMentions: mentions.missing,
      controls: { maxTurns: 1, hooksDisabled: true, reservationWritesDenied: true, nativeResume: false, globalClaudeSettings: 'inherited', memory: 'source MEMORY.md first 200 lines copied into scratch guide' },
      providerStdin: {}, results: [] };
    // Transport comparison is deterministic; only Claude incurs live model calls.
    for (const provider of ['claude', 'codex', 'pi', 'gemini']) {
      // Input is already built stdin. Do not add its metadata-derived priority
      // hint a second time while measuring the system-on-stdin transport.
      report.providerStdin[provider] = measureStdin(buildTurnPrompt({ ...session, firstPrompt: null }, { includeSystemPrompt: provider !== 'claude', hasProviderSession: false }).prompt).bytes;
    }
    console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
    if (parsed.metadata.mode && parsed.metadata.mode !== 'fresh') console.log('NOTE: replay uses a fresh native session; historical resumed context is absent.');
    if (Number.isFinite(parsed.metadata.systemPromptChars) && parsed.metadata.systemPromptChars !== system.length) console.log('NOTE: supplied/reconstructed system length differs from dump header.');
    for (const variant of buildVariants(args, mentions.text, cwd, emptyCwd, neutralizeAtMentions)) {
      if (interrupted) break;
      const spec = cliSpawnSpec(config.CLAUDE_BIN, variant.args, { env, isWin: process.platform === 'win32' });
      const result = await runVariant({ ...variant, args: spec.args }, { command: spec.command, options: spec.options, env, timeoutMs: opts.timeoutMs,
        onSpawn: pid => console.log(`RUN ${variant.name} pid=${pid}`) });
      report.results.push(result);
      console.log(JSON.stringify(result));
      if (cannotContinue(result)) break;
    }
    Object.assign(report, rankVariants(report.results));
    console.log('RANK (first-request input incl. cache): ' + report.ranked.map((row, i) => `${i + 1}. ${row.name}=${row.firstInput} reduction=${row.reduction}`).join('; '));
    console.log(report.summary);
    if (opts.report) fs.writeFileSync(path.resolve(opts.report), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return interrupted ? 130 : report.complete ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(err => { console.error(`probe: ${err.message}`); process.exitCode = 1; });
module.exports = { parseArgs, parsePromptFile, resolveMentions, buildVariants, inputTotal, createCollector, rankVariants, cannotContinue, runVariant, main };
