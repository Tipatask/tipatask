'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const BaseTaskAgent = require('./base-agent');
const config = require('../config');
const { getStaticBundle, getTaskStartupGrepBundle } = require('../static-context');
const { resolveBin, resolveBinAsync, augmentPathEnv, resolveNvmBinDir, resolveSpawnModel } = require('../spawn-utils');
const { buildCodexEnv, codexEffortArgs, toCodexEffort } = require('../codex-env');
const { matchPromptLine, CODEX_PROMPT_PATTERNS } = require('./prompt-detect');
const { parseCodexCatalog } = require('./model-registry');

// (C1504) `codex debug models` is a documented subcommand that dumps the live catalog as
// JSON (verified: exit 0, ~0.2-1.3s, {"models":[...]}) — unlike Claude, Codex genuinely has
// a machine-readable model list. execFile's default stdio is a non-tty pipe, so this never
// risks opening Codex's interactive TUI the way a bare `codex <word>` prompt would.
const MODEL_PROBE_TIMEOUT_MS = 10_000;
const MODEL_PROBE_MAX_BUFFER = 16 * 1024 * 1024; // catalog carries a per-model system prompt

function isCodexLoggedIn(output) {
  if (!output) return false;
  if (/\bnot logged in\b/i.test(output)) return false;
  return /\blogged in\b/i.test(output);
}

class CodexAgent extends BaseTaskAgent {
  getQuotaStatus(config, opts = {}) {
    return require('./codex-quota').readCodexQuota(config, opts);
  }

  constructor() {
    super('codex', 'Codex');
    this.approvalCommand = null;
  }

  // (C1057) Codex-specific prompt/dialog wording layered over the generic table — see
  // prompt-detect.js for the verified pattern list and the HARD RULE about toolApproval/
  // mcpTrust kinds.
  isPromptLine(line) {
    return matchPromptLine(line, CODEX_PROMPT_PATTERNS) || super.isPromptLine(line);
  }

