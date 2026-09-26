'use strict';

const path = require('node:path');
const BaseTaskAgent = require('./base-agent');
const runtimeConfig = require('../config');
const { getStaticBundle, getTaskStartupGrepBundle } = require('../static-context');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir, resolveSpawnModel, resolvePiLaunch, resolvePiLaunchAsync } = require('../spawn-utils');
const { readProjectConfig, piDefaultEntry, piEntryForModel, piKeyEnvVars } = require('../project-config');
const { preparePiCustomEndpoint } = require('../pi-custom-endpoint');
const { matchPromptLine, PI_PROMPT_PATTERNS } = require('./prompt-detect');
const { LEGACY_STATUSES, LEGACY_ROLE_NAMES, sanitizeStatusName } = require('../status-roles');
const { buildVcsDirective } = require('../vcs-settings');
const { buildTagDescriptionDirective } = require('../tag-descriptions');

// Pi has no built-in MCP; this single fenced REST recipe keeps URL, auth, and body
// together for copying. Credentials and task key arrive through spawn env vars.
// Its text is echoed into prompt detection: avoid bare sentinels, dialog-shaped rows,
// and approval phrases. Sanitize interpolated status names before rendering.
function buildTipataskRestRecipe(opts = {}) {
  const roles = { ...LEGACY_ROLE_NAMES, ...(opts.statusRoles || {}) };
  const startName = sanitizeStatusName(roles.start);
  const inProgressName = sanitizeStatusName(roles.in_progress);
  const rawNames = Array.isArray(opts.statusNames) && opts.statusNames.length > 0
    ? opts.statusNames
    : LEGACY_STATUSES.map(s => s.name);
  // Cap the displayed list — a project with dozens of statuses shouldn't blow the
  // prompt-size budget (pi-agent.test.js asserts the whole prompt stays under 9000 chars).
  const cleanNames = rawNames.map(sanitizeStatusName).filter(Boolean);
  const namesLine = cleanNames.length > 12
    ? `${cleanNames.slice(0, 12).join(' | ')} | … (${cleanNames.length - 12} more — GET /statuses for the full list)`
    : cleanNames.join(' | ');
  return [
    '- Tipatask REST is the full replacement for those MCP tools. The env vars below are already exported in this shell (from .tipatask/config.json). Never hardcode a token, a URL or a task key, and never invent an endpoint that is not listed here.',
    '```sh',
    'TT="$API_BASE_URL/api/projects/$API_PROJECT_ID"; AUTH="Authorization: Bearer $API_TOKEN"; JSON="Content-Type: application/json"',
    '# read THIS task (all fields + tags); $TIPATASK_TASK_ID is already set to this task key',
    'curl -sS -H "$AUTH" "$TT/tasks/$TIPATASK_TASK_ID"',
    '# read comments on this task',
    'curl -sS -H "$AUTH" "$TT/tasks/$TIPATASK_TASK_ID/comments"',
    `# set status (this project's configured statuses): ${namesLine}`,
    `curl -sS -X PATCH -H "$AUTH" -H "$JSON" "$TT/tasks/$TIPATASK_TASK_ID" -d '{"status":"${inProgressName}"}'`,
    '# post a comment (type: comment | resolution | spec)',
    'curl -sS -X POST -H "$AUTH" -H "$JSON" "$TT/tasks/$TIPATASK_TASK_ID/comments" -d \'{"content":"REPORT TEXT","type":"resolution"}\'',
    '# the same PATCH also accepts: title description priority story_points type assignee due_date dependencies parent_id',
    '# list the project tag table (replaces list_system_tags / get_project_tags)',
    'curl -sS -H "$AUTH" "$TT/tags"',
    '# register a tag BEFORE putting it on a task (bulk array; description required, max 500 chars)',
    'curl -sS -X POST -H "$AUTH" -H "$JSON" "$TT/tags" -d \'{"tags":[{"name":"tt-x","description":"what module tt-x covers"}]}\'',
    '# replace this task full tag list (every name must already exist in /tags, else 400)',
    'curl -sS -X PATCH -H "$AUTH" -H "$JSON" "$TT/tasks/$TIPATASK_TASK_ID" -d \'{"tags":["tt-a","tt-b","bugfix"]}\'',
    '# other tasks: list, or read one by key',
    `curl -sS -H "$AUTH" "$TT/tasks?status=${startName}&fields=summary&limit=20"`,
    'curl -sS -H "$AUTH" "$TT/tasks/C123"',
    '# project members (for @mentions in a comment)',
    'curl -sS -H "$AUTH" "$TT/members"',
    '# push an edited architecture doc to the shared KB (file_key = repo-relative path)',
    'curl -sS -X POST -H "$AUTH" -H "$JSON" "$TT/knowledge" -d "$(jq -Rs \'{files:[{file_key:"ai/architecture/tt-x.md",content:.}]}\' < ai/architecture/tt-x.md)"',
    '```',
  ].join('\n');
}

