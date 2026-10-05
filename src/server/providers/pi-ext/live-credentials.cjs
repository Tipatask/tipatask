'use strict';
const fs = require('node:fs');
const path = require('node:path');

function payload(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); }
  catch { return null; }
}
function normalize(base) {
  const u = new URL(base);
  return (u.origin + u.pathname).replace(/\/+$/, '');
}
// Staged with the extension, so use only built-ins. Pin the launch target/account:
// token renewal is live, but changing account or project requires a fresh chat.
function liveCredentials(env) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(env.TIPATASK_PROJECT_ROOT, '.tipatask/config.json'), 'utf8'));
    const base = normalize(cfg.API_BASE_URL);
    if (base !== normalize(env.API_BASE_URL) || String(cfg.API_PROJECT_ID) !== String(env.API_PROJECT_ID)) throw new Error();
    const store = JSON.parse(fs.readFileSync(path.join(env.TIPATASK_USER_DATA, '.tipatask-account.json'), 'utf8'));
    const token = store.accounts?.[base]?.token;
    if (!token) throw new Error();
    const current = payload(token);
    const original = payload(env.API_TOKEN);
    if (current?.project_id != null && String(current.project_id) !== String(cfg.API_PROJECT_ID)) throw new Error();
    if (current?.id !== original?.id) throw new Error();
    return { ...env, API_TOKEN: token };
  } catch {
    throw new Error('Tipatask account or project changed, or account store is unavailable. Restart this chat after checking the project and sign-in.');
  }
}
module.exports = { liveCredentials };
