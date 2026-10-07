'use strict';

// Task/project chat history: references to each provider's NATIVE session (Claude session id,
// Codex thread id, Pi session uuid) so a closed chat can be continued after a restart. The
// index (chat-persistence.js readChatHistory/upsertChatHistory) holds metadata only — never
// messages, tool output or widgets; the conversation itself lives in the provider's own store.
// This module knows where each provider keeps that store and whether a session is still there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeProjectDirName } = require('./task-agent/final-message');
const { ASK_USER_REMINDER, TASK_EDITS_RE } = require('./task-chat-widgets');

// Providers whose task-chat fence exists (providers/tool-profiles.js PROFILES.taskChat).
const HISTORY_PROVIDERS = ['claude', 'codex', 'pi'];
// Native ids become path segments below — anything else is never looked up.
const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HISTORY_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Search data kept on each entry is bounded so the index never grows with a conversation.
const KEYWORD_COUNT = 40;
const EXCERPT_CHARS = 200;
const KEYWORD_SOURCE_CHARS = 200 * 1024;

function isHistoryId(value) {
  return typeof value === 'string' && HISTORY_ID_RE.test(value);
}

// Where a spawn from `cwd` with `env` keeps this provider's sessions. Mirrors the spawn paths:
// Claude's own config dir (headless turns never set CLAUDE_CONFIG_DIR), Codex's project-local
// CODEX_HOME (codex-env.js buildCodexEnv → getCodexPaths), Pi's session dir
// (pi-custom-endpoint.js — an explicit PI_CODING_AGENT_SESSION_DIR, else Pi's per-cwd default).
function nativeStorageRef(provider, cwd, env = process.env) {
  const root = path.resolve(String(cwd || ''));
  if (provider === 'claude') {
    return { claudeConfigDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) };
  }
  if (provider === 'codex') return { codexHome: path.resolve(root, '.codex') };
  if (provider === 'pi') {
    const { piDefaultSessionDir } = require('./pi-custom-endpoint');
    return { piSessionDir: path.resolve(env.PI_CODING_AGENT_SESSION_DIR || piDefaultSessionDir(root, env)) };
  }
  return null;
}

