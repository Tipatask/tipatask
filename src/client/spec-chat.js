import { buildWsUrl, wsSend } from './ws-client.js';
import { renderMarkdown, escapeAttr, renderTagBadge, showSaveToast } from './utils.js';
import state from './state.js';
import { attachImagePaste } from './task-board.js';
import { showActionConfirm } from './action-confirm.js';
import { t } from './i18n.js';

let ws = null;
let currentTaskId = null;
let task = null;
let messages = []; // [{ role: 'user'|'assistant'|'system', content, streaming? }]
let _keyHandler = null;
let _isReconnect = false;

export async function open(taskId) {
  if (currentTaskId) close();
  currentTaskId = taskId;
  messages = [];
  _isReconnect = false;

  let taskData;
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
    taskData = await res.json();
  } catch {
    taskData = { id: taskId, title: taskId, description: '', tags: [] };
  }
  task = taskData;

  _renderModal();
  _connectWs();
}

export function close() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const el = document.querySelector('.spec-chat-modal');
  if (el) el.remove();
  document.documentElement.style.overflowY = '';
  document.body.style.paddingRight = '';
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  currentTaskId = null;
  task = null;
  messages = [];
}

function _renderModal() {
  const overlay = document.createElement('div');
  overlay.className = 'spec-chat-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const tags = (task.tags || []).map(t => renderTagBadge(t, state.tagDescriptions)).join('');
  const desc = renderMarkdown(task.description || '');

  overlay.innerHTML = `
    <div class="spec-chat-backdrop" data-close></div>
    <div class="spec-chat-panel">
      <div class="spec-chat-header">
        <div class="spec-chat-title">
          <span class="spec-chat-task-key">#${escapeAttr(String(task.id))}</span>
          <span class="spec-chat-task-title-text">${escapeAttr(task.title || '')}</span>
        </div>
        <div class="spec-chat-header-actions">
          <button class="spec-chat-cancel" aria-label="Cancel and discard">Cancel</button>
          <button class="spec-chat-close" data-close aria-label="Close">×</button>
        </div>
      </div>
      ${(desc || tags) ? `
      <div class="spec-chat-task-detail">
        ${desc ? `<div class="spec-chat-task-desc">${desc}</div>` : ''}
        ${tags ? `<div class="spec-chat-task-tags card-tags">${tags}</div>` : ''}
      </div>` : ''}
      <div class="spec-chat-messages"></div>
      <div class="spec-chat-input-area">
        <textarea class="spec-chat-input" rows="2" placeholder="Discuss this spec with Claude…"></textarea>
        <button class="spec-chat-send">Send</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.paddingRight = scrollbarWidth + 'px';
  document.documentElement.style.overflowY = 'hidden';

  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelector('.spec-chat-close').addEventListener('click', close);
  overlay.querySelector('.spec-chat-cancel').addEventListener('click', async () => {
    const ok = await showActionConfirm({
      message: t('spec.confirmDiscard'),
      confirmLabel: t('btn.discard'),
      danger: true,
      overlayClass: 'modal-overlay--over-chat',
    });
    if (ok) {
      wsSend(ws, 'kill', {});
      close();
    }
  });

  const input = overlay.querySelector('.spec-chat-input');
  attachImagePaste(input, null, { taskKey: currentTaskId });
  const sendBtn = overlay.querySelector('.spec-chat-send');

  sendBtn.addEventListener('click', () => _sendUserMessage(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendUserMessage(input); }
  });

  _keyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', _keyHandler);

  input.focus();
}

function _sendUserMessage(input) {
  const text = input.value.trim();
  if (!text || !currentTaskId) return;
  input.value = '';

  messages.push({ role: 'user', content: text });
  _appendBubble('user', text);

  messages.push({ role: 'assistant', content: '', streaming: true });
  const bubble = _appendBubble('assistant', '', true);
  bubble.dataset.streaming = '1';

  wsSend(ws, 'spec-chat-message', { taskId: currentTaskId, text });
}

function _appendBubble(role, content, streaming = false) {
  const list = document.querySelector('.spec-chat-messages');
  if (!list) return null;

  const msgEl = document.createElement('div');
  msgEl.className = `chat-msg chat-msg--${role}`;

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble--${role}`;

  if (streaming) {
    bubble.innerHTML = '<span class="chat-typing-indicator"><span></span><span></span><span></span></span>';
    bubble.dataset.streaming = '1';
  } else if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  msgEl.appendChild(bubble);
  list.appendChild(msgEl);
  list.scrollTop = list.scrollHeight;
  return bubble;
}

