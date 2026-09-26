'use strict';

const OBJECTIVE_HISTORY_TAIL_MESSAGES = 8;
const OBJECTIVE_HISTORY_PAGE_MESSAGES = 8;

function hasUnresolvedCards(message) {
  if (!message || !Array.isArray(message.cards) || message.cards.length === 0) return false;
  if (message.discarded) return false;
  if (!Array.isArray(message.confirmedMask) || message.confirmedMask.length === 0) return false;
  return message.cards.some((_, idx) => !message.confirmedMask[idx]);
}

function buildHistoryWindow(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const tailCount = Math.max(1, options.tailCount ?? OBJECTIVE_HISTORY_TAIL_MESSAGES);
  const preserveUnresolved = options.preserveUnresolved !== false;

  if (total === 0) {
    return {
      messages: [],
      historyWindowStart: 1,
      historyTotalCount: 0,
      hasOlderHistory: false,
    };
  }

  let historyWindowStart = Math.max(1, total - tailCount);
  if (preserveUnresolved) {
    for (let i = 1; i < total; i++) {
      if (hasUnresolvedCards(list[i])) {
        historyWindowStart = Math.min(historyWindowStart, i);
        break;
      }
    }
  }

  if (historyWindowStart <= 1) {
    return {
      messages: list,
      historyWindowStart: 1,
      historyTotalCount: total,
      hasOlderHistory: false,
    };
  }

  return {
    messages: [list[0], ...list.slice(historyWindowStart)],
    historyWindowStart,
    historyTotalCount: total,
    hasOlderHistory: historyWindowStart > 1,
  };
}

function buildHistoryChunk(messages, before, limit = OBJECTIVE_HISTORY_PAGE_MESSAGES) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const safeBefore = Math.max(1, Number(before) || 1);
  const pageSize = Math.max(1, Number(limit) || OBJECTIVE_HISTORY_PAGE_MESSAGES);
  const start = Math.max(1, safeBefore - pageSize);
  const end = Math.min(safeBefore, total);

  return {
    messages: start < end ? list.slice(start, end) : [],
    historyWindowStart: start,
    historyTotalCount: total,
    hasOlderHistory: start > 1,
  };
}

function mergeHistoryWindow(existingMessages, incomingMessages, historyWindowStart) {
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const start = Math.max(1, Number(historyWindowStart) || 1);

  if (incoming.length === 0) return existing;
  if (existing.length === 0 || start <= 1) return incoming;

  const firstMessage = incoming[0] || existing[0];
  const preservedMiddle = existing.slice(1, Math.min(start, existing.length));
  return [firstMessage, ...preservedMiddle, ...incoming.slice(1)];
}

module.exports = {
  OBJECTIVE_HISTORY_TAIL_MESSAGES,
  OBJECTIVE_HISTORY_PAGE_MESSAGES,
  buildHistoryWindow,
  buildHistoryChunk,
  mergeHistoryWindow,
};
