<!-- Installed by tipatask-setup. Edits preserved on re-install unless --force. -->

# {{PROJECT_NAME}} — Agent Guide (Codex / Generic)

Use the `tipatask` MCP server whenever it is available for task CRUD, system-tag lookup, and architecture lookups. A second server, `tipatask-local`, carries 5 tools that need a repo checkout — `batch_grep_tags`, `push_knowledge`, `pull_knowledge`, `git_worktree_status`, `complete_task` — call those there instead of on `tipatask`.

## System Components

<!-- Seeded by discover.js on first setup. Run `tipatask-setup --skip-install` to re-seed. -->
<!-- Example layout:
| Component | Path | Description |
|---|---|---|
| **Task App** | (the TipΔTask checkout, wherever it is cloned) | Local AI task management tool, port 4455 |
| **Your API** | `api/src/` | Product backend |
-->

## Core Workflow

- Read `ai/architecture/GENERAL.md` before implementing anything substantial.
- Identify the relevant `tt-*` tags for the task or touched modules.
- Read `ai/architecture/{tag}.md` for each relevant tag before editing code in that area.
- Keep `ai/architecture/*.md` in sync with any changed endpoints, schema, env vars, file structure, or behavior — standing system facts only. Task investigation notes, evidence tables, dated findings and corrections go in the task's resolution comment, never in a `tt-*.md` — see § Knowledge Base Hygiene.

## Task Source Of Truth

- Tasks live in the Tipatask API project selected by `API_PROJECT_ID` (`.tipatask/config.json`). The local `file` task backend is retired — `ai/TODO.md` is not live task state.
- Prefer the `tipatask` MCP server over manual file edits for task updates.
- Never verify task status against `ai/TODO.md`; verify against the configured API project instead.
- Write status with `update_task`, then call `get_task` to confirm the saved status from the active project.
- If MCP task results do not match the active `API_PROJECT_ID` (`.tipatask/config.json`), treat that as broken MCP registration and fix `.mcp.json` / client MCP config before trusting writes.

## Tag Rules

- Call `list_system_tags` before assigning any `tt-*` tag — verify it exists. If none fits, call `create_system_tag` with a real `architecture_hint` (key files, endpoints, DB tables).
- Call `get_tag_architecture` for each `tt-*` tag on the task before editing code in that module.
- Call `get_project_tags` to see all tags already registered in the project database.
- Include at least one specific `tt-*` module tag on tracked tasks.
- Add one action tag such as `feature`, `bugfix`, `refactor`, `migration`, `config`, `security`, or `css`.
- Add 1-2 detail tags when they materially help navigation.
- Avoid generic standalone tags like `backend`, `frontend`, `ui`, or `database`.

**IMPORTANT: `tt-*` is a universal architectural tagging convention for ANY project managed by Tipatask — it is NOT Tipatask-specific.** When working on a non-Tipatask codebase (PHP app, mobile app, etc.), `tt-*` tags describe THAT project's modules (e.g. `tt-voucher` for a voucher module, `tt-tracker` for a tracker module). The arch docs in `ai/architecture/` describe THIS project's modules. Never dismiss `tt-*` tags as inapplicable because the codebase is not Tipatask.

## Post-Task Tag Analysis

Run after the last code change, before setting task to `completed`.

**Tool sequence:**
1. `list_system_tags` — fetch current `tt-*` taxonomy
2. For each module file touched, confirm a matching `tt-*` tag is on the task
3. If a touched module has no `tt-*` tag → `create_system_tag(tag_name, description, architecture_hint)` — creates `ai/architecture/{tag}.md` stub + registers tag in DB
4. `update_task(task_key, tags=[...])` — apply final tag set

**Tag count:** 3–5 tags per task (≥1 feature/module, 1 action, 1+ detail when non-trivial).

Skipping this step = completed task with stale tags = broken architecture navigation for next agent.

## Resolution Comment

Pass one resolution report to `tipatask-local.complete_task(task_key, resolution)` (or `tt complete` for Pi), in plain English prose, covering: what was implemented and why, key files touched, how to verify, and any follow-ups/caveats (write "none" if there are none). The completion guard posts the resolution and status together. This is the executing agent explaining itself in the task, distinct from the Task App's automatic terminal-tail resolution comment posted on session end.

To read how earlier tagged tasks were resolved, call `list_task_resolutions(tags=[...])` — that is where per-task narrative is stored and read back, not `ai/architecture/*.md`.

## Agent context and credentials

Claude loads `CLAUDE.md`; Codex loads `AGENTS.md`; Pi loads its native project guides (`AGENTS.md`, with `CLAUDE.md` fallback). Tipatask injects the task or chat contract separately. Gemini is supported only for objective planning; its launch loads `AGENTS.md`/`GEMINI.md` and injected planning context, with read tools and no Tipatask MCP/REST tools. It is not a task-execution or task/project-chat provider.

