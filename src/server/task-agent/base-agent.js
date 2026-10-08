'use strict';

const { spawn } = require('node:child_process');
const { killProcessGroup, AGENT_LIMIT_DEFAULTS } = require('../process-group');
const { buildLanguageDirective } = require('../project-config');
const { matchPromptLine, GENERIC_PROMPT_PATTERNS } = require('./prompt-detect');
const { localizeAttachments } = require('./attachments');
const { fetchStatusRoles, fetchStatusNames, LEGACY_STATUSES, LEGACY_ROLE_NAMES } = require('../status-roles');
const { fetchVcsSettings, buildVcsDirective } = require('../vcs-settings');
const { fetchTagDescriptions, buildTagDescriptionDirective } = require('../tag-descriptions');
const { resolveModels } = require('./model-registry');
const { winExecSpec } = require('../spawn-utils');

function combineCommandOutput(stdout, stderr) {
  const out = stdout ? String(stdout) : '';
  const err = stderr ? String(stderr) : '';
  return `${out}\n${err}`.trim();
}

const DETECT_TTL_MS = 300_000; // 5 minutes — cached positives (stale-while-revalidate)
// Cached negatives expire fast and re-detect before a gate returns — a stale "unavailable"
// poisoned at startup (e.g. keychain not yet unlocked at login, CLI mid-auto-update)
// must never be served for long at user-facing gates (task start, setup wizard).
const NEGATIVE_DETECT_TTL_MS = 30_000; // 30 seconds
// Ceiling for one asynchronous CLI probe (login status etc.) — see runCliProbe(). Every probe
// builds its argv through spawn-utils.js's winExecSpec(): a Windows .cmd/.bat launcher (npm's
// claude.cmd / codex.cmd, possibly in a path with spaces) runs as `cmd.exe /d /s /c "…"` with
// every part quoted — never `shell: true`, which hands cmd.exe the path unquoted.
const CLI_PROBE_TIMEOUT_MS = 10_000;
const CLI_PROBE_OUTPUT_BYTES = 64 * 1024;
// Cap for the diagnostic `detail.output` on an unavailable detect() result — see buildDetectDetail().
const DETECT_DETAIL_OUTPUT_CHARS = 200;

function commentType(comment) {
  return String(comment?.comment_type || comment?.commentType || comment?.type || 'comment');
}

function commentTimestamp(comment) {
  const raw = comment?.created_at || comment?.createdAt || 0;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function commentId(comment) {
  const n = Number(comment?.id);
  return Number.isFinite(n) ? n : 0;
}

// Shared filter+sort+line-format core behind both formatTaskCommentsBlock() (no type filter —
// every comment) and formatParentTaskBlock() below (PARENT_COMMENT_TYPES — spec/comment only).
// types === null means "no type filter".
function commentLines(comments, types) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const sorted = comments
    .filter(c => c && typeof c.content === 'string' && c.content.trim())
    .filter(c => !types || types.has(commentType(c)))
    .sort((a, b) => {
      const aSpec = commentType(a) === 'spec' ? 0 : 1;
      const bSpec = commentType(b) === 'spec' ? 0 : 1;
      if (aSpec !== bSpec) return aSpec - bSpec;
      const timeDelta = commentTimestamp(a) - commentTimestamp(b);
      if (timeDelta !== 0) return timeDelta;
      return commentId(a) - commentId(b);
    });
  return sorted.map(c => `**${c.user?.name || 'Unknown'} (${c.created_at || c.createdAt || 'unknown time'}):** ${c.content.trim()}`);
}

// ── Parent task context injection (C1575) ──
// Exclude resolution comments from parent context: session exit auto-posts a
// machine-generated comment under that type when a child ends without its own report,
// and it must not reach every sibling subtask's kickoff prompt.
const PARENT_COMMENT_TYPES = new Set(['spec', 'comment']);
// Pi-only truncation marker — see fitParentTaskBlock() below.
const PARENT_BLOCK_TRUNCATION_MARKER = '\n\n… (parent context truncated)';

// TPT286 — per-task reasoning effort levels. Mirror of the API's EFFORT_LEVELS
// (api/src/lib/task-service.js, TPT284): ai/todo/server is a separate repo and cannot
// require across the gitlink, so keep the two lists in sync by hand.
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max']);

