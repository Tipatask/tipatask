#!/usr/bin/env node
'use strict';

/**
 * Benchmark claude CLI startup stages for objective-chat proc_startup optimization (C360).
 *
 * Usage:
 *   node scripts/bench-claude-startup.js [--runs N] [--variant all|full|no-mcp|no-project|stdin-blocking]
 *
 * Variants:
 *   full           Full args matching spawnObjectiveTurn (baseline)
 *   no-mcp         Remove MCP tools from --allowedTools (isolates MCP init cost)
 *   no-project     Run from /tmp (no .mcp.json discovery, no CLAUDE.md)
 *   stdin-blocking  Full args but stdin held open 3s — verifies if init fires before EOF
 *
 * Output: median + p95 per stage per variant (ms).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = require('../src/server/project-root').resolveProjectRoot();

// Load config for CLAUDE_MODEL, OBJECTIVE_EFFORT
process.chdir(SERVER_ROOT);
const config = require('../src/server/config');

const RUNS = (() => {
  const idx = process.argv.indexOf('--runs');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

const VARIANT_ARG = (() => {
  const idx = process.argv.indexOf('--variant');
  return idx !== -1 ? process.argv[idx + 1] : 'all';
})();

const ALLOWED_TOOLS_FULL = 'Read,Glob,Grep,mcp__tipatask__list_system_tags,mcp__tipatask__get_tag_architecture,mcp__tipatask__list_tasks,mcp__tipatask__get_task';
const ALLOWED_TOOLS_NO_MCP = 'Read,Glob,Grep';

const BASE_ARGS = [
  '-p', '--verbose',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--exclude-dynamic-system-prompt-sections',
  '--permission-mode', 'acceptEdits',
];

const VARIANTS = {
  full: {
    label: 'Full args (baseline)',
    cwd: PROJECT_ROOT,
    args: [...BASE_ARGS, '--model', config.CLAUDE_MODEL, '--effort', config.OBJECTIVE_EFFORT,
           '--allowedTools', ALLOWED_TOOLS_FULL],
    stdinHoldMs: 0,
    prompt: 'Reply only with "ok".',
  },
  'no-mcp': {
    label: 'No MCP tools in --allowedTools',
    cwd: PROJECT_ROOT,
    args: [...BASE_ARGS, '--model', config.CLAUDE_MODEL, '--effort', config.OBJECTIVE_EFFORT,
           '--allowedTools', ALLOWED_TOOLS_NO_MCP],
    stdinHoldMs: 0,
    prompt: 'Reply only with "ok".',
  },
  'no-project': {
    label: 'cwd=/tmp (no .mcp.json, no CLAUDE.md)',
    cwd: '/tmp',
    args: [...BASE_ARGS, '--model', config.CLAUDE_MODEL, '--effort', config.OBJECTIVE_EFFORT,
           '--allowedTools', ALLOWED_TOOLS_NO_MCP],
    stdinHoldMs: 0,
    prompt: 'Reply only with "ok".',
  },
  'stdin-blocking': {
    label: 'Full args, stdin held 3s — verifies init-before-EOF',
    cwd: PROJECT_ROOT,
    args: [...BASE_ARGS, '--model', config.CLAUDE_MODEL, '--effort', config.OBJECTIVE_EFFORT,
           '--allowedTools', ALLOWED_TOOLS_FULL],
    stdinHoldMs: 3000,
    prompt: 'Reply only with "ok".',
  },
  'cold-prewarm': {
    label: 'Cold prewarm (no --resume), stdin held 2s — first-turn savings',
    cwd: PROJECT_ROOT,
    args: [...BASE_ARGS, '--model', config.CLAUDE_MODEL, '--effort', config.OBJECTIVE_EFFORT,
           '--allowedTools', ALLOWED_TOOLS_FULL],
    stdinHoldMs: 2000,
    prompt: 'Reply only with "ok".',
  },
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return percentile(s, 50);
}

function p95(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return percentile(s, 95);
}

function fmt(v) {
  return v == null ? '  n/a  ' : String(v).padStart(6) + 'ms';
}

async function runOnce(variant) {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const proc = spawn(config.CLAUDE_BIN, variant.args, {
      cwd: variant.cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const result = {
      spawnedAt,
      firstStderrAt: null,
      mcpServerStartedAt: null,
      firstStdoutAt: null,
      initEventAt: null,
      firstChunkAt: null,
      closeAt: null,
      initFiredBeforeStdinEOF: false,
      exitCode: null,
    };

    proc.stderr.on('data', (chunk) => {
      if (!result.firstStderrAt) result.firstStderrAt = Date.now();
      const s = chunk.toString();
      if (!result.mcpServerStartedAt) {
        const m = s.match(/\[mcp:tipatask:ready ts=(\d+)\]/);
        if (m) result.mcpServerStartedAt = parseInt(m[1], 10);
      }
    });

    let sseBuffer = '';
    proc.stdout.on('data', (chunk) => {
      if (!result.firstStdoutAt) {
        result.firstStdoutAt = Date.now();
        // True only if stdout arrives BEFORE stdin was closed
        if (variant.stdinHoldMs > 0 && !stdinClosed) result.initFiredBeforeStdinEOF = true;
      }
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('{')) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === 'system' && ev.subtype === 'init' && !result.initEventAt) {
            result.initEventAt = Date.now();
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !result.firstChunkAt) {
            result.firstChunkAt = Date.now();
          }
        } catch {}
      }
    });

    // Write (and optionally hold) stdin
    let stdinClosed = false;
    const writeStdin = () => {
      stdinClosed = true;
      proc.stdin.write(variant.prompt);
      proc.stdin.end();
    };
    if (variant.stdinHoldMs > 0) {
      setTimeout(writeStdin, variant.stdinHoldMs);
    } else {
      writeStdin();
    }

    proc.on('close', (code) => {
      result.closeAt = Date.now();
      result.exitCode = code;
      resolve(result);
    });
    proc.on('error', (err) => {
      result.closeAt = Date.now();
      result.error = err.message;
      resolve(result);
    });

    // Hard timeout — 60s
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 60000);
  });
}

function computeSpans(r) {
  const s = r.spawnedAt;
  return {
    proc_startup:       r.firstStdoutAt    ? r.firstStdoutAt    - s : null,
    bin_to_stderr:      r.firstStderrAt    ? r.firstStderrAt    - s : null,
    bin_to_mcp_ready:   r.mcpServerStartedAt ? r.mcpServerStartedAt - s : null,
    mcp_to_stdout:      (r.mcpServerStartedAt && r.firstStdoutAt) ? r.firstStdoutAt - r.mcpServerStartedAt : null,
    stdout_to_init:     (r.firstStdoutAt && r.initEventAt) ? r.initEventAt - r.firstStdoutAt : null,
    init_to_first_chunk:(r.initEventAt && r.firstChunkAt) ? r.firstChunkAt - r.initEventAt : null,
    total_wall:         r.closeAt          ? r.closeAt          - s : null,
  };
}

async function runVariant(key, variant) {
  console.log(`\n▶  Variant: ${variant.label}  (${RUNS} runs)`);
  const allSpans = {};
  const initBeforeEOF = [];

  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  run ${i + 1}/${RUNS}...`);
    const r = await runOnce(variant);
    process.stdout.write(` done (${r.closeAt - r.spawnedAt}ms)\n`);
    if (r.error) { console.log(`    error: ${r.error}`); continue; }
    const spans = computeSpans(r);
    for (const [k, v] of Object.entries(spans)) {
      if (!allSpans[k]) allSpans[k] = [];
      if (v != null) allSpans[k].push(v);
    }
    initBeforeEOF.push(r.initFiredBeforeStdinEOF);
  }

  console.log(`\n  Stage breakdown:`);
  const stageOrder = ['proc_startup', 'bin_to_stderr', 'bin_to_mcp_ready', 'mcp_to_stdout', 'stdout_to_init', 'init_to_first_chunk', 'total_wall'];
  for (const stage of stageOrder) {
    const vals = allSpans[stage] || [];
    const med = vals.length ? median(vals) : null;
    const p = vals.length ? p95(vals) : null;
    console.log(`    ${stage.padEnd(24)} median=${fmt(med)}  p95=${fmt(p)}  n=${vals.length}`);
  }

  if (variant.stdinHoldMs > 0) {
    const hitCount = initBeforeEOF.filter(Boolean).length;
    const postStdinMs = (allSpans.proc_startup || []).map(v => v - variant.stdinHoldMs).filter(v => v > 0);
    const postStdinMedian = postStdinMs.length ? median(postStdinMs) : null;
    console.log(`\n  [stdin-blocking analysis]`);
    console.log(`  Init event fired before stdin close: ${hitCount}/${RUNS} runs`);
    console.log(`  Post-stdin API time: ${fmt(postStdinMedian)} (proc_startup - ${variant.stdinHoldMs}ms hold)`);
    const fullBaseline = allSpans.proc_startup && allSpans.proc_startup[0];
    if (postStdinMedian && fullBaseline) {
      const mcpParallel = fullBaseline - postStdinMedian;
      console.log(`  MCP parallel init savings (full_baseline - post_stdin_api): ~${mcpParallel}ms`);
      console.log(`  → Pre-warm saves ~${mcpParallel}ms by overlapping MCP init with user think time`);
    }
  }
}

async function main() {
  const variantKeys = VARIANT_ARG === 'all' ? Object.keys(VARIANTS) : [VARIANT_ARG];

  console.log(`Claude startup bench  claude=${config.CLAUDE_BIN}  model=${config.CLAUDE_MODEL}  effort=${config.OBJECTIVE_EFFORT}`);
  console.log(`Runs per variant: ${RUNS}`);

  for (const key of variantKeys) {
    if (!VARIANTS[key]) { console.error(`Unknown variant: ${key}`); process.exit(1); }
    await runVariant(key, VARIANTS[key]);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
