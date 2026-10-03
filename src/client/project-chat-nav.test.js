import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHAT_BUBBLE_SVG } from './constants.js';

// (TPT469) Named project chats in the left menu. task-board.js is browser-only, so the two chat
// row helpers are lifted out of its source and run against a stub state; the wiring is scanned.
const boardJs = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');

const fnSource = name => boardJs.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`))?.[0] || '';

function chatHelpers(sessionMeta) {
  const escapeAttr = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
  const state = { sessionMeta: new Map(Object.entries(sessionMeta)) };
  // eslint-disable-next-line no-new-func
  return new Function('escapeAttr', 't', 'state', 'CHAT_BUBBLE_SVG',
    `${fnSource('renderChatSessionRow')}${fnSource('projectChatRows')}return { renderChatSessionRow, projectChatRows };`,
  )(escapeAttr, t, state, CHAT_BUBBLE_SVG);
}

test('only titled project chats become rows, oldest first; drafts and terminals stay out', () => {
  const { projectChatRows } = chatHelpers({
    'projectChat:2:bbbbbb2': { type: 'taskChat', title: 'Second', startedAt: 20 },
    'projectChat:2:aaaaaa1': { type: 'taskChat', title: 'First', startedAt: 10 },
    'projectChat:2:draft01': { type: 'taskChat', title: '', startedAt: 30 },
    'taskChat:TPT1': { type: 'taskChat', startedAt: 5 },
    TPT2: { type: 'terminal', startedAt: 1 },
  });
  assert.deepEqual(projectChatRows('projectChat:2:bbbbbb2'), [
    { chat: true, taskId: 'projectChat:2:aaaaaa1', title: 'First', isOpen: false },
    { chat: true, taskId: 'projectChat:2:bbbbbb2', title: 'Second', isOpen: true },
  ]);
});

test('a chat row carries the chat glyph, its title and an End control, no task key', () => {
  const { renderChatSessionRow } = chatHelpers({});
  const html = renderChatSessionRow({ taskId: 'projectChat:2:aaaaaa1', title: 'Plan "the" release', isOpen: true }, false);
  assert.match(html, /^<button type="button" class="active-session-item active-session-item--chat active" data-chat-id="projectChat:2:aaaaaa1"/);
  assert.match(html, /data-tooltip="Plan &quot;the&quot; release" aria-label="Plan &quot;the&quot; release"/);
  assert.ok(html.includes(`<span class="active-session-icon">${CHAT_BUBBLE_SVG}</span>`));
  assert.match(html, /<span class="active-session-title">Plan &quot;the&quot; release<\/span>/);
  assert.doesNotMatch(html, /active-session-key|data-task-id/);
  assert.match(html, /class="active-session-close" role="button" tabindex="0" data-close-chat-id="projectChat:2:aaaaaa1" aria-label="taskChat\.nav\.end"/);
  assert.match(renderChatSessionRow({ taskId: 'projectChat:2:x', title: 'T' }, true), /class="[^"]*\bcollapsed"/);
});

test('rows are wired: chat rows reopen their chat, End confirms and terminates, task rows keep openTerminal', () => {
  assert.match(boardJs, /if \(s\.chat\) return renderChatSessionRow\(s, collapsed\);/);
  assert.match(boardJs, /rows\.push\(\.\.\.projectChatRows\(window\.TipTask\?\.taskChat\?\.currentChatId\?\.\(\) \|\| ''\)\);/);
  assert.match(boardJs, /\.active-session-item\[data-chat-id\]'\)\.forEach[\s\S]*?openProjectChat\?\.\(\{ chatId: btn\.dataset\.chatId \}\)/);
  const end = boardJs.slice(boardJs.indexOf("'.active-session-close[data-close-chat-id]'"), boardJs.indexOf("'.active-session-item[data-task-id]'"));
  assert.match(end, /showActionConfirm\(/);
  assert.match(end, /terminateTaskSession\(id, \{ timeoutMs: 5000 \}\)/);
  assert.match(end, /forgetLocalSession\(id\)/);
  assert.match(boardJs, /\.active-session-item\[data-task-id\]'\)\.forEach[\s\S]*?window\.TipTask\?\.openTerminal\?\.\(id, title, '', status\)/);
  assert.match(boardJs, /function sessionRowId\(row\) \{\s*return row\.dataset\.taskId \|\| row\.dataset\.chatId \|\| '';/);
});

test('Start Chat shows the plain outline speech bubble, shared with the chat rows', () => {
  assert.match(CHAT_BUBBLE_SVG, /^<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"/);
  assert.equal((CHAT_BUBBLE_SVG.match(/<path /g) || []).length, 1, 'no plus inside the bubble');
  assert.match(template, /data-action="start-chat"[^>]*>\s*<span class="left-nav-icon">\$\{window\.TipTask\?\.constants\?\.CHAT_BUBBLE_SVG \|\| ''\}<\/span>/);
  assert.doesNotMatch(template, /M13 9v6M10 12h6/, 'the old bubble-with-plus is gone');
  assert.match(css, /\.active-session-item--chat \.active-session-title \{\s*flex: 1 1 auto;/);
});

test('End chat strings exist in every locale', () => {
  assert.equal((i18n.match(/'taskChat\.nav\.end':/g) || []).length, 2);
  assert.equal((i18n.match(/'taskChat\.nav\.confirmEnd':[^\n]*\{title\}/g) || []).length, 2);
});
