import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1458) A native alert()/confirm()/prompt() blocks the page event loop — any CDP/
// Claude-in-Chrome command issued after one fires never returns, so an automation session
// freezes hard (root cause of C1391). C1392 converted the card-open + task-edit-modal path;
// C1458 converted every remaining board surface. This is the regression guard: it fails if
// a future edit reintroduces a native dialog anywhere in the client bundle.
//
// Matching is intentionally simple (strip `//` line comments, then look for a lowercase
// `alert(`/`confirm(`/`prompt(` at a word boundary) rather than a real parser — good enough
// to catch a reintroduced call without false-positiving on the many camelCase helpers that
// contain these words with a capital letter (showActionConfirm, showConfirmModal,
// showDeleteConfirmModal, sessionCloseNeedsConfirm, requestSessionClose, buildObjectivePrompt,
// etc. — none of those match `\bconfirm\(`/`\bprompt\(` since the substring starts uppercase).
const DIALOG_CALL = /\b(alert|confirm|prompt)\(/;

function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function findViolations(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const violations = [];
  text.split('\n').forEach((line, i) => {
    const code = stripLineComment(line);
    if (DIALOG_CALL.test(code)) {
      violations.push(`${path.relative(CLIENT_DIR, filePath)}:${i + 1}: ${line.trim()}`);
    }
  });
  return violations;
}

function listTargetFiles() {
  const files = fs.readdirSync(CLIENT_DIR)
    .filter((name) => (name.endsWith('.js') && !name.endsWith('.test.js')) || name.endsWith('.html'))
    .map((name) => path.join(CLIENT_DIR, name));
  return files;
}

test('no native alert()/confirm()/prompt() remains in the client bundle', () => {
  const violations = listTargetFiles().flatMap(findViolations);
  assert.deepEqual(violations, [], `Native blocking dialog(s) found — replace with showToast()/showActionConfirm():\n${violations.join('\n')}`);
});
