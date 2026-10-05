---
name: tipatask-expert
description: >
  Tipatask project expert. Guides tag application to tasks, architecture file navigation,
  and system-specific tag management. Always active for this project.
  Load when: creating tasks, working on a task, reading architecture, applying tags,
  looking up system modules, asking about project structure.
---

# Tipatask Expert

System-specific tags (`tt-*`) are the primary navigation mechanism for the architecture knowledge base at `ai/architecture/`. Every task should carry the right `tt-*` tags. Every implementation session should load the matching architecture files before touching code.

## MCP Server Split

Two MCP servers are registered — call each tool on the right one:

- **`tipatask`** (remote HTTP, primary) — everything in this skill: `list_system_tags`, `get_tag_architecture`, `get_tag_architectures`, `get_project_tags`, `create_system_tag`, `ensure_project_tag`, plus all task CRUD.
- **`tipatask-local`** (stdio, this machine only) — 4 tools that need a repo checkout or git worktree the remote API doesn't have: `batch_grep_tags`, `push_knowledge`, `pull_knowledge`, `git_worktree_status`. None of them are covered by this skill.

If a tool call fails with "tool not found," check you called it on the right server name.

## Credential recovery

Project config holds only the API target; the account store under TIPATASK_USER_DATA holds credentials. Follow CLAUDE.md’s Credential recovery and completion section. Missing user-data paths are not expiry. Never print tokens or bypass local completion verification with a REST status write.

## Architecture Context Loading

**Before implementing anything:**
1. Read `ai/architecture/GENERAL.md` — stack, structure, env vars, DB patterns, commands.
2. Identify the `tt-*` tags on the task (or relevant to the work).
3. Read `ai/architecture/{tag-name}.md` for each relevant tag.

**MCP tools available (all on the `tipatask` server):**
- `list_system_tags` — live list of all `tt-*` tags with one-line descriptions. Call this when unsure which tags exist.
- `get_tag_architecture` — returns full content of `ai/architecture/{tag}.md`. Call for detailed module info before coding.
- `get_project_tags` — lists project-level task tags from the DB (non-`tt-*` tags).
- `create_system_tag` — registers a new tag + writes its architecture stub to the project's knowledge base. On a local checkout this materializes as `ai/architecture/{tag}.md` once synced (`pull_knowledge`, on `tipatask-local`) — the write itself lands in the KB database, not directly on this machine's disk. Pass a real `architecture_hint`.

**No hardcoded taxonomy** — the live project taxonomy is in the database + `ai/architecture/`. Use `list_system_tags` every time.

---

## Semantic Context Discovery via Tag Descriptions

Task-listed tags are a starting point, not the whole picture. Tag descriptions (returned by `list_system_tags`) summarize each module in one line — scan them to find adjacent modules the work likely touches.

### Step 0.5 — Before loading arch docs

1. Call `list_system_tags` → returns `[{tag, description}, ...]`.
2. Extract keywords from the task title + description (verbs, nouns, module names, file path fragments).
3. Match keywords against each tag's `description` text (case-insensitive substring or stem match).
4. Build the **load set** = task-listed tags ∪ tags whose description semantically overlaps with the work.
5. Call `get_tag_architectures(tag_names=[...load set...])` once (batch read).

### Overlap rule

Load a tag's arch doc if its description names:
- A module the work will read/write (e.g. task mentions "sync" → `tt-knowledge-sync`)
- A data flow the work crosses (e.g. task mentions "API endpoint" + module name → `tt-api-<module>`)
- A subsystem the work coordinates with (e.g. setup/CLI changes → `tt-cli-setup` even if not tagged)