// ── (C1134/C1217, migrated onto the shared helper by C1528) Ask-and-stop mechanism — every
// Pi task ──
// Pi has no AskUserQuestion tool and no interactive picker (upstream design, see the no-MCP
// FAQ above), so a task instruction to "ask the user clarifying questions" otherwise falls
// through to plain generation with no pause. C1134/C1217 closed this locally as a private
// PI_QUESTION_MECHANISM const (numbered question list, lettered A)/B)/C) options, standalone
// "Questions ready." sentinel). C1528 replaced that const with the shared, agent-agnostic
// BaseTaskAgent#buildClarifyDirective({ compact: true }) (base-agent.js) — same sentinel, same
// lettered-option contract, same echo-safety discipline (its own copy of the sentinel stays
// embedded mid-sentence, never on its own line — see the HARD RULE comment above; also see
// buildClarifyDirective()'s doc comment for the letters-not-nested-numbers rationale, moved
// there since it now owns this wording for every non-Claude agent, not just Pi).

// (C1134) Emitted only on tasks carrying the 'discovery' tag (seed-setup-tasks.js's
// discoveryBlock() — preset-A/B starter tasks and runtime "Inspect existing code: <folder>"
// tasks). Forces Pi to ground its questions in what already exists instead of assuming a blank
// project, and explicitly overrides the "write the plan immediately" instruction above for
// THIS task only: questions come before the plan, not after.
function piDiscoveryMandateLines() {
  return [
    `- This is a discovery task: before asking anything, read what already exists — ai/architecture/GENERAL.md (its ## Source Documents and ## Existing Code sections), any root README/docs, and any manifest file — so your questions are grounded in the real project, not assumptions.`,
    `- Then read the other tasks in this project and their comments (the GET /tasks and GET /tasks/<key>/comments curls above) so you never re-ask something a sibling task already recorded.`,
    `- Only then ask the user with the Clarifying questions mechanism above, in batches of 3-5, repeating for follow-up batches until the task's own question list is answered — this overrides the earlier instruction to write the plan immediately: for THIS task, the plan comes after the answers. If the user says "you decide", record it as an explicit Assumption line in the deliverable instead of silently choosing.`,
  ];
}

// ── Parent-task block budget (C1575) ──
// Pi is the only agent that caps opts.parentTaskBlock — Claude/Codex thread it through
// uncapped (see their buildPrompt()s). Pi's kickoff prompt is echoed verbatim into a
// small/cheap OpenRouter model's own TUI (same reasoning as the 9000-char ceiling on every
// other directive here — see pi-agent.test.js), so total prompt size still needs a hard
// ceiling even with the parent block now in the mix. Raised from 9000 to 12000 here (not the
// other directives' shared ceiling) because the parent block is task DATA, not fixed
// boilerplate — it can legitimately be large (a whole objective's chat history), and a Pi
// spawn that never had a parent (the common case, parentTaskBlock null) is byte-identical to
// pre-C1575 and still well under the old 9000/9600 ceilings other tests assert.
const PI_PROMPT_BUDGET = 12000;
const PI_PARENT_BLOCK_MAX_CHARS = 2000;

class PiAgent extends BaseTaskAgent {
  constructor() {
    // (C1136) 'Other Model' — matches the wizard/setup-modal/agents-modal naming
    // (AGENT_DISPLAY_NAMES in agent-select.js) and providers/registry.js's PROVIDER_META.pi
    // label, so the Settings → Agents summary (summarizeAgents() via getTaskAgentInfo().label)
    // no longer disagrees with every other Pi-naming surface. The Pi product itself is still
    // named in the spawn system prompt below — this is display text only, id stays 'pi'.
    super('pi', 'Other Model');
    this.approvalCommand = null;
  }

