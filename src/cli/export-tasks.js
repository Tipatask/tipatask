#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./http');
const { getApiCredentials } = require('../server/api-credentials');

const { resolveProjectRoot } = require('../server/project-root');

// Project root: --project-root is not a flag here, so TIPATASK_PROJECT_ROOT → cwd walk-up → cwd.
const PROJECT_ROOT = resolveProjectRoot();
// Legacy file-backend location inside the PROJECT (not this checkout).
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'ai', 'todo', 'TODO.md');

// ANSI helpers
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Field mapping (inverse of migrate-tasks.js toApi)
// ---------------------------------------------------------------------------

function fromApi(t) {
  return {
    id: t.task_key,
    title: t.title,
    description: t.description || '',
    category: t.category || 'CODING',
    status: t.status || 'pending',
    priority: t.priority ?? 0,
    order: t.display_order ?? 0,
    dependencies: t.dependencies || [],
    tags: t.tags || [],
    assignee: t.assignee ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  // Parse --output <path>
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1]
    ? path.resolve(args[outputIdx + 1])
    : DEFAULT_OUTPUT;

  console.log(`\n  ${BOLD}Tip${CYAN}Δ${RESET}${BOLD}Task — Export API → TODO.md${RESET}\n`);

  // 1. Load credentials from the selected project's config.json.
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
  console.log(`  ${DIM}Output:     ${outputPath}${RESET}`);
  if (dryRun) console.log(`  ${YELLOW}Mode:       dry-run (print only, no file write)${RESET}`);
  console.log('');

  // 2. Fetch tasks and tags from API
  const tasksUrl = `${baseUrl}/api/projects/${projectId}/tasks`;
  const tagsUrl = `${baseUrl}/api/projects/${projectId}/tags`;
  const authHeader = { Authorization: `Bearer ${token}` };
  console.log(`  ${DIM}Fetching tasks and tags from API...${RESET}`);

  const [tasksRes, tagsRes] = await Promise.all([
    request(tasksUrl, { method: 'GET', headers: authHeader }),
    request(tagsUrl, { method: 'GET', headers: authHeader }),
  ]);

  if (tasksRes.status === 401 || tagsRes.status === 401) {
    console.error(`\n  ${RED}Authentication failed (401).${RESET}`);
    console.error(`  Token may be expired. Run ${CYAN}npm run setup${RESET} to re-authenticate.\n`);
    process.exit(1);
  }

  if (tasksRes.status >= 400) {
    console.error(`\n  ${RED}API error fetching tasks (${tasksRes.status}):${RESET}`);
    const detail = typeof tasksRes.data === 'object' ? JSON.stringify(tasksRes.data, null, 2) : tasksRes.data;
    console.error(`  ${detail}\n`);
    process.exit(1);
  }

  if (tagsRes.status >= 400) {
    console.error(`\n  ${RED}API error fetching tags (${tagsRes.status}):${RESET}`);
    const detail = typeof tagsRes.data === 'object' ? JSON.stringify(tagsRes.data, null, 2) : tagsRes.data;
    console.error(`  ${detail}\n`);
    process.exit(1);
  }

  // 3. Map to TODO.md format
  const apiTasks = Array.isArray(tasksRes.data.tasks) ? tasksRes.data.tasks : [];
  const tasks = apiTasks.map(fromApi);
  const tags = Array.isArray(tagsRes.data.tags)
    ? tagsRes.data.tags
        .map(t => {
          if (typeof t === 'string') return t;
          return t.description ? { name: t.name, description: t.description } : t.name;
        })
        .sort((a, b) => {
          const an = typeof a === 'string' ? a : a.name;
          const bn = typeof b === 'string' ? b : b.name;
          return an.localeCompare(bn);
        })
    : [];

  console.log(`  ${GREEN}Fetched ${tasks.length} tasks, ${tags.length} tags from API${RESET}\n`);

  if (verbose) {
    for (const t of tasks) {
      const tagInfo = t.tags.length > 0 ? ` (${t.tags.join(', ')})` : '';
      console.log(`    ${DIM}${t.id}${RESET}  ${t.title}${DIM}${tagInfo}${RESET}`);
    }
    if (tags.length > 0) {
      const tagDisplay = tags
        .map(t => (typeof t === 'string' ? t : `${t.name} (${t.description})`))
        .join(', ');
      console.log(`\n    ${DIM}Tag registry (${tags.length}): ${tagDisplay}${RESET}`);
    }
    console.log('');
  }

  // 4. Build markdown
  const markdown = `# TODO\n\n\`\`\`json\n${JSON.stringify({ tasks, tags }, null, 2)}\n\`\`\`\n`;

  // 5. Dry-run: print and exit
  if (dryRun) {
    console.log(markdown);
    console.log(`  ${YELLOW}Dry run complete — ${tasks.length} tasks exported, no file written.${RESET}\n`);
    return;
  }

  // 6. Write file
  fs.writeFileSync(outputPath, markdown, 'utf8');
  console.log(`  ${GREEN}Success! ${tasks.length} tasks written to ${outputPath}${RESET}\n`);
}

main().catch((err) => {
  if (err.message && err.message.includes('Request to')) {
    const urlMatch = err.message.match(/Request to (\S+)/);
    const tried = urlMatch ? urlMatch[1] : 'unknown';
    console.error(`\n  ${RED}API unreachable:${RESET} ${err.message}`);
    console.error(`  URL tried: ${tried}`);
    console.error(`  Make sure the Tipatask API server is running.\n`);
  } else {
    console.error(`\n  ${RED}Error:${RESET} ${err.message}\n`);
  }
  process.exit(1);
});
