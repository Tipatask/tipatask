import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createMemberCache, membersEqual } = await import('./member-cache.js');

const M1 = { id: 1, user_id: 1, name: 'Ann', avatar_url: null };
const M2 = { id: 2, user_id: 2, name: 'Bob', avatar_url: null };
const M2_RENAMED = { id: 2, user_id: 2, name: 'Bobby', avatar_url: null };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── membersEqual ──

test('membersEqual: same length + fields is equal', () => {
  assert.equal(membersEqual([M1, M2], [{ ...M1 }, { ...M2 }]), true);
});

test('membersEqual: different length is not equal', () => {
  assert.equal(membersEqual([M1], [M1, M2]), false);
});

test('membersEqual: renamed member is not equal', () => {
  assert.equal(membersEqual([M1, M2], [M1, M2_RENAMED]), false);
});

test('membersEqual: null/undefined treated as empty list', () => {
  assert.equal(membersEqual(null, undefined), true);
  assert.equal(membersEqual(null, [M1]), false);
});

// ── ensure() ──

test('ensure(): fetches once, caches, second call makes no second fetch', async () => {
  let calls = 0;
  const cache = createMemberCache({ fetchMembers: async () => { calls++; return [M1]; } });
  const first = await cache.ensure();
  const second = await cache.ensure();
  assert.equal(calls, 1);
  assert.deepEqual(first, [M1]);
  assert.strictEqual(second, first);
});

test('ensure(): applies normalize to each raw member', async () => {
  const cache = createMemberCache({
    fetchMembers: async () => [{ raw: 1 }],
    normalize: (m) => ({ id: m.raw, name: `member-${m.raw}` }),
  });
  const result = await cache.ensure();
  assert.deepEqual(result, [{ id: 1, name: 'member-1' }]);
});

// ── revalidate(): single-flight dedupe ──

test('revalidate(): two overlapping calls trigger exactly one fetch', async () => {
  let calls = 0;
  const d = deferred();
  const cache = createMemberCache({ fetchMembers: () => { calls++; return d.promise; } });
  const p1 = cache.revalidate();
  const p2 = cache.revalidate();
  d.resolve([M1]);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.deepEqual(r1.members, [M1]);
  assert.deepEqual(r2.members, [M1]);
});

// ── revalidate(): changed flag ──

test('revalidate(): identical payload reports changed=false', async () => {
  let payload = [M1, M2];
  const cache = createMemberCache({ fetchMembers: async () => payload });
  await cache.ensure();
  const result = await cache.revalidate();
  assert.equal(result.changed, false);
  assert.deepEqual(result.members, [M1, M2]);
});

test('revalidate(): added member reports changed=true', async () => {
  let payload = [M1];
  const cache = createMemberCache({ fetchMembers: async () => payload });
  await cache.ensure();
  payload = [M1, M2];
  const result = await cache.revalidate();
  assert.equal(result.changed, true);
  assert.deepEqual(result.members, [M1, M2]);
});

test('revalidate(): first call against an empty project settles cache (no infinite refetch)', async () => {
  let calls = 0;
  const cache = createMemberCache({ fetchMembers: async () => { calls++; return []; } });
  const result = await cache.revalidate();
  assert.equal(result.changed, false); // null -> [] is "no real change" for callers
  assert.deepEqual(cache.peek(), []);
  await cache.ensure(); // must not re-fetch — cache is now a settled []
  assert.equal(calls, 1);
});

// ── failure handling ──

test('revalidate(): rejected fetch does not clobber a previously good cache', async () => {
  let shouldFail = false;
  const cache = createMemberCache({
    fetchMembers: async () => {
      if (shouldFail) throw new Error('network down');
      return [M1, M2];
    },
  });
  await cache.ensure();
  shouldFail = true;
  const result = await cache.revalidate();
  assert.equal(result.changed, false);
  assert.deepEqual(result.members, [M1, M2]);
  assert.deepEqual(cache.peek(), [M1, M2]);
});

test('revalidate(): rejected fetch before any success yields empty, cache stays unsettled for retry', async () => {
  let shouldFail = true;
  let calls = 0;
  const cache = createMemberCache({
    fetchMembers: async () => {
      calls++;
      if (shouldFail) throw new Error('network down');
      return [M1];
    },
  });
  const failedResult = await cache.revalidate();
  assert.equal(failedResult.changed, false);
  assert.deepEqual(failedResult.members, []);
  assert.equal(cache.peek(), null);

  shouldFail = false;
  const okResult = await cache.revalidate();
  assert.equal(calls, 2);
  assert.equal(okResult.changed, true);
  assert.deepEqual(okResult.members, [M1]);
});

test('ensure(): a prior failed revalidate still triggers a real fetch, not stuck on []', async () => {
  let shouldFail = true;
  const cache = createMemberCache({
    fetchMembers: async () => {
      if (shouldFail) throw new Error('down');
      return [M1];
    },
  });
  await cache.revalidate(); // fails, cache stays null
  shouldFail = false;
  const result = await cache.ensure();
  assert.deepEqual(result, [M1]);
});