  // (C1057) Pi shares Codex's dialog-approval plan-ready wording — see prompt-detect.js.
  isPromptLine(line) {
    return matchPromptLine(line, PI_PROMPT_PATTERNS) || super.isPromptLine(line);
  }

  // C1215 — Pi's kickoff prompt is echoed verbatim into its own TUI and budgeted under
  // 9000 chars (pi-agent.test.js), and Pi has no MCP support at all — the base directive's
  // MCP-specific caveat doesn't apply here. See buildVcsDirective's opts.compact doc in
  // vcs-settings.js for what compact mode drops/shortens. C1561: same absent-key '' guard
  // as base-agent.js's resolveVcsDirective() — buildVcsDirective() itself no longer has a
  // '' branch, so this override must guard the same way or every no-vcsSettings Pi caller
  // (four other prompt-budget test files) would start seeing the VCS-off block leak in.
  resolveVcsDirective(opts = {}) {
    return opts.vcsSettings ? buildVcsDirective(opts.vcsSettings, { compact: true }) : '';
  }

  // C1513 — same reasoning as resolveVcsDirective() above: Pi has no MCP, so the
  // backfill directive's remedy has to be `PUT /tags/:name`, not `ensure_project_tag`.
  buildTagDescriptionDirective(opts = {}) {
    return buildTagDescriptionDirective(opts.taskTags, opts.tagDescriptions, { compact: true });
  }

  // Compact wording for every shared directive — Pi's kickoff prompt is echoed verbatim into
  // its own TUI under a hard size budget, and Pi has no MCP tools to name. Text clarifying
  // questions stay on: Pi has no question tool.
  getPreamblePolicy() {
    return { compact: true, clarify: true };
  }

  _buildAppendSystemPrompt(opts = {}) {
    const ttTags = (opts.taskTags || []).filter(t => t.startsWith('tt-'));
    const projectRoot = opts.projectPath || runtimeConfig.PROJECT_ROOT;
    const staticBundle = getStaticBundle(projectRoot);
    const grepBundle = ttTags.length >= 2 ? getTaskStartupGrepBundle(ttTags, projectRoot) : '';
    const langDirective = this.getLanguageDirective(runtimeConfig, opts);
    return [langDirective, staticBundle, grepBundle].filter(Boolean).join('\n\n');
  }

