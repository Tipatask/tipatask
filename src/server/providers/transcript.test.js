'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../config');
const { buildTurnPrompt, buildHandoffPrompt } = require('./transcript');
const { buildObjectiveArgs } = require('../claude-session');
const { buildCodexArgs } = require('./codex-session');
const { buildGeminiArgs } = require('./gemini-session');
const { buildPiArgs } = require('./pi-session');

// The only per-provider knob buildTurnPrompt() takes is transport: claude ships the system
// prompt as a CLI flag, the other three fold it into stdin.
const PROVIDERS = [
  { id: 'claude', includeSystemPrompt: false },
  { id: 'codex', includeSystemPrompt: true },
  { id: 'gemini', includeSystemPrompt: true },
  { id: 'pi', includeSystemPrompt: true },
];

const PREFETCH = '## Pre-fetched Workflow Data\n### get_project_tags\nPREFETCH_MARKER';
const OBJECTIVE = 'OBJECTIVE_MARKER ship the thing';
const SYSTEM = 'SYSTEM_PROMPT_MARKER';

for (const { id, includeSystemPrompt } of PROVIDERS) {
  for (const mode of ['fresh', 'resume', 'handoff', 'rebuild']) {
    test(`${id}: ${mode} includes the metadata priority baseline exactly once`, () => {
      const session = startedSession({
        firstPrompt: '### list_task_id_meta\n```json\n{"priorityBaseline":42,"active":[]}\n```\n\nObjective',
        messages: mode === 'fresh' ? [msg('user', 'LATEST')] : conversation(3, 'LATEST'),
        _providerSwitchPending: mode === 'handoff',
      });
      const result = buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession: mode === 'resume' });
      assert.equal(count(result.prompt, 'Priority baseline (list_task_id_meta): 42.'), 1);
      if (mode !== 'fresh') assert.ok(result.prompt.endsWith('LATEST'));
      if (mode === 'resume') assert.ok(!result.prompt.includes('```json'), 'resume carries only the compact hint');
    });
  }
}

test('legacy prefetched metadata derives baseline from active CODING rows, including custom statuses', () => {
  const meta = { active: [
    { category: 'CODING', status: 'working', priority: 42 },
    { category: 'CODING', status: 'working', priority: 35 },
    { category: 'HUMAN', status: 'working', priority: 100 },
  ] };
  const session = startedSession({ firstPrompt: '### list_task_id_meta\n```json\n' + JSON.stringify(meta) + '\n```' });
  assert.match(buildTurnPrompt(session, { hasProviderSession: true }).prompt, /Priority baseline \(list_task_id_meta\): 42\./);
});

test('malformed prefetched metadata does not break a provider turn or invent a baseline', () => {
  const session = startedSession({ firstPrompt: '### list_task_id_meta\n```json\n{broken}\n```' });
  assert.equal(buildTurnPrompt(session, { hasProviderSession: true }).prompt, OBJECTIVE);
});

