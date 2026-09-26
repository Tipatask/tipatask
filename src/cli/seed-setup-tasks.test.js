'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PRESET_TASKS,
  CODE_SCAN_TASK_TITLE,
  CODE_SCAN_TASK_DESCRIPTION,
  inspectionTaskBody,
  BACKLOG_BLOCK,
  ORIGINAL_SPEC_STARTER_TITLES,
  discoveryBlock,
  EXISTING_CODE_MAP_TASK_TITLE,
  EXISTING_CODE_MAP_TASK_DESCRIPTION,
  EXISTING_CODE_DOC_TITLES,
  EXISTING_CODE_SPRINT2_TITLES,
  EXISTING_CODE_PROFILE_TASK_DESCRIPTION,
  EXISTING_CODE_GATE_BLOCK,
  existingCodeInspectionBody,
  CONDITIONAL_TRACKS,
  finalizeBodyError,
  describePresetSeedProblem,
} = require('./seed-setup-tasks');

// MAX_DESC_LEN lives in src/client/constants.js, which is ESM and not require()-able
// from this CJS test — read it by regex so the budget guard below can never drift
// from the real constant (C1065).
function readMaxDescLen() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'constants.js'),
    'utf8'
  );
  const m = src.match(/MAX_DESC_LEN\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_DESC_LEN not found in constants.js');
  return parseInt(m[1], 10);
}

const MAX_DESC_LEN = readMaxDescLen();
const specDefs = PRESET_TASKS['original-specification'];
const existingCodeDefs = PRESET_TASKS['existing-code'];

// ── C1102: legacy-project/existing-frontend/existing-backend (C/D/E) removed
// — the CLI (src/cli/setup.js) now offers the same 2 presets as the wizard.
// Their substance lives on in CONDITIONAL_TRACKS, asserted below. ──

test('PRESET_TASKS defines only the 2 wizard/CLI-shared keys', () => {
  assert.deepEqual(
    Object.keys(PRESET_TASKS).sort(),
    ['existing-code', 'original-specification']
  );
});

test('every preset in PRESET_TASKS has a template file on disk', () => {
  for (const letter of ['a', 'b']) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', '..', 'templates', `preset-${letter}.md`)),
      `templates/preset-${letter}.md missing`
    );
  }
});

test('removed C/D/E preset templates stay gone (C1102 regression guard)', () => {
  for (const letter of ['c', 'd', 'e']) {
    assert.ok(
      !fs.existsSync(path.join(__dirname, '..', '..', 'templates', `preset-${letter}.md`)),
      `templates/preset-${letter}.md should have been removed`
    );
  }
});

test('original-specification has 5 entries, code-scan task first', () => {
  assert.equal(specDefs.length, 5);
  assert.equal(specDefs[0][0], CODE_SCAN_TASK_TITLE);
});

test('code-scan task seeds at priority 1 with no code-scan dependency', () => {
  const [, , extra] = specDefs[0];
  assert.equal(extra.priority, 1);
  assert.ok(!extra.dependsOnCodeScan);
});

test('the three research spec tasks seed at priority 2, depending on the code-scan task', () => {
  for (let i = 1; i <= 3; i++) {
    const [, , extra] = specDefs[i];
    assert.equal(extra.priority, 2, `entry ${i} priority`);
    assert.equal(extra.dependsOnCodeScan, true, `entry ${i} dependsOnCodeScan`);
  }
});

// C1142: 'Choose tech stack' must not be pickable before architecture/data-model/user-flows
// exist — depends on all three (plus code-scan) and seeds one sprint after them.
test('Choose tech stack seeds one sprint after the other three spec tasks and depends on all of them', () => {
  const [title, , extra] = specDefs[4];
  assert.equal(title, 'Choose tech stack');
  assert.deepEqual(extra.dependsOn, [0, 1, 2, 3]);
  const depTitles = extra.dependsOn.map(idx => specDefs[idx][0]);
  assert.deepEqual(depTitles, [CODE_SCAN_TASK_TITLE, ...ORIGINAL_SPEC_STARTER_TITLES.slice(0, 3)]);
  const otherPriorities = specDefs.slice(1, 4).map(([, , e]) => e.priority);
  assert.ok(extra.priority > Math.max(...otherPriorities), 'tech-stack priority must exceed the other three');
  assert.equal(extra.priority, 3);
});

test('the four spec task titles match ORIGINAL_SPEC_STARTER_TITLES in order (gate matches by title)', () => {
  const titles = specDefs.slice(1).map(([title]) => title);
  assert.deepEqual(titles, ORIGINAL_SPEC_STARTER_TITLES);
});

