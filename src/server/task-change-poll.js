'use strict';

// Poll each project's backend independently: packaged Electron shares one server
// among windows, so a singleton hash misses other projects. Broadcast per project;
// retain the rootless fallback for single-project callers.

// TPT12 — how often (in ticks, i.e. every Nth 10s tick) the poll also fetches unread
// `notifications` inbox rows and diffs them into a `task-activity` broadcast. Task changes
// need the fast 10s cadence; a teammate's comment does not, so this runs 3x slower — cuts
// the added DB load (one joined SELECT + two COUNT(*) per project, see
// api/src/routes/notifications.js) to ~2 req/min/project instead of 6. A named export so
// tests can drive it directly instead of calling tick() 3 times.
const NOTIFICATIONS_EVERY_N_TICKS = 3;

/**
 * @param {object} opts
 * @param {object} opts.wss                WebSocketServer instance (reads .clients)
 * @param {(projectPath: string) => object} opts.getBackendForPath  per-project backend resolver (index.js)
 * @param {object} opts.websocket          websocket.js module (broadcastToProject)
 * @param {(msg: string) => void} [opts.log]      TEST SEAM — defaults to console.log
 * @param {(msg: string) => void} [opts.warn]     TEST SEAM — defaults to console.warn
 * @param {() => boolean} [opts.isSingletonUnbound] TEST SEAM — reports whether the singleton
 *   backend (what an empty projectPath resolves to) has no real project bound. When true,
 *   a watched client with no `_projectPath` is skipped with a once-per-boot warning instead
 *   of throwing every tick against dead credentials.
 * @param {number} [opts.notificationsEveryNTicks] TEST SEAM — overrides NOTIFICATIONS_EVERY_N_TICKS.
 * @returns {{ tick: () => Promise<void> }}
 */
function createTaskChangePoll({
  wss, getBackendForPath, websocket, log = console.log, warn = console.warn,
  isSingletonUnbound = () => false, notificationsEveryNTicks = NOTIFICATIONS_EVERY_N_TICKS,
}) {
  const _lastHashByProject = new Map(); // projectPath ('' = singleton) → md5 hex
  const _lastActivityHashByProject = new Map(); // projectPath → md5 hex of the reduced activity snapshot
  const _tickCountByProject = new Map(); // projectPath → number of ticks seen (for the every-Nth gate)
  let _warnedUnboundSingleton = false;

  // TPT12 — reduce a project's unread `notifications` rows (TPT10) into a per-task-key
  // summary for the board's activity chip + OS push. Rows with no task_key (deleted task,
  // or a project-level row) are dropped — there's no card to attach them to.
  function _reduceActivity(notifications) {
    const activity = {};
    for (const row of notifications) {
      if (!row.task_key) continue;
      let entry = activity[row.task_key];
      if (!entry) {
        entry = { count: 0, ids: [], latest: null };
        activity[row.task_key] = entry;
      }
      entry.count += 1;
      entry.ids.push(row.id);
      // Rows arrive newest-first (routes/notifications.js: ORDER BY created_at DESC, id DESC)
      // — the first one seen per task is the latest.
      if (!entry.latest) {
        entry.latest = {
          id: row.id,
          title: row.title,
          body: row.body,
          event_type: row.event_type,
          actor: row.actor,
          created_at: row.created_at,
        };
      }
    }
    return activity;
  }

  async function _tickProjectActivity(projectPath, backend) {
    if (typeof backend.getNotifications !== 'function') return;
    // (C-guard) Never let this be the first request of a tick against a backend already
    // having auth trouble — an extra request here must not be what trips the
    // `unauthorized` latch (see auth-guard.js) for a project with real credential issues.
    if (typeof backend.getConnectionState === 'function' && backend.getConnectionState() !== 'connected') return;

    const result = await backend.getNotifications({ unreadOnly: true, limit: 200 });
    const notifications = result?.notifications || [];
    const unreadCount = result?.unread_count || 0;
    if (unreadCount > notifications.length) {
      warn(`[poll] project=${projectPath || '<default>'} notifications truncated: ${unreadCount} unread but only ${notifications.length} fit in the 200-row cap`);
    }

    const activity = _reduceActivity(notifications);
    const crypto = require('node:crypto');
    const hash = crypto.createHash('md5').update(JSON.stringify(activity)).digest('hex');
    const lastHash = _lastActivityHashByProject.get(projectPath);
    // Unlike the task-hash diff above, broadcast on the FIRST computation too (lastHash
    // undefined counts as "changed") — a client that only ever WS-connects (no HTTP
    // board-init fetch) still needs an initial snapshot, and the client-side reducer
    // (task-activity.js) already treats its own first-ever applied snapshot as a silent
    // baseline, so a redundant frame after a server restart is harmless.
    if (hash !== lastHash) {
      log(`[poll] project=${projectPath || '<default>'} activity changed, broadcasting task-activity`);
      websocket.broadcastToProject(projectPath, 'task-activity', { activity });
    }
    _lastActivityHashByProject.set(projectPath, hash);
  }

  function _watchedProjectPaths() {
    const paths = new Set();
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (!client._boardWatcher && !client._attentionSubscriber) continue;
      paths.add(client._projectPath || '');
    }
    return paths;
  }

  async function _tickOneProject(projectPath) {
    if (!projectPath && isSingletonUnbound()) {
      if (!_warnedUnboundSingleton) {
        _warnedUnboundSingleton = true;
        warn('[poll] singleton backend has no project bound — skipping unstamped client(s) (this should only happen for a stray connection with no ?projectPath=)');
      }
      return;
    }
    const backend = getBackendForPath(projectPath);
    const tasks = await (backend.getTasksUnfiltered ? backend.getTasksUnfiltered() : backend.getTasks());
    const crypto = require('node:crypto');
    const hash = crypto.createHash('md5').update(JSON.stringify(tasks)).digest('hex');
    const lastHash = _lastHashByProject.has(projectPath) ? _lastHashByProject.get(projectPath) : null;
    if (lastHash !== null && hash !== lastHash) {
      log(`[poll] project=${projectPath || '<default>'} tasks changed, broadcasting tasks-updated`);
      websocket.broadcastToProject(projectPath, 'tasks-updated');
    }
    _lastHashByProject.set(projectPath, hash);

    // TPT12 — every Nth tick, also diff unread notifications into a task-activity broadcast.
    // Own try/catch: a notifications-fetch failure (transient API hiccup, a deployment that
    // predates this route, a project mid-auth-trouble) must never suppress the tasks-updated
    // broadcast above, and must never make this project's whole tick() entry reject.
    const tickCount = (_tickCountByProject.get(projectPath) || 0) + 1;
    _tickCountByProject.set(projectPath, tickCount);
    if (tickCount % notificationsEveryNTicks === 0) {
      try {
        await _tickProjectActivity(projectPath, backend);
      } catch (err) {
        warn(`[poll] Failed to poll notifications for project=${projectPath || '<default>'}: ${err && err.message}`);
      }
    }
  }

  async function tick() {
    const paths = [..._watchedProjectPaths()];
    if (paths.length === 0) return;
    // Promise.allSettled — one project's fetch throwing (e.g. a transient API hiccup on
    // just that project) must never stall or skip every other open project's poll.
    const results = await Promise.allSettled(paths.map((p) => _tickOneProject(p)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        warn(`[poll] Failed to poll tasks for project=${paths[i] || '<default>'}: ${results[i].reason && results[i].reason.message}`);
      }
    }
  }

  return { tick };
}

module.exports = { createTaskChangePoll, NOTIFICATIONS_EVERY_N_TICKS };
