'use strict';

// C1337 — extracted out of src/server/index.js's setImmediate boot block so the boot
// sync/re-index chain is unit-testable (requiring index.js itself creates a real HTTP
// server and calls .listen()). NEVER THROWS — same discipline as every other function in
// this module's family (autoPushOnEdit, syncProjectKb, fireAutoReindex).

const { isAsarPath } = require('./spawn-utils');

// Boot KB pull needs an explicit project root. Packaged Electron shares one
// server across projects, so config.PROJECT_ROOT may point into app.asar; skip
// boot pull then and let window binding sync each actual project.
function resolveBootKbRoot(config) {
  if (config.BOUND_PROJECT_ROOT) return config.BOUND_PROJECT_ROOT;
  return isAsarPath(config.SERVER_ROOT) ? null : config.PROJECT_ROOT;
}

/**
 * @param {object} opts
 * @param {object} opts.config   the server's config module (PROJECT_ROOT, BOUND_PROJECT_ROOT, SERVER_ROOT)
 * @param {object} opts.backend  the active task backend, forwarded to fireAutoReindexWithBroadcast
 * @param {Function} [opts.sync]     TEST SEAM — defaults to knowledge-sync.js's syncProjectKb
 * @param {Function} [opts.reindex]  TEST SEAM — defaults to kb-auto-reindex.js's fireAutoReindexWithBroadcast
 * @param {Function} [opts.invalidateArchForKeys] TEST SEAM — defaults to architecture-cache.js's export
 * @returns {Promise<{ok:boolean, status:string, rootPath?:string|null, pulledCount?:number,
 *   pulledKeys?:string[], pushed?:string[], pushSkipped?:string[], message?:string}>}
 */
async function fireBootKbSync({
  config,
  backend,
  sync = require('../cli/knowledge-sync').syncProjectKb,
  reindex = require('./kb-auto-reindex').fireAutoReindexWithBroadcast,
  invalidateArchForKeys = require('../mcp/architecture-cache').invalidateArchForKeys,
} = {}) {
  const rootPath = resolveBootKbRoot(config);

  let res = { ok: true, status: 'skipped-no-root' };
  if (rootPath) {
    try {
      res = await sync(rootPath, 'boot', { push: true });
      if (res && res.pulledKeys && res.pulledKeys.length > 0) {
        // Bust the in-memory arch-doc cache the same way terminal-session.js's per-task
        // spawn sync does — otherwise index.js's OWN earlier setImmediate (the arch-cache
        // warm, which runs first in the listen callback) can have already cached the
        // stale pre-pull content, and get_tag_architecture/list_system_tags would keep
        // serving it until the next TTL rescan.
        try { invalidateArchForKeys(res.pulledKeys, rootPath); } catch { /* best-effort */ }
      }
    } catch (err) {
      // sync() never throws by contract, but this boot path must survive even a broken
      // test double or an unforeseen throw — never let it block the re-index below.
      res = { ok: false, status: 'error', message: err.message };
    }
  }

  // Chained AFTER the pull resolves — same reasoning as ws-handlers.js's WS-connect block
  // (C1218): the re-index runs its own presync, which would otherwise race the pull's
  // write to the same version cache. Fires even on a skipped/failed pull (no root bound,
  // no creds yet, transport error) — this preserves today's boot re-index behavior
  // (including the C1230 force-once path) for every case that isn't a genuine successful
  // sync.
  try {
    await reindex({ rootPath, projectPath: rootPath, backend, label: 'boot' });
  } catch { /* fireAutoReindexWithBroadcast never throws; belt-and-braces */ }

  return { rootPath, ...res };
}

module.exports = { fireBootKbSync, resolveBootKbRoot };