  buildPrompt(prompt, opts = {}) {
    const promptWithComments = BaseTaskAgent.prependTaskComments(prompt, opts);
    // (C1575) SIMPLE_MODE is a bare debug path with no surrounding framing to budget the
    // parent block against — thread it through uncapped, same discipline SIMPLE_MODE gives
    // every other opt in this method.
    if (runtimeConfig.SIMPLE_MODE) return BaseTaskAgent.prependParentTask(promptWithComments, opts);

    const ttTags = (opts.taskTags || []).filter(t => t.startsWith('tt-'));
    const cachedTags = (opts.cachedTags || []).filter(t => t.startsWith('tt-') && !ttTags.includes(t));
    const tagNote = [
      ttTags.length > 0
        ? `Task tt-* tags: [${ttTags.join(', ')}]. Read ai/architecture/{tag}.md for each relevant tag before editing code in that module.`
        : 'Use the pre-loaded taxonomy to identify relevant tt-* architecture docs, then read their ai/architecture/{tag}.md files before editing.',
      cachedTags.length > 0
        ? `Already loaded this task session: [${cachedTags.join(', ')}]. Do not duplicate architecture reads unless content is needed again.`
        : '',
    ].filter(Boolean).join(' ');
    const grepNote = ttTags.length >= 2
      ? `Cross-reference scan for [${ttTags.join(', ')}] is already complete in startup context. Use shell grep/rg only for identifiers absent from that section.`
      : 'Use rg for source search.';
    // Shared directives (VCS, tag-description backfill, process safety, KB hygiene, task status) plus the
    // separate clarify slot — see base-agent.js#buildSharedPreamble. All compact by policy
    // (getPreamblePolicy() above): plain prose/bullet lines with no dialog-shaped phrasing, so
    // they stay safe under the HARD RULE above (no bare "Plan ready.", no "❯ n." prefix, no
    // "[y/n]", no "do you want to …?" etc.) and inside the echo-verbatim prompt budget —
    // pi-agent.test.js's echo-safety sweep covers them.
    const { directives, clarify } = this.buildSharedPreamble(opts);

    const lines = [
      'Use the Tipatask workflow for this repository.',
      'You are running inside Pi Coding Agent. Pi has NO MCP support at all — that is Pi\'s design (its README says "No MCP."), not a broken setup. A missing `tipatask` MCP server here is expected and is NOT a bug: never report it to the user, never investigate it, never read or edit `.mcp.json`, and never stop work over it. Use Pi built-in shell/read/edit tools only.',
      'Pi auto-loads this repo\'s AGENTS.md / CLAUDE.md, which were written for MCP-capable agents (Claude Code, Codex). Every instruction there to call a `tipatask` MCP tool — list_system_tags, get_project_tags, get_tag_architecture, get_tag_architectures, create_system_tag, batch_grep_tags, list_tasks, get_task, create_task, update_task, create_task_comment, push_knowledge — does NOT apply to you, and neither does the "MCP Tool Schemas" section of your system prompt. Read architecture docs straight off disk (ai/architecture/*.md) and use the curl recipes below for everything else.',
      'Start in planning mode enforced by Task App. First study the task, relevant source code, configuration files, and architecture docs. Do not implement, edit files, or run mutating commands until the user approves the plan.',
      // (C1116) The instruction below is deliberately kept as ONE unbroken sentence with no
      // literal newline — Pi's TUI echoes this prompt verbatim in its first frames, and the
      // server-side ready-detector (PI_PLAN_READY_PATTERNS, prompt-detect.js) anchors on a
      // standalone "Plan ready." line. If this instruction itself put "Plan ready." on its
      // own line, the echo would satisfy that anchor immediately — exactly the bug being
      // fixed. Keep it embedded mid-sentence so only Pi's REAL final line (which Pi renders
      // as a bare "Plan ready." with nothing else on it, per this instruction) can match.
      'Write the plan immediately in normal output, then as the very last line of the response, by itself with nothing else on that line, write exactly the words Plan ready. — do this only after the plan is fully written, then wait for Task App approval before mutating files.',
      clarify,
      'Project context:',
      '- General architecture and tag taxonomy are pre-loaded in the system prompt.',
      `- ${tagNote}`,
      '- After any code change, update ai/architecture/GENERAL.md and/or ai/architecture/{tag}.md for each tt-* tag on this task to reflect changed endpoints, schema, env vars, file structure, or behavior. Never write ai/ARCHITECTURE.md — deprecated path, no agent loads it. During exploration, if a STANDING fact is missing from a tt-*.md (undocumented endpoint, missing file row, changed schema, behavioral nuance), fix that doc immediately with that fact alone.',
      // C1184: statuses are per-project custom now — pull the resolved role names
      // (fail-open to the legacy pending/in_progress/completed via LEGACY_ROLE_NAMES)
      // instead of writing the literal names into the prompt.
      buildTipataskRestRecipe(opts),
      // "on_fire" carries no role flag by design — unlike "canceled" (which got a 4th
      // role flag, is_workflow_canceled, in C1187), on_fire was never meant to have
      // one: it's just an ordinary active, non-start, non-in-progress status. Matched
      // by literal name here so a project that removed it entirely isn't told to use a
      // status that no longer exists.
      `- Task status: PATCH status to ${this.resolveStatusForRole('in_progress', opts)} as soon as you start implementing (right after plan approval), and to ${this.resolveStatusForRole('complete', opts)}${this.resolveStatusNames(opts).includes('on_fire') ? ' — or on_fire if this task is blocked —' : ''} before your final message. Re-GET the task afterwards to confirm the saved status.`,
      '- Before marking this task complete: if a module you touched has no tt-* tag, GET /tags to check, then POST /tags to register it (description required), then create the ai/architecture/tt-*.md stub yourself with your write tool, then PATCH the task tags. That order matters: an unregistered name inside a PATCH tags array is rejected with 400 "tags not registered". There is no create_system_tag here to write the stub for you.',
      `- MANDATORY before marking this task ${this.resolveStatusForRole('complete', opts)}: post ONE self-authored resolution comment using the resolution-comment command above. content must be a real report in plain English prose covering: what changed and why, key files touched, how to verify, and follow-ups/caveats (write "none" if there are none). If the work needs a follow-up task, describe it here instead of creating one. Post it immediately before the PATCH that sets status to ${this.resolveStatusForRole('complete', opts)}. It is separate from and required IN ADDITION TO the auto-posted terminal-tail resolution comment (a raw log dump posted on session exit) — that one does not satisfy this step.`,
      '- KB push: nothing auto-pushes your ai/architecture/*.md edits from this session (that hook is Claude Code only, and Task App session start only pulls). After your LAST edit to an arch doc, push it with the arch-doc command above. If jq is unavailable, skip the push and say so in the resolution comment — the file on disk stays authoritative.',
      `- ${grepNote}`,
      ...directives,
      ...(opts.discovery ? piDiscoveryMandateLines() : []),
      '',
    ];
    // (C1575) Fit the parent-task block against the REAL assembled framing + task text
    // rather than guessing a fixed reservation — exact, not approximate. The "- 4" accounts
    // for the two join()-inserted '\n's this method's own final join() adds around the fitted
    // block (framing + '\n' + block) PLUS the '\n\n' prependParentTask() puts between the
    // fitted block and promptWithComments — 3 separator chars whenever the block is
    // non-empty, plus 1 spare so an exact-fit block lands strictly under PI_PROMPT_BUDGET,
    // never exactly at it. When the block is empty/dropped, prependParentTask() is a
    // passthrough and this slightly over-reserves, which only ever makes the block MORE
    // likely to be dropped, never lets the total exceed PI_PROMPT_BUDGET.
    const framing = lines.join('\n');
    const room = Math.min(
      PI_PARENT_BLOCK_MAX_CHARS,
      PI_PROMPT_BUDGET - framing.length - 4 - promptWithComments.length,
    );
    const parentTaskBlock = BaseTaskAgent.fitParentTaskBlock(opts.parentTaskBlock, room);
    return [...lines, BaseTaskAgent.prependParentTask(promptWithComments, { parentTaskBlock })].join('\n');
  }

