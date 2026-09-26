import assert from 'node:assert/strict';
import { test } from 'node:test';

const { VCS_TYPES, VCS_GIT_FLAGS, buildVcsPatchBody } = await import('./vcs-form.js');

// (TPT62) buildVcsPatchBody() is the single guard against the dormant-flag trap: sending
// `false` for the four git-only flags on a Disabled/SVN save would zero out choices the
// user may switch back to, and sending `true` when vcs_type isn't 'git' is a 400 from the
// API's buildVcsPatch(). These mirror api/web/src/lib/vcs-form.js's own test intent —
// field names/order must stay in lockstep with that module and with the server-side
// api/src/lib/vcs-settings.js VCS_GIT_FLAGS.

test('buildVcsPatchBody("git", flags) includes vcs_type plus all four strict-boolean flags', () => {
  const body = buildVcsPatchBody('git', {
    vcs_worktree_enabled: true,
    vcs_commit_enabled: false,
    vcs_pr_enabled: true,
    vcs_merge_enabled: true,
  });
  assert.deepEqual(body, {
    vcs_type: 'git',
    vcs_worktree_enabled: true,
    vcs_commit_enabled: false,
    vcs_pr_enabled: true,
    vcs_merge_enabled: true,
  });
});

test('buildVcsPatchBody("", flags) normalizes to vcs_type: null and omits every flag key', () => {
  const body = buildVcsPatchBody('', { vcs_worktree_enabled: true, vcs_commit_enabled: true, vcs_pr_enabled: true, vcs_merge_enabled: true });
  assert.deepEqual(body, { vcs_type: null });
});

test('buildVcsPatchBody("svn", flags) omits every flag key even when truthy flags are passed in', () => {
  // Regression guard: svn has no suboptions of its own, but the caller may still be
  // holding stale git-flag state (e.g. a user who had worktrees on before switching to
  // svn) — that state must never reach the PATCH body.
  const body = buildVcsPatchBody('svn', { vcs_worktree_enabled: true, vcs_commit_enabled: true, vcs_pr_enabled: true, vcs_merge_enabled: true });
  assert.deepEqual(body, { vcs_type: 'svn' });
});

test('buildVcsPatchBody("git", flags) coerces a missing flag key to false', () => {
  const body = buildVcsPatchBody('git', { vcs_commit_enabled: true });
  assert.equal(body.vcs_worktree_enabled, false);
  assert.equal(body.vcs_commit_enabled, true);
  assert.equal(body.vcs_pr_enabled, false);
  assert.equal(body.vcs_merge_enabled, false);
});

test('buildVcsPatchBody("git", flags) ignores an unknown flag key', () => {
  const body = buildVcsPatchBody('git', { not_a_real_field: true });
  assert.equal('not_a_real_field' in body, false);
});

test('buildVcsPatchBody(undefined/null flags, "git") does not throw and defaults every flag to false', () => {
  assert.deepEqual(buildVcsPatchBody('git', undefined), {
    vcs_type: 'git',
    vcs_worktree_enabled: false,
    vcs_commit_enabled: false,
    vcs_pr_enabled: false,
    vcs_merge_enabled: false,
  });
});

test('VCS_GIT_FLAGS field names/order match the web twin (api/web/src/lib/vcs-form.js)', () => {
  assert.deepEqual(
    VCS_GIT_FLAGS.map((f) => f.field),
    ['vcs_worktree_enabled', 'vcs_commit_enabled', 'vcs_pr_enabled', 'vcs_merge_enabled']
  );
});

test('VCS_TYPES covers exactly the three radio values, Disabled first', () => {
  assert.deepEqual(VCS_TYPES.map((t) => t.value), ['', 'git', 'svn']);
});
