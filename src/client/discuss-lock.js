// ── (TPT271/TPT283) Discuss lock ──
// Board task keys currently locked by an objective tab opened via Rehash → Discuss or
// Rehash → Split (LOCKING_INTENTS). Pure (no imports) so node:test can load it directly.
// chat-ui.js#syncDiscussLocks() is the only writer of state.discussingTaskKeys and
// state.discussLockIntents; board code reads via isTaskDiscussing()/lockIntentOf().
//
// Tab-row fields win over chatState: spawnObjectiveTab() stamps rehashIntent/taskKey on the
// tab row, and tab.chatState stays null until the first turn is sent. Restored tabs carry
// the same fields on both, so the chatState fallback only matters for odd partial rows.
//
// lockReleased: a saved Split chat keeps rehashIntent/taskKey (later accepts in the same chat
// still need split mode), so releaseDiscussLock() stamps this flag instead of clearing them.

const LOCKING_INTENTS = new Set(['discuss', 'split']);

function lockOf(tab) {
  if (!tab) return null;
  const hasOwn = tab.rehashIntent !== undefined || tab.taskKey !== undefined;
  const src = hasOwn ? tab : tab.chatState;
  if (!src || !LOCKING_INTENTS.has(src.rehashIntent) || !src.taskKey || src.lockReleased) return null;
  return { key: String(src.taskKey), intent: src.rehashIntent };
}

function discussKeyOf(tab) {
  return lockOf(tab)?.key ?? null;
}

export function collectDiscussingKeys(tabs) {
  const keys = new Set();
  if (!Array.isArray(tabs)) return keys;
  for (const tab of tabs) {
    const key = discussKeyOf(tab);
    if (key) keys.add(key);
  }
  return keys;
}

// key → 'discuss' | 'split'. First tab for a key wins.
export function collectLockIntents(tabs) {
  const intents = new Map();
  if (!Array.isArray(tabs)) return intents;
  for (const tab of tabs) {
    const lock = lockOf(tab);
    if (lock && !intents.has(lock.key)) intents.set(lock.key, lock.intent);
  }
  return intents;
}

export function isTaskDiscussing(state, key) {
  return !!key && state?.discussingTaskKeys instanceof Set && state.discussingTaskKeys.has(String(key));
}

// 'discuss' | 'split' for a locked key, null when unlocked.
export function lockIntentOf(state, key) {
  if (!isTaskDiscussing(state, key)) return null;
  const intents = state.discussLockIntents;
  return (intents instanceof Map && intents.get(String(key))) || 'discuss';
}

// i18n key naming the lock's mode (hourglass tooltip, edit-refusal toast).
export function lockMessageKey(intent) {
  return intent === 'split' ? 'card.splitting' : 'card.discussing';
}

export function sameKeySet(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return false;
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

export function sameIntentMap(a, b) {
  if (!(a instanceof Map) || !(b instanceof Map)) return false;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
