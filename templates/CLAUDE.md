<!-- Installed by tipatask-setup. Edits preserved on re-install unless --force. -->

# {{PROJECT_NAME}} — AI Agent Instructions (Claude)

## Task Management
- Tasks live only in the Tipatask API project selected by `API_PROJECT_ID` (`.tipatask/config.json`). The local `file` task backend is retired — do not use `ai/TODO.md` to verify live task state, except during intentional migration/export.

### Statuses
- `pending` — not started
- `in_progress` — being worked
- `on_fire` — urgent, do now
- `completed` — done
- `canceled` — canceled; ignored as dependency

### Picking tasks
- Default: pick **1 CODING task** from the active backend
- User specifies number ("do next 3"): pick that many
- **`on_fire` first**, regardless of ID
- Then ID order, respect dependencies (skip if deps not `completed`/`canceled`)
- CODING only — HUMAN tasks done by user manually

### Priority assignment (new tasks)
- No deps: lowest-numbered priority group still holding `pending`/`in_progress` CODING task (HUMAN ignored)
- No such group: `max(existing priorities) + 1`
- With deps: priority > max priority of deps (overrides group rule)

### Working on a task
0. Load context: read `ai/architecture/GENERAL.md` + each `ai/architecture/{tag}.md` for the task's `tt-*` tags (use MCP `get_tag_architecture`). Skip if already loaded this session.
   - **Tag check**: when task proposes or touches new `tt-*` tags, first call `list_system_tags` to get full current taxonomy. Pick from existing tags before inventing new ones.
1. Read tasks via MCP task tools (`list_tasks`, `get_task`, `update_task`), find next eligible
2. Set `in_progress` before starting
2.5. **Deferring work to a new task**: when you split off a portion of the current task or a newly discovered problem into a separate `create_task` call, first call `get_task` on the current `in_progress` task, read its `priority` field, and pass that exact value as the `priority` param to `create_task`. Never omit `priority` when creating follow-up/deferral tasks — omitting it causes the new task to land in an earlier sprint than the parent.
3. Implement fully
3.5. **Tag review** (before marking complete):
   - Call `list_system_tags` to see current taxonomy
   - For each module file touched, verify a matching `tt-*` tag is on the task
   - If a touched module has no `tt-*` tag: call `create_system_tag(tag_name, description, architecture_hint)` — auto-creates stub at `ai/architecture/{tag}.md` + registers in DB
   - Call `update_task` with final tag list (3–5 tags: ≥1 feature/module + 1 action + 1+ detail)
   - **KB hygiene**: before touching any `ai/architecture/*.md`, apply the line test in § KB Hygiene below. Standing system concepts only.
3.6. **Resolution comment**: call `create_task_comment(task_key, content)` with a real report, in plain English prose (not caveman-styled) — what was implemented and why, key files touched, how to verify, and follow-ups/caveats (write "none" if there are none). Defaults to `type='resolution'`. Do this in the same tool-call batch as step 4 below.
4. After implementation, task-local verification, and tag review, post the resolution comment (3.6) and set `completed` in the same tool-call batch — **DO NOT send the final response before this step**
5. Blocked within this task's scope: set `on_fire` when available, explain why. Unrelated issues are caveats under § Task status scope.
6. **ALWAYS** kill node server you start so I can run mine on that port

### KB Hygiene — architecture docs hold standing concepts only
- `ai/architecture/*.md` is reference material about how the system works — standing concepts only: module responsibilities, schema, endpoints, file inventories, invariants, and gotchas that stay true after this task ships. Write every line for a reader who has never heard of this task.
- Never put task-specific material in a KB file: investigation logs, evidence tables, query output, dated findings, "correction after reviewing the data" passages, before/after narratives, or anything that reads as an update to your own earlier analysis. All of that goes in `create_task_comment(task_key, content, type: "resolution")` on this task instead.
- **Line test**: would this KB line still be worth reading a year from now, with this task long forgotten? Yes → KB. No → resolution comment.
- For prior-task context, call `list_task_resolutions(tags=[...])` and read the comment history — do not mine the KB for it, and do not write it back into the KB for the next agent.

**WRONG** — never paste this into `ai/architecture/tt-*.md`:
```
## Investigation notes (2026-03-04)
Correction of my earlier analysis: I first assumed the cache key was the task id. It is not.
| probe | expected | observed |
|---|---|---|
| GET /tasks (cold) | 200 | 304 |
Re-ran 3x, all green. Next agent: check this before trusting the cache.
```

**RIGHT** — the KB keeps only the one durable fact: "Cache key is `${projectId}:${status}`, not the task id; a cold `GET /tasks` answers 304 when the ETag matches." The task key, date, evidence table, and correction narrative all go in the task's resolution comment instead.

