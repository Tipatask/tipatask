'use strict';

// C894: the forked multi-project server must resolve ai/architecture per active project,
// not via a single module-load constant. These tests assert that getStaticBundle /
// listSystemTags / getTagArchitecture are isolated per projectRoot and that omitting
// projectRoot still resolves (env/repo fallback — dev parity).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sc = require('./static-context');
const ac = require('../mcp/architecture-cache');

function mkProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `c894-${label}-`));
  const arch = path.join(root, 'ai', 'architecture');
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(arch, 'GENERAL.md'), `# GENERAL ${label}\nstack-${label}`);
  fs.writeFileSync(path.join(arch, `tt-${label}.md`), `# tt-${label} — Module ${label}\nbody-${label}`);
  fs.writeFileSync(path.join(root, 'ai', 'CONVENTIONS.md'), `conv-${label}`);
  return root;
}

test('static-context: per-project isolation (no cross-contamination between project windows)', () => {
  const A = mkProject('alpha');
  const B = mkProject('beta');
  try {
    const bundleA = sc.getStaticBundle(A);
    const bundleB = sc.getStaticBundle(B);

    assert.ok(bundleA.includes('stack-alpha'), 'A bundle has alpha GENERAL');
    assert.ok(bundleA.includes('tt-alpha'), 'A bundle taxonomy lists tt-alpha');
    assert.ok(bundleA.includes('conv-alpha'), 'A bundle includes alpha CONVENTIONS');
    assert.ok(!bundleA.includes('beta'), 'A bundle must not leak beta content');

    assert.ok(bundleB.includes('stack-beta') && bundleB.includes('conv-beta'), 'B has beta content');
    assert.ok(!bundleB.includes('alpha'), 'B bundle must not leak alpha content');
    assert.notStrictEqual(bundleA, bundleB, 'bundles differ per project');
  } finally {
    fs.rmSync(A, { recursive: true, force: true });
    fs.rmSync(B, { recursive: true, force: true });
  }
});

test('architecture-cache: getTagArchitecture / listSystemTags scoped to projectRoot', () => {
  const A = mkProject('gamma');
  const B = mkProject('delta');
  try {
    assert.strictEqual(ac.getTagArchitecture('tt-gamma', A), '# tt-gamma — Module gamma\nbody-gamma');
    assert.strictEqual(ac.getTagArchitecture('tt-gamma', B), null, 'tt-gamma absent in B');
    assert.ok(ac.getTagArchitecture('tt-delta', B).includes('body-delta'));

    const tagsA = ac.listSystemTags(A).map(t => t.tag);
    assert.ok(tagsA.includes('tt-gamma') && !tagsA.includes('tt-delta'), 'listSystemTags isolated');
  } finally {
    fs.rmSync(A, { recursive: true, force: true });
    fs.rmSync(B, { recursive: true, force: true });
  }
});

test('static-context: bundle cache is stable per project', () => {
  const A = mkProject('epsilon');
  try {
    const first = sc.getStaticBundle(A);
    assert.strictEqual(sc.getStaticBundle(A), first, 'repeat call returns cached bundle');
  } finally {
    fs.rmSync(A, { recursive: true, force: true });
  }
});

test('static-context: omitting projectRoot still resolves (env/repo fallback — dev parity)', () => {
  const bundle = sc.getStaticBundle();
  assert.ok(typeof bundle === 'string' && bundle.includes('Tag Taxonomy'), 'default bundle builds');
  // Default resolution must not collide with a project-scoped resolution.
  assert.ok(Array.isArray(ac.listSystemTags()), 'default listSystemTags returns array');
});

test('architecture-cache: resolveArchitectureDir prefers explicit projectRoot', () => {
  const root = path.join(os.tmpdir(), 'c894-resolve-test');
  const resolved = ac.resolveArchitectureDir(root);
  assert.strictEqual(resolved, path.join(root, 'ai', 'architecture'));
});

// C1439 — prefetchObjectiveWorkflow's ### get_project_tags section must always tell the
// planner the TRUTH about the registry: populated, genuinely empty, or unreadable. A
// fetch failure used to collapse to `[]` and the section silently vanished, which the
// planner could not tell apart from "this project has zero tags" — either way it looked
// like "no constraint", and the model went on to emit unregistered tags with no new_tags
// entry. Minimal fake backend: getTasksUnfiltered() only (no getStatuses — fetchStatusContext
// fails open to legacy defaults without it).
function fakeBackend({ tags }) {
  return {
    async getTasksUnfiltered() { return []; },
    async getTagsDetailed() {
      if (tags instanceof Error) throw tags;
      return tags;
    },
  };
}