function sameStorage(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function locateClaude(entry, root, storage) {
  const projects = path.join(storage.claudeConfigDir, 'projects');
  const name = `${entry.nativeSessionId}.jsonl`;
  const roots = [root];
  try { const real = fs.realpathSync(root); if (real !== root) roots.push(real); } catch { /* missing cwd */ }
  for (const r of roots) {
    const file = path.join(projects, claudeProjectDirName(r), name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Codex names rollouts `rollout-<timestamp>-<thread id>.jsonl` under sessions/YYYY/MM/DD.
function codexRollouts(codexHome, cache) {
  const key = `codex\0${codexHome}`;
  if (cache.has(key)) return cache.get(key);
  const byId = new Map();
  const sessions = path.join(codexHome, 'sessions');
  for (const y of safeReaddir(sessions)) {
    for (const m of safeReaddir(path.join(sessions, y))) {
      for (const d of safeReaddir(path.join(sessions, y, m))) {
        const dir = path.join(sessions, y, m, d);
        for (const name of safeReaddir(dir)) {
          const match = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
          if (match) byId.set(match[1].toLowerCase(), path.join(dir, name));
        }
      }
    }
  }
  cache.set(key, byId);
  return byId;
}

// Pi names sessions `<iso timestamp>_<uuid>.jsonl` in its session dir.
function piSessions(dir, cache) {
  const key = `pi\0${dir}`;
  if (cache.has(key)) return cache.get(key);
  const byId = new Map();
  for (const name of safeReaddir(dir)) {
    const match = /_([^_]+)\.jsonl$/.exec(name);
    if (match) byId.set(match[1].toLowerCase(), path.join(dir, name));
  }
  cache.set(key, byId);
  return byId;
}

// Whether an entry can be resumed from `cwd` with `env`, and why not: `provider` (no task-chat
// fence for it), `checkout` (recorded for another checkout, CLAUDE_CONFIG_DIR or Pi session dir —
// a resume there would start a new conversation), `missing` (the provider no longer holds the
// session). `file` is the native session file when available. `cache` lets one listing share
// directory scans across entries.
function historyAvailability(entry, { cwd, env = process.env } = {}, cache = new Map()) {
  const no = reason => ({ available: false, reason, file: null });
  if (!entry || !HISTORY_PROVIDERS.includes(entry.provider)) return no('provider');
  if (typeof entry.nativeSessionId !== 'string' || !NATIVE_ID_RE.test(entry.nativeSessionId)) return no('missing');
  const root = path.resolve(String(cwd || ''));
  if (!entry.cwd || path.resolve(entry.cwd) !== root) return no('checkout');
  const storage = nativeStorageRef(entry.provider, root, env);
  if (!sameStorage(storage, entry.storage)) return no('checkout');
  const id = entry.nativeSessionId.toLowerCase();
  let file = null;
  if (entry.provider === 'claude') file = locateClaude(entry, root, storage);
  else if (entry.provider === 'codex') file = codexRollouts(storage.codexHome, cache).get(id) || null;
  else file = piSessions(storage.piSessionDir, cache).get(id) || null;
  return file ? { available: true, reason: null, file } : no('missing');
}

// The native session file an entry points at, or null when it is gone, unreadable, or kept in
// a store a spawn from this cwd/env would not look in.
function locateNativeSession(entry, opts = {}, cache = new Map()) {
  return historyAvailability(entry, opts, cache).file;
}

// ── Search data: keywords + excerpts, extracted locally from the chat's own messages ──

// Internal attachment URLs (task-chat composer uploads) and inline blobs carry no meaning.
const ATTACHMENT_URL_RE = /\/api\/(?:projects\/[^/\s)]+\/)?(?:images|files)\/|^(?:blob|data):/i;
const WIDGET_FENCE_RE = /```(?:ask_user|task_edits)[^\n]*\n[\s\S]*?(?:```|$)/gi;

// Message text as a person reads it: no task_edits / ask_user blocks, no resume reminder, no
// attachment references or URLs. `keepCode` keeps the inside of code fences (identifiers are
// good search terms); otherwise fenced blocks are dropped (excerpts).
function cleanChatText(text, { keepCode = false } = {}) {
  let s = String(text || '');
  s = s.replace(TASK_EDITS_RE, '');
  s = s.split(ASK_USER_REMINDER).join(' ');
  s = s.replace(WIDGET_FENCE_RE, ' ');
  s = keepCode ? s.replace(/```[^\n]*\n?/g, ' ') : s.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, label, url) => (ATTACHMENT_URL_RE.test(url.trim()) ? ' ' : label));
  s = s.replace(/\b(?:https?:\/\/|blob:|data:)\S+/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function clipExcerpt(text, max = EXCERPT_CHARS) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

const STOPWORDS = new Set((
  // en
  'the and for are but not you all any can had her was one our out has him his how its may new now old see two way who '
  + 'did get got let put say she too use this that with have from they will would there their what about which when make '
  + 'like time just know take into year your some could them than then look only come over also back after work first well '
  + 'even want because these give most here need should does done each where more much very such being been were doing '
  + 'into onto upon while until those other another same able yes yeah okay please thanks thank sure maybe still again '
  + 'ever every through though without within between before above below under again further once both few own off why '
  + 'whom whose shall might must cannot can\'t don\'t didn\'t isn\'t it\'s i\'m i\'ll i\'ve you\'re we\'re that\'s there\'s '
  + 'let\'s won\'t doesn\'t wasn\'t aren\'t haven\'t hasn\'t ours yours mine via etc'
  // uk
  + ' але або алеж бо був була було були буде будуть вам вас ваш ваша ваше ваші вже від він вона воно вони все всі всього '
  + 'для де дуже його її їх їм йому коли куди лише мене мені може можна мій моя моє мої над нам нас наш наша наше наші '
  + 'немає нею них ним ніж ось перед під після при про саме свій своє свої себе собі так також там тебе тобі того тоді той '
  + 'тому треба тут тут цей цим цих цього ця цю ці це чи чого чому шо що щоб щось якби який яка яке які як якщо ще'
  + ' аби адже ані бути вже весь вся всю зараз знову інший інша інше інші кожен кожна кожне між навіть отже поки проте '
  + 'через щодо тільки теж тим тих ті та'
).split(/\s+/).filter(Boolean));

const TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}_']|[.\-](?=[\p{L}\p{N}]))*/gu;

// Task keys (TPT539), file names, snake/kebab/camel identifiers rank above plain words.
function isIdentifier(raw) {
  return /^[A-Za-z]{1,8}-?\d+$/.test(raw) || /[_.\-]/.test(raw) || /\p{Ll}\p{Lu}/u.test(raw)
    || (/\d/.test(raw) && /\p{L}/u.test(raw));
}

// Up to `max` lower-cased, de-duplicated search terms by weighted frequency (identifiers ×2).
// `prior` (the stored keywords of a resumed chat) count as two occurrences each, so earlier
// context stays searchable. Ties keep first appearance; prior terms come after the text's own.
function extractKeywords(texts, { prior = [], max = KEYWORD_COUNT } = {}) {
  let source = (Array.isArray(texts) ? texts : [texts]).filter(t => typeof t === 'string' && t).join('\n');
  if (source.length > KEYWORD_SOURCE_CHARS) source = source.slice(-KEYWORD_SOURCE_CHARS);
  const scores = new Map();
  let order = 0;
  const add = (term, weight) => {
    const cur = scores.get(term);
    if (cur) cur.weight += weight;
    else scores.set(term, { weight, order: order++ });
  };
  for (const match of source.matchAll(TOKEN_RE)) {
    const raw = match[0].replace(/'+$/, '');
    const term = raw.toLowerCase();
    if (term.length > 48 || STOPWORDS.has(term)) continue;
    if (/^[\d.\-_]+$/.test(term)) continue;
    if (term.length < 3 && !(/\d/.test(term) && /\p{L}/u.test(term))) continue;
    add(term, isIdentifier(raw) ? 2 : 1);
  }
  for (const k of Array.isArray(prior) ? prior : []) {
    if (typeof k === 'string' && k && k.length <= 48) add(k.toLowerCase(), 2);
  }
  return [...scores.entries()]
    .sort((a, b) => (b[1].weight - a[1].weight) || (a[1].order - b[1].order))
    .slice(0, max)
    .map(([term]) => term);
}

// The entry's search data from a chat's session.messages (restored messages included; the
// generated seed and the hidden resume marker are not conversation). `prior` is the stored
// { keywords, first, latest } of the entry a chat was resumed from.
function buildSearchData(messages, prior = null) {
  const conv = (Array.isArray(messages) ? messages : [])
    .filter(m => m && !m.seed && !m.resumed && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  const userTexts = conv.filter(m => m.role === 'user').map(m => cleanChatText(m.content)).filter(Boolean);
  const first = (prior && prior.first) || clipExcerpt(userTexts[0] || '');
  const latest = clipExcerpt(userTexts[userTexts.length - 1] || '') || (prior && prior.latest) || '';
  return {
    keywords: extractKeywords(conv.map(m => cleanChatText(m.content, { keepCode: true })), { prior: prior && prior.keywords }),
    excerpts: { first: first || '', latest: latest || '' },
  };
}

function matchesQuery(e, needle) {
  if ([e.title, e.taskKey, e.provider, e.model].some(v => typeof v === 'string' && v.toLowerCase().includes(needle))) return true;
  if (Array.isArray(e.keywords) && e.keywords.some(k => typeof k === 'string' && k.includes(needle))) return true;
  const ex = e.excerpts || {};
  return [ex.first, ex.latest].some(v => typeof v === 'string' && v.toLowerCase().includes(needle));
}

// Case-insensitive substring search over the listed metadata and search data (keywords,
// excerpts), newest activity first.
function filterHistory(entries, { projectId, taskKey, kind, q, limit } = {}) {
  const wantKey = typeof taskKey === 'string' && taskKey.trim() ? taskKey.trim().toUpperCase() : '';
  const wantKind = wantKey ? 'task' : (kind === 'task' || kind === 'project' ? kind : '');
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const max = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
  return (Array.isArray(entries) ? entries : [])
    .filter(e => e && (projectId == null || String(e.projectId) === String(projectId)))
    .filter(e => !wantKind || e.kind === wantKind)
    .filter(e => !wantKey || String(e.taskKey || '').toUpperCase() === wantKey)
    .filter(e => !needle || matchesQuery(e, needle))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, max);
}

// What leaves the server: no native id, cwd or storage paths. `availability` is
// historyAvailability()'s result (a bare boolean is still accepted).
function publicHistoryRow(entry, availability) {
  const available = typeof availability === 'object' && availability !== null ? !!availability.available : !!availability;
  const ex = entry.excerpts || {};
  return {
    historyId: entry.historyId,
    kind: entry.kind,
    taskKey: entry.taskKey || null,
    title: entry.title || '',
    provider: entry.provider,
    model: entry.model || null,
    createdAt: entry.createdAt || null,
    lastActivityAt: entry.lastActivityAt || null,
    endedAt: entry.endedAt || null,
    available,
    unavailableReason: available ? null : ((availability && availability.reason) || 'missing'),
    keywords: Array.isArray(entry.keywords) ? entry.keywords.slice(0, KEYWORD_COUNT) : [],
    excerpts: {
      first: typeof ex.first === 'string' ? ex.first : '',
      latest: typeof ex.latest === 'string' ? ex.latest : '',
    },
  };
}

module.exports = {
  HISTORY_PROVIDERS,
  isHistoryId,
  nativeStorageRef,
  locateNativeSession,
  historyAvailability,
  cleanChatText,
  clipExcerpt,
  extractKeywords,
  buildSearchData,
  KEYWORD_COUNT,
  EXCERPT_CHARS,
  filterHistory,
  publicHistoryRow,
};
