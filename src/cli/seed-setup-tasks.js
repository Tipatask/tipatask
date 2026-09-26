'use strict';

const fs = require('fs');
const path = require('path');
const { spawnMcpClient } = require('./mcp-client');
const { request } = require('./http');
const { isValidTaskKey } = require('../server/task-key-format');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// TPT200: every tag any seeder in this file puts on a task, with a real one-line
// description. A brand-new project only carries the 7 default action tags
// (api/src/lib/default-tags.js), and the API's PATCH /tasks/:taskKey validates every tag
// name BEFORE any write (C951) — one unregistered tag returns 400 and discards the whole
// finalize (title, description, priority, dependencies), stranding the reserved key as a
// blank is_reservation placeholder. registerSeedTags() below registers whatever is missing
// from this map first. Descriptions must be real: POST /tags rejects blank text and
// anything starting with "Auto-registered" (C1038).
const SEED_TAG_DESCRIPTIONS = {
  'existing-code': 'Work that inspects, maps, or builds on code that already existed before this project was set up in Tipatask.',
  'discovery': 'Investigating and documenting an unknown area (requirements, architecture, data model, user flows, stack) before build work starts.',
  'research': 'Open-ended investigation whose output is findings and recommendations rather than shipped code.',
  'tt-project-creation-wizard': 'Starter tasks seeded when a project is created through the Tipatask wizard or setup CLI: the discovery pipeline and preset backlog generation.',
  'tt-cli-setup': 'Tipatask setup CLI and project bootstrap: config files, knowledge-base seeding, and onboarding task seeding.',
  'tt-config': 'Project configuration and agent instruction files: CLAUDE.md, AGENTS.md, .tipatask/config.json, IDE and AI rule files.',
  'db-schema': 'Database tables, columns, indexes, and migrations: designing, changing, or documenting the schema.',
  // Already seeded on every new project by api/src/lib/default-tags.js — listed so a project
  // that lost or predates them still gets a real description instead of a failed finalize.
  'feature': 'Adding new user-facing or system capability that did not exist before.',
  'config': 'Adding or changing user-facing settings, preferences, and app configuration options.',
};

function buildAgentInstructionTask(projectRoot, priority) {
  return {
    title: 'Merge Tipatask task workflow into CLAUDE.md and AGENTS.md',
    category: 'CODING',
    priority,
    tags: ['tt-cli-setup', 'tt-config', 'feature', 'config'],
    description: [
      '1. Read @CLAUDE.md and @AGENTS.md — detect missing Tipatask sections:',
      '   Task Management, Architecture KB, Tag conventions, Communication Style, Status discipline.',
      '2. Read templates/CLAUDE.md and templates/AGENTS.md from the Task App checkout as merge source.',
      '3. If file absent: write from template, substituting `{{PROJECT_NAME}}` with `name` from @package.json (fallback: dir basename).',
      '4. If file exists: append only missing section blocks verbatim from template.',
      '5. Verify the task board URL uses port 4455 and that no path assumes where the Task App is installed.',
    ].join('\n'),
  };
}

function buildAuditAiIdeConfigTask(projectRoot, priority) {
  return {
    title: 'Audit existing AI & IDE config files for project context',
    category: 'CODING',
    priority,
    tags: ['tt-cli-setup', 'tt-config', 'feature', 'config'],
    description: [
      '1. Read @.claude/CLAUDE.md if exists — extract workflow, conventions, agent instructions already defined for this project.',
      '2. Check @.vscode/settings.json and @.vscode/extensions.json — note IDE-enforced formatting, linting rules, recommended extensions.',
      '3. Check @.cursorrules or @.cursor/rules if exists — extract Cursor AI rules.',
      '4. Check @.github/copilot-instructions.md if exists — extract Copilot custom instructions.',
      '5. Check root-level @AGENTS.md if exists (separate from Tipatask template) — note any pre-existing Codex instructions.',
      '6. Summarize findings: merge any non-duplicate conventions/instructions into @CLAUDE.md and @AGENTS.md, skip sections already covered by Tipatask template.',
    ].join('\n'),
  };
}

function buildGeneralMdTask(projectRoot, priority) {
  return {
    title: 'Complete ai/architecture/GENERAL.md with real project structure details',
    category: 'CODING',
    priority,
    tags: ['tt-config', 'tt-cli-setup', 'feature', 'db-schema'],
    description: [
      '1. Read @ai/architecture/GENERAL.md — list unfilled placeholders (`_(describe module)_`, `_(document purpose)_`, empty sections).',
      '2. Scan @package.json, top-level dirs (skip node_modules/dist/build/.git), @.env.example.',
      '3. Replace each `_(describe module)_` dir cell with real one-line purpose inferred from dir contents.',
      '4. Replace each `_(document purpose)_` env var cell with real description from .env.example comments or inferred.',
      '5. Fill STACK_SUMMARY, SETUP_COMMANDS, DB_NOTES if still placeholder.',
    ].join('\n'),
  };
}

function findFirstActivePriority(tasks) {
  const active = tasks
    .filter(t => t.category === 'CODING' && (t.status === 'pending' || t.status === 'in_progress'))
    .map(t => Number(t.priority))
    .filter(p => Number.isFinite(p));
  return active.length ? Math.min(...active) : 1;
}

// C1482: keys for every seeded placeholder task come from the atomic reserve_task_keys
// flow — never a local max-scan (raced with concurrent minters, and hardcoded the 'C'
// prefix which will be wrong once per-project prefixes are wired into the reservation
// endpoint, C1481). reserveKeysViaMcp() is the MCP-client-path counterpart of
// seedPresetTasks'/seedSyncTasks' own POST /tasks/reserve call below.
async function reserveKeysViaMcp(mcp, count) {
  const res = await mcp.callTool('reserve_task_keys', { count, category: 'CODING' });
  const keys = (res && res.keys) || [];
  if (keys.length !== count) {
    throw new Error(`reserve_task_keys returned ${keys.length} key(s), expected ${count}`);
  }
  for (const k of keys) {
    if (!isValidTaskKey(k)) throw new Error(`reserve_task_keys returned malformed key "${k}"`);
  }
  return keys;
}