function msg(role, content) {
  return { role, content, timestamp: 0 };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Mirrors ws-handlers.js's objective `start`: firstPrompt = prefetch + client prompt,
// messages[0] = the user's visible text (distinct from the prompt).
function startedSession(extra = {}) {
  return {
    messages: [msg('user', OBJECTIVE)],
    firstPrompt: `${PREFETCH}\n\nObjective from the user:\n\n${OBJECTIVE}`,
    systemPrompt: SYSTEM,
    compressedSummaries: [],
    compressedThrough: 0,
    ...extra,
  };
}

function conversation(pairs, lastAsk) {
  const out = [msg('user', OBJECTIVE)];
  for (let p = 1; p <= pairs; p++) {
    out.push(msg('assistant', `REPLY_${p}_`), msg('user', `ASK_${p}_`));
  }
  out[out.length - 1] = msg('user', lastAsk);
  return out;
}

for (const { id, includeSystemPrompt } of PROVIDERS) {
  const opts = (hasProviderSession) => ({ includeSystemPrompt, hasProviderSession });

  test(`${id}: first turn delivers prefetched context and the objective exactly once`, () => {
    const { prompt, mode } = buildTurnPrompt(startedSession(), opts(false));
    assert.equal(mode, 'fresh');
    assert.equal(count(prompt, 'PREFETCH_MARKER'), 1);
    assert.equal(count(prompt, 'OBJECTIVE_MARKER'), 1);
    assert.equal(count(prompt, SYSTEM), includeSystemPrompt ? 1 : 0);
    if (includeSystemPrompt) assert.ok(prompt.startsWith(SYSTEM));
  });

  test(`${id}: first turn falls back to the last message without firstPrompt`, () => {
    const { prompt, mode } = buildTurnPrompt(startedSession({ firstPrompt: null }), opts(false));
    assert.equal(mode, 'fresh');
    assert.equal(prompt, includeSystemPrompt ? `${SYSTEM}\n\n${OBJECTIVE}` : OBJECTIVE);
  });

  test(`${id}: SIMPLE_MODE-shaped session (no system prompt, no prefetch) sends the bare prompt`, () => {
    const session = startedSession({ systemPrompt: '', firstPrompt: OBJECTIVE });
    assert.equal(buildTurnPrompt(session, opts(false)).prompt, OBJECTIVE);
  });

  test(`${id}: resume sends only the latest message`, () => {
    const session = startedSession({ messages: conversation(2, 'LATEST_ASK') });
    const { prompt, mode } = buildTurnPrompt(session, opts(true));
    assert.equal(mode, 'resume');
    assert.equal(prompt, 'LATEST_ASK');
  });

  test(`${id}: handoff carries prefetched objective once, summaries, every turn, and ends on the ask`, () => {
    const session = startedSession({
      messages: conversation(3, 'LATEST_ASK'),
      _providerSwitchPending: true,
    });
    const { prompt, mode } = buildTurnPrompt(session, opts(false));
    assert.equal(mode, 'handoff');
    assert.equal(count(prompt, 'PREFETCH_MARKER'), 1);
    assert.equal(count(prompt, 'OBJECTIVE_MARKER'), 1);
    for (const marker of ['REPLY_1_', 'ASK_1_', 'REPLY_2_', 'ASK_2_', 'REPLY_3_']) {
      assert.ok(prompt.includes(marker), `expected handoff prompt to include ${marker}`);
    }
    assert.match(prompt, /do not restart or re-ask settled questions/);
    assert.equal(count(prompt, 'LATEST_ASK'), 1);
    assert.ok(prompt.trimEnd().endsWith('LATEST_ASK'));
    assert.equal(count(prompt, SYSTEM), includeSystemPrompt ? 1 : 0);
  });

  test(`${id}: post-compression rebuild keeps objective, summaries, a bounded tail, and the latest ask`, () => {
    const tailTurns = config.OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS;
    const pairs = tailTurns + 3; // last "pair" is the in-flight ask
    const session = startedSession({
      messages: conversation(pairs, 'LATEST_ASK'),
      compressedSummaries: [{ turn: 1, decision: 'SUMMARY_MARKER' }],
      compressedThrough: 1,
    });
    const { prompt, mode } = buildTurnPrompt(session, opts(false));
    assert.equal(mode, 'fresh');
    assert.equal(count(prompt, 'PREFETCH_MARKER'), 1);
    assert.equal(count(prompt, 'OBJECTIVE_MARKER'), 1);
    assert.equal(count(prompt, 'SUMMARY_MARKER'), 1);
    assert.match(prompt, /<recent-context-verbatim>/);
    // Exactly the last tailTurns complete exchanges are verbatim; older ones are not.
    for (let p = pairs; p > pairs - tailTurns; p--) {
      assert.ok(prompt.includes(`REPLY_${p}_`), `tail should include REPLY_${p}_`);
    }
    assert.ok(!prompt.includes('REPLY_1_'), 'compressed pair must not be re-sent verbatim');
    assert.ok(!prompt.includes(`REPLY_${pairs - tailTurns}_`), 'tail must stay bounded');
    assert.equal(count(prompt, 'LATEST_ASK'), 1);
    assert.ok(prompt.trimEnd().endsWith('LATEST_ASK'));
    assert.equal(count(prompt, SYSTEM), includeSystemPrompt ? 1 : 0);
  });

  test(`${id}: post-trim rebuild (no summaries) still carries objective, tail, and latest ask`, () => {
    const session = startedSession({ messages: conversation(2, 'LATEST_ASK') });
    const { prompt, mode } = buildTurnPrompt(session, opts(false));
    assert.equal(mode, 'fresh');
    assert.equal(count(prompt, 'OBJECTIVE_MARKER'), 1);
    assert.ok(!prompt.includes('<prior-decisions-compressed>'));
    assert.ok(prompt.includes('REPLY_1_') && prompt.includes('ASK_1_') && prompt.includes('REPLY_2_'));
    assert.ok(prompt.trimEnd().endsWith('LATEST_ASK'));
  });

  test(`${id}: real planner rules reach the model unchanged through this provider's transport`, async () => {
    const { buildObjectivePrompt } = await import('../../client/utils.js');
    const { systemPrompt, userPrompt } = buildObjectivePrompt(OBJECTIVE, null, null, { originTaskKey: 'TPT1' });
    const session = startedSession({
      // applyRehashIntent() appends its directive to session.systemPrompt.
      systemPrompt: `${systemPrompt}\n\nSTATIC_KB\n\nREHASH_DIRECTIVE_MARKER`,
      firstPrompt: `${PREFETCH}\n\n${userPrompt}`,
    });
    const stdin = buildTurnPrompt(session, opts(false)).prompt;
    const claudeArgs = buildObjectiveArgs(session);
    const flagIdx = claudeArgs.indexOf('--append-system-prompt');
    const delivered = includeSystemPrompt ? stdin : claudeArgs[flagIdx + 1];
    for (const rule of ['YOU ARE A READ-ONLY PLANNER', 'fenced ```json block ONLY', 'ORIGIN-LINKED PLANNING', 'TPT1', 'REHASH_DIRECTIVE_MARKER']) {
      assert.ok(delivered.includes(rule), `${id} must receive planner rule: ${rule}`);
    }
    assert.ok(delivered.includes(systemPrompt), 'planner rules must not be trimmed');
    if (!includeSystemPrompt) {
      assert.ok(!stdin.includes('YOU ARE A READ-ONLY PLANNER'), 'claude stdin carries no system text');
    }
  });
}

test('handoff without firstPrompt falls back to the first message as the objective', () => {
  const session = startedSession({
    firstPrompt: null,
    messages: conversation(1, 'LATEST_ASK'),
    _providerSwitchPending: true,
  });
  const { prompt, mode } = buildTurnPrompt(session, { includeSystemPrompt: false, hasProviderSession: false });
  assert.equal(mode, 'handoff');
  assert.match(prompt, /<objective>\nOBJECTIVE_MARKER/);
});

test('handoff mode needs a real conversation to replay', () => {
  const session = startedSession({ _providerSwitchPending: true });
  assert.equal(buildTurnPrompt(session, { includeSystemPrompt: false, hasProviderSession: false }).mode, 'fresh');
});

test('buildHandoffPrompt elides oldest turns and keeps the marker + trailing ask when over the char cap', () => {
  const originalCap = config.OBJECTIVE_HANDOFF_MAX_CHARS;
  config.OBJECTIVE_HANDOFF_MAX_CHARS = 80;
  try {
    const session = {
      messages: [
        msg('user', 'OBJECTIVE_TEXT'),
        msg('assistant', 'A'.repeat(60)),
        msg('user', 'B'.repeat(60)),
        msg('assistant', 'C'.repeat(60)),
        msg('user', 'TRAILING_ASK'),
      ],
      firstPrompt: 'OBJECTIVE_TEXT',
      compressedSummaries: [],
      compressedThrough: 0,
    };

    const prompt = buildHandoffPrompt(session, { includeSystemPrompt: false });

    assert.match(prompt, /earlier turn\(s\) elided/);
    assert.ok(prompt.trimEnd().endsWith('TRAILING_ASK'));
  } finally {
    config.OBJECTIVE_HANDOFF_MAX_CHARS = originalCap;
  }
});

// ── Transport fixtures: tool restrictions live in argv, never in a new system flag ──

test('claude argv keeps its tool allowlist/denylist and appended-system flag', () => {
  const args = buildObjectiveArgs({ claudeSessionId: null, systemPrompt: SYSTEM });
  const allowed = args[args.indexOf('--allowedTools') + 1];
  assert.match(allowed, /^Read,/);
  assert.match(allowed, /mcp__tipatask__reserve_task_keys/);
  assert.match(allowed, /mcp__tipatask__get_task(,|$)/);
  assert.ok(args.includes('--disallowedTools'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], SYSTEM);
});

test('codex argv: read-only sandbox on a fresh turn, inherited on resume, no system flag', () => {
  const fresh = buildCodexArgs({ codexSessionId: null }, { cwd: '/p', model: 'm', imagePaths: [] });
  assert.equal(fresh[fresh.indexOf('-s') + 1], 'read-only');
  assert.equal(fresh.at(-1), '-');
  const resume = buildCodexArgs({ codexSessionId: 'tid' }, { cwd: '/p', model: 'm', imagePaths: [] });
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'tid']);
  assert.ok(!resume.includes('-s'));
  for (const a of [...fresh, ...resume]) assert.doesNotMatch(String(a), /system/i);
});

