#!/usr/bin/env node
'use strict';

// Spawn real Claude with the task terminal's /design submission and inspect PTY
// output for the AskUserQuestion menu versus design-generation progress. A bare
// /design asks for a brief; the task text must be in the same submission.
// PTY inspection works even when inherited CLAUDE_CODE_CHILD_SESSION disables
// transcript files. --cwd may trigger workspace trust; each variant uses real
// inference. Examples:
//   npm run probe:design
//   npm run probe:design -- --variant A
//   npm run probe:design -- --cwd /tmp/scratch

const fs = require('node:fs');
const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const { stripAnsi } = require('../src/server/terminal-session');

const READY_EXTRA_MS = 1500;   // grace beyond agent.getInteractiveReadyMs() before the first write
const POLL_MS = 2000;
const MAX_WAIT_MS = 60000; // ceiling per variant — real design generation can take a while to show clear signal

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Mirrors terminal-session.js's own idle-silence detection (C947) so probe timing matches
// production behavior instead of a guess — see probe-image-paste.js's identical helper.
async function waitForQuiet(getBuffer, { minWaitMs, quietMs, maxMs }) {
  const start = Date.now();
  await sleep(minWaitMs);
  let lastLen = getBuffer().length;
  let lastChangeAt = Date.now();
  for (;;) {
    const len = getBuffer().length;
    if (len !== lastLen) { lastLen = len; lastChangeAt = Date.now(); }
    if (Date.now() - lastChangeAt >= quietMs) return;
    if (Date.now() - start >= maxMs) return;
    await sleep(POLL_MS);
  }
}

// Same anchors as prompt-detect.js's CLAUDE_ASK_QUESTION_PATTERNS — model-independent chrome
// the AskUserQuestion component always renders itself (free-text row placeholder, trailing
// "Chat about this" row), plus the literal menu header from the design skill's own "empty
// request" exit, confirmed present verbatim in a real captured session.
const ASK_MENU_RE = /Design brief|What (?:should|do) (?:I|you) design|Type something\.?\b|Chat about this/i;

// Chrome the design skill itself renders once it's actually generating (not asking) —
// confirmed live: launching background sub-agents and the skill's own "Transmuting…" spinner
// label both appeared within ~20s for a real brief with the no-ask suffix, well before the
// 60s ceiling.
const GENERATING_RE = /background agents? launched|Transmuting…|\.dc\.html|canvas\.json/i;

function classify(buffer) {
  const clean = stripAnsi(buffer);
  return {
    hasAskMenu: ASK_MENU_RE.test(clean),
    isGenerating: GENERATING_RE.test(clean),
    clean,
  };
}

function buildVariants(agent, sentinel) {
  const longDesc = `Work on task PROBE: exercise the design-mode kickoff probe (sentinel ${sentinel}). ` +
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(50);
  return [
    {
      name: 'A: bare /design (control — reproduces the pre-C1272 bug)',
      prompt: '/design',
      expectAskMenu: true,
      note: 'the skill\'s own "empty request" rule asks and stops — this is the C1207/C1260 bug, reproduced deliberately',
    },
    {
      name: 'B: /design <short one-line brief> (production buildPrompt(), short task)',
      prompt: agent.buildPrompt(`Add a small changelog widget to the settings page (probe sentinel ${sentinel})`, { designMode: true }),
      expectAskMenu: false,
    },
    {
      name: 'C: /design <~4000-char flattened brief> (production shape — this is what a real task sends)',
      prompt: agent.buildPrompt(`${longDesc} sentinel-marker:${sentinel}`, { designMode: true }),
      expectAskMenu: false,
    },
    {
      name: 'D: /design <line1>\\n<body> (expected NOT to register as a command — pins the C1260 finding)',
      prompt: `/design Probe line one, sentinel ${sentinel}\nProbe line two, deliberately on its own line so the argument is multi-line.`,
      expectAskMenu: false,
      expectGenerating: false,
      note: 'a multi-line first line breaks command parsing (C1260) — expect neither the ask-menu nor design-skill generation chrome, since /design never registers as a command at all',
    },
  ];
}

