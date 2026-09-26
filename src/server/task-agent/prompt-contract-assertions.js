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

module.exports = { projectFixture, once, processSafety, kbHygiene, taskStatus, tagBackfill, vcsOff };