// HTTP-path counterpart of reserveKeysViaMcp() above, for seedPresetTasks/seedSyncTasks
// (raw request(), not an MCP client). Calls the same atomic POST /tasks/reserve endpoint
// the MCP tool wraps (api/src/routes/tasks.js, C980) and returns the reserved keys in
// task_key order.
async function reserveKeysViaHttp({ apiBaseUrl, token, projectId, count }) {
  const { status, data } = await request(`${apiBaseUrl}/api/projects/${projectId}/tasks/reserve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { count, category: 'CODING', priority: 0 },
  });
  if (status >= 400) {
    throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  }
  const tasks = (data && data.tasks) || [];
  const keys = tasks.map(t => t.task_key || t.id);
  if (keys.length !== count) {
    throw new Error(`reserve endpoint returned ${keys.length} key(s), expected ${count}`);
  }
  for (const k of keys) {
    if (!isValidTaskKey(k)) throw new Error(`reserve endpoint returned malformed key "${k}"`);
  }
  return keys;
}

// TPT200: makes sure every tag in `tagNames` exists in the project's tag registry before any
// reserved key is finalized with it. Returns { known }: the subset of `tagNames` confirmed
// registered, or `known: null` when the registry could not be read at all (caller must then
// send tags unfiltered and rely on its own 400 fallback rather than drop every tag).
//
// Only MISSING tags are POSTed: POST /tags overwrites a changed description on an existing
// row (api/src/routes/tags.js), so re-sending `feature`/`config` would clobber the wording
// api/src/lib/default-tags.js seeded — or one the user has since customized.
// Non-fatal by design: a registration failure must degrade to "tag dropped, content still
// lands", never abort the preset.
async function registerSeedTags({ apiBaseUrl, token, projectId, tagNames }) {
  const wanted = [...new Set((tagNames || []).filter(n => typeof n === 'string' && n))];
  if (wanted.length === 0) return { known: new Set() };

  const base = `${apiBaseUrl}/api/projects/${projectId}/tags`;
  const headers = { Authorization: `Bearer ${token}` };

  let existing;
  try {
    const { status, data } = await request(base, { method: 'GET', headers });
    if (status >= 400) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    existing = new Set(((data && data.tags) || []).map(t => t && t.name));
  } catch (err) {
    console.log(`  ${YELLOW}Could not read project tags (${err.message}) — seeding without tag pre-registration${RESET}`);
    return { known: null };
  }

  const known = new Set(wanted.filter(n => existing.has(n)));
  const missing = wanted.filter(n => !existing.has(n));
  if (missing.length === 0) return { known };

  const registrable = missing.filter(n => SEED_TAG_DESCRIPTIONS[n]);
  const undescribed = missing.filter(n => !SEED_TAG_DESCRIPTIONS[n]);
  if (undescribed.length > 0) {
    console.log(`  ${YELLOW}No seed description for tag(s) ${undescribed.join(', ')} — leaving them off the seeded tasks${RESET}`);
  }
  if (registrable.length === 0) return { known };

  try {
    const { status, data } = await request(base, {
      method: 'POST',
      headers,
      body: { tags: registrable.map(name => ({ name, description: SEED_TAG_DESCRIPTIONS[name] })) },
    });
    if (status >= 400) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    // POST /tags answers with the project's full tag list — confirm against it when present
    // rather than trusting the status code alone.
    const returned = Array.isArray(data && data.tags) ? new Set(data.tags.map(t => t && t.name)) : null;
    for (const n of registrable) {
      if (!returned || returned.has(n)) known.add(n);
    }
  } catch (err) {
    console.log(`  ${YELLOW}Failed to register seed tag(s) ${registrable.join(', ')}: ${err.message}${RESET}`);
  }
  return { known };
}

// null `known` = registry unreadable, send tags as-is (see registerSeedTags).
function keepKnownTags(tags, known) {
  const list = Array.isArray(tags) ? tags : [];
  return known ? list.filter(t => known.has(t)) : list;
}

// TPT200: a finalize body must carry everything that makes a task startable. A missing field
// means PRESET_TASKS (or a builder) was edited into a shape that would PATCH a blank task, so
// refuse to send it. Returns an error string, or null when the body is complete.
function finalizeBodyError(body) {
  if (typeof body.title !== 'string' || !body.title.trim()) return 'title is empty';
  if (typeof body.description !== 'string' || !body.description.trim()) return 'description is empty';
  if (typeof body.status !== 'string' || !body.status) return 'status is missing';
  if (typeof body.priority !== 'number' || !Number.isFinite(body.priority)) return 'priority is not a number';
  return null;
}

// TPT200: checks the row PATCH /tasks/:taskKey echoes back (`{ task: <full row> }`). Flags a
// row still marked is_reservation, still carrying placeholder text, or missing its description.
// Only checks what the response affirmatively contradicts — a response with no `task` object
// (older API, unexpected shape) is not evidence of failure, so it passes.
function finalizedTaskError(data, body) {
  const task = data && typeof data === 'object' ? data.task : null;
  if (!task || typeof task !== 'object') return null;
  if (task.is_reservation) return 'response is still flagged is_reservation — the placeholder was not finalized';
  if (typeof task.title === 'string' && task.title.trim() !== body.title.trim()) {
    return `response title "${task.title}" does not match the title sent`;
  }
  if (!task.description || !String(task.description).trim()) return 'response has no description';
  if (task.description === RESERVE_PLACEHOLDER_DESCRIPTION) return 'response still carries the reservation placeholder description';
  return null;
}

// Mirrors api/src/lib/reservations.js RESERVE_PLACEHOLDER_DESCRIPTION (separate package —
// hand-synced, same convention as task-key-format.js).
const RESERVE_PLACEHOLDER_DESCRIPTION = 'Reserved key — pending finalization.';

async function runSeedSetupTasks({ projectRoot, apiBaseUrl, token, projectId }) {
  const builders = [buildAgentInstructionTask, buildGeneralMdTask, buildAuditAiIdeConfigTask];
  let seeded = 0;
  let failed = 0;
  let mcp;
  try {
    mcp = await spawnMcpClient();
  } catch (err) {
    console.log(`  ${YELLOW}Could not start MCP server: ${err.message}${RESET}`);
    return { seeded: 0, failed: builders.length };
  }
  try {
    let tasks = [];
    try {
      const res = await mcp.callTool('list_tasks', {});
      // list_tasks resolves to { project_id, tasks, ... } (see mcp-client.js callTool),
      // not a bare array — the pre-C1482 `Array.isArray(res)` check here was always
      // false, so seedPriority silently defaulted to 1 on every run. Fixed as a
      // drive-by while rewriting this block for the reservation flow.
      if (Array.isArray(res && res.tasks)) tasks = res.tasks;
    } catch { /* empty project — priority defaults to 1 */ }
    const seedPriority = findFirstActivePriority(tasks);
    const defs = builders.map(b => b(projectRoot, seedPriority));

    // TPT200: register the builders' tags before finalizing — update_task PATCHes with them,
    // and one unregistered tag 400s the whole finalize, stranding the reserved key blank.
    // Credentials are optional here (older callers); without them tags go through unfiltered.
    let known = null;
    if (apiBaseUrl && token && projectId != null) {
      ({ known } = await registerSeedTags({
        apiBaseUrl, token, projectId,
        tagNames: defs.flatMap(d => d.tags || []),
      }));
    }

    let keys;
    try {
      keys = await reserveKeysViaMcp(mcp, builders.length);
    } catch (err) {
      console.log(`  ${YELLOW}Could not reserve task keys: ${err.message}${RESET}`);
      return { seeded: 0, failed: builders.length };
    }

    // Reservation already created placeholder rows with real, collision-proof keys —
    // finalize each in place via update_task (title being set for the first time),
    // never create_task, which would 409 against the row the reservation just inserted.
    const stranded = [];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const body = {
        task_key: keys[i],
        title: def.title,
        description: def.description,
        priority: def.priority,
        tags: keepKnownTags(def.tags, known),
        status: 'pending',
      };
      try {
        const bodyErr = finalizeBodyError(body);
        if (bodyErr) throw new Error(bodyErr);
        try {
          await mcp.callTool('update_task', body);
        } catch (err) {
          // Registry unreadable or raced: the API refuses the whole finalize over one
          // unregistered tag. Content must still land — retry once without tags.
          if (!body.tags.length || !/not registered/i.test(err.message || '')) throw err;
          console.log(`  ${YELLOW}"${def.title}": tag(s) not registered — retrying without tags${RESET}`);
          await mcp.callTool('update_task', { ...body, tags: [] });
        }
        // Read it back: update_task reports success even if the row is somehow still a
        // reservation placeholder, which is exactly the blank-unstartable-task symptom.
        let readback = null;
        try { readback = await mcp.callTool('get_task', { task_key: keys[i] }); } catch { /* unverifiable — not a failure */ }
        if (readback && readback.task && readback.task.isReservation) {
          throw new Error('still flagged as a reservation after update_task — the placeholder was not finalized');
        }
        seeded++;
      } catch (err) {
        console.log(`  ${RED}Failed to seed "${def.title}" (${keys[i]}): ${err.message}${RESET}`);
        stranded.push(keys[i]);
        failed++;
      }
    }
    if (stranded.length > 0) {
      console.log(`  ${RED}${stranded.length} setup task(s) left as blank placeholders: ${stranded.join(', ')}${RESET}`);
    }
    console.log(`  ${GREEN}Seeded ${seeded} setup task(s)${failed ? `, ${failed} failed` : ''}${RESET}`);
  } finally {
    await mcp.close();
  }
  return { seeded, failed };
}

const ORIGINAL_SPEC_STARTER_TITLES = [
  'Draft initial system architecture',
  'Define data model and schema',
  'Identify core user flows',
  'Choose tech stack',
];

// ── Preset A code-scan step (C1065) ──
// A 5th starter task, seeded ahead of the four spec tasks and depended on by
// all of them (wired at seed time in seedPresetTasks — see below). Keeps the
// heavy scan/inspection text out of the four spec descriptions, which are
// already close to MAX_DESC_LEN.
const CODE_SCAN_TASK_TITLE = 'Scan for pre-existing code';

const CODE_SCAN_SKIP_DIRS = 'node_modules, dist, build, out, coverage, vendor, target, .git, .venv, __pycache__, .next, .cache, .idea, .vscode, and the Tipatask-owned ai, .tipatask, .claude, .codex';

function inspectionTaskBody(folder) {
  return [
    `This directory existed before Tipatask was set up. Establish what it is and what it is for — from the user, not by guessing. Read-only investigation: do not modify anything inside ${folder}.`,
    `1. Read enough of ${folder} to ask informed questions: manifest, README, entry files, top-level layout, languages and frameworks. Do not read the whole tree.`,
    '2. ASK THE USER in objective-chat, in batches of 3-5 questions, wait for answers, follow up on vague replies. Cover at minimum: what this codebase is and where it came from; whether it is kept, extended, replaced, or discarded in the new project; which parts are live vs dead; runtime, build, and deploy story; data stores and external integrations; known tech debt and no-touch areas; licensing or compliance limits. If the user says "you decide", record it as an explicit **Assumption** line.',
    `3. WRITE THE DELIVERABLE. Under the "## Existing Code" heading in @ai/architecture/GENERAL.md add a "### ${folder}" subsection: what it is, its intended role, stack, entry points, integrations, risks, and a one-line provenance note. Reuse the heading if a sibling task already created it. Keep it short — per-module depth belongs in ai/architecture/tt-*.md, not here.`,
    `4. TAG. Call list_system_tags. For each real module inside ${folder}, reuse a matching tt-* tag or call create_system_tag with a real architecture_hint. Then call update_task on THIS task with the final 3-5 tags.`,
    `5. SPAWN THE DEEP DIVE. From the answers, list the areas of ${folder} that still need investigation, print them in chat, and wait for the user's OK. Then call create_task once per approved area: title "Investigate ${folder}/<module>: <question it answers>", category "CODING", status "pending", priority = THIS task's own priority (call get_task on yourself first — never omit priority), dependencies ["<this task's key>"], 3-5 tags including the module's tt-* tag, and a description with numbered steps ending in a verification step. If a matching task already exists, update it instead of creating a duplicate.`,
  ].join('\n');
}