Skip when the description is clearly orthogonal (e.g. task about kanban UI won't need `tt-api-auth-jwt`).

### Example

Task: *"Sync project knowledge files to API on save"*

- Task tags: `tt-knowledge-sync`
- Description scan matches:
  - `tt-knowledge-sync` ("syncs KB files to/from API") — already on task
  - `tt-api-knowledge` ("knowledge files API: stores/serves CLAUDE.md, architecture/...") — **add**, work crosses this boundary
  - `tt-config` ("Configuration & Documentation") — skip, too generic for this work
- Load set: `[tt-knowledge-sync, tt-api-knowledge]`

### Budget

- Cap added tags at **3** beyond task-listed. More than 3 matches → re-read the task description; you're matching too loosely.
- Track loaded tags in working memory — never re-load the same arch file twice in a session.

---

## Applying Tags to a Task

### Step 1 — Identify the primary feature/module

Pick the most specific `tt-*` tag that covers the code area touched. Pattern: `tt-{area}-{module}`.

Examples of the pattern:
- API route handlers for a module → `tt-api-<module>` (e.g. `tt-api-tasks`, `tt-api-auth`)
- Frontend page → `tt-web-<page>` (e.g. `tt-web-kanban`, `tt-web-dashboard`)
- Database schema changes → `tt-migrations` + the affected module tag
- Auth flow → `tt-api-auth` (+ sub-tag when applicable, e.g. `tt-api-auth-oauth`)

**Use subtags when the work is specifically about a sub-feature** — scan `list_system_tags` for sub-tags before falling back to a parent tag.

### Step 2 — Add action type tag

One of: `feature`, `bugfix`, `refactor`, `migration`, `config`, `security`, `css`.

### Step 3 — Add detail tags (1-2, when non-trivial)

Implementation technique: `drag-and-drop`, `inline-edit`, `modal`, `polling`, `animation`, `responsive`, `crud`, `validation`, `websocket`, `streaming`, `pagination`.

### Step 4 — Verify count

**3-5 tags total.** At minimum: 1 feature/module + 1 action. Add detail tags when the implementation technique is significant.

### Anti-patterns

- **Too generic**: `backend`, `frontend`, `ui`, `database` — say nothing useful. Replace with specific module tags.
- **Missing system tag**: if the task touches a project module, it must have at least one `tt-*` tag.
- **Wrong subtag vs parent**: use subtag (e.g. `tt-task-cards-drag-drop`) when the work is specifically about that sub-feature; use parent (e.g. `tt-task-cards`) when touching the card system broadly.
- **Inventing tags**: always call `list_system_tags` first. New tags only when three-condition rule (below) holds.
- **Not scanning descriptions**: loading only task-listed tags misses related modules touched by the work. Always run Step 0.5 (Semantic Context Discovery) before loading arch files.

---

## When to Create a New System-Specific Tag

Create a new `tt-*` tag when **all three** are true:
1. **The module/feature is distinct** — not a sub-feature already covered by an existing tag (scan `list_system_tags` first)
2. **Multiple future tasks will use it** — one-off tasks don't need new tags; recurring feature areas do
3. **No existing tag fits** — scan the taxonomy; existing tags cover many sub-areas

**Process for new tag:**
1. Choose name: `tt-{area}-{module}` pattern (e.g. `tt-web-notifications`, `tt-api-webhooks`)
2. Call `create_system_tag(tag_name, description, architecture_hint)` — this writes an architecture stub to the project's knowledge base + inserts a DB row (materializes as `ai/architecture/{tag}.md` on disk once synced — see MCP Server Split above). `architecture_hint` must describe module purpose, key files, and endpoints (so the generated stub is useful, not empty).
3. Apply the new tag via `update_task(task_key, tags=[...])`.

**Do NOT create new tags for:**
- One-off bug fixes that happen to touch a module (use parent tag)
- Generic concepts already covered (e.g. auth tag covers all auth work)
- Work spanning many modules (use multiple existing tags instead)

---

## Keeping Architecture In Sync

Any code change that adds/removes/modifies:
- DB schema → update `tt-migrations.md` + affected `tt-*.md`
- API endpoints → update the module's `tt-*.md`
- Env vars / file structure / setup commands → update `ai/architecture/GENERAL.md`
- Module behavior → update the relevant `tt-*.md`

Update architecture **before** marking the task `completed`. Stale architecture = broken onboarding for the next agent.

**Standing concepts only**: every line above is a durable fact about how the system works, not about this task. Task-specific investigation notes, evidence, and corrections never go in a `tt-*.md` — see § Post-Task Completion Checklist step 3 below for where they do go.

---

## Post-Task Completion Checklist

Run this **before `tipatask-local.complete_task(task_key, resolution)`**. The guarded tool posts the report and completion status together; do not bypass it with `update_task`.

### 1. Tags accurate?
- Call `list_system_tags` if any touched module might need a new `tt-*` tag
- Task must have ≥1 `tt-*` module tag + 1 action tag + 1-2 detail tags
- Call `update_task(tags=[...])` if current tags are wrong or missing

### 2. Architecture docs updated?
For each `tt-*` tag on the task, ask: *did this session change anything the next agent would need to know?*
- New methods, endpoints, DB tables → update `tt-*.md`
- Env vars, file structure, commands → update `GENERAL.md`
- If the answer is "no change" — that's fine, nothing to update

### 3. Non-obvious discoveries captured?
This is the most commonly skipped step. Capture anything surprising — but **where** you write it depends on whether it's a standing fact or task narrative:

**Durable module gotcha → KB.** Still true and useful once this task is forgotten:
- **Third-party library gotchas** (e.g. a library option that doesn't work as documented)
- **Workarounds** that look wrong but are intentional
- **Behavior that contradicts the docs** or common intuition
- **Ordering/timing constraints** that aren't obvious from the code

Write it as one or two standing lines in a "Gotchas"/"Known issues" block in the relevant `tt-*.md` — no investigation log, no dates, no task keys, no evidence tables. Cross-project/reusable (a library pattern, a framework quirk) → save a `feedback_*.md` memory file in the project memory dir and add a pointer to `MEMORY.md` instead.

**Task narrative → resolution comment, never the KB.** How you found it, what you tried first, evidence tables of observed values, dated findings, and any correction of your own earlier analysis:
- Pass the report to `tipatask-local.complete_task(task_key, resolution)` after verification; use `create_task_comment` only for separate investigation notes during work.
- To read how a past task went, call `list_task_resolutions(tags=[...])` — that is where this narrative lives, not `ai/architecture/*.md`.

**Line test**: would this line still be worth reading a year from now, with this task long forgotten? Yes → KB. No → resolution comment. Naming a task key, a date, or what you personally tried is itself the answer: resolution comment.

**Rule of thumb**: if you had to try multiple approaches before finding the working one, the working approach (and why the others failed) is worth noting.