Apply system/developer and explicit user instructions first. Within the project workflow, the current injected session contract and verified VCS settings take precedence over generic guide defaults. Planning approval forbids mutations, including task status writes. Objective chat proposes work; task/project chat may change tasks but cannot edit code or run Git, even when a general guide describes coding tasks. Claude/Codex task terminals use MCP; Pi uses the credential-safe REST command in its launch prompt. Do not treat missing MCP in Pi or Gemini as a setup error.

The selected project's `.tipatask/config.json` stores `API_BASE_URL` and `API_PROJECT_ID`. The signed-in token lives in `.tipatask-account.json` under `TIPATASK_USER_DATA`, keyed by API server. Never print/copy a token, commit it, or read it from a legacy `.env`. A legacy project-scoped token cannot authorize another project: sign in again to obtain an account token. Opening an old checkout must not change the signed-in account.

Claude's generated MCP header helper reads the current account on connect/reconnect. Codex reads its bearer environment at launch; restart it after token/account rotation. Direct Codex/Pi shells need the shipped `src/cli/launch-agent.js <provider> --project-root <directory>` launcher, run with the installing app's Node runtime (packaged Electron uses `ELECTRON_RUN_AS_NODE=1`). The launcher reads non-secret runtime/user-data paths from generated `.mcp.json`; refresh the agent harness if those paths are stale. A plain Codex command with no launch environment is not a supported authenticated Tipatask launch.

## Credential recovery and completion

A missing account store or wrong `TIPATASK_USER_DATA` is not token expiry. Check the selected project and generated local MCP paths (`TIPATASK_PROJECT_ROOT`, `TIPATASK_SERVER_ROOT`, `TIPATASK_USER_DATA`) without displaying credentials. For an actual expired/rejected token or scope mismatch, use Project → Re-authenticate / Change Account, then reconnect Claude or restart the affected agent. Do not retry with an inherited token from another project.

When remote MCP is unavailable, use the shipped `src/cli/task-tools.js` through the installing runtime. It reads live credentials internally; requests accept a project-relative method/path and JSON bodies on stdin, never a token argument. Task terminals receive `TIPATASK_TOOL_EXEC` and `TIPATASK_SERVER_ROOT`:

```sh
tt() { ELECTRON_RUN_AS_NODE=1 "$TIPATASK_TOOL_EXEC" "$TIPATASK_TOOL_SCRIPT" "$@"; }
tt GET "/tasks/$TIPATASK_TASK_ID"
tt verify "$TIPATASK_TASK_ID"
tt complete "$TIPATASK_TASK_ID" < /path/to/resolution.txt
```

Require live verified VCS settings before Git writes and successful completion verification before finishing. Use `tipatask-local.complete_task(task_key, resolution)` for MCP agents, or `tt complete` for Pi/REST recovery; both run the same guard and post one plain-English resolution plus the configured completion status. Never bypass this guard by directly PATCHing a completed status. If local verification is unavailable or requires a runtime restart, leave the task incomplete and report the reason.


## Knowledge Base Hygiene

- `ai/architecture/*.md` holds standing system concepts only: what a module is for, how it works today, its files/endpoints/schema/invariants — written for a reader who never saw this task.
- Task-specific narrative never goes there: investigation logs, evidence tables of observed values, dated findings, task keys, step-by-step of what you tried, and corrections of your own earlier analysis. Those go in `create_task_comment(task_key, content, type='resolution')` on this task.
- **Line test** before adding a line to a KB file: would it have to be deleted or rewritten once this task closes, or does it only make sense to someone who read this task? If yes — it's task narrative, not KB. Naming a task key, a date, or what you personally tried is the same verdict.
- For context from earlier tasks call `list_task_resolutions(tags=[...])` and read the comment history — do not mine the KB for it, and do not write it back into the KB for the next agent.

## Process Safety

- Before running any `npm run` command (build/typecheck/test/etc.), verify the active Node matches this project's pinned version (check `.nvmrc`, `.tool-versions`, or `engines.node` against `node --version`) and switch to it first. A stale ambient npm can silently ignore `--workspace`/`--workspaces` flags and let a self-referential build script recurse without bound — a real incident produced thousands of runaway processes and exhausted a machine this way.
- To abort a backgrounded command, kill it by the PID or process group you captured when starting it — never by matching the command-line text (`pkill -f "..."`). npm's internal lifecycle re-exec replaces each descendant's argv with just the currently-running script name, so a substring match on the original command can never catch a runaway recursive chain.

## Version Control

The project's Version Control setting (Task App Settings ▸ Version Control, or the web project settings; off by default) decides what git work agents may do — not this file.

