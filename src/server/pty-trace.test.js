'use strict';

// (TPT9048) The env-gated PTY I/O trace: off by default, one JSONL file per spawn when on,
// never throwing into the terminal pipeline.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openPtyTrace, traceDir } = require('./pty-trace');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pty-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function settle() { return new Promise((resolve) => setTimeout(resolve, 50)); }

test('pty-trace: disabled unless TIPATASK_PTY_TRACE is set to a truthy value or a directory', () => {
  assert.equal(traceDir({}, '/data'), null);
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: '' }, '/data'), null);
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: '0' }, '/data'), null);
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: 'off' }, '/data'), null);
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: '1' }, '/data'), path.join('/data', 'pty-trace'));
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: 'true' }, null), null, 'no user-data root to derive the default dir from');
  assert.equal(traceDir({ TIPATASK_PTY_TRACE: '/tmp/x' }, '/data'), path.resolve('/tmp/x'));
  assert.equal(openPtyTrace({ agentId: 'codex', taskId: 'C1', env: {} }), null);
});

test('pty-trace: records meta, every input write and every output chunk, then closes on exit', async (t) => {
  const dir = scratch(t);
  const spec = { command: 'codex', args: ['--no-alt-screen'], initialPrompt: 'Work on task C1. Read the file.', kickoffTypedLine: ' Begin.', kickoffFile: 'C:/x/abc.md' };
  const trace = openPtyTrace({ agentId: 'codex', taskId: 'C1', spawnedAt: 1000, spec, cols: 120, rows: 40, env: { TIPATASK_PTY_TRACE: dir } });
  assert.ok(trace && trace.file.startsWith(dir));
  assert.match(path.basename(trace.file), /^C1-codex-1000\.jsonl$/);
  trace.write('in', '\x1b[200~hello\x1b[201~');
  trace.write('out', '› hello\n');
  trace.write('log', 'awaitPasteAck: Enter written');
  trace.close();
  await settle();
  const records = readRecords(trace.file);
  assert.equal(records[0].k, 'meta');
  assert.equal(records[0].command, 'codex');
  assert.deepEqual(records[0].args, ['--no-alt-screen']);
  assert.equal(records[0].initialPromptLength, spec.initialPrompt.length, 'the prompt length is recorded, never its text');
  assert.equal(records[0].s, '');
  assert.equal(records[0].kickoffFile, 'C:/x/abc.md');
  assert.equal(records[0].kickoffTypedLine, ' Begin.');
  assert.deepEqual(records.slice(1).map((r) => [r.k, r.s]), [
    ['in', '\x1b[200~hello\x1b[201~'],
    ['out', '› hello\n'],
    ['log', 'awaitPasteAck: Enter written'],
  ]);
  assert.ok(records.every((r) => Number.isInteger(r.t) && r.t >= 0), 'timestamps are ms since spawn');
  trace.write('in', 'after close');
  await settle();
  assert.equal(readRecords(trace.file).length, 4, 'writes after close are dropped, not thrown');
});

test('pty-trace: an unwritable directory disables the trace instead of throwing', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'occupied');
  fs.writeFileSync(file, 'not a directory');
  assert.equal(openPtyTrace({ agentId: 'codex', taskId: 'C1', env: { TIPATASK_PTY_TRACE: path.join(file, 'sub') } }), null);
});

test('pty-trace: task and agent ids are sanitised in the file name', async (t) => {
  const dir = scratch(t);
  const trace = openPtyTrace({ agentId: 'codex', taskId: '../C 1/x', spawnedAt: 5, env: { TIPATASK_PTY_TRACE: dir } });
  assert.ok(trace);
  assert.equal(path.dirname(trace.file), dir);
  assert.match(path.basename(trace.file), /^[A-Za-z0-9._-]+-codex-5\.jsonl$/);
  trace.close();
  await settle();
});