### Task status scope

- Decide each task's `completed` / `on_fire` status from its own requested scope and task-local verification. Use the project's configured completion status when renamed, and `on_fire` only when available.
- Complete only when the requested scope is fully implemented and relevant checks pass. Incomplete scope, relevant failures, and regressions caused by this task's changes block completion. Deferring requested work to another task does not make this task complete.
- Unrelated unfinished tasks and unrelated failures in a broad test suite are caveats, not blockers, unless the user or task explicitly connects them to this task's acceptance criteria.
- Investigate relevance before classifying a failure; a failure outside edited files is not automatically unrelated. Report unrelated caveats and supporting evidence in this task's resolution comment and final reply.

### ⚠️ MANDATORY: Update task status — #1 rule
- **EVERY** task touched MUST be `completed` (or `on_fire`) before response ends
- Status update is PART OF implementation — not done until the API project shows `"status": "completed"`
- User-given plan (not from a task): check if it matches an existing task, update that too
- Write status with the current project's `tipatask` MCP `update_task`, then call `get_task` to confirm the saved status under the active `API_PROJECT_ID`.
- If `update_task`/`get_task` results do not match the active `API_PROJECT_ID` (`.tipatask/config.json`), stop and fix MCP registration (`.mcp.json`, Claude settings, Codex config) before trusting task writes.
- If every `tipatask` MCP call fails with HTTP 401 (expired launch-time token), the status write is still mandatory — use the REST fallback in § MCP 401 fallback, then confirm with a GET.
- **PRE-SEND CHECKLIST** — run this mentally before every response:
  1. Did I touch a task? → status updated via MCP `update_task`?
  2. If NO → **do it now, before sending**
  3. Tags accurate? → `list_system_tags` checked, `tt-*` tags assigned to all touched modules, missing tags created via `create_system_tag`
  4. Updated arch docs? → standing system facts only — task narrative goes in the resolution comment, never in a `tt-*.md` (§ KB Hygiene)
  5. Task completed? → your own self-authored `type='resolution'` comment posted via `create_task_comment` before/with the status update — full report, plain English, not caveman-styled
- Skipping status update = incomplete work. User WILL notice. Do not skip.

### View task board
Open the project in the TipΔTask desktop app (Project ▸ Open Project…). Browser fallback, for
debugging only — run in the Task App checkout:
```bash
node todo-server.js
# Open http://127.0.0.1:4455/todo.html and enter the launch code the server prints
```

### Tag conventions
- **Scope**: `tt-*` tags describe modules of whatever codebase is being managed — any project, not just Tipatask. A PHP project gets `tt-voucher`, `tt-tracker`; a mobile app gets `tt-auth-screen`, `tt-payments`. The Tipatask-flavored examples in this file (`tt-api-*`, `tt-task-board`) apply ONLY when working on the Tipatask codebase itself.
- **Primary tags**: name product feature/module touched (e.g. `invoice-pdf`, `profile-portfolio`, `registration-flow`, `admin-user-edit`, `auth-login`). System/architecture tags use the `tt-` prefix (e.g. `tt-task-board`, `tt-api-auth`, `tt-objective-chat`).
- **Secondary tags**: action type (`bugfix`, `feature`, `refactor`, `migration`) or cross-cutting concern (`config`, `security`, `css`). Don't replace feature tag.
- **Detail tags**: implementation technique/pattern (e.g. `drag-and-drop`, `inline-edit`, `modal`, `polling`, `animation`, `responsive`, `crud`, `validation`). 1-2 per task when non-trivial.
- **3–5 tags** per task: ≥1 feature/module, 1 action, 1+ detail when non-trivial.
- Avoid generic standalone tags (`backend`, `frontend`, `admin`, `ui`, `database`) — useless for navigation. Combine into specific feature tags (e.g. `admin-user-edit` not `admin` + `ui`).
- **Lookup before assigning**: before assigning any `tt-*` tag to a new task, call `list_system_tags` to verify tag exists. If no existing tag covers the module, create new one and include `architecture_hint` in task JSON.
- **`architecture_hint` required for new tags**: new `tt-*` tags MUST have an `architecture_hint` field in task JSON describing module purpose, key files, and endpoints — so `create_system_tag`/`overwriteRaw()`'s stub writer produces a useful stub (not empty skeleton).
- **Include affected module tags**: when updating existing code, check whether affected module already has a `tt-*` tag and include it on task even if not primary focus.

## Architecture Knowledge Base

Technical reference is split across `ai/architecture/` by system tag:

