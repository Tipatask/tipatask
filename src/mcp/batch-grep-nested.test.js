'use strict';

// batch_grep_tags default search paths must cover the src/ of nested git checkouts (gitlinks)
// without assuming any directory name — a project that vendors the Task App as a submodule
// keeps its source outside the conventional roots (src, lib, app, api, packages).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runBatchGrep, nestedSourceDirs } = require('./batch-grep');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const hasGit = spawnSync('git', ['--version']).status === 0;

// outer/ (git) with ai/architecture/tt-nested.md and a gitlink `vendor-app/` whose src/ holds
// the only file matching the tag's pattern. No conventional root (src/, api/, …) exists in
// outer/, so a hit proves the gitlink rule, not the fallback whole-project walk.
function makeFixture() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-grep-nested-'));
  fs.mkdirSync(path.join(outer, 'ai', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(outer, 'ai', 'architecture', 'tt-nested.md'), '# tt-nested\n\nFiles: `nested-thing.js`\n');
  const nested = path.join(outer, 'vendor-app');
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'src', 'nested-thing.js'), "module.exports = 'nested-thing';\n");
  git(nested, 'init', '-q');
  git(nested, 'add', '.');
  git(nested, 'commit', '-q', '-m', 'nested');
  git(outer, 'init', '-q');
  git(outer, 'add', 'vendor-app'); // records a 160000 gitlink for a dir that has its own .git
  return { outer, nested };
}

test('nestedSourceDirs: lists <gitlink>/src for nested checkouts, [] for a non-git dir', { skip: !hasGit }, () => {
  const { outer, nested } = makeFixture();
  try {
    assert.deepEqual(nestedSourceDirs(outer), [path.join(nested, 'src')]);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-grep-plain-'));
    try { assert.deepEqual(nestedSourceDirs(plain), []); } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});

test('runBatchGrep default paths include a nested checkout\'s src/', { skip: !hasGit }, () => {
  const { outer } = makeFixture();
  try {
    const res = runBatchGrep({ tagNames: ['tt-nested'], projectRoot: outer, maxHitsPerTag: 10 });
    const files = (res.results['tt-nested'] || []).map(h => h.file);
    assert.ok(files.includes(path.join('vendor-app', 'src', 'nested-thing.js')), `expected nested hit, got ${JSON.stringify(files)}`);
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});

test('runBatchGrep explicit paths are honoured verbatim (no nested augmentation)', { skip: !hasGit }, () => {
  const { outer } = makeFixture();
  try {
    fs.mkdirSync(path.join(outer, 'other'));
    const res = runBatchGrep({ tagNames: ['tt-nested'], projectRoot: outer, paths: ['other'] });
    assert.deepEqual(res.results['tt-nested'] || [], []);
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});
