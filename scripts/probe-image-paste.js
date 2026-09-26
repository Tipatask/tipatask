#!/usr/bin/env node
'use strict';

// ── Image-paste attach probe (C1051) ──
// Spawns the real agent CLI (claude/codex) with the SAME argv/env
// spawnTerminal()/getSpawnSpec() use for a live task terminal, pastes a fixture image via
// each candidate escape-sequence variant, and reports whether the agent's own image-attach
// marker (BaseTaskAgent#getImageAttachMarkerRe()) shows up in the PTY output. Nothing is ever
// submitted (no Enter key) — this is pure attach detection, not a real task run, so it costs
// no model inference for Claude. For Codex, the initial-task prompt argv (which Codex begins
// executing on spawn — unlike Claude, whose prompt is PTY-injected separately after boot, see
// spawnTerminal()) is stripped before spawn for the same reason: we want an empty composer to
// paste into, not a live run.
//
// Usage:
//   npm run probe:paste            # probe every registered agent
//   npm run probe:paste -- claude  # probe one agent by id

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const { stripAnsi } = require('../src/server/terminal-session');

const FIXTURE = path.join(config.PROJECT_ROOT, 'ai/examples/img_4.png');
const READY_EXTRA_MS = 1500;   // grace beyond agent.getInteractiveReadyMs() before the first write
const VARIANT_WAIT_MS = 4000;  // max time to wait for the attach marker per variant
const QUIET_POLL_MS = 250;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function scratchImageCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-paste-probe-'));
  const dest = path.join(dir, 'probe-' + crypto.randomUUID() + '.png');
  fs.copyFileSync(FIXTURE, dest);
  return dest;
}

function writeImageToMacClipboard(pngPath) {
  const escaped = pngPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err) => (err ? reject(err) : resolve()));
  });
}

// Waits until `getBuffer()` stops growing for `quietMs`, with a `minWaitMs` floor and a
// `maxMs` ceiling — mirrors the idle-silence detection terminal-session.js uses for real
// paste injection (C947), so probe timing matches production behavior instead of a guess.
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
    await sleep(QUIET_POLL_MS);
  }
}

const VARIANTS = [
  {
    name: 'A: bracketed-paste bare path (current injectPastedImage bytes)',
    write: (imgPath) => '\x1b[200~' + imgPath + '\x1b[201~',
  },
  {
    name: 'B: OS-clipboard write + empty bracketed paste',
    skip: os.platform() !== 'darwin',
    prepare: async (imgPath) => writeImageToMacClipboard(imgPath),
    write: () => '\x1b[200~\x1b[201~',
  },
  {
    name: 'C: control — bare path, no bracketed-paste frame',
    write: (imgPath) => imgPath,
  },
];

// Each variant gets a fresh CLI process rather than reusing one PTY across variants. A
// reused-process approach (clearing the input line with Ctrl-U between writes) was tried
// first and produced a false MATCH for Codex's variant C: an unsubmitted image attachment
// chip from a prior variant survived the Ctrl-U line-clear and got redrawn into the next
// variant's "fresh" buffer window on Codex's full-repaint ratatui TUI. A clean process per
// variant has no such cross-contamination risk, at the cost of extra spawn time.
async function probeVariant(agent, agentId, spec, spawnArgs, variant) {
  let buffer = '';
  const ptyProc = pty.spawn(spec.command, spawnArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: spec.cwd,
    env: spec.env,
  });
  ptyProc.onData((d) => { buffer += d; });

  try {
    await waitForQuiet(() => buffer, {
      minWaitMs: agent.getInteractiveReadyMs() + READY_EXTRA_MS,
      quietMs: agent.getPasteSilenceMs(),
      maxMs: 15000,
    });

    const imgPath = scratchImageCopy();
    if (variant.prepare) await variant.prepare(imgPath);
    buffer = '';
    ptyProc.write(variant.write(imgPath));
    await waitForQuiet(() => buffer, {
      minWaitMs: 300,
      quietMs: agent.getPasteSilenceMs(),
      maxMs: VARIANT_WAIT_MS,
    });
    const clean = stripAnsi(buffer);
    const markerRe = agent.getImageAttachMarkerRe();
    return { variant: variant.name, imgPath, matched: markerRe.test(clean), tail: clean.slice(-1600) };
  } finally {
    try { ptyProc.kill(); } catch { /* already dead */ }
  }
}

async function probeAgent(agentId) {
  const agent = getTaskAgent(agentId);
  const status = await agent.cachedDetect(config, true);
  if (!status.available) {
    return { agentId, skipped: true, reason: status.reason || 'not available' };
  }

  const spec = await agent.getSpawnSpec(
    config,
    'Paste probe — do not act on this. Standby.',
    null,
    { taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: config.PROJECT_ROOT },
  );

  // Codex bakes its initial prompt into argv and starts executing on spawn (getSpawnSpec does
  // NOT return spec.initialPrompt the way ClaudeAgent does — see codex-agent.js). Drop it so
  // the probe boots to an empty composer instead of kicking off a real task run.
  const spawnArgs = agentId === 'codex' && spec.args.length > 0
    ? spec.args.slice(0, -1)
    : spec.args;

  const results = [];
  for (const variant of VARIANTS) {
    if (variant.skip) {
      results.push({ variant: variant.name, skipped: true });
      continue;
    }
    results.push(await probeVariant(agent, agentId, spec, spawnArgs, variant));
  }

  return { agentId, results };
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const agentIds = requested.length > 0 ? requested : ['claude', 'codex'];

  console.log(`[probe-image-paste] fixture: ${FIXTURE}`);
  if (!fs.existsSync(FIXTURE)) {
    console.error(`[probe-image-paste] fixture missing: ${FIXTURE}`);
    process.exitCode = 1;
    return;
  }

  for (const agentId of agentIds) {
    console.log(`\n=== ${agentId} ===`);
    let report;
    try {
      report = await probeAgent(agentId);
    } catch (err) {
      console.log(`  ERROR: ${(err && err.stack) || err}`);
      continue;
    }
    if (report.skipped) {
      console.log(`  SKIPPED: ${report.reason}`);
      continue;
    }
    for (const r of report.results) {
      if (r.skipped) { console.log(`  - ${r.variant}: skipped (platform)`); continue; }
      console.log(`  - ${r.variant}: ${r.matched ? 'MATCHED' : 'no match'}`);
      if (!r.matched) {
        console.log('    --- last output ---');
        console.log(r.tail.split('\n').slice(-40).map((l) => '    ' + l).join('\n'));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
