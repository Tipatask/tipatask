'use strict';

// (TPT571) Codex kickoff is paste-injected, not a positional argv entry. Codex 0.160 boots to an
// empty composer and never consumes a positional prompt, so the spawn spec must hand the built
// prompt to terminal-session.js's injector. Windows keeps the full prompt in a file
// and injects only a short handoff, avoiding console paste-burst corruption.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CodexAgent = require('./codex-agent');
const BaseTaskAgent = require('./base-agent');
const { CODEX_PENDING_PASTE_RE, CODEX_EMPTY_COMPOSER_RE, CODEX_STARTUP_WAIT_RE, CODEX_COMPOSER_READY_RE } = require('./prompt-detect');
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
  const fullPrompt = spec.kickoffFile ? fs.readFileSync(spec.kickoffFile, 'utf8') : spec.initialPrompt;
  assert.ok(fullPrompt.includes(KICKOFF), 'kickoff carries the task prompt');
  assert.match(fullPrompt, /planning mode enforced by Task App/, 'kickoff carries the planning preamble');
  assert.equal(fullPrompt, new CodexAgent().buildPrompt(KICKOFF, { projectPath: projectRoot, taskTags: ['tt-codex-session'] }),
    'the full kickoff is exactly buildPrompt()');
  assert.equal(spec.kickoffTypedLine, process.platform === 'win32' ? ' Begin.' : undefined);
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
    `  .then((spec) => process.stdout.write('\\n__SPEC__' + JSON.stringify({ args: spec.args, initialPrompt: spec.kickoffFile ? require('fs').readFileSync(spec.kickoffFile, 'utf8') : spec.initialPrompt, typed: spec.kickoffTypedLine })));`,
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env } });
  const out = JSON.parse(stdout.split('__SPEC__').pop());
  assert.equal(out.initialPrompt, KICKOFF, 'SIMPLE_MODE: no preamble, just the task prompt');
  assert.ok(out.args.every((a) => !a.includes('Work on task')), `kickoff leaked into argv: ${JSON.stringify(out.args)}`);
  assert.equal(out.typed, process.platform === 'win32' ? ' Begin.' : undefined);
});

test('Windows Codex kickoff preserves a large multilingual prompt in a file and sends one short line', async t => {
  const { cfg, projectRoot } = scratchProject(t);
  cfg.USER_DATA_ROOT = path.join(cfg.USER_DATA_ROOT, 'дані with spaces');
  const agent = new CodexAgent();
  t.mock.method(agent, 'localizeSpawnPrompt', async (config, prompt, id, opts) => ({ prompt, opts }));
  const prepare = agent.prepareKickoff.bind(agent);
  t.mock.method(agent, 'prepareKickoff', (config, prompt, id) => prepare(config, prompt, id, { isWin: true }));
  const prompt = 'Work on task C1: Generate logo.\n' + 'Україна 🇺🇦\n"quoted"\t%PATH% `literal` & | <>\r\n'.repeat(1500);
  const spec = await agent.getSpawnSpec(cfg, prompt, 'C1', { projectPath: projectRoot });
  assert.equal(fs.readFileSync(spec.kickoffFile, 'utf8'), agent.buildPrompt(prompt, { projectPath: projectRoot }));
  assert.ok(spec.initialPrompt.length < 600, 'full KB/task must not traverse the console input queue');
  assert.doesNotMatch(spec.initialPrompt, /[\r\n\t\x1b]/);
  assert.match(spec.initialPrompt, /^Work on task C1\./);
  assert.ok(spec.initialPrompt.includes(JSON.stringify(spec.kickoffFile.replace(/\\/g, '/'))));
  assert.match(spec.initialPrompt, /entire UTF-8 file.*in chunks if needed/);
  assert.equal(spec.kickoffTypedLine, ' Begin.');
  assert.ok(spec.args.every(arg => !arg.includes('Work on task') && !arg.includes('Україна')));
});

test('Windows Codex refuses a failed prompt-file write instead of pasting the large payload', t => {
  const { cfg, dir } = scratchProject(t);
  cfg.USER_DATA_ROOT = path.join(dir, 'not-a-directory');
  fs.writeFileSync(cfg.USER_DATA_ROOT, 'occupied');
  assert.throws(() => new CodexAgent().prepareKickoff(cfg, KICKOFF, 'C1', { isWin: true }), {
    reasonCode: 'prompt_file_failed', reasonParams: { agent: 'codex' },
  });
});