  async getSpawnSpec(config, prompt, taskId, opts = {}) {
    const localized = await this.localizeSpawnPrompt(config, prompt, taskId, opts);
    prompt = localized.prompt;
    opts = localized.opts;

    const projectRoot = opts.projectPath || config.PROJECT_ROOT;
    // (C1112) launch is null only when Pi is unresolvable by any strategy (no bundle, no
    // PI_BIN, no system install) — fall back to the bare name so the spawn fails with a clear
    // ENOENT the caller already surfaces, instead of throwing here.
    const launch = resolvePiLaunch() || { command: 'pi', argsPrefix: [], env: {} };
    const env = augmentPathEnv({
      TERM: 'xterm-256color',
      PI_SKIP_VERSION_CHECK: '1',
      ...projectEnvExtras(opts.projectPath),
      ...launch.env,
    });
    const nvmBinDir = resolveNvmBinDir(launch.command);
    if (nvmBinDir) env.PATH = `${nvmBinDir}${path.delimiter}${env.PATH}`;
    if (taskId) {
      env.TIPATASK_TASK_ID = taskId;
      env.TIPATASK_TRACK_DIR = path.join(config.USER_DATA_ROOT, '.file-tracks');
    }

    // C1101 — live per-project read (config.json > global default), same pattern as
    // claude-agent/codex-agent (C953): a project's saved "Other Model" choice applies
    // on the next spawn with no server restart.
    // C1121 — PI_MODELS (array of {model,apiKey} rows) is now the sole source a
    // wizard-created project writes; row 0's model wins over the legacy flat PI_MODEL
    // config.json field resolveSpawnModel() falls back to (pre-C1121 projects only).
    let piCfg;
    try { piCfg = readProjectConfig(projectRoot); } catch { piCfg = null; }
    const piEntry = piCfg && piDefaultEntry(piCfg);
    const piModel = (typeof opts.model === 'string' && opts.model.trim())
      || piEntry?.model
      || resolveSpawnModel(opts.model, projectRoot, 'PI_MODEL', config.PI_MODEL);
    // C1122 — row 0's key arrived from projectEnvExtras() above under its provider's env var
    // (piDefaultEntry). When the resolved model names a DIFFERENT row, that row's own
    // key must win — else a non-default model authenticates against the default model's
    // account. Self-healing for row 0 too (piEntryForModel(cfg, row0.model) === row 0), so
    // this is a strict superset of the projectEnvExtras() default, never a regression.
    // (TPT163/TPT188) The key goes under the row's own provider env var (DEEPSEEK_API_KEY for a
    // deepseek row, GEMINI_API_KEY for google, …; nothing at all for a keyless row —
    // piKeyEnvVars), and --provider below is always explicit — without it Pi infers a provider
    // from a "vendor/" prefix and can land a deepseek/... id on OpenRouter.
    // (TPT189) A `custom` row runs on a models.json-declared provider: preparePiCustomEndpoint()
    // writes <projectRoot>/.pi/agent/models.json and returns the block id for --provider plus the
    // PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR env Pi needs to find it. For every other row
    // it returns the row's own provider id and an empty env without touching disk.
    const selEntry = (piCfg && piEntryForModel(piCfg, piModel)) || piEntry || null;
    const { provider: piProvider, env: piEndpointEnv } = preparePiCustomEndpoint(projectRoot, selEntry, env);
    Object.assign(env, piKeyEnvVars(selEntry), piEndpointEnv);
    // (C1117) Logged so a model-specific misbehavior (e.g. Kimi K3 leaking a bare `<|sep|>`
    // chat-template token on plan approval — see tt-pi-session.md § Plan approval PTY protocol)
    // doesn't require a follow-up round-trip just to find out which model was running.
    console.log(`[terminal:pi] spawning task ${taskId || '(objective)'} model=${piModel} provider=${piProvider}`);
    // TPT286 — Pi has no reasoning-effort setting; a task's effort is noted and otherwise ignored.
    const effort = this.resolveEffort(opts.task);
    if (effort) console.debug(`[terminal:pi] task ${taskId || '(objective)'} effort=${effort} ignored — Pi has no effort setting`);
    const args = [
      '--provider', piProvider,
      '--model', piModel,
      '--approve',
    ];
    if (!config.SIMPLE_MODE) {
      args.push('--append-system-prompt', this._buildAppendSystemPrompt(opts));
    }
    args.push(this.buildPrompt(prompt, opts));

    return {
      command: launch.command,
      args: [...launch.argsPrefix, ...args],
      cwd: projectRoot,
      env,
      model: piModel,
    };
  }

