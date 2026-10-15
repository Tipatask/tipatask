'use strict';

// C1215 — project VCS settings (git worktree/commit/PR, or svn) applied to task-agent
// kickoff prompts. Covers vcs-settings.js's pure helpers + fail-open fetcher, and each
// agent's buildPrompt() injection point. See ai/architecture/tt-version-control-agents.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { VCS_OFF, normalizeVcsSettings, fetchVcsSettings, buildVcsDirective } = require('../vcs-settings');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const {
  matchPromptLine,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vcs-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

const GIT_ALL_ON = { type: 'git', worktree: true, commit: true, pr: true, merge: true };
const GIT_WORKTREE_ONLY = { type: 'git', worktree: true, commit: false, pr: false, merge: false };
const SVN = { type: 'svn', worktree: false, commit: false, pr: false, merge: false };
// TPT576 — the strict live-read context every real task-terminal spawn threads (vcs-context.js).
const VCS_CONTEXT = Object.freeze({
  verified: true, projectId: 2, checkedAt: '2026-01-01T00:00:00.000Z',
  vcs: { type: 'git', worktree: false, commit: true, pr: false, merge: false },
  runtime: { version: 'test', source: '/tmp/test', packaged: false, fingerprint: 'test', stale: false, protocol: 1 },
});

