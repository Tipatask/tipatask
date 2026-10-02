'use strict';

// Pure logic for Electron's recent-projects list (main.js owns the file I/O). Each entry
// remembers WHO opened it — { path, userId, apiBaseUrl } — so the menu can show only the
// projects of the account that is signed in now. No fs, no Electron: node-testable.

const RECENT_PROJECTS_LIMIT = 10;
// The file keeps more than the menu shows so switching accounts does not evict the other
// account's history.
const RECENT_STORE_LIMIT = 50;

function sameUser(a, b) {
  return a != null && b != null && String(a) === String(b);
}

// Accepts the legacy shape (array of path strings) and the current one (array of entries).
// A string becomes a legacy entry: userId null, hidden until reconciled.
function normalizeRecentEntries(raw) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = typeof item === 'string'
      ? { path: item, userId: null, apiBaseUrl: '' }
      : item && typeof item === 'object'
        ? { path: item.path, userId: item.userId == null ? null : item.userId, apiBaseUrl: String(item.apiBaseUrl || '') }
        : null;
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push(entry);
    if (result.length >= RECENT_STORE_LIMIT) break;
  }
  return result;
}

// Move/insert at the front; a re-opened project takes the opening account's identity.
function upsertRecentEntry(entries, entry) {
  return normalizeRecentEntries([entry, ...entries.filter((e) => e.path !== entry.path)]);
}

// Paths shown to the signed-in user. userIdFor(apiBaseUrl) -> current account id on that
// server, or null when signed out (then nothing is visible). Legacy entries never show.
function visibleRecentPaths(entries, userIdFor) {
  const out = [];
  for (const e of entries) {
    if (e.userId == null) continue;
    if (!sameUser(e.userId, userIdFor(e.apiBaseUrl))) continue;
    out.push(e.path);
    if (out.length >= RECENT_PROJECTS_LIMIT) break;
  }
  return out;
}

// Resolve legacy (userId-less) entries for one server once the signed-in user's own project
// list is known. projectInfoFor(path) -> { apiBaseUrl, projectId } | null (null = no usable
// config). Owned project -> stamped with this user; not owned or no config -> dropped.
// Legacy entries whose project lives on another server are left for that server's pass.
function reconcileLegacyEntries(entries, { apiBaseUrl, userId, projectIds, projectInfoFor }) {
  const owned = new Set((projectIds || []).map(String));
  const out = [];
  for (const e of entries) {
    if (e.userId != null) { out.push(e); continue; }
    const info = projectInfoFor(e.path);
    if (info && info.apiBaseUrl && info.apiBaseUrl !== apiBaseUrl) { out.push(e); continue; }
    if (info && info.apiBaseUrl === apiBaseUrl && owned.has(String(info.projectId))) {
      out.push({ path: e.path, userId, apiBaseUrl });
    }
  }
  return out;
}

module.exports = {
  RECENT_PROJECTS_LIMIT,
  RECENT_STORE_LIMIT,
  normalizeRecentEntries,
  upsertRecentEntry,
  visibleRecentPaths,
  reconcileLegacyEntries,
};
