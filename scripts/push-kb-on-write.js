'use strict';

// Claude Code PostToolUse hook — auto-push architecture-KB edits to the
// remote API (C1037). Fires after Edit/Write/MultiEdit. Replaces the
// "agent must remember to call push_knowledge" reliability gap described in
// CLAUDE.md step 3.5.
//
// Unlike track-file-access.js this hook does NOT gate on TIPATASK_TASK_ID —
// a KB edit made in a plain interactive Claude session (not just Task App
// task execution) must sync too. Gating is config-based (TASK_BACKEND=api +
// live credentials), resolved inside autoPushOnEdit().
//
// Kill switch: TIPATASK_KB_AUTOPUSH=0 (off) | dry (log-only, no PUT).
//
// Never blocks the agent: every path exits 0. Failures surface only via
// non-blocking additionalContext (so the agent can fall back to
// push_knowledge) and a line in .tipatask/kb-autopush.log.

// Bare specifiers — see track-file-access.js for why (C1041: `node:` requires need
// Node >=14.18, and this hook can be spawned under whatever `node` wins PATH resolution).
const path = require('path');
const fs = require('fs');

// Project root: TIPATASK_PROJECT_ROOT (stamped by the Task App into every agent spawn),
// else the hook event's own `cwd` (Claude Code runs hooks from the project directory), else
// this process's cwd. Never derived from where this checkout lives.
function resolveHookProjectRoot(event) {
  return process.env.TIPATASK_PROJECT_ROOT
    || (event && typeof event.cwd === 'string' && event.cwd)
    || process.cwd();
}
// C1490 — skipped-sync-as-you-go-off logged (audit trail) but deliberately NOT added to
// the additionalContext branch below: a user-chosen setting shouldn't spend agent tokens
// on every KB edit, unlike an unexpected deferral (skipped-lock-held).
const LOG_STATUSES = new Set(['pushed', 'conflict-overwrote-remote', 'skipped-lock-held', 'skipped-sync-as-you-go-off', 'dry-run', 'error']);
const nodeMajor = parseInt(process.versions.node, 10);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let filePath;
  let root;
  try {
    const event = JSON.parse(input);
    filePath = event.tool_input && event.tool_input.file_path;
    if (!filePath || typeof filePath !== 'string') process.exit(0);
    root = resolveHookProjectRoot(event);
  } catch {
    process.exit(0);
    return;
  }

  if (nodeMajor < 22) {
    // C1041: knowledge-sync.js's module tree assumes Node >=22; under an older `node` that
    // won PATH resolution it would throw inside the try/catch below and exit(0) with zero
    // trace. Fail loud (but still non-blocking) here, before that require, into the
    // existing audit log instead of swallowing it silently.
    try {
      fs.appendFileSync(
        path.join(root, '.tipatask', 'kb-autopush.log'),
        `${new Date().toISOString()} skipped — node ${process.version} (${process.execPath}) below required major 22 — ${filePath}\n`,
      );
    } catch { /* never block on log write failure */ }
    process.exit(0);
  }

  let autoPushOnEdit;
  try {
    ({ autoPushOnEdit } = require('../src/cli/knowledge-sync'));
  } catch {
    process.exit(0);
    return;
  }

  autoPushOnEdit(filePath, root)
    .then((res) => {
      if (!LOG_STATUSES.has(res.status)) process.exit(0);

      // Audit trail. .tipatask/*.log is already gitignored by the installer.
      try {
        fs.appendFileSync(
          path.join(root, '.tipatask', 'kb-autopush.log'),
          `${new Date().toISOString()} ${res.status} ${res.fileKey || filePath}` +
            `${res.version ? ` v${res.version}` : ''}` +
            // C1221 — a `pushed` line alone can't say whether a C1105 lease was actually
            // taken or acquireLock failed open (404/5xx/transport); res.locked disambiguates.
            `${typeof res.locked === 'boolean' ? (res.locked ? ' [lease]' : ' [no-lease]') : ''}` +
            `${res.message ? ` — ${res.message}` : ''}\n`,
        );
      } catch { /* ignore — never block on log write failure */ }

      // Only surface the cases the agent should act on. additionalContext is
      // non-blocking — it never stops or rejects the tool call. skipped-lock-held (C1105)
      // needs to reach the agent too — the edit did NOT make it to the remote copy, so the
      // agent shouldn't assume it did.
      if (res.status === 'error' || res.status === 'skipped-lock-held' || res.remoteDiverged) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext:
              `[kb-autopush] ${res.fileKey || filePath}: ${res.status}` +
              `${res.message ? ` — ${res.message}` : ''}`,
          },
        }));
      }
      process.exit(0);
    })
    .catch(() => process.exit(0)); // belt-and-braces — autoPushOnEdit never rejects
});
