'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, parsePromptFile, resolveMentions, buildVariants, createCollector,
  rankVariants, cannotContinue, runVariant, main } = require('../../scripts/probe-objective-prompt-size');
const { buildPromptDump } = require('./objective-prompt-dump');

test('live gate refuses before any source/scratch work; option mistakes are explicit', async () => {
  assert.equal(await main(['--prompt', '/does/not/exist']), 2);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /between/);
  assert.throws(() => parseArgs(['--prompt']), /missing value/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  assert.equal(parseArgs(['--yes', '--timeout-ms', '1000']).timeoutMs, 1000);
});

test('dump reader preserves exact UTF-8 body and rejects stale offsets/counts', () => {
  const stdin = 'Привіт 🌍\r\n@src/app.js\n---- stdin (exact) ----\n';
  const dump = buildPromptDump({ taskId: 'probe', turnIdx: 1, mode: 'fresh', systemPromptChars: 10, stdin });
  const buffer = Buffer.from(dump.header + dump.body);
  assert.equal(parsePromptFile(buffer).text, stdin);
  assert.equal(parsePromptFile(buffer).metadata.systemPromptChars, 10);
  assert.throws(() => parsePromptFile(Buffer.concat([buffer, Buffer.from('x')])), /counts/);
  assert.throws(() => parsePromptFile(Buffer.from(buffer.toString().replace(/body starts at byte \d+/, 'body starts at byte 1'))), /offset/);
  assert.throws(() => parsePromptFile(Buffer.from('# objective-prompt\nbroken')), /separator/);
  assert.equal(parsePromptFile(Buffer.from('raw 🌍\n')).text, 'raw 🌍\n');
});

test('cwd controls preserve @file resolution and leave emails intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-size-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  fs.writeFileSync(path.join(root, 'a b.txt'), 'x');
  const result = resolveMentions('(@file.txt) @"a b.txt" mail@host.test @missing.md', root);
  assert.equal(result.resolved, 2);
  assert.deepEqual(result.missing, ['missing.md']);
  assert.ok(result.text.includes(`@${path.join(root, 'file.txt')}`));
  assert.ok(result.text.includes(`@${JSON.stringify(path.join(root, 'a b.txt'))}`));
  assert.ok(result.text.includes('mail@host.test'));
  const sentence = resolveMentions('@file.txt.', root);
  assert.equal(sentence.text, `@${path.join(root, 'file.txt')}.`);
  assert.deepEqual(sentence.missing, []);
});

test('each ablation changes only its target; production argv stays immutable', () => {
  const args = ['--model', 'M', '--append-system-prompt', 'SYSTEM', '--mcp-config', '/mcp.json', '--strict-mcp-config', '--max-turns', '1'];
  const snapshot = args.slice();
  const rows = buildVariants(args, '@file', '/project', '/empty', value => value.replace('@', '＠'));
  assert.equal(rows.length, 5);
  assert.deepEqual(args, snapshot);
  assert.deepEqual(rows[0].args, args);
  assert.ok(!rows[1].args.includes('SYSTEM'));
  assert.ok(rows[2].args.includes('{"mcpServers":{}}'));
  assert.ok(rows[2].args.includes('--strict-mcp-config'));
  assert.equal(rows[3].stdin, '＠file');
  assert.deepEqual(rows[3].args, args);
  assert.equal(rows[4].cwd, '/empty');
  assert.deepEqual(rows[4].args, args);
  for (const row of rows.filter(row => row.name !== 'no-at')) assert.equal(row.stdin, '@file');
  for (const row of rows.filter(row => row.name !== 'empty-cwd')) assert.equal(row.cwd, '/project');
  const windows = buildVariants(['--append-system-prompt-file', 'system.md'], 'x', 'p', 'e', x => x);
  assert.deepEqual(windows[1].args, []);
});