test('gemini argv: stdin prompt, resume only with a session id, no system flag', () => {
  const fresh = buildGeminiArgs({ providerType: 'gemini' });
  assert.ok(fresh.includes('--prompt') && !fresh.includes('--resume'));
  assert.ok(buildGeminiArgs({ providerType: 'gemini', geminiSessionId: 'g' }).includes('--resume'));
  for (const a of fresh) assert.doesNotMatch(String(a), /system/i);
});

test('pi argv: read-only tools, session flag only on resume, no system flag', () => {
  const fresh = buildPiArgs({ providerType: 'pi' });
  assert.equal(fresh[fresh.indexOf('--tools') + 1], 'read');
  assert.ok(!fresh.includes('--session'));
  assert.ok(buildPiArgs({ providerType: 'pi', piSessionId: 'p' }).includes('--session'));
  for (const a of fresh) assert.doesNotMatch(String(a), /system/i);
});

for (const { id, includeSystemPrompt } of PROVIDERS) {
  test(`${id}: rebuilding without firstPrompt preserves fallback objective, JSON history, and latest ask once`, () => {
    for (const handoff of [false, true]) {
      const jsonReply = '```json\n{"changes":[],"questions":["RETAINED_QUESTION"]}\n```';
      const session = startedSession({
        firstPrompt: undefined,
        _providerSwitchPending: handoff,
        messages: [msg('user', OBJECTIVE), msg('assistant', jsonReply), msg('user', 'LATEST_UNIQUE')],
      });
      const { prompt } = buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession: false });
      assert.equal(count(prompt, OBJECTIVE), 1, 'fallback objective is not repeated in transcript');
      assert.equal(count(prompt, jsonReply), 1, 'retained JSON must stay intact');
      assert.equal(count(prompt, 'LATEST_UNIQUE'), 1);
      assert.ok(prompt.endsWith('LATEST_UNIQUE'));
      assert.ok(!prompt.includes('PREFETCH_MARKER'), 'no fabricated prefetch');
    }
  });

  test(`${id}: compressed boundary excludes summarized pairs even inside the tail window`, () => {
    const session = startedSession({
      messages: conversation(4, 'LATEST_UNIQUE'),
      compressedThrough: 3,
      compressedSummaries: [{ decision: 'SUMMARY_UNIQUE' }],
    });
    for (const handoff of [false, true]) {
      session._providerSwitchPending = handoff;
      const { prompt } = buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession: false });
      for (const old of ['REPLY_1_', 'ASK_1_', 'REPLY_2_', 'ASK_2_', 'REPLY_3_', 'ASK_3_']) {
        assert.ok(!prompt.includes(old), `summarized context must not also be verbatim: ${old}`);
      }
      assert.equal(count(prompt, 'REPLY_4_'), 1);
      assert.equal(count(prompt, 'SUMMARY_UNIQUE'), 1);
      assert.equal(count(prompt, 'PREFETCH_MARKER'), 1);
    }
  });

  test(`${id}: objective context larger than Pi task budget keeps mandatory rules and prefetch`, () => {
    const session = startedSession({
      systemPrompt: `RULE_START ${'policy '.repeat(2200)} RULE_END`,
      firstPrompt: `${PREFETCH}\n${'architecture '.repeat(1100)}\n${OBJECTIVE}`,
    });
    const { prompt } = buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession: false });
    const delivered = includeSystemPrompt ? prompt : `${session.systemPrompt}\n${prompt}`;
    assert.ok(delivered.length > 12000, 'fixture exceeds task-mode cap intentionally');
    for (const marker of ['RULE_START', 'RULE_END', 'PREFETCH_MARKER', OBJECTIVE]) {
      assert.equal(count(delivered, marker), 1, `${id}: must retain ${marker}`);
    }
  });
}