function _getStreamingBubble() {
  return document.querySelector('.spec-chat-messages .chat-bubble[data-streaming="1"]');
}

function _finalizeStreaming(bubble) {
  if (!bubble) return;
  delete bubble.dataset.streaming;
  const lastMsg = messages.findLast(m => m.role === 'assistant');
  if (lastMsg) {
    bubble.innerHTML = renderMarkdown(lastMsg.content || '');
  }
}

// ── Suggestion card ──

function _hasDiff(update) {
  if (!task) return false;
  if (update.title && update.title !== task.title) return true;
  if (update.description !== undefined && update.description !== task.description) return true;
  if (Array.isArray(update.tags) && JSON.stringify([...(update.tags || [])].sort()) !== JSON.stringify([...(task.tags || [])].sort())) return true;
  if (update.priority !== undefined && update.priority !== task.priority) return true;
  return false;
}

function _renderTagDiffRow(currentTags, suggestedTags) {
  const curSet = new Set(currentTags || []);
  const sugSet = new Set(suggestedTags || []);

  const renderBadge = (t, cls) => {
    const base = renderTagBadge(t, state.tagDescriptions);
    // Wrap to add modifier class
    const tmp = document.createElement('div');
    tmp.innerHTML = base;
    const badge = tmp.firstElementChild;
    if (badge && cls) badge.classList.add(cls);
    return tmp.innerHTML;
  };

  const curBadges = (currentTags || []).map(t => renderBadge(t, !sugSet.has(t) ? 'tag-diff-removed' : '')).join('');
  const sugBadges = (suggestedTags || []).map(t => renderBadge(t, !curSet.has(t) ? 'tag-diff-added' : '')).join('');

  return `
    <div class="spec-diff-row spec-diff-tags-row">
      <div class="spec-diff-col">
        <div class="spec-diff-label">Tags</div>
        <div class="card-tags">${curBadges || '<em class="spec-diff-empty">none</em>'}</div>
      </div>
      <div class="spec-diff-col">
        <div class="spec-diff-label spec-diff-label--new">Suggested</div>
        <div class="card-tags">${sugBadges || '<em class="spec-diff-empty">none</em>'}</div>
      </div>
    </div>`;
}

