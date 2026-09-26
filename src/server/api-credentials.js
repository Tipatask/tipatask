'use strict';

const { readProjectConfig } = require('./project-config');

function missingCredential(name) {
  const err = new Error(`API not configured for this project (missing ${name} in .tipatask/config.json)`);
  err.missingCredentials = true;
  return err;
}

// (C1522) Per-caller token-change watcher. `getApiCredentials()` is shared across every
// backend instance in a process (module singleton, per-project instances, ws-handlers,
// MCP, CLI — see tt-api-backend.md § Files), so watcher state MUST live per-caller, not
// module-global: a module-global "last token" would be consumed by whichever caller
// reads first, and every other caller would never observe the change. Each backend
// instance owns its own watch object and passes it in as `opts.watch`.
function createTokenWatch(onChange) {
  return { last: null, onChange };
}

// Single runtime credential resolver. Always re-reads the selected project's
// config.json so re-auth changes apply without a server or MCP restart.
// `opts.watch` (from createTokenWatch()): when the resolved token differs from the last
// token this same watch object saw, fires onChange(token, prevToken) once. A first read
// (prevToken === null) never fires — that's initial load, not a change. The callback is
// swallowed on error — a broken listener must never break credential resolution.
function getApiCredentials(projectRoot, opts = {}) {
  // Resolve the default lazily. Electron's main process always supplies an
  // explicit project root and must not initialize the forked server's static
  // config singleton merely to read one project's credentials.
  const root = projectRoot || require('./config').PROJECT_ROOT;
  const live = root ? readProjectConfig(root) : null;
  const baseUrl = String(live?.API_BASE_URL || '').replace(/\/+$/, '');
  const token = live?.API_TOKEN || '';
  const projectId = live?.API_PROJECT_ID || '';

  if (!baseUrl) throw missingCredential('API_BASE_URL');
  if (!token) throw missingCredential('API_TOKEN');
  if (!projectId) throw missingCredential('API_PROJECT_ID');

  const watch = opts.watch;
  if (watch) {
    const prev = watch.last;
    watch.last = token;
    if (prev !== null && prev !== token) {
      try { watch.onChange(token, prev); } catch (e) {
        console.warn('[api-credentials] token-watch listener error:', e.message);
      }
    }
  }

  return { baseUrl, token, projectId };
}

module.exports = { getApiCredentials, createTokenWatch };