// C1142/C1482: real wiring check — stub the HTTP layer and run seedPresetTasks for
// real, asserting the exact reserve call + PATCH bodies (priority/dependencies) it
// sends, not just the static PRESET_TASKS shape asserted above. Keys now come from
// one POST /tasks/reserve call (C1482), not a locally-guessed "C{n}" sequence — the
// mock hands back keys in the same C1..C5 shape so the rest of the assertions read
// the same way, but the production code path no longer computes them itself.
test('seedPresetTasks reserves keys then PATCHes the resolved dependencies and priorities for original-specification', async (t) => {
  const http = require('./http');
  const reserveCalls = [];
  const patches = [];
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (opts.method === 'POST' && url.endsWith('/tasks/reserve')) {
      reserveCalls.push(JSON.parse(JSON.stringify(opts.body)));
      const count = opts.body.count;
      const tasks = Array.from({ length: count }, (_, i) => ({ task_key: `C${i + 1}` }));
      return { status: 201, data: { tasks } };
    }
    if (opts.method === 'PATCH') {
      const m = url.match(/\/tasks\/([^/]+)$/);
      patches.push({ task_key: decodeURIComponent(m[1]), ...JSON.parse(JSON.stringify(opts.body)) });
      return { status: 200, data: { id: 1 } };
    }
    return { status: 200, data: { tasks: [] } };
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  try {
    await fresh.seedPresetTasks('original-specification', {
      apiBaseUrl: 'http://example.invalid',
      token: 'test-token',
      projectId: 1,
      // no projectRoot — skips applyPresetTemplate, so no filesystem writes
    });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }

  assert.equal(reserveCalls.length, 1);
  assert.deepEqual(reserveCalls[0], { count: 5, category: 'CODING', priority: 0 });

  assert.equal(patches.length, 5);
  assert.deepEqual(patches.map(p => p.task_key), ['C1', 'C2', 'C3', 'C4', 'C5']);
  assert.deepEqual(patches.map(p => p.priority), [1, 2, 2, 2, 3]);
  assert.deepEqual(patches[0].dependencies, []);
  assert.deepEqual(patches[1].dependencies, ['C1']);
  assert.deepEqual(patches[2].dependencies, ['C1']);
  assert.deepEqual(patches[3].dependencies, ['C1']);
  assert.deepEqual(patches[4].dependencies, ['C1', 'C2', 'C3', 'C4']);
  assert.equal(patches[4].title, 'Choose tech stack');
});

test('seedPresetTasks fails the whole preset (no PATCHes) when key reservation itself fails', async (t) => {
  const http = require('./http');
  const patches = [];
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (opts.method === 'POST' && url.endsWith('/tasks/reserve')) {
      return { status: 404, data: { error: 'Not found' } };
    }
    if (opts.method === 'PATCH') patches.push(opts.body);
    return { status: 200, data: { tasks: [] } };
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.seedPresetTasks('original-specification', {
      apiBaseUrl: 'http://example.invalid',
      token: 'test-token',
      projectId: 1,
    });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }

  assert.deepEqual(result, { seeded: 0, failed: 5 });
  assert.equal(patches.length, 0, 'no PATCH should fire when reservation itself failed');
});

test('every original-specification and existing-code description fits under MAX_DESC_LEN — guards against silent Start-prompt truncation (C1096)', () => {
  for (const [title, description] of [...specDefs, ...existingCodeDefs]) {
    assert.ok(
      description.length < MAX_DESC_LEN,
      `"${title}" description is ${description.length} chars, MAX_DESC_LEN is ${MAX_DESC_LEN}`
    );
  }
});

// TPT203: the lower bound that pairs with the MAX_DESC_LEN test above. A def with a blank or
// stub body seeds a task no agent can start — it needs the what/where/how-to-verify text inline.
const MIN_PRESET_DESC_LEN = 200;

test('every preset def is startable: non-empty title and a description over 200 chars (TPT203)', () => {
  for (const [preset, defs] of Object.entries(PRESET_TASKS)) {
    for (const [title, description] of defs) {
      assert.ok(typeof title === 'string' && title.trim().length > 0, `${preset}: a def has an empty title`);
      assert.ok(typeof description === 'string' && description.trim().length > 0, `${preset} "${title}" has an empty description`);
      assert.ok(
        description.trim().length > MIN_PRESET_DESC_LEN,
        `${preset} "${title}" description is only ${description.trim().length} chars, needs more than ${MIN_PRESET_DESC_LEN}`
      );
    }
  }
});

test('every preset def has a numeric priority and only in-range dependsOn indexes (TPT203)', () => {
  for (const [preset, defs] of Object.entries(PRESET_TASKS)) {
    defs.forEach(([title, , extra = {}], i) => {
      assert.ok(Number.isFinite(extra.priority), `${preset} "${title}" has no numeric priority`);
      for (const idx of extra.dependsOn ?? []) {
        assert.ok(Number.isInteger(idx) && idx >= 0 && idx < defs.length, `${preset} "${title}" dependsOn index ${idx} is out of range`);
        assert.notEqual(idx, i, `${preset} "${title}" depends on itself`);
      }
    });
  }
});

test('finalizeBodyError rejects every shape that would PATCH a blank task, and passes a complete body (TPT203)', () => {
  const ok = { title: 'T', description: 'body', status: 'pending', priority: 1 };
  assert.equal(finalizeBodyError(ok), null);
  assert.equal(finalizeBodyError({ ...ok, title: '   ' }), 'title is empty');
  assert.equal(finalizeBodyError({ ...ok, title: undefined }), 'title is empty');
  assert.equal(finalizeBodyError({ ...ok, description: '' }), 'description is empty');
  assert.equal(finalizeBodyError({ ...ok, description: '  \n ' }), 'description is empty');
  assert.equal(finalizeBodyError({ ...ok, description: null }), 'description is empty');
  assert.equal(finalizeBodyError({ ...ok, status: '' }), 'status is missing');
  assert.equal(finalizeBodyError({ ...ok, priority: NaN }), 'priority is not a number');
  assert.equal(finalizeBodyError({ ...ok, priority: '2' }), 'priority is not a number');
});