const CODE_SCAN_TASK_DESCRIPTION = [
  'Nothing else starts until this is done — the four specification starter tasks depend on this task and cannot be started before it completes.',
  `1. FIND PRE-EXISTING CODE. List the project root and each directory one level deep, skipping ${CODE_SCAN_SKIP_DIRS}. A directory counts as PRE-EXISTING CODE when it contains, at any depth, a source file (*.js, *.ts, *.tsx, *.py, *.rb, *.go, *.rs, *.java, *.kt, *.php, *.cs, *.swift, *.c, *.cpp, *.sql, *.vue, *.svelte, or any other language's sources) or a manifest (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, composer.json, pom.xml, Gemfile, *.csproj). Docs, images, data, or config alone is NOT code. If loose source files sit in the project root itself, treat the root as one candidate named "(project root)".`,
  '2. NONE FOUND. Write "No pre-existing code found." under the "## Existing Code" heading in @ai/architecture/GENERAL.md, say so in chat, mark this task completed, and create nothing.',
  '3. FOUND — ONE INSPECTION TASK PER FOLDER. Call list_tasks; skip every folder that already has a task titled "Inspect existing code: <folder>" in ANY status. For each remaining folder, call reserve_task_keys for one CODING key (never invent a key or a descriptive slug — create_task rejects anything else) then call create_task with: that key, title "Inspect existing code: <folder>", category "CODING", status "pending", priority = THIS task\'s own priority (call get_task on yourself and pass it explicitly — never omit priority), dependencies [], tags ["existing-code","research","discovery"], and description equal to the INSPECTION TASK BODY below, verbatim, with <folder> replaced by the real path.',
  `4. WIRE THE GATE, before completing yourself. For each of the four specification starter tasks — ${ORIGINAL_SPEC_STARTER_TITLES.map(t => `"${t}"`).join(', ')} — call get_task, then call update_task with dependencies set to its current dependency list UNION the new inspection task keys. update_task REPLACES the whole list — never send a bare list of only the new keys.`,
  '5. Report the created task keys in chat, post your resolution comment, and mark this task completed.',
  '',
  'INSPECTION TASK BODY — copy verbatim into each new task\'s description, replacing every <folder> with the real path:',
  inspectionTaskBody('<folder>'),
].join('\n');

function discoveryBlock(questionBullets) {
  return [
    '1. ASK THE USER FIRST. Read the "## Existing Code" section of @ai/architecture/GENERAL.md — the "Scan for pre-existing code" task you depend on already inventoried any code that was here before, and its inspection tasks recorded what it is for. Beyond that there is no code to read, so do not write the deliverable below from assumptions. In objective-chat, ask the user concrete clarifying questions until you can write it without guessing. Cover at minimum:',
    ...questionBullets.map(q => `   - ${q}`),
    '   Ask in batches of 3-5 questions, wait for answers, follow up on vague replies. If the user says "you decide", record it as an explicit **Assumption** line in the deliverable instead of silently choosing.',
  ].join('\n');
}