  buildPrompt(prompt, opts = {}) {
    // C1575 — parent-task context (opts.parentTaskBlock), prepended ahead of this task's own
    // comments. Uncapped for Codex — no prompt-size test exists here, unlike pi-agent.js.
    const promptWithComments = BaseTaskAgent.prependParentTask(
      BaseTaskAgent.prependTaskComments(prompt, opts), opts);

    // SIMPLE_MODE: skip static bundle + preamble, return bare task prompt
    if (config.SIMPLE_MODE) return promptWithComments;

    const ttTags = (opts.taskTags || []).filter(t => t.startsWith('tt-'));
    const projectRoot = opts.projectPath || config.PROJECT_ROOT;
    const cachedTags = (opts.cachedTags || []).filter(t => t.startsWith('tt-') && !ttTags.includes(t));
    const tagNote = [
      ttTags.length > 0
        ? `Task tt-* tags: [${ttTags.join(', ')}]. Call \`get_tag_architectures(tag_names=[...])\` ONCE for the subset whose taxonomy description is plausibly relevant — skip tags whose description clearly doesn't match.`
        : 'Call `get_tag_architectures` for tags whose description is plausibly relevant. Use the tag taxonomy pre-loaded above to judge.',
      cachedTags.length > 0
        ? `Fetched in a prior session for this task — skip MCP re-fetch, content in session memory: [${cachedTags.join(', ')}].`
        : '',
      'Track loaded tags — never call twice.',
    ].filter(Boolean).join(' ');
    const grepBundle = ttTags.length >= 2 ? getTaskStartupGrepBundle(ttTags, projectRoot) : '';
    const grepNote = grepBundle
      ? `Cross-reference scan for [${ttTags.join(', ')}] is already complete — see "Pre-computed Cross-References" below. Use Grep only for identifiers absent from that section. For new batch lookups: \`batch_grep_tags(tag_names=[...], symbols=[...])\`.`
      : 'Symbol/file search across ≥2 tt-* tags: call `batch_grep_tags(tag_names=[...])` ONCE — single file scan (~30ms) replaces N sequential Grep/rg calls (~1.2s each).';
    const staticBundle = getStaticBundle(projectRoot);
    // Shared directives (VCS, tag-description backfill, process safety, resource limits, KB hygiene, task status) plus the
    // separate clarify slot — see base-agent.js#buildSharedPreamble. Codex inherits the base
    // policy: full wording, text clarifying questions.
    const { directives, clarify } = this.buildSharedPreamble(opts);
    const body = [
      'Use the Tipatask workflow for this repository.',
      'You are starting in planning mode enforced by Task App.',
      'First study the task, relevant source code, configuration files, and architecture docs.',
      'Do not implement, edit files, or run mutating commands until the user approves the plan.',
      'Do not ask whether to create a plan or wait for Shift+Tab plan mode. Write the plan immediately in normal output, then stop. After the plan, emit one final line whose only content is the words Plan ready., then wait for Task App approval before mutating files.',
      // C1527 — clarifying-questions directive, placed directly after the plan-ready
      // instruction above (mirrors pi-agent.js's PI_QUESTION_MECHANISM placement right after
      // its own plan-ready sentence): the two interact — the directive explicitly overrides
      // "Write the plan immediately" for the ask-first case — so they read together. See
      // base-agent.js#buildClarifyDirective's ORDERING note for why the two sentinels must
      // never share one response.
      clarify,
      'Project context:',
      '- Taxonomy and GENERAL.md are pre-loaded above — no need to call list_system_tags or read GENERAL.md.',
      '- Prefer the tipatask MCP server when available.',
      `- ${tagNote}`,
      '- After any code change, update ai/architecture/GENERAL.md and/or ai/architecture/{tag}.md for each tt-* tag on this task to reflect added/removed/changed endpoints, DB schema, env vars, file structure, or module behavior. Do this before marking task complete.',
      '- Before marking complete: if new module touched has no tt-* tag — call list_system_tags to verify, create tag via MCP or POST /api/tags, create ai/architecture/tt-*.md stub, add tag to task.',
      // C1184: resolve the project's actual "complete" status name (role-based)
      // instead of the hardcoded literal "completed".
      opts.vcsContext
        ? '- MANDATORY: supply ONE self-authored plain-English resolution to tipatask-local complete_task. Cover what changed and why, key files, checks, and follow-ups/caveats (none if absent). That tool posts the resolution and completion status together after verification. The automatic terminal-tail comment does not satisfy this requirement.'
        : `- MANDATORY before marking this task \`${this.resolveStatusForRole('complete', opts)}\`: post ONE self-authored resolution comment via \`create_task_comment(task_key, content, type="resolution")\`. \`content\` must be a real report, written in plain English prose — do NOT use caveman style for this comment. Cover: what changed and why, key files touched, how to verify, and follow-ups/caveats (write "none" if there are none). Separate from and required IN ADDITION TO the auto-posted terminal-tail resolution comment (a raw log dump with no explanation, posted on session exit) — that one does not satisfy this step. Post it in the SAME tool-call batch as the final status update to \`${this.resolveStatusForRole('complete', opts)}\`.`,
      ...directives,
      `- ${grepNote}`,
      '',
      ...(grepBundle ? [grepBundle, ''] : []),
      promptWithComments,
    ].join('\n');
    const langDirective = this.getLanguageDirective(config, opts);
    return `${langDirective ? `${langDirective}\n\n` : ''}${staticBundle}\n\n${body}`;
  }

  async getSpawnSpec(config, prompt, taskId, opts = {}) {
    const localized = await this.localizeSpawnPrompt(config, prompt, taskId, opts);
    prompt = localized.prompt;
    opts = localized.opts;
    // Resolve project root from the window's bound project (opts.projectPath),
    // falling back to global config. In a packaged GUI launch config.PROJECT_ROOT
    // points inside the .app bundle — cwd, Codex MCP config, and the .codex home
    // MUST be derived from the opened project. SERVER_ROOT is derived from that
    // same root so the MCP server resolves under the opened project.
    if (!opts.projectPath && process.versions.electron) {
      console.warn('[codex-agent] opts.projectPath is falsy in a packaged Electron build — falling back to config.PROJECT_ROOT (bundle path). Check WS session projectPath resolution.');
    }
    const projectRoot = opts.projectPath || config.PROJECT_ROOT;
    // Explicit CLI config override wins over inherited user/project config.toml.
    // TPT286 — a task's own effort replaces the fixed default (max -> xhigh, see codex-env.js).
    const effort = this.resolveEffort(opts.task);
    const args = effort ? codexEffortArgs(toCodexEffort(effort)) : codexEffortArgs();
    // Live-read config.json for the model (not the frozen startup config.CODEX_MODEL
    // snapshot) so a settings-page edit applies on the next spawn without a server
    // restart, and a stale exported CODEX_MODEL env var can never shadow it (C953).
    // Fallback '' preserves "blank = Codex's own default" (no --model flag).
    const _codexModel = resolveSpawnModel(opts.model, projectRoot, 'CODEX_MODEL', '');
    if (_codexModel) args.push('--model', _codexModel);
    args.push('--no-alt-screen');
    args.push(this.buildPrompt(prompt, opts));
    // Use the running install's server root (config.SERVER_ROOT, this checkout) — never a
    // project-relative path; the Task App is a standalone checkout.
    // env + CODEX_HOME/MCP wiring shared with the objective-chat Codex provider (C1029) — see codex-env.js.
    let env;
    try {
      ({ env } = buildCodexEnv({ projectRoot, taskId, term: 'xterm-256color' }));
    } catch (err) {
      throw new Error(`Unable to prepare project-local Codex MCP config: ${err.message}`);
    }
    return {
      command: config.CODEX_BIN,
      args,
      cwd: projectRoot,
      env,
      model: _codexModel,
    };
  }