test('describePresetSeedProblem reports a partial or thrown seed and stays silent on a clean one (TPT203)', () => {
  assert.equal(describePresetSeedProblem({ seeded: 5, failed: 0 }), null);
  assert.equal(describePresetSeedProblem(null), null);
  assert.equal(describePresetSeedProblem(undefined), null);
  assert.equal(describePresetSeedProblem({ seeded: 3, failed: 2 }), '2 of 5 preset task(s) could not be seeded.');
  assert.equal(describePresetSeedProblem({ seeded: 0, failed: 7 }), '7 of 7 preset task(s) could not be seeded.');
  assert.equal(
    describePresetSeedProblem({ seeded: 0, failed: null, error: 'ECONNREFUSED' }),
    'Preset task seeding failed: ECONNREFUSED'
  );
});

test('callSeedPresetTasks (wizard seeder) hands the seed outcome back instead of swallowing it (TPT203)', async () => {
  const { callSeedPresetTasks } = require('../server/project-seeder');
  // An unknown preset short-circuits inside seedPresetTasks with { seeded: 0, failed: 0 } and
  // touches no network — proves the result is returned, not discarded.
  assert.deepEqual(await callSeedPresetTasks('no-such-preset', {}), { seeded: 0, failed: 0 });
});

test('CODE_SCAN_TASK_DESCRIPTION embeds the inspection task body verbatim and names all four spec titles', () => {
  assert.ok(CODE_SCAN_TASK_DESCRIPTION.includes(inspectionTaskBody('<folder>')));
  for (const title of ORIGINAL_SPEC_STARTER_TITLES) {
    assert.ok(CODE_SCAN_TASK_DESCRIPTION.includes(title), `missing spec title "${title}"`);
  }
});

test('code-scan skip list excludes Tipatask-owned directories', () => {
  for (const dir of ['ai', '.tipatask', '.claude', '.codex']) {
    assert.ok(
      CODE_SCAN_TASK_DESCRIPTION.includes(dir),
      `skip list missing Tipatask-owned dir "${dir}"`
    );
  }
});

test('inspectionTaskBody substitutes every <folder> placeholder', () => {
  const body = inspectionTaskBody('server');
  assert.ok(!body.includes('<folder>'), 'literal <folder> placeholder left unsubstituted');
  const occurrences = body.split('server').length - 1;
  assert.ok(occurrences >= 5, `expected "server" interpolated >= 5 times, got ${occurrences}`);
});

test('BACKLOG_BLOCK uses the preset-a-backlog tag sentinel, not the old task-count heuristic (D1 regression)', () => {
  assert.ok(BACKLOG_BLOCK.includes('preset-a-backlog'));
  assert.ok(!BACKLOG_BLOCK.includes('implementation tasks beyond these four starter tasks'));
});

test('BACKLOG_BLOCK requires backlog tasks to depend on the inspection tasks', () => {
  assert.ok(BACKLOG_BLOCK.includes('Inspect existing code'));
  assert.ok(BACKLOG_BLOCK.includes('dependencies'));
});

// C1142: BACKLOG_BLOCK (ex-COMPLETION_GATE_BLOCK) is pinned to 'Choose tech stack' only —
// it is last by dependency now, not by a finish-order race — so the other three research
// tasks must not carry it.
test('BACKLOG_BLOCK lives only on Choose tech stack, not on the other three spec tasks', () => {
  for (const [title, description] of specDefs.slice(1, 4)) {
    assert.ok(!description.includes(BACKLOG_BLOCK), `"${title}" should not carry BACKLOG_BLOCK`);
  }
  const [, techStackDescription] = specDefs[4];
  assert.ok(techStackDescription.includes(BACKLOG_BLOCK));
});

test('discoveryBlock no longer unconditionally claims the project is greenfield, and points at Existing Code (D2 regression)', () => {
  const block = discoveryBlock([]);
  assert.ok(!block.includes('This is a greenfield project — there is no code to read'));
  assert.ok(block.includes('Existing Code'));
});

test('the three research spec tasks have unique, sequential step numbers 1-3 (no gate)', () => {
  for (const [title, description] of specDefs.slice(1, 4)) {
    const steps = [...description.matchAll(/^(\d+)\. [A-Z]/gm)].map(m => parseInt(m[1], 10));
    assert.deepEqual(steps, [1, 2, 3], `"${title}" step numbers`);
  }
});

test('Choose tech stack has unique, sequential step numbers 1-4 (ends in BACKLOG_BLOCK)', () => {
  const [title, description] = specDefs[4];
  const steps = [...description.matchAll(/^(\d+)\. [A-Z]/gm)].map(m => parseInt(m[1], 10));
  assert.deepEqual(steps, [1, 2, 3, 4], `"${title}" step numbers`);
});

