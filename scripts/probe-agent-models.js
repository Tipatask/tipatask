#!/usr/bin/env node
'use strict';

// (C1504) Live probe for the per-agent model registry. Calls listAllAgentModels() in-process
// against the REAL installed claude/codex CLIs — no mocking, no todo-server needed — so this
// is how the feature gets verified without starting a second server on port 4455 (which would
// collide with the user's already-running app; see feedback_no_standalone_todo_server memory).
//
// Usage:
//   npm run probe:agent-models                # cache-aware (respects the 24h/5min TTLs)
//   npm run probe:agent-models -- --force      # bypass cache, force a fresh probe
//   npm run probe:agent-models -- --agent claude
//   npm run probe:agent-models -- --agent codex --force

const config = require('../src/server/config');
const { listAllAgentModels, listAgentModels } = require('../src/server/task-agent');

function parseArgs(argv) {
  const opts = { agent: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') opts.agent = argv[++i];
    else if (argv[i] === '--force') opts.force = true;
  }
  return opts;
}

function printEntry(id, entry) {
  console.log(`\n=== ${id} — source=${entry.source} probedAt=${new Date(entry.probedAt).toISOString()} ===`);
  if (!entry.models || entry.models.length === 0) {
    console.log('  (no models)');
    return;
  }
  for (const m of entry.models) {
    console.log(`  ${m.isLatest ? '*' : ' '} ${m.id.padEnd(28)} ${m.label}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  if (opts.agent) {
    const entry = await listAgentModels(opts.agent, config, { force: opts.force });
    printEntry(entry.agent, entry);
  } else {
    const agents = await listAllAgentModels(config, { force: opts.force });
    for (const [id, entry] of Object.entries(agents)) printEntry(id, entry);
  }

  console.log(`\nelapsed=${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('[probe-agent-models] failed:', err);
  process.exitCode = 1;
});