- **Live VCS verification**: before VCS writes, after resuming, and before completion, call `tipatask-local.git_worktree_status` with `task_key` and require `verified: true`. Current flags supersede kickoff snapshots. A failed or incomplete settings read grants no VCS writes and cannot waive an enabled merge requirement. Older tool builds: read `GET /api/projects/{API_PROJECT_ID}` with current `.tipatask/config.json` credentials (never print them), then restart the updated Task App to obtain local verification. When automatic merge is enabled, commit once per touched repository, merge nested task branches first and root last into each original checkout's CURRENT branch, preserve unrelated edits and correct gitlinks, and run relevant checks there. A PR is separate and never substitutes for local merge. Use `tipatask-local.complete_task(task_key, resolution)` for the final resolution/status pair; it rechecks settings and Git state before writing. If unavailable or verification fails, do not mark completed. Commit disabled never authorizes committing or merging.
- **Where to read it**: the directive block at the top of a task kickoff prompt — `Version control (git) is enabled for this project:` / `Version control (svn) is enabled for this project:` / `Version control is OFF for this project`. With no such block (SIMPLE_MODE, chat and other ad-hoc sessions), call the `git_worktree_status` MCP tool (served by `tipatask-local`) and read the `vcs` flags it reports (`worktree`, `commit`, `pr`, `merge`); a "Git integration is not enabled" reply, an svn setting, or an error with no `vcs` object means Version Control is off.
- **Off, or git with commit off**: never run `git add`, `git commit`, `git push`, `git tag`, `git merge`, `git rebase`, or `git stash`, never create a branch or worktree, never open a PR, never write a commit message. Leave changes in the working tree, unstaged, and report what changed — the user commits. Only carve-outs, exactly as the kickoff directive gives them: with the worktree flag on you may create the task worktree and branch, and with the PR flag on you may push the task branch to open the PR. Read-only git (`status`, `diff`, `log`, `show`) is always fine.
- **Git with flags on**: do exactly what the enabled flags allow and nothing beyond them (worktree, commit, merge, PR) — including when the user asks for it directly in chat. The latest verified VCS settings govern writes, including when they differ from the kickoff snapshot. svn: only the `svn commit` the directive describes.

## Compatibility

- Keep `.mcp.json` valid for Claude-friendly MCP clients.
- Keep `CLAUDE.md` and `AGENTS.md` aligned with any shared workflow changes.

## Important Paths

- `CLAUDE.md` — Claude-specific project workflow
- `AGENTS.md` — this file, generic/Codex agent workflow
- `.mcp.json` — project MCP registration
- `<task-app-checkout>/src/mcp/server.js` — Tipatask MCP server (absolute path registered in `.mcp.json`)
- `<task-app-checkout>/src/cli/setup.js` — Task App setup + infra installer
- `<task-app-checkout>/.env` — Task App non-credential settings; API credentials live in `.tipatask/config.json` instead

## Communication & Taxonomy Rules (Codex Inline)

Codex does not load Claude skills. The following rules are embedded here so Codex agents operate consistently with Claude agents on this project.

### Caveman-ultra output style (applies to all CODING task implementation)

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: `[thing] [action] [reason]. [next step].`

Not: "Sure! I'd be happy to help. The issue is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

**Auto-clarity:** drop caveman for security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread, or when user asks to clarify. Resume caveman after clear part done.

**Boundaries:** code/commits/PRs/docs: write normal. "stop caveman" or "normal mode": revert to normal prose. Self-authored resolution comment (`create_task_comment`, `type='resolution'`, see "Resolution Comment" above): always plain English prose, never caveman — it's a report read later, not a live status update.

### Tag taxonomy lookup

The hardcoded tag taxonomy lives in `ai/architecture/` + the database, not in this file. Use MCP tools:
- `list_system_tags` → live list of all `tt-*` tags
- `get_tag_architecture <tag>` → full architecture doc for a tag
- `get_project_tags` → project-level non-system tags

The tags and docs under `ai/architecture/` describe **the current project's** architecture, whatever its tech stack (PHP, Swift, Go, …). `tt-*` is only the naming convention Tipatask uses to organize that knowledge — it does not imply the project itself is Tipatask.

Never invent `tt-*` tags without first calling `list_system_tags` to verify no existing tag covers the module.

### Tag naming pattern (when creating new)

`tt-{area}-{module}` — e.g. `tt-api-webhooks`, `tt-web-notifications`, `tt-db-analytics`.

**Three-condition rule** — create a new tag only if:
1. Module is distinct, not covered by existing tag
2. Multiple future tasks will use it
3. No existing tag fits (scan `list_system_tags`)

### Task status scope

- Decide each task's `completed` / `on_fire` status from its own requested scope and task-local verification. Use the project's configured completion status when renamed, and `on_fire` only when available.
- Complete only when the requested scope is fully implemented and relevant checks pass. Incomplete scope, relevant failures, and regressions caused by this task's changes block completion. Deferring requested work to another task does not make this task complete.
- Unrelated unfinished tasks and unrelated failures in a broad test suite are caveats, not blockers, unless the user or task explicitly connects them to this task's acceptance criteria.
- Investigate relevance before classifying a failure; a failure outside edited files is not automatically unrelated. Report unrelated caveats and supporting evidence in this task's resolution comment and final reply.

### Status discipline

For task execution after plan approval, keep task status current; planning and chat follow their session contract. `in_progress` when starting, `completed` or `on_fire` before sending reply. Use `update_task` for non-completion status changes; complete through the guarded completion tool with one resolution report.
