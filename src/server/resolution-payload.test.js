'use strict';

// C1541 — node:test suite for resolution-payload.js. Ported verbatim (test bodies
// unchanged, require path only) from the remote API's own
// api/src/lib/resolution-payload.test.js — keeping both suites identical is how drift
// between the two hand-synced copies gets caught.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TRUNC_MARK,
  MAX_COMMENTS_PER_TASK,
  AGENT_EXIT_MARKER,
  isAgentLogTailComment,
  clip,
  shapeResolutionPayload,
} = require('./resolution-payload');

// ── isAgentLogTailComment ──

test('detects all three auto-posted terminal-tail headers', () => {
  const mk = (header) => `${header}\n\n\`\`\`\nsome PTY output\nmore lines\n\`\`\``;
  assert.equal(isAgentLogTailComment(mk('Agent session terminated by user')), true);
  assert.equal(isAgentLogTailComment(mk('Agent completed the task')), true);
  assert.equal(isAgentLogTailComment(mk('Agent session ended (exit code 1)')), true);
  assert.equal(isAgentLogTailComment(mk('Agent session ended (exit code 137)')), true);
});

test('empty-tail log dump still detected', () => {
  assert.equal(isAgentLogTailComment('Agent completed the task\n\n```\n\n```'), true);
});

test('genuine report starting with similar words is NOT a false positive', () => {
  const content = 'Agent completed the task by wiring up the new endpoint. Files touched: routes/tasks.js.';
  assert.equal(isAgentLogTailComment(content), false);
});

test('header line alone with no following fence is not a log tail', () => {
  assert.equal(isAgentLogTailComment('Agent completed the task\n\nNo fence here, just prose.'), false);
});

test('plain prose, empty string, and null are not log tails', () => {
  assert.equal(isAgentLogTailComment('Implemented the feature per spec.'), false);
  assert.equal(isAgentLogTailComment(''), false);
  assert.equal(isAgentLogTailComment(null), false);
});

// (TPT354) The auto-posted exit comment now ends in an invisible marker instead of a fence.

test('detects the marker-terminated exit comment (rendered-markdown body)', () => {
  const body = 'TPT352 completed. **MailSenderTest.php** now skips sibling-file checks.\n\n- one\n- two';
  const mk = (header) => `${header}\n\n${body}\n\n${AGENT_EXIT_MARKER}`;
  assert.equal(isAgentLogTailComment(mk('Agent completed the task')), true);
  assert.equal(isAgentLogTailComment(mk('Agent session terminated by user')), true);
  assert.equal(isAgentLogTailComment(mk('Agent session ended (exit code 1)')), true);
});

test('header-only exit comment (nothing readable) is detected via the marker', () => {
  assert.equal(isAgentLogTailComment(`Agent completed the task\n\n${AGENT_EXIT_MARKER}`), true);
});

test('marker tolerates trailing blank lines / whitespace', () => {
  assert.equal(isAgentLogTailComment(`Agent completed the task\n\nbody\n\n${AGENT_EXIT_MARKER}\n\n  \n`), true);
});

test('marker without the exact header is not a log tail', () => {
  assert.equal(isAgentLogTailComment(`My own report\n\n${AGENT_EXIT_MARKER}`), false);
});

test('marker in the middle of a genuine report is not a log tail', () => {
  assert.equal(isAgentLogTailComment(`Agent completed the task\n\n${AGENT_EXIT_MARKER}\n\nMore real prose after it.`), false);
});

// ── clip ──

test('clip passes text under the limit through unchanged', () => {
  const result = clip('short text', 100);
  assert.deepEqual(result, { text: 'short text', truncated: false });
});

test('clip never exceeds max and marks truncated', () => {
  const long = 'x'.repeat(500);
  const result = clip(long, 100);
  assert.ok(result.text.length <= 100);
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith(TRUNC_MARK));
});

test('clip with max smaller than the marker does not throw', () => {
  const result = clip('some text longer than five chars', 5);
  assert.ok(result.text.length <= 5);
  assert.equal(result.truncated, true);
});

test('clip output length never exceeds max, at every size including below the marker length', () => {
  const source = 'y'.repeat(2000); // longer than every max tested below, so all cases truncate
  for (const max of [0, 1, 5, 12, 50, 1000]) {
    const r = clip(source, max);
    assert.ok(r.text.length <= max, `max=${max} produced length ${r.text.length}`);
    assert.equal(r.truncated, true);
  }
});

test('clip truncated flag matches endsWith(TRUNC_MARK) once max reaches the marker length', () => {
  const source = 'y'.repeat(2000);
  for (const max of [TRUNC_MARK.length, TRUNC_MARK.length + 5, 50, 1000]) {
    const r = clip(source, max);
    assert.equal(r.truncated, r.text.endsWith(TRUNC_MARK));
  }
});

