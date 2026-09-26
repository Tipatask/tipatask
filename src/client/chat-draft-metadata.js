// Relationship metadata belongs to the always-on draft: chat-state.json exists only
// while accepted cards are still unsaved.
export const CHAT_DRAFT_VERSION = 2;

const RELATIONSHIP_FIELDS = ['parentTaskKey', 'objectiveParentKey', 'originTaskKey', 'originResolution'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function draftRelationshipForSave(chatState) {
  return {
    draftVersion: CHAT_DRAFT_VERSION,
    parentTaskKey: chatState.parentTaskKey || null,
    objectiveParentKey: chatState.objectiveParentKey || null,
    originTaskKey: chatState.originTaskKey || null,
    originResolution: chatState.originResolution || null,
  };
}

export function draftRelationshipNeedsLegacyFallback(draft) {
  return RELATIONSHIP_FIELDS.some(field => !hasOwn(draft, field));
}

function hasUnsavedCards(snapshot) {
  return Array.isArray(snapshot?.messages) && snapshot.messages.some(message =>
    Array.isArray(message.cards) && message.cards.length > 0 &&
    (message.acceptedMask || []).some((accepted, index) => accepted && !(message.confirmedMask || [])[index])
  );
}

export function restoreDraftRelationship(draft, snapshot = null) {
  // A legacy draft may be accompanied by a richer chat-state snapshot. Only
  // borrow fields from the same conversation while that snapshot is still live.
  const fallback = snapshot?.taskId && snapshot.taskId === draft.taskId && hasUnsavedCards(snapshot)
    ? snapshot : null;
  const field = name => {
    if (hasOwn(draft, name)) return draft[name]; // explicit null clears a link
    if (hasOwn(fallback, name)) return fallback[name];
    return null;
  };
  const parentTaskKey = hasOwn(draft, 'parentTaskKey') || hasOwn(fallback, 'parentTaskKey')
    ? field('parentTaskKey')
    : draft.rehashIntent === 'split' ? draft.taskKey || null : null;
  return {
    parentTaskKey,
    objectiveParentKey: field('objectiveParentKey'),
    originTaskKey: field('originTaskKey'),
    originResolution: field('originResolution'),
  };
}
