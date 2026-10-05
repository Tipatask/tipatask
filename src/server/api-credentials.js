'use strict';

const { readProjectConfig, migrateLegacyApiToken } = require('./project-config');
const { readAccount, decodeTokenPayload, assertTokenProject, accountStorePath } = require('./account-store');

function missingCredential(name) {
  const err = new Error(`API not configured for this project (missing ${name}${name === 'API_TOKEN' ? ' — sign in again' : ' in .tipatask/config.json'})`);
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

// Single runtime credential resolver. API_BASE_URL / API_PROJECT_ID come from the selected
// project's config.json, the token from the app-level account store; both are re-read on
// every call so re-auth changes apply without a server or MCP restart.
// `opts.watch` (from createTokenWatch()): when the resolved token differs from the last
// token or API target this same watch object saw, fires onChange(token, prevToken) once. A first read
// (prevToken === null) never fires — that's initial load, not a change. The callback is
// swallowed on error — a broken listener must never break credential resolution.
function getApiCredentials(projectRoot, opts = {}) {
  // Resolve the default lazily. Electron's main process always supplies an
  // explicit project root and must not initialize the forked server's static
  // config singleton merely to read one project's credentials.
  const root = projectRoot || require('./config').PROJECT_ROOT;
  let live = root ? readProjectConfig(root) : null;
  // A pre-account-store project still carries API_TOKEN inline: lift it into the store once
  // (and strip it from config.json), then re-read.
  if (opts.migrate !== false && live && Object.hasOwn(live, 'API_TOKEN') && migrateLegacyApiToken(root)) live = readProjectConfig(root);
  const baseUrl = String(live?.API_BASE_URL || '').replace(/\/+$/, '');
  // The signed-in account's token is app-level (account-store.js), keyed by API server. The
  // inline value only survives here when migration could not run (e.g. read-only checkout).
  const token = readAccount(baseUrl)?.token || (opts.migrate === false ? '' : live?.API_TOKEN) || '';
  const projectId = live?.API_PROJECT_ID || '';

  const watch = opts.watch;
  if (watch) {
    const prev = watch.last;
    const context = JSON.stringify([baseUrl, String(projectId)]);
    const previousContext = watch.context;
    watch.last = token;
    watch.context = context;
    if (prev !== null && (prev !== token || previousContext !== context)) {
      try { watch.onChange(token, prev); } catch (e) {
        console.warn('[api-credentials] token-watch listener error:', e.message);
      }
    }
  }

  if (!baseUrl) throw missingCredential('API_BASE_URL');
  if (!projectId) throw missingCredential('API_PROJECT_ID');
  if (!token) {
    const err = missingCredential('API_TOKEN');
    err.message = `No signed-in account token at ${accountStorePath()}. Check TIPATASK_USER_DATA or sign in again.`;
    throw err;
  }
  assertTokenProject(token, projectId);

  return { baseUrl, token, projectId };
}

// User id of the account signed in on `baseUrl`'s API server, or null when nobody is. Reads
// only the app-level account store (never a project's config.json), so it is cheap and safe
// for Electron's main process to call per menu build. Entries written before the store
// recorded userId fall back to the id claim inside the stored token.
function getAccountUserId(baseUrl) {
  const account = readAccount(baseUrl);
  if (!account) return null;
  if (account.userId != null) return account.userId;
  const id = decodeTokenPayload(account.token)?.id;
  return id != null ? id : null;
}

// Non-secret namespace for histories and provider continuations. Rotation retains
// identity; an API-server/project/account switch does not.
function projectContextIdentity(projectRoot) {
  if (!projectRoot) return '';
  const cfg = readProjectConfig(projectRoot);
  if (!cfg?.API_BASE_URL || !cfg?.API_PROJECT_ID) return '';
  const account = readAccount(cfg.API_BASE_URL);
  const userId = account?.userId ?? decodeTokenPayload(account?.token)?.id ?? null;
  return JSON.stringify([require('./account-store').normalizeBaseUrl(cfg.API_BASE_URL), String(cfg.API_PROJECT_ID), userId]);
}
module.exports = { getApiCredentials, createTokenWatch, getAccountUserId, projectContextIdentity };
