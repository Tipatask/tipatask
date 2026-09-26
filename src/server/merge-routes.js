'use strict';

// TPT345 — `/api/project/merge/*` same-origin routes for the Task App's "Merge task
// branches" panel. Mounted from ws-handlers.js's createHttpHandler() with the request's
// authorized project root + backend (local-access.js has already validated the
// x-tipatask-project header). All git runs in THIS server process — never through an
// agent shell — so the panel works whatever the agent-facing Version Control flags allow
// (it only requires vcs_type === 'git'; see tt-version-control-agents.md).

const merge = require('./git-merge');
const { MergeJobError } = require('./git-merge/merge-job');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
  res.end(JSON.stringify(body));
}

// `target[root]=x&target[ai/todo/server]=y&create[root]=name` → { root: {branch:'x'}, ... }
function parseTargetsQuery(searchParams) {
  const targets = {};
  for (const [k, v] of searchParams.entries()) {
    let m = /^target\[(.+)\]$/.exec(k);
    if (m && v) { targets[m[1]] = { branch: v }; continue; }
    m = /^create\[(.+)\]$/.exec(k);
    if (m && v) targets[m[1]] = { createBranch: v };
  }
  return targets;
}

function statusForError(err) {
  if (err instanceof merge.MergeError) return err.status || 500;
  if (err instanceof MergeJobError) {
    if (['JOB_RUNNING', 'STILL_CONFLICTED', 'NOT_IN_CONFLICT', 'MERGE_NOT_FOUND', 'REPO_MID_MERGE'].includes(err.code)) return 409;
    return 500;
  }
  return 500;
}

async function readJsonBody(req, res, readTextBody) {
  const text = await readTextBody(req, res);
  if (text === null) return null; // readTextBody already answered (413)
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'JSON body must be an object', code: 'BAD_REQUEST' });
      return null;
    }
    return body;
  } catch { sendJson(res, 400, { error: 'Invalid JSON', code: 'BAD_JSON' }); return null; }
}

// Returns true when the path was handled (always, for /api/project/merge/*).
async function handleMergeRoute(req, res, urlPath, { projectRoot, backend, sessions, readTextBody }) {
  const sub = urlPath.replace(/^\/api\/project\/merge\/?/, '').replace(/\/+$/, '');
  const ctx = { projectRoot, backend, sessions };
  try {
    if (req.method === 'GET' && sub === 'status') {
      const url = new URL(req.url, 'http://localhost');
      return sendJson(res, 200, await merge.getMergeStatus({ ...ctx, targets: parseTargetsQuery(url.searchParams) }));
    }
    if (req.method === 'GET' && sub === 'job') {
      return sendJson(res, 200, merge.getJobState(ctx));
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    const body = await readJsonBody(req, res, readTextBody);
    if (body === null) return true;
    switch (sub) {
      case 'task':
        return sendJson(res, 200, await merge.startMergeRun({ ...ctx, taskKey: body?.taskKey ?? null }));
      case 'dry-run':
        return sendJson(res, 200, await merge.dryRun({ ...ctx, selections: body.selections, targets: body.targets }));
      case 'commit-worktree':
        return sendJson(res, 200, await merge.commitWorktree({ ...ctx, repoId: body.repoId, branch: body.branch, force: !!body.force }));
      case 'run':
        return sendJson(res, 202, await merge.startMergeRun({ ...ctx, selections: body.selections, targets: body.targets, checks: body.checks }));
      case 'abort':
        return sendJson(res, 200, await merge.abortJob(ctx));
      case 'resume':
        return sendJson(res, 200, await merge.resumeJob(ctx));
      case 'publish':
        return sendJson(res, 200, await merge.publish({ ...ctx, repoIds: body.repoIds, pr: body.pr !== false, bases: body.bases, targets: body.targets }));
      case 'cleanup':
        return sendJson(res, 200, await merge.cleanup({ ...ctx, selections: body.selections }));
      default:
        return sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }
  } catch (err) {
    const status = statusForError(err);
    if (status >= 500) console.error('[merge] route failed:', err);
    return sendJson(res, status, { error: err.message, code: err.code || 'MERGE_FAILED', details: err.details || null });
  }
}

module.exports = { handleMergeRoute, parseTargetsQuery, statusForError };