function _renderSuggestionCard(update) {
  const list = document.querySelector('.spec-chat-messages');
  if (!list) return;

  const card = document.createElement('div');
  card.className = 'chat-msg chat-msg--system spec-suggestion-wrap';

  if (!_hasDiff(update)) {
    card.innerHTML = `<div class="spec-suggestion-card spec-suggestion-card--nodiff">
      <div class="spec-suggestion-header">Spec suggestion</div>
      <p class="spec-suggestion-nodiff">No changes proposed — spec matches current task.</p>
    </div>`;
    list.appendChild(card);
    list.scrollTop = list.scrollHeight;
    return;
  }

  let titleHtml = '';
  if (update.title && update.title !== task.title) {
    titleHtml = `<div class="spec-diff-title-row">
      <span class="spec-diff-label">Title</span>
      <span class="spec-diff-title-old">${escapeAttr(task.title || '')}</span>
      <span class="spec-diff-arrow">→</span>
      <span class="spec-diff-title-new">${escapeAttr(update.title)}</span>
    </div>`;
  }

  let descHtml = '';
  if (update.description !== undefined && update.description !== task.description) {
    descHtml = `<div class="spec-diff-row spec-diff-desc-row">
      <div class="spec-diff-col">
        <div class="spec-diff-label">Current</div>
        <div class="spec-diff-desc-body">${renderMarkdown(task.description || '') || '<em class="spec-diff-empty">empty</em>'}</div>
      </div>
      <div class="spec-diff-col">
        <div class="spec-diff-label spec-diff-label--new">Suggested</div>
        <div class="spec-diff-desc-body">${renderMarkdown(update.description || '') || '<em class="spec-diff-empty">empty</em>'}</div>
      </div>
    </div>`;
  }

  let tagsHtml = '';
  if (Array.isArray(update.tags)) {
    tagsHtml = _renderTagDiffRow(task.tags || [], update.tags);
  }

  let priorityHtml = '';
  if (update.priority !== undefined && update.priority !== task.priority) {
    priorityHtml = `<div class="spec-diff-priority-row">
      <span class="spec-diff-label">Priority</span>
      <span class="spec-diff-priority-old">P${task.priority ?? '—'}</span>
      <span class="spec-diff-arrow">→</span>
      <span class="spec-diff-priority-new">P${update.priority}</span>
    </div>`;
  }

  card.innerHTML = `<div class="spec-suggestion-card">
    <div class="spec-suggestion-header">
      <span class="spec-suggestion-label">Spec suggestion</span>
    </div>
    <div class="spec-suggestion-body">
      ${titleHtml}${descHtml}${tagsHtml}${priorityHtml}
    </div>
    <div class="spec-suggestion-actions">
      <button class="spec-suggestion-reject">Reject</button>
      <button class="spec-suggestion-accept">Accept</button>
    </div>
  </div>`;

  const acceptBtn = card.querySelector('.spec-suggestion-accept');
  const rejectBtn = card.querySelector('.spec-suggestion-reject');

  acceptBtn.addEventListener('click', () => {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    acceptBtn.textContent = 'Saving…';
    wsSend(ws, 'apply-spec-update', { taskId: currentTaskId, update });
  });

  rejectBtn.addEventListener('click', () => {
    card.remove();
  });

  list.appendChild(card);
  list.scrollTop = list.scrollHeight;
}

function _markCardApplied(cardEl, updatedTask) {
  const inner = cardEl.querySelector('.spec-suggestion-card');
  if (!inner) return;
  const actions = inner.querySelector('.spec-suggestion-actions');
  if (actions) actions.remove();
  inner.classList.add('spec-suggestion-card--applied');
  const header = inner.querySelector('.spec-suggestion-header');
  if (header) header.innerHTML = '<span class="spec-suggestion-label spec-suggestion-label--applied">✓ Applied</span>';
}

function _renderMessagesFromHistory(hist, running) {
  const list = document.querySelector('.spec-chat-messages');
  if (!list) return;
  list.innerHTML = '';
  for (const m of hist) {
    _appendBubble(m.role === 'system' ? 'assistant' : m.role, m.content);
  }
  if (running) {
    const bubble = _appendBubble('assistant', '', true);
    bubble.dataset.streaming = '1';
    messages.push({ role: 'assistant', content: '', streaming: true });
  }
}