// ── C1096: existing-code (preset B) pipeline ──

test('existing-code has 7 entries: map task, then profile task, then sprint-2 docs/KB tasks', () => {
  assert.equal(existingCodeDefs.length, 7);
  assert.equal(existingCodeDefs[0][0], EXISTING_CODE_MAP_TASK_TITLE);
  assert.equal(existingCodeDefs[1][0], 'Profile the project with the user');
});

test('sprint-1 tasks (map, profile) seed at priority 1; profile depends on map', () => {
  const [, , mapExtra] = existingCodeDefs[0];
  const [, , profileExtra] = existingCodeDefs[1];
  assert.equal(mapExtra.priority, 1);
  assert.deepEqual(mapExtra.dependsOn ?? [], []);
  assert.equal(profileExtra.priority, 1);
  assert.deepEqual(profileExtra.dependsOn, [0]);
});

test('sprint-2 tasks (4 docs + KB) seed at priority 2, depending on map + profile', () => {
  for (let i = 2; i <= 6; i++) {
    const [, , extra] = existingCodeDefs[i];
    assert.equal(extra.priority, 2, `entry ${i} priority`);
    assert.deepEqual(extra.dependsOn, [0, 1], `entry ${i} dependsOn`);
  }
});

test('the four doc task titles match EXISTING_CODE_DOC_TITLES in order (gate matches by title)', () => {
  const titles = existingCodeDefs.slice(2, 6).map(([title]) => title);
  assert.deepEqual(titles, EXISTING_CODE_DOC_TITLES);
});

test('EXISTING_CODE_SPRINT2_TITLES lists the 4 doc titles plus the KB task title, in seed order', () => {
  const titles = existingCodeDefs.slice(2).map(([title]) => title);
  assert.deepEqual(titles, EXISTING_CODE_SPRINT2_TITLES);
});

test('EXISTING_CODE_MAP_TASK_DESCRIPTION embeds the inspection body verbatim and names every sprint-2 title', () => {
  assert.ok(EXISTING_CODE_MAP_TASK_DESCRIPTION.includes(existingCodeInspectionBody('<folder>')));
  for (const title of EXISTING_CODE_SPRINT2_TITLES) {
    assert.ok(EXISTING_CODE_MAP_TASK_DESCRIPTION.includes(title), `missing sprint-2 title "${title}"`);
  }
});

test('existingCodeInspectionBody substitutes every <folder> placeholder', () => {
  const body = existingCodeInspectionBody('server');
  assert.ok(!body.includes('<folder>'), 'literal <folder> placeholder left unsubstituted');
  const occurrences = body.split('server').length - 1;
  assert.ok(occurrences >= 5, `expected "server" interpolated >= 5 times, got ${occurrences}`);
});

test('EXISTING_CODE_PROFILE_TASK_DESCRIPTION offers all three conditional tracks and points at Recommended Tracks', () => {
  for (const track of ['legacy', 'frontend', 'backend']) {
    assert.ok(EXISTING_CODE_PROFILE_TASK_DESCRIPTION.includes(`\`${track}\``), `missing track "${track}"`);
  }
  assert.ok(EXISTING_CODE_PROFILE_TASK_DESCRIPTION.includes('Recommended Tracks'));
});

test('EXISTING_CODE_GATE_BLOCK uses the preset-b-backlog sentinel and requires backlog deps on the inspection tasks', () => {
  assert.ok(EXISTING_CODE_GATE_BLOCK.includes('preset-b-backlog'));
  assert.ok(EXISTING_CODE_GATE_BLOCK.includes('Inspect existing code'));
  assert.ok(EXISTING_CODE_GATE_BLOCK.includes('dependencies'));
  for (const title of EXISTING_CODE_DOC_TITLES) {
    assert.ok(EXISTING_CODE_GATE_BLOCK.includes(title), `gate missing doc title "${title}"`);
  }
});

test('CONDITIONAL_TRACKS retains the substance of the removed legacy/frontend/backend presets (C1102 regression guard)', () => {
  assert.deepEqual(Object.keys(CONDITIONAL_TRACKS).sort(), ['backend', 'frontend', 'legacy']);
  assert.equal(CONDITIONAL_TRACKS.legacy.length, 3);
  assert.equal(CONDITIONAL_TRACKS.frontend.length, 3);
  assert.equal(CONDITIONAL_TRACKS.backend.length, 3);
  const allTitles = [
    ...CONDITIONAL_TRACKS.legacy, ...CONDITIONAL_TRACKS.frontend, ...CONDITIONAL_TRACKS.backend,
  ].map(([title]) => title);
  for (const title of [
    'Document legacy API surface', 'Identify tech debt hotspots', 'Plan modernisation approach',
    'Inventory frontend components and routes', 'Define API contract requirements', 'Plan state management approach',
    'Map existing API endpoints', 'Design frontend integration layer', 'Define auth and session strategy',
  ]) {
    assert.ok(allTitles.includes(title), `missing retained track item "${title}"`);
  }
});

test('each existing-code doc task description has unique, sequential step numbers 1-4', () => {
  for (const [title, description] of existingCodeDefs.slice(2, 6)) {
    const steps = [...description.matchAll(/^(\d+)\. [A-Z]/gm)].map(m => parseInt(m[1], 10));
    assert.deepEqual(steps, [1, 2, 3, 4], `"${title}" step numbers`);
  }
});

