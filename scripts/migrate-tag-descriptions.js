#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('../src/cli/http');

const ENV_PATH = path.resolve(__dirname, '../.env');
const ARCH_DIR = path.join(require('../src/server/project-root').resolveProjectRoot(), 'ai', 'architecture');

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function readEnv(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    values[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return values;
}

function checkAuth(status) {
  if (status === 401) {
    console.error(`\n  ${RED}Authentication failed (401).${RESET}`);
    console.error(`  Token may be expired. Run ${CYAN}npm run setup${RESET} to re-authenticate.\n`);
    process.exit(1);
  }
}

const envFile = readEnv(ENV_PATH);
const env = {
  API_BASE_URL: envFile.API_BASE_URL,
  API_PROJECT_ID: envFile.API_PROJECT_ID,
  API_TOKEN: envFile.API_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || envFile.ANTHROPIC_API_KEY,
};

const missing = Object.keys(env).filter((k) => !env[k]);
if (missing.length) {
  console.error(`${RED}Missing required config: ${missing.join(', ')}${RESET}`);
  console.error(`Set in ${ENV_PATH} or export to environment.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

async function callClaude(archText) {
  const { status, data } = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: `Summarize this architecture doc in exactly 1 concise sentence (max 120 chars) describing what this module does. Output only the sentence.\n\n${archText}`,
        },
      ],
    },
    timeoutMs: 30000,
  });
  if (status !== 200) {
    throw new Error(`Anthropic ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const text = (data.content || [])
    .map((b) => b.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Empty response from Claude');
  return text;
}

function sanitize(raw) {
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (s.length > 120) s = s.slice(0, 117) + '...';
  return s;
}

async function main() {
  const baseUrl = env.API_BASE_URL;
  const projectId = env.API_PROJECT_ID;
  const authHeader = { Authorization: `Bearer ${env.API_TOKEN}` };

  console.log(`\n  ${BOLD}TipΔTask — migrate-tag-descriptions${RESET}`);
  if (dryRun) console.log(`  ${YELLOW}dry-run mode — no writes${RESET}`);
  console.log();

  const listRes = await request(`${baseUrl}/api/projects/${projectId}/tags`, {
    headers: authHeader,
  });
  checkAuth(listRes.status);
  if (listRes.status !== 200) {
    console.error(`${RED}Failed to list tags: ${listRes.status}${RESET}`, listRes.data);
    process.exit(1);
  }

  const allTags = listRes.data.tags || [];
  const todo = allTags.filter((t) => !t.description || !t.description.trim());

  console.log(`  ${allTags.length} total tags, ${todo.length} missing description\n`);

  if (todo.length === 0) {
    console.log(`  ${GREEN}Nothing to do.${RESET}\n`);
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const tag of todo) {
    const archPath = path.join(ARCH_DIR, `${tag.name}.md`);
    if (!fs.existsSync(archPath)) {
      console.warn(`  ${YELLOW}skip${RESET} ${tag.name} — no arch doc`);
      skipped++;
      continue;
    }

    const raw = fs.readFileSync(archPath, 'utf8').slice(0, 3000);

    let desc;
    try {
      desc = sanitize(await callClaude(raw));
    } catch (err) {
      console.warn(`  ${YELLOW}skip${RESET} ${tag.name} — Claude error: ${err.message}`);
      skipped++;
      continue;
    }

    if (!desc) {
      console.warn(`  ${YELLOW}skip${RESET} ${tag.name} — empty description after sanitize`);
      skipped++;
      continue;
    }

    if (verbose || dryRun) {
      console.log(`  ${CYAN}${tag.name}${RESET} → ${desc}`);
    }

    if (dryRun) {
      updated++;
      continue;
    }

    const putRes = await request(
      `${baseUrl}/api/projects/${projectId}/tags/${encodeURIComponent(tag.name)}`,
      { method: 'PUT', headers: authHeader, body: { description: desc } },
    );

    if (putRes.status === 200) {
      console.log(`  ${GREEN}✓${RESET} ${tag.name} → ${desc}`);
      updated++;
    } else if (putRes.status === 404) {
      console.warn(`  ${YELLOW}skip${RESET} ${tag.name} — tag not found (404)`);
      skipped++;
    } else {
      console.warn(
        `  ${YELLOW}skip${RESET} ${tag.name} — PUT ${putRes.status}: ${JSON.stringify(putRes.data).slice(0, 120)}`,
      );
      skipped++;
    }
  }

  console.log(`\n  ${BOLD}Done.${RESET} ${updated} updated, ${skipped} skipped (of ${todo.length} total missing)\n`);
}

main().catch((err) => {
  if (err.message && err.message.startsWith('Request to ')) {
    console.error(`\n  ${RED}API unreachable.${RESET} ${err.message}\n`);
  } else {
    console.error(`\n  ${RED}Error:${RESET}`, err.message || err);
  }
  process.exit(1);
});