function _connectWs() {
  ws = new WebSocket(buildWsUrl('specChat:' + currentTaskId, { mode: 'spec-chat' }));

  ws.onopen = () => {
    // Defer send by one microtask so any synchronous chat-history-reset
    // (reconnect path) can set _isReconnect before we decide to seed.
    queueMicrotask(() => {
      if (!_isReconnect) {
        wsSend(ws, 'start-spec-chat', { taskId: currentTaskId });
      }
    });
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'chat-history-reset') {
      _isReconnect = true;
      // Restore history, skipping the first user message (seed JSON dump).
      messages = (msg.messages || [])
        .filter((m, idx) => !(idx === 0 && m.role === 'user'))
        .map(m => ({ role: m.role, content: m.content }));
      _renderMessagesFromHistory(messages, !!msg.running);
      return;
    }

    if (msg.type === 'data') {
      const lastMsg = messages.findLast(m => m.role === 'assistant' && m.streaming);
      if (lastMsg) lastMsg.content += msg.data || '';
      const bubble = _getStreamingBubble();
      if (bubble) {
        const typing = bubble.querySelector('.chat-typing-indicator');
        if (typing) typing.remove();
        let streamEl = bubble.querySelector('.chat-stream-text');
        if (!streamEl) {
          streamEl = document.createElement('span');
          streamEl.className = 'chat-stream-text';
          bubble.appendChild(streamEl);
        }
        streamEl.textContent += msg.data || '';
        const list = document.querySelector('.spec-chat-messages');
        if (list) list.scrollTop = list.scrollHeight;
      }
      return;
    }

    if (msg.type === 'done' || msg.type === 'exit') {
      const bubble = _getStreamingBubble();
      _finalizeStreaming(bubble);
      const lastMsg = messages.findLast(m => m.role === 'assistant');
      if (lastMsg) lastMsg.streaming = false;
      return;
    }

    if (msg.type === 'spec-suggestion') {
      const bubble = _getStreamingBubble();
      _finalizeStreaming(bubble);
      const lastMsg = messages.findLast(m => m.role === 'assistant');
      if (lastMsg) lastMsg.streaming = false;

      const update = msg.update || {};
      messages.push({ role: 'system', content: JSON.stringify(update, null, 2) });
      _renderSuggestionCard(update);
      return;
    }

    if (msg.type === 'spec-applied') {
      if (msg.task) {
        task = msg.task;
        // Update modal header title if modal still open
        const titleEl = document.querySelector('.spec-chat-task-title-text');
        if (titleEl && msg.task.title) titleEl.textContent = msg.task.title;
      }
      // Mark the most recent pending card as applied
      const cards = document.querySelectorAll('.spec-suggestion-wrap');
      const pending = [...cards].reverse().find(c => c.querySelector('.spec-suggestion-accept:not([disabled])') || c.querySelector('.spec-suggestion-accept[disabled]'));
      if (pending) _markCardApplied(pending, msg.task);
      showSaveToast(1);
      return;
    }

    if (msg.type === 'spec-apply-error') {
      // Re-enable buttons on the most recent card with disabled accept
      const cards = document.querySelectorAll('.spec-suggestion-wrap');
      const pendingCard = [...cards].reverse().find(c => {
        const btn = c.querySelector('.spec-suggestion-accept');
        return btn && btn.disabled;
      });
      if (pendingCard) {
        const acceptBtn = pendingCard.querySelector('.spec-suggestion-accept');
        const rejectBtn = pendingCard.querySelector('.spec-suggestion-reject');
        if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Accept'; }
        if (rejectBtn) { rejectBtn.disabled = false; }
      }
      const list = document.querySelector('.spec-chat-messages');
      if (!list) return;
      const errEl = document.createElement('div');
      errEl.className = 'chat-msg chat-msg--system';
      errEl.innerHTML = `<div class="chat-bubble chat-bubble--system">${escapeAttr(msg.message || 'Failed to apply spec update')}</div>`;
      list.appendChild(errEl);
      list.scrollTop = list.scrollHeight;
      return;
    }

    if (msg.type === 'error') {
      const bubble = _getStreamingBubble();
      _finalizeStreaming(bubble);
      const lastMsg = messages.findLast(m => m.role === 'assistant');
      if (lastMsg) { lastMsg.streaming = false; lastMsg.content = msg.message || 'Error'; }

      const list = document.querySelector('.spec-chat-messages');
      if (!list) return;
      const errEl = document.createElement('div');
      errEl.className = 'chat-msg chat-msg--system';
      errEl.innerHTML = `<div class="chat-bubble chat-bubble--system">${escapeAttr(msg.message || 'Error from server')}</div>`;
      list.appendChild(errEl);
      list.scrollTop = list.scrollHeight;
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    const bubble = _getStreamingBubble();
    if (bubble) _finalizeStreaming(bubble);
  };
}