  // ── Plan-approval submission (C1117) ──
  // Pi's editor routes an Enter-submitted line differently depending on stream state
  // (interactive-mode.js: mid-turn it takes `streamingBehavior: 'steer'` instead of starting a
  // fresh turn, see the state machine around setupEditorSubmitHandler()). A blind write —
  // Codex's approach, which pi-agent.js used to copy verbatim — can land mid-turn and steer
  // instead of submitting cleanly. Wait for PTY quiescence (same idle-silence shape the C947
  // paste-injector in terminal-session.js uses) before each write, deliver the text atomically
  // via a bracketed-paste frame (pi-tui's StdinBuffer treats `\x1b[200~ … \x1b[201~` as one
  // `paste` event — see stdin-buffer.js — bypassing per-keystroke dispatch entirely, unlike the
  // ~46 synthetic keystrokes a plain string write would produce), then wait for quiescence again
  // before Enter. Text must stay single-line: inside a paste frame a literal `\n` inserts a
  // newline in Pi's editor instead of submitting.
  _submitApproval(session, text) {
    if (!session.pty) return;
    const quietMs = this.getPasteSilenceMs();
    const ceiling = Date.now() + 10000; // don't wait forever on a permanently noisy PTY
    const waitQuiet = (cb) => {
      const check = () => {
        if (!session.pty) return;
        const idleMs = Date.now() - (session.lastOutputAt || 0);
        if (idleMs >= quietMs || Date.now() >= ceiling) { cb(); return; }
        setTimeout(check, 100);
      };
      check();
    };
    waitQuiet(() => {
      if (!session.pty) return;
      session.pty.write('\x1b[200~' + text + '\x1b[201~');
      waitQuiet(() => {
        if (session.pty) session.pty.write('\r');
      });
    });
  }