// ── shapeResolutionPayload ──

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, status: 'completed', tags: ['tt-mcp-server'], description: 'desc', ...overrides };
}

test('per-task comment cap keeps only the newest N', () => {
  const commentsByTaskId = {
    C1: [
      { id: 1, content: 'oldest', comment_type: 'comment', created_at: '2026-01-01' },
      { id: 2, content: 'middle', comment_type: 'comment', created_at: '2026-01-02' },
      { id: 3, content: 'newer', comment_type: 'resolution', created_at: '2026-01-03' },
      { id: 4, content: 'newest', comment_type: 'resolution', created_at: '2026-01-04' },
    ],
  };
  const { resolutions } = shapeResolutionPayload({ tasks: [task('C1')], commentsByTaskId });
  assert.equal(resolutions[0].resolution_comments.length, MAX_COMMENTS_PER_TASK);
  const ids = resolutions[0].resolution_comments.map(c => c.id);
  assert.deepEqual(ids, [4, 3, 2]);
});

test('all comment types are eligible, not just resolution', () => {
  const commentsByTaskId = {
    C1: [
      { id: 1, content: 'spec capture', comment_type: 'spec', created_at: '2026-01-01' },
      { id: 2, content: 'discussion', comment_type: 'comment', created_at: '2026-01-02' },
      { id: 3, content: 'report', comment_type: 'resolution', created_at: '2026-01-03' },
    ],
  };
  const { resolutions } = shapeResolutionPayload({ tasks: [task('C1')], commentsByTaskId });
  const types = resolutions[0].resolution_comments.map(c => c.type).sort();
  assert.deepEqual(types, ['comment', 'resolution', 'spec']);
});

test('agent log-tail comments excluded by default', () => {
  const commentsByTaskId = {
    C1: [
      { id: 1, content: 'Agent completed the task\n\n```\nlog\n```', comment_type: 'resolution', created_at: '2026-01-01' },
      { id: 2, content: 'Real report here.', comment_type: 'resolution', created_at: '2026-01-02' },
    ],
  };
  const { resolutions } = shapeResolutionPayload({ tasks: [task('C1')], commentsByTaskId });
  assert.equal(resolutions[0].resolution_comments.length, 1);
  assert.equal(resolutions[0].resolution_comments[0].content, 'Real report here.');
});

test('includeAgentLogs:true restores log-tail comments', () => {
  const commentsByTaskId = {
    C1: [
      { id: 1, content: 'Agent completed the task\n\n```\nlog\n```', comment_type: 'resolution', created_at: '2026-01-01' },
    ],
  };
  const { resolutions } = shapeResolutionPayload({ tasks: [task('C1')], commentsByTaskId, includeAgentLogs: true });
  assert.equal(resolutions[0].resolution_comments.length, 1);
});

test('global char budget stops adding comments but keeps every task', () => {
  // 15 tasks x 2 comments x 1500 chars = 45000 chars, well past the 20000 global cap —
  // must trigger real truncation without dropping any of the 15 tasks.
  const bigComment = (n) => ({ id: n, content: 'z'.repeat(1500), comment_type: 'resolution', created_at: `2026-01-${String(n).padStart(2, '0')}` });
  const tasks = [];
  const commentsByTaskId = {};
  for (let i = 1; i <= 15; i++) {
    tasks.push(task(`C${i}`));
    commentsByTaskId[`C${i}`] = [bigComment(i * 2 - 1), bigComment(i * 2)];
  }
  const { resolutions, truncated } = shapeResolutionPayload({ tasks, commentsByTaskId, totalMatched: 15 });
  assert.equal(resolutions.length, 15); // every task present, none dropped for budget reasons
  assert.equal(truncated, true);
  const totalCommentChars = resolutions.flatMap(r => r.resolution_comments).reduce((a, c) => a + c.content.length, 0);
  assert.ok(totalCommentChars <= 20000);
  // later tasks in the list ran out of budget entirely
  assert.equal(resolutions[14].resolution_comments.length, 0);
});

test('description is clipped and truncation is reported', () => {
  const longDesc = 'd'.repeat(1000);
  const { resolutions } = shapeResolutionPayload({
    tasks: [task('C1', { description: longDesc })],
    commentsByTaskId: {},
  });
  assert.ok(resolutions[0].description.length <= 400);
  assert.ok(resolutions[0].description.endsWith(TRUNC_MARK));
});

test('task with no comments still returns with an empty resolution_comments array', () => {
  const { resolutions } = shapeResolutionPayload({ tasks: [task('C1')], commentsByTaskId: {} });
  assert.deepEqual(resolutions[0].resolution_comments, []);
});

test('returned and total_matched reflect input sizes', () => {
  const { returned, total_matched } = shapeResolutionPayload({
    tasks: [task('C1'), task('C2')],
    commentsByTaskId: {},
    totalMatched: 5,
  });
  assert.equal(returned, 2);
  assert.equal(total_matched, 5);
});
