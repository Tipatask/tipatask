#!/usr/bin/env node
'use strict';

// Backfill descriptions in the CONFIGURED project, not a throwaway probe project.
// Never accepts --force. --project-id must match local config; live writes also
// require --yes and use the KB lease/cooldown path. --detect-only performs no writes;
// --dry-run calls Opus but writes nothing. Recheck residual blanks after a real run:
// an Opus timeout can drop a batch without appearing in errors.
// --fill-file-gaps copies existing tag descriptions to blank linked KB files.
// --repair-tag-links attaches unlinked tt-* docs; automatic reindex handles ordinary
// link-only gaps, so use this for remaining conflicts/mismatches after inspection.
// Both repair flags honor --dry-run. Example:
//   npm run backfill-kb-descriptions -- --project-id 2 --detect-only
//   npm run backfill-kb-descriptions -- --project-id 2 --dry-run
//   npm run backfill-kb-descriptions -- --project-id 2 --yes

const path = require('path');

function parseArgs(argv) {
  const opts = { projectId: null, detectOnly: false, dryRun: false, yes: false, fillFileGaps: false, repairTagLinks: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-id') opts.projectId = argv[++i];
    else if (a === '--detect-only') opts.detectOnly = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--fill-file-gaps') opts.fillFileGaps = true;
    else if (a === '--repair-tag-links') opts.repairTagLinks = true;
  }
  return opts;
}

