'use strict';

// Test-only expectations, deliberately independent of the assembly's directive list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function projectFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-prompt-contract-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function once(text, pattern, meaning) {
  assert.equal([...text.matchAll(new RegExp(pattern.source, 'gi'))].length, 1, meaning);
}

function processSafety(text) {
  once(text, /Before[^\n]*`npm run`[^\n]*node --version[^\n]*switch|Before[^\n]*`npm run`[^\n]*switch[^\n]*node --version/, 'check pinned Node and switch before npm run exactly once');
  assert.match(text, /Before[^\n]*pinned[^\n]*\.nvmrc[^\n]*\.tool-versions[^\n]*engines.node/, 'Node selection must use project pins');
  once(text, /PID or process group[^\n]*never[^\n]*pkill -f/, 'abort by PID/group, never command matching, exactly once');
}

function resourceLimits(text, cap = 3) {
  once(text, /at most \d+ sub-agents or background commands in parallel/, 'parallel sub-agent/background cap stated exactly once');
  assert.match(text, new RegExp(`at most ${cap} sub-agents or background commands in parallel`), `cap must be ${cap}`);
  once(text, /test (?:and|or) build commands[^\n]*(?:one at a time[^\n]*never in parallel|in parallel[^\n]*one at a time)/, 'test/build runs are serial exactly once');
  once(text, /(?:Stop all background work you started before finishing|Before finishing, stop every background command)/, 'background work is stopped before finishing exactly once');
}

function kbHygiene(text) {
  once(text, /ai\/architecture\/\*\.md[^\n]*standing/, 'KB holds standing system facts exactly once');
  once(text, /(?:Never put task-specific|Task-specific material never)[^\n]*investigation[^\n]*(?:resolution|create_task_comment)/, 'task investigation belongs in resolution comments exactly once');
  once(text, /(?:year from now[^\n]*forgotten|stays true and useful[^\n]*forgotten)/, 'KB line must remain useful after task closes exactly once');
}

function taskStatus(text) {
  once(text, /Complete only when/, 'completion requires this task scope and verification exactly once');
  assert.match(text, /(?:this task's scope and checks pass|that scope is fully implemented and relevant checks pass)/);
  assert.match(text, /(?:own regressions block|regressions caused by your changes block completion)/);
  once(text, /Unrelated[^\n]*tasks[^\n]*(?:suite[^\n]*failures|failures[^\n]*suite)[^\n]*caveats, not blockers/, 'unrelated work and suite failures are caveats exactly once');
  assert.match(text, /unless (?:the user or task|user\/task) explicitly (?:connects|links) them/);
  assert.match(text, /(?:Investigate a failure's relevance before classifying it|Check relevance)/);
  assert.match(text, /evidence[^\n]*resolution(?: comment)? and (?:final )?reply/);
}

function followUps(text) {
  once(text, /Follow-up capture:/, 'follow-up capture directive delivered exactly once');
  once(text, /Zero follow-ups is the normal result\./, 'zero follow-ups is the default exactly once');
  once(text, /At most 2 new tasks per run, each with one sentence of evidence\./, 'new tasks are capped and evidenced exactly once');
  assert.match(text, /Only capture a defect, data risk or security issue in shipped behavior, or a manual step the user must take\./);
  assert.match(text, /Never file improvements, refactors, extra tests, doc ideas, nice-to-haves or (?:own-scope work|things already covered by this task)/);
  assert.match(text, /Prefer a comment/);
  assert.match(text, /otherwise report none/);
  once(text, /(?:After implementation|After implementing)[^\n]*before/, 'follow-ups run after implementation and before completion exactly once');
  once(text, /not-started(?: and |\/)urgent/, 'only not-started and urgent tasks count as outstanding exactly once');
  once(text, /never (?:file a )?duplicate/i, 'search before filing, never duplicate exactly once');
  once(text, /Never touch[^\n]*in[- ]progress[^\n]*done[^\n]*canceled/, 'in-progress, done and canceled tasks stay untouched exactly once');
  once(text, /(?:filed or updated|filed\/updated)[^\n]*resolution[^\n]*reply/, 'filed or updated keys listed in resolution and reply exactly once');
  assert.match(text, /type:? "?comment\b/, 'affected tasks get a plain comment, not a resolution');
  assert.match(text, /self-contained/, 'filed tasks carry self-contained descriptions');
  assert.match(text, /this task's priority/, 'filed tasks inherit this task\'s priority');
  assert.match(text, /\\~/, 'tildes are escaped');
  assert.match(text, /HUMAN/, 'HUMAN category is reserved for user-only steps');
  assert.match(text, /Skip trivia/, 'trivia is skipped');
}

function cowboyChain(text) {
  once(text, /Cowboy chain:/, 'cowboy chain directive delivered exactly once');
  once(text, /After[^\n]*(?:complete_task`? succeeded|completion succeeds)[^\n]*(?:start_next_tasks\(task_key\)|tt next)[^\n]*exactly once/,
    'the next tasks are requested exactly once, only after a successful completion');
  once(text, /Never pick, start or work on the next tasks yourself/, 'the agent never picks or starts tasks itself exactly once');
  once(text, /refused[^\n]*(?:do not call it|skip it)/, 'a refused or blocked completion starts nothing exactly once');
  once(text, /(?:task keys it started|started task keys)[^\n]*(?:final message|reason)/, 'the started keys are reported exactly once');
  assert.match(text, /No retry|Do not retry/, 'the request is never retried');
}

function tagBackfill(text, id) {
  once(text, /Blank tag description\(s\) on this task: tt-fixture/, 'blank registered tag needs backfill exactly once');
  assert.match(text, /[Ss]tudy the module/);
  assert.match(text, /(?:before marking this task complete|before\s+marking this task complete)/i);
  assert.match(text, /Never write "Auto-registered/);
  once(text, id === 'pi' ? /PUT \/tags\/<name>/ : /ensure_project_tag\(tag_name, description\)/, 'backfill uses supported transport exactly once');
}

function vcsOff(text) {
  once(text, /Version control is off for this project/, 'VCS-off prohibition delivered exactly once');
  assert.match(text, /(?:No git writes|Never run a git command that writes)/);
  for (const operation of ['add', 'commit', 'push', 'tag', 'branch', 'merge', 'rebase', 'reset', 'stash', 'worktree add']) {
    assert.ok(text.includes(operation), `VCS-off must prohibit ${operation}`);
  }
  assert.match(text, /Never[^\n]*(?:attribution|Co-Authored-By)/);
}

module.exports = { projectFixture, once, processSafety, resourceLimits, kbHygiene, taskStatus, followUps, cowboyChain, tagBackfill, vcsOff };