test('prefetched priority baseline uses custom active statuses and closed-task fallback', async () => {
  const root = mkProject('priority-baseline');
  try {
    for (const active of [true, false]) {
      const backend = fakeBackend({ tags: [] });
      backend.getTasksUnfiltered = async () => [
        { id: 'TPT1', category: 'CODING', status: active ? 'working' : 'done', priority: 42 },
        { id: 'TPT2', category: 'CODING', status: 'done', priority: 80 },
      ];
      backend.getStatuses = async () => [
        { name: 'working', is_workflow_start: true }, { name: 'done', is_workflow_complete: true },
      ];
      const { bundle } = await sc.prefetchObjectiveWorkflow(backend, 'new', root);
      const meta = JSON.parse(bundle.match(/### list_task_id_meta\n```json\n([\s\S]*?)\n```/)[1]);
      assert.equal(meta.priorityBaseline, active ? 42 : 81);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prefetchObjectiveWorkflow: populated registry renders the real tag list', async () => {
  const root = mkProject('c1439-populated');
  try {
    const backend = fakeBackend({ tags: [{ name: 'config', description: 'x' }] });
    const { bundle } = await sc.prefetchObjectiveWorkflow(backend, 'C1', root);
    assert.match(bundle, /### get_project_tags/);
    assert.match(bundle, /"name": "config"/);
    assert.doesNotMatch(bundle, /UNAVAILABLE/);
    assert.doesNotMatch(bundle, /NO tags registered/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prefetchObjectiveWorkflow: genuinely empty registry says so explicitly, distinct from unavailable', async () => {
  const root = mkProject('c1439-empty');
  try {
    const backend = fakeBackend({ tags: [] });
    const { bundle } = await sc.prefetchObjectiveWorkflow(backend, 'C1', root);
    assert.match(bundle, /### get_project_tags/);
    assert.match(bundle, /NO tags registered yet/);
    assert.match(bundle, /new_tags entry/);
    assert.doesNotMatch(bundle, /UNAVAILABLE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prefetchObjectiveWorkflow: a getTagsDetailed() failure renders UNAVAILABLE, never a silently-omitted or empty-looking section', async () => {
  const root = mkProject('c1439-unavailable');
  try {
    const backend = fakeBackend({ tags: new Error('ECONNRESET') });
    const { bundle } = await sc.prefetchObjectiveWorkflow(backend, 'C1', root);
    assert.match(bundle, /### get_project_tags/);
    assert.match(bundle, /UNAVAILABLE \(ECONNRESET\)/);
    assert.match(bundle, /Treat every tag you use as unregistered/);
    assert.doesNotMatch(bundle, /NO tags registered/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prefetchObjectiveWorkflow: a backend with no getTagsDetailed() also renders UNAVAILABLE, not a silent omission', async () => {
  const root = mkProject('c1439-nomethod');
  try {
    const backend = { async getTasksUnfiltered() { return []; } };
    const { bundle } = await sc.prefetchObjectiveWorkflow(backend, 'C1', root);
    assert.match(bundle, /### get_project_tags/);
    assert.match(bundle, /UNAVAILABLE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// TPT488 — the planner must see the verbatim original before proposing a "modified"
// description; active tasks named by key in the objective are pre-fetched in full.
test('buildReferencedTasksSection: active keys named in the objective get their full description', () => {
  const longDesc = '1. @a.js keep focus routing; verify X.\n\n2. @b.js keep dismissal; verify Y.\n\n' + 'z'.repeat(5000);
  const tasks = [
    { id: 'TPT10', title: 'Panel', status: 'pending', description: longDesc },
    { id: 'TPT11', title: 'Done one', status: 'completed', description: 'closed' },
    { id: 'TPT12', title: 'Other', status: 'pending', description: 'not named' },
  ];
  const active = new Set(['pending', 'in_progress']);
  const section = sc.buildReferencedTasksSection(tasks, 'Objective: add Show on Top to TPT10, TPT10 again, and TPT11. Ignore TPT999.', active);
  assert.match(section, /^### Referenced task descriptions/);
  const rows = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(rows.map(r => r.id), ['TPT10']);
  assert.equal(rows[0].description, longDesc, 'description is never truncated');

  assert.equal(sc.buildReferencedTasksSection(tasks, 'no keys here', active), '');
  assert.equal(sc.buildReferencedTasksSection(tasks, 'only TPT11', active), '');
  assert.equal(sc.buildReferencedTasksSection(tasks, '', active), '');
});

test('prefetchObjectiveWorkflow: renders the referenced-task block only when the objective names an active task', async () => {
  const root = mkProject('tpt488-referenced');
  try {
    const backend = fakeBackend({ tags: [] });
    backend.getTasksUnfiltered = async () => [
      { id: 'C7', title: 'Seven', status: 'pending', category: 'CODING', priority: 1, description: 'full seven text' },
    ];
    const named = await sc.prefetchObjectiveWorkflow(backend, 'new', root, 'Objective from the user:\n\nupdate C7');
    assert.match(named.bundle, /### Referenced task descriptions[\s\S]*full seven text/);
    const unnamed = await sc.prefetchObjectiveWorkflow(backend, 'new', root, 'Objective from the user:\n\nsomething else');
    assert.doesNotMatch(unnamed.bundle, /### Referenced task descriptions/);
    const legacy = await sc.prefetchObjectiveWorkflow(backend, 'new', root);
    assert.doesNotMatch(legacy.bundle, /### Referenced task descriptions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
