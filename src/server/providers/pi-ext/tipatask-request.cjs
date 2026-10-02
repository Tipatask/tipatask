'use strict';

// Request gate for the Pi `tipatask_api` tool (task-tools.mjs). Pi has no MCP, so a task chat
// reaches the Tipatask REST API through this one tool instead of a shell. Everything the model
// can ask for is checked here: the URL always stays under this project's API root, and only
// the listed method + path shapes pass. Pure — no network, no process.env reads of its own.
//
// Self-contained on purpose: both files in this directory are copied out of the app bundle
// (providers/pi-task-tools.js) and loaded by the Pi CLI, so they may only require Node built-ins.

const MAX_BODY_BYTES = 200 * 1024;

const SEGMENT = '[^/]+';
const RULES = [
  { method: 'GET', re: new RegExp(`^/tasks(/${SEGMENT}(/(comments|events))?)?$`) },
  { method: 'GET', re: /^\/(tags|members|sprints|statuses)$/ },
  { method: 'GET', re: new RegExp(`^/(images|files)/task/${SEGMENT}$`) },
  { method: 'GET', re: /^\/knowledge(\/.+)?$/ },
  { method: 'POST', re: /^\/tasks$/ },
  { method: 'POST', re: new RegExp(`^/tasks/${SEGMENT}/comments$`) },
  { method: 'POST', re: /^\/tags$/ },
  { method: 'PATCH', re: new RegExp(`^/tasks/${SEGMENT}$`) },
  { method: 'DELETE', re: new RegExp(`^/tasks/${SEGMENT}$`) },
];

const ALLOWED_SUMMARY = [
  'GET /tasks, /tasks/<KEY>, /tasks/<KEY>/comments, /tasks/<KEY>/events',
  'GET /tags, /members, /sprints, /statuses, /knowledge, /knowledge/<file_key>',
  'POST /tasks, /tasks/<KEY>/comments, /tags',
  'PATCH /tasks/<KEY>',
  'DELETE /tasks/<KEY>',
].join('; ');

function fail(error) {
  return { ok: false, error };
}

function resolveTipataskRequest(input, env) {
  const e = env || {};
  const base = String(e.API_BASE_URL || '').replace(/\/+$/, '');
  const projectId = String(e.API_PROJECT_ID || '');
  if (!base || !projectId || !e.API_TOKEN) {
    return fail('Tipatask API credentials are not available in this session.');
  }
  const method = String((input && input.method) || 'GET').toUpperCase();
  const rawPath = String((input && input.path) || '');
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\s\\#]/.test(rawPath) || rawPath.includes('://')) {
    return fail('path must be a project-relative path such as /tasks/TPT1 — not a URL.');
  }
  const queryAt = rawPath.indexOf('?');
  const pathname = queryAt === -1 ? rawPath : rawPath.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rawPath.slice(queryAt);
  // No encoded characters in the path part: `%2e%2e` / `%2f` must never reach the server as a
  // different path than the one checked here. Query strings may be encoded freely.
  if (pathname.includes('%') || pathname.split('/').some(seg => seg === '..' || seg === '.')) {
    return fail('path must not contain encoded characters or dot segments.');
  }
  if (!RULES.some(rule => rule.method === method && rule.re.test(pathname))) {
    return fail(`${method} ${pathname} is not available in task chat. Allowed: ${ALLOWED_SUMMARY}.`);
  }
  let body;
  if (method === 'POST' || method === 'PATCH') {
    let value = input && input.body;
    // Some models hand the body over as a JSON string instead of an object.
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(`${method} needs a JSON object body.`);
    }
    body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return fail('body is too large.');
  }
  return {
    ok: true,
    method,
    url: `${base}/api/projects/${encodeURIComponent(projectId)}${pathname}${query}`,
    headers: {
      Authorization: `Bearer ${e.API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  };
}

module.exports = { resolveTipataskRequest, RULES, MAX_BODY_BYTES };