// ── C1482: seedSyncTasks routed through reservation instead of a bare, unkeyed POST ──
// (the pre-C1482 POST with no task_key at all 400'd against validateTask's
// "task_key is required" and was silently swallowed into a YELLOW log line).

test('seedSyncTasks reserves exactly as many keys as it needs and PATCHes each into place', async (t) => {
  const http = require('./http');
  const reserveCalls = [];
  const patches = [];
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') return { status: 200, data: { tasks: [] } };
    if (opts.method === 'POST' && url.endsWith('/tasks/reserve')) {
      reserveCalls.push(JSON.parse(JSON.stringify(opts.body)));
      const count = opts.body.count;
      const tasks = Array.from({ length: count }, (_, i) => ({ task_key: `C${i + 1}` }));
      return { status: 201, data: { tasks } };
    }
    if (opts.method === 'PATCH') {
      const m = url.match(/\/tasks\/([^/]+)$/);
      patches.push({ task_key: decodeURIComponent(m[1]), ...JSON.parse(JSON.stringify(opts.body)) });
      return { status: 200, data: { id: 1 } };
    }
    return { status: 200, data: { tasks: [] } };
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.seedSyncTasks({
      apiBaseUrl: 'http://example.invalid',
      token: 'test-token',
      projectId: 1,
    });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }

  assert.deepEqual(result, { seeded: 2, skipped: 0 });
  assert.deepEqual(reserveCalls, [{ count: 2, category: 'CODING', priority: 0 }]);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map(p => p.task_key), ['C1', 'C2']);
  assert.ok(patches[0].title && patches[1].title, 'each PATCH carries a real title, not an unkeyed create');
});

test('seedSyncTasks skips titles that already exist and reserves only for the remainder', async (t) => {
  const http = require('./http');
  const reserveCalls = [];
  const patches = [];
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') {
      return { status: 200, data: { tasks: [{ title: 'Verify AVAILABLE_AGENTS consistency across project devices', category: 'CODING', status: 'pending', priority: 1 }] } };
    }
    if (opts.method === 'POST' && url.endsWith('/tasks/reserve')) {
      reserveCalls.push(JSON.parse(JSON.stringify(opts.body)));
      return { status: 201, data: { tasks: [{ task_key: 'C7' }] } };
    }
    if (opts.method === 'PATCH') {
      patches.push(JSON.parse(JSON.stringify(opts.body)));
      return { status: 200, data: { id: 1 } };
    }
    return { status: 200, data: { tasks: [] } };
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.seedSyncTasks({
      apiBaseUrl: 'http://example.invalid',
      token: 'test-token',
      projectId: 1,
    });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }

  assert.deepEqual(result, { seeded: 1, skipped: 1 });
  assert.deepEqual(reserveCalls, [{ count: 1, category: 'CODING', priority: 0 }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].title, 'Push local KB to API after agent config sync');
});

// ── C1482: runSeedSetupTasks (MCP-client path) reserves keys then finalizes via
// update_task — never create_task, which would 409 against the placeholder row the
// reservation already inserted. Mocks ./mcp-client's spawnMcpClient() instead of HTTP.

test('runSeedSetupTasks reserves 3 CODING keys via MCP and finalizes each with update_task, not create_task', async (t) => {
  const mcpClientModule = require('./mcp-client');
  const http = require('./http');
  const calls = [];
  const events = [];
  const fakeClient = {
    async callTool(name, args) {
      calls.push({ name, args });
      events.push(name);
      if (name === 'list_tasks') return { project_id: 1, tasks: [] };
      if (name === 'reserve_task_keys') {
        return { project_id: 1, category: args.category, keys: ['C1', 'C2', 'C3'] };
      }
      if (name === 'update_task') return { project_id: 1, task: { id: args.task_key } };
      if (name === 'get_task') return { project_id: 1, task: { id: args.task_key, isReservation: false } };
      throw new Error(`unexpected tool call in test: ${name}`);
    },
    async close() {},
  };
  t.mock.method(mcpClientModule, 'spawnMcpClient', async () => fakeClient);
  // TPT200: the seeder now pre-registers its tags over HTTP — stub the registry so this test
  // never touches the network. A fresh project only has the default action tags.
  const tagPosts = [];
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (url.endsWith('/tags') && opts.method === 'GET') {
      return { status: 200, data: { tags: [{ name: 'feature' }, { name: 'config' }] } };
    }
    if (url.endsWith('/tags') && opts.method === 'POST') {
      events.push('POST /tags');
      tagPosts.push(opts.body);
      return { status: 200, data: { tags: opts.body.tags.map(x => ({ name: x.name })) } };
    }
    throw new Error(`unexpected http call in test: ${opts.method} ${url}`);
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.runSeedSetupTasks({ projectRoot: '/tmp/does-not-matter', apiBaseUrl: 'http://example.invalid', token: 't', projectId: 1 });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }

  assert.deepEqual(result, { seeded: 3, failed: 0 });

  const reserveCall = calls.find(c => c.name === 'reserve_task_keys');
  assert.ok(reserveCall, 'reserve_task_keys must be called');
  assert.deepEqual(reserveCall.args, { count: 3, category: 'CODING' });

  const createCalls = calls.filter(c => c.name === 'create_task');
  assert.deepEqual(createCalls, [], 'create_task must never be called against a reserved placeholder — it would 409');

  const updateCalls = calls.filter(c => c.name === 'update_task');
  assert.equal(updateCalls.length, 3);
  assert.deepEqual(updateCalls.map(c => c.args.task_key), ['C1', 'C2', 'C3']);
  for (const c of updateCalls) {
    assert.ok(c.args.title, 'each update_task call must carry a real title');
    assert.equal(c.args.status, 'pending');
  }

  // TPT200: tags are registered BEFORE the first finalize — an unregistered tag 400s the
  // whole update_task and strands the reserved key blank.
  assert.ok(events.indexOf('POST /tags') !== -1, 'missing tags must be registered');
  assert.ok(events.indexOf('POST /tags') < events.indexOf('update_task'), 'tags must be registered before the first update_task');
  const posted = tagPosts.flatMap(b => b.tags.map(x => x.name)).sort();
  assert.deepEqual(posted, ['db-schema', 'tt-cli-setup', 'tt-config'], 'only the missing tags are POSTed — feature/config already exist');
  for (const c of updateCalls) {
    assert.ok(c.args.tags.length > 0, 'registered tags stay on the finalize');
  }
});

