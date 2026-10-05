'use strict';

// Machine-local per-project objective chat state. The API backend does not own these files.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { mergeHistoryWindow } = require('./objective-history');

const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
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

  return { readChatDraft, writeChatDraft, deleteChatDraft, readChatState, writeChatState, deleteChatState };
}

module.exports = { ...createChatPersistence(), createChatPersistence };