- **`ai/architecture/GENERAL.md`** — stack, structure, env vars, DB patterns, local setup, commands. **Always read this first.**
- **`ai/architecture/tt-*.md`** — tag-specific files. Each `tt-` tag has a matching `.md` with schema, endpoints, files, and behavior details for that module.

**MCP tools** (via `tipatask` MCP server):
- `list_tasks` — list all tasks; optional `status`/`category` filters
- `get_task` — get single task by key
- `create_task` — create a new task
- `update_task` — patch task fields (status, title, description, priority, tags, assignee)
- `delete_task` — delete task by key
- `create_task_comment` — post a comment on a task; defaults to `type='resolution'` for self-authored completion reports (plain English, not caveman-styled)
- `list_task_resolutions` — browse past task comment history by tag (all comment types, closed tasks by default). Read prior-task context from here instead of writing it into `ai/architecture/tt-*.md` (see § KB Hygiene)
- `list_system_tags` — all `tt-*` tags with one-line descriptions (filesystem)
- `get_tag_architecture` — full architecture doc for a specific `tt-*` tag
- `create_system_tag` — write stub `tt-*.md` + register tag in DB; requires real `architecture_hint`
- `get_project_tags` — list project-level task tags from the database

### How to use

1. **Starting any task**: read `GENERAL.md` + call `get_tag_architecture` for each `tt-*` tag on the task.
2. **Creating/tagging tasks**: call `list_system_tags` to verify tags exist before assigning. Also use when unsure which tags cover a module.
3. **After changing system code**: update the relevant `tt-*.md` file(s) to reflect new/changed endpoints, schema, behavior, files. Update `GENERAL.md` if project structure, env vars, commands, or DB patterns changed. Standing system facts only — per-task investigation notes go in the resolution comment (see § KB Hygiene).
4. **New module/feature**: create a new `tt-*.md` file via `create_system_tag`, add to tipatask-expert skill taxonomy if maintained locally.

### Tag → file mapping (pattern)

| Working on... | Read |
|---|---|
| Auth flow | `tt-<area>-auth.md` (e.g. `tt-api-auth.md`) |
| API endpoints for module X | `tt-api-<module>.md` |
| Frontend page | `tt-web-<page>.md` |
| DB schema change | `tt-migrations.md`, plus affected module tag |

Call `list_system_tags` for the live project taxonomy.

## Tipatask API Access

To communicate with the Tipatask task API server, use `API_TOKEN` from `.tipatask/config.json` (project root) — the Task App's own `.env` no longer carries API credentials. Base URL and project ID are also configured there.

### MCP 401 fallback (expired `API_TOKEN`)

The remote `tipatask` MCP server authenticates with the project token that was in `API_TOKEN` when your session **launched**. It is a 7-day JWT, and Claude Code expands `${API_TOKEN}` from its own process environment, so a token that expired or was renewed later is not visible to a running session's frozen `$API_TOKEN` (the Task App normally renews a dying token before launch, and `/mcp` → Reconnect picks up a renewed one when the session was started with the headers helper). If every `tipatask` MCP call fails with `rejected the Authorization header` / HTTP 401 (the API's own reply reads `API token expired at <time>`), the token expired — `tipatask-local` keeps working. You cannot run `/mcp` yourself, so do not stop: finish through REST, reading the **current** credentials from `.tipatask/config.json` (`API_BASE_URL`, `API_PROJECT_ID`, `API_TOKEN`) — not from `$API_TOKEN` (the frozen launch value) and not from the Task App's own `.env` (it carries no credentials). Never print the token.

