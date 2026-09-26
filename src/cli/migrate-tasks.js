#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./http');
const { getApiCredentials } = require('../server/api-credentials');

const { resolveProjectRoot } = require('../server/project-root');

// Project root: TIPATASK_PROJECT_ROOT → nearest ancestor of cwd with .tipatask/config.json → cwd.
const PROJECT_ROOT = resolveProjectRoot();
// Legacy file-backend location inside the PROJECT (not this checkout).
const TODO_PATH = path.join(PROJECT_ROOT, 'ai', 'todo', 'TODO.md');
const TODO_REGEX = /^([\s\S]*?```json\s*\n)([\s\S]*)(```[\s\S]*)$/;

// ANSI helpers (same as setup.js)
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Field mapping (mirrors api-backend.js toApi)
// ---------------------------------------------------------------------------

function toApi(t) {
  return {
    task_key: t.id,
    title: t.title,
    description: t.description || t.title,
    category: t.category || 'CODING',
    status: t.status || 'pending',
    priority: t.priority ?? 0,
    display_order: t.order ?? 0,
    dependencies: t.dependencies || [],
    tags: t.tags || [],
    assignee: t.assignee ?? null,
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

function taskChanged(local, remote) {
  if (local.title !== remote.title) return true;
  if (local.description !== remote.description) return true;
  if (local.category !== remote.category) return true;
  if (local.status !== remote.status) return true;
  if (local.priority !== remote.priority) return true;
  if (local.display_order !== remote.display_order) return true;
  if (local.assignee !== remote.assignee) return true;
  if (JSON.stringify(local.dependencies) !== JSON.stringify(remote.dependencies || [])) return true;
  const localTags = [...(local.tags || [])].sort().join(',');
  const remoteTags = [...(remote.tags || [])].sort().join(',');
  if (localTags !== remoteTags) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Auth check helper
// ---------------------------------------------------------------------------

function checkAuth(status) {
  if (status === 401) {
    console.error(`\n  ${RED}Authentication failed (401).${RESET}`);
    console.error(`  Token may be expired. Run ${CYAN}npm run setup${RESET} to re-authenticate.\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync mode (default) — create/update per task, preserve API-only tasks
// ---------------------------------------------------------------------------

async function syncTasks(baseUrl, projectId, token, apiTasks, { dryRun, verbose }) {
  const listUrl = `${baseUrl}/api/projects/${projectId}/tasks`;
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. Fetch existing API tasks
  console.log(`  ${DIM}Fetching existing tasks from API...${RESET}`);
  const { status: listStatus, data: listData } = await request(listUrl, {
    method: 'GET',
    headers: authHeader,
  });
  checkAuth(listStatus);
  if (listStatus >= 400) {
    console.error(`\n  ${RED}Failed to fetch tasks (${listStatus}):${RESET}`);
    const detail = typeof listData === 'object' ? JSON.stringify(listData, null, 2) : listData;
    console.error(`  ${detail}\n`);
    process.exit(1);
  }

  const remoteTasks = (listData && listData.tasks) || [];
  const remoteMap = new Map();
  for (const t of remoteTasks) {
    remoteMap.set(t.task_key, t);
  }
  console.log(`  ${DIM}Found ${remoteTasks.length} existing tasks in API${RESET}\n`);

  // 2. Sync each local task
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const local of apiTasks) {
    const existing = remoteMap.get(local.task_key);

    if (existing) {
      // Task exists — check if changed
      if (!taskChanged(local, existing)) {
        counts.unchanged++;
        if (verbose) console.log(`    ${DIM}${local.task_key}${RESET}  unchanged`);
        continue;
      }

      // Changed — PATCH
      if (dryRun) {
        counts.updated++;
        if (verbose) console.log(`    ${YELLOW}${local.task_key}${RESET}  update (dry-run)`);
        continue;
      }

      const patchUrl = `${listUrl}/${encodeURIComponent(local.task_key)}`;
      const { status: patchStatus, data: patchData } = await request(patchUrl, {
        method: 'PATCH',
        headers: authHeader,
        body: local,
      });
      checkAuth(patchStatus);
      if (patchStatus >= 400) {
        counts.skipped++;
        if (verbose) {
          const detail = typeof patchData === 'object' ? JSON.stringify(patchData) : patchData;
          console.log(`    ${RED}${local.task_key}${RESET}  PATCH failed (${patchStatus}): ${detail}`);
        }
        continue;
      }
      counts.updated++;
      if (verbose) console.log(`    ${CYAN}${local.task_key}${RESET}  updated`);
    } else {
      // New task — POST
      if (dryRun) {
        counts.created++;
        if (verbose) console.log(`    ${GREEN}${local.task_key}${RESET}  create (dry-run)`);
        continue;
      }

      const { status: postStatus, data: postData } = await request(listUrl, {
        method: 'POST',
        headers: authHeader,
        body: local,
      });
      checkAuth(postStatus);

      // 409 = task_key already exists (race condition) — retry as PATCH
      if (postStatus === 409) {
        const patchUrl = `${listUrl}/${encodeURIComponent(local.task_key)}`;
        const { status: retryStatus, data: retryData } = await request(patchUrl, {
          method: 'PATCH',
          headers: authHeader,
          body: local,
        });
        checkAuth(retryStatus);
        if (retryStatus >= 400) {
          counts.skipped++;
          if (verbose) {
            const detail = typeof retryData === 'object' ? JSON.stringify(retryData) : retryData;
            console.log(`    ${RED}${local.task_key}${RESET}  PATCH retry failed (${retryStatus}): ${detail}`);
          }
          continue;
        }
        counts.updated++;
        if (verbose) console.log(`    ${CYAN}${local.task_key}${RESET}  updated (409→PATCH)`);
        continue;
      }

      if (postStatus >= 400) {
        counts.skipped++;
        if (verbose) {
          const detail = typeof postData === 'object' ? JSON.stringify(postData) : postData;
          console.log(`    ${RED}${local.task_key}${RESET}  POST failed (${postStatus}): ${detail}`);
        }
        continue;
      }
      counts.created++;
      if (verbose) console.log(`    ${GREEN}${local.task_key}${RESET}  created`);
    }
  }

  // 3. Summary
  console.log('');
  if (dryRun) console.log(`  ${YELLOW}Dry run complete — no API changes made.${RESET}`);
  console.log(`  ${GREEN}Created: ${counts.created}${RESET}, ${CYAN}Updated: ${counts.updated}${RESET}, Unchanged: ${counts.unchanged}${counts.skipped ? `, ${RED}Skipped: ${counts.skipped}${RESET}` : ''}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Force mode (legacy) — bulk PUT replace
// ---------------------------------------------------------------------------

async function forcePut(baseUrl, projectId, token, apiTasks, { dryRun, verbose }) {
  if (verbose) {
    for (const t of apiTasks) {
      const tagInfo = t.tags.length > 0 ? ` (${t.tags.length} tags)` : '';
      console.log(`    ${DIM}${t.task_key}${RESET}  ${t.title}${DIM}${tagInfo}${RESET}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log(JSON.stringify(apiTasks, null, 2));
    console.log(`\n  ${YELLOW}Dry run complete — ${apiTasks.length} tasks mapped, no API call made.${RESET}\n`);
    return;
  }

  const url = `${baseUrl}/api/projects/${projectId}/tasks`;
  console.log(`  ${DIM}Sending ${apiTasks.length} tasks to API (force PUT)...${RESET}`);

  const { status, data: resData } = await request(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: { tasks: apiTasks },
  });

  checkAuth(status);

  if (status === 400) {
    console.error(`\n  ${RED}Validation error (400):${RESET}`);
    const detail = typeof resData === 'object' ? JSON.stringify(resData, null, 2) : resData;
    console.error(`  ${detail}\n`);
    process.exit(1);
  }

  if (status >= 400) {
    console.error(`\n  ${RED}API error (${status}):${RESET}`);
    const detail = typeof resData === 'object' ? JSON.stringify(resData, null, 2) : resData;
    console.error(`  ${detail}\n`);
    process.exit(1);
  }

  const imported = resData && resData.tasks ? resData.tasks.length : apiTasks.length;
  console.log(`\n  ${GREEN}Success! ${imported} tasks imported into project ${projectId}.${RESET}\n`);
}

// ---------------------------------------------------------------------------
// Core import function (also exported for use by setup.js)
// ---------------------------------------------------------------------------

async function importFromTodo(baseUrl, projectId, token, todoPath, { dryRun = false, verbose = false, force = false } = {}) {
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. Read and parse TODO.md
  let raw;
  try {
    raw = fs.readFileSync(todoPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read TODO.md: ${err.message}`);
  }

  const match = raw.match(TODO_REGEX);
  if (!match) throw new Error('Could not parse TODO.md — no JSON code block found.');

  let data;
  try {
    data = JSON.parse(match[2]);
  } catch (err) {
    throw new Error(`Invalid JSON in TODO.md: ${err.message}`);
  }

  const tasks = data.tasks;
  if (!Array.isArray(tasks)) throw new Error('TODO.md JSON is missing a "tasks" array.');

  // Collect tag registry with descriptions
  const tagDescriptions = new Map();
  if (Array.isArray(data.tags)) {
    for (const entry of data.tags) {
      if (typeof entry === 'string') {
        if (!tagDescriptions.has(entry)) tagDescriptions.set(entry, null);
      } else if (entry && typeof entry.name === 'string') {
        const desc = typeof entry.description === 'string' && entry.description.length > 0
          ? entry.description : null;
        tagDescriptions.set(entry.name, desc);
      }
    }
  }
  for (const t of tasks) {
    if (Array.isArray(t.tags)) {
      for (const tag of t.tags) {
        if (!tagDescriptions.has(tag)) tagDescriptions.set(tag, null);
      }
    }
  }
  const allTags = [...tagDescriptions.keys()].sort().map(name => {
    const desc = tagDescriptions.get(name);
    return desc ? { name, description: desc } : name;
  });

  console.log(`  ${GREEN}Read ${tasks.length} tasks, ${allTags.length} tags from TODO.md${RESET}\n`);

  // 2. Sync tag registry first (ensure all tags exist before task sync)
  if (allTags.length > 0) {
    const tagsUrl = `${baseUrl}/api/projects/${projectId}/tags/bulk-migrate`;
    console.log(`  ${DIM}Syncing ${allTags.length} tags to API...${RESET}`);

    if (!dryRun) {
      const { status: tagStatus, data: tagData } = await request(tagsUrl, {
        method: 'POST',
        headers: authHeader,
        body: { tags: allTags },
      });
      checkAuth(tagStatus);
      if (tagStatus >= 400) {
        const detail = typeof tagData === 'object' ? JSON.stringify(tagData, null, 2) : tagData;
        throw new Error(`Failed to sync tags (${tagStatus}): ${detail}`);
      }
      const synced = tagData && tagData.tags ? tagData.tags.length : allTags.length;
      console.log(`  ${GREEN}Tag registry synced (${synced} tags in project)${RESET}\n`);
    } else {
      console.log(`  ${YELLOW}Tag sync skipped (dry-run) — ${allTags.length} tags would be synced${RESET}\n`);
    }
  }

  // 3. Sync sprints — ensure every priority value has a sprint record
  const sprintNumbers = [...new Set(tasks.map(t => t.priority).filter(p => typeof p === 'number' && p > 0))].sort((a, b) => a - b);
  if (sprintNumbers.length > 0) {
    const sprintsUrl = `${baseUrl}/api/projects/${projectId}/sprints`;
    console.log(`  ${DIM}Syncing ${sprintNumbers.length} sprint(s) to API...${RESET}`);

    if (!dryRun) {
      const { status: getStatus, data: sprintData } = await request(sprintsUrl, { method: 'GET', headers: authHeader });
      checkAuth(getStatus);
      const existingNumbers = new Set(
        getStatus < 400 && sprintData && sprintData.sprints
          ? sprintData.sprints.map(s => s.number)
          : []
      );
      let created = 0;
      for (const n of sprintNumbers) {
        if (existingNumbers.has(n)) continue;
        const { status: postStatus } = await request(sprintsUrl, {
          method: 'POST',
          headers: authHeader,
          body: { name: `Sprint ${n}`, number: n },
        });
        checkAuth(postStatus);
        if (postStatus < 400 || postStatus === 409) created++;
      }
      console.log(`  ${GREEN}Sprints synced (${created} created, ${sprintNumbers.length - created} already existed)${RESET}\n`);
    } else {
      console.log(`  ${YELLOW}Sprint sync skipped (dry-run) — ${sprintNumbers.length} sprint(s) would be synced${RESET}\n`);
    }
  }

  // 4. Map to API format and execute
  const apiTasks = tasks.map(toApi);
  if (force) {
    await forcePut(baseUrl, projectId, token, apiTasks, { dryRun, verbose });
  } else {
    await syncTasks(baseUrl, projectId, token, apiTasks, { dryRun, verbose });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const force = args.includes('--force');

  console.log(`\n  ${BOLD}Tip${CYAN}Δ${RESET}${BOLD}Task — Migrate TODO.md → API${RESET}\n`);

  let credentials;
  try {
    credentials = getApiCredentials(PROJECT_ROOT);
  } catch {
    console.error(`  ${RED}Missing API configuration.${RESET}`);
    console.error(`  Run ${CYAN}npm run setup${RESET} first to configure API connection.\n`);
    process.exit(1);
  }
  const { baseUrl, token, projectId } = credentials;

  console.log(`  ${DIM}API:        ${baseUrl}${RESET}`);
  console.log(`  ${DIM}Project ID: ${projectId}${RESET}`);
  console.log(`  ${DIM}Mode:       ${force ? 'force (bulk PUT)' : 'sync (create/update)'}${RESET}`);
  if (dryRun) console.log(`  ${YELLOW}Dry run:    enabled${RESET}`);
  console.log('');

  await importFromTodo(baseUrl, projectId, token, TODO_PATH, { dryRun, verbose, force });
}

module.exports = { importFromTodo, TODO_PATH };

if (require.main === module) {
  main().catch((err) => {
    if (err.message && err.message.includes('Request to')) {
      console.error(`\n  ${RED}API unreachable:${RESET} ${err.message}`);
      console.error(`  Make sure the Tipatask API server is running.\n`);
    } else {
      console.error(`\n  ${RED}Error:${RESET} ${err.message}\n`);
    }
    process.exit(1);
  });
}