async function probeVariant(agent, spec, variant) {
  const ptyProc = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: spec.cwd, env: spec.env,
  });
  let buffer = '';
  ptyProc.onData((d) => { buffer += d; });
  try {
    await waitForQuiet(() => buffer, {
      minWaitMs: agent.getInteractiveReadyMs() + READY_EXTRA_MS,
      quietMs: agent.getPasteSilenceMs(),
      maxMs: 15000,
    });
    buffer = '';
    // Same discipline as terminal-session.js's injector: bracketed paste, wait for the echo to
    // settle, THEN a separate Enter — not one write, so the CLI's Ink TUI sees two distinct
    // input events rather than a paste-plus-newline chunk it might not parse as a submission.
    ptyProc.write(`\x1b[200~${variant.prompt}\x1b[201~`);
    await waitForQuiet(() => buffer, { minWaitMs: 300, quietMs: agent.getPasteSilenceMs(), maxMs: 4000 });
    buffer = ''; // isolate what happens AFTER submission from the paste-echo itself
    ptyProc.write('\r');
    const start = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      const result = classify(buffer);
      if (result.hasAskMenu || result.isGenerating) return result;
      if (Date.now() - start >= MAX_WAIT_MS) return result;
    }
  } finally {
    try { ptyProc.kill(); } catch { /* already dead */ }
  }
}

function parseArgs(argv) {
  const out = { cwd: null, variant: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') out.cwd = argv[++i];
    else if (argv[i] === '--variant') out.variant = argv[++i];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const agent = getTaskAgent('claude');
  const status = await agent.cachedDetect(config, true);
  if (!status.available) {
    console.error(`[probe-design-mode] claude not available: ${status.reason}`);
    process.exitCode = 1;
    return;
  }
  if (process.env.CLAUDE_CODE_CHILD_SESSION) {
    console.log('[probe-design-mode] NOTE: running inside another Claude Code session (CLAUDE_CODE_CHILD_SESSION set) — the spawned child\'s own transcript saving will be disabled, but this probe does not depend on it (see header comment).');
  }

  const spec = await agent.getSpawnSpec(
    config,
    'Design-mode probe placeholder — never actually sent, each variant pastes its own text.',
    null,
    { taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: config.PROJECT_ROOT },
  );
  if (opts.cwd) {
    fs.mkdirSync(opts.cwd, { recursive: true });
    spec.cwd = opts.cwd;
    console.log(`[probe-design-mode] spawning in throwaway cwd: ${opts.cwd}`);
    console.log('[probe-design-mode] NOTE: a cwd Claude Code has never opened before may hit the workspace-trust first-run screen — this probe does not auto-answer it. See the header comment.');
  }

  const sentinel = Math.random().toString(36).slice(2, 10);
  const variants = buildVariants(agent, sentinel);
  const selected = opts.variant
    ? variants.filter((v) => v.name.toUpperCase().startsWith(opts.variant.toUpperCase()))
    : variants;
  if (selected.length === 0) {
    console.error(`[probe-design-mode] no variant matches --variant ${opts.variant}`);
    process.exitCode = 1;
    return;
  }

  let anyUnexpected = false;
  for (const variant of selected) {
    console.log(`\n=== ${variant.name} ===`);
    const result = await probeVariant(agent, spec, variant);
    console.log(`  ask-menu chrome seen: ${result.hasAskMenu ? 'YES' : 'no'}`);
    console.log(`  generation chrome seen: ${result.isGenerating ? 'YES' : 'no'}`);
    if (variant.note) console.log(`  note: ${variant.note}`);
    const askOk = result.hasAskMenu === variant.expectAskMenu;
    const genOk = variant.expectGenerating === undefined || result.isGenerating === variant.expectGenerating;
    if (!askOk || !genOk) {
      anyUnexpected = true;
      console.log(`  UNEXPECTED (expected ask-menu=${variant.expectAskMenu}${variant.expectGenerating !== undefined ? `, generating=${variant.expectGenerating}` : ''})`);
      console.log('  --- last output ---');
      console.log(result.clean.slice(-1200).split('\n').map((l) => '    ' + l).join('\n'));
    } else {
      console.log('  OK');
    }
  }

  if (anyUnexpected) {
    console.error('\n[probe-design-mode] one or more variants did not behave as expected — see UNEXPECTED lines above.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