// ── Task chat: the ask_user contract on resumed turns ──

const { ASK_USER_REMINDER } = require('../task-chat-widgets');

for (const { id, includeSystemPrompt } of PROVIDERS) {
  test(`${id}: a resumed task-chat turn ${includeSystemPrompt ? 'restates' : 'does not restate'} the ask_user contract`, () => {
    const session = startedSession({ type: 'taskChat', messages: conversation(2, 'LATEST') });
    const { prompt, mode } = buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession: true });
    assert.equal(mode, 'resume');
    assert.ok(prompt.startsWith('LATEST'));
    assert.equal(count(prompt, ASK_USER_REMINDER), includeSystemPrompt ? 1 : 0);
    assert.ok(!prompt.includes(SYSTEM));
  });

  test(`${id}: fresh and handoff task-chat turns rely on the system prompt, not the reminder`, () => {
    const fresh = buildTurnPrompt(startedSession({ type: 'taskChat' }), { includeSystemPrompt, hasProviderSession: false });
    const handoff = buildTurnPrompt(startedSession({ type: 'taskChat', messages: conversation(2, 'LATEST'), _providerSwitchPending: true }), { includeSystemPrompt, hasProviderSession: false });
    for (const { prompt } of [fresh, handoff]) assert.equal(count(prompt, ASK_USER_REMINDER), 0);
  });
}

test('an objective turn never carries the task-chat reminder', () => {
  const session = startedSession({ type: 'objective', messages: conversation(2, 'LATEST') });
  const { prompt } = buildTurnPrompt(session, { includeSystemPrompt: true, hasProviderSession: true });
  assert.equal(prompt, 'LATEST');
});