// ── TPT200: a finalize PATCH that names an unregistered tag 400s as a whole (the API
// validates tags before any write, C951), so the preset's title/description/priority were
// discarded and every reserved key stayed a blank is_reservation placeholder. The seeders
// now register their tags first, assert each body is complete, and verify the echoed row. ──

const DEFAULT_PROJECT_TAGS = ['feature', 'bugfix', 'refactor', 'migration', 'config', 'security', 'css'];

// One stubbed Tipatask API for seedPresetTasks. `hooks` override only what a case cares about:
//   getTags()            -> response for GET  /tags
//   postTags(body)       -> response for POST /tags
//   patch(key, body, n)  -> response for the n-th (0-based) PATCH; return undefined for default
// Default PATCH answer mirrors the real route: 200 { task: <finalized row> }.
async function runPreset(t, preset, hooks = {}) {
  const http = require('./http');
  const rec = { events: [], reserve: [], tagPosts: [], patches: [], out: [] };
  t.mock.method(console, 'log', (...a) => { rec.out.push(a.join(' ')); });
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (url.endsWith('/tags') && opts.method === 'GET') {
      rec.events.push('GET /tags');
      return hooks.getTags ? hooks.getTags() : { status: 200, data: { tags: DEFAULT_PROJECT_TAGS.map(name => ({ name })) } };
    }
    if (url.endsWith('/tags') && opts.method === 'POST') {
      rec.events.push('POST /tags');
      rec.tagPosts.push(JSON.parse(JSON.stringify(opts.body)));
      return hooks.postTags ? hooks.postTags(opts.body) : { status: 200, data: { tags: opts.body.tags.map(x => ({ name: x.name })) } };
    }
    if (opts.method === 'POST' && url.endsWith('/tasks/reserve')) {
      rec.events.push('RESERVE');
      rec.reserve.push(opts.body);
      return { status: 201, data: { tasks: Array.from({ length: opts.body.count }, (_, i) => ({ task_key: `C${i + 1}` })) } };
    }
    if (opts.method === 'PATCH') {
      rec.events.push('PATCH');
      const key = decodeURIComponent(url.match(/\/tasks\/([^/]+)$/)[1]);
      const body = JSON.parse(JSON.stringify(opts.body));
      const n = rec.patches.length;
      rec.patches.push({ task_key: key, ...body });
      const custom = hooks.patch && hooks.patch(key, body, n);
      if (custom) return custom;
      return { status: 200, data: { task: { task_key: key, title: body.title, description: body.description, is_reservation: 0, tags: body.tags } } };
    }
    throw new Error(`unexpected http call in test: ${opts.method} ${url}`);
  });

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  try {
    if (hooks.mutate) hooks.mutate(fresh);
    rec.result = await fresh.seedPresetTasks(preset, { apiBaseUrl: 'http://example.invalid', token: 't', projectId: 1 });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }
  return rec;
}

function tagsOnSeededTasks() {
  const names = new Set();
  for (const defs of Object.values(PRESET_TASKS)) {
    for (const [, , extra = {}] of defs) for (const n of extra.tags || []) names.add(n);
  }
  const { buildAgentInstructionTask, buildGeneralMdTask, buildAuditAiIdeConfigTask } = require('./seed-setup-tasks');
  for (const b of [buildAgentInstructionTask, buildGeneralMdTask, buildAuditAiIdeConfigTask]) {
    for (const n of b('/tmp/x', 1).tags) names.add(n);
  }
  return [...names].sort();
}

