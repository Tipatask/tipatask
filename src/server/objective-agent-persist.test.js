'use strict';

// Real-transport lock for the objective-chat SAVE path: a proposal card's agent pin
// (agentAssignee + per-agent model + design mode) must reach the API on the wire.
//
// The chain under test is chat-task-preview.js -> PUT /api/todo -> overwriteRawWithRemap ->
// overwriteRaw -> updateTask/_rawUpdateTask (reservation finalize, the normal path) or
// createTask/toApi (direct-create fallback). NOTHING in that chain names these fields in a
// whitelist until the very last hop, so they survive only because the intermediate layers are
// field-transparent. A future "pick the fields we know" refactor anywhere upstream of
// _rawUpdateTask/toApi would drop the pin silently — this file is what fails when it does.
//
// Drives the genuine backend against a throwaway fake HTTP server (same harness shape as
// api-backend-origin-spec.test.js). Never touches port 4455 or production (web.tipatask.com).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// writeProjectConfig() routes API_TOKEN into the account store under TIPATASK_USER_DATA.
// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-agent-persist-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-agent-persist-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Records every write body. `state.liveRows` is what GET /tasks returns (raw snake_case API
// rows). Anything the chain requests that isn't listed here 404s and lands in state.unexpected,
// so a new hidden round trip shows up as a test failure rather than a silent pass.
function makeServer(state) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        return send(200, { user: { id: 7 } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') {
        return send(200, { tags: [] });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') {
        return send(200, { tasks: state.liveRows });
      }
      const patchMatch = pathname.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/);
      if (req.method === 'PATCH' && patchMatch) {
        const parsed = JSON.parse(body);
        state.patches.push({ key: patchMatch[1], body: parsed });
        return send(200, { task: { id: 1, project_id: 1, task_key: patchMatch[1], ...parsed } });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        const parsed = JSON.parse(body);
        state.posts.push(parsed);
        return send(201, { task: { id: 2, project_id: 1, ...parsed } });
      }
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  };
}

function baseState(liveRows) {
  return { liveRows, patches: [], posts: [], unexpected: [] };
}

// A live, unfinalized reserve_task_keys row — what the planner's reserved key looks like
// server-side until the objective is saved (is_reservation is the C1017 primary signal).
function reservationRow(taskKey) {
  return {
    id: 10,
    project_id: 1,
    task_key: taskKey,
    title: '',
    description: 'Reserved key — pending finalization.',
    category: 'CODING',
    status: 'pending',
    priority: 0,
    is_reservation: 1,
  };
}

// The `PUT /api/todo` body shape chat-task-preview.js builds: markdown wrapper around a JSON
// block, with `newTaskIds` naming the cards being created.
function todoBody(tasks, newTaskIds) {
  const data = { tasks };
  if (newTaskIds) data.newTaskIds = newTaskIds;
  return '# Tasks\n\n```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
}

function proposalTask(overrides) {
  return {
    id: 'C900',
    title: 'Proposed task',
    description: 'Do the thing',
    category: 'CODING',
    status: 'pending',
    priority: 1,
    order: 1,
    dependencies: [],
    tags: [],
    assignee: 7,
    ...overrides,
  };
}

const FULL_PIN = {
  agentAssignee: 'pi',
  piModel: 'anthropic/claude-sonnet-5',
  claudeModel: 'opus',
  codexModel: 'gpt-5',
  effort: 'high',
  claudeDesignMode: true,
};

test('objective save finalizing a reserved key PATCHes the proposal agent, models and design mode', async () => {
  const state = baseState([reservationRow('C900')]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    // overwriteRawWithRemap is the real entry point behind PUT /api/todo.
    const idRemap = await backend.overwriteRawWithRemap(todoBody([proposalTask(FULL_PIN)], ['C900']));

    assert.strictEqual(idRemap.size, 0, 'the planner\'s reserved key must be kept, not remapped');
    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 0, 'a live reservation is finalized in place, never re-created');
    assert.strictEqual(state.patches.length, 1);
    const { key, body } = state.patches[0];
    assert.strictEqual(key, 'C900');
    assert.strictEqual(body.agent_assignee, 'pi');
    assert.strictEqual(body.pi_model, 'anthropic/claude-sonnet-5');
    assert.strictEqual(body.claude_model, 'opus');
    assert.strictEqual(body.codex_model, 'gpt-5');
    assert.strictEqual(body.effort, 'high');
    assert.strictEqual(body.claude_design_mode, true);
  });
});