  approvePlan(session) {
    this._submitApproval(session, this.getApprovalText());
  }

  // (TPT354) See BaseTaskAgent#readFinalMessage. Pi's per-cwd session dir (or a custom-endpoint
  // row's PI_CODING_AGENT_SESSION_DIR) is resolved from the spawn env snapshot on
  // session._transcriptHint; the file is matched by spawn time + `Work on task <KEY>` kickoff.
  readFinalMessage(session) {
    return require('./final-message').readPiFinalMessage(session && session._transcriptHint);
  }

  // Substantive one-liner instead of a bare "go" — a terse instruction is what let a Kimi
  // K3 turn come back as nothing but a leaked chat-template separator token (`<|sep|>`, see
  // tt-pi-session.md § Plan approval PTY protocol) with no tool activity at all.
  getApprovalText() {
    return 'Plan approved. Implement the approved plan now — do not re-plan and do not request approval again. '
      + 'If this task requires clarifying questions from the user, ask them now with the numbered-list mechanism from the system prompt. '
      + 'Follow the Tipatask workflow already given in the system prompt, including posting the resolution comment before marking the task complete.';
  }

  getApprovalWatchdogMs() { return 15000; }

  // A stalled approval looks like either: (a) the model echoed a leaked chat-template token
  // instead of a real reply (confirmed live with Kimi K3 returning a bare `<|sep|>`), or (b)
  // the PTY produced next to nothing before going idle again — a real turn, even a short one,
  // renders far more than a few dozen bytes (tool-call framing, the response text itself).
  approvalStalled(session, ctx) {
    const LEAKED_TOKEN_RE = /<\|[a-z0-9_]{1,24}\|>/i;
    if (ctx && typeof ctx.tail === 'string' && LEAKED_TOKEN_RE.test(ctx.tail)) return true;
    const MIN_GROWTH_BYTES = 40;
    if (ctx && ctx.growthBytes < MIN_GROWTH_BYTES && ctx.idleMs >= this.getPasteSilenceMs()) return true;
    return false;
  }

  // One automatic re-attempt with an even more explicit instruction, guarded so a second
  // stall just falls through to the watchdog's plain notice instead of looping.
  retryApproval(session) {
    if (!session.pty || session._piApprovalRetried) return;
    session._piApprovalRetried = true;
    this._submitApproval(
      session,
      'Your previous reply had no usable content. Plan approved — implement it now: use your '
      + 'tools (read, edit, write, bash) to make the actual code changes the plan calls for. '
      + 'Do not just acknowledge this message.'
    );
  }

  async detect(config) {
    // (C1112) launch is null only when Pi is unresolvable by any strategy — bundled dependency
    // (checkout), extraResources copy (packaged Electron), PI_BIN override, or system PATH.
    const launch = await resolvePiLaunchAsync();
    if (!launch) {
      return {
        id: this.id, label: this.label, available: false,
        reason: 'Pi CLI not found. Run npm install in the Task App checkout to get the bundled copy, install pi globally, or set PI_BIN=/path/to/pi in .env.',
      };
    }
    const nvmBinDir = resolveNvmBinDir(launch.command);
    const probeEnv = augmentPathEnv({ PI_SKIP_VERSION_CHECK: '1', ...launch.env });
    if (nvmBinDir) probeEnv.PATH = `${nvmBinDir}${path.delimiter}${probeEnv.PATH}`;
    const probe = await BaseTaskAgent.runCliProbe(launch.command, [...launch.argsPrefix, '--version'], { env: probeEnv });
    if (probe.error) {
      if (probe.error.code === 'ENOENT') {
        return { id: this.id, label: this.label, available: false, reason: 'Pi CLI not found' };
      }
      return { id: this.id, label: this.label, available: false, reason: 'Pi CLI probe failed' };
    }
    if (probe.status === 0) {
      return { id: this.id, label: this.label, available: true };
    }
    const reason = probe.output ? `Pi CLI probe failed: ${probe.output.split('\n')[0]}` : 'Pi CLI probe failed';
    return { id: this.id, label: this.label, available: false, reason };
  }
}

module.exports = PiAgent;
