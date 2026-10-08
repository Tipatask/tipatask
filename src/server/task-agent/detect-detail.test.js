'use strict';

// (TPT567) Every unavailable detect() result carries `detail: { bin, exit, output }` so the
// Edit Agents card can show the launcher path and the probe's exit/output — the only evidence
// a packaged app ever surfaces when Windows detection fails. buildDetectDetail() is tested
// directly; the real ClaudeAgent/CodexAgent.detect() paths run against a stub launcher via the
// documented ${NAME}_BIN override (POSIX shell stubs — skipped on win32).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const BaseTaskAgent = require('./base-agent');
const { clearBinCache } = require('../spawn-utils');

test('buildDetectDetail: no launcher -> null bin, null exit, empty output', () => {
  assert.deepEqual(BaseTaskAgent.buildDetectDetail(null, undefined), { bin: null, exit: null, output: '' });
  assert.deepEqual(BaseTaskAgent.buildDetectDetail('', null), { bin: null, exit: null, output: '' });
});

test('buildDetectDetail: probe output is trimmed and capped at 200 chars; exit kept when integer', () => {
  const long = 'x'.repeat(500);
  const d = BaseTaskAgent.buildDetectDetail('/usr/local/bin/claude', { error: null, status: 1, output: `  ${long}\n` });
  assert.equal(d.bin, '/usr/local/bin/claude');
  assert.equal(d.exit, 1);
  assert.equal(d.output.length, 200);
  assert.equal(d.output, 'x'.repeat(200));
});

test('buildDetectDetail: a spawn error with no output reports the error code (or message); killed probe has null exit', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(BaseTaskAgent.buildDetectDetail('C:\\x\\claude.cmd', { error: enoent, status: null, output: '' }),
    { bin: 'C:\\x\\claude.cmd', exit: null, output: 'ENOENT' });
  assert.deepEqual(BaseTaskAgent.buildDetectDetail('/b', { error: new Error('scan timed out'), status: null, output: '' }),
    { bin: '/b', exit: null, output: 'scan timed out' });
  // Output wins over the error code when both exist (the output is the more useful evidence).
  assert.equal(BaseTaskAgent.buildDetectDetail('/b', { error: enoent, status: null, output: 'partial' }).output, 'partial');
});

if (process.platform === 'win32') {
  test.skip('real detect() against a stub launcher (POSIX shell stubs)', () => {});
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-detect-detail-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function stub(name, body) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  test('ClaudeAgent.detect(): logged-out stub -> detail carries the launcher, exit status and the raw output', async () => {
    const ClaudeAgent = require('./claude-agent');
    const bin = stub('claude', 'echo \'{"loggedIn":false,"authMethod":"none"}\'; echo "keychain locked" >&2; exit 1');
    process.env.CLAUDE_BIN = bin;
    clearBinCache('claude');
    try {
      const res = await new ClaudeAgent().detect({});
      assert.equal(res.available, false);
      assert.match(res.reason, /not logged in/i);
      assert.equal(res.detail.bin, bin);
      assert.equal(res.detail.exit, 1);
      assert.match(res.detail.output, /"loggedIn":false/);
      assert.match(res.detail.output, /keychain locked/, 'stderr is part of the combined output');
      assert.ok(res.detail.output.length <= 200);
    } finally {
      delete process.env.CLAUDE_BIN;
      clearBinCache('claude');
    }
  });

  test('CodexAgent.detect(): logged-out stub -> detail carries the launcher, exit status and the raw output', async () => {
    const CodexAgent = require('./codex-agent');
    const bin = stub('codex', 'echo "Not logged in"; exit 1');
    process.env.CODEX_BIN = bin;
    clearBinCache('codex');
    try {
      const res = await new CodexAgent().detect({});
      assert.equal(res.available, false);
      assert.match(res.reason, /not logged in/i);
      assert.deepEqual(res.detail, { bin, exit: 1, output: 'Not logged in' });
    } finally {
      delete process.env.CODEX_BIN;
      clearBinCache('codex');
    }
  });

  test('a logged-in stub yields a positive with no detail at all', async () => {
    const CodexAgent = require('./codex-agent');
    const bin = stub('codex-ok', 'echo "Logged in using ChatGPT"; exit 0');
    process.env.CODEX_BIN = bin;
    clearBinCache('codex');
    try {
      const res = await new CodexAgent().detect({});
      assert.equal(res.available, true);
      assert.equal('detail' in res, false);
    } finally {
      delete process.env.CODEX_BIN;
      clearBinCache('codex');
    }
  });
}
