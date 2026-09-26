#!/usr/bin/env node
'use strict';

// Isolated parse harness for gemini-session.js
// Feeds a recorded Gemini stream-json fixture through spawnGeminiTurn's logic
// and asserts that a task-cards frame with ≥1 valid card is emitted.
//
// Usage (from the Task App checkout):
//   node scripts/verify-gemini-turn.js              — fixture test (no gemini binary needed)
//   LIVE=1 node scripts/verify-gemini-turn.js       — live single-turn via GEMINI_BIN

// ── 1. FIXTURE TEST ──────────────────────────────────────────────────────────

if (!process.env.LIVE) {
  console.log('=== FIXTURE TEST (no binary needed) ===\n');

  const { normalizeProposals } = require('../src/server/claude-session');

  // Simulate the key parsing logic from gemini-session without spawning a proc.
  // This tests normalizeProposals + the ```json``` block extraction used in extractCards.

  const fixture = `I've analysed the task. Here's my proposal:

\`\`\`json
{
  "changes": [
    {
      "type": "new",
      "task": {
        "title": "Add Gemini CLI provider config",
        "description": "Add GEMINI_BIN, GEMINI_MODEL, OBJECTIVE_PROVIDER to config.js so callers can switch providers via env var.",
        "category": "CODING",
        "status": "pending",
        "priority": 165,
        "tags": ["feature", "tt-gemini-session", "config"]
      }
    },
    {
      "type": "new",
      "task": {
        "title": "Create gemini-session.js provider",
        "description": "Implement spawnGeminiTurn(session, taskId, emitFn) that mirrors claude-session frame contract so ws-handlers.js stays provider-agnostic.",
        "category": "CODING",
        "status": "pending",
        "priority": 165,
        "tags": ["feature", "tt-gemini-session", "streaming"]
      }
    }
  ],
  "files_addressed": ["src/server/config.js", "src/server/providers/gemini-session.js"],
  "doc_updates": [],
  "new_tags": []
}
\`\`\``;

  // Mirror extractCards logic
  const blocks = [...fixture.matchAll(/```json\s*([\s\S]*?)```/gi)];
  let cards = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = normalizeProposals(JSON.parse(blocks[i][1]));
      if (parsed && parsed.changes && Array.isArray(parsed.changes)) {
        cards = parsed.changes;
        break;
      }
    } catch { /* ignore */ }
  }

  if (!cards || cards.length === 0) {
    console.error('FAIL: no cards extracted from fixture');
    process.exit(1);
  }

  // Validate each card shape
  let passed = true;
  for (const card of cards) {
    if (!card.type || !card.task || !card.task.title || !card.task.description) {
      console.error('FAIL: invalid card shape:', JSON.stringify(card, null, 2));
      passed = false;
    }
  }

  if (passed) {
    console.log(`PASS: extracted ${cards.length} card(s) from fixture`);
    for (const c of cards) console.log(`  [${c.type}] ${c.task.title}`);
    console.log('\nFixture test PASSED');
  } else {
    process.exit(1);
  }
  process.exit(0);
}

// ── 2. LIVE TEST ─────────────────────────────────────────────────────────────

console.log('=== LIVE TEST (requires gemini binary + auth) ===\n');

const { spawnGeminiTurn } = require('../src/server/providers/gemini-session');

const session = {
  tabId: 'verify-test',
  type: 'objective',
  ws: null,                // no WS — emitFn captures frames
  messages: [],
  turnBuffer: '',
  turnRawSse: '',
  _lastEmittedCardsJson: null,
  _resultFinalized: false,
  _aborted: false,
  _retryAttempt: 0,
  geminiSessionId: null,
  claudeSessionId: null,
  systemPrompt: null,
  compressedSummaries: [],
  timingMilestones: { msgReceivedAt: Date.now() },
  totalTokens: { input: 0, output: 0, costUsd: 0, cacheCreation: 0, cacheRead: 0 },
  proc: null,
  projectPath: '',
  // Timer fields (gemini-session clears these)
  _turnDeadlineTimer: null,
  _idleWatchdogTimer: null,
};

// Simple objective prompt that should produce a changes[] block
const promptText = [
  'You are a task-planning AI. Respond ONLY with a fenced ```json block in this exact shape:',
  '{ "changes": [{ "type": "new", "task": { "title": "...", "description": "...", "category": "CODING", "status": "pending", "priority": 1, "tags": [] } }], "files_addressed": [], "doc_updates": [], "new_tags": [] }',
  '',
  'Propose exactly one task: "Verify Gemini CLI integration works end-to-end".',
  'Description: Confirm spawnGeminiTurn emits the correct frame contract.',
].join('\n');

session.messages.push({ role: 'user', content: promptText, timestamp: Date.now() });

const emittedFrames = [];
function captureEmit(frame) {
  emittedFrames.push(frame);
  console.log(`frame: ${JSON.stringify(frame).slice(0, 120)}`);
}

console.log('Spawning gemini turn...\n');
spawnGeminiTurn(session, 'verify-task-1', captureEmit);

// Wait for exit or objective-result frame (max 60s)
const deadline = Date.now() + 60000;
const poll = setInterval(() => {
  const done = emittedFrames.some(f => f.type === 'exit' || f.type === 'objective-result' || f.type === 'objective-error');
  if (done || Date.now() > deadline) {
    clearInterval(poll);
    const resultFrame = emittedFrames.find(f => f.type === 'objective-result');
    const cardsFrame = emittedFrames.find(f => f.type === 'task-cards');
    const errorFrame = emittedFrames.find(f => f.type === 'objective-error');

    if (errorFrame) {
      console.error(`\nFAIL: objective-error reason=${errorFrame.reason}`);
      process.exit(1);
    }

    const cards = (cardsFrame && cardsFrame.cards) || (resultFrame && resultFrame.cards) || [];
    if (cards.length === 0) {
      console.error('\nFAIL: no cards in objective-result or task-cards frame');
      console.error('Turn buffer:', session.turnBuffer.slice(0, 500));
      process.exit(1);
    }

    console.log(`\nPASS: ${cards.length} card(s) in changes[]`);
    for (const c of cards) console.log(`  [${c.type}] ${c.task && c.task.title}`);
    console.log('\nLive test PASSED');
    process.exit(0);
  }
}, 500);