for (const compact of [false, true]) {
  test(`buildVcsDirective: merge completion gate (compact=${compact})`, () => {
    const directive = buildVcsDirective(GIT_ALL_ON, { compact });
    const mergeLine = directive.split('\n').find(line => line.includes('`git merge task/<TASK_KEY>`'));
    assert.ok(mergeLine, 'merge enabled must deliver the merge command');
    assert.match(mergeLine, /After (?:the task )?commit/);
    assert.match(mergeLine, /main checkout.*CURRENT/);
    assert.match(mergeLine, /[Rr]esolve (?:all|every) conflict/);
    assert.match(mergeLine, /merge commit.*allowed/);
    assert.match(mergeLine, /run (?:the relevant )?checks/);
    assert.match(mergeLine, /Only after.*(?:success|succeed).*resolution comment.*completed/);
    assert.ok(directive.indexOf('Commit ') < directive.indexOf(mergeLine));
    assert.doesNotMatch(directive, /first, then post the resolution comment/);
    assert.doesNotMatch(directive, /\?/);
    if (compact) assert.ok(directive.length < buildVcsDirective(GIT_ALL_ON).length);

    for (const merge of [false, undefined]) {
      const off = buildVcsDirective({ ...GIT_ALL_ON, merge }, { compact });
      assert.doesNotMatch(off, /git merge task|After (?:the task )?commit|resolve (?:all|every) conflict/i);
    }
    for (const type of [null, 'svn']) {
      assert.doesNotMatch(buildVcsDirective({ ...GIT_ALL_ON, type }, { compact }), /git merge task/);
    }
  });

  test(`buildVcsDirective: merge does not override disabled commits (compact=${compact})`, () => {
    const directive = buildVcsDirective({ ...GIT_ALL_ON, commit: false }, { compact });
    assert.match(directive, /Do not commit:/);
    assert.match(directive, /[Ww]ait for (?:the )?user to commit and merge/);
    assert.match(directive, /checks before.*resolution comment.*completed/);
    assert.doesNotMatch(directive, /`git merge task/);
  });
}

// ── vcs-settings.js: pure helpers ──

test('normalizeVcsSettings: null/missing project -> VCS_OFF', () => {
  assert.deepEqual(normalizeVcsSettings(null), VCS_OFF);
  assert.deepEqual(normalizeVcsSettings(undefined), VCS_OFF);
  assert.deepEqual(normalizeVcsSettings({}), VCS_OFF);
  assert.deepEqual(normalizeVcsSettings({ vcs_type: null }), VCS_OFF);
});

// C1213's hard rule: the four flags are NOT force-reset when vcs_type moves away from
// 'git' — they go dormant server-side. A reader that checked a flag alone (instead of
// gating on vcs_type === 'git' first) would wrongly emit worktree instructions here.
test('normalizeVcsSettings: dormant flags on a non-git project never surface (C1213 trap)', () => {
  const svnWithStaleFlags = { vcs_type: 'svn', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1 };
  assert.deepEqual(normalizeVcsSettings(svnWithStaleFlags), { type: 'svn', worktree: false, commit: false, pr: false, merge: false });

  const offWithStaleFlags = { vcs_type: null, vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1 };
  assert.deepEqual(normalizeVcsSettings(offWithStaleFlags), VCS_OFF);
});

test('normalizeVcsSettings: git project surfaces exactly the flags that are set (TINYINT 0/1 rows)', () => {
  assert.deepEqual(
    normalizeVcsSettings({ vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 0, vcs_pr_enabled: 1, vcs_merge_enabled: 1 }),
    { type: 'git', worktree: true, commit: false, pr: true, merge: true }
  );
});

test('normalizeVcsSettings: merge is opt-in and independent of other git flags', () => {
  for (const value of [undefined, null, 0, false]) {
    assert.equal(normalizeVcsSettings({ vcs_type: 'git', vcs_merge_enabled: value }).merge, false);
  }
  assert.deepEqual(normalizeVcsSettings({ vcs_type: 'git', vcs_merge_enabled: 1 }), {
    type: 'git', worktree: false, commit: false, pr: false, merge: true,
  });
});

// C1561 — VCS_OFF used to render '' (silence let an agent's own CLI defaults commit and
// attribute unchecked). It now renders an explicit no-commit/no-attribution prohibition.
test('buildVcsDirective: VCS_OFF -> explicit no-commit/no-attribution prohibition block', () => {
  for (const vcs of [VCS_OFF, undefined, null]) {
    const directive = buildVcsDirective(vcs);
    assert.notEqual(directive, '');
    assert.match(directive, /git add/);
    assert.match(directive, /git commit/);
    assert.match(directive, /git push/);
    assert.match(directive, /Co-Authored-By/);
    assert.match(directive, /Generated with Claude Code/);
    assert.match(directive, /git status/, 'read-only inspection must still be allowed');
  }
  // VCS_OFF, undefined, and null all normalize to the same prohibition text.
  assert.equal(buildVcsDirective(VCS_OFF), buildVcsDirective(undefined));
  assert.equal(buildVcsDirective(VCS_OFF), buildVcsDirective(null));
});

test('buildVcsDirective: VCS_OFF compact variant — shorter, same prohibitions, no question marks', () => {
  const directive = buildVcsDirective(VCS_OFF, { compact: true });
  assert.notEqual(directive, '');
  assert.match(directive, /commit/);
  assert.match(directive, /Co-Authored-By/);
  assert.doesNotMatch(directive, /\?/);
  const full = buildVcsDirective(VCS_OFF);
  assert.ok(directive.length < full.length, 'compact must be shorter than the full block');
});

test('buildVcsDirective: git — only the enabled sub-lines appear', () => {
  const worktreeOnly = buildVcsDirective(GIT_WORKTREE_ONLY);
  assert.match(worktreeOnly, /dedicated git worktree/);
  assert.match(worktreeOnly, /\.worktrees\//);
  assert.doesNotMatch(worktreeOnly, /Commit your work exactly once/);
  assert.doesNotMatch(worktreeOnly, /gh pr create/);

  const allOn = buildVcsDirective(GIT_ALL_ON);
  assert.match(allOn, /dedicated git worktree/);
  assert.match(allOn, /Commit your work exactly once/);
  assert.match(allOn, /gh pr create/);
  assert.match(allOn, /do not guess a forge host/);
});

// C1561 — 'git' with vcs_commit_enabled off is a "you do not touch git" project too, same
// as VCS_OFF, but keeps its worktree/pr sub-lines when those flags are separately on.
test('buildVcsDirective: git with commit off — same prohibition as VCS_OFF, no "Commit your work" line', () => {
  const directive = buildVcsDirective(GIT_WORKTREE_ONLY);
  assert.doesNotMatch(directive, /Commit your work exactly once/);
  assert.match(directive, /Do not commit/);
  assert.match(directive, /Co-Authored-By/);
  assert.match(directive, /dedicated git worktree/, 'worktree line must still appear');
});

test('buildVcsDirective: git with commit on keeps today\'s wording, no attribution line added', () => {
  const directive = buildVcsDirective(GIT_ALL_ON);
  assert.match(directive, /Commit your work exactly once/);
  assert.doesNotMatch(directive, /Co-Authored-By/, 'a commit-enabled project must not gain a new attribution ban — user opted in to commits there');
  assert.doesNotMatch(directive, /Do not commit/);
});

test('buildVcsDirective: git commit off + pr on — prohibition does not forbid git push (the PR line needs it)', () => {
  const directive = buildVcsDirective({ type: 'git', worktree: false, commit: false, pr: true, merge: true });
  assert.doesNotMatch(directive, /Do not commit:[^\n]*git push/, 'push must not be banned when pr mode legitimately pushes the branch');
  assert.match(directive, /gh pr create/);
});

test('buildVcsDirective: svn — commit-only instruction, no worktree creation or PR concepts', () => {
  const svnNote = buildVcsDirective(SVN);
  assert.match(svnNote, /svn commit/);
  assert.doesNotMatch(svnNote, /git worktree add/);
  assert.doesNotMatch(svnNote, /pull\/merge request/);
});

// ── vcs-settings.js: fail-open fetcher ──

test('fetchVcsSettings: fail-open — null backend, backend missing the method, and a rejecting method all degrade to VCS_OFF', async () => {
  assert.deepEqual(await fetchVcsSettings(null), VCS_OFF);
  assert.deepEqual(await fetchVcsSettings({}), VCS_OFF);
  assert.deepEqual(await fetchVcsSettings({ getProjectSettings: async () => { throw new Error('boom'); } }), VCS_OFF);
});

test('fetchVcsSettings: normalizes a real backend row', async () => {
  const backend = { getProjectSettings: async () => ({ vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 0 }) };
  assert.deepEqual(await fetchVcsSettings(backend), { type: 'git', worktree: true, commit: true, pr: false, merge: false });
});

// ── ClaudeAgent.buildPrompt ──

// C1561 — buildVcsDirective() no longer has a '' branch for VCS_OFF, so a real vcsSettings
// object (even a VCS-off one) now diverges from the no-key fallback. The absent-key
// contract (resolveVcsDirective()'s own '' guard, base-agent.js) is what's actually
// byte-identical — verified separately by the two calls with no vcsSettings key at all.
test('ClaudeAgent.buildPrompt: no opts.vcsSettings -> no VCS text at all; VCS_OFF -> prohibition block', () => {
  const agent = new ClaudeAgent();
  const withoutKey = agent.buildPrompt('Do the thing', {});
  assert.ok(!withoutKey.includes('Version control'), 'absent vcsSettings key must not inject any VCS text');
  assert.ok(withoutKey.startsWith('/tipatask-expert'));

  const withOff = agent.buildPrompt('Do the thing', { vcsSettings: VCS_OFF });
  assert.match(withOff, /Version control is OFF/);
  assert.match(withOff, /Co-Authored-By/);
  assert.ok(withOff.trim().endsWith('Do the thing'), 'task prompt must still be the last thing in the string');
});

test('ClaudeAgent.buildPrompt: git settings append the directive after the resolution mandate, before the task prompt', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsSettings: GIT_ALL_ON });
  assert.match(prompt, /Version control \(git\) is enabled/);
  assert.match(prompt, /gh pr create/);
  assert.ok(prompt.trim().endsWith('Do the thing'), 'task prompt must still be the last thing in the string');
});

test('ClaudeAgent.buildPrompt: designMode wins over vcsSettings — /design brief regardless, no VCS directive fused in (C1272)', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, vcsSettings: GIT_ALL_ON });
  assert.ok(prompt.startsWith('/design '));
  assert.ok(prompt.includes('Do the thing'));
  assert.ok(!prompt.includes('Version control'), 'VCS directive must not be injected into the design brief');
});

// SIMPLE_MODE is read off the module-level `require('../config')` singleton, not the opts
// object (see design-mode-prompt.test.js's note on this) — verified in a child process so
// this file's own config singleton (used by every other test above) is untouched.
test('ClaudeAgent.buildPrompt: SIMPLE_MODE wins over vcsSettings — bare prompt regardless', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const ClaudeAgent = require(${JSON.stringify(path.join(__dirname, 'claude-agent.js'))});`,
    `const agent = new ClaudeAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { vcsSettings: { type: 'git', worktree: true, commit: true, pr: true, merge: true } });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing');
});

// TPT576 — with a vcsContext Claude finishes through the local complete_task guard, like Codex,
// so the commit/merge check applies. The legacy create_task_comment + remote update_task note
// survives only for callers without one.
test('ClaudeAgent.buildPrompt: vcsContext -> finish through complete_task, never create_task_comment + update_task (TPT576)', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs });
  assert.ok(prompt.includes('`mcp__tipatask-local__complete_task(task_key, resolution)`'));
  assert.ok(!prompt.includes('update_task(status='), 'no remote status write for completion');
  assert.doesNotMatch(prompt, /SAME tool-call batch/);
  assert.match(prompt, /Never also call `create_task_comment` or `update_task` to complete the task\./);
  assert.match(prompt, /When it refuses, fix the blockers it lists \(e\.g\. TASK_COMMIT_MISSING: commit first\) and call it again\./);
  // A blocker the agent cannot clear still leaves the report on the task.
  assert.match(prompt, /cannot be cleared within this task, do not complete it: post the same report with `mcp__tipatask__create_task_comment\(task_key, content, type: "resolution"\)` so it is not lost/);
  assert.match(prompt, /plain English prose — do NOT use caveman style/);
  assert.equal([...prompt.matchAll(/MANDATORY to finish this task/g)].length, 1, 'exactly one resolution mandate');
  assert.ok(prompt.indexOf('MANDATORY to finish this task') < prompt.indexOf('Version control (git) is enabled'), 'mandate precedes the VCS directive');
  assert.ok(prompt.trim().endsWith('Do the thing'), 'task prompt must still be the last thing in the string');
});

test('ClaudeAgent.buildPrompt: vcsContext mandate names the project\'s complete-role status (C1184)', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs, statusRoles: { complete: 'done' } });
  assert.match(prompt, /posts this report as the task's resolution comment and sets `done`/);
});

test('ClaudeAgent.buildPrompt: no vcsContext -> legacy create_task_comment + update_task note unchanged', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsSettings: GIT_ALL_ON });
  assert.ok(prompt.includes('`mcp__tipatask__create_task_comment(task_key, content, type: "resolution")`'));
  assert.ok(prompt.includes('Post it in the SAME tool-call batch as the final `update_task(status="completed")`.'));
  // The commit-on definition-of-done line (TPT611) names complete_task; the mandate itself must not.
  assert.ok(!prompt.includes('mcp__tipatask-local__complete_task'), 'no guarded-completion mandate without a vcsContext');
  assert.doesNotMatch(prompt, /MANDATORY to finish this task|Final-message checklist/);
});

test('ClaudeAgent.buildPrompt: designMode wins over vcsContext — bare /design brief, no completion mandate', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs });
  assert.ok(prompt.startsWith('/design '));
  assert.ok(!prompt.includes('complete_task'));
  assert.ok(!prompt.includes('MANDATORY'));
});

test('ClaudeAgent.buildPrompt: SIMPLE_MODE wins over vcsContext — bare prompt regardless', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const ClaudeAgent = require(${JSON.stringify(path.join(__dirname, 'claude-agent.js'))});`,
    `const agent = new ClaudeAgent();`,
    `const context = ${JSON.stringify(VCS_CONTEXT)};`,
    `const prompt = agent.buildPrompt('Do the thing', { vcsContext: context, vcsSettings: context.vcs });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing');
});

// ── CodexAgent.buildPrompt ──

test('CodexAgent.buildPrompt: no opts.vcsSettings -> no VCS text at all; VCS_OFF -> prohibition block', () => {
  const agent = new CodexAgent();
  const withoutKey = agent.buildPrompt('Do the thing', {});
  assert.ok(!withoutKey.includes('Version control'), 'absent vcsSettings key must not inject any VCS text');

  const withOff = agent.buildPrompt('Do the thing', { vcsSettings: VCS_OFF });
  assert.match(withOff, /Version control is OFF/);
  assert.match(withOff, /Co-Authored-By/);
});

test('CodexAgent.buildPrompt: svn settings append the svn-commit instruction', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsSettings: SVN });
  assert.match(prompt, /Version control \(svn\) is enabled/);
  assert.match(prompt, /svn commit/);
});

test('CodexAgent.buildPrompt: echoed kickoff instruction cannot false-trigger anchored plan-ready detection (C1236)', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', {});
  const instruction = prompt.split('\n').find((line) => line.includes('emit one final line whose only content is the words Plan ready.'));

  assert.ok(instruction, 'Codex kickoff must explain the standalone sentinel output');
  assert.equal(matchPromptLine(instruction, CODEX_PROMPT_PATTERNS), null);
  assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
});

test('CodexAgent.buildPrompt: vcsContext mandate retries on refusal and keeps the report when blocked, echo-safe (TPT576)', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs });
  const lines = prompt.split('\n');
  const mandate = lines.find((line) => line.startsWith('- MANDATORY: supply ONE self-authored plain-English resolution to tipatask-local complete_task.'));
  assert.ok(mandate, 'Codex vcsContext resolution mandate present');
  assert.match(mandate, /Never also call `create_task_comment` or `update_task` to complete the task\./);
  assert.match(mandate, /fix the blockers it lists \(e\.g\. TASK_COMMIT_MISSING: commit first\) and call it again/);
  assert.match(mandate, /post the same report with `create_task_comment\(task_key, content, type="resolution"\)` so it is not lost/);
  assert.ok(!prompt.includes('update_task(status='));
  const directive = lines.find((line) => line.startsWith('Finish with tipatask-local complete_task'));
  assert.match(directive, /verifies current settings, the required task commit \(when commits are on\) and local merges/);
  for (const line of [mandate, directive]) {
    assert.equal(matchPromptLine(line, CODEX_PROMPT_PATTERNS), null, `Codex table matched: ${line}`);
  }
});

// ── PiAgent.buildPrompt ──

test('PiAgent.buildPrompt: no opts.vcsSettings -> no VCS text at all; VCS_OFF -> compact prohibition block', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const withoutKey = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.ok(!withoutKey.includes('Version control'), 'absent vcsSettings key must not inject any VCS text');

    const withOff = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, vcsSettings: VCS_OFF });
    assert.match(withOff, /Version control is off/);
    assert.match(withOff, /Co-Authored-By/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1119/C1116/C1117) Re-run of the existing echo-safety sweep (see pi-agent.test.js), now
// covering every vcsSettings shape — VCS-off, git worktree-only (commit off), full git,
// and svn — plus the discovery:true + VCS_OFF combo, which is Pi's real worst-case spawn
// now that VCS-off carries a real directive instead of ''. The whole prompt is echoed
// verbatim into Pi's own TUI and scanned by prompt-detect.js, so every new block must clear
// the same bar.
test('PiAgent.buildPrompt: every VCS directive shape cannot false-trigger the attention/plan-ready detectors, and stays under the size budget', (t) => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const scenarios = [
      { vcsSettings: VCS_OFF, discovery: false },
      { vcsSettings: VCS_OFF, discovery: true },
      { vcsSettings: GIT_WORKTREE_ONLY, discovery: false },
      { vcsSettings: GIT_ALL_ON, discovery: false },
      { vcsSettings: GIT_ALL_ON, discovery: true },
      { vcsSettings: { ...GIT_ALL_ON, merge: false }, discovery: true },
      { vcsSettings: { ...GIT_ALL_ON, commit: false }, discovery: true },
      // Commits on, nothing else: the mandatory commit line on its own (TPT573).
      { vcsSettings: { type: 'git', worktree: false, commit: true, pr: false, merge: false }, discovery: true },
      { vcsSettings: SVN, discovery: false },
    ];
    for (const { vcsSettings, discovery } of scenarios) {
      const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, vcsSettings, discovery });

      assert.match(prompt, /Version control/);
      assert.equal(prompt.includes('Commit is MANDATORY'), vcsSettings.commit === true, 'compact mandatory commit line follows the commit flag');

      for (const line of prompt.split('\n')) {
        assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `PI table matched: ${line}`);
        assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `generic table matched: ${line}`);
      }
      for (const { re, agents } of buildLegacyPatternTable()) {
        if (agents && !agents.includes('pi')) continue;
        assert.ok(!re.test(prompt), `tail-scoped pattern matched the prompt: ${re}`);
      }
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);

      // Keep the existing ceiling for merge-on/off and commit-disabled prompts too.
      t.diagnostic(`Pi vcs=${vcsSettings.type}, merge=${vcsSettings.merge}, commit=${vcsSettings.commit}, discovery=${discovery}: ${prompt.length} / 9900`);
      assert.ok(prompt.length < 9900, `prompt grew to ${prompt.length} chars (scenario: vcs=${vcsSettings.type}, discovery=${discovery})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Assert delivered meaning independently of buildSharedPreamble's own list.
for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}: vcsOff contract survives shared assembly and detects omission/duplication`, (t) => {
    const agent = new Agent();
    const verify = require('./prompt-contract-assertions').vcsOff;
    const opts = { vcsSettings: { type: 'off' } };
    opts.projectPath = require('./prompt-contract-assertions').projectFixture(t);
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    verify(build(), agent.id);
    const original = agent.resolveVcsDirective.bind(agent);
    const stub = t.mock.method(agent, 'resolveVcsDirective', () => '');
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
  });
}

test('assembled VCS permissions follow each flag for all task agents', () => {
  const { once } = require('./prompt-contract-assertions');
  for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
    const agent = new Agent();
    assert.doesNotMatch(agent.buildPrompt('TASK', {}), /Version control/);
    for (const worktree of [false, true]) for (const commit of [false, true]) for (const pr of [false, true]) for (const merge of [false, true]) {
      const prompt = agent.buildPrompt('TASK', { vcsSettings: { type: 'git', worktree, commit, pr, merge } });
      once(prompt, /Version control \(git\)/, `${agent.id}: one git policy`);
      assert.equal(prompt.includes('Work in a dedicated git worktree'), worktree);
      assert.equal(/Commit (?:your work exactly )?once/.test(prompt), commit);
      assert.equal(prompt.includes('Commit is MANDATORY'), commit, `${agent.id}: mandatory commit line follows the commit flag`);
      assert.equal(/Definition of done:|Done only when/.test(prompt), commit, `${agent.id}: definition-of-done line follows the commit flag`);
      assert.equal(prompt.includes('Do not commit:'), !commit);
      assert.equal(prompt.includes('Open a pull/merge request'), pr);
      assert.equal(prompt.includes('`git merge task/<TASK_KEY>`'), merge && commit);
      assert.equal(/[Ww]ait for (?:the )?user to commit and merge/.test(prompt), merge && !commit);
    }
    const svn = agent.buildPrompt('TASK', { vcsSettings: SVN });
    once(svn, /svn commit/, `${agent.id}: svn commit once`);
    assert.doesNotMatch(svn, /Version control \(git\)/);
  }
});

// TPT345 — directive tells agents to branch from the CURRENT branch, check .gitignore before
// appending, and commit BEFORE marking the task completed (full + compact).
test('buildVcsDirective (TPT345): current-branch base, .gitignore check, commit-before-complete', () => {
  const full = buildVcsDirective(GIT_ALL_ON);
  assert.match(full, /-b task\/<TASK_KEY> HEAD/);
  assert.match(full, /CURRENT branch/);
  assert.match(full, /only if it is missing/);
  assert.match(full, /BEFORE you mark the task completed/);
  const compact = buildVcsDirective(GIT_ALL_ON, { compact: true });
  assert.match(compact, /-b task\/<TASK_KEY> HEAD/);
  assert.match(compact, /add only if missing/);
  assert.match(compact, /BEFORE marking the task completed/);
  assert.doesNotMatch(compact, /\?/);
  assert.ok(compact.includes('Work in a dedicated git worktree'));
});

// TPT573 — an enabled Commits flag is a hard completion requirement, not a permission the agent
// may skip or hand back to the user. Full (Claude/Codex) and compact (Pi), every commit-on combo.
for (const compact of [false, true]) {
  test(`buildVcsDirective (TPT573): commits on -> commit is mandatory, never skipped or asked about (compact=${compact})`, () => {
    for (const worktree of [false, true]) for (const pr of [false, true]) for (const merge of [false, true]) {
      const label = `worktree=${worktree} pr=${pr} merge=${merge}`;
      const directive = buildVcsDirective({ type: 'git', worktree, commit: true, pr, merge }, { compact });
      const mandatory = directive.split('\n').filter(line => /\bmandatory\b/i.test(line));
      assert.equal(mandatory.length, 1, `exactly one mandatory commit line (${label})`);
      const [line] = mandatory;
      assert.match(line, /^- Commit is MANDATORY\b/, label);
      assert.match(line, /not complete until[^\n]*`git add`[^\n]*`git commit`/, label);
      assert.ok(line.includes('`<TASK_KEY>: <summary>`'), `commit message must start with the task key (${label})`);
      assert.match(line, /Never skip the commit, never ask the user whether to commit/, label);
      assert.match(line, /never leave (?:this task's|task) changes uncommitted/, label);
      assert.match(line, /stage only/, label);
      assert.match(line, /BEFORE (?:you mark|marking) the task completed/, label);
      assert.doesNotMatch(line, /\?/, label);
    }
    for (const vcs of [{ ...GIT_ALL_ON, commit: false }, GIT_WORKTREE_ONLY, VCS_OFF, SVN]) {
      assert.doesNotMatch(buildVcsDirective(vcs, { compact }), /mandatory/i, 'only an enabled Commits flag makes the commit mandatory');
    }
  });
}

// TPT611 — commits on: a definition-of-done line gates "done" on the recorded task commit, a
// clean status and a completed complete_task result, and forbids handing the commit back.
for (const compact of [false, true]) {
  test(`buildVcsDirective (TPT611): commits on -> one definition-of-done line, absent otherwise (compact=${compact})`, () => {
    const dodRe = compact ? /^- Done only when / : /^- Definition of done: /;
    for (const worktree of [false, true]) for (const pr of [false, true]) for (const merge of [false, true]) {
      const label = `worktree=${worktree} pr=${pr} merge=${merge}`;
      const directive = buildVcsDirective({ type: 'git', worktree, commit: true, pr, merge }, { compact });
      const lines = directive.split('\n').filter(line => dodRe.test(line));
      assert.equal(lines.length, 1, `exactly one definition-of-done line (${label})`);
      const [line] = lines;
      assert.equal(directive.split('\n').at(-1), line, `definition of done closes the git block (${label})`);
      assert.ok(line.includes(worktree ? '`git log -1 task/<TASK_KEY>`' : '`git log -1`'), label);
      if (!worktree) assert.ok(!line.includes('git log -1 task/'), label);
      assert.ok(line.includes('`<TASK_KEY>:`'), label);
      assert.ok(line.includes('`git status`'), label);
      assert.match(line, /complete_task/, label);
      assert.match(line, /[Nn]ever end with "ready to commit when you confirm"/, label);
      if (compact) assert.match(line, /final message gives the sha/, label);
      else assert.match(line, /NOT done until/, label);
      assert.doesNotMatch(line, /\?/, label);
      assert.doesNotMatch(line, /mandatory/i, `the commit line alone owns "mandatory" (${label})`);
    }
    for (const vcs of [{ ...GIT_ALL_ON, commit: false }, GIT_WORKTREE_ONLY, VCS_OFF, SVN]) {
      assert.doesNotMatch(buildVcsDirective(vcs, { compact }), /Definition of done|Done only when|ready to commit when you confirm/);
    }
  });
}

// TPT611 — the Claude/Codex guarded-completion mandate closes with a final-message checklist:
// commit sha (commits on only) and the complete_task result, after follow-up capture.
for (const Agent of [ClaudeAgent, CodexAgent]) {
  test(`${new Agent().id}: vcsContext mandate ends with the final-message checklist (TPT611)`, () => {
    const agent = new Agent();
    for (const commit of [true, false]) {
      const context = { ...VCS_CONTEXT, vcs: { ...VCS_CONTEXT.vcs, commit } };
      const prompt = agent.buildPrompt('Do the thing', { vcsContext: context, vcsSettings: context.vcs });
      const checklists = [...prompt.matchAll(/Final-message checklist: [^\n]*/g)].map(m => m[0]);
      assert.equal(checklists.length, 1, `one checklist (commit=${commit})`);
      const [checklist] = checklists;
      assert.match(checklist, /after Follow-up capture and `?complete_task`?/, 'follow-up capture stays ahead of complete_task');
      assert.match(checklist, /`?complete_task`? result \(completed, or the blockers it listed and the on_fire fallback/);
      assert.equal(checklist.includes('commit sha'), commit, `sha clause follows the commit flag (commit=${commit})`);
      assert.match(checklist, /follow-up task keys/);
      assert.doesNotMatch(checklist, /\?/);
      assert.ok(!prompt.includes('update_task(status='), 'still finishes through complete_task');
      assert.ok(prompt.indexOf('Final-message checklist') > prompt.indexOf('complete_task'), 'checklist follows the complete_task mandate');
      assert.equal(/Definition of done:/.test(prompt), commit, 'definition-of-done line follows the commit flag');
      if (agent.id === 'codex') {
        const mandate = prompt.split('\n').find(line => line.startsWith('- MANDATORY: supply ONE'));
        assert.ok(mandate.includes('Final-message checklist'), 'Codex checklist stays on the mandate line');
        assert.equal(matchPromptLine(mandate, CODEX_PROMPT_PATTERNS), null);
      }
    }
    const legacy = agent.buildPrompt('Do the thing', { vcsSettings: GIT_ALL_ON });
    assert.ok(!legacy.includes('Final-message checklist'), 'no checklist on the legacy (no vcsContext) mandate');
  });
}
