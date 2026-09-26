import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Regression guards for the "a CLI installed after boot must reach the chat model selector"
// wiring — the parts that live in chat-ui.js / template.html / the three Re-Check surfaces and
// can't be unit-tested directly (no jsdom in this repo; chat-ui.js is not importable under node).
// Source-scan style, same house pattern as objective-tabs-wiring.test.js. The pure policy
// (objective-providers-refresh.js) and the fetch helpers (agent-recheck.js) have their own
// direct unit tests.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Top-level function body by name — same helper as objective-tabs-wiring.test.js.
function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `function ${name}() not found in source`);
  const startIdx = startMatch.index;
  const nextDeclRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + startMatch[0].length;
  const nextMatch = nextDeclRe.exec(source);
  return source.slice(startIdx, nextMatch ? nextMatch.index : source.length);
}

// The indented `async function reCheck() { ... }` each Re-Check surface declares inside its
// render closure: from its header to the first line that is just the closing brace at 2-space indent.
function extractReCheck(source) {
  const start = source.indexOf('async function reCheck() {');
  assert.ok(start >= 0, 'reCheck() not found');
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, 'reCheck() end not found');
  return source.slice(start, end);
}

function stripLineComments(src) {
  return src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

// ── The three Re-Check buttons all go server-first ───────────────────────────────────────────

for (const file of ['setup-modal.js', 'project-creation-wizard.js', 'agents-modal.js']) {
  test(`${file}: Re-Check goes through agent-recheck.js recheckAgents()`, () => {
    const src = readSource(file);
    assert.match(src, /import \{[^}]*\brecheckAgents\b[^}]*\} from '\.\/agent-recheck\.js'/, `${file} must import recheckAgents`);
    const body = stripLineComments(extractReCheck(src));
    assert.match(body, /recheckAgents\(\)/, `${file}: reCheck() must call recheckAgents()`);
  });
}

test('setup-modal.js / project-creation-wizard.js: no bare loadAgents({ force: true }) Re-Check left', () => {
  // That call only re-detects in Electron MAIN — a different process (and different detect
  // caches) from the forked server that serves the chat model selector. It was the bug.
  for (const file of ['setup-modal.js', 'project-creation-wizard.js']) {
    assert.doesNotMatch(stripLineComments(readSource(file)), /loadAgents\(\s*\{\s*force:\s*true/, `${file} must not Re-Check via main-process IPC only`);
  }
});

test('agents-modal.js: one server-fetch implementation only (the shared one)', () => {
  const src = readSource('agents-modal.js');
  assert.doesNotMatch(src, /function _fetchAgentsFromServer/, 'the inline copy must stay deleted');
  assert.match(src, /browserFallback:\s*fetchAgentStatusesFromServer/);
});

// ── Setup save leaves the forked server correct ──────────────────────────────────────────────

test('setup-modal.js: notifies the server after EVERY save branch, before completing, scoped to _projectPath', () => {
  const src = readSource('setup-modal.js');
  assert.match(src, /import \{[^}]*\bnotifyServerAgentsSaved\b[^}]*\} from '\.\/agent-recheck\.js'/);
  const call = src.indexOf('notifyServerAgentsSaved(_projectPath,');
  assert.ok(call >= 0, 'must pass _projectPath explicitly (a setup window has no ?projectPath= yet)');
  // After the open-existing IPC, the Electron re-auth IPC AND the browser POST; before completion.
  assert.ok(call > src.indexOf('openExistingProject('), 'after the open-existing save');
  assert.ok(call > src.indexOf('reauthSave('), 'after the re-auth save');
  assert.ok(call > src.indexOf("fetch('/api/project-config'"), 'after the browser-mode save');
  assert.ok(call < src.indexOf('_completed = true;'), 'before the modal completes');
});

// ── chat-ui.js: composer-open refresh, repaint on change ─────────────────────────────────────

test('chat-ui.js: applyProviderConfig() reports whether the list/selection changed', () => {
  const body = extractFunctionBody(readSource('chat-ui.js'), 'applyProviderConfig');
  assert.match(body, /return changed;/);
  assert.match(body, /providersSignature\(payload\)/);
  assert.match(body, /_providersFetchedAt = Date\.now\(\)/, 'every writer stamps the fetch time here');
});

test('chat-ui.js: attachChatHandlers() triggers the composer-open refresh', () => {
  assert.match(extractFunctionBody(readSource('chat-ui.js'), 'attachChatHandlers'), /refreshProvidersForComposer\(\)/);
});

test('chat-ui.js: the composer-open refresh repaints in place — refreshObjectiveContent(), never reload()', () => {
  const body = stripLineComments(extractFunctionBody(readSource('chat-ui.js'), 'refreshProvidersForComposer'));
  assert.match(body, /refreshObjectiveContent\(\)/);
  // reload() = loadAndRender() = #app.innerHTML wipe, destructive under a composer being typed in.
  assert.doesNotMatch(body, /\breload\(\)/);
  assert.match(body, /objectiveIsStreaming\(\)/, 'never refreshes mid-turn');
  assert.match(body, /_providersFetchInFlight/, 'never runs two fetches at once');
  assert.match(body, /PROVIDERS_RETRY_DELAY_MS/, 'one delayed follow-up for the stale-negative first-caller case');
});

test('chat-ui.js: the WS config frame repaints when the provider list changed', () => {
  const src = readSource('chat-ui.js');
  const start = src.indexOf("if (msg.type === 'config') {");
  assert.ok(start >= 0, 'config handler not found');
  const handler = src.slice(start, src.indexOf('return;', start));
  assert.match(handler, /if \(applyProviderConfig\(msg\)\) refreshObjectiveContent\(\);/);
});

test('chat-ui.js: tiptask:providers-changed and the page-load fetch repaint only on a real change', () => {
  const src = stripLineComments(readSource('chat-ui.js'));
  assert.match(src, /if \(applyProviderConfig\(e\.detail\)\) reload\(\);/);
  assert.match(src, /if \(payload && applyProviderConfig\(payload\)\) reload\(\);/);
});

test('chat-ui.js: the page-load fetch flags itself in-flight so the first attach does not double-fetch', () => {
  const src = readSource('chat-ui.js');
  const at = src.indexOf("label: 'objective-providers' }");
  assert.ok(at >= 0);
  assert.ok(src.lastIndexOf('_providersFetchInFlight = true;', at) > src.lastIndexOf('function applyProviderConfig', at));
  assert.match(src.slice(at, at + 400), /_providersFetchInFlight = false/);
});

test('chat-ui.js: exports invalidateObjectiveProviders() for project switches', () => {
  assert.match(readSource('chat-ui.js'), /^export function invalidateObjectiveProviders\(\)/m);
});

// ── template.html ────────────────────────────────────────────────────────────────────────────

test('template.html: a project switch invalidates the objective provider list', () => {
  const src = readSource('template.html');
  const handler = src.indexOf('window.electronAPI.onProjectChanged(async (dir, name) => {');
  assert.ok(handler >= 0, 'onProjectChanged handler not found');
  const end = src.indexOf('await loadAndRender({ scrollToTop: true, force: true });', handler);
  const block = src.slice(handler, end);
  assert.match(block, /chatUI\.invalidateObjectiveProviders\(\);/);
  // Must run in the reset block, i.e. before the render that re-fetches.
  assert.ok(block.indexOf('chatUI.invalidateObjectiveProviders()') < block.indexOf('await applyProjectLanguage()'));
});
