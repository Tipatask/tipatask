#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { selectAgent, confirm } = require('./prompts');

const ENV_PATH = path.resolve(__dirname, '../../.env');

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function readTaskAgent(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (/^TASK_AGENT=/.test(line)) return line.slice('TASK_AGENT='.length).trim();
    }
  } catch { /* missing .env — fall through */ }
  return 'claude';
}

function patchEnvAgent(filePath, agentId) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // file missing — will create with just this key
  }

  const lines = content.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (/^TASK_AGENT=/.test(line)) {
      found = true;
      return `TASK_AGENT=${agentId}`;
    }
    return line;
  });

  if (!found) updated.push(`TASK_AGENT=${agentId}`);

  const result = updated.join('\n');
  fs.writeFileSync(filePath, result.endsWith('\n') ? result : result + '\n', 'utf8');
}

async function main() {
  const { listAvailableTaskAgents } = require('../server/task-agent');
  const config = require('../server/config');
  const available = await listAvailableTaskAgents(config);

  if (available.length === 0) {
    process.stderr.write('No task agents installed. Install Claude Code or Codex first.\n');
    process.exit(1);
  }

  const currentId = readTaskAgent(ENV_PATH);

  if (available.length === 1) {
    const only = available[0];
    process.stdout.write(`Task agent: ${only.label} ${DIM}(only installed option)${RESET}\n`);
    process.exit(0);
  }

  const selected = await selectAgent(available, currentId);

  if (selected.id === currentId) {
    process.stdout.write(`TASK_AGENT already set to ${selected.label}\n`);
    process.exit(0);
  }

  patchEnvAgent(ENV_PATH, selected.id);

  process.stdout.write(`${GREEN}✓ TASK_AGENT set to ${selected.label}${RESET}\n`);
  process.stdout.write(`${DIM}Restart any running task terminals to use the new agent.${RESET}\n`);

  // Optionally add to AVAILABLE_AGENTS if it is set but missing the new id
  const envContent = (() => { try { return fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; } })();
  const availableLine = envContent.split('\n').find(l => /^AVAILABLE_AGENTS=/.test(l));
  if (availableLine !== undefined) {
    const currentList = availableLine.slice('AVAILABLE_AGENTS='.length).split(',').map(s => s.trim()).filter(Boolean);
    if (!currentList.includes(selected.id)) {
      const add = await confirm(`  Add ${selected.label} to AVAILABLE_AGENTS?`);
      if (add) {
        const newList = [...currentList, selected.id].join(',');
        const updated = envContent.split('\n').map(l =>
          /^AVAILABLE_AGENTS=/.test(l) ? `AVAILABLE_AGENTS=${newList}` : l
        ).join('\n');
        fs.writeFileSync(ENV_PATH, updated.endsWith('\n') ? updated : updated + '\n', 'utf8');
        process.stdout.write(`${GREEN}✓ AVAILABLE_AGENTS updated to ${newList}${RESET}\n`);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
