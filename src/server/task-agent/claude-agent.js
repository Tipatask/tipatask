'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const BaseTaskAgent = require('./base-agent');
const config = require('../config');
const { getStaticBundle, getTaskStartupGrepBundle } = require('../static-context');
const { resolveBin, resolveBinAsync, augmentPathEnv, projectEnvExtras, resolveNvmBinDir, resolveSpawnModel, resolveAttentionTerminalBell } = require('../spawn-utils');
const { matchPromptLine, CLAUDE_PROMPT_PATTERNS, CLAUDE_PENDING_PASTE_RE } = require('./prompt-detect');
const { buildClaudeModelList } = require('./model-registry');
const { buildHeadersHelperCommand, writeSpawnMcpConfig } = require('../mcp-spawn-config');

// ── Model probe (C1504) ──
// No CLI path exists for this at all: `claude --help` has no `models` subcommand, `--model`
// carries no commander `choices:` list, and the signed remote catalog
// (https://downloads.claude.ai/model-catalog/v1/catalog.json) 404s on this account/build (no
// document has been published there yet — confirmed live). The only source is the CLI
// binary's own embedded model table (verified against the installed 2.1.263 build: 19 rows,
// `id:"…",family:"…",display_name:"…"`). Streamed, not read whole — the binary is a ~200MB
// single-file bundle (no separate cli.js to target).
const MODEL_SCAN_MAX_MATCH_CHARS = 200; // generous vs. the ~90-char rows actually seen
const MODEL_SCAN_TIMEOUT_MS = 5000;
const MODEL_SCAN_CHUNK_BYTES = 1 << 22; // 4MB

