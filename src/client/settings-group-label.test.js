import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1457) Regression guard for the Settings modal's "Show {noun}" caption
// (#settings-sprints-enabled-caption). The caption must always be derived from the
// project's current task_group_label via group-label.js's groupPluralFor()/getGroupLabel(),
// never a literal "Sprints" — and it must stay in sync live (not just on next modal open)
// whenever the "Group tasks into" select changes.
//
// Source-scan style, same DOM-free house pattern as dialogs.test.js — this repo has no
// jsdom, and task-board.js's helpers here are module-private (not exported), so the only
// practical guard is scanning the source text rather than executing it.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Extracts a top-level function body by name: from the `function <name>(` or
// `async function <name>(` declaration line up to (not including) the next top-level
// `function`/`async function` declaration. Good enough for this file's flat top-level
// function-declaration style (no nested same-named declarations).
function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `function ${name}() not found in source`);
  const startIdx = startMatch.index;
  const nextDeclRe = /^(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + startMatch[0].length;
  const nextMatch = nextDeclRe.exec(source);
  const endIdx = nextMatch ? nextMatch.index : source.length;
  return source.slice(startIdx, endIdx);
}

test('writeProjectGroupLabel() re-populates the Show {noun} row live on every outcome', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'writeProjectGroupLabel');
  // Must appear in the `finally` block, not only the try — a failed save (select rolled
  // back to `prev`) must still leave the caption matching whatever noun actually persisted.
  const finallyIdx = body.lastIndexOf('finally');
  assert.ok(finallyIdx !== -1, 'writeProjectGroupLabel() must have a finally block');
  const finallyBody = body.slice(finallyIdx);
  assert.match(
    finallyBody,
    /_populateSettingsSprintsRow\(\)/,
    'writeProjectGroupLabel()\'s finally block must call _populateSettingsSprintsRow() ' +
      '(C1457) so the Show {noun} caption tracks a Group-Tasks-Into change immediately, ' +
      'not only on the next modal open'
  );
});

test('_populateSettingsSprintsRow() derives its caption from the live group label, never a literal', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, '_populateSettingsSprintsRow');
  assert.match(
    body,
    /groupPluralFor\(getGroupLabel\(\)\)/,
    '_populateSettingsSprintsRow() must interpolate groupPluralFor(getGroupLabel()) into ' +
      'the caption — a hardcoded "Sprints" string must never be reintroduced here'
  );
});

test('the Show Sprints caption span in template.html stays empty markup (text set at open time, not baked in)', () => {
  const html = readSource('template.html');
  const spanMatch = /<span id="settings-sprints-enabled-caption">([^<]*)<\/span>/.exec(html);
  assert.ok(spanMatch, '#settings-sprints-enabled-caption span not found in template.html');
  assert.strictEqual(
    spanMatch[1].trim(),
    '',
    'the caption span must stay empty in static markup — its text is set at runtime by ' +
      '_populateSettingsSprintsRow(), never baked into template.html'
  );
});
