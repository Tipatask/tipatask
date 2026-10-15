'use strict';

// (TPT571) Codex kickoff is paste-injected, not a positional argv entry. Codex 0.160 boots to an
// empty composer and never consumes a positional prompt, so the spawn spec must hand the built
// prompt to terminal-session.js's injector (spec.initialPrompt) exactly like Claude's does.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CodexAgent = require('./codex-agent');
const BaseTaskAgent = require('./base-agent');
const { CODEX_PENDING_PASTE_RE, CODEX_EMPTY_COMPOSER_RE } = require('./prompt-detect');
const { clearBinCache } = require('../spawn-utils');

function scratchProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-kickoff-'));
  const previousCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const projectRoot = path.join(dir, 'project');
  const globalCodexHome = path.join(dir, 'user-codex');
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.mkdirSync(globalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), '', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    API_BASE_URL: 'https://codex-kickoff.test', API_PROJECT_ID: '2', API_TOKEN: 'test-token',
  }), 'utf8');
  process.env.CODEX_HOME = globalCodexHome;
  return { dir, projectRoot, cfg: { CODEX_BIN: 'codex', PROJECT_ROOT: projectRoot, USER_DATA_ROOT: dir } };
}

// taskId stays '' (as in effort-spawn.test.js): a real key makes localizeSpawnPrompt() look up
// attachments against the API, which is not what these tests are about.
const KICKOFF = 'Work on task TPT571: make the kickoff land.';

test('CodexAgent.getSpawnSpec: the kickoff is spec.initialPrompt, never a positional argv entry', async (t) => {
  const { cfg, projectRoot } = scratchProject(t);
  const spec = await new CodexAgent().getSpawnSpec(cfg, KICKOFF, '', { projectPath: projectRoot, taskTags: ['tt-codex-session'] });
  assert.ok(Array.isArray(spec.args));
  for (const arg of spec.args) {
    assert.ok(!arg.includes('Work on task'), `kickoff leaked into argv: ${arg.slice(0, 80)}`);
    assert.ok(!/planning mode enforced by Task App/.test(arg), `preamble leaked into argv: ${arg.slice(0, 80)}`);
  }
  assert.ok(spec.args.includes('--no-alt-screen'));
  assert.equal(typeof spec.initialPrompt, 'string');
  assert.ok(spec.initialPrompt.includes(KICKOFF), 'initialPrompt carries the task prompt');
  assert.match(spec.initialPrompt, /planning mode enforced by Task App/, 'initialPrompt carries the planning preamble');
  assert.equal(spec.initialPrompt, new CodexAgent().buildPrompt(KICKOFF, { projectPath: projectRoot, taskTags: ['tt-codex-session'] }),
    'initialPrompt is exactly buildPrompt() — the same text the positional arg used to carry');
  assert.equal(spec.kickoffTypedLine, undefined, 'Codex accepts a paste-only message: no typed kickoff line');
  assert.equal(spec.preludePrompt, undefined);
  assert.equal(spec.cwd, projectRoot);
});