test('objective save of a card whose modal save stamped nulls forwards them as explicit clears', async () => {
  // template.html's onSavePreview writes a falsy model as null and a falsy design mode as
  // false onto every NEW card, so this is the shape a card carries after a modal round trip
  // that only picked an agent. The PATCH path must pass those through, not drop the agent.
  const state = baseState([reservationRow('C900')]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.overwriteRawWithRemap(todoBody([proposalTask({
      agentAssignee: 'claude', claudeModel: null, codexModel: null, piModel: null, effort: null, claudeDesignMode: false,
    })], ['C900']));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.patches.length, 1);
    const { body } = state.patches[0];
    assert.strictEqual(body.agent_assignee, 'claude');
    assert.strictEqual(body.claude_model, null);
    assert.strictEqual(body.codex_model, null);
    assert.strictEqual(body.pi_model, null);
    assert.strictEqual(body.effort, null);
    assert.strictEqual(body.claude_design_mode, false);
  });
});

test('objective save with no live placeholder row creates the task carrying the proposal agent + models', async () => {
  // Defensive fallback in overwriteRaw: id absent from the live list and not in newTaskIds.
  const state = baseState([]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.overwriteRaw(todoBody([proposalTask({ id: 'C901', ...FULL_PIN })]));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.patches.length, 0);
    assert.strictEqual(state.posts.length, 1);
    const body = state.posts[0];
    assert.strictEqual(body.task_key, 'C901');
    assert.strictEqual(body.agent_assignee, 'pi');
    assert.strictEqual(body.pi_model, 'anthropic/claude-sonnet-5');
    assert.strictEqual(body.claude_model, 'opus');
    assert.strictEqual(body.codex_model, 'gpt-5');
    assert.strictEqual(body.effort, 'high');
    assert.strictEqual(body.claude_design_mode, true);
  });
});

test('direct create keeps the agent but omits falsy models and design mode (inherit project defaults)', async () => {
  // toApi() sends model / design-mode keys only when truthy, so a plain new task carries no
  // defaulted override and inherits the project CLAUDE_MODEL/CODEX_MODEL at spawn. The agent
  // itself is always sent.
  const state = baseState([]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.overwriteRaw(todoBody([proposalTask({
      id: 'C902', agentAssignee: 'codex', claudeModel: null, codexModel: null, piModel: null, effort: null, claudeDesignMode: false,
    })]));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 1);
    const body = state.posts[0];
    assert.strictEqual(body.agent_assignee, 'codex');
    for (const k of ['claude_model', 'codex_model', 'pi_model', 'effort', 'claude_design_mode']) {
      assert.strictEqual(k in body, false, `${k} must be omitted, not sent as null/false`);
    }
  });
});

// (TPT285) Edit-modal Save path: persistDraft() PATCHes `effort` straight through
// api.tasks.update -> updateTask/_rawUpdateTask, and the returned row maps it back via fromApi().
test('updateTask forwards effort on the PATCH wire and maps it back on the returned row', async () => {
  const state = baseState([]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    const row = await backend.updateTask('C903', { effort: 'max' });
    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0].body.effort, 'max');
    assert.strictEqual(row.effort, 'max');

    await backend.updateTask('C903', { effort: '' });
    assert.strictEqual(state.patches[1].body.effort, null, "'' clears to null (inherit)");
  });
});

test('an effort-only change on a live task still PATCHes (effort is in DIFF_FIELDS)', async () => {
  const live = { ...reservationRow('C904'), is_reservation: 0, title: 'Proposed task', description: 'Do the thing', priority: 1, display_order: 1, assignee: 7, agent_assignee: 'claude', effort: null };
  const state = baseState([live]);
  await withFakeApiServer(makeServer(state), async (backend) => {
    // Every other DIFF_FIELDS value matches the live row, so without `effort` in DIFF_FIELDS
    // overwriteRaw would skip this task entirely (no PATCH).
    await backend.overwriteRaw(todoBody([proposalTask({ id: 'C904', agentAssignee: 'claude', claudeDesignMode: false, isObjective: false, effort: 'low' })]));
    // The live-task update path may re-read the single row; that GET isn't under test here.
    assert.deepStrictEqual(state.unexpected.filter(u => u !== 'GET /api/projects/1/tasks/C904'), []);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0].body.effort, 'low');
  });
});
