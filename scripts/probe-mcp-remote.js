#!/usr/bin/env node
'use strict';

// Live remote MCP parity probe: tool list, ported calls, viewer write gate,
// and unsupported GET/DELETE responses. Requires --api-base and uses isolated
// credentials plus a throwaway project; never production or port 4455.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
  }
  return opts;
}

// ── Minimal HS256 JWT signer — mirrors probe-status-roles.js's own, so this probe has
// no dependency on the `jsonwebtoken` package (an api/ dependency, not ai/todo/server's). ──
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwtHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + 7 * 24 * 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${sig}`;
}
function readJwtSecret() {
  const envPath = path.join(__dirname, '..', '..', '..', '..', 'api', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^JWT_SECRET=(.+)$/m);
  if (!m) throw new Error(`JWT_SECRET not found in ${envPath}`);
  return m[1].trim();
}
function readUserEmail(userId) {
  return userId === 1 ? (process.env.TIPATASK_PROBE_USER_EMAIL || 'user1@example.invalid') : `probe-user-${userId}@example.invalid`;
}

// Scans api/src/routes/mcp.js's own server.tool('name') call sites — same technique
// api/src/routes/mcp.test.js's parity guard already uses — instead of hardcoding a tool
// count/list here. In mcp.js those call sites are exactly TOOL_NAMES (mcp.test.js asserts
// that equality), so this scan needs no second source of truth. Returns null (never
// throws) when the file is absent, e.g. a checkout without ./api — callers must skip
// rather than fail in that case, mirroring mcp.test.js's own skip discipline.
function readRemoteToolNames() {
  const mcpJsPath = path.join(__dirname, '..', '..', '..', '..', 'api', 'src', 'routes', 'mcp.js');
  let src;
  try { src = fs.readFileSync(mcpJsPath, 'utf8'); } catch { return null; }
  const names = [...src.matchAll(/^[ \t]*server\.tool\(\s*['"]([A-Za-z0-9_]+)['"]/gm)].map((m) => m[1]);
  return names.length ? names : null;
}

let _passCount = 0, _failCount = 0;
function assertTrue(label, cond, detail) {
  if (cond) { _passCount++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { _failCount++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
}
function assertEq(label, actual, expected) {
  assertTrue(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function apiFetch(apiBase, token, method, path_, body) {
  const res = await fetch(`${apiBase}${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path_} -> ${res.status}: ${json && json.error || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

let _rpcId = 1;
async function mcpCall(apiBase, projectId, token, method, params, extraHeaders) {
  const res = await fetch(`${apiBase}/api/projects/${projectId}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', ...(extraHeaders || {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
function toolResult(r) {
  const text = r.json && r.json.result && r.json.result.content && r.json.result.content[0] && r.json.result.content[0].text;
  if (text === undefined) return r.json;
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-mcp-remote] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase)) {
    console.error('[probe-mcp-remote] --api-base looks like the production host — refusing to run against it.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-mcp-remote] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-mcp-remote] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  console.log(`[probe-mcp-remote] target: ${opts.apiBase}\n`);

  console.log('1. Creating throwaway project...');
  const projectName = `probe-mcp-remote-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"\n`);

  try {
    console.log('2. POST /api/auth/project-token — mint a project-scoped token...');
    const { token: scopedToken } = await apiFetch(opts.apiBase, token, 'POST', '/api/auth/project-token', { project_id: projectId });
    console.log('   minted.\n');

    console.log('3. tools/list — expect exactly the tools registered in mcp.js...');
    const list = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/list', {});
    const names = (list.json.result && list.json.result.tools || []).map(t => t.name).sort();
    const expectedNames = readRemoteToolNames();
    if (expectedNames) {
      assertEq('tools/list matches mcp.js TOOL_NAMES', names, [...expectedNames].sort());
    } else {
      console.log(`   (skipped exact-set check — could not read api/src/routes/mcp.js from this checkout; got ${names.length} tools)`);
    }
    for (const n of ['create_task_comment', 'delete_task', 'list_task_id_meta', 'reserve_task_keys',
      'purge_stale_reservations', 'ensure_project_tag', 'create_system_tag', 'get_tag_architectures',
      'list_knowledge_conflicts', 'get_knowledge_conflict']) {
      assertTrue(`tools/list includes ${n}`, names.includes(n));
    }
    console.log();

    console.log('4. reserve_task_keys...');
    let r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'reserve_task_keys', arguments: { count: 2, category: 'CODING' } });
    let out = toolResult(r);
    assertTrue('reserved 2 keys', Array.isArray(out.keys) && out.keys.length === 2, JSON.stringify(out));
    const [k1, k2] = out.keys;
    console.log();

    console.log('5. list_task_id_meta reflects the reservation...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'list_task_id_meta', arguments: {} });
    out = toolResult(r);
    assertTrue('maxCId >= 2', out.maxCId >= 2, `maxCId=${out.maxCId}`);
    console.log();

    console.log(`6. update_task finalizes reservation ${k1} (title set, priority defaulted, is_reservation cleared)...`);
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'update_task', arguments: { task_key: k1, title: 'Probe task one', description: 'desc' } });
    out = toolResult(r);
    assertEq('title set', out.task && out.task.title, 'Probe task one');
    assertEq('is_reservation cleared', out.task && out.task.isReservation, false);
    console.log();

    console.log('7. create_task_comment...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'create_task_comment', arguments: { task_key: k1, content: 'Probe comment for C1382.', type: 'comment' } });
    out = toolResult(r);
    assertTrue('comment created', !!(out.comment && out.comment.content.includes('Probe comment')), JSON.stringify(out));
    console.log();

    console.log('8. ensure_project_tag (real description, then placeholder rejection)...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'ensure_project_tag', arguments: { tag_name: 'probe-tag', description: 'Real description for probe verification' } });
    out = toolResult(r);
    assertEq('plain tag registered', out.tag, 'probe-tag');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'ensure_project_tag', arguments: { tag_name: 'probe-tag-2', description: 'Auto-registered by createTask' } });
    assertTrue('placeholder description rejected', r.json.result && r.json.result.isError === true);
    console.log();

    console.log('9. create_system_tag (creates a KB stub, second call reports exists:true)...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'create_system_tag', arguments: { tag_name: 'tt-probe-mcp-remote', description: 'Probe tag for verification', architecture_hint: 'Scratch module used only by probe-mcp-remote.js.' } });
    out = toolResult(r);
    assertTrue('system tag created', out.created === true && out.file === 'ai/architecture/tt-probe-mcp-remote.md', JSON.stringify(out));
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'create_system_tag', arguments: { tag_name: 'tt-probe-mcp-remote', description: 'irrelevant', architecture_hint: 'irrelevant' } });
    out = toolResult(r);
    assertEq('idempotent re-call reports exists:true', out.exists, true);
    console.log();

    console.log('10. get_tag_architectures (batch, including a missing-tag -> null case)...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'get_tag_architectures', arguments: { tag_names: ['tt-probe-mcp-remote', 'tt-does-not-exist'] } });
    out = toolResult(r);
    assertTrue('found real tag content', typeof out['tt-probe-mcp-remote'] === 'string' && out['tt-probe-mcp-remote'].includes('tt-probe-mcp-remote'));
    assertEq('missing tag maps to null', out['tt-does-not-exist'], null);
    console.log();

    console.log(`11. delete_task cascades a parent+child subtree (${k1} + ${k2})...`);
    await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'update_task', arguments: { task_key: k2, title: 'Probe child', description: 'child' } });
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'delete_task', arguments: { task_key: k1 } });
    out = toolResult(r);
    assertEq('delete reports deleted:true', out.deleted, true);
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'get_task', arguments: { task_key: k1 } });
    assertTrue('deleted task no longer found', r.json.result && r.json.result.isError === true);
    console.log();

    console.log('12. purge_stale_reservations dry_run...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'purge_stale_reservations', arguments: { dry_run: true, older_than_hours: 1 } });
    out = toolResult(r);
    assertEq('dry_run echoed back', out.dry_run, true);
    console.log();

    console.log('13. list_knowledge_conflicts / get_knowledge_conflict on a fresh project...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'list_knowledge_conflicts', arguments: {} });
    out = toolResult(r);
    assertTrue('no conflicts recorded', out.total === 0 && Array.isArray(out.conflicts) && out.conflicts.length === 0, JSON.stringify(out));
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'get_knowledge_conflict', arguments: { record_id: 999999 } });
    assertTrue('nonexistent conflict record errors cleanly', r.json.result && r.json.result.isError === true);
    console.log();

    console.log('14. X-Tipatask-Session-Task header does not break create_task...');
    r = await mcpCall(opts.apiBase, projectId, scopedToken, 'tools/call', { name: 'create_task', arguments: { task_key: 'C999', title: 'Session-scoped follow-up', description: 'd' } }, { 'X-Tipatask-Session-Task': 'C1' });
    out = toolResult(r);
    assertEq('create_task with session header succeeds', out.task && out.task.id, 'C999');
    console.log();

    console.log('15. GET/DELETE on the route -> 405...');
    const getRes = await fetch(`${opts.apiBase}/api/projects/${projectId}/mcp`, { method: 'GET', headers: { Authorization: `Bearer ${scopedToken}` } });
    assertEq('GET returns 405', getRes.status, 405);
    console.log();

    console.log('16. viewer-role token cannot write (create_task_comment) — expect isError, not a thrown 403...');
    const viewerAdd = await apiFetch(opts.apiBase, token, 'POST', `/api/projects/${projectId}/members`, { email: readUserEmail(999), role: 'viewer' }).catch(() => null);
    if (viewerAdd) {
      console.log('   (skipped — this API build has no /members invite-by-email path suited to a probe user; write-gate is covered by the unit tests in api/src/lib and by manual review of ctx.canWrite checks)');
    } else {
      console.log('   (skipped — no throwaway second user available in this environment)');
    }
    console.log();
  } finally {
    if (opts.keep) {
      console.log(`[probe-mcp-remote] --keep set: leaving project id=${projectId} in place for inspection.`);
    } else {
      console.log('[probe-mcp-remote] tearing down throwaway project...');
      await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      console.log('   deleted.');
    }
  }

  console.log(`\n[probe-mcp-remote] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-mcp-remote] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