async function apiFetch(baseUrl, token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(`${method} ${urlPath} -> ${res.status}: ${(json && json.error) || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function printDetectSummary(label, detected) {
  console.log(`[${label}] hasStale=${detected.hasStale} tagCount=${detected.tagCount} fileCount=${detected.fileCount} staleCount=${detected.staleCount} linkOnlyCount=${detected.linkOnlyCount}`);
}

// §4/§5 — zero-Opus gap-fill: reuse an already-good tag description as its linked file's
// description, for every tt-* tag whose file row is still blank. Batches of 50 to keep the
// server's all-or-nothing transaction short and any one bad item's blast radius small.
async function fillFileGaps(baseUrl, projectId, token, { dryRun = false } = {}) {
  const { tags } = await apiFetch(baseUrl, token, 'GET', `/api/projects/${projectId}/tags`);
  const { files } = await apiFetch(baseUrl, token, 'GET', `/api/projects/${projectId}/knowledge`);
  const fileDescByKey = new Map(files.map((f) => [f.file_key, f.description]));

  const isPlaceholder = (d) => !d || !String(d).trim() || /^auto-registered\b/i.test(String(d).trim());

  const gaps = tags
    .filter((t) => t.name.startsWith('tt-') && t.knowledge_file_key && !isPlaceholder(t.description))
    .filter((t) => !fileDescByKey.has(t.knowledge_file_key) || isPlaceholder(fileDescByKey.get(t.knowledge_file_key)))
    .map((t) => ({ file_key: t.knowledge_file_key, description: t.description }));

  console.log(`[fill-file-gaps] found ${gaps.length} file(s) whose already-good tag description was never copied to the file row`);

  if (dryRun) {
    for (const g of gaps) console.log(`  would set ${g.file_key} :: ${g.description}`);
    console.log(`\n[fill-file-gaps] --dry-run: zero writes.`);
    return { updated: 0 };
  }

  if (gaps.length === 0) return { updated: 0 };

  let totalUpdated = 0;
  const BATCH = 50;
  for (let i = 0; i < gaps.length; i += BATCH) {
    const batch = gaps.slice(i, i + BATCH);
    const result = await apiFetch(baseUrl, token, 'POST', `/api/projects/${projectId}/knowledge/reindex`, { files: batch });
    console.log(`[fill-file-gaps] batch ${i / BATCH + 1}: files_updated=${result.files_updated} skipped=${JSON.stringify(result.skipped)}`);
    totalUpdated += result.files_updated || 0;
  }
  return { updated: totalUpdated };
}

// §6 (C1238) — zero-Opus link-only repair: attach tags.knowledge_file_id for every tt-* tag
// that's still NULL even though its doc already exists as a project_knowledge_files row.
// Uses PUT /tags/:name/link (no description required, unlike POST /knowledge/reindex) —
// see this file's header for why the auto-reindex path never drains this on its own.
async function repairTagLinks(baseUrl, projectId, token, { dryRun = false } = {}) {
  const { tags } = await apiFetch(baseUrl, token, 'GET', `/api/projects/${projectId}/tags`);
  const { files } = await apiFetch(baseUrl, token, 'GET', `/api/projects/${projectId}/knowledge`);
  const fileKeys = new Set(files.map((f) => f.file_key));
  const claimedBy = new Map(tags.filter((t) => t.knowledge_file_key).map((t) => [t.knowledge_file_key, t.name]));

  const candidates = []; // { name, fileKey } — safe to link
  const noFile = [];     // expected doc not pushed yet
  const conflict = [];   // expected doc already claimed by a different tag
  const mismatched = []; // linked, but not to the expected path — report only, never rewritten

  for (const t of tags) {
    if (!t.name.startsWith('tt-')) continue;
    const expectedFileKey = `ai/architecture/${t.name}.md`;

    if (t.knowledge_file_id == null) {
      if (!fileKeys.has(expectedFileKey)) noFile.push({ name: t.name, fileKey: expectedFileKey });
      else if (claimedBy.has(expectedFileKey) && claimedBy.get(expectedFileKey) !== t.name) {
        conflict.push({ name: t.name, fileKey: expectedFileKey, claimedBy: claimedBy.get(expectedFileKey) });
      } else {
        candidates.push({ name: t.name, fileKey: expectedFileKey });
      }
    } else if (t.knowledge_file_key && t.knowledge_file_key !== expectedFileKey) {
      mismatched.push({ name: t.name, actual: t.knowledge_file_key, expected: expectedFileKey });
    }
  }

  console.log(`[repair-tag-links] ${candidates.length} linkable, ${noFile.length} missing doc, ${conflict.length} conflicting, ${mismatched.length} mismatched (report-only)`);
  for (const c of candidates) console.log(`  ${dryRun ? 'would link' : 'linking'} ${c.name} -> ${c.fileKey}`);
  for (const n of noFile) console.log(`  [skip] ${n.name} -> ${n.fileKey} not found in KB — push the doc first`);
  for (const c of conflict) console.log(`  [skip] ${c.name} -> ${c.fileKey} already linked to "${c.claimedBy}"`);
  for (const m of mismatched) console.log(`  [warn] ${m.name} linked to "${m.actual}", expected "${m.expected}" — left alone, verify manually`);

  if (dryRun) {
    console.log(`\n[repair-tag-links] --dry-run: zero writes.`);
    return { linked: 0, failed: [] };
  }
  if (candidates.length === 0) return { linked: 0, failed: [] };

  let linked = 0;
  const failed = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      await apiFetch(baseUrl, token, 'PUT', `/api/projects/${projectId}/tags/${encodeURIComponent(c.name)}/link`, { file_key: c.fileKey });
      linked++;
    } catch (err) {
      // First failure with a 404 that isn't the route's own "not found" JSON means the route
      // itself is likely missing (prod deployed from a stale branch, tt-deploy.md) — bail loud
      // instead of repeating the same failure for every remaining candidate.
      const routeLikelyMissing = i === 0 && err.status === 404 &&
        !/Tag not found|No knowledge file found/.test((err.body && err.body.error) || '');
      if (routeLikelyMissing) {
        console.error(`[repair-tag-links] PUT /tags/:name/link failed with a bare 404 on the first candidate — the route may not be deployed on this API. Deploy api/ first. (${err.message})`);
        failed.push({ name: c.name, error: err.message });
        break;
      }
      failed.push({ name: c.name, error: err.message });
    }
  }
  console.log(`\n[repair-tag-links] linked ${linked}/${candidates.length}${failed.length ? `, ${failed.length} failed: ${JSON.stringify(failed)}` : ''}`);

  const after = await apiFetch(baseUrl, token, 'GET', `/api/projects/${projectId}/tags`);
  const afterByName = new Map(after.tags.map((t) => [t.name, t.knowledge_file_key]));
  const stillUnlinked = candidates.filter((c) => afterByName.get(c.name) !== c.fileKey);
  if (stillUnlinked.length > 0) {
    console.log(`[repair-tag-links] ${stillUnlinked.length} candidate(s) still not linked after the run: ${stillUnlinked.map((c) => c.name).join(', ')}`);
  } else {
    console.log(`[repair-tag-links] converged — every candidate now links to its expected doc.`);
  }
  return { linked, failed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.projectId) {
    console.error('[backfill-kb-descriptions] --project-id <id> is required — confirms you mean to run this against the project this checkout is currently configured for.');
    process.exitCode = 1;
    return;
  }

  const rootPath = require('../src/server/project-root').resolveProjectRoot();
  const { getApiCredentials } = require('../src/server/api-credentials');
  let creds;
  try {
    creds = getApiCredentials(rootPath);
  } catch (err) {
    console.error(`[backfill-kb-descriptions] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (String(creds.projectId) !== String(opts.projectId)) {
    console.error(`[backfill-kb-descriptions] --project-id ${opts.projectId} does not match this checkout's configured API_PROJECT_ID (${creds.projectId}) — refusing. Pass the right id, or check .tipatask/config.json.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[backfill-kb-descriptions] target: ${creds.baseUrl} project ${creds.projectId}\n`);

  if (opts.fillFileGaps) {
    const result = await fillFileGaps(creds.baseUrl, creds.projectId, creds.token, { dryRun: opts.dryRun });
    if (!opts.dryRun) console.log(`\n[backfill-kb-descriptions] fill-file-gaps done — ${result.updated} file(s) updated.`);
    return;
  }

  if (opts.repairTagLinks) {
    const result = await repairTagLinks(creds.baseUrl, creds.projectId, creds.token, { dryRun: opts.dryRun });
    if (!opts.dryRun) console.log(`\n[backfill-kb-descriptions] repair-tag-links done — ${result.linked} tag(s) linked${result.failed.length ? `, ${result.failed.length} failed` : ''}.`);
    return;
  }

  const { createApiBackend } = require('../src/server/api-backend');
  const backend = createApiBackend({}, rootPath);
  await backend.init();

  if (opts.detectOnly) {
    const { detectStaleDescriptions } = require('../src/server/kb-reindex');
    const detected = await detectStaleDescriptions({ backend, rootPath, baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token });
    printDetectSummary('detect', detected);
    return;
  }

  if (opts.dryRun) {
    const { reindexKnowledge } = require('../src/server/kb-reindex');
    console.log('[backfill-kb-descriptions] --dry-run: real Opus calls, zero writes.\n');
    const result = await reindexKnowledge({
      baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token, rootPath, backend,
      onProgress: (p) => console.log(`  [progress] ${p.phase} ${p.done}/${p.total}`),
      dryRun: true,
    });
    console.log(`\n[backfill-kb-descriptions] proposed ${result.proposals.tags.length} tag description(s), ${result.proposals.files.length} file description(s). errors: ${JSON.stringify(result.errors)}\n`);
    for (const t of result.proposals.tags) console.log(`  tag  ${t.name}${t.file_key ? ` (-> ${t.file_key})` : ''} :: ${t.description}`);
    for (const f of result.proposals.files) console.log(`  file ${f.file_key} :: ${f.description}`);
    return;
  }

  if (!opts.yes) {
    console.error('[backfill-kb-descriptions] a real run requires --yes (this writes to production: tag/file descriptions + tag<->file links, force=false — see this file\'s header for the exact safety model). Run --dry-run first.');
    process.exitCode = 1;
    return;
  }

  const { detectStaleDescriptions } = require('../src/server/kb-reindex');
  const { fireAutoReindex } = require('../src/cli/knowledge-sync');

  const before = await detectStaleDescriptions({ backend, rootPath, baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token });
  printDetectSummary('before', before);

  console.log('\n[backfill-kb-descriptions] running fireAutoReindex(manual:false, force:false)...\n');
  const result = await fireAutoReindex(rootPath, 'backfill', {
    backend,
    manual: false,
    onStart: (d) => console.log(`  [start] tagCount=${d.tagCount} fileCount=${d.fileCount} staleCount=${d.staleCount}${d.joined ? ' (joined an in-flight run)' : ''}`),
    onProgress: (p) => console.log(`  [progress] ${p.phase} ${p.done}/${p.total}`),
  });
  console.log(`\n[backfill-kb-descriptions] run result: status=${result.status} ok=${result.ok}${result.message ? ` message=${result.message}` : ''}`);
  if (result.result) console.log(`  tagsUpdated=${result.result.tagsUpdated} filesUpdated=${result.result.filesUpdated} skipped=${result.result.skipped} errors=${JSON.stringify(result.result.errors || [])}`);

  const after = await detectStaleDescriptions({ backend, rootPath, baseUrl: creds.baseUrl, projectId: creds.projectId, token: creds.token });
  console.log();
  printDetectSummary('after', after);
  if (after.staleCount > 0) {
    console.log(`\n[backfill-kb-descriptions] ${after.staleCount} item(s) still stale — likely a silently-dropped Opus batch (no retries in reindexKnowledge). Re-run this script to converge.`);
  } else {
    console.log('\n[backfill-kb-descriptions] converged — 0 stale items remain.');
  }
}

main().catch((err) => {
  console.error('[backfill-kb-descriptions] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