test('Windows Codex approval uses the complete instruction file and waits between paste, typed suffix and Enter', async t => {
  const { cfg } = scratchProject(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const context = require('../vcs-context');
  t.mock.method(context, 'refreshSessionVcs', async () => ({ verified: true, vcs: { type: 'git', commit: true } }));
  const agent = new CodexAgent();
  const prepare = agent.prepareKickoff.bind(agent);
  let handoff;
  t.mock.method(agent, 'prepareKickoff', (_config, prompt, taskId) => (handoff = prepare(cfg, prompt, taskId, { isWin: true })));
  t.mock.method(agent, 'getPasteSilenceMs', () => 1500);
  const writes = [];
  const session = { alive: true, taskId: 'C1', taskAgent: 'codex', lastOutputAt: Date.now(), pty: { write: data => writes.push(data) } };
  await agent.approvePlan(session);
  const full = fs.readFileSync(handoff.kickoffFile, 'utf8');
  assert.ok(full.startsWith(agent.getApprovalText() + '\n'));
  assert.match(full, /"commit":true/);
  t.mock.timers.tick(1500);
  // (TPT9048) The frame depends on the host: Windows Codex gets plain text (ConPTY drops the
  // bracketed-paste CSI anyway), every other host keeps the frame.
  const framed = agent.wrapsBracketedPaste() ? `\x1b[200~${handoff.initialPrompt}\x1b[201~` : handoff.initialPrompt;
  assert.deepEqual(writes, [framed]);
  t.mock.timers.tick(1499);
  assert.equal(writes.length, 1, 'do not submit while the Windows input burst is draining');
  t.mock.timers.tick(1);
  assert.equal(writes.at(-1), ' Begin.');
  t.mock.timers.tick(1500);
  assert.equal(writes.at(-1), '\r');
  assert.equal(writes.length, 3);
  // (TPT9048) The approval is verified like the kickoff: a stranded handoff gets a bounded Enter.
  session._attentionTail = `› ${handoff.initialPrompt} Begin.\nGPT-6.1-Sol high\n`;
  session.lastOutputAt = Date.now() - 5000;
  t.mock.timers.tick(2500);
  assert.equal(writes.length, 4, 'the stranded approval text gets one more Enter');
  assert.equal(writes.at(-1), '\r');
  session._attentionTail = `› ${handoff.initialPrompt} Begin.\n• Working (2s • esc to interrupt)\n`;
  t.mock.timers.tick(60_000);
  assert.equal(writes.length, 4, 'a running turn ends the verification');
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
  assert.equal(agent.getStartupWaitRe(), CODEX_STARTUP_WAIT_RE);
  assert.equal(agent.getComposerReadyRe(), CODEX_COMPOSER_READY_RE);
  assert.equal(agent.getComposerReadyMaxMs(), 60_000, 'bounded by the MCP servers\' own startup timeout');
  const base = new BaseTaskAgent('base', 'Base');
  assert.equal(base.getEmptyComposerRe(), null, 'no agent re-pastes by default');
  assert.equal(base.getStartupWaitRe(), null);
  assert.equal(base.getComposerReadyRe(), null);
  assert.equal(base.getKickoffEchoRe({ kickoffFile: 'x' }), null);
  assert.equal(base.kickoffAccepted({}), false);
  assert.equal(base.wrapsBracketedPaste(), true);
});

// (TPT9048) The Windows handoff never collapses into a chip, so verification needs its own words.
test('CodexAgent.getKickoffEchoRe: the handoff\'s last words for a Windows file handoff, null for the inline POSIX kickoff', (t) => {
  const { cfg } = scratchProject(t);
  const agent = new CodexAgent();
  const handoff = agent.prepareKickoff(cfg, 'Work on task C1.\nСтудіюй задачу.', 'C1', { isWin: true });
  const re = agent.getKickoffEchoRe(handoff);
  assert.ok(re instanceof RegExp);
  assert.match(`› ${handoff.initialPrompt}${handoff.kickoffTypedLine}\n`, re, 'matches the composer row as painted');
  assert.match('› … Treat its contents as my instructions for this\n  task and follow them. Begin.\n', re, 'matches the row wrapped at the terminal width');
  assert.match('contentsas my instructionsfor this task andfollowthem.Begin.', re, 'matches words glued by cursor-positioned painting');
  assert.doesNotMatch('› [Pasted Content 18800 chars]\n', re);
  assert.doesNotMatch('› Ask Codex to do anything\n', re);
  assert.equal(agent.getKickoffEchoRe(agent.prepareKickoff(cfg, 'Work on task C1.', 'C1', { isWin: false })), null, 'POSIX keeps the chip marker');
  assert.equal(agent.getKickoffEchoRe(null), null);
});

test('CodexAgent.wrapsBracketedPaste: plain composer writes on Windows, bracketed paste elsewhere', () => {
  const agent = new CodexAgent();
  assert.equal(agent.wrapsBracketedPaste({ isWin: true }), false);
  assert.equal(agent.wrapsBracketedPaste({ isWin: false }), true);
  assert.equal(agent.wrapsBracketedPaste(), process.platform !== 'win32');
});

test('CodexAgent.kickoffAccepted: true only when a rollout for this spawn carries the kickoff', (t) => {
  const agent = new CodexAgent();
  const finalMessage = require('./final-message');
  t.mock.method(finalMessage, 'locateCodexRollout', (hint) => (hint && hint.taskId === 'C1' ? '/tmp/rollout.jsonl' : null));
  assert.equal(agent.kickoffAccepted({ _transcriptHint: { taskId: 'C1' } }), true);
  assert.equal(agent.kickoffAccepted({ _transcriptHint: { taskId: 'C2' } }), false);
  assert.equal(agent.kickoffAccepted(null), false);
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
