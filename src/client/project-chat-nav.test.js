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
  const state = { sessionMeta: new Map(Object.entries(sessionMeta)), taskTitleById: new Map([['TPT3', 'Board title']]) };
  // eslint-disable-next-line no-new-func
  return new Function('escapeAttr', 't', 'state', 'CHAT_BUBBLE_SVG',
    `${fnSource('renderChatSessionRow')}${fnSource('projectChatRows')}${fnSource('chatRowLabel')}${fnSource('taskChatRows')}`
      + 'return { renderChatSessionRow, projectChatRows, taskChatRows };',
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
  assert.doesNotMatch(html, /active-session-key|left-nav-chat-key|active-session-item--task-chat|data-task-id/);
  assert.match(html, /class="active-session-close" role="button" tabindex="0" data-close-chat-id="projectChat:2:aaaaaa1" aria-label="taskChat\.nav\.end"/);
  assert.match(renderChatSessionRow({ taskId: 'projectChat:2:x', title: 'T' }, true), /class="[^"]*\bcollapsed"/);
});

test('rows are wired: chat rows reopen their chat, End confirms and terminates, task rows keep openTerminal', () => {
  assert.match(boardJs, /if \(s\.chat\) return renderChatSessionRow\(s, collapsed\);/);
  assert.match(boardJs, /const openChatId = window\.TipTask\?\.taskChat\?\.currentChatId\?\.\(\) \|\| '';\s*rows\.push\(\.\.\.taskChatRows\(openChatId\), \.\.\.projectChatRows\(openChatId\)\);/);
  assert.match(boardJs, /\.active-session-item\[data-chat-id\]'\)\.forEach[\s\S]*?const chatId = btn\.dataset\.chatId;[\s\S]*?openProjectChat\?\.\(\{ chatId \}\)/);
  const end = boardJs.slice(boardJs.indexOf("'.active-session-close[data-close-chat-id]'"), boardJs.indexOf("'.active-session-item[data-task-id]'"));
  assert.match(end, /showActionConfirm\(/);
  assert.match(end, /terminateTaskSession\(id, \{ timeoutMs: 5000 \}\)/);
  assert.match(end, /forgetLocalSession\(id\)/);
  assert.match(boardJs, /\.active-session-item\[data-task-id\]'\)\.forEach[\s\S]*?window\.TipTask\?\.openTerminal\?\.\(id, title, '', status\)/);
  assert.match(boardJs, /function sessionRowId\(row\) \{\s*return row\.dataset\.taskId \|\| row\.dataset\.chatId \|\| '';/);
});

// (TPT526) Task chats get rows too, marked with a task key badge.
test('started task chats become rows, oldest first; pending chats, spec chats and project chats stay out', () => {
  const { taskChatRows } = chatHelpers({
    'taskChat:TPT2': { type: 'taskChat', taskKey: 'TPT2', title: 'Later', startedAt: 20 },
    'taskChat:TPT1': { type: 'taskChat', taskKey: 'TPT1', title: 'Earlier', startedAt: 10 },
    'taskChat:TPT3': { type: 'taskChat', taskKey: 'TPT3', title: '', startedAt: 30 },
    'taskChat:TPT4': { type: 'objective', startedAt: 40 },
    'specChat:TPT5': { type: 'specChat', taskKey: 'TPT5', startedAt: 1 },
    'projectChat:2:aaaaaa1': { type: 'taskChat', title: 'Project', startedAt: 1 },
  });
  assert.deepEqual(taskChatRows('taskChat:TPT2'), [
    { chat: true, taskId: 'taskChat:TPT1', taskKey: 'TPT1', title: 'Earlier', isOpen: false },
    { chat: true, taskId: 'taskChat:TPT2', taskKey: 'TPT2', title: 'Later', isOpen: true },
    { chat: true, taskId: 'taskChat:TPT3', taskKey: 'TPT3', title: 'Board title', isOpen: false },
  ]);
});

test('a task chat row carries the .left-nav-chat-key badge before its title; a project chat row does not', () => {
  const { renderChatSessionRow } = chatHelpers({});
  const html = renderChatSessionRow({ taskId: 'taskChat:TPT1', taskKey: 'TPT1', title: 'Fix "login"', isOpen: false }, false);
  assert.match(html, /^<button type="button" class="active-session-item active-session-item--chat active-session-item--task-chat" data-chat-id="taskChat:TPT1"/);
  assert.ok(html.includes(`<span class="active-session-icon">${CHAT_BUBBLE_SVG}</span><span class="left-nav-chat-key">TPT1</span><span class="active-session-title">Fix &quot;login&quot;</span>`));
  assert.match(html, /data-tooltip="nav\.sessionTooltip:\{&quot;key&quot;:&quot;TPT1&quot;/);
  assert.match(renderChatSessionRow({ taskId: 'taskChat:TPT9', taskKey: 'TPT9', title: '' }, false), /data-tooltip="TPT9" aria-label="TPT9"/);
  assert.doesNotMatch(renderChatSessionRow({ taskId: 'projectChat:2:x', title: 'T' }, false), /left-nav-chat-key/);
});

test('a task chat row reopens its task workspace; its badge style hides with the collapsed rail', () => {
  assert.match(boardJs, /if \(taskKey && chatId\.startsWith\('taskChat:'\)\) window\.TipTask\?\.taskChat\?\.open\?\.\(taskKey\);\s*else window\.TipTask\?\.taskChat\?\.openProjectChat\?\.\(\{ chatId \}\);/);
  assert.match(css, /\.left-nav-chat-key \{[^}]*background: var\(--c-bg-tier\);[^}]*color: var\(--c-text-secondary\);/);
  assert.match(css, /body\.left-nav-collapsed \.left-nav-chat-key,/);
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