function parseClaudeAuthStatus(output) {
  if (!output) return { loggedIn: false };
  try {
    const parsed = JSON.parse(output);
    return { loggedIn: !!parsed.loggedIn, raw: parsed };
  } catch {
    return { loggedIn: !/loggedIn"\s*:\s*false/.test(output) };
  }
}

// ── Design-mode brief cap (C1272) ──
// /design's own registration in the installed CLI (2.1.246) appends its argument string
// verbatim as a `## User Request` section — no size limit of its own — but the prompt is
// still delivered as one bracketed-paste PTY write, and a very large single paste risks the
// CLI's own paste-chip collapsing behavior. 4000 chars is comfortably inside that margin for
// the flattened task text + comments this repo actually produces.
const DESIGN_BRIEF_MAX_CHARS = 4000;
// Targets the design skill's two documented ask-triggers (mockups-vs-prototype ambiguity,
// "settle the aesthetic with the user") so a design-mode task never stalls on a clarifying
// question with no human in the loop — the skill's own "When you cannot ask" clause is what
// this sentence invokes.
// ── Effort flag probe (TPT286) ──
// CLAUDE_CODE_EFFORT_LEVEL is always exported when a task sets an effort; the `--effort`
// flag is added only when the installed CLI's own `--help` lists it (older builds reject
// an unknown option at startup). Memoized per binary fingerprint (realpath:size — changes on
// every `claude update`, same idea as getModelProbeKey()), so the probe runs once per install.
const EFFORT_HELP_TIMEOUT_MS = 10_000;
const _effortFlagCache = new Map(); // fingerprint -> Promise<boolean>

// ── headersHelper probe (TPT349) ──
// `headersHelper` on an http MCP server entry (a shell command whose JSON stdout supplies
// request headers, re-run on every connect/reconnect) is not listed in `claude --help` or any
// documented CLI surface, so support is detected the same way the model table is: by scanning
// the CLI's own bundle for the literal. Memoized per binary fingerprint (changes on every
// `claude update`); any failure resolves false and the spawn keeps the project's .mcp.json.
const HEADERS_HELPER_NEEDLE = 'headersHelper';
const HEADERS_HELPER_SCAN_TIMEOUT_MS = 10_000;
const _headersHelperCache = new Map(); // fingerprint -> Promise<boolean>

function claudeBinFingerprint(bin) {
  try {
    const real = fs.realpathSync(bin);
    return `${real}:${fs.statSync(real).size}`;
  } catch { return String(bin || ''); }
}

const DESIGN_NO_ASK_SUFFIX = 'Build it this turn: do not ask follow-up questions — if the aesthetic, direction, or mockup-vs-prototype choice is unspecified, pick one that matches this app and proceed.';

// ── Kickoff typed line (TPT445) ──
// Claude Code refuses a message that is only a bracketed paste ("Message is only pasted block, no
// words from you"). terminal-session.js types this one newline-free sentence after the paste.
const KICKOFF_TYPED_LINE = 'Please carry out the task brief pasted above.';

class ClaudeAgent extends BaseTaskAgent {
  static KICKOFF_TYPED_LINE = KICKOFF_TYPED_LINE;

  getQuotaStatus(config, opts = {}) {
    return require('./claude-quota').readClaudeQuota(config, opts);
  }

  constructor() {
    super('claude', 'Claude Code');
    this.supportsPlanMode = true;
  }

  // Full directive wording, and no text clarifying-question mechanism: Claude asks through its
  // native AskUserQuestion tool, so the "Questions ready." sentinel never enters its prompt.
  getPreamblePolicy() {
    return { compact: false, clarify: false };
  }

  // Builds the --append-system-prompt value: static bundle + grep bundle.
  // Tag arch docs are NOT inlined here — agent loads them lazily via MCP.
  // Stable prefix ordering maximises CLI prompt-cache hit rate across turns.
  _buildAppendSystemPrompt(opts = {}) {
    const ttTags = (opts.taskTags || []).filter(t => t.startsWith('tt-'));
    const projectRoot = opts.projectPath || config.PROJECT_ROOT;
    const staticBundle = getStaticBundle(projectRoot);
    const grepBundle = ttTags.length >= 2 ? getTaskStartupGrepBundle(ttTags, projectRoot) : '';
    const langDirective = this.getLanguageDirective(config, opts);
    const parts = [];
    if (langDirective) parts.push(langDirective);
    parts.push(staticBundle);
    if (grepBundle) parts.push(grepBundle);
    const totalChars = parts.reduce((s, p) => s + p.length, 0);
    const estTok = n => Math.ceil(n / 4);
    console.log(
      `[task-agent:profile] staticBundle.chars=${staticBundle.length} est_tokens=${estTok(staticBundle.length)}` +
      ` grepBundle.chars=${grepBundle.length} est_tokens=${estTok(grepBundle.length)}` +
      ` systemPrompt.chars=${totalChars} est_tokens=${estTok(totalChars)}`
    );
    return parts.join('\n\n');
  }

  // Static helper (unit-testable without an instance): collapse every whitespace run
  // (newlines included) to a single space and cap length. A `/design` invocation is a real
  // slash command only when its first line has no embedded newline — a raw multi-line task
  // description glued onto `/design` is exactly what stopped it from registering as a
  // command pre-C1272 (see design-mode-prompt.test.js). Truncation marker is short and
  // fixed so callers can reserve room for it deterministically.
  static flattenDesignBrief(text, maxChars) {
    const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (flat.length <= maxChars) return flat;
    const marker = '… (truncated)';
    const cut = Math.max(0, maxChars - marker.length);
    return `${flat.slice(0, cut).trimEnd()}${marker}`;
  }

  buildPrompt(prompt, opts = {}) {
    // C1575 — parent-task context (opts.parentTaskBlock), prepended ahead of this task's own
    // comments. Uncapped for Claude — no prompt-size test exists here, unlike pi-agent.js.
    const promptWithComments = BaseTaskAgent.prependParentTask(
      BaseTaskAgent.prependTaskComments(prompt, opts), opts);

    // Design mode sends /design and the task brief in one PTY submission; bare
    // /design opens a question menu. Check opt-in before SIMPLE_MODE. Put recent
    // comments first so brief truncation preserves task intent.
    if (opts.designMode) {
      const rawBrief = [prompt, opts.taskCommentsBlock].filter(Boolean).join(' ');
      const reserve = DESIGN_NO_ASK_SUFFIX.length + 1; // +1 for the joining space
      const brief = ClaudeAgent.flattenDesignBrief(rawBrief, DESIGN_BRIEF_MAX_CHARS - reserve);
      return `/design ${brief} ${DESIGN_NO_ASK_SUFFIX}`;
    }

    // SIMPLE_MODE: skip all KB/cache preamble, return bare task prompt
    if (config.SIMPLE_MODE) return promptWithComments;

    const ttTags = (opts.taskTags || []).filter(t => t.startsWith('tt-'));
    const cachedTags = (opts.cachedTags || []).filter(t => t.startsWith('tt-') && !ttTags.includes(t));
    const tagNote = [
      ttTags.length > 0
        ? `Task tt-* tags: [${ttTags.join(', ')}]. Call \`mcp__tipatask__get_tag_architectures(tag_names=[...])\` ONCE for the subset whose taxonomy description is plausibly relevant — skip tags whose description clearly doesn't match.`
        : `Call \`mcp__tipatask__get_tag_architecture\` for tags whose description is plausibly relevant. Use taxonomy already in the system prompt (STATIC CONTEXT) to judge.`,
      cachedTags.length > 0
        ? `Already loaded this session (skip MCP re-fetch, content is available from prior context): [${cachedTags.join(', ')}].`
        : '',
      `Track loaded tags — never call twice.`,
    ].filter(Boolean).join(' ');
    const hasGrep = ttTags.length >= 2;
    const grepNote = hasGrep
      ? `Cross-reference scan for [${ttTags.join(', ')}] is **already complete** — see "Pre-computed Cross-References" in the system prompt. Use Grep only for identifiers absent from that section. For new batch lookups: \`mcp__tipatask-local__batch_grep_tags(tag_names=[...], symbols=[...])\`.`
      : `Symbol/file search across ≥2 tt-* tags: call \`mcp__tipatask-local__batch_grep_tags(tag_names=[...])\` ONCE — single codebase scan (~30ms) replaces N sequential Grep calls (~1.2s each). Use Grep only for single-tag or single-symbol lookups.`;
    const compressionLevel = opts.compressionLevel || process.env.TASK_AGENT_COMPRESS_LEVEL || 'full';
    const cavemanLine = compressionLevel === 'full' ? '/caveman' : `/caveman ${compressionLevel}`;
    // C1184: resolve the project's actual "complete" status name (role-based) instead
    // of the hardcoded literal "completed" — a renamed status must still be reachable.
    const completeStatus = this.resolveStatusForRole('complete', opts);
    const resolutionNote = `\n\nMANDATORY before marking this task \`${completeStatus}\`: post ONE self-authored resolution comment via \`mcp__tipatask__create_task_comment(task_key, content, type: "resolution")\`. \`content\` must be a real report, written in plain English prose — do NOT use caveman style for this comment, even though the rest of this session runs in caveman mode. Cover: what changed and why, key files touched, how to verify, and follow-ups/caveats (write "none" if there are none). This is separate from and required IN ADDITION TO the auto-posted terminal-tail resolution comment (a raw log dump with no explanation, posted on session exit) — that one does not satisfy this step. Post it in the SAME tool-call batch as the final \`update_task(status="${completeStatus}")\`.`;
    // Shared directives (VCS, tag-description backfill, process safety, resource limits, KB hygiene, task status) — see
    // base-agent.js#buildSharedPreamble. Each is its own blank-line-separated block between
    // the resolution note and the task tail; absent optional ones leave no gap. The clarify
    // slot is unused here by policy (getPreamblePolicy() above).
    const { directives } = this.buildSharedPreamble(opts);
    const directiveBlocks = directives.map(d => `\n\n${d}`).join('');
    return `/tipatask-expert\n${cavemanLine}\n\n⚠️ Architecture KB: NEVER write to \`ai/ARCHITECTURE.md\` (deprecated legacy path, will not be loaded by any agent). Always use \`ai/architecture/GENERAL.md\` for stack/env/commands and \`ai/architecture/tt-*.md\` for module docs.\n\nBefore starting:\n1. General architecture and tag taxonomy are pre-loaded in the system prompt (STATIC CONTEXT section) — no need to Read \`ai/architecture/GENERAL.md\` or call \`list_system_tags\`.\n2. ${tagNote}\n\nDuring exploration: when a STANDING fact is missing from KB (undocumented endpoint, file not in KB Files table, schema change, behavioral nuance) — update \`ai/architecture/tt-*.md\` immediately with that fact alone. What you find out about THIS task does not go there — see KB hygiene below.\n\n${grepNote}\n\nAfter any code change, update ai/architecture/GENERAL.md and/or ai/architecture/{tag}.md for each tt-* tag on this task to reflect added/removed/changed endpoints, DB schema, env vars, file structure, or module behavior. Do this before marking task complete — never \`ai/ARCHITECTURE.md\`.\n\nBefore marking complete: if new module touched has no tt-* tag — call list_system_tags to verify, create tag via MCP or POST /api/tags, create ai/architecture/tt-*.md stub, add tag to task.${resolutionNote}${directiveBlocks}\n\n${promptWithComments}`;
  }

  getInteractiveReadyMs() { return 1500; }

  getPasteSilenceMs() { return 400; }

  // The `[Pasted text #N +M lines]` chip Claude leaves in its input box until the prompt is
  // submitted — see CLAUDE_PENDING_PASTE_RE in prompt-detect.js.
  getUnsentPasteRe() { return CLAUDE_PENDING_PASTE_RE; }

  // (C1057) Claude-specific prompt/dialog wording layered over the generic table — see
  // prompt-detect.js for the verified pattern list and the HARD RULE about toolApproval/
  // mcpTrust kinds.
  isPromptLine(line) {
    return matchPromptLine(line, CLAUDE_PROMPT_PATTERNS) || super.isPromptLine(line);
  }

  async getSpawnSpec(config, prompt, taskId, opts = {}) {
    const localized = await this.localizeSpawnPrompt(config, prompt, taskId, opts);
    prompt = localized.prompt;
    opts = localized.opts;
    // Resolve the project root from the window's bound project (opts.projectPath),
    // falling back to the global config. In a packaged GUI launch config.PROJECT_ROOT
    // points inside the .app bundle, so the cwd + .mcp.json MUST come from the opened
    // project instead — projectEnvExtras also injects that project's API creds so the
    // spawned MCP tipatask server uses the correct project identity.
    if (!opts.projectPath && process.versions.electron) {
      // In packaged builds config.PROJECT_ROOT resolves into the .app bundle.
      // This should be unreachable after the B1 WS header fallback; log so any regression is visible.
      console.warn('[claude-agent] opts.projectPath is falsy in a packaged Electron build — falling back to config.PROJECT_ROOT (bundle path). Check WS session projectPath resolution.');
    }
    const projectRoot = opts.projectPath || config.PROJECT_ROOT;
    const env = augmentPathEnv({ TERM: 'xterm-256color', ...projectEnvExtras(opts.projectPath) });
    if (taskId) {
      env.TIPATASK_TASK_ID = taskId;
      env.TIPATASK_TRACK_DIR = path.join(config.USER_DATA_ROOT, '.file-tracks');
    }
    // Live-read config.json for the model (not the frozen startup config.CLAUDE_MODEL
    // snapshot) so a settings-page edit applies on the next spawn without a server
    // restart, and a stale exported CLAUDE_MODEL env var can never shadow it (C953).
    const model = resolveSpawnModel(opts.model, projectRoot, 'CLAUDE_MODEL', 'opusplan');
    // TPT286 — per-task effort (null = CLI's own default, spawn left untouched).
    const effort = this.resolveEffort(opts.task);
    console.log(`[claude-agent] model=${model} (task=${opts.model || '-'}) effort=${effort || '-'}`);
    const args = ['--model', model, '--permission-mode', 'plan'];
    // (TPT354) Pin the session uuid so the exit-comment builder can find this run's transcript
    // (final-message.js) instead of guessing among the project's sessions. terminal-session.js
    // mints it per spawn and stores it on session._transcriptHint; absent for any caller that
    // doesn't pass it (probes, tests), which then simply gets no --session-id.
    if (opts.agentSessionId) args.push('--session-id', opts.agentSessionId);
    if (effort) {
      env.CLAUDE_CODE_EFFORT_LEVEL = effort;
      if (await ClaudeAgent._cliSupportsEffortFlag(config)) args.push('--effort', effort);
    }
    // TPT349 — when the CLI supports headersHelper, hand it a derived copy of .mcp.json whose
    // `tipatask` entry re-reads the account-store token on every (re)connect, so a
    // refreshed/re-authed token reaches the remote MCP without restarting the session. See
    // mcp-spawn-config.js. Falls back to the project's own .mcp.json (token frozen at launch).
    let mcpConfigPath = path.join(projectRoot, '.mcp.json');
    let mcpHeadersHelper = false;
    if (await ClaudeAgent._cliSupportsHeadersHelper(config)) {
      const helperCommand = buildHeadersHelperCommand({ projectRoot, userDataRoot: config.USER_DATA_ROOT });
      const derived = helperCommand
        ? writeSpawnMcpConfig({ projectRoot, userDataRoot: config.USER_DATA_ROOT, helperCommand })
        : null;
      if (derived) {
        mcpConfigPath = derived;
        mcpHeadersHelper = true;
      }
    }
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    // (C1057) Deterministic, wording-independent attention signal: with this channel
    // selected, Claude Code writes a BEL (\x07) to the PTY on agent_needs_input /
    // worker_permission_prompt / idle_prompt — terminal-session.js's feedAttentionChunk()
    // raises attention on it directly, no regex required. Additive settings source (merges
    // with the user's own ~/.claude/settings.json rather than replacing it) — confirmed via
    // scripts/probe-attention-prompts.js against the installed CLI version. Opt out
    // per-project with { "ATTENTION_TERMINAL_BELL": false } in .tipatask/config.json if a
    // future CLI version changes that merge behavior.
    if (resolveAttentionTerminalBell(projectRoot)) {
      args.push('--settings', JSON.stringify({ preferredNotifChannel: 'terminal_bell' }));
    }
    if (!config.SIMPLE_MODE) {
      args.push('--exclude-dynamic-system-prompt-sections');
      args.push('--append-system-prompt', this._buildAppendSystemPrompt(opts));
    }
    const initialPrompt = this.buildPrompt(prompt, opts);
    // (C1260, now dead for Claude as of C1272) preludePrompt was `/design` split into its own
    // submission — see buildPrompt()'s design-mode doc comment for why that shipped a worse
    // bug and was replaced with a single-submission `/design <brief>`. ClaudeAgent no longer
    // overrides buildPreludePrompt(), so this resolves BaseTaskAgent's default ('') and
    // spec.preludePrompt is never set — a non-design (or designMode:false) spec keeps its
    // exact pre-C1260 shape, and so does every design-mode spec now too. Left as a live call
    // (not deleted) so a future agent — or a reinstated fallback prelude path — can still use
    // it; terminal-session.js's awaitPrelude* phases stay in the injector for the same reason.
    // designMode itself stays OFF the spec on purpose — recordLastUsedAgent only persists
    // spec.model into .tipatask/config.json, never a one-off task flag.
    const preludePrompt = this.buildPreludePrompt(opts);
    const spec = {
      command: config.CLAUDE_BIN,
      args,
      cwd: projectRoot,
      env,
      initialPrompt,
      model,
    };
    if (preludePrompt) spec.preludePrompt = preludePrompt;
    // TPT445 — typed after the bracketed paste so the message holds real typed words; omitted for
    // design mode, where extra text would land inside the /design brief.
    if (!opts.designMode) spec.kickoffTypedLine = KICKOFF_TYPED_LINE;
    // TPT349 — lets terminal-session.js word its mid-session token-expiry notice (reconnect vs
    // restart). Like `model`, never persisted.
    spec.mcpHeadersHelper = mcpHeadersHelper;
    return spec;
  }

  // (TPT286) Resolves true when `<CLAUDE_BIN> --help` lists `--effort`. Async (execFile, never
  // spawnSync) so a first-time probe never blocks the event loop; any failure resolves false —
  // the env var still carries the effort. Only reached when a task actually sets an effort.
  static _cliSupportsEffortFlag(config) {
    // Probe the same binary getSpawnSpec() launches; fingerprint its resolved path.
    const bin = config.CLAUDE_BIN || resolveBin('claude');
    if (!bin) return Promise.resolve(false);
    const key = claudeBinFingerprint(path.isAbsolute(bin) ? bin : (resolveBin('claude') || bin));
    if (!_effortFlagCache.has(key)) {
      const nvmBinDir = resolveNvmBinDir(config.CLAUDE_BIN);
      const env = augmentPathEnv({});
      if (nvmBinDir) env.PATH = `${nvmBinDir}${path.delimiter}${env.PATH}`;
      _effortFlagCache.set(key, new Promise((resolve) => {
        execFile(bin, ['--help'], { env, timeout: EFFORT_HELP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            console.log(`[claude-agent] --help effort probe failed: ${err.code || err.message}`);
            _effortFlagCache.delete(key); // retry on the next effort spawn
            return resolve(false);
          }
          resolve(/--effort\b/.test(`${stdout || ''}\n${stderr || ''}`));
        });
      }));
    }
    return _effortFlagCache.get(key);
  }

  // (TPT349) Resolves true when the CLI bundle contains `headersHelper`. Streamed with an early
  // exit — the ~200MB bundle is never read whole — and a short tail carried across chunks so
  // a match split over a chunk boundary is not lost.
  static _cliSupportsHeadersHelper(config) {
    const bin = config.CLAUDE_BIN || resolveBin('claude');
    if (!bin) return Promise.resolve(false);
    const abs = path.isAbsolute(bin) ? bin : (resolveBin('claude') || bin);
    const key = claudeBinFingerprint(abs);
    if (!_headersHelperCache.has(key)) {
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { /* scan the path as given */ }
      _headersHelperCache.set(key, ClaudeAgent._scanFileForString(real, HEADERS_HELPER_NEEDLE).catch((err) => {
        console.log(`[claude-agent] headersHelper probe failed: ${err.message}`);
        _headersHelperCache.delete(key); // retry on the next spawn
        return false;
      }));
    }
    return _headersHelperCache.get(key);
  }

  static _scanFileForString(filePath, needle) {
    return new Promise((resolve, reject) => {
      let tail = '';
      let settled = false;
      const stream = fs.createReadStream(filePath, { encoding: 'latin1', highWaterMark: MODEL_SCAN_CHUNK_BYTES });
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.destroy();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('scan timed out')), HEADERS_HELPER_SCAN_TIMEOUT_MS);
      stream.on('data', (chunk) => {
        const buf = tail + chunk;
        if (buf.includes(needle)) return finish(resolve, true);
        tail = buf.slice(-(needle.length - 1));
      });
      stream.on('end', () => finish(resolve, false));
      stream.on('error', (err) => finish(reject, err));
    });
  }

  // (TPT354) See BaseTaskAgent#readFinalMessage. Reads the pinned-uuid transcript (--session-id above).
  readFinalMessage(session) {
    return require('./final-message').readClaudeFinalMessage(session && session._transcriptHint);
  }

  approvePlan(session) {
    if (!session.pty) return;
    session.pty.write('\x1b[Z');
    setTimeout(() => {
      if (session.pty) {
        session.pty.write(this.getApprovalText());
      }
    }, 120);
    setTimeout(() => {
      if (session.pty) session.pty.write('\r');
    }, 220);
  }

  // (C1504) See file-header comment for why this scans the binary instead of shelling out.
  // Empty return (no bin resolved, scan finds 0 rows, timeout, read error) is a normal,
  // expected outcome for model-registry.js's resolveModels() — it means "fall back to the
  // static list", not a hard failure, so this never throws for those cases.
  async probeModels() {
    const binPath = resolveBin('claude');
    if (!binPath) return [];
    let realPath;
    try { realPath = fs.realpathSync(binPath); } catch { realPath = binPath; }
    let scanned;
    try {
      scanned = await ClaudeAgent._scanBinaryForModelTable(realPath);
    } catch (err) {
      console.log(`[claude-agent] model probe failed: ${err.message}`);
      return [];
    }
    return buildClaudeModelList(scanned);
  }

  // Fingerprints the CLI binary's real path + size — both change on every `claude update`
  // (installer replaces the file at a new versioned path), so a stale cached model list is
  // invalidated the moment the CLI itself changes, independent of the 24h TTL.
  getModelProbeKey() {
    const binPath = resolveBin('claude');
    if (!binPath) return '';
    try {
      const realPath = fs.realpathSync(binPath);
      return `${realPath}:${fs.statSync(realPath).size}`;
    } catch { return binPath; }
  }

  // Streams the binary looking for `id:"…",family:"…",display_name:"…"` records rather than
  // reading it whole (it's ~200MB). Chunks are `latin1`-decoded (1 byte : 1 char, so byte
  // offsets stay stable across chunk boundaries) and a short tail from the previous chunk is
  // re-scanned with each new one so a record split across a chunk boundary is never lost —
  // model-registry.js's parseClaudeModelTable() de-dupes any record this doubly matches.
  static _scanBinaryForModelTable(filePath) {
    return new Promise((resolve, reject) => {
      const re = new RegExp('id:"(claude-[a-z0-9.-]+)",family:"([a-z0-9]+)",display_name:"([^"]{1,40})"', 'g');
      let tail = '';
      const rows = [];
      const stream = fs.createReadStream(filePath, { encoding: 'latin1', highWaterMark: MODEL_SCAN_CHUNK_BYTES });
      const timer = setTimeout(() => {
        stream.destroy(new Error('model scan timed out'));
      }, MODEL_SCAN_TIMEOUT_MS);
      stream.on('data', (chunk) => {
        const buf = tail + chunk;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(buf))) rows.push(m[0]);
        tail = buf.slice(-MODEL_SCAN_MAX_MATCH_CHARS);
      });
      stream.on('end', () => { clearTimeout(timer); resolve(rows.join('\n')); });
      stream.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  async detect(config) {
    const bin = await resolveBinAsync('claude');
    if (!bin) {
      return { id: this.id, label: this.label, available: false, reason: 'Claude CLI not found. Install claude or ensure its directory is on PATH.' };
    }
    // Run the login probe under the nvm-matched node so shebang-based CLIs resolve correctly
    const nvmBinDir = resolveNvmBinDir(bin);
    const probeEnv = augmentPathEnv({});
    if (nvmBinDir) probeEnv.PATH = `${nvmBinDir}${path.delimiter}${probeEnv.PATH}`;
    const probe = await BaseTaskAgent.runCliProbe(bin, ['auth', 'status'], { env: probeEnv });
    if (probe.error) {
      if (probe.error.code === 'ENOENT') {
        return { id: this.id, label: this.label, available: false, reason: 'Claude CLI not found' };
      }
      console.log(`[task-agent:detect] claude auth probe spawn error: ${probe.error.code || probe.error.message}`);
      return { id: this.id, label: this.label, available: false, reason: 'Claude is not logged in' };
    }
    const status = parseClaudeAuthStatus(probe.output);
    if (status.loggedIn) {
      // Warm the headersHelper probe off the spawn path (memoized; failures resolve false).
      void ClaudeAgent._cliSupportsHeadersHelper(config);
      return { id: this.id, label: this.label, available: true };
    }
    // Server-log the raw probe result — a false negative here (keychain locked at
    // login, CLI mid-auto-update) is invisible to the user otherwise.
    console.log(
      `[task-agent:detect] claude auth probe reported not-logged-in ` +
      `(exit=${probe.status}): ${String(probe.output || '').slice(0, 200)}`
    );
    return { id: this.id, label: this.label, available: false, reason: 'Claude is not logged in' };
  }
}

module.exports = ClaudeAgent;
