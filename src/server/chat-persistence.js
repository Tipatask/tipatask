'use strict';

// Machine-local per-project objective chat state, plus the task/project chat history index
// (native LLM session references, metadata only). The API backend does not own these files.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { mergeHistoryWindow } = require('./objective-history');

const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
// Task/project chat history index (chat-history.js): newest entries kept, oldest dropped.
const CHAT_HISTORY_MAX_ENTRIES = 200;
const CHAT_HISTORY_VERSION = 1;
const CHAT_DRAFT_VERSION = 2;
const RELATIONSHIP_FIELDS = ['parentTaskKey', 'objectiveParentKey', 'originTaskKey', 'originResolution'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validateDraftRelationship(options) {
  if (hasOwn(options, 'draftVersion') && options.draftVersion !== CHAT_DRAFT_VERSION) {
    const err = new Error('Unsupported chat draft version');
    err.code = 'INVALID_CHAT_DRAFT';
    throw err;
  }
  if (options.draftVersion === CHAT_DRAFT_VERSION && RELATIONSHIP_FIELDS.some(field => !hasOwn(options, field))) {
    const err = new Error('Versioned chat draft requires all relationship fields');
    err.code = 'INVALID_CHAT_DRAFT';
    throw err;
  }
  for (const field of RELATIONSHIP_FIELDS) {
    if (!hasOwn(options, field)) continue;
    const value = options[field];
    const valid = value === null || (field === 'originResolution'
      ? value === 'single' || value === 'parent'
      : typeof value === 'string' && value.trim().length > 0);
    if (!valid) {
      const err = new Error(`Invalid ${field}`);
      err.code = 'INVALID_CHAT_DRAFT';
      throw err;
    }
  }
}

function hashProject(projectPath) {
  const identity = require('./api-credentials').projectContextIdentity(projectPath);
  // Do not guess an owner for legacy path-only drafts after configuration.
  return crypto.createHash('md5').update(String(projectPath) + (identity ? '\0' + identity : '')).digest('hex').slice(0, identity ? 16 : 8);
}

function createChatPersistence({ fsOps = fs, userDataRoot = config.USER_DATA_ROOT } = {}) {
  const queues = new Map();

  function chatDraftPath(projectPath) {
    return path.join(userDataRoot, projectPath
      ? `.chat-draft-${hashProject(projectPath)}.json`
      : '.chat-draft.json');
  }

  function chatStatePath(projectPath) {
    return path.join(userDataRoot, projectPath
      ? `chat-state-${hashProject(projectPath)}.json`
      : 'chat-state.json');
  }

  // Queue all operations for one project, including reads and deletes. A rejected operation
  // must not poison later operations, and idle project keys must not stay in memory.
  function forProject(projectPath, operation) {
    const key = String(projectPath || '');
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.then(operation);
    const tail = result.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }

  // A crash can leave an incomplete temp file. The live path is always authoritative;
  // old temp files are best-effort housekeeping, never candidates for restore.
  async function cleanupStaleTemps(filePath) {
    const directory = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.tmp-`;
    try {
      const names = await fsOps.readdir(directory);
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const tempPath = path.join(directory, name);
        try {
          const info = await fsOps.stat(tempPath);
          if (Date.now() - info.mtimeMs >= STALE_TEMP_MS) await fsOps.unlink(tempPath);
        } catch { /* a concurrent cleanup or inaccessible orphan must not block chat */ }
      }
    } catch { /* a missing or inaccessible directory is handled by the real operation */ }
  }

  async function atomicWrite(filePath, contents) {
    const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fsOps.open(tempPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsOps.rename(tempPath, filePath);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* preserve original error */ }
      }
      try { await fsOps.unlink(tempPath); } catch { /* preserve original error */ }
      throw error;
    }
  }

  async function readDraftFile(filePath) {
    try {
      return JSON.parse(await fsOps.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readChatDraft(projectPath) {
    const filePath = chatDraftPath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      return readDraftFile(filePath);
    });
  }

  async function writeChatDraft(messages, taskId, options = {}, projectPath) {
    validateDraftRelationship(options);
    const filePath = chatDraftPath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      const historyWindowStart = Math.max(1, Number(options.historyWindowStart) || 1);
      let mergedMessages = Array.isArray(messages) ? messages : [];
      let existing = null;
      let sameConversation = false;

      // Read the current draft inside this project's queue, so a history-window merge or
      // relationship carry-forward always sees the previous write.
      if (historyWindowStart > 1 || RELATIONSHIP_FIELDS.some(field => !hasOwn(options, field))) {
        existing = await readDraftFile(filePath);
        const sameTask = !taskId || !existing?.taskId || existing.taskId === taskId;
        sameConversation = !!taskId && existing?.taskId === taskId;
        if (historyWindowStart > 1 && existing && Array.isArray(existing.messages) && sameTask) {
          mergedMessages = mergeHistoryWindow(existing.messages, mergedMessages, historyWindowStart);
        }
      }

      const payload = { messages: mergedMessages, savedAt: Date.now() };
      if (taskId) payload.taskId = taskId;
      if (options.draftVersion === CHAT_DRAFT_VERSION || (sameConversation && existing?.draftVersion === CHAT_DRAFT_VERSION)) {
        payload.draftVersion = CHAT_DRAFT_VERSION;
      }
      for (const field of RELATIONSHIP_FIELDS) {
        if (hasOwn(options, field)) payload[field] = options[field];
        else if (sameConversation && hasOwn(existing, field)) payload[field] = existing[field];
      }
      if (options.objectiveModel) payload.objectiveModel = options.objectiveModel;
      if ((options.rehashIntent === 'split' || options.rehashIntent === 'discuss') && typeof options.taskKey === 'string') {
        payload.rehashIntent = options.rehashIntent;
        payload.taskKey = options.taskKey;
        if (options.lockReleased === true) payload.lockReleased = true;
      }
      await atomicWrite(filePath, JSON.stringify(payload, null, 2));
    });
  }

  async function deleteChatDraft(projectPath) {
    const filePath = chatDraftPath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      try { await fsOps.unlink(filePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  }

  async function readChatState(projectPath) {
    const filePath = chatStatePath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      try { return await fsOps.readFile(filePath, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
  }

  async function writeChatState(body, projectPath) {
    const filePath = chatStatePath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      await atomicWrite(filePath, body);
    });
  }

  async function deleteChatState(projectPath) {
    const filePath = chatStatePath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      try { await fsOps.unlink(filePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  }

  function chatHistoryPath(projectPath) {
    return path.join(userDataRoot, projectPath
      ? `chat-history-${hashProject(projectPath)}.json`
      : 'chat-history.json');
  }

  // A missing index is an empty history. A malformed one is too (with a warning): the index
  // only points at provider-owned sessions, so losing it must never block a chat.
  async function readHistoryFile(filePath) {
    let raw;
    try { raw = await fsOps.readFile(filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries.filter(e => e && typeof e.historyId === 'string') : [];
    } catch {
      console.warn(`[chat-history] ignoring malformed index ${filePath}`);
      return [];
    }
  }

  async function readChatHistory(projectPath) {
    const filePath = chatHistoryPath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      return readHistoryFile(filePath);
    });
  }

  // Insert or merge one entry by historyId. createdAt of an existing entry is kept; the list is
  // stored newest-activity first and capped, so the oldest entries fall off.
  async function upsertChatHistory(projectPath, entry) {
    if (!entry || typeof entry.historyId !== 'string' || !entry.historyId) {
      const err = new Error('Chat history entry requires a historyId');
      err.code = 'INVALID_CHAT_HISTORY';
      throw err;
    }
    const filePath = chatHistoryPath(projectPath);
    return forProject(projectPath, async () => {
      await cleanupStaleTemps(filePath);
      const entries = await readHistoryFile(filePath);
      const index = entries.findIndex(e => e.historyId === entry.historyId);
      const previous = index >= 0 ? entries[index] : null;
      const now = Date.now();
      const saved = {
        ...(previous || {}),
        ...entry,
        createdAt: previous?.createdAt || entry.createdAt || now,
        lastActivityAt: entry.lastActivityAt || now,
      };
      if (index >= 0) entries.splice(index, 1);
      entries.unshift(saved);
      entries.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
      const kept = entries.slice(0, CHAT_HISTORY_MAX_ENTRIES);
      await atomicWrite(filePath, JSON.stringify({ version: CHAT_HISTORY_VERSION, entries: kept }, null, 2));
      return saved;
    });
  }

  return {
    readChatDraft, writeChatDraft, deleteChatDraft, readChatState, writeChatState, deleteChatState,
    readChatHistory, upsertChatHistory,
  };
}

module.exports = { ...createChatPersistence(), createChatPersistence, CHAT_HISTORY_MAX_ENTRIES };
