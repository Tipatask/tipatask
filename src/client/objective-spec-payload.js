// ── Objective-chat save payload: newTaskIds / originalSpec ──
// Extracted from chat-task-preview.js (C1376) so these two small, pure functions are
// importable in a plain Node test — chat-task-preview.js itself transitively pulls in
// browser-only modules (e.g. a raw .css import via console-modal.js) that fail to load
// under `node --test`.
import state from './state.js';

export function getOriginalSpec(cs) {
  const content = (cs || state.chatState)?.messages?.[0]?.content;
  return typeof content === 'string' && content.trim() ? content : null;
}

// C1376: newTaskIds and originalSpec are two unrelated concerns that used to be gated
// together behind `originalSpec && ids.length > 0` — a chat with no/blank first message
// (getOriginalSpec() -> null) silently dropped newTaskIds too, not just originalSpec.
// That's the ONLY signal overwriteRawWithRemap() has for "which cards are new" — losing
// it skips assignIncomingNewTaskIds()'s atomic reserveTaskKeys() entirely, so a reserved
// placeholder row (title "New task", see RESERVE_PLACEHOLDER_TITLE in
// api/src/routes/tasks.js) never gets PATCHed with the real proposed content and stays
// stuck off the board forever. newTaskIds now depends only on `ids.length > 0`;
// originalSpec keeps its own condition (a spec comment is only meaningful when there are
// new tasks to attach it to, api-backend.js's overwriteRaw()).
export function attachOriginalSpecPayload(data, newTaskIds, cs) {
  const ids = [...new Set((newTaskIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  const originalSpec = getOriginalSpec(cs);
  if (ids.length > 0) {
    data.newTaskIds = ids;
  } else {
    delete data.newTaskIds;
  }
  if (originalSpec && ids.length > 0) {
    data.originalSpec = originalSpec;
  } else {
    delete data.originalSpec;
  }
}