  async approvePlan(session) {
    if (!session.pty) return;
    const pty = session.pty;
    const { refreshSessionVcs, buildVcsContextDirective } = require('../vcs-context');
    const context = await refreshSessionVcs(session);
    if (session.pty !== pty || !session.alive) return;
    session.pty.write(`\x1b[200~${this.getApprovalText()}\n${buildVcsContextDirective(context)}\x1b[201~`);
    setTimeout(() => {
      if (session.pty) session.pty.write('\r');
    }, 100);
  }

  // (TPT354) See BaseTaskAgent#readFinalMessage. Codex offers no way to pin its rollout file, so
  // final-message.js finds it by spawn time + this task's `Work on task <KEY>` kickoff line.
  readFinalMessage(session) {
    return require('./final-message').readCodexFinalMessage(session && session._transcriptHint);
  }

  // (C1504) See file-header comment. Live spawn first; on any failure (network down, CLI
  // too old for `debug models`, non-zero exit, bad JSON) fall back to Codex's own on-disk
  // cache mirror of the same catalog — still fresher than the hardcoded static list, just
  // not guaranteed current. Returns [] only when both sources fail, which model-registry.js
  // treats as "use the static config.js list", never as an error to surface.
  async probeModels(config) {
    const binPath = resolveBin('codex');
    if (!binPath) return [];
    const nvmBinDir = resolveNvmBinDir(config.CODEX_BIN);
    const probeEnv = augmentPathEnv({});
    if (nvmBinDir) probeEnv.PATH = `${nvmBinDir}${path.delimiter}${probeEnv.PATH}`;
    try {
      const json = await CodexAgent._runDebugModels(binPath, probeEnv);
      const parsed = parseCodexCatalog(json);
      if (parsed.length > 0) return parsed;
    } catch (err) {
      console.log(`[codex-agent] model probe spawn failed, trying on-disk cache: ${err.message}`);
    }
    try {
      const cacheFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
      return parseCodexCatalog(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    } catch {
      return [];
    }
  }

  // Codex's catalog is server-fetched and versioned by the CLI itself (etag/fetched_at), not
  // tied to a local binary path the way Claude's is — a coarse day-bucket key is enough to
  // keep "once per day" honest without invalidating a still-fresh in-memory cache on every
  // single check.
  getModelProbeKey() {
    return new Date().toISOString().slice(0, 10);
  }

  static _runDebugModels(binPath, env) {
    return new Promise((resolve, reject) => {
      execFile(binPath, ['debug', 'models'], {
        env,
        timeout: MODEL_PROBE_TIMEOUT_MS,
        maxBuffer: MODEL_PROBE_MAX_BUFFER,
      }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (parseErr) { reject(parseErr); }
      });
    });
  }

  async detect(config) {
    const bin = await resolveBinAsync('codex');
    if (!bin) {
      return { id: this.id, label: this.label, available: false, reason: 'Codex CLI not found. Install codex (npm i -g @openai/codex under node 22, or brew install codex), or set CODEX_BIN=/path/to/codex in .env.' };
    }
    // Run the login probe under the nvm-matched node so shebang-based CLIs resolve correctly
    const nvmBinDir = resolveNvmBinDir(bin);
    const probeEnv = augmentPathEnv({});
    if (nvmBinDir) probeEnv.PATH = `${nvmBinDir}${path.delimiter}${probeEnv.PATH}`;
    const probe = await BaseTaskAgent.runCliProbe(bin, ['login', 'status'], { env: probeEnv });
    if (probe.error) {
      if (probe.error.code === 'ENOENT') {
        return { id: this.id, label: this.label, available: false, reason: 'Codex CLI not found' };
      }
      return { id: this.id, label: this.label, available: false, reason: 'Codex is not logged in (or login status check failed)' };
    }
    if (isCodexLoggedIn(probe.output)) {
      return { id: this.id, label: this.label, available: true };
    }
    console.log(
      `[task-agent:detect] codex login probe reported not-logged-in ` +
      `(exit=${probe.status}): ${String(probe.output || '').slice(0, 200)}`
    );
    return { id: this.id, label: this.label, available: false, reason: 'Codex is not logged in' };
  }
}

module.exports = CodexAgent;