test('SEED_TAG_DESCRIPTIONS covers every tag any seeder puts on a task, each with a real description', () => {
  const { SEED_TAG_DESCRIPTIONS } = require('./seed-setup-tasks');
  for (const name of tagsOnSeededTasks()) {
    const d = SEED_TAG_DESCRIPTIONS[name];
    assert.ok(d && d.trim().length > 0, `tag "${name}" is put on a seeded task but has no SEED_TAG_DESCRIPTIONS entry — its finalize would 400`);
  }
  for (const [name, d] of Object.entries(SEED_TAG_DESCRIPTIONS)) {
    assert.ok(d.length <= 500, `${name} description exceeds the API's 500-char cap`);
    assert.ok(!/^auto-registered\b/i.test(d), `${name} description looks like a C1038 placeholder — POST /tags would reject it`);
  }
});

test('seedPresetTasks registers the missing tags before reserving keys or PATCHing, and never re-POSTs tags that already exist', async (t) => {
  const rec = await runPreset(t, 'original-specification');

  assert.ok(rec.events.indexOf('POST /tags') !== -1, 'a fresh project is missing existing-code/discovery/research/tt-* — they must be registered');
  assert.ok(rec.events.indexOf('POST /tags') < rec.events.indexOf('RESERVE'), 'register before reserving, so a failure never strands reserved keys');
  assert.ok(rec.events.indexOf('POST /tags') < rec.events.indexOf('PATCH'));

  const posted = rec.tagPosts.flatMap(b => b.tags);
  assert.deepEqual(posted.map(x => x.name).sort(), ['discovery', 'existing-code', 'research', 'tt-project-creation-wizard']);
  for (const x of posted) {
    assert.ok(x.description.trim().length > 0);
    assert.ok(!/^auto-registered\b/i.test(x.description));
  }
  // `feature` is a default tag — POSTing it would overwrite its seeded description.
  assert.ok(!posted.some(x => x.name === 'feature'), 'existing tags must not be re-POSTed');
  assert.deepEqual(rec.result, { seeded: 5, failed: 0 });
});

test('seedPresetTasks skips POST /tags entirely when every tag is already registered', async (t) => {
  const all = tagsOnSeededTasks();
  const rec = await runPreset(t, 'original-specification', {
    getTags: () => ({ status: 200, data: { tags: all.map(name => ({ name })) } }),
  });
  assert.equal(rec.tagPosts.length, 0);
  assert.deepEqual(rec.result, { seeded: 5, failed: 0 });
});

for (const preset of ['original-specification', 'existing-code']) {
  test(`every ${preset} PATCH carries title + full description + status + priority from PRESET_TASKS`, async (t) => {
    const rec = await runPreset(t, preset);
    const defs = PRESET_TASKS[preset];

    assert.equal(rec.patches.length, defs.length);
    assert.deepEqual(rec.result, { seeded: defs.length, failed: 0 });
    defs.forEach(([title, description, extra = {}], i) => {
      const p = rec.patches[i];
      assert.equal(p.title, title);
      assert.equal(p.description, description, `"${title}" must PATCH its full description, not a truncated/blank one`);
      assert.ok(p.description.trim().length > 0);
      assert.equal(p.status, 'pending');
      assert.equal(p.priority, extra.priority ?? 1);
      assert.equal(p.category, 'CODING');
    });
  });
}

test('a tag that could not be registered is dropped from the PATCH but the task still finalizes with its content', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    postTags: () => ({ status: 400, data: { error: 'description is required' } }),
  });
  assert.deepEqual(rec.result, { seeded: 5, failed: 0 });
  assert.equal(rec.patches.length, 5, 'a failed tag registration must not stop any PATCH');
  const sent = new Set(rec.patches.flatMap(p => p.tags));
  for (const n of ['existing-code', 'discovery', 'research', 'tt-project-creation-wizard']) {
    assert.ok(!sent.has(n), `unregistered tag "${n}" must never reach a PATCH — it would 400 the whole finalize`);
  }
  assert.ok(sent.has('feature'), 'tags that ARE registered are kept');
  assert.ok(rec.patches.every(p => p.title && p.description));
});

test('when the tag registry cannot be read at all, tags are sent unfiltered rather than every tag being dropped', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    getTags: () => ({ status: 500, data: { error: 'boom' } }),
  });
  assert.equal(rec.tagPosts.length, 0, 'nothing to diff against, so nothing is POSTed');
  assert.deepEqual(rec.patches[1].tags, ['tt-project-creation-wizard', 'feature', 'discovery']);
  assert.deepEqual(rec.result, { seeded: 5, failed: 0 });
});

test('a PATCH answering 400 with `missing` tags is retried exactly once without tags, and the content lands', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    // registry says everything is known, then the API disagrees for the 2nd task only
    getTags: () => ({ status: 200, data: { tags: tagsOnSeededTasks().map(name => ({ name })) } }),
    patch: (key, body) => {
      if (key === 'C2' && body.tags.length > 0) {
        return { status: 400, data: { error: 'tags not registered', missing: ['discovery'] } };
      }
    },
  });
  const c2 = rec.patches.filter(p => p.task_key === 'C2');
  assert.equal(c2.length, 2, 'exactly one retry');
  assert.ok(c2[0].tags.length > 0);
  assert.deepEqual(c2[1].tags, [], 'the retry drops the tags');
  assert.equal(c2[1].title, c2[0].title);
  assert.equal(c2[1].description, c2[0].description, 'retry must carry the full description');
  assert.deepEqual(rec.result, { seeded: 5, failed: 0 });
});