test('CodexAgent.getSpawnSpec: SIMPLE_MODE — bare prompt in initialPrompt, still absent from argv', async (t) => {
  const { dir, projectRoot } = scratchProject(t);
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const CodexAgent = require(${JSON.stringify(path.join(__dirname, 'codex-agent.js'))});`,
    `const cfg = { CODEX_BIN: 'codex', PROJECT_ROOT: ${JSON.stringify(projectRoot)}, USER_DATA_ROOT: ${JSON.stringify(dir)} };`,
    `new CodexAgent().getSpawnSpec(cfg, ${JSON.stringify(KICKOFF)}, '', { projectPath: ${JSON.stringify(projectRoot)} })`,
    // getSpawnSpec() logs its launch mode to stdout; the JSON goes out as its own final line.
    `  .then((spec) => process.stdout.write('\\n__SPEC__' + JSON.stringify({ args: spec.args, initialPrompt: spec.initialPrompt, typed: spec.kickoffTypedLine })));`,
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env } });
  const out = JSON.parse(stdout.split('__SPEC__').pop());
  assert.equal(out.initialPrompt, KICKOFF, 'SIMPLE_MODE: no preamble, just the task prompt');
  assert.ok(out.args.every((a) => !a.includes('Work on task')), `kickoff leaked into argv: ${JSON.stringify(out.args)}`);
  assert.equal(out.typed, undefined);
});

test('CodexAgent injector tuning: longer boot floor and settle window than the base defaults', () => {
  const agent = new CodexAgent();
  const base = new BaseTaskAgent('base', 'Base');
  assert.ok(agent.getInteractiveReadyMs() > base.getInteractiveReadyMs(), 'ratatui boot (banner + model catalog + MCP) outlasts the base floor');
  assert.ok(agent.getPasteSilenceMs() > base.getPasteSilenceMs(), 'a large paste triggers a full composer repaint');
});

test('CodexAgent exposes the composer markers the submit verification needs', () => {
  const agent = new CodexAgent();
  assert.equal(agent.getUnsentPasteRe(), CODEX_PENDING_PASTE_RE);
  assert.equal(agent.getEmptyComposerRe(), CODEX_EMPTY_COMPOSER_RE);
  assert.equal(new BaseTaskAgent('base', 'Base').getEmptyComposerRe(), null, 'no agent re-pastes by default');
});

// (TPT572) detect() names the CLI build: `codex --version` runs beside the login probe and its parsed
// version rides in `detail.version` on every result, so the task-start gate log and
// scripts/probe-codex-kickoff.js can say which Codex took (or dropped) a kickoff.
test('CodexAgent.parseVersion: the bare version from `codex --version` output, null otherwise', () => {
  assert.equal(CodexAgent.parseVersion('codex-cli 0.160.0'), '0.160.0');
  assert.equal(CodexAgent.parseVersion('codex-cli 0.161.0-alpha.2\n'), '0.161.0-alpha.2');
  assert.equal(CodexAgent.parseVersion('codex 1.2.3'), '1.2.3');
  assert.equal(CodexAgent.parseVersion('v0.160.0'), '0.160.0');
  assert.equal(CodexAgent.parseVersion('WARNING: could not update PATH\ncodex-cli 0.160.0\n'), '0.160.0',
    'a warning line ahead of the version line is skipped');
  for (const junk of ['', null, undefined, 'Not logged in', 'codex-cli', 'Logged in using ChatGPT',
    '(node:4242) Warning: running under node v22.19.0']) {
    assert.equal(CodexAgent.parseVersion(junk), null, `no version in ${JSON.stringify(junk)}`);
  }
});

if (process.platform === 'win32') {
  test.skip('CodexAgent.detect() version against a stub launcher (POSIX shell stubs)', () => {});
} else {
  // Same seam as detect-detail.test.js: the documented CODEX_BIN override points detect() at a stub.
  async function detectWithStub(t, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-version-'));
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const previous = process.env.CODEX_BIN;
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
      clearBinCache('codex');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    process.env.CODEX_BIN = bin;
    clearBinCache('codex');
    return { bin, res: await new CodexAgent().detect({}) };
  }

  test('CodexAgent.detect(): a logged-in CLI carries exactly { bin, version } — no probe output', async (t) => {
    const { bin, res } = await detectWithStub(t,
      'case "$1" in --version) echo "codex-cli 0.160.0";; *) echo "Logged in using an API key - sk-proj-***ABCDE";; esac');
    assert.equal(res.available, true);
    assert.deepEqual(res.detail, { bin, version: '0.160.0' });
  });

  test('CodexAgent.detect(): a logged-out CLI keeps its TPT567 diagnostics and still names the version', async (t) => {
    const { bin, res } = await detectWithStub(t,
      'case "$1" in --version) echo "codex-cli 0.160.0";; *) echo "Not logged in"; exit 1;; esac');
    assert.equal(res.available, false);
    assert.match(res.reason, /not logged in/i);
    assert.equal(res.reasonCode, 'not_logged_in'); // (TPT9008)
    assert.deepEqual(res.detail, { bin, exit: 1, output: 'Not logged in', version: '0.160.0' });
  });

  test('CodexAgent.detect(): unparseable --version output leaves version null and availability alone', async (t) => {
    const { bin, res } = await detectWithStub(t,
      'case "$1" in --version) echo "something unexpected"; exit 2;; *) echo "Logged in using ChatGPT";; esac');
    assert.equal(res.available, true);
    assert.deepEqual(res.detail, { bin, version: null });
  });
}