class BaseTaskAgent {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.approvalCommand = '/approve-plan';
    this.supportsPlanMode = false;
    this._detectResult = null;
    this._detectTs = 0;
    this._detectInflight = null;
    this._detectInflightClearedBin = false;
    this._detectFollowup = null;
  }

  // Spawn prompts are assembled synchronously by each adapter's buildPrompt(), but
  // attachment localization needs network I/O. Keep that contract intact: every
  // terminal adapter awaits this shared preparation step before calling buildPrompt().
  // This is also the single path that turns legacy inline data images into local files
  // for Claude, Codex, and Pi.
  async localizeSpawnPrompt(config, prompt, taskId, opts = {}) {
    const originalComments = opts.taskCommentsBlock || '';
    const localized = await localizeAttachments({
      taskId,
      prompt,
      taskCommentsBlock: originalComments,
      projectRoot: opts.projectPath || config.PROJECT_ROOT,
    });
    return {
      prompt: localized.prompt,
      opts: localized.taskCommentsBlock !== originalComments
        ? { ...opts, taskCommentsBlock: localized.taskCommentsBlock }
        : opts,
    };
  }

  getInteractiveReadyMs() { return 1500; }

  // Project-language directive for agent prompts (C942). Resolves the project
  // root the same way getSpawnSpec does; '' when language is 'en' or unset.
  getLanguageDirective(config, opts = {}) {
    const projectRoot = opts.projectPath || (config && config.PROJECT_ROOT);
    return buildLanguageDirective(projectRoot);
  }

  // ── Workflow-role status resolution (C1184) ──
  // buildPrompt() is SYNC in every agent subclass; the project's status registry read
  // (backend.getStatuses()) is ASYNC. Split accordingly: resolveStatusRoles() runs once
  // per spawn (in getSpawnSpec()/terminal-session.js, before buildPrompt() is called)
  // and produces a plain { start, in_progress, complete } name map; resolveStatusForRole()
  // is a pure sync lookup against that map, called from inside buildPrompt() via
  // opts.statusRoles. Fail-open end to end — see status-roles.js's fetchStatusRoles():
  // a registry fetch failure (file backend, network hiccup, older API server) never
  // throws, it returns the legacy role names, so a status hiccup never blocks a spawn
  // and never changes the rendered prompt for a project that hasn't customized statuses.
  static async fetchStatusRoles(backend) {
    return fetchStatusRoles(backend);
  }

  static async fetchStatusNames(backend) {
    return fetchStatusNames(backend);
  }

  // role ∈ 'start' | 'in_progress' | 'complete'. opts.statusRoles is the map produced by
  // fetchStatusRoles() above (threaded through getSpawnSpec()'s opts into buildPrompt()).
  // No opts.statusRoles at all (unit test, a caller that didn't thread it) → legacy name,
  // so prompts stay byte-identical to pre-C1184 whenever the caller doesn't opt in.
  resolveStatusForRole(role, opts = {}) {
    return (opts.statusRoles && opts.statusRoles[role]) || LEGACY_ROLE_NAMES[role];
  }

  // ── Per-task effort (TPT286) ──
  // The one place every agent reads task.effort (threaded into getSpawnSpec() as opts.task by
  // terminal-session.js). Returns a canonical EFFORT_LEVELS entry, or null when the task, the
  // field, or its value is absent/unknown — null means "inherit the agent's own default".
  // Unknown values are dropped rather than passed on: the result lands in argv/env.
  // Each agent maps the level onto its own CLI setting (see claude-agent.js/codex-agent.js).
  resolveEffort(task) {
    const raw = task && typeof task.effort === 'string' ? task.effort.trim().toLowerCase() : '';
    return EFFORT_LEVELS.includes(raw) ? raw : null;
  }

  // Full ordered status-name list for this project (used where a prompt enumerates every
  // status, e.g. pi-agent's REST recipe). No opts.statusNames → legacy 5 names.
  resolveStatusNames(opts = {}) {
    return (Array.isArray(opts.statusNames) && opts.statusNames.length > 0)
      ? opts.statusNames
      : LEGACY_STATUSES.map(s => s.name);
  }

  // ── Project VCS settings (C1215) ──
  // Same async-resolve-once/sync-read split as the status-role pair above:
  // fetchVcsSettings() runs once per spawn (terminal-session.js's spawnTerminal(),
  // fail-open — see vcs-settings.js) and is threaded through getSpawnSpec()'s opts into
  // buildPrompt() as opts.vcsSettings; resolveVcsDirective() is the pure sync read.
  // No opts.vcsSettings at all (unit test, an out-of-tree caller that didn't thread it)
  // → '' — same absent-key fallback contract status-roles.js gives when opts.statusRoles
  // is absent. C1561: buildVcsDirective() no longer has a '' branch of its own (VCS_OFF
  // now renders a real prohibition block) — this guard is the ONLY place '' still comes
  // from, and only when the key itself was never threaded through. A real spawn always
  // resolves and threads a real vcsSettings object (terminal-session.js), even for a
  // VCS-off project, so every real kickoff prompt gets a directive.
  static async fetchVcsSettings(backend) {
    return fetchVcsSettings(backend);
  }

  resolveVcsDirective(opts = {}) {
    if (this.id === 'codex' && opts.vcsContext) return require('../vcs-context').buildVcsContextDirective(opts.vcsContext);
    return opts.vcsSettings ? buildVcsDirective(opts.vcsSettings) : '';
  }

  // ── Tag-description backfill directive (C1513) ──
  // Same async-resolve-once/sync-read split as the VCS pair above: fetchTagDescriptions()
  // runs once per spawn (terminal-session.js, fail-open — see tag-descriptions.js) and is
  // threaded through getSpawnSpec()'s opts as opts.tagDescriptions; buildTagDescriptionDirective()
  // is the pure sync read, called from inside buildPrompt(). No opts.tagDescriptions at all
  // (unit test, an out-of-tree caller that didn't thread it) -> '' — the exact same
  // byte-identical-prompt fallback resolveVcsDirective() gives when opts.vcsSettings is absent.
  // Overridable per-agent — pi-agent.js overrides it for compact/no-MCP wording, same as it
  // overrides resolveVcsDirective().
  static async fetchTagDescriptions(backend, taskTags) {
    return fetchTagDescriptions(backend, taskTags);
  }

  buildTagDescriptionDirective(opts = {}) {
    return buildTagDescriptionDirective(opts.taskTags, opts.tagDescriptions);
  }

  // Always include process-safety rules; they need no project data. Compact wording
  // preserves both rules within Pi's prompt budget. npm lifecycle re-exec changes
  // descendant argv, so abort background work by captured PID/process group.
  buildProcessSafetyDirective(opts = {}) {
    if (opts.compact) {
      return [
        'Process safety:',
        '- Before any `npm run` command, check `node --version` against this project\'s pinned Node (`.nvmrc`/`.tool-versions`/`engines.node`) and switch first — a mismatched npm can silently recurse and exhaust the machine.',
        '- Abort a backgrounded command by its PID or process group only, never `pkill -f "<command text>"` — npm\'s lifecycle re-exec drops the outer command text from descendant argv.',
      ].join('\n');
    }
    return [
      'Process safety:',
      '- Before running any `npm run` command (build/typecheck/test/etc.), verify the active Node matches this project\'s pinned version (check `.nvmrc`, `.tool-versions`, or `engines.node` against `node --version`) and switch to it first. A stale ambient npm can silently ignore `--workspace`/`--workspaces` flags and let a self-referential script recurse without bound — this has previously produced thousands of runaway processes and exhausted a real machine.',
      '- To abort a backgrounded command, kill it by the PID or process group you captured when starting it — never by matching the command-line text (`pkill -f "..."`). npm\'s internal lifecycle re-exec replaces each descendant\'s argv with just the currently-running script name, so a substring match on the original command can never catch a runaway recursive chain.',
    ].join('\n');
  }

  // Always include standing-KB versus task-resolution guidance. Pi receives compact,
  // MCP-free wording because its kickoff prompt is echoed and size-limited.
  buildKbHygieneDirective(opts = {}) {
    if (opts.compact) {
      return [
        'KB hygiene:',
        '- ai/architecture/*.md holds standing system concepts only — what a module is for and how it works today, written for a reader who never saw this task.',
        '- Task-specific material never goes there: investigation notes, evidence tables, dated findings, corrections of your own earlier analysis. Put those in the resolution comment instead.',
        '- Keep a KB line only if it stays true and useful once this task is forgotten. Anything else belongs in the resolution comment.',
      ].join('\n');
    }
    return [
      'KB hygiene:',
      '- `ai/architecture/*.md` is reference material about how this system works — standing concepts only: module responsibilities, schema, endpoints, file inventories, invariants, and gotchas that stay true after this task ships. Write every line for a reader who has never heard of this task.',
      '- Never put task-specific material in a KB file: investigation logs, evidence tables, query output, dated findings, "correction after reviewing the data" passages, before/after narratives, or anything that reads as an update to your own earlier analysis. All of that goes in `create_task_comment(task_key, content, type: "resolution")` on this task instead.',
      '- Test every KB line before writing it: would it still be worth reading a year from now, with this task long forgotten? Yes → KB. No → resolution comment.',
      '- To see how similar work was resolved before, call `list_task_resolutions(tags=[...])`. Past-task narrative lives in task comments by design — do not go looking for it in `ai/architecture/*.md`, and do not add it there.',
    ].join('\n');
  }

  // Spawn-side half of the agent resource limits: states the same sub-agent cap the descendant
  // watchdog enforces (process-group.js#resolveAgentLimits), so an agent stays inside it instead
  // of being caught after the fact. `limits` is the resolved object terminal-session.js threads
  // through as opts.agentLimits; a missing or invalid maxSubagents falls back to the default, so
  // the directive is always present. Pure — no env or config read here.
  buildResourceLimitsDirective(limits, opts = {}) {
    const raw = limits && limits.maxSubagents;
    const cap = Number.isSafeInteger(raw) && raw > 0 ? raw : AGENT_LIMIT_DEFAULTS.maxSubagents;
    if (opts.compact) {
      return [
        'Resource limits:',
        `- Run at most ${cap} sub-agents or background commands in parallel, counted together; run test and build commands one at a time, never in parallel.`,
        '- Stop all background work you started before finishing.',
      ].join('\n');
    }
    return [
      'Resource limits:',
      `- Run at most ${cap} sub-agents or background commands in parallel, counted together. Wait for one to finish before starting another, and do the work in this session when it fits here instead of delegating it. Task App watches this session's process tree and may pause or stop a session that goes past its limits.`,
      '- Never run test or build commands in parallel — one at a time, each finished before the next starts, and never a second run of a suite that is still running.',
      '- Before finishing, stop every background command and sub-agent you started (by the PID or process group you captured) and confirm nothing is left running.',
    ].join('\n');
  }

  // A question batch precedes the plan and uses a separate sentinel: plan readiness is
  // latched once per session, and planReady outranks attention in a shared output tail.
  // Keep the directive safe when echoed into agent output: no bare sentinel line,
  // question mark, approval prompt, or numbered option that matches dialog detection.
  // Lettered options avoid the numbered-row detector; compact wording fits Pi's budget.
  buildClarifyDirective(opts = {}) {
    if (opts.compact) {
      return [
        'Clarifying questions:',
        '- You have no question tool and no picker here. Ask only when the task says to, or when a choice would change the plan and nothing in the task or the repo settles it — otherwise decide and note it as an Assumption line in the plan.',
        '- Ask in plain text before the plan — the one exception to writing the plan immediately — and never in the same response as the plan or its plan-ready line: a numbered list of 3-5 questions, each with 2-5 indented options lettered A) B) C), likeliest first, the last always an open "something else", and one line above the list saying the user can reply with letters like 1A 2C or their own wording; then stop, the last line of that response, alone on it, reading exactly the words Questions ready. — the next line typed into this terminal is the user\'s reply, and you resume from there, batch by batch.',
      ].join('\n');
    }
    return [
      'Clarifying questions:',
      '- You have no question tool and no interactive picker in this terminal. Ask the user only when the task tells you to, or when a choice would change the shape of the plan and nothing in the task text, its comments or the repo settles it. Anything you could settle by reading is not a question — read it and move on.',
      '- Ask by writing a plain numbered text list, one question per line with no box-drawing or cursor-marker characters, 3-5 questions per batch, giving every question 2-5 indented option lines lettered A) B) C) — concrete alternatives, likeliest first, the last one always an open "something else" choice — and one short line before the list saying the user can answer with letters like 1A 2C or type their own wording instead, then end that response immediately after the list with no further prose and no further tool calls, making its very last line, by itself with nothing else on it, read exactly the words Questions ready. — the next line typed into this terminal is the user\'s reply, and you resume from there, repeating this list-then-stop pattern for any follow-up batch until every question is answered.',
      '- A question batch is the one exception to writing the plan immediately: it comes before the plan and replaces it for that response — no plan text, no partial plan, and never the plan-ready line alongside questions. That line belongs only to the response carrying the finished plan; Task App latches it once per session, so one emitted before the answers arrive cannot be withdrawn and will not fire again after you revise the plan.',
      '- Never stall on a question you can answer yourself, and never wait on an answer you did not actually ask for. When the choice is minor, or the user has already told you to decide, skip the batch: write the plan and record the call as an explicit Assumption line inside it.',
    ].join('\n');
  }

  // Task status depends on this task's scope and verification, not unrelated work.
  // Use workflow concepts rather than literal status names so custom registries still work.
  // Compact wording is echoed by Pi: no MCP names, questions, or readiness sentinels.
  buildTaskStatusDirective(opts = {}) {
    if (opts.compact) {
      return [
        'Task status scope:',
        '- Complete only when this task\'s scope and checks pass; own regressions block.',
        '- Unrelated tasks or suite failures are caveats, not blockers, unless user/task explicitly links them. Check relevance; report evidence in resolution and reply.',
      ].join('\n');
    }
    return [
      'Task status scope:',
      '- Decide this task\'s completion or blocked status from its own requested scope and task-local verification. Complete only when that scope is fully implemented and relevant checks pass; incomplete scope, relevant failures, and regressions caused by your changes block completion.',
      '- Unrelated unfinished tasks and unrelated failures in a broad test suite are caveats, not blockers for this task, unless the user or task explicitly connects them to its acceptance criteria. Report these caveats and the evidence for treating them as unrelated in this task\'s resolution comment and final reply.',
      '- Investigate a failure\'s relevance before classifying it; never assume it is unrelated merely because it occurs outside the files you edited. Deferring requested work to another task does not make this task complete.',
    ].join('\n');
  }

  // ── Shared directive assembly ──
  // The single place every adapter's buildPrompt() gets its common directives from, so a new
  // or reordered directive is one edit here instead of three hand-synced call sites.
  //
  // getPreamblePolicy() is the explicit per-agent wording policy:
  //   compact — short, no-MCP-names, echo-safe wording for a tightly budgeted kickoff prompt
  //             that is echoed verbatim into the agent's own TUI (Pi).
  //   clarify — whether the agent needs the text clarifying-question mechanism at all. false
  //             for an agent with a native question tool (Claude's AskUserQuestion).
  // Base default is "full wording, text questions" — what an agent with MCP but no question
  // tool needs (Codex). Override per agent rather than passing knobs at call sites.
  getPreamblePolicy() {
    return { compact: false, clarify: true };
  }

  // Returns SLOTS, never a joined string: framing, separators and placement differ per adapter
  // (Claude joins with blank lines inside one template, Codex/Pi splice array lines, and Pi
  // places the directives after its grep note where Codex places them before), so each
  // buildPrompt() keeps ownership of where the slots land.
  //   directives — [vcs, tagDesc, processSafety, resourceLimits, kbHygiene, taskStatus] in that
  //                fixed order, empties dropped, so absent optional data (no opts.vcsSettings,
  //                nothing blank in opts.tagDescriptions) emits no directive and no stray
  //                separator. resourceLimits reads opts.agentLimits and is never empty.
  //   clarify    — deliberately NOT part of `directives`: it must sit directly beside the
  //                adapter's own plan-ready instruction (see buildClarifyDirective's ORDERING
  //                note). '' when the policy says the agent has a native question tool.
  // The individual strings are returned too, for an adapter that needs to place one alone.
  // resolveVcsDirective()/buildTagDescriptionDirective() are reached through `this`, so a
  // subclass override (pi-agent.js's compact/REST wording) still applies.
  // SIMPLE_MODE and Claude's Design Mode are NOT handled here — adapters return early, before
  // calling this, exactly where they always skipped the directives.
  buildSharedPreamble(opts = {}) {
    const policy = this.getPreamblePolicy();
    const variant = policy.compact ? { compact: true } : {};
    const vcs = this.resolveVcsDirective(opts);
    const tagDesc = this.buildTagDescriptionDirective(opts);
    const processSafety = this.buildProcessSafetyDirective(variant);
    const resourceLimits = this.buildResourceLimitsDirective(opts.agentLimits, variant);
    const kbHygiene = this.buildKbHygieneDirective(variant);
    const taskStatus = this.buildTaskStatusDirective(variant);
    const clarify = policy.clarify ? this.buildClarifyDirective(variant) : '';
    return {
      vcs,
      tagDesc,
      processSafety,
      resourceLimits,
      kbHygiene,
      taskStatus,
      directives: [vcs, tagDesc, processSafety, resourceLimits, kbHygiene, taskStatus].filter(Boolean),
      clarify,
    };
  }

  // Idle-silence window (ms) used by the terminal-session paste-injection detector (C947):
  // once the PTY has emitted no onData for this long, the pending phase (paste or Enter)
  // fires. Override per-agent to tune for slower/faster TUIs.
  getPasteSilenceMs() { return 400; }

  // Pattern that, while present in the rolling PTY tail after the submit Enter, shows the pasted
  // kickoff is still sitting unsent in the input box (terminal-session.js's submit verification).
  // null (default) = this agent has no such on-screen marker, so its Enter is never re-sent.
  getUnsentPasteRe() { return null; }

  // Writes a locally-saved clipboard image's path into the PTY so the agent attaches it
  // (C809/C1003/C1051). Default: bare absolute path inside a bracketed-paste frame — no `@`,
  // no quotes, no trailing newline, left on the input line (not auto-submitted). Confirmed
  // against the installed Claude Code CLI by reading its bundled JS: a bracketed-paste line
  // matching `/\.(png|jpe?g|gif|webp)$/i` is read straight off disk and attached, no `onData`
  // round-trip required. Override per-agent if `scripts/probe-image-paste.js` finds a
  // different convention (e.g. Codex's `attach_image` path parsing may differ).
  injectImagePath(session, localPath) {
    session.pty.write('\x1b[200~' + localPath + '\x1b[201~');
  }

  // Regex tested against fresh PTY output (stripAnsi'd) to confirm an injected image actually
  // attached, so injectPastedImage() can report a real failure instead of assuming success.
  // Confirmed via scripts/probe-image-paste.js: Claude Code renders "[Image#N]" — no space
  // between "Image" and "#" in the actual terminal buffer (the space visible in the CLI's own
  // source strings is styling between two adjacent segments, not a literal character) — so
  // `\s*` tolerates both. Override per-agent if a probe run finds a different marker.
  getImageAttachMarkerRe() { return /\[Image\s*#\d+\]/; }

  // Line-scoped attention detector (C1057). Called once per freshly-carved output line by
  // terminal-session.js's feedAttentionChunk() (via matchPromptLines() below) — separate from
  // and does not affect the tail-scoped getAttentionPromptMatch() used for paste-injection
  // gating (see prompt-detect.js's HARD RULE). Returns null, or { kind, promptText } where
  // kind is 'attention' | 'toolApproval' | 'mcpTrust' | 'planReady' and promptText is already
  // sanitized (prompt-detect.js#sanitizePromptText) and safe to put on the wire / in a
  // notification. Base implementation covers agent-agnostic prompt wording; override per
  // agent to add CLI-specific patterns (see claude-agent.js / codex-agent.js / pi-agent.js).
  isPromptLine(line) {
    return matchPromptLine(line, GENERIC_PROMPT_PATTERNS);
  }

  // Runs isPromptLine() over every freshly-carved line in an output chunk; the LAST match
  // wins, so the most recent question is what gets reported (a chunk can render more than
  // one line, e.g. a multi-line dialog redraw).
  matchPromptLines(lines) {
    let hit = null;
    for (const line of lines) {
      const m = this.isPromptLine(line);
      if (m) hit = m;
    }
    return hit;
  }

  // eslint-disable-next-line no-unused-vars
  buildPrompt(prompt, opts) { throw new Error(`${this.id}: buildPrompt not implemented`); }
  // eslint-disable-next-line no-unused-vars
  getSpawnSpec(config, prompt, taskId, opts) { throw new Error(`${this.id}: getSpawnSpec not implemented`); }

  // ── Live model registry (C1504) ──
  // getAvailableModels() is the one entry point callers use (task-agent/index.js's
  // listAgentModels(), the GET /api/agent-models route) — it's concrete here and delegates
  // to model-registry.js's resolveModels(), which owns caching/coalescing/disk persistence
  // so every agent gets that for free. probeModels()/getModelProbeKey() are the per-agent
  // hooks a subclass overrides; base defaults (empty probe, no key) mean an agent that
  // doesn't implement discovery (pi-agent.js) just always falls through to
  // model-registry.js's fallbackModels() static list — never throws, never blocks a spawn.
  // Async on purpose: model and availability probes both do I/O off the event loop.
  async getAvailableModels(config, opts = {}) {
    return resolveModels(this, config, opts);
  }

  // eslint-disable-next-line no-unused-vars
  async probeModels(config) { return []; }

  // eslint-disable-next-line no-unused-vars
  getModelProbeKey(config) { return ''; }

  // C1260 — optional slash-command prelude a spawn wants run as its OWN PTY submission
  // before the task prompt (e.g. Claude's per-task /design mode). A slash command fused
  // into the same paste as a multi-line body never executes as a command — terminal-
  // session.js's injector must paste+Enter this alone, wait for it to finish, THEN
  // paste+Enter the task prompt. Default '' (no prelude) keeps every non-Claude agent,
  // and Claude spawns with designMode off, on the original single-paste path unchanged.
  // eslint-disable-next-line no-unused-vars
  buildPreludePrompt(opts) { return ''; }
  // eslint-disable-next-line no-unused-vars
  approvePlan(session, config) { throw new Error(`${this.id}: approvePlan not implemented`); }
  // eslint-disable-next-line no-unused-vars
  async detect(config) { throw new Error(`${this.id}: detect not implemented`); }

  // (TPT354) The agent CLI's own final assistant message for the run that `session` spawned,
  // read from its session transcript — feeds the auto-posted exit resolution comment
  // (exit-resolution.js) so it carries what the agent said instead of a terminal-screen scrape.
  // Returns `{ text, turnEnded }` or null when unsupported/unlocatable. Must never throw and
  // must be cheap (a file read, no network). Base default: unsupported → the comment falls back
  // to the sanitized PTY tail.
  readFinalMessage(session) { return null; }

  // ── Plan-approval hardening hooks (C1117) ──
  // All four are opt-in — base defaults reproduce today's fire-and-forget behavior exactly
  // (claude-agent.js / codex-agent.js use the defaults, only pi-agent.js overrides). Extracted
  // so terminal-session.js's approvePlan() can stay agent-agnostic while giving Pi a real
  // post-approval watchdog: a degenerate model reply (e.g. a leaked chat-template token like
  // Kimi K3's bare `<|sep|>`) otherwise looks identical to a healthy approval from the PTY's
  // point of view — see tt-pi-session.md § Plan approval PTY protocol (C1117).

  // The literal text written into the PTY on plan approval. Override to send something more
  // substantive than the default one-liner (e.g. a model that needs an explicit "don't re-ask"
  // nudge).
  getApprovalText() { return 'Plan approved. Implement the approved plan now.'; }

  // Milliseconds after approvePlan() to check whether the approval actually landed. 0 (default)
  // disables the watchdog entirely — terminal-session.js never arms a timer for an agent that
  // returns 0.
  getApprovalWatchdogMs() { return 0; }

  // Called once when the watchdog fires. `ctx = { growthBytes, tail, idleMs }` — growthBytes is
  // how much session.buffer grew since approval, tail is the raw rolling PTY tail
  // (session._attentionTail), idleMs is time since the PTY last produced output. Return true to
  // treat this as a stalled/degenerate approval (triggers a notice + retryApproval()).
  // eslint-disable-next-line no-unused-vars
  approvalStalled(session, ctx) { return false; }

  // Re-attempt approval once after a stalled watchdog fires. No-op by default.
  // eslint-disable-next-line no-unused-vars
  retryApproval(session) {}

  // One in-flight probe per agent instance. Every fresh-result caller joins it, including
  // a forced Re-Check racing a stale refresh. Failures become short-lived negatives so a
  // rejected Promise cannot strand the cache or suppress a later retry.
  _refreshDetect(config, { clearBin = false } = {}) {
    if (this._detectInflight) {
      if (!clearBin || this._detectInflightClearedBin) return this._detectFollowup || this._detectInflight;
      // A forced Re-Check racing an automatic stale-positive probe must observe a
      // lookup after binary-cache invalidation. Coalesce all such callers on one
      // sequential follow-up, keeping only one child probe alive at a time.
      if (!this._detectFollowup) {
        this._detectFollowup = this._detectInflight.then(() => {
          this._detectFollowup = null;
          return this._refreshDetect(config, { clearBin: true });
        });
      }
      return this._detectFollowup;
    }
    if (clearBin) {
      try { require('../spawn-utils').clearBinCache(this.id); } catch { /* best-effort */ }
    }
    this._detectInflightClearedBin = clearBin;
    const probe = Promise.resolve().then(() => this.detect(config)).then((result) => {
      if (!result || typeof result.available !== 'boolean') throw new Error('invalid detection result');
      return this._storeDetect(result, Date.now(), config);
    }).catch((err) => this._storeDetect({
        id: this.id, label: this.label, available: false,
        reason: `${this.label} detection failed`,
        detail: BaseTaskAgent.buildDetectDetail(null, { error: err }),
      }, Date.now(), config)).finally(() => {
      if (this._detectInflight === probe) {
        this._detectInflight = null;
        this._detectInflightClearedBin = false;
      }
    });
    this._detectInflight = probe;
    return probe;
  }

  // Gate read. A stale positive is returned at once and refreshed once in background;
  // an expired negative or a cold cache awaits a probe before the caller decides.
  async cachedDetect(config, force = false) {
    const now = Date.now();
    if (force) return this._refreshDetect(config, { clearBin: true });
    if (this._detectResult === null) return this._refreshDetect(config);
    const age = now - this._detectTs;
    if (!this._detectResult.available) {
      if (age >= NEGATIVE_DETECT_TTL_MS) return this._refreshDetect(config, { clearBin: true });
      return this._detectResult;
    }
    if (age >= DETECT_TTL_MS) {
      void this._refreshDetect(config);
    }
    return this._detectResult;
  }

  // Informational read stays synchronous. A cold read reports detection pending and starts
  // one async probe; an expired negative is served while one async retry runs.
  peekDetect(config) {
    if (this._detectResult === null) {
      void this._refreshDetect(config);
      return { id: this.id, label: this.label, available: false, reason: `${this.label} detection pending` };
    }
    if (!this._detectResult.available && Date.now() - this._detectTs >= NEGATIVE_DETECT_TTL_MS) {
      void this._refreshDetect(config, { clearBin: true });
    }
    return this._detectResult;
  }

  // Store a detect() result + log availability flips (diagnosis aid: a silent
  // available→unavailable transition was the root of a 27h false-negative).
  // `config` is optional — only the unavailable→available re-probe below needs it.
  _storeDetect(result, ts, config) {
    const prev = this._detectResult;
    if (prev && !!prev.available !== !!result.available) {
      console.log(
        `[task-agent:detect] ${this.id} availability changed: ` +
        `${prev.available ? 'available' : `unavailable (${prev.reason || 'no reason'})`} -> ` +
        `${result.available ? 'available' : `unavailable (${result.reason || 'no reason'})`}`
      );
    }
    this._detectResult = result;
    this._detectTs = ts;
    if (prev && !prev.available && result.available) this._reprobeModelsAfterInstall(config);
    return result;
  }

  // A CLI that was absent when the server booted left the model registry holding the static
  // fallback list (model-registry.js caches it, and mirrors it to disk, with an empty probe
  // key). Nothing on the read path ever re-probes a cached entry — peekModels() is cache-only
  // by design — so the moment the agent flips unavailable→available is the one event that
  // says "the live catalog is now reachable". Fire-and-forget: resolveModels() coalesces
  // concurrent callers per agent and never throws, and a probe (streamed binary scan / CLI
  // subcommand) is async I/O that must not delay whichever read observed the flip.
  // Skipped without a real server config (USER_DATA_ROOT is where the registry persists), so a
  // bare `{}` in a unit test can never trigger a probe.
  _reprobeModelsAfterInstall(config) {
    if (!config || !config.USER_DATA_ROOT) return;
    this.getAvailableModels(config, { force: true }).catch(() => { /* keep the fallback list */ });
  }

  // opts.spawnImpl (default child_process.spawn) and opts.isWin (default: the real platform)
  // are test-only injection points so the win32 argv shape is verifiable on any host.
  // Diagnostic payload carried on every `available: false` detect() result (TPT567) so a
  // packaged app — whose server stdout nobody sees — can still show WHICH layer failed:
  // `bin` is the launcher resolveBin()/resolveBinAsync() settled on (null = not found),
  // `exit` the probe's exit status (null when it never ran or was killed), `output` the
  // first DETECT_DETAIL_OUTPUT_CHARS of the probe's combined stdout+stderr, or the spawn
  // error code/message when there was no output. Rendered by agent-select.js under the
  // reason text; printed by scripts/probe-agent-detect.js. Never present on a positive.
  static buildDetectDetail(bin, probe) {
    const err = probe && probe.error;
    const output = String(
      (probe && probe.output) || (err && (err.code || err.message)) || ''
    ).trim().slice(0, DETECT_DETAIL_OUTPUT_CHARS);
    return {
      bin: bin || null,
      exit: probe && Number.isInteger(probe.status) ? probe.status : null,
      output,
    };
  }

  static runCliProbe(command, args, opts = {}) {
    const {
      signal, timeout = CLI_PROBE_TIMEOUT_MS, maxOutputBytes = CLI_PROBE_OUTPUT_BYTES,
      spawnImpl = spawn, isWin, ...spawnOpts
    } = opts;
    return new Promise((resolve) => {
      let child;
      let error = null;
      let bytes = 0;
      const stdout = [];
      const stderr = [];
      let settled = false;
      let timer;
      let stopBackstop;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(stopBackstop);
        if (signal) signal.removeEventListener('abort', abort);
        resolve({ error, status, output: combineCommandOutput(Buffer.concat(stdout), Buffer.concat(stderr)) });
      };
      const stop = (code) => {
        if (!error) error = Object.assign(new Error(`CLI probe ${code}`), { code });
        if (child && child.pid && !killProcessGroup(child.pid, 'SIGKILL')) {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
        if (!stopBackstop) stopBackstop = setTimeout(() => {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish(null);
        }, 500);
      };
      const abort = () => stop('ABORT_ERR');
      try {
        const spec = winExecSpec(command, args, isWin === undefined ? {} : { isWin });
        child = spawnImpl(spec.command, spec.args, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          detached: process.platform !== 'win32',
          ...spec.options,
          ...spawnOpts,
        });
      } catch (err) {
        error = err;
        finish(null);
        return;
      }
      const collect = (parts, chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) { stop('ENOBUFS'); return; }
        parts.push(chunk);
      };
      child.stdout?.on('data', (chunk) => collect(stdout, chunk));
      child.stderr?.on('data', (chunk) => collect(stderr, chunk));
      child.on('error', (err) => { if (!error) error = err; });
      child.on('close', (status) => finish(status));
      timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
    });
  }

  static formatTaskCommentsBlock(comments) {
    const lines = commentLines(comments, null);
    if (lines.length === 0) return '';
    return `## Task Comments\n${lines.join('\n\n')}`;
  }

  static prependTaskComments(prompt, opts = {}) {
    if (!opts.taskCommentsBlock) return prompt;
    return `${opts.taskCommentsBlock}\n\n${prompt}`;
  }

  // ── Parent task context injection (C1575) ──
  // parentTask: the fromApi()-shaped row for this task's parent (.id = task key, .title,
  // .description) — resolved by terminal-session.js's fetchParentTaskBlock() from
  // task.parentDbId, since the API has no GET-by-numeric-id route. comments: the raw array
  // from backend.getTaskComments(parentTask.id), same shape formatTaskCommentsBlock() above
  // consumes — filtered here to PARENT_COMMENT_TYPES (spec + comment; resolution dropped,
  // see that const's comment). '' when parentTask is falsy, so a possibly-null lookup result
  // can be passed straight through.
  //
  // Guard sentence carries zero '?' characters on purpose — like every other directive in
  // this file, this block is echoed verbatim into Pi's own TUI and rescanned by
  // prompt-detect.js (see buildClarifyDirective's ECHO SAFETY note above); a '?' would risk
  // matching a GENERIC "do you want to …?" dialog pattern.
  static formatParentTaskBlock(parentTask, comments) {
    if (!parentTask) return '';
    const key = parentTask.id || parentTask.key || 'unknown';
    const title = parentTask.title || '(untitled)';
    const description = typeof parentTask.description === 'string' ? parentTask.description.trim() : '';
    const parts = [
      `## Parent Task — ${key}: ${title}`,
      'This task is a subtask of the parent task below. Use it for context only: do not implement the parent\'s scope, and never change the parent\'s status — it closes automatically once every subtask is closed.',
    ];
    if (description) parts.push(description);
    const lines = commentLines(comments, PARENT_COMMENT_TYPES);
    if (lines.length > 0) parts.push(`### Parent Task Comments\n${lines.join('\n\n')}`);
    return parts.join('\n\n');
  }

  // Pi-only truncation (C1575) — Claude/Codex thread opts.parentTaskBlock straight through
  // uncapped, same as opts.taskCommentsBlock: no prompt-size test exists for either agent,
  // and Claude additionally carries a far larger --append-system-prompt KB bundle. '' below
  // a 200-char floor: a block trimmed that hard is mostly the truncation marker, not useful
  // context, so it's dropped entirely rather than waste prompt budget on it. Same
  // hard-slice-plus-marker shape as ClaudeAgent.flattenDesignBrief() (claude-agent.js).
  static fitParentTaskBlock(block, maxChars) {
    if (!block) return '';
    if (maxChars < 200) return '';
    if (block.length <= maxChars) return block;
    const cut = Math.max(0, maxChars - PARENT_BLOCK_TRUNCATION_MARKER.length);
    return `${block.slice(0, cut).trimEnd()}${PARENT_BLOCK_TRUNCATION_MARKER}`;
  }

  static prependParentTask(prompt, opts = {}) {
    if (!opts.parentTaskBlock) return prompt;
    return `${opts.parentTaskBlock}\n\n${prompt}`;
  }
}

BaseTaskAgent.EFFORT_LEVELS = EFFORT_LEVELS;

module.exports = BaseTaskAgent;
