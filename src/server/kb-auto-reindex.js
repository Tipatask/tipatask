'use strict';

// C1218 — shared wrapper: fires knowledge-sync.js's fireAutoReindex() and broadcasts its
// onStart/onProgress/result over the project-scoped board WS, so the 3 in-process trigger
// sites (WS connect, sync-kb, spawnTerminal) and the delegated Electron window-bind
// trigger (see index.js's `process.on('message', ...)` handler) don't each hand-roll the
// same broadcast wiring. See ai/architecture/tt-knowledge-sync.md § Auto-Trigger on Sync.
//
// Broadcast (not unicast) because there is no requesting socket for an auto-fired run —
// contrast the manual `reindex-kb` WS handler, which replies directly to the clicking
// socket via sendWsJson and stamps `auto:false` implicitly by omitting the field.
//
// C1230 — force-once branch. Checked FIRST, ahead of the ordinary fireAutoReindex path, so
// every one of the 5 triggers that route through this function (boot — new, WS connect,
// sync-kb, task spawn, Electron window-bind) gives a never-indexed project its one-time
// pass, not just server boot. hasNeverBeenReindexed() is one 30s-cached, fail-closed GET —
// negligible next to the presync + two detect GETs the normal path already does.

function _broadcastResult(websocket, to, label, res) {
  websocket.broadcastKbReindexResult(to, {
    success: res.ok,
    tagsUpdated: res.result?.tagsUpdated ?? 0,
    filesUpdated: res.result?.filesUpdated ?? 0,
    skipped: res.result?.skipped ?? 0,
    errors: res.result?.errors ?? [],
    // C1244 — carried through so the client can tell a link-only run (staleCount:0,
    // linkOnlyCount>0) apart from an ordinary description run and pick different toast
    // copy instead of reading "0 stale descriptions" on a run that fixed real rows.
    staleCount: res.staleCount ?? 0,
    linkOnlyCount: res.linkOnlyCount ?? 0,
    ...(res.ok ? {} : { error: res.message }),
  });
  console.log(`[kb-reindex:${label}] run finished — ok=${res.ok} tags=${res.result?.tagsUpdated ?? 0} files=${res.result?.filesUpdated ?? 0}`);
}

async function fireAutoReindexWithBroadcast({ rootPath, projectPath, backend, label }) {
  const { fireAutoReindex } = require('../cli/knowledge-sync');
  const { hasNeverBeenReindexed, forceReindexOnStartup } = require('./kb-reindex');
  const websocket = require('./websocket');
  const to = projectPath || ''; // '' -> broadcastToProject falls through to "every client"

  // forceReindexOnStartup calls fireAutoReindex with manual:true, which bypasses the
  // kill switch check inside fireAutoReindex (that check is itself gated `!manual`) —
  // re-check it HERE so TIPATASK_KB_AUTOREINDEX=0/false still disables every auto path,
  // force-once included. A real user click (ws-handlers.js's `reindex-kb` msg, separate
  // code path, always manual:true) is correctly unaffected by this switch either way.
  const killSwitched = ['0', 'false'].includes(process.env.TIPATASK_KB_AUTOREINDEX);
  const neverIndexed = !killSwitched && await hasNeverBeenReindexed(backend).catch(() => false);

  if (neverIndexed) {
    const forceLabel = `${label}+force-once`;
    console.log(`[kb-reindex:${forceLabel}] kb_last_reindexed_at is NULL for ${rootPath} — firing once-per-project forced run`);
    const res = await forceReindexOnStartup({
      backend, rootPath, label: forceLabel,
      // forced:true lets the client tell this apart from a real "N stale descriptions
      // found" auto-detect run — manual:true skips detect, so `d` here is always the
      // zero-count shape ({tagCount:0,fileCount:0,staleCount:0}); without this flag the
      // toast would misleadingly read "Found 0 stale descriptions — re-indexing…".
      onStart: (d) => websocket.broadcastToProject(to, 'reindex-kb-auto', { ...d, label: forceLabel, forced: true }),
      onProgress: (p) => websocket.broadcastToProject(to, 'reindex-kb-progress', { ...p, auto: true }),
    });
    // 'ran'/'joined' both produced (or joined a run that will produce) a real result —
    // everything else (skipped-*, error, detect-failed) has no result worth a toast.
    if (res.status === 'ran' || res.status === 'joined') _broadcastResult(websocket, to, forceLabel, res);
    else console.log(`[kb-reindex:${forceLabel}] ${res.status} for ${rootPath}${res.message ? `: ${res.message}` : ''} (stamped=${res.stamped})`);
    return res;
  }

  const res = await fireAutoReindex(rootPath, label, {
    backend,
    onStart: (d) => websocket.broadcastToProject(to, 'reindex-kb-auto', { ...d, label }),
    onProgress: (p) => websocket.broadcastToProject(to, 'reindex-kb-progress', { ...p, auto: true }),
  });
  if (res.status === 'ran') {
    _broadcastResult(websocket, to, label, res);
  } else if (res.status === 'detect-failed' || res.status === 'error') {
    console.warn(`[kb-reindex:${label}] ${res.status} for ${rootPath}: ${res.message}`);
  } else if (res.status !== 'skipped-recently-checked' && res.status !== 'clean') {
    // Log every non-trivial skip (cooldown/lease/in-flight/etc) — silent on the two hot,
    // expected-to-be-frequent outcomes so normal task-launch traffic doesn't spam stdout.
    console.log(`[kb-reindex:${label}] ${res.status} for ${rootPath}`);
  }
  return res;
}

module.exports = { fireAutoReindexWithBroadcast };