const DOC_SCAN_BLOCK = [
  '2. SCAN FOR EXISTING PROJECT DOCS. List every *.md, *.txt and *.pdf file in the project root and one level deep (skip node_modules, dist, build, .git, vendor). Show the user the list and ask, per file, whether it should be treated as project documentation / source of truth. Read every file the user confirms — for PDFs extract the text; if a PDF is not readable, say so and ask the user to paste the relevant part. Record the confirmed set under a "## Source Documents" heading in @ai/architecture/GENERAL.md. If that heading already exists (a sibling starter task already ran this step), reuse it and only ask about files not already listed there.',
].join('\n');

// C1142: was COMPLETION_GATE_BLOCK — a race gate shared by all four spec tasks
// ("whoever finishes last generates the backlog"). Since 'Choose tech stack' now
// depends on the other three, it IS last by construction — race check dropped,
// block pinned to that one task only. preset-a-backlog tag is now an idempotency
// guard (task re-run) rather than a race guard.
const BACKLOG_BLOCK = [
  '4. GENERATE THE BUILD BACKLOG — run this last, before marking yourself completed. You are the final spec task by construction: this task depends on "Draft initial system architecture", "Define data model and schema", and "Identify core user flows", so all three are already completed before you start.',
  '   a. Re-read @ai/architecture/GENERAL.md in full (Architecture, Data Model, Core User Flows, Stack, Source Documents, Existing Code).',
  '   b. Call list_tasks; if any task already carries the `preset-a-backlog` tag, you generated the backlog in an earlier run — skip generation. (Do not count the "Scan for pre-existing code" task, its "Inspect existing code: …" tasks, or any "Investigate …" tasks they spawned — those are inputs to the spec, not backlog output.)',
  '   c. Propose before creating: print the proposed backlog in chat as a numbered list (title + one-line scope each) and wait for the user\'s OK. Apply any edits they ask for.',
  '   d. Then call MCP create_task once per approved item: category "CODING", status "pending", priority = this task\'s current priority + 1 (build work belongs in the sprint after this one — do not inherit this task\'s own priority), a description with numbered implementation steps ending in a verification step, and 3-5 tags. Call list_system_tags first; for a module with no matching tag, call create_system_tag with a real architecture_hint.',
  '   e. Every backlog task must list the "Inspect existing code: …" tasks (and any "Investigate …" tasks they spawned) in its `dependencies`, so no build work starts before the pre-existing code is understood.',
  '   f. Tag every backlog task you create with `preset-a-backlog` in addition to its 3-5 real tags.',
  '   g. Order the backlog so dependencies come first: scaffold/config → data layer → API → UI → tests/deploy.',
].join('\n');

// ── Preset B (existing-code) pipeline (C1096) ──
// Mirrors preset A's scan → inspect → document → gate shape, but framed around
// code that already IS the project's foundation — not legacy to scan defensively.
// Also replaces the old wizard Description step: "Profile the project with the
// user" interviews the user instead, and folds in what used to be presets
// C/D/E (legacy-project, existing-frontend, existing-backend) as conditional
// tracks the gate can scaffold once the profile says which apply.

const EXISTING_CODE_MAP_TASK_TITLE = 'Map the existing codebase';

const EXISTING_CODE_DOC_TITLES = [
  'Document system architecture from the code',
  'Document data model and schema from the code',
  'Document core user flows from the code',
  'Document stack, commands, and environment',
];

const EXISTING_CODE_SPRINT2_TITLES = [...EXISTING_CODE_DOC_TITLES, 'Discover modules and create per-tag KB tasks'];

// Sole surviving home for the old C/D/E presets' substance (legacy-project,
// existing-frontend, existing-backend — removed C1102, no longer offered by
// either the wizard or the CLI). "Profile the project with the user" (below)
// decides which of these apply from the codebase + the user's answers; the
// completion gate expands the chosen ones into real backlog tasks. One-liners
// on purpose — same pattern the gate already uses for its own backlog items.
const CONDITIONAL_TRACKS = {
  legacy: [
    ['Document legacy API surface', 'List existing endpoints, request/response shapes, auth rules.'],
    ['Identify tech debt hotspots', 'Find risky/outdated modules; rank by impact.'],
    ['Plan modernisation approach', 'Outline migration phases, risks, and target stack.'],
  ],
  frontend: [
    ['Inventory frontend components and routes', 'List pages, components, route map, shared UI primitives.'],
    ['Define API contract requirements', 'Specify endpoints/payloads frontend needs from backend.'],
    ['Plan state management approach', 'Decide store/library, data flow, caching strategy.'],
  ],
  backend: [
    ['Map existing API endpoints', 'Catalog routes, methods, auth, response shapes.'],
    ['Design frontend integration layer', 'Plan client SDK, error model, pagination conventions.'],
    ['Define auth and session strategy', 'Pick auth scheme, token lifetime, session storage.'],
  ],
};

function existingCodeInspectionBody(folder) {
  return [
    `This directory is part of the existing codebase this project is built on. Establish what it does and how it fits — from the user, not by guessing. Read-only investigation: do not modify anything inside ${folder}.`,
    `1. Read enough of ${folder} to ask informed questions: manifest, README, entry files, top-level layout, languages and frameworks. Do not read the whole tree.`,
    '2. ASK THE USER in objective-chat, in batches of 3-5 questions, wait for answers, follow up on vague replies. Cover at minimum: what this codebase is and where it came from; whether it is kept, extended, replaced, or discarded going forward; which parts are live vs dead; runtime, build, and deploy story; data stores and external integrations; known tech debt and no-touch areas; licensing or compliance limits. If the user says "you decide", record it as an explicit **Assumption** line.',
    `3. WRITE THE DELIVERABLE. Under the "## Existing Code" heading in @ai/architecture/GENERAL.md add a "### ${folder}" subsection: what it is, its role in the project, stack, entry points, integrations, risks, and a one-line provenance note. Reuse the heading if a sibling task already created it. Keep it short — per-module depth belongs in ai/architecture/tt-*.md, not here.`,
    `4. TAG. Call list_system_tags. For each real module inside ${folder}, reuse a matching tt-* tag or call create_system_tag with a real architecture_hint. Then call update_task on THIS task with the final 3-5 tags.`,
    `5. SPAWN THE DEEP DIVE. From the answers, list the areas of ${folder} that still need investigation, print them in chat, and wait for the user's OK. Then call create_task once per approved area: title "Investigate ${folder}/<module>: <question it answers>", category "CODING", status "pending", priority = THIS task's own priority (call get_task on yourself first — never omit priority), dependencies ["<this task's key>"], 3-5 tags including the module's tt-* tag, and a description with numbered steps ending in a verification step. If a matching task already exists, update it instead of creating a duplicate.`,
  ].join('\n');
}

