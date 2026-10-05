#!/usr/bin/env node
'use strict';

// Credential-safe REST recovery and Pi terminal tools. Bodies/resolutions arrive
// on stdin; tokens are read internally and never passed through argv or stdout.
async function run(argv, { input = '', fetchImpl = fetch } = {}) {
  const { resolveProjectRoot } = require('../server/project-root');
  const root = resolveProjectRoot();
  const { getApiCredentials } = require('../server/api-credentials');
  const { baseUrl, projectId, token } = getApiCredentials(root);
  const [command, target] = argv;
  if (command === 'verify' || command === 'complete') {
    const { createPerProjectBackend } = require('../server/task-backend');
    const backend = createPerProjectBackend({ TASK_BACKEND: 'api' }, root);
    const guard = require('../server/git-merge/completion-guard');
    const opts = { backend, projectRoot: root, taskId: target, resolution: input };
    return command === 'verify' ? guard.verifyTaskCompletion(opts) : guard.completeVerifiedTask(opts);
  }
  // Share the chat path validator, extending only the terminal's documented KB writes.
  const { resolveTipataskRequest } = require('../server/providers/pi-ext/tipatask-request.cjs');
  let request;
  if (command === 'POST' && target === '/knowledge') {
    request = { ok: true, method: command, url: `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/knowledge`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.parse(input)) };
  } else {
    request = resolveTipataskRequest({ method: command, path: target, body: input || undefined },
      { API_BASE_URL: baseUrl, API_PROJECT_ID: projectId, API_TOKEN: token });
  }
  if (!request.ok) throw new Error(request.error);
  const res = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(15000) });
  let body;
  try { body = await res.json(); } catch { throw new Error(`Tipatask returned HTTP ${res.status} with an unreadable response`); }
  // An unexpected server echo must never reveal a credential in diagnostics.
  return { status: res.status, body: JSON.parse(JSON.stringify(body).split(token).join('[redacted]')) };
}

if (require.main === module) {
  const command = process.argv[2];
  const input = ['POST', 'PATCH', 'complete'].includes(command) ? require('node:fs').readFileSync(0, 'utf8') : '';
  run(process.argv.slice(2), { input }).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.completed === false || result.verified === false || result.status >= 400) process.exitCode = 1;
  }).catch(err => { console.error(err.missingCredentials || err.authError ? err.message : 'Tipatask request failed; check method, body, project and sign-in.'); process.exitCode = 1; });
}
module.exports = { run };
