'use strict';

// Claude Code PostToolUse hook — track file paths accessed by task agent.
// Invoked automatically for Read/Edit/Write/Grep/Glob tool calls.
// No-op when TIPATASK_TASK_ID is unset (non-Task-App Claude sessions).

// Bare specifiers (not `node:fs`/`node:path`) — the `node:` prefix for require() needs
// Node >=14.18, and this hook can be spawned under whatever `node` wins PATH resolution
// (C1041). Hoisted out of the try block below so a genuine failure is visible instead of
// silently swallowed — under Node <14.18 these used to throw here and no-op forever with
// zero signal.
const fs = require('fs');
const path = require('path');

const nodeMajor = parseInt(process.versions.node, 10);
if (nodeMajor < 22) {
  // Never block the agent — just leave a breadcrumb on stderr (hook stdout is reserved
  // for hookSpecificOutput JSON elsewhere in the hook chain).
  console.error(`[track-file-access] skipped — node ${process.version} (${process.execPath}) below required major 22`);
  process.exit(0);
}

const taskId = process.env.TIPATASK_TASK_ID;
const trackDir = process.env.TIPATASK_TRACK_DIR;

if (!taskId || !trackDir) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const toolInput = event.tool_input || {};
    // Read/Edit/Write use file_path; Grep/Glob use path
    const filePath = toolInput.file_path || toolInput.path;
    if (!filePath || typeof filePath !== 'string') process.exit(0);

    fs.mkdirSync(trackDir, { recursive: true });
    fs.appendFileSync(path.join(trackDir, `${taskId}.txt`), filePath + '\n');
  } catch { /* ignore silently — never block agent */ }
});