const EXISTING_CODE_MAP_TASK_DESCRIPTION = [
  'Nothing in sprint 2 starts until this is done — the documentation tasks depend on this task and cannot start before it completes.',
  `1. FIND THE CODE. List the project root and each directory one level deep, skipping ${CODE_SCAN_SKIP_DIRS}. A directory counts as CODE when it contains, at any depth, a source file (*.js, *.ts, *.tsx, *.py, *.rb, *.go, *.rs, *.java, *.kt, *.php, *.cs, *.swift, *.c, *.cpp, *.sql, *.vue, *.svelte, or any other language's sources) or a manifest (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, composer.json, pom.xml, Gemfile, *.csproj). Docs, images, data, or config alone is NOT code. If loose source files sit in the project root itself, treat the root as one candidate named "(project root)".`,
  '2. NONE FOUND. The user picked Existing Codebase, so finding no code is unexpected — say so in chat, ask the user where the code actually lives (unscanned subfolder, private submodule, not checked out yet), write whatever they say under the "## Existing Code" heading in @ai/architecture/GENERAL.md, mark this task completed, and create nothing.',
  '3. FOUND — ONE INSPECTION TASK PER FOLDER. Call list_tasks; skip every folder that already has a task titled "Inspect existing code: <folder>" in ANY status. For each remaining folder, call reserve_task_keys for one CODING key (never invent a key or a descriptive slug — create_task rejects anything else) then call create_task with: that key, title "Inspect existing code: <folder>", category "CODING", status "pending", priority = THIS task\'s own priority (call get_task on yourself and pass it explicitly — never omit priority), dependencies [], tags ["existing-code","research","discovery"], and description equal to the INSPECTION TASK BODY below, verbatim, with <folder> replaced by the real path.',
  `4. WIRE THE GATE, before completing yourself. For each of these sprint-2 tasks — ${EXISTING_CODE_SPRINT2_TITLES.map(t => `"${t}"`).join(', ')} — call get_task, then call update_task with dependencies set to its current dependency list UNION the new inspection task keys. update_task REPLACES the whole list — never send a bare list of only the new keys.`,
  '5. Report the created task keys in chat, post your resolution comment, and mark this task completed.',
  '',
  'INSPECTION TASK BODY — copy verbatim into each new task\'s description, replacing every <folder> with the real path:',
  existingCodeInspectionBody('<folder>'),
].join('\n');

const EXISTING_CODE_PROFILE_TASK_DESCRIPTION = [
  'Depends on "Map the existing codebase" — read its output before asking anything.',
  '1. READ FIRST. Read the "## Existing Code" and "## Project Structure" sections of @ai/architecture/GENERAL.md and any findings already written by the "Inspect existing code: …" tasks — don\'t block on ones still pending.',
  '2. ASK THE USER in objective-chat, in batches of 3-5 questions, wait for answers, follow up on vague replies. Cover at minimum: what the product does and who uses it; what gets built or changed next; whether this codebase is kept as the long-term foundation, migrated off, or partially replaced; which surfaces exist or are planned — frontend, backend, mobile, library — and which need work; deploy story and hosting constraints; anything off-limits or already scheduled for removal. If the user says "you decide", record it as an explicit **Assumption** line.',
  '3. PICK RECOMMENDED TRACKS. From the answers, decide which of these apply — only if the answers actually call for it, never by default:',
  '   - `legacy` — this codebase, or part of it, is being migrated off or replaced.',
  '   - `frontend` — a frontend surface exists or is planned and needs an API contract / state strategy.',
  '   - `backend` — a backend surface exists or is planned and needs endpoint mapping / integration design.',
  '   None, one, or several may apply — a fullstack rewrite could pick all three; a pure library addition may pick none.',
  '4. WRITE THE DELIVERABLE. Under a "## Project Profile" heading in @ai/architecture/GENERAL.md, summarize the answers (product, users, direction, surfaces, constraints), then add a "### Recommended Tracks" subsection listing the chosen track names (or "none") with a one-line reason each. End with a one-line provenance note (answers came from the user).',
].join('\n');

function codeFirstBlock(readTargets, confirmBullets) {
  return [
    `1. READ THE CODE FIRST, THEN ASK. Read the "## Existing Code" and "## Project Structure" sections of @ai/architecture/GENERAL.md — the "Map the existing codebase" task and its inspection tasks already inventoried what is here. Then read the code itself: ${readTargets}. Do not read the whole tree — enough to answer the deliverable below with real detail. Once you've read the code, ask the user in objective-chat only what the code cannot answer:`,
    ...confirmBullets.map(q => `   - ${q}`),
    '   Ask in batches of 3-5 questions, wait for answers, follow up on vague replies. If the user says "you decide", record it as an explicit **Assumption** line in the deliverable instead of silently choosing.',
  ].join('\n');
}

const EXISTING_CODE_GATE_BLOCK = [
  '4. COMPLETION GATE — run this last, before marking yourself completed.',
  `   a. Call MCP list_tasks. Find the other three documentation tasks of this preset: ${EXISTING_CODE_DOC_TITLES.map(t => `"${t}"`).join(', ')}.`,
  '   b. If ANY of the other three is not status completed, stop here: mark this task completed and do nothing else. The last documentation task to finish is the one that runs step c.',
  '   c. If ALL of the other three are completed, you are last — generate the real build backlog:',
  '      - Re-read @ai/architecture/GENERAL.md in full (Project Structure, Existing Code, Project Profile, Architecture, Data Model, Core User Flows, Stack, Commands, Environment Variables).',
  '      - Read the "### Recommended Tracks" list under "## Project Profile" — it names which of the legacy / frontend / backend tracks apply, decided during "Profile the project with the user".',
  '      - Call list_tasks once more; if any task already carries the `preset-b-backlog` tag, another documentation task won the race — skip generation. (Do not count the "Map the existing codebase" task, its "Inspect existing code: …" tasks, or any "Investigate …" tasks they spawned — those are inputs to the docs, not backlog output.)',
  '      - Propose before creating: print the proposed backlog in chat as a numbered list (title + one-line scope each) — the recommended tracks\' items expanded into full numbered descriptions, plus anything else the assembled docs and the user\'s stated goals call for — and wait for the user\'s OK. Apply any edits they ask for.',
  '      - Then call MCP create_task once per approved item: category "CODING", status "pending", priority = this task\'s current priority + 1 (build work belongs in the sprint after the docs sprint — do not inherit this task\'s own priority), a description with numbered implementation steps ending in a verification step, and 3-5 tags. Call list_system_tags first; for a module with no matching tag, call create_system_tag with a real architecture_hint.',
  '      - Every backlog task must list the "Inspect existing code: …" tasks (and any "Investigate …" tasks they spawned) in its `dependencies`, so no build work starts before the existing code is understood.',
  '      - Tag every backlog task you create with `preset-b-backlog` in addition to its 3-5 real tags.',
  '      - Order the backlog so dependencies come first: scaffold/config → data layer → API → UI → tests/deploy.',
].join('\n');