1. `POST {API_BASE_URL}/api/projects/{API_PROJECT_ID}/tasks/{KEY}/comments` with `{"content": "<resolution report>", "type": "resolution"}` → expect `201`.
2. `PATCH {API_BASE_URL}/api/projects/{API_PROJECT_ID}/tasks/{KEY}` with `{"status": "completed"}` (the project's complete-status name) → expect `200`.
3. `GET {API_BASE_URL}/api/projects/{API_PROJECT_ID}/tasks/{KEY}` and confirm the returned `status` — never assume the PATCH took effect.

Every request sends `Authorization: Bearer <token from config.json>`; write the JSON body to a file and use `-d @file` to avoid shell-quoting a long report. Example:

```bash
# read the CURRENT credentials from config.json (never echo the token)
read -r BASE PID TOK < <(node -e "const c=require('./.tipatask/config.json');console.log(c.API_BASE_URL,c.API_PROJECT_ID,c.API_TOKEN)")
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/projects/$PID/tasks/<KEY>/comments" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/resolution.json   # -> 201
```

If REST also answers `401 API token expired at …`, the token in `config.json` has expired too: say so in your final reply and ask the user to sign in again (Project ▸ Re-authenticate / Change Account) instead of retrying.

## Conventions

- Never change existing DB migrations — add new ones.
- Don't break existing.
- Don't revert user's manual changes.
- Speak English.
- Don't create instruction/doc files unless asked.
- Update `README.md` when adding user-facing CLI commands, setup steps, or workflow changes worth documenting.
- Missing functions/data to understand context? Ask — don't guess.
- Adding function calls + conditions: never cause fatal errors.
- Translation: handle for frontend + backend in files we edit/create where user-visible.
- **Architecture docs stay in sync**: any code change that adds/removes/modifies endpoints, DB schema, env vars, file structure, or module behavior → update matching `ai/architecture/tt-*.md` and/or `ai/architecture/GENERAL.md` before marking task complete — standing system facts only; task investigation notes, evidence tables and corrections go in the resolution comment, never in a `tt-*.md` (see § KB Hygiene).
- **Process safety**: before running any `npm run` command (build/typecheck/test/etc.), verify the active Node matches this project's pinned version (`.nvmrc`, `.tool-versions`, or `engines.node` against `node --version`) and switch first — a stale ambient npm can silently ignore `--workspace`/`--workspaces` flags and let a self-referential build script recurse without bound. To abort a backgrounded command, kill it by the PID or process group you captured when starting it — never by matching the command-line text (`pkill -f "..."`); npm's internal lifecycle re-exec drops the outer invocation text from every descendant's argv, so a substring match can never catch a runaway recursive chain.

## Version Control

The project's Version Control setting (Task App Settings ▸ Version Control, or the web project settings; off by default) decides what git work agents may do — not this file.

- **Live VCS verification**: before VCS writes, after resuming, and before completion, call `tipatask-local.git_worktree_status` with `task_key` and require `verified: true`. Current flags supersede kickoff snapshots. A failed or incomplete settings read grants no VCS writes and cannot waive an enabled merge requirement. Older tool builds: read `GET /api/projects/{API_PROJECT_ID}` with current `.tipatask/config.json` credentials (never print them), then restart the updated Task App to obtain local verification. When automatic merge is enabled, commit once per touched repository, merge nested task branches first and root last into each original checkout's CURRENT branch, preserve unrelated edits and correct gitlinks, and run relevant checks there. A PR is separate and never substitutes for local merge. Use `tipatask-local.complete_task(task_key, resolution)` for the final resolution/status pair; it rechecks settings and Git state before writing. If unavailable or verification fails, do not mark completed. Commit disabled never authorizes committing or merging.
- **Where to read it**: the directive block at the top of a task kickoff prompt — `Version control (git) is enabled for this project:` / `Version control (svn) is enabled for this project:` / `Version control is OFF for this project`. With no such block (Claude design mode, SIMPLE_MODE, chat and other ad-hoc sessions), call the `git_worktree_status` MCP tool (served by `tipatask-local`) and read the `vcs` flags it reports (`worktree`, `commit`, `pr`, `merge`); a "Git integration is not enabled" reply, an svn setting, or an error with no `vcs` object means Version Control is off.
- **Off, or git with commit off**: never run `git add`, `git commit`, `git push`, `git tag`, `git merge`, `git rebase`, or `git stash`, never create a branch or worktree, never open a PR, never write a commit message. Leave changes in the working tree, unstaged, and report what changed — the user commits. Only carve-outs, exactly as the kickoff directive gives them: with the worktree flag on you may create the task worktree and branch, and with the PR flag on you may push the task branch to open the PR. Read-only git (`status`, `diff`, `log`, `show`) is always fine.
- **Git with flags on**: do exactly what the enabled flags allow and nothing beyond them (worktree, commit, merge, PR) — including when the user asks for it directly in chat. The latest verified VCS settings govern writes, including when they differ from the kickoff snapshot. svn: only the `svn commit` the directive describes.

## Communication Style

- **Caveman ultra (all CODING task implementation)**: At the start of every CODING task, invoke the `caveman` skill with `ultra` intensity (`Skill: caveman, args: ultra`) if available — this loads the full style guide. Task App auto-prepends `use caveman` to all Claude prompts. No manual invocation needed by user. **Exception**: the self-authored resolution comment (3.6 above) is written in plain English prose, never caveman-styled — it is a report for the user to read later, not a live status update.
- **When blocked within this task's scope**: State the blocker in one sentence. Set task `on_fire` when available. Unrelated caveats do not block completion (§ Task status scope).
- **When done**: First call `create_task_comment` with your own self-authored resolution report (plain English, not caveman-styled), then set task status to `completed` via MCP — **before** sending final response. Brief confirmation, plus any unrelated caveats and supporting verification evidence.
- Confirm with `get_task` after `update_task`.
