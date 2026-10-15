'use strict';

// TPT9015 — run the export audit's credential check (export-task-app.sh SECRET_RE, mirrored by
// scripts/release-notes.js findSecret) over every git-tracked file, so a credential-shaped literal
// in a test, probe or fixture fails npm test/CI instead of blocking the next public export.
// Scans all tracked files, a superset of what the export ships: the root repo's exclusion list
// does not ship with the Task App, so it is not read here. Text files only (no NUL byte in the
// first 8 KB, as grep -I decides), up to MAX_BYTES each. Every credential shape in this file is
// built at runtime, never written as one literal, or the guard would flag itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fx = require('./git-merge/test-fixture');
const rn = require('../../scripts/release-notes');

const MAX_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function scanTrackedFiles(repoRoot, { maxBytes = MAX_BYTES, env = process.env } = {}) {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hits = [];
  for (const rel of listed.split('\0').filter(Boolean)) {
    let st;
    try { st = fs.lstatSync(path.join(repoRoot, rel)); } catch { continue; }
    if (!st.isFile() || st.size > maxBytes) continue;
    const buf = fs.readFileSync(path.join(repoRoot, rel));
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const line = rn.findSecret(buf.toString('utf8'));
    if (line) hits.push(`${rel}:${line}`);
  }
  return hits.sort();
}

// The Task App checkout root, or null when it is not the top of its own git checkout (a
// tarball build, or one extracted inside some other repository) or git is unavailable.
function repoRootOrNull(root = path.resolve(__dirname, '../..')) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return fs.realpathSync(top) === fs.realpathSync(root) ? root : null;
  } catch {
    return null;
  }
}

function failureMessage(hits) {
  return [
    `${hits.length} tracked file(s) match the export audit's credential regex (export-task-app.sh SECRET_RE);`,
    'the public export refuses this commit until each is fixed:',
    ...hits.map(h => `  ${h}`),
    "Build credential-shaped test data at runtime instead of one literal: 'AKIA' + 'B'.repeat(16),",
    'or a private-key header split across two string literals.',
  ].join('\n');
}

test('no tracked file matches the export audit credential regex', t => {
  const root = repoRootOrNull();
  if (!root) { t.skip('not a git checkout (tarball build) or git unavailable'); return; }
  const hits = scanTrackedFiles(root);
  assert.deepEqual(hits, [], failureMessage(hits));
});

test('scan reports a committed credential shape by path:line and skips binary, oversize and untracked files', t => {
  if (fx.skipUnless(t)) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'export-audit-secrets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const git = fx.makeGit(home);
  const repo = path.join(home, 'repo');
  const aws = 'AKIA' + 'B'.repeat(16);
  const keyHeader = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  fx.initRepo(git, repo, {
    files: {
      'clean.txt': 'nothing to see\n',
      'fixtures/leak.txt': `one\ntwo\nkey ${aws}\n`,
      'fixtures/key.pem.txt': `${keyHeader}\n`,
      'fixtures/blob.bin': Buffer.concat([Buffer.from([0]), Buffer.from(` ${aws}\n`)]),
      'fixtures/big.txt': `${'x'.repeat(200)}\n${aws}\n`,
    },
  });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), `${aws}\n`);

  assert.deepEqual(scanTrackedFiles(repo, { maxBytes: 100, env: fx.fixtureEnv(home) }), [
    'fixtures/key.pem.txt:1',
    'fixtures/leak.txt:3',
  ]);
  assert.match(failureMessage(['fixtures/leak.txt:3']), /^ {2}fixtures\/leak\.txt:3$/m);
});