test('a PATCH whose response is still flagged is_reservation is a hard error: counted failed, key reported', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    patch: (key, body) => key === 'C3'
      ? { status: 200, data: { task: { task_key: key, title: 'New task', description: 'Reserved key — pending finalization.', is_reservation: 1 } } }
      : undefined,
  });
  assert.deepEqual(rec.result, { seeded: 4, failed: 1 });
  const text = rec.out.join('\n');
  assert.match(text, /Failed to seed .*\(C3\).*is_reservation/);
  assert.match(text, /left as blank placeholders: C3/);
});

test('a PATCH response that lost the description is a hard error even when is_reservation is cleared', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    patch: (key, body) => key === 'C1'
      ? { status: 200, data: { task: { task_key: key, title: body.title, description: null, is_reservation: 0 } } }
      : undefined,
  });
  assert.deepEqual(rec.result, { seeded: 4, failed: 1 });
  assert.match(rec.out.join('\n'), /no description/);
});

test('a def edited into an incomplete shape is refused before any PATCH is sent, never PATCHed blank', async (t) => {
  const rec = await runPreset(t, 'original-specification', {
    mutate: (mod) => { mod.PRESET_TASKS['original-specification'][2][1] = '   '; },
  });
  assert.equal(rec.patches.length, 4, 'the incomplete def must not be PATCHed');
  assert.ok(!rec.patches.some(p => p.task_key === 'C3'));
  assert.deepEqual(rec.result, { seeded: 4, failed: 1 });
  assert.match(rec.out.join('\n'), /refusing to PATCH an incomplete body: description is empty/);
});

test('a still-reservation row after update_task fails the setup task (MCP path read-back)', async (t) => {
  const mcpClientModule = require('./mcp-client');
  const http = require('./http');
  t.mock.method(console, 'log', () => {});
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (url.endsWith('/tags') && opts.method === 'GET') return { status: 200, data: { tags: tagsOnSeededTasks().map(name => ({ name })) } };
    throw new Error(`unexpected http call: ${opts.method} ${url}`);
  });
  const fakeClient = {
    async callTool(name, args) {
      if (name === 'list_tasks') return { project_id: 1, tasks: [] };
      if (name === 'reserve_task_keys') return { project_id: 1, keys: ['C1', 'C2', 'C3'] };
      if (name === 'update_task') return { project_id: 1, task: { id: args.task_key } };
      if (name === 'get_task') return { project_id: 1, task: { id: args.task_key, isReservation: args.task_key === 'C2' } };
      throw new Error(`unexpected tool call: ${name}`);
    },
    async close() {},
  };
  t.mock.method(mcpClientModule, 'spawnMcpClient', async () => fakeClient);

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.runSeedSetupTasks({ projectRoot: '/tmp/x', apiBaseUrl: 'http://example.invalid', token: 't', projectId: 1 });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }
  assert.deepEqual(result, { seeded: 2, failed: 1 });
});

test('runSeedSetupTasks retries update_task once without tags when the API rejects a tag as not registered', async (t) => {
  const mcpClientModule = require('./mcp-client');
  const http = require('./http');
  t.mock.method(console, 'log', () => {});
  t.mock.method(http, 'request', async (url, opts = {}) => {
    if (url.endsWith('/tags') && opts.method === 'GET') return { status: 200, data: { tags: tagsOnSeededTasks().map(name => ({ name })) } };
    throw new Error(`unexpected http call: ${opts.method} ${url}`);
  });
  const updates = [];
  const fakeClient = {
    async callTool(name, args) {
      if (name === 'list_tasks') return { project_id: 1, tasks: [] };
      if (name === 'reserve_task_keys') return { project_id: 1, keys: ['C1', 'C2', 'C3'] };
      if (name === 'update_task') {
        updates.push(args);
        if (args.task_key === 'C1' && args.tags.length > 0) throw new Error('tags not registered, register them first via POST /tags with a description: feature');
        return { project_id: 1, task: { id: args.task_key } };
      }
      if (name === 'get_task') return { project_id: 1, task: { id: args.task_key, isReservation: false } };
      throw new Error(`unexpected tool call: ${name}`);
    },
    async close() {},
  };
  t.mock.method(mcpClientModule, 'spawnMcpClient', async () => fakeClient);

  delete require.cache[require.resolve('./seed-setup-tasks')];
  const fresh = require('./seed-setup-tasks');
  let result;
  try {
    result = await fresh.runSeedSetupTasks({ projectRoot: '/tmp/x', apiBaseUrl: 'http://example.invalid', token: 't', projectId: 1 });
  } finally {
    delete require.cache[require.resolve('./seed-setup-tasks')];
  }
  const c1 = updates.filter(u => u.task_key === 'C1');
  assert.equal(c1.length, 2);
  assert.deepEqual(c1[1].tags, []);
  assert.equal(c1[1].title, c1[0].title);
  assert.equal(c1[1].description, c1[0].description);
  assert.deepEqual(result, { seeded: 3, failed: 0 });
});
