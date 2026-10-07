'use strict';

// (TPT354) node:test suite for final-message.js. Transcript lines mirror the real formats
// (Claude one-block-per-line jsonl, Codex 0.156 rollout, Pi session v3); locators run against
// real temp directories rather than a faked fs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseClaudeTranscript,
  parseCodexRollout,
  parsePiSession,
  claudeProjectDirName,
  locateClaudeTranscript,
  locateCodexRollout,
  locatePiSession,
  readClaudeFinalMessage,
  readCodexFinalMessage,
  readPiFinalMessage,
} = require('./final-message');

const jl = (...objs) => objs.map(o => JSON.stringify(o)).join('\n') + '\n';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt354-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Claude parser ──

const cAssistant = (id, stop, blocks) => ({ type: 'assistant', message: { id, stop_reason: stop, content: blocks } });
const cText = (text) => ({ type: 'text', text });
const cTool = { type: 'tool_use', name: 'Bash', input: {} };

test('claude: finished turn → last text, turnEnded, bookkeeping lines after it ignored', () => {
  const out = parseClaudeTranscript(jl(
    { type: 'user', message: { role: 'user', content: 'Work on task TPT1: x' } },
    cAssistant('m1', 'tool_use', [cText('Let me look.'), cTool]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    cAssistant('m2', 'end_turn', [cText('TPT1 is fixed.')]),
    { type: 'last-prompt' }, { type: 'cost-state' }, { type: 'mode' },
  ));
  assert.deepEqual(out, { text: 'TPT1 is fixed.', turnEnded: true });
});

test('claude: last assistant line is a tool_use → turn not ended, text is the earlier message', () => {
  const out = parseClaudeTranscript(jl(
    cAssistant('m1', 'tool_use', [cText('Running the tests now.')]),
    cAssistant('m1', 'tool_use', [cTool]),
  ));
  assert.deepEqual(out, { text: 'Running the tests now.', turnEnded: false });
});

test('claude: blocks of one message.id on separate lines are joined', () => {
  const out = parseClaudeTranscript(jl(
    cAssistant('m9', null, [{ type: 'thinking', thinking: 'hmm' }]),
    cAssistant('m9', null, [cText('Part one.')]),
    cAssistant('m9', 'end_turn', [cText('Part two.')]),
  ));
  assert.equal(out.text, 'Part one.\n\nPart two.');
  assert.equal(out.turnEnded, true);
});

test('claude: a fresh user prompt after end_turn means the turn is not over', () => {
  const out = parseClaudeTranscript(jl(
    cAssistant('m1', 'end_turn', [cText('Done.')]),
    { type: 'user', message: { role: 'user', content: 'one more thing' } },
  ));
  assert.equal(out.turnEnded, false);
  assert.equal(out.text, 'Done.');
});

test('claude: meta user lines and sidechain (subagent) entries are ignored', () => {
  const out = parseClaudeTranscript(jl(
    cAssistant('m1', 'end_turn', [cText('Real final message.')]),
    { type: 'user', isMeta: true, message: { role: 'user', content: 'system reminder' } },
    { ...cAssistant('sub', 'tool_use', [cText('subagent chatter')]), isSidechain: true },
  ));
  assert.deepEqual(out, { text: 'Real final message.', turnEnded: true });
});

test('claude: no assistant entries / empty / junk → null', () => {
  assert.equal(parseClaudeTranscript(''), null);
  assert.equal(parseClaudeTranscript('not json\n{broken'), null);
  assert.equal(parseClaudeTranscript(jl({ type: 'user', message: { content: 'hi' } })), null);
});

test('claude: a partial first line (tail read) is skipped, not fatal', () => {
  const out = parseClaudeTranscript(`ial-json-fragment"}}\n${jl(cAssistant('m1', 'end_turn', [cText('Fine.')]))}`);
  assert.equal(out.text, 'Fine.');
});

// ── Codex parser ──

const xEvent = (payload) => ({ type: 'event_msg', payload });
const xAssistant = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

test('codex: task_complete.last_agent_message wins and marks the turn ended', () => {
  const out = parseCodexRollout(jl(
    xEvent({ type: 'task_started' }),
    xAssistant('Working on it.'),
    xEvent({ type: 'task_complete', last_agent_message: 'TPT352 completed.' }),
  ));
  assert.deepEqual(out, { text: 'TPT352 completed.', turnEnded: true });
});

test('codex: interim assistant message with no task_complete → mid-turn', () => {
  const out = parseCodexRollout(jl(xEvent({ type: 'task_started' }), xAssistant('Reading the files first.')));
  assert.deepEqual(out, { text: 'Reading the files first.', turnEnded: false });
});

test('codex: a second turn after an ended one resets turnEnded', () => {
  const out = parseCodexRollout(jl(
    xEvent({ type: 'task_started' }),
    xEvent({ type: 'task_complete', last_agent_message: 'Plan ready.' }),
    xEvent({ type: 'task_started' }),
    xAssistant('Implementing now.'),
  ));
  assert.deepEqual(out, { text: 'Implementing now.', turnEnded: false });
});

test('codex: task_complete with a null message keeps the last assistant text', () => {
  const out = parseCodexRollout(jl(xAssistant('Wrapped up the change.'), xEvent({ type: 'task_complete', last_agent_message: null })));
  assert.deepEqual(out, { text: 'Wrapped up the change.', turnEnded: true });
});

test('codex: unrelated / empty input → null', () => {
  assert.equal(parseCodexRollout(''), null);
  assert.equal(parseCodexRollout(jl({ type: 'session_meta', payload: { id: 'x' } })), null);
});

// ── Pi parser ──

const pMsg = (role, extra) => ({ type: 'message', message: { role, ...extra } });

test('pi: stopReason "stop" ends the turn; text is the last assistant text', () => {
  const out = parsePiSession(jl(
    { type: 'session', id: 's', cwd: '/x', version: 3 },
    pMsg('user', { content: [{ type: 'text', text: 'Work on task TPT1: x' }] }),
    pMsg('assistant', { stopReason: 'toolUse', content: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall' }] }),
    pMsg('toolResult', { content: [] }),
    pMsg('assistant', { stopReason: 'stop', content: [{ type: 'text', text: 'Done. TPT1 completed.' }] }),
  ));
  assert.deepEqual(out, { text: 'Done. TPT1 completed.', turnEnded: true });
});

test('pi: trailing toolUse / toolResult → mid-turn', () => {
  const out = parsePiSession(jl(
    pMsg('assistant', { stopReason: 'toolUse', content: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall' }] }),
    pMsg('toolResult', { content: [] }),
  ));
  assert.deepEqual(out, { text: 'Checking.', turnEnded: false });
});

test('pi: no assistant message → null', () => {
  assert.equal(parsePiSession(jl({ type: 'session' }, pMsg('user', { content: [] }))), null);
});

// ── Claude locator / reader ──

test('claudeProjectDirName matches the on-disk convention, worktree dots included', () => {
  assert.equal(claudeProjectDirName('/Users/alice/Projects/Tipatask'), '-Users-alice-Projects-Tipatask');
  assert.equal(claudeProjectDirName('/a/b/.worktrees/TPT1'), '-a-b--worktrees-TPT1');
});

test('claude reader: finds <config>/projects/<dir>/<uuid>.jsonl and parses it', (t) => {
  const home = tmpDir(t);
  const cwd = '/work/proj';
  const id = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(home, 'projects', claudeProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), jl(cAssistant('m1', 'end_turn', [cText('Shipped it.')])));
  const hint = { cwd, agentSessionId: id, env: { CLAUDE_CONFIG_DIR: home } };
  assert.equal(locateClaudeTranscript(hint), path.join(dir, `${id}.jsonl`));
  assert.deepEqual(readClaudeFinalMessage(hint), { text: 'Shipped it.', turnEnded: true });
});

test('claude reader: falls back to scanning project dirs when the cwd mapping differs', (t) => {
  const home = tmpDir(t);
  const id = '99999999-2222-3333-4444-555555555555';
  const dir = path.join(home, 'projects', '-some-other-normalisation');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), jl(cAssistant('m1', 'end_turn', [cText('Found via scan.')])));
  assert.equal(readClaudeFinalMessage({ cwd: '/not/it', agentSessionId: id, env: { CLAUDE_CONFIG_DIR: home } }).text, 'Found via scan.');
});

test('claude reader: missing transcript, missing id, missing dirs → null (never throws)', (t) => {
  const home = tmpDir(t);
  assert.equal(readClaudeFinalMessage({ cwd: '/x', agentSessionId: 'nope', env: { CLAUDE_CONFIG_DIR: home } }), null);
  assert.equal(readClaudeFinalMessage({ cwd: '/x', env: { CLAUDE_CONFIG_DIR: home } }), null);
  assert.equal(readClaudeFinalMessage(null), null);
  assert.equal(readClaudeFinalMessage({ cwd: '/x', agentSessionId: 'nope', env: { CLAUDE_CONFIG_DIR: path.join(home, 'absent') } }), null);
});

// ── Codex locator / reader ──

function writeRollout(codexHome, name, taskLine, endMsg, mtimeMs, date = new Date()) {
  const dir = path.join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = jl(
    { type: 'session_meta', payload: { id: name, cwd: '/work/proj' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${'static context '.repeat(9000)}\n${taskLine}` }] } },
    xEvent({ type: 'task_started' }),
    xEvent({ type: 'task_complete', last_agent_message: endMsg }),
  );
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('codex reader: picks this task\'s rollout, not a concurrent sibling that merely mentions the key', (t) => {
  const codexHome = tmpDir(t);
  const spawnedAt = Date.now() - 60_000;
  // Sibling task's session: newer mtime, and mentions TPT354 in passing (e.g. it listed tasks).
  writeRollout(codexHome, 'rollout-sibling.jsonl', 'Work on task TPT999: other. See also TPT354 in the list.', 'Sibling done.', Date.now() - 1000);
  const mine = writeRollout(codexHome, 'rollout-mine.jsonl', 'Work on task TPT354: fix comment.', 'TPT354 fixed.', Date.now() - 5000);
  const hint = { cwd: '/work/proj', spawnedAt, taskId: 'TPT354', env: { CODEX_HOME: codexHome } };
  assert.equal(locateCodexRollout(hint), mine);
  assert.deepEqual(readCodexFinalMessage(hint), { text: 'TPT354 fixed.', turnEnded: true });
});

test('codex reader: ignores rollouts last written before the spawn', (t) => {
  const codexHome = tmpDir(t);
  writeRollout(codexHome, 'rollout-old.jsonl', 'Work on task TPT354: old run.', 'Old.', Date.now() - 3_600_000);
  const hint = { cwd: '/work/proj', spawnedAt: Date.now() - 60_000, taskId: 'TPT354', env: { CODEX_HOME: codexHome } };
  assert.equal(readCodexFinalMessage(hint), null);
});

test('codex reader: a task key must match as a whole (TPT35 ≠ TPT354)', (t) => {
  const codexHome = tmpDir(t);
  writeRollout(codexHome, 'rollout-x.jsonl', 'Work on task TPT3540: nope.', 'No.', Date.now() - 1000);
  const hint = { cwd: '/work/proj', spawnedAt: Date.now() - 60_000, taskId: 'TPT354', env: { CODEX_HOME: codexHome } };
  assert.equal(readCodexFinalMessage(hint), null);
});

test('codex reader: no sessions dir / no taskId → null', (t) => {
  const codexHome = tmpDir(t);
  assert.equal(readCodexFinalMessage({ cwd: '/x', spawnedAt: Date.now(), taskId: 'TPT1', env: { CODEX_HOME: codexHome } }), null);
  assert.equal(readCodexFinalMessage({ cwd: '/x', spawnedAt: Date.now(), env: { CODEX_HOME: codexHome } }), null);
});

// ── Pi locator / reader ──

test('pi reader: uses PI_CODING_AGENT_SESSION_DIR, matches this task, parses the tail', (t) => {
  const dir = tmpDir(t);
  const body = (taskLine, end) => jl(
    { type: 'session', id: 's', cwd: '/work/proj', version: 3 },
    pMsg('user', { content: [{ type: 'text', text: `${'ctx '.repeat(5000)}\n${taskLine}` }] }),
    pMsg('assistant', { stopReason: 'stop', content: [{ type: 'text', text: end }] }),
  );
  fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z_aaa.jsonl'), body('Work on task TPT7: other.', 'Other done.'));
  const mine = path.join(dir, '2026-01-01T00-00-01-000Z_bbb.jsonl');
  fs.writeFileSync(mine, body('Work on task TPT354: mine.', 'Mine done.'));
  const hint = { cwd: '/work/proj', spawnedAt: Date.now() - 60_000, taskId: 'TPT354', env: { PI_CODING_AGENT_SESSION_DIR: dir } };
  assert.equal(locatePiSession(hint), mine);
  assert.deepEqual(readPiFinalMessage(hint), { text: 'Mine done.', turnEnded: true });
});

test('pi reader: missing session dir → null', () => {
  assert.equal(readPiFinalMessage({ cwd: '/work/proj', spawnedAt: Date.now(), taskId: 'TPT1', env: { PI_CODING_AGENT_SESSION_DIR: '/definitely/not/here' } }), null);
});

// ── Tail read of a large transcript ──

test('large claude transcript: only the tail is read, final message still found', (t) => {
  const home = tmpDir(t);
  const cwd = '/work/big';
  const id = 'aaaaaaaa-2222-3333-4444-555555555555';
  const dir = path.join(home, 'projects', claudeProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filler = jl({ type: 'attachment', pad: 'x'.repeat(1024) }).repeat(3000); // ~3 MB
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), filler + jl(cAssistant('m1', 'end_turn', [cText('Tail message.')])));
  assert.deepEqual(readClaudeFinalMessage({ cwd, agentSessionId: id, env: { CLAUDE_CONFIG_DIR: home } }), { text: 'Tail message.', turnEnded: true });
});

// ── (TPT539) conversation read-back for task/project chat history resume ──
{
  const { parseClaudeConversation, parseCodexConversation, parsePiConversation, readNativeConversation } = require('./final-message');
  const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'chat-transcripts');
  // Every fixture holds the same chat: generated seed, greeting, a codeword turn with a tool call,
  // provider bookkeeping (meta lines, injected instructions, reasoning, compaction), a recall turn.
  const EXPECTED = [
    ['assistant', 'Hi, I can help with TPT1.'],
    ['user', 'The codeword is PELICAN. Remember it.'],
    ['assistant', 'Let me check the task first.\n\nNoted: PELICAN.'],
    ['user', 'What is the codeword?'],
    ['assistant', 'PELICAN'],
  ];

  for (const provider of ['claude', 'codex', 'pi']) {
    test(`(TPT539) ${provider}: user/assistant text only, seed and reminder stripped, one reply per turn`, () => {
      const result = readNativeConversation(provider, path.join(FIXTURES, `${provider}.jsonl`));
      assert.deepEqual(result.messages.map(m => [m.role, m.content]), EXPECTED);
      const text = JSON.stringify(result);
      assert.doesNotMatch(text, /Fixture task|AGENTS\.md|environment_context|Reminder:|sidechain|compacted summary|tool_result|\{"id":"TPT1"\}/);
    });
  }

  test('(TPT539) a tail read keeps its first user message: the seed is not in view', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'pi.jsonl'), 'utf8');
    const fromTail = parsePiConversation(raw, { fromStart: false });
    assert.equal(fromTail[0].role, 'user');
    assert.match(fromTail[0].content, /Fixture task/);
  });

  test('(TPT539) readNativeConversation caps count and size, and fails open', (t) => {
    const dir = tmpDir(t);
    const turns = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ type: 'user', message: { role: 'user', content: i === 0 ? 'SEED' : `question ${i} ${'x'.repeat(100)}` } });
      turns.push({ type: 'assistant', message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } });
    }
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, jl(...turns));
    const capped = readNativeConversation('claude', file, { maxMessages: 10, maxChars: 30 });
    assert.equal(capped.messages.length, 10);
    assert.equal(capped.messages.at(-1).content, 'answer 39');
    assert.ok(capped.messages.every(m => m.content.length <= 30));
    const total = readNativeConversation('claude', file, { maxTotalChars: 500 });
    assert.ok(total.messages.reduce((n, m) => n + m.content.length, 0) <= 500);
    assert.equal(total.messages.at(-1).content, 'answer 39', 'the newest messages are the ones kept');
    const tail = readNativeConversation('claude', file, { maxBytes: 2000 });
    assert.ok(tail.messages.length > 0 && tail.messages.at(-1).content === 'answer 39');

    assert.equal(readNativeConversation('claude', path.join(dir, 'missing.jsonl')), null);
    assert.equal(readNativeConversation('gemini', file), null);
    fs.writeFileSync(path.join(dir, 'junk.jsonl'), 'not json\n{"type":"other"}\n');
    assert.equal(readNativeConversation('codex', path.join(dir, 'junk.jsonl')), null, 'nothing of the provider shape');
    assert.deepEqual(parseClaudeConversation(jl({ type: 'user', message: { role: 'user', content: 'SEED' } })), [],
      'a session holding only the seed reads back as an empty conversation');
    assert.deepEqual(parseCodexConversation(jl(
      { type: 'event_msg', payload: { type: 'user_message', message: 'SEED' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Q' } },
    )).map(m => m.content), ['Hi', 'Q'], 'older rollouts without response items');
  });
}