const PRESET_TASKS = {
  'original-specification': [
    [
      CODE_SCAN_TASK_TITLE,
      CODE_SCAN_TASK_DESCRIPTION,
      { priority: 1, tags: ['existing-code', 'discovery', 'research'] },
    ],
    [
      'Draft initial system architecture',
      [
        discoveryBlock([
          'what the product does and who uses it',
          'v1 must-haves vs. later/nice-to-have',
          'expected scale / number of users',
          'third-party services it must integrate with',
          'hosting/deploy constraints',
          'auth model',
          'realtime or offline needs',
          'existing systems it must talk to',
        ]),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Architecture" heading in @ai/architecture/GENERAL.md, describe the high-level components, their responsibilities, boundaries, and the data flow between them — based on the user\'s answers and any confirmed docs. End with a one-line provenance note (answers came from the user / from <doc>).',
      ].join('\n'),
      { priority: 2, dependsOnCodeScan: true, tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Define data model and schema',
      [
        discoveryBlock([
          'the core entities, in the user\'s own words',
          'tenancy model (single user / team / org)',
          'required fields per entity',
          'relations and cardinality between entities',
          'soft-delete / audit / history needs',
          'PII and retention rules',
          'file and media storage needs',
        ]),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Data Model" heading in @ai/architecture/GENERAL.md, write an entity table (fields, types, nullability), the relations and cardinality between entities, and key indexes — based on the user\'s answers and any confirmed docs. End with a one-line provenance note (answers came from the user / from <doc>).',
      ].join('\n'),
      { priority: 2, dependsOnCodeScan: true, tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Identify core user flows',
      [
        discoveryBlock([
          'actor roles (who uses the product)',
          'the 3-5 journeys that must work for v1',
          'entry point per journey (signup, invite, deep link, etc.)',
          'success and failure states per journey',
          'emails/notifications triggered along the way',
          'permissions required at each step',
        ]),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Core User Flows" heading in @ai/architecture/GENERAL.md, write one numbered end-to-end step list per journey, naming the actor and the success/failure states — based on the user\'s answers and any confirmed docs. End with a one-line provenance note (answers came from the user / from <doc>).',
      ].join('\n'),
      { priority: 2, dependsOnCodeScan: true, tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Choose tech stack',
      [
        discoveryBlock([
          'languages/frameworks the user or team already knows',
          'existing infra or hosting accounts',
          'DB preferences or constraints',
          'budget constraints',
          'deploy target',
          'CI expectations',
          'web / mobile / desktop targets',
          'hard constraints (compliance, on-prem, etc.)',
        ]),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Fill the existing "## Stack" table in @ai/architecture/GENERAL.md (Runtime / Framework / Database / Deploy target) with a rationale column, based on the user\'s answers and any confirmed docs. End with a one-line provenance note (answers came from the user / from <doc>).',
        BACKLOG_BLOCK,
      ].join('\n'),
      // C1142: depends on code-scan (0) AND the other three spec tasks (1,2,3) — picking
      // a stack before architecture/data-model/user-flows exist is explicitly disallowed
      // (templates/preset-a.md "What to AVOID"). Seeds one sprint after them (priority 3).
      { priority: 3, dependsOn: [0, 1, 2, 3], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
  ],
  'existing-code': [
    [
      EXISTING_CODE_MAP_TASK_TITLE,
      EXISTING_CODE_MAP_TASK_DESCRIPTION,
      { priority: 1, tags: ['existing-code', 'discovery', 'research'] },
    ],
    [
      'Profile the project with the user',
      EXISTING_CODE_PROFILE_TASK_DESCRIPTION,
      { priority: 1, dependsOn: [0], tags: ['tt-project-creation-wizard', 'discovery', 'feature'] },
    ],
    [
      'Document system architecture from the code',
      [
        codeFirstBlock(
          'entry files, routers/controllers, how modules call each other, config that wires them together',
          [
            'what gets built or changed next, beyond what already exists',
            'expected scale / number of users going forward',
            'planned third-party integrations not yet in the code',
            'hosting/deploy constraints for what comes next',
            'realtime or offline needs not yet implemented',
            'other systems this must talk to that aren\'t wired up yet',
          ],
        ),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Architecture" heading in @ai/architecture/GENERAL.md, describe the high-level components that exist today, their responsibilities, boundaries, and the data flow between them — based on what you read in the code and the user\'s answers about what\'s next. End with a one-line provenance note (code / user answers / <doc>).',
        EXISTING_CODE_GATE_BLOCK,
      ].join('\n'),
      { priority: 2, dependsOn: [0, 1], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Document data model and schema from the code',
      [
        codeFirstBlock(
          'schema files, migrations, ORM models/entities, and how they relate',
          [
            'planned schema changes or new entities',
            'tenancy model if not obvious from the code (single user / team / org)',
            'PII and retention rules',
            'soft-delete / audit / history needs not yet implemented',
            'file and media storage plans',
          ],
        ),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Data Model" heading in @ai/architecture/GENERAL.md, write an entity table (fields, types, nullability) reflecting the real schema/models, the relations and cardinality between entities, and key indexes — based on the code and the user\'s answers about what\'s changing. End with a one-line provenance note (code / user answers / <doc>).',
        EXISTING_CODE_GATE_BLOCK,
      ].join('\n'),
      { priority: 2, dependsOn: [0, 1], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Document core user flows from the code',
      [
        codeFirstBlock(
          'routes/pages, controllers, and the auth-gated paths through the app',
          [
            'actor roles beyond what the code already distinguishes',
            'the 3-5 journeys that must work next, in the user\'s own words',
            'journeys that exist in the code but are being reworked or dropped',
            'success and failure states not covered by the current code',
            'emails/notifications planned but not yet wired up',
            'permission gaps to close before the next journey ships',
          ],
        ),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Under a "## Core User Flows" heading in @ai/architecture/GENERAL.md, write one numbered end-to-end step list per journey that exists today (naming the actor and the success/failure states), plus any journey the user says is coming next marked "(planned)" — based on the code and the user\'s answers. End with a one-line provenance note (code / user answers / <doc>).',
        EXISTING_CODE_GATE_BLOCK,
      ].join('\n'),
      { priority: 2, dependsOn: [0, 1], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Document stack, commands, and environment',
      [
        codeFirstBlock(
          'package manifests, lockfiles, build/deploy config, CI files, and .env.example',
          [
            'budget constraints',
            'deploy target changes planned',
            'CI expectations if none exist yet',
            'additional web/mobile/desktop targets planned',
            'hard constraints (compliance, on-prem, etc.) not visible in config',
          ],
        ),
        DOC_SCAN_BLOCK,
        '3. WRITE THE DELIVERABLE. Fill the "## Stack" table in @ai/architecture/GENERAL.md (Runtime / Framework / Database / Deploy target) from the real manifests and config, with a rationale column where the user explained a choice. Fill "## Commands" with the real dev/build/test/deploy commands from package.json scripts or equivalent. Fill "## Environment Variables" with the real vars from .env.example plus a one-line description each. End with a one-line provenance note (code / user answers / <doc>).',
        EXISTING_CODE_GATE_BLOCK,
      ].join('\n'),
      { priority: 2, dependsOn: [0, 1], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
    [
      'Discover modules and create per-tag KB tasks',
      [
        'Two-phase KB discovery. Do NOT document every module in this one session — spawn one sub-task per module.',
        '1. Read @ai/architecture/GENERAL.md — use the "## Project Structure" and "## Existing Code" sections from the prior "Map the existing codebase" task.',
        '2. Identify each distinct module/subsystem (one per meaningful top-level dir; skip node_modules/dist/build/.git).',
        '3. For EACH module, call MCP create_task with:',
        '   - title: "Document [module]: create tt-[tag].md via create_system_tag"',
        '   - description (three steps):',
        '       1. Read the module\'s source files.',
        '       2. Call create_system_tag with the module\'s schema, endpoints, key files, and behavior.',
        '       3. Verify ai/architecture/tt-[tag].md exists and names at least 3 exported functions/handlers.',
        '4. Create the sub-tasks ONLY — do not write any tt-*.md in this session. Each sub-task is executed separately.',
      ].join('\n'),
      { priority: 2, dependsOn: [0, 1], tags: ['tt-project-creation-wizard', 'feature', 'discovery'] },
    ],
  ],
};

// C1102: legacy-project/existing-frontend/existing-backend (C/D/E) removed —
// the CLI (src/cli/setup.js) now offers the same 2 presets as the wizard.
// Their substance lives on in CONDITIONAL_TRACKS above, which existing-code's
// profile task recommends from real user answers instead of asking the user
// to guess a preset up front.
const PRESET_LETTER = {
  'original-specification': 'a',
  'existing-code':          'b',
};

function parsePresetTemplate(content) {
  const overlayMatch = content.match(/^## CLAUDE\.md Overlay\s*\n([\s\S]*?)(?=^## GENERAL\.md Seed)/m);
  const generalMatch = content.match(/^## GENERAL\.md Seed\s*\n([\s\S]*)/m);
  return {
    'CLAUDE.md Overlay': overlayMatch ? overlayMatch[1].trim() : '',
    'GENERAL.md Seed':   generalMatch ? generalMatch[1].trim() : '',
  };
}

function resolveProjectName(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch { /* no package.json — fall through */ }
  return path.basename(projectRoot);
}

function applyPresetTemplate(preset, projectRoot, presetDescription) {
  const letter = PRESET_LETTER[preset];
  if (!letter) return;
  const tplPath = path.join(__dirname, '..', '..', 'templates', `preset-${letter}.md`);
  let tplContent;
  try {
    tplContent = fs.readFileSync(tplPath, 'utf8');
  } catch {
    console.log(`  ${YELLOW}Preset template not found: ${tplPath}${RESET}`);
    return;
  }
  const desc = presetDescription || '';
  const projectName = resolveProjectName(projectRoot);
  tplContent = tplContent
    .replace(/\{\{PRESET_DESCRIPTION\}\}/g, desc)
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
  const sections = parsePresetTemplate(tplContent);

  // Write CLAUDE.md overlay
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  const overlayContent = sections['CLAUDE.md Overlay'];
  if (overlayContent) {
    try {
      const existing = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
      const separator = existing.trim() ? '\n\n---\n\n' : '';
      fs.writeFileSync(claudePath, existing + separator + overlayContent + '\n', 'utf8');
    } catch (err) {
      console.log(`  ${YELLOW}Could not write CLAUDE.md overlay: ${err.message}${RESET}`);
    }
  }

  // Write GENERAL.md seed
  const generalDir = path.join(projectRoot, 'ai', 'architecture');
  const generalPath = path.join(generalDir, 'GENERAL.md');
  const seedContent = sections['GENERAL.md Seed'];
  if (seedContent) {
    try {
      fs.mkdirSync(generalDir, { recursive: true });
      let writeMode = 'overwrite';
      if (fs.existsSync(generalPath)) {
        const existing = fs.readFileSync(generalPath, 'utf8');
        // Only overwrite if still placeholder-only content
        if (!existing.includes('_(describe module)_') && existing.trim().length > 0) {
          writeMode = 'prepend';
        }
      }
      if (writeMode === 'overwrite') {
        fs.writeFileSync(generalPath, seedContent + '\n', 'utf8');
      } else {
        const existing = fs.readFileSync(generalPath, 'utf8');
        const block = `<!-- preset-context -->\n${seedContent}\n<!-- /preset-context -->\n\n`;
        fs.writeFileSync(generalPath, block + existing, 'utf8');
      }
    } catch (err) {
      console.log(`  ${YELLOW}Could not write GENERAL.md seed: ${err.message}${RESET}`);
    }
  }
}

async function seedPresetTasks(preset, { projectRoot, apiBaseUrl, token, projectId, presetDescription } = {}) {
  const defs = PRESET_TASKS[preset];
  if (!defs) return { seeded: 0, failed: 0 };

  if (projectRoot) {
    applyPresetTemplate(preset, projectRoot, presetDescription || null);
  }
  let seeded = 0, failed = 0;

  // TPT200: register every tag the preset uses BEFORE reserving keys — a finalize PATCH that
  // names an unregistered tag 400s as a whole (the API validates tags before any write), so
  // reserving first would strand N blank placeholders for nothing. A fresh project only has
  // the 7 default action tags; existing-code/discovery/research/tt-* are not among them.
  const { known } = await registerSeedTags({
    apiBaseUrl, token, projectId,
    tagNames: defs.flatMap(([, , extra = {}]) => extra.tags ?? []),
  });

  // C1482: keys come from the atomic reservation endpoint — never a local max-scan
  // of GET /tasks (raced with concurrent minters, hardcoded the 'C' prefix, and a
  // plain GET excludes live-but-unfinalized reservation rows so a scan could even
  // reuse a key someone else already claimed).
  let keys;
  try {
    keys = await reserveKeysViaHttp({ apiBaseUrl, token, projectId, count: defs.length });
  } catch (err) {
    console.log(`  ${YELLOW}Failed to reserve ${defs.length} task key(s) for preset "${preset}": ${err.message}${RESET}`);
    return { seeded: 0, failed: defs.length };
  }

  // C1065/C1096: seeded defs always land on the reserved keys in order, so a def can
  // reference an earlier sibling by index instead of a race-prone runtime lookup.
  // `dependsOn` is a list of def indexes; the legacy `dependsOnCodeScan: true`
  // (preset A) is kept as an alias for `dependsOn: [0]`. Each key already has a
  // placeholder row from the reservation — finalize with PATCH, not POST (which
  // would 409 against that row).
  // Finalize contract (TPT200): the PATCH must clear is_reservation and persist title +
  // description + status + priority. Each body is asserted complete before it is sent, and
  // the row the API echoes back is asserted finalized after — a task that comes back still
  // flagged as a reservation is a hard error, not a silent "seeded".
  const stranded = [];
  for (let i = 0; i < defs.length; i++) {
    const [title, description, extra = {}] = defs[i];
    const dependsOnIdx = extra.dependsOn ?? (extra.dependsOnCodeScan ? [0] : []);
    const dependencies = dependsOnIdx.map(idx => keys[idx]);
    const body = {
      title,
      description,
      category: 'CODING',
      status: 'pending',
      priority: extra.priority ?? 1,
      dependencies,
      tags: keepKnownTags(extra.tags ?? [], known),
    };
    const url = `${apiBaseUrl}/api/projects/${projectId}/tasks/${encodeURIComponent(keys[i])}`;
    const patch = (b) => request(url, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: b });
    try {
      const bodyErr = finalizeBodyError(body);
      if (bodyErr) throw new Error(`refusing to PATCH an incomplete body: ${bodyErr}`);

      let res = await patch(body);
      // Registry unreadable or raced: one unregistered tag 400s the whole finalize and the API
      // reports which (`missing`). Content must still land — retry once without tags.
      if (res.status === 400 && res.data && Array.isArray(res.data.missing) && res.data.missing.length > 0 && body.tags.length > 0) {
        console.log(`  ${YELLOW}"${title}": tag(s) not registered (${res.data.missing.join(', ')}) — retrying without tags${RESET}`);
        res = await patch({ ...body, tags: [] });
      }
      if (res.status >= 400) throw new Error(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));

      const finalizeErr = finalizedTaskError(res.data, body);
      if (finalizeErr) throw new Error(finalizeErr);
      seeded++;
    } catch (err) {
      console.log(`  ${RED}Failed to seed "${title}" (${keys[i]}): ${err.message}${RESET}`);
      stranded.push(keys[i]);
      failed++;
    }
  }
  if (stranded.length > 0) {
    console.log(`  ${RED}${stranded.length} preset task(s) left as blank placeholders: ${stranded.join(', ')}${RESET}`);
  }
  console.log(`  ${GREEN}Seeded ${seeded} placeholder tasks for preset: ${preset}${RESET}${failed ? ` (${failed} failed)` : ''}`);
  return { seeded, failed };
}

// TPT203: one-line human summary of a seedPresetTasks() outcome, shared by the setup CLI and the
// Electron wizard (via project-seeder.js) so neither silently drops a partial seed. `result` is
// `{ seeded, failed }` from seedPresetTasks, or `{ seeded: 0, failed: null, error }` when the call
// itself threw. Returns null when everything seeded (or there is nothing to report).
function describePresetSeedProblem(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error) return `Preset task seeding failed: ${result.error}`;
  const failed = Number(result.failed) || 0;
  if (failed <= 0) return null;
  const total = failed + (Number(result.seeded) || 0);
  return `${failed} of ${total} preset task(s) could not be seeded.`;
}

const SYNC_TASK_DEFS = [
  {
    title: 'Verify AVAILABLE_AGENTS consistency across project devices',
    description: [
      '1. Call GET /api/devices — inspect each device\'s `available_agents` field.',
      '2. Flag devices where `available_agents` is null/empty — they haven\'t synced yet.',
      '3. Compare agent sets across devices; log any mismatch (e.g. one device missing codex).',
      '4. Re-run `npm run setup` → "Sync agent config with API" on under-configured devices.',
    ].join('\n'),
  },
  {
    title: 'Push local KB to API after agent config sync',
    description: [
      '1. Ensure `.tipatask/config.json` has valid API_BASE_URL + API_TOKEN + API_PROJECT_ID.',
      '2. Trigger setup → Sync KB with remote, or call the MCP `push_knowledge` tool; both live-read credentials from `.tipatask/config.json`.',
      '3. Verify all local KB files (CLAUDE.md, AGENTS.md, ai/architecture/*.md) appear in GET /api/projects/:id/knowledge.',
    ].join('\n'),
  },
];

async function seedSyncTasks({ apiBaseUrl, token, projectId }) {
  // Fetch existing tasks for title-dedup + priority
  let tasks = [];
  try {
    const { status, data } = await request(`${apiBaseUrl}/api/projects/${projectId}/tasks`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (status === 200) tasks = Array.isArray(data) ? data : (data.tasks || data.data || []);
  } catch { /* non-fatal */ }

  const existingTitles = new Set(tasks.map(t => (t.title || '').trim().toLowerCase()));
  const priority = findFirstActivePriority(tasks);

  // C1482: dedupe against existing titles first, then reserve exactly as many keys as
  // defs actually need seeding — never a bare POST with no task_key at all (which used
  // to 400 silently here, since validateTask requires task_key on every non-epic
  // create). Route through the reservation flow like every other seeder in this file.
  const toSeed = SYNC_TASK_DEFS.filter(def => !existingTitles.has(def.title.trim().toLowerCase()));
  const skipped = SYNC_TASK_DEFS.length - toSeed.length;

  let seeded = 0;
  if (toSeed.length > 0) {
    let keys;
    try {
      keys = await reserveKeysViaHttp({ apiBaseUrl, token, projectId, count: toSeed.length });
    } catch (err) {
      console.log(`  ${YELLOW}Failed to reserve ${toSeed.length} sync task key(s): ${err.message}${RESET}`);
      keys = [];
    }
    for (let i = 0; i < keys.length; i++) {
      const def = toSeed[i];
      try {
        const { status, data } = await request(`${apiBaseUrl}/api/projects/${projectId}/tasks/${encodeURIComponent(keys[i])}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: { title: def.title, description: def.description, category: 'CODING', status: 'pending', priority },
        });
        if (status >= 400) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
        seeded++;
      } catch (err) {
        console.log(`  ${YELLOW}Failed to seed "${def.title}": ${err.message}${RESET}`);
      }
    }
  }
  if (seeded > 0) {
    console.log(`  ${GREEN}Seeded ${seeded} sync follow-up task(s)${skipped ? ` (${skipped} already exist)` : ''}${RESET}`);
  }
  return { seeded, skipped };
}

module.exports = {
  runSeedSetupTasks, buildAgentInstructionTask, buildGeneralMdTask, buildAuditAiIdeConfigTask,
  seedPresetTasks, seedSyncTasks, applyPresetTemplate,
  // TPT200 — tag pre-registration before finalize, exported for src/cli/seed-setup-tasks.test.js
  SEED_TAG_DESCRIPTIONS, registerSeedTags,
  // TPT203 — finalize-body/response assertions, exported so every rejection branch is unit-testable
  finalizeBodyError, finalizedTaskError, describePresetSeedProblem,
  // C1065 — exported for src/cli/seed-setup-tasks.test.js
  PRESET_TASKS, CODE_SCAN_TASK_TITLE, CODE_SCAN_TASK_DESCRIPTION, inspectionTaskBody,
  BACKLOG_BLOCK, ORIGINAL_SPEC_STARTER_TITLES, discoveryBlock,
  // C1096 — preset B (existing-code) pipeline, exported for src/cli/seed-setup-tasks.test.js
  EXISTING_CODE_MAP_TASK_TITLE, EXISTING_CODE_MAP_TASK_DESCRIPTION, EXISTING_CODE_DOC_TITLES,
  EXISTING_CODE_SPRINT2_TITLES, EXISTING_CODE_PROFILE_TASK_DESCRIPTION, EXISTING_CODE_GATE_BLOCK,
  existingCodeInspectionBody, codeFirstBlock, CONDITIONAL_TRACKS,
};