const usage = n => ({ input_tokens: 2, cache_creation_input_tokens: n - 12, cache_read_input_tokens: 10 });
test('collector deduplicates partial blocks, separates per-request and aggregate usage', () => {
  const collector = createCollector();
  collector.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a', usage: usage(100) } } });
  collector.accept({ type: 'assistant', message: { id: 'a', usage: usage(100) } });
  collector.accept({ type: 'assistant', message: { id: 'a', usage: usage(100) } });
  collector.accept({ type: 'assistant', message: { id: 'b', usage: usage(140) } });
  collector.accept({ type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'sub', usage: usage(2000) } });
  collector.accept({ type: 'result', subtype: 'success', is_error: false, usage: usage(240), num_turns: 2, total_cost_usd: 0.1 });
  const result = collector.finish();
  assert.equal(result.requests.length, 2);
  assert.equal(result.firstInput, 100);
  assert.equal(result.peakInput, 140);
  assert.equal(result.totalInput, 240);
  assert.equal(result.costUsd, 0.1);
  assert.equal(result.errorText, null);
});

test('errors and missing usage stay visible, including errors with token counts', () => {
  const collector = createCollector();
  collector.accept({ type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['prompt too long: 5000001'], error: { message: 'over limit' }, api_error_status: 400, usage: usage(10) });
  const result = collector.finish();
  assert.equal(result.firstInput, null);
  assert.equal(result.totalInput, 10);
  assert.equal(result.api_error_status, 400);
  assert.equal(result.errorText, 'prompt too long: 5000001 | over limit');
  assert.equal(createCollector().finish().totalInput, null);
  const synthetic = createCollector();
  synthetic.accept({ type: 'assistant', message: { id: 'login-error', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  assert.equal(synthetic.finish().firstInput, null, 'synthetic auth errors are not measured requests');
  assert.equal(cannotContinue({ failure: 'CLI error', hasResult: true, errorText: 'prompt too long: 5000001' }), false);
  assert.equal(cannotContinue({ failure: 'CLI error', hasResult: true, errorText: 'Not logged in · Please run /login' }), true);
  assert.equal(cannotContinue({ failure: 'timeout', hasResult: false }), false);
  assert.equal(cannotContinue({ failure: 'spawn E2BIG', hasResult: false }), false);
});

test('ranking uses request size, names the largest reduction, refuses incomplete evidence', () => {
  const rows = ['full', 'no-system', 'no-mcp', 'no-at', 'empty-cwd'].map((name, i) => ({ name,
    firstInput: [10000, 3000, 9000, 9998, 8000][i], totalInput: i === 1 ? 900000 : 10000, hasResult: true }));
  const ranking = rankVariants(rows);
  assert.deepEqual(ranking.ranked.map(row => row.name), ['full', 'no-at', 'no-mcp', 'empty-cwd', 'no-system']);
  assert.match(ranking.summary, /appended system prompt/);
  assert.equal(rankVariants(rows.slice(1)).largestContributor, null);
  assert.equal(rankVariants(rows.map(row => ({ ...row, firstInput: 10000 }))).largestContributor, null);
  assert.equal(rankVariants(rows.map(row => row.name === 'no-at' ? { ...row, firstInput: null } : row)).complete, false);
});

test('stream runner parses a final unterminated result and captures exit/errors', async () => {
  const events = [{ type: 'assistant', message: { id: 'x', usage: usage(100) } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, usage: usage(100), errors: ['one turn limit'] }];
  const source = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))}));`;
  const result = await runVariant({ name: 'test', args: ['-e', source], stdin: 'prompt', cwd: os.tmpdir() },
    { command: process.execPath, env: process.env, timeoutMs: 5000 });
  assert.equal(result.firstInput, 100);
  assert.equal(result.errorText, 'one turn limit');
  assert.equal(result.failure, null);
});

test('timeout kills the captured process group, including its child', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-size-kill-'));
  let descendant;
  try {
    const pidFile = path.join(dir, 'pid');
    const source = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(()=>{},1000);`;
    const result = await runVariant({ name: 'timeout', args: ['-e', source], stdin: '', cwd: dir },
      { command: process.execPath, env: process.env, timeoutMs: 500 });
    descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(result.failure, 'timeout');
    assert.equal(result.hasResult, false);
    for (let tries = 0; tries < 20; tries++) {
      try { process.kill(descendant, 0); } catch { descendant = null; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(descendant, null, 'descendant survived group cleanup');
    assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
