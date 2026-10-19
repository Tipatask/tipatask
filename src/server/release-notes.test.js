'use strict';

// TPT701 — scripts/release-notes.js: release-base resolution (real git fixtures), bounded
// evidence, prompt/output validation, the notes-file marker and the rerun rules, and the
// generate flow with injected provider/comment deps, and (TPT9040) the private website Changelog
// drafts. No model calls, no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./git-merge/test-fixture');
const rn = require('../../scripts/release-notes');

fx.applyFixtureEnvToProcess();

function scratch(t, prefix = 'release-notes-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// ---------------------------------------------------------------- pure helpers

test('semver parse/compare', () => {
  assert.deepEqual(rn.parseSemver('v0.9.10'), [0, 9, 10]);
  assert.equal(rn.parseSemver('0.9'), null);
  assert.equal(rn.compareSemver('v0.9.10', '0.9.9'), 1);
  assert.equal(rn.compareSemver('0.9.9', '0.9.9'), 0);
  assert.equal(rn.compareSemver('0.8.50', '0.9.0'), -1);
  assert.throws(() => rn.compareSemver('x', '0.9.0'));
});

test('trailerFromText finds a Private-Commit trailer in tag annotations and commit bodies only', () => {
  assert.equal(rn.trailerFromText(`TipΔTask v0.9.13\n\nPrivate-Commit: ${SHA}\n`), SHA);
  assert.equal(rn.trailerFromText(`Sync\n\nTPT1: x\n\nPrivate-Commit: ${SHA}`), SHA);
  assert.equal(rn.trailerFromText('TipΔTask v0.9.13\n'), null);
  assert.equal(rn.trailerFromText(`Private-Commit: ${SHA.slice(0, 39)}`), null);
  assert.equal(rn.trailerFromText(null), null);
});

test('readExportState parses private/dest_head/exported_v* lines and ignores garbage', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'state');
  fs.writeFileSync(file, `private=${SHA}\nfingerprint=abc\ndest_head=${SHA2}\nexported_v0.9.14=${SHA2}\nexported_v0.9.15=short\njunk\n`);
  const s = rn.readExportState(file);
  assert.equal(s.private, SHA);
  assert.equal(s.destHead, SHA2);
  assert.equal(s.fingerprint, 'abc');
  assert.deepEqual(s.exported, { 'v0.9.14': SHA2 });
  assert.deepEqual(rn.readExportState(path.join(dir, 'missing')).exported, {});
});

test('parseTaskKey reads the leading key of a subject in both spellings', () => {
  assert.deepEqual(rn.parseTaskKey('TPT701: generate notes'), { prefix: 'TPT', key: 'TPT701' });
  assert.deepEqual(rn.parseTaskKey('C1292 Add thing'), { prefix: 'C', key: 'C1292' });
  assert.deepEqual(rn.parseTaskKey('TPT-45 dash'), { prefix: 'TPT', key: 'TPT45' });
  assert.equal(rn.parseTaskKey('current state'), null);
  assert.equal(rn.parseTaskKey('Merge pull request #12'), null);
});

test('scrubEvidence replaces home paths, emails, seen task keys and hex ids; SHA256SUMS survives', () => {
  const text = 'see /Users/anton/x and /home/bob/y and C:\\Users\\eve\\z by anton@example.com; TPT701 fixed C12 (sha 0d2a150e) SHA256SUMS 1234567 H9';
  const out = rn.scrubEvidence(text, ['TPT', 'C']);
  assert.equal(out, 'see <path>/x and <path>/y and <path>\\z by <email>; [task] fixed [task] (sha <id>) SHA256SUMS 1234567 H9');
});

test('findSecret flags the export audit shapes and returns the line', () => {
  assert.equal(rn.findSecret('clean\nline'), 0);
  // Credential shapes are built at runtime: the export audit greps this file as well.
  assert.equal(rn.findSecret(`ok\ntoken ghp_${'A'.repeat(24)} here`), 2);
  assert.equal(rn.findSecret('AKIA' + 'B'.repeat(16)), 1);
  assert.equal(rn.findSecret('-----BEGIN RSA ' + 'PRIVATE KEY-----'), 1);
  assert.equal(rn.findSecret('tipatask-sk-notasecret'), 0);
});

test('validateNotes rejects each private-material class and accepts a clean body', () => {
  const clean = '## Highlights\n\n- The task board loads faster.\n\n## Fixes\n\n- Notifications no longer stick.\n';
  assert.deepEqual(rn.validateNotes('```markdown\n' + clean + '```', { keyPrefixes: ['TPT'] }), { ok: true, body: clean.trim(), violations: [] });
  const bad = (text) => rn.validateNotes(text, { keyPrefixes: ['TPT', 'C'] }).violations;
  assert.match(bad('## Fixes\n- TPT701 done')[0], /task identifier/);
  assert.match(bad('## Fixes\n- see commit 0d2a150e')[0], /commit identifier/);
  assert.match(bad('## Fixes\n- in /Users/anton/x')[0], /private path/);
  assert.match(bad('## Fixes\n- ai/todo/server moved')[0], /internal path/);
  assert.match(bad('## Fixes\n- mail someone@example.com')[0], /email/);
  assert.match(bad('## Fixes\n- Private-Commit: x')[0], /private marker/);
  assert.match(bad(`## Fixes\n- ghp_${'A'.repeat(24)}`)[0], /credential/);
  assert.match(bad('# Title\n## Fixes\n- x')[0], /H1/);
  assert.match(bad('## Internals\n- x')[0], /unexpected section/);
  assert.match(bad('')[0], /empty/);
  assert.match(bad('## Fixes\n' + 'x'.repeat(13000))[0], /too long/);
});

test('notes file marker round-trips; an edited body is detected', () => {
  const file = rn.renderNotesFile('## Fixes\n\n- Thing.', 'e'.repeat(64));
  assert.ok(file.includes(rn.FOOTER));
  const parsed = rn.parseNotesFile(file);
  assert.equal(parsed.unedited, true);
  assert.equal(parsed.marker.evidence, 'e'.repeat(64));
  assert.ok(parsed.body.startsWith('## Fixes'));
  const edited = rn.parseNotesFile(file.replace('Thing.', 'Thing, now better.'));
  assert.equal(edited.unedited, false);
  assert.ok(edited.marker);
  assert.equal(rn.parseNotesFile('## Fixes\n- hand written\n').marker, null);
});

test('decideRerun matrix', () => {
  const ev = 'e'.repeat(64);
  const file = rn.renderNotesFile('## Fixes\n\n- Thing.', ev);
  assert.equal(rn.decideRerun({ existingText: null, evidenceHash: ev }), 'generate');
  assert.equal(rn.decideRerun({ existingText: file, evidenceHash: ev }), 'up-to-date');
  assert.equal(rn.decideRerun({ existingText: file, evidenceHash: 'f'.repeat(64) }), 'regenerate');
  const edited = file.replace('Thing.', 'Thing!');
  assert.equal(rn.decideRerun({ existingText: edited, evidenceHash: ev }), 'kept-edited');
  assert.equal(rn.decideRerun({ existingText: edited, evidenceHash: 'f'.repeat(64) }), 'kept-edited-stale');
  assert.equal(rn.decideRerun({ existingText: 'hand written', evidenceHash: ev }), 'kept-edited');
  assert.equal(rn.decideRerun({ existingText: edited, evidenceHash: ev, regenerate: true }), 'regenerate');
  assert.equal(rn.decideRerun({ existingText: file, evidenceHash: ev, frozen: true }), 'frozen');
});

test('findStaleDrafts: unedited intermediate drafts are stale, edited ones become the prior draft', (t) => {
  const dir = scratch(t);
  const ev = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, 'v0.9.13.md'), rn.renderNotesFile('## Fixes\n\n- old', ev));   // tagged: untouched
  fs.writeFileSync(path.join(dir, 'v0.9.14.md'), rn.renderNotesFile('## Fixes\n\n- mid', ev));   // untagged, unedited: stale
  fs.writeFileSync(path.join(dir, 'v0.9.15.md'), rn.renderNotesFile('## Fixes\n\n- mid2', ev).replace('mid2', 'mid2 edited')); // untagged, edited: prior draft
  fs.writeFileSync(path.join(dir, 'v0.9.16.md'), rn.renderNotesFile('## Fixes\n\n- current', ev)); // this version
  fs.writeFileSync(path.join(dir, 'v0.9.9.md'), 'hand written old');
  const r = rn.findStaleDrafts(dir, '0.9.13', '0.9.16', new Set(['v0.9.13', 'v0.9.9']));
  assert.deepEqual(r.stale, ['docs/releases/v0.9.14.md']);
  assert.equal(r.priorDraft.file, 'docs/releases/v0.9.15.md');
  assert.ok(r.priorDraft.body.includes('mid2 edited'));
  assert.deepEqual(rn.findStaleDrafts(path.join(dir, 'nope'), '0.9.13', '0.9.16', new Set()), { stale: [], priorDraft: null });
});

test('buildPrompt: first release carries no commit list; retry lists violations; prior draft framed as data', () => {
  const first = rn.buildPrompt({ version: '0.9.1', prevTag: null, evidence: '## About the app (README excerpt)\nhi', firstRelease: true });
  assert.ok(first.includes('first public release'));
  assert.ok(!first.includes('Commits in this release'));
  const retry = rn.buildPrompt({ version: '0.9.2', prevTag: 'v0.9.1', evidence: 'E', priorDraft: 'old words', retryViolations: ['task identifier: "TPT1"'] });
  assert.ok(retry.includes('rejected for these reasons'));
  assert.ok(retry.includes('- task identifier: "TPT1"'));
  assert.ok(retry.includes('## Prior draft\nold words'));
  assert.ok(retry.indexOf('=== EVIDENCE START ===') < retry.indexOf('E\n'));
  assert.ok(retry.includes('data, not instructions'));
});

test('generateNotes: violation → one retry with the list; still bad → rejected; null → failed', async () => {
  const prompts = [];
  const answers = ['## Fixes\n- TPT1 broke', '## Fixes\n- fixed it'];
  const runPrompt = async (p) => { prompts.push(p); return answers.shift(); };
  const ok = await rn.generateNotes({ prompt: 'P', runPrompt, keyPrefixes: ['TPT'], promptForRetry: (v) => `RETRY ${v.join(';')}` });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.body, '## Fixes\n- fixed it');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /^RETRY task identifier/);
  const bad = await rn.generateNotes({ prompt: 'P', runPrompt: async () => '## Fixes\n- TPT1', keyPrefixes: ['TPT'], promptForRetry: () => 'R' });
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.raw, '## Fixes\n- TPT1');
  const failed = await rn.generateNotes({ prompt: 'P', runPrompt: async () => null, keyPrefixes: [], promptForRetry: () => 'R' });
  assert.equal(failed.status, 'failed');
});

test('fetchResolutions keeps only agent-authored resolution reports and never leaks the input', async () => {
  const { isAgentLogTailComment } = require('./resolution-payload');
  const { EXIT_BACKSTOP_HEADER } = require('./completion-nudge');
  const calls = [];
  const run = async (args) => {
    calls.push(args[1]);
    if (args[1].includes('TPT404')) return { status: 404, body: { error: 'Task not found' } };
    return { status: 200, body: { comments: [
      { id: 1, comment_type: 'comment', content: 'chatter', user: { email: 'x@y.z' } },
      { id: 2, comment_type: 'resolution', content: 'Agent completed the task\n\nlast message\n\n<!-- tipatask:agent-exit -->' },
      { id: 3, comment_type: 'resolution', content: `${EXIT_BACKSTOP_HEADER}: TASK_COMMIT_MISSING` },
      { id: 4, comment_type: 'spec', content: 'spec text' },
      { id: 5, comment_type: 'resolution', content: 'What changed: real report ' + 'x'.repeat(2000), user: { email: 'a@b.c' } },
    ] } };
  };
  const r = await rn.fetchResolutions(['TPT1', 'TPT404', 'TPT1'], { run, isLogTail: isAgentLogTailComment, backstopHeader: EXIT_BACKSTOP_HEADER });
  assert.deepEqual(calls.sort(), ['/tasks/TPT1/comments', '/tasks/TPT404/comments']);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].key, 'TPT1');
  assert.ok(r.items[0].text.startsWith('What changed: real report'));
  assert.ok(r.items[0].text.length <= rn.LIMITS.resolutionChars);
  assert.ok(!JSON.stringify(r).includes('@'));
  const creds = await rn.fetchResolutions(['TPT1'], { run: async () => { const e = new Error('No signed-in account token at /Users/x'); e.missingCredentials = true; throw e; }, isLogTail: isAgentLogTailComment, backstopHeader: EXIT_BACKSTOP_HEADER });
  assert.equal(creds.items.length, 0);
  assert.match(creds.skipped, /no signed-in account/);
  assert.ok(!creds.skipped.includes('/Users/'));
  const denied = await rn.fetchResolutions(['TPT1'], { run: async () => ({ status: 401, body: {} }), isLogTail: isAgentLogTailComment, backstopHeader: EXIT_BACKSTOP_HEADER });
  assert.match(denied.skipped, /HTTP 401/);
});

test('buildEvidence: resolutions never change the hash; the prompt budget shrinks resolutions first', () => {
  const commits = [{ sha: SHA, subject: 'TPT1: thing', body: 'body', files: ['src/a.js'], key: 'TPT1', versionStampOnly: false }];
  const diff = { numstat: ['1\t0\tsrc/a.js'], hunks: ['diff --git a/README.md'], overlay: [] };
  const a = rn.buildEvidence({ commits, dropped: 0, keyPrefixes: ['TPT'], diff, resolutions: null });
  const b = rn.buildEvidence({ commits, dropped: 0, keyPrefixes: ['TPT'], diff, resolutions: { items: [{ key: 'TPT1', text: 'did it' }] } });
  assert.equal(a.hash, b.hash);
  assert.ok(b.text.includes('## Task resolution reports'));
  assert.ok(!b.text.includes('TPT1'));
  assert.ok(b.text.includes('[task]'));
  const limits = { ...rn.LIMITS, promptBytes: 3000 };
  const big = rn.buildEvidence({ commits, dropped: 0, keyPrefixes: ['TPT'], diff, resolutions: { items: [{ key: 'TPT1', text: 'r'.repeat(5000) }] }, limits });
  assert.ok(big.bytes <= 3000 + 2500, `bytes ${big.bytes}`);
  assert.ok(big.text.includes('## Task resolution reports'));
  assert.ok(big.text.includes('…[truncated]'));
  assert.equal(big.hash, a.hash);
});

test('keyPattern falls back to the known prefixes; readPathList accepts NUL or newline lists; parseArgs', (t) => {
  assert.equal(rn.keyPattern([]).source, '\\b(?:TPT|C|H)-?\\d{1,6}\\b');
  assert.equal(rn.keyPattern(['TPT']).source, '\\b(?:TPT)-?\\d{1,6}\\b');
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'p'), 'a.js\0b.js\0');
  assert.deepEqual(rn.readPathList(path.join(dir, 'p')), ['a.js', 'b.js']);
  assert.deepEqual(rn.readPathList(null), []);
  assert.deepEqual(rn.parseArgs(['generate', '--src', '/s', '--dry-run', '--regenerate']), { _: ['generate'], src: '/s', 'dry-run': true, regenerate: true });
  assert.throws(() => rn.parseArgs(['--src']), /needs a value/);
});

test('userDataProbe honors TIPATASK_USER_DATA, else the platform user-data dir only when a store exists', (t) => {
  const home = scratch(t);
  assert.equal(rn.userDataProbe({ TIPATASK_USER_DATA: '/x' }, 'darwin', home), '/x');
  assert.equal(rn.userDataProbe({}, 'darwin', home), null);
  const dir = path.join(home, 'Library', 'Application Support', 'TipATask');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask-account.json'), '{}');
  assert.equal(rn.userDataProbe({}, 'darwin', home), dir);
  assert.equal(rn.userDataProbe({}, 'linux', home), null);
});

// ---------------------------------------------------------------- git fixtures

function buildSrc(t) {
  const home = scratch(t, 'rn-home-');
  const git = fx.makeGit(home);
  const src = path.join(home, 'src');
  fx.initRepo(git, src, { files: { 'package.json': '{"name":"x","version":"0.9.1","description":"A task app"}\n', 'src/a.js': '1\n', 'SETUP_PLAN.md': 'private\n' } });
  const c1 = fx.commit(git, src, { 'src/a.js': '2\n' }, 'TPT1: faster board\n\nThe board renders faster.');
  const c2 = fx.commit(git, src, { 'package.json': '{"name":"x","version":"0.9.2","description":"A task app"}\n' }, 'current state');
  const c3 = fx.commit(git, src, { 'SETUP_PLAN.md': 'private 2\n' }, 'TPT2: private planning only');
  const c4 = fx.commit(git, src, { 'src/b.js': '3\n', 'SETUP_PLAN.md': 'private 3\n', 'README.md': '# x\n\nnew readme line\n' }, 'TPT3 Fix notifications');
  return { home, git, src, c0: git(src, ['rev-parse', `${c1}^`]), c1, c2, c3, c4 };
}

function buildDest(git, home, { tag, tagMessage, commitMessage, name = 'dest' } = {}) {
  const dest = path.join(home, name);
  fx.initRepo(git, dest, { files: { 'package.json': '{"version":"0.9.2"}\n' } });
  const head = fx.commit(git, dest, { 'src/a.js': 'public\n' }, commitMessage || 'Release v0.9.2');
  if (tag) git(dest, ['tag', '-a', tag, '-m', tagMessage || `TipΔTask ${tag}`]);
  return { dest, head };
}

const exported = ['src/a.js', 'src/b.js', 'README.md', 'package.json'];
const realGit = () => {
  const { execFileSync } = require('node:child_process');
  return (cwd, args, { ok = false, input } = {}) => {
    try { return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input }).replace(/\n$/, ''); }
    catch (err) { if (ok) return null; throw err; }
  };
};

test('resolveReleaseBase: --notes-since wins and is validated', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const git = realGit();
  const ok = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: '/nope', destIsCheckout: false, version: '0.9.3', notesSince: f.c1, git });
  assert.equal(ok.status, 'resolved');
  assert.equal(ok.base, f.c1);
  assert.equal(ok.baseSource, '--notes-since');
  assert.equal(ok.prevVersion, '0.9.1');
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: f.c1, dest: '/nope', destIsCheckout: false, version: '0.9.3', notesSince: f.c4, git }).status, 'error');
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: '/nope', destIsCheckout: false, version: '0.9.3', notesSince: 'deadbeef', git }).status, 'error');
});

test('resolveReleaseBase: first release, frozen, no tag, version order', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const git = realGit();
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: '/nope', destIsCheckout: false, version: '0.9.3', git }).status, 'first-release');
  const d = buildDest(f.git, f.home, { tag: 'v0.9.3' });
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: d.dest, destIsCheckout: true, version: '0.9.3', git }).status, 'frozen');
  const noTag = buildDest(f.git, f.home, { name: 'dest2' });
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: noTag.dest, destIsCheckout: true, version: '0.9.3', git }).status, 'skipped-no-release-tag');
  const newer = buildDest(f.git, f.home, { name: 'dest3', tag: 'v0.9.5' });
  assert.equal(rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: newer.dest, destIsCheckout: true, version: '0.9.3', git }).status, 'skipped-version-order');
});

test('resolveReleaseBase: tag annotation trailer beats the commit trailer; commit trailer alone works', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const git = realGit();
  const a = buildDest(f.git, f.home, { tag: 'v0.9.2', tagMessage: `TipΔTask v0.9.2\n\nPrivate-Commit: ${f.c2}`, commitMessage: `Sync\n\nPrivate-Commit: ${f.c1}` });
  const ra = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: a.dest, destIsCheckout: true, version: '0.9.3', git });
  assert.equal(ra.status, 'resolved');
  assert.equal(ra.base, f.c2);
  assert.match(ra.baseSource, /tag annotation/);
  assert.equal(ra.prevTag, 'v0.9.2');
  const b = buildDest(f.git, f.home, { name: 'dest2', tag: 'v0.9.2', commitMessage: `Sync\n\nPrivate-Commit: ${f.c1}` });
  const rb = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: b.dest, destIsCheckout: true, version: '0.9.3', git });
  assert.equal(rb.base, f.c1);
  assert.match(rb.baseSource, /commit trailer/);
});

test('resolveReleaseBase: export-state sources, non-ancestor candidates skipped, unresolved hint', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const git = realGit();
  const d = buildDest(f.git, f.home, { tag: 'v0.9.2' });
  const state = path.join(f.home, 'state');
  fs.writeFileSync(state, `exported_v0.9.2=${f.c2}\n`);
  const r1 = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: d.dest, destIsCheckout: true, version: '0.9.3', stateFile: state, git });
  assert.equal(r1.base, f.c2);
  assert.match(r1.baseSource, /exported_v0\.9\.2/);
  // private= applies only when the tag sits on the commit made from the last sync (dest_head == HEAD^).
  const parent = git(d.dest, ['rev-parse', 'HEAD^']);
  fs.writeFileSync(state, `private=${f.c1}\ndest_head=${parent}\n`);
  const r2 = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: d.dest, destIsCheckout: true, version: '0.9.3', stateFile: state, git });
  assert.equal(r2.base, f.c1);
  assert.match(r2.baseSource, /last sync committed as v0\.9\.2/);
  fs.writeFileSync(state, `private=${f.c1}\ndest_head=${d.head}\n`);
  const r3 = rn.resolveReleaseBase({ src: f.src, ref: 'HEAD', dest: d.dest, destIsCheckout: true, version: '0.9.3', stateFile: state, git });
  assert.equal(r3.status, 'skipped-unresolved-base');
  assert.equal(r3.hint.sha, f.c1, 'parent of the commit that stamped 0.9.2');
  assert.match(r3.message, new RegExp(`--notes-since ${f.c1}`));
  // A candidate that is not an ancestor of the exported ref is skipped (ref = c1, candidate = c4).
  fs.writeFileSync(state, `exported_v0.9.2=${f.c4}\n`);
  const r4 = rn.resolveReleaseBase({ src: f.src, ref: f.c1, dest: d.dest, destIsCheckout: true, version: '0.9.3', stateFile: state, git });
  assert.equal(r4.status, 'skipped-unresolved-base');
});

test('collectCommits keeps only commits that touch exported paths and flags version stamps', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const r = rn.collectCommits(realGit(), f.src, f.c0, 'HEAD', exported);
  assert.deepEqual(r.commits.map(c => c.subject), ['TPT3 Fix notifications', 'current state', 'TPT1: faster board']);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.commits[0].files, ['README.md', 'src/b.js']);
  assert.equal(r.commits[1].versionStampOnly, true);
  assert.equal(r.commits[2].body, 'The board renders faster.');
  assert.deepEqual(r.keyPrefixes, ['TPT']);
  const rendered = rn.renderCommits(r.commits, { ...rn.LIMITS, commitsMax: 2 });
  assert.ok(rendered.includes('(1 more commits omitted)'));
  assert.ok(rendered.includes('(version stamp only)'));
});

test('collectDiffEvidence: numstat for exported paths, hunks for allow-listed files, overlay for worktree edits', (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  fs.writeFileSync(path.join(f.src, 'src/a.js'), 'dirty\n');
  const d = rn.collectDiffEvidence(realGit(), f.src, f.c0, 'HEAD', exported, ['src/a.js']);
  assert.ok(d.numstat.some(l => l.endsWith('\tsrc/b.js')));
  assert.ok(!d.numstat.some(l => l.includes('SETUP_PLAN')));
  assert.equal(d.hunks.length, 2, 'README.md and package.json');
  assert.ok(d.hunks.some(h => h.includes('new readme line')));
  assert.equal(d.overlay.length, 1);
  assert.ok(d.overlay[0].includes('dirty'));
});

test('main generate: dry-run writes nothing; generate writes the stage file; reruns keep edits', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const stage = path.join(f.home, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'README.md'), '# x\n');
  fs.writeFileSync(path.join(stage, 'package.json'), '{"version":"0.9.3","description":"A task app"}');
  const d = buildDest(f.git, f.home, { tag: 'v0.9.2' });
  const paths = path.join(f.home, 'paths');
  fs.writeFileSync(paths, exported.join('\n') + '\n');
  const outLines = [];
  const stdout = (s) => outLines.push(s.trim());
  const stderr = () => {};
  const kv = () => Object.fromEntries(outLines.map(l => l.split(/=(.*)/s).slice(0, 2)));
  const common = ['generate', '--src', f.src, '--ref', 'HEAD', '--dest', d.dest, '--stage', stage, '--version', '0.9.3', '--project-root', f.home,
    '--base-status', 'resolved', '--base', f.c0, '--base-source', 'test', '--prev-tag', 'v0.9.2', '--paths', paths];
  const prompts = [];
  const deps = {
    stdout, stderr,
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: 'test-model' }), runOneShotPrompt: async () => null, stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude', 'codex', 'gemini', 'pi'] },
    fetchComments: async () => ({ status: 200, body: { comments: [{ id: 1, comment_type: 'resolution', content: 'What changed: the board got faster.' }] } }),
    runPrompt: async (p) => { prompts.push(p); return '## Highlights\n\n- The board renders faster.\n\n## Fixes\n\n- Notifications work again.'; },
  };
  // dry run
  assert.equal(await rn.main([...common, '--dry-run'], deps), 0);
  let r = kv();
  assert.equal(r.status, 'dry-run');
  assert.equal(r.would, 'generate');
  assert.equal(r.commits, '3');
  assert.equal(r.tasks, '2');
  assert.ok(!fs.existsSync(path.join(stage, 'docs')));
  assert.equal(prompts.length, 0);
  // real generate
  outLines.length = 0;
  assert.equal(await rn.main(common, deps), 0);
  r = kv();
  assert.equal(r.status, 'generated', JSON.stringify(r));
  assert.equal(r.file, 'docs/releases/v0.9.3.md');
  assert.equal(r.provider, 'claude/test-model');
  assert.equal(r.resolutions, '2', 'TPT1 and TPT3 both have a report');
  const written = fs.readFileSync(path.join(stage, 'docs/releases/v0.9.3.md'), 'utf8');
  assert.ok(written.startsWith('## Highlights'));
  assert.ok(written.includes(rn.FOOTER));
  assert.ok(/<!-- tipatask-release-notes generated=[0-9a-f]{64} evidence=[0-9a-f]{64} -->/.test(written));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('the board got faster'));
  assert.ok(!prompts[0].includes('TPT1'));
  assert.ok(!prompts[0].includes('private 3'));
  // same evidence, file now in dest → up-to-date, no prompt
  fs.mkdirSync(path.join(d.dest, 'docs/releases'), { recursive: true });
  fs.writeFileSync(path.join(d.dest, 'docs/releases/v0.9.3.md'), written);
  fs.rmSync(path.join(stage, 'docs'), { recursive: true });
  outLines.length = 0;
  assert.equal(await rn.main(common, deps), 0);
  assert.equal(kv().status, 'up-to-date');
  assert.equal(prompts.length, 1);
  assert.ok(!fs.existsSync(path.join(stage, 'docs')));
  // hand edit → kept-edited; --regenerate → regenerated
  fs.writeFileSync(path.join(d.dest, 'docs/releases/v0.9.3.md'), written.replace('work again', 'work again, reliably'));
  outLines.length = 0;
  assert.equal(await rn.main(common, deps), 0);
  assert.equal(kv().status, 'kept-edited');
  outLines.length = 0;
  assert.equal(await rn.main([...common, '--regenerate'], deps), 0);
  assert.equal(kv().status, 'regenerated');
  assert.equal(prompts.length, 2);
  // new private commit → evidence changes → edited file is kept-edited-stale
  fs.rmSync(path.join(stage, 'docs'), { recursive: true });
  fx.commit(f.git, f.src, { 'src/b.js': '4\n' }, 'TPT5: more');
  outLines.length = 0;
  assert.equal(await rn.main(common, deps), 0);
  assert.equal(kv().status, 'kept-edited-stale');
  // frozen and skipped statuses pass through without touching anything
  outLines.length = 0;
  assert.equal(await rn.main([...common.filter((a, i) => !(a === 'resolved' && common[i - 1] === '--base-status')).map(a => a === '--base-status' ? a : a), '--base-status', 'frozen'], deps), 0);
  assert.equal(kv().status, 'frozen');
  outLines.length = 0;
  await rn.main([...common, '--base-status', 'skipped-unresolved-base'], { ...deps });
  assert.equal(kv().status, 'skipped-unresolved-base');
});

test('main generate: a secret in the commit range rejects the evidence before any model call; model failure is reported', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const stage = path.join(f.home, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const d = buildDest(f.git, f.home, { tag: 'v0.9.2' });
  const paths = path.join(f.home, 'paths');
  fs.writeFileSync(paths, exported.join('\n') + '\n');
  const outLines = [];
  const kv = () => Object.fromEntries(outLines.map(l => l.trim().split(/=(.*)/s).slice(0, 2)));
  const deps = {
    stdout: (s) => outLines.push(s), stderr: () => {},
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: '' }), stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude', 'codex', 'gemini', 'pi'] },
    fetchComments: async () => ({ status: 404, body: {} }),
    runPrompt: async () => null,
  };
  const common = ['generate', '--src', f.src, '--ref', 'HEAD', '--dest', d.dest, '--stage', stage, '--version', '0.9.3', '--project-root', f.home,
    '--base-status', 'resolved', '--base', f.c0, '--prev-tag', 'v0.9.2', '--paths', paths, '--provider', 'codex'];
  assert.equal(await rn.main(common, deps), 0);
  let r = kv();
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.match(r.message, /model call failed/);
  assert.equal(r.provider, 'codex');
  assert.ok(!fs.existsSync(path.join(stage, 'docs')));
  outLines.length = 0;
  assert.equal(await rn.main([...common, '--provider', 'nope'], deps), 0);
  assert.equal(kv().status, 'failed');
  assert.match(kv().message, /unknown provider/);
  fx.commit(f.git, f.src, { 'src/a.js': 'x\n' }, `TPT9: add token ghp_${'Q'.repeat(24)}`);
  outLines.length = 0;
  assert.equal(await rn.main(common, { ...deps, runPrompt: async () => { throw new Error('must not be called'); } }), 0);
  r = kv();
  assert.equal(r.status, 'rejected-evidence');
  assert.ok(!r.message.includes('ghp_'));
  assert.ok(!fs.existsSync(path.join(stage, 'docs')));
});

test('main generate: empty exported range writes a stub without a model call; first release uses the README', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const stage = path.join(f.home, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'README.md'), '# TipΔTask\n\nRuns coding agents against a task board.\n');
  fs.writeFileSync(path.join(stage, 'package.json'), '{"version":"0.9.3","description":"A task app"}');
  const d = buildDest(f.git, f.home, { tag: 'v0.9.2' });
  const paths = path.join(f.home, 'paths');
  fs.writeFileSync(paths, '');
  const outLines = [];
  const kv = () => Object.fromEntries(outLines.map(l => l.trim().split(/=(.*)/s).slice(0, 2)));
  const prompts = [];
  const deps = {
    stdout: (s) => outLines.push(s), stderr: () => {},
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: 'm' }), stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude'] },
    runPrompt: async (p) => { prompts.push(p); return '## Highlights\n\n- Runs coding agents against your task board.'; },
  };
  assert.equal(await rn.main(['generate', '--src', f.src, '--ref', 'HEAD', '--dest', d.dest, '--stage', stage, '--version', '0.9.3', '--project-root', f.home,
    '--base-status', 'resolved', '--base', 'HEAD', '--prev-tag', 'v0.9.2', '--paths', paths], deps), 0);
  assert.equal(kv().status, 'stub');
  assert.ok(fs.readFileSync(path.join(stage, 'docs/releases/v0.9.3.md'), 'utf8').includes('No changes to the application since v0.9.2'));
  assert.equal(prompts.length, 0);
  fs.rmSync(path.join(stage, 'docs'), { recursive: true });
  outLines.length = 0;
  assert.equal(await rn.main(['generate', '--src', f.src, '--ref', 'HEAD', '--dest', path.join(f.home, 'newdest'), '--stage', stage, '--version', '0.9.3', '--project-root', f.home, '--base-status', 'first-release'], deps), 0);
  const r = kv();
  assert.equal(r.status, 'generated', JSON.stringify(r));
  assert.equal(r.resolutions, 'skipped (first release)');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('first public release'));
  assert.ok(prompts[0].includes('Runs coding agents against a task board'));
  assert.ok(!prompts[0].includes('Commits in this release'));
});

// ---------------------------------------------------------------- website Changelog drafts (TPT9040)

const EN_NOTES = '## Highlights\n\n- **Faster board.** The board renders faster.\n\n## Fixes\n\n- Notifications work again.';
const UK_NOTES = '## Головне\n\n- **Швидша дошка.** Дошка відображається швидше.\n\n## Виправлення\n\n- Сповіщення знову працюють.';
const sha256hex = (s) => require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex');
const readDraft = (dir, version) => JSON.parse(fs.readFileSync(path.join(dir, `v${version}.json`), 'utf8'));

test('changelogBodyFromNotes drops the marker and the installer footer; isStubNotes spots the no-changes stub', () => {
  const file = rn.renderNotesFile(EN_NOTES, 'e'.repeat(64));
  assert.equal(rn.changelogBodyFromNotes(file), EN_NOTES);
  assert.equal(rn.changelogBodyFromNotes(file.replace(/\n/g, '\r\n')), EN_NOTES);
  assert.equal(rn.changelogBodyFromNotes(`${EN_NOTES}\n\n---\n\nDownloads are on the release page.\n`), EN_NOTES, 'an edited footer goes too');
  const ruled = `${EN_NOTES}\n\n---\n\n## Known issues\n\n- One.`;
  assert.equal(rn.changelogBodyFromNotes(ruled), ruled, 'a rule followed by a section stays');
  assert.equal(rn.changelogBodyFromNotes('Intro line\n---\n\n- item'), 'Intro line\n---\n\n- item', 'a setext underline is not a rule');
  assert.ok(rn.isStubNotes(rn.stubNotes('v0.9.2')));
  assert.ok(rn.isStubNotes(rn.changelogBodyFromNotes(rn.renderNotesFile(rn.stubNotes(null), 'e'.repeat(64)))));
  assert.ok(!rn.isStubNotes('## Maintenance\n\nThe build scripts were tidied up.'));
});

test('changelog entries derive title, excerpt and SEO fields from the notes, inside the website limits', () => {
  const body = '## Highlights\n\n- **Ukrainian throughout.** Screens follow the project language.\n- **Finish button.** Relaunches the agent.\n- **Smarter limits.** Grows with memory.\n- **Fourth item.** Left out.\n\n## Fixes\n\n- A fix.';
  const { body: enBody, ...en } = rn.buildChangelogEntry({ locale: 'en', version: '0.9.15', body, origin: 'release-notes' });
  assert.equal(enBody, body);
  assert.deepEqual(en, {
    locale: 'en', origin: 'release-notes', title: 'Tipatask 0.9.15', excerpt: 'Ukrainian throughout. Finish button. Smarter limits.',
    seo_title: "What's new in Tipatask 0.9.15", seo_description: 'Ukrainian throughout. Finish button. Smarter limits.',
  });
  assert.equal(rn.deriveExcerpt('## Fixes\n\n- `Play All` now shows **one** [message](https://example.com/x) per refusal.\n- Second.'), 'Play All now shows one message per refusal.');
  assert.equal(rn.deriveExcerpt(rn.stubNotes('v0.9.2')), 'No changes to the application since v0.9.2; this build only moves the version number.');
  const long = rn.deriveExcerpt(`## Improvements\n\n${'word '.repeat(200)}`);
  assert.ok(long.length <= rn.CHANGELOG_LIMITS.excerpt && / word…$/.test(long), long.slice(-20));
  const uk = rn.buildChangelogEntry({ locale: 'uk', version: '0.9.15', body: UK_NOTES, origin: 'machine-translation' });
  assert.equal(uk.seo_title, 'Що нового в Tipatask 0.9.15');
  assert.equal(uk.excerpt, 'Швидша дошка.');
  const big = rn.buildChangelogEntry({ locale: 'en', version: '0.9.15', body: `## Highlights\n\n- **${'Long lead '.repeat(40)}** x`, origin: 'release-notes' });
  assert.ok(big.excerpt.length <= 300 && big.seo_description.length <= 160 && big.title.length <= 200 && big.seo_title.length <= 200);
});

test('validateTranslation holds the structure and refuses leaks, English answers and renamed headings', () => {
  const check = (text) => rn.validateTranslation(text, { sourceBody: EN_NOTES, keyPrefixes: ['TPT'] });
  assert.ok(check(UK_NOTES).ok, check(UK_NOTES).violations.join('; '));
  assert.equal(check(`\`\`\`markdown\n${UK_NOTES}\n\`\`\``).body, UK_NOTES);
  const why = (text) => check(text).violations.join(' | ');
  assert.match(why(UK_NOTES.replace('## Виправлення', '## Fixes')), /heading 2 must be "## Виправлення"/);
  assert.match(why(UK_NOTES.replace('\n\n## Виправлення', '')), /expected 2 "## " headings, got 1/);
  assert.match(why(`${UK_NOTES}\n- Ще один пункт.`), /expected 2 bullet points, got 3/);
  assert.match(why(EN_NOTES.replace('## Highlights', '## Головне').replace('## Fixes', '## Виправлення')), /not translated into Ukrainian/);
  assert.match(why(`${UK_NOTES.slice(0, -1)} (TPT12).`), /task identifier/);
  assert.match(why(`${UK_NOTES} /Users/anton/x`), /private path/);
  assert.match(why(`${UK_NOTES} anton@example.com`), /email address/);
  assert.match(why(`${UK_NOTES} ghp_${'Q'.repeat(24)}`), /credential-shaped/);
  assert.match(why(`# Заголовок\n\n${UK_NOTES}`), /an H1 heading/);
  assert.match(why(`${UK_NOTES}\n\n${'ж'.repeat(2100)}`), /too long/);
  assert.match(why(''), /empty answer/);
  // A heading the map does not know may be translated freely; its slot must still be there.
  assert.ok(rn.validateTranslation('## Подяки\n\n- Усім.', { sourceBody: '## Thanks\n\n- To everyone.' }).ok);
});

test('translateChangelog retries once with the violations, then reports rejected or failed', async () => {
  const prompts = [];
  const answers = [EN_NOTES, UK_NOTES];
  let r = await rn.translateChangelog({ body: EN_NOTES, version: '0.9.15', runPrompt: async (p) => { prompts.push(p); return answers.shift(); } });
  assert.equal(r.status, 'ok');
  assert.equal(r.body, UK_NOTES);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes(`=== SOURCE START ===\n${EN_NOTES}\n=== SOURCE END ===`));
  assert.ok(prompts[0].includes('"## Highlights" → "## Головне"'));
  assert.match(prompts[1], /previous answer was rejected[\s\S]*not translated into Ukrainian/);
  r = await rn.translateChangelog({ body: EN_NOTES, version: '0.9.15', runPrompt: async () => EN_NOTES });
  assert.equal(r.status, 'rejected');
  r = await rn.translateChangelog({ body: EN_NOTES, version: '0.9.15', runPrompt: async () => null });
  assert.equal(r.status, 'failed');
});

test('exportChangelogDraft: en from the notes, uk translated once per notes version and retried after a failure, nothing for leaks or stubs', async (t) => {
  const dir = path.join(scratch(t), 'drafts');
  const notes = rn.renderNotesFile(EN_NOTES, 'e'.repeat(64));
  const calls = [];
  const translate = async (body, version) => { calls.push({ body, version }); return { status: 'ok', body: UK_NOTES, violations: [] }; };
  const run = (extra = {}) => rn.exportChangelogDraft({ version: '0.9.15', notesText: notes, changelogDir: dir, translate, ...extra });

  let r = await run({ dryRun: true, translate: async () => { throw new Error('must not translate'); } });
  assert.equal(r.status, 'would-write');
  assert.ok(!fs.existsSync(dir), 'a dry run creates nothing');

  r = await run();
  assert.equal(r.status, 'written', r.message);
  assert.deepEqual(r.locales, ['en', 'uk']);
  assert.equal(r.file, path.join(dir, 'v0.9.15.json'));
  const a = readDraft(dir, '0.9.15');
  assert.deepEqual([a.kind, a.schema, a.version, a.source.notes_file, a.source.sha256], ['tipatask-changelog-draft', 1, '0.9.15', 'docs/releases/v0.9.15.md', sha256hex(EN_NOTES)]);
  assert.deepEqual(a.drafts.map(d => [d.locale, d.origin, d.title]), [['en', 'release-notes', 'Tipatask 0.9.15'], ['uk', 'machine-translation', 'Tipatask 0.9.15']]);
  assert.equal(a.drafts[0].body, EN_NOTES, 'the English entry is the notes body itself');
  assert.equal(a.drafts[1].body, UK_NOTES);
  assert.ok(!JSON.stringify(a).includes('tipatask-release-notes') && !JSON.stringify(a).includes('attached below'), 'no marker, no installer footer');
  assert.ok(!Object.keys(a).some(k => /publish|status/.test(k)) && a.drafts.every(d => !Object.keys(d).some(k => /publish|status/.test(k))), 'no publication state');
  assert.deepEqual(calls, [{ body: EN_NOTES, version: '0.9.15' }]);
  assert.deepEqual(fs.readdirSync(dir), ['v0.9.15.json'], 'no temp file left');

  const before = fs.statSync(r.file).mtimeMs;
  r = await run();
  assert.equal(r.status, 'up-to-date');
  assert.equal(calls.length, 1, 'unchanged notes reuse the translation');
  assert.equal(fs.statSync(r.file).mtimeMs, before);

  r = await run({ notesText: notes.replace('work again', 'work again, reliably') });
  assert.equal(r.status, 'written');
  assert.equal(calls.length, 2);
  assert.ok(readDraft(dir, '0.9.15').drafts[0].body.includes('reliably'));

  r = await run({ translate: async () => ({ status: 'failed', message: 'timed out', violations: [] }) });
  assert.equal(r.status, 'written-partial');
  assert.match(r.message, /wrote the English draft only: the Ukrainian translation failed \(timed out\)/);
  assert.deepEqual(readDraft(dir, '0.9.15').drafts.map(d => d.locale), ['en']);
  r = await run({ dryRun: true });
  assert.equal(r.status, 'would-write', 'an English-only draft is never up to date');
  r = await run({ translate: async () => ({ status: 'rejected', violations: ['expected 2 bullet points, got 1'] }) });
  assert.equal(r.status, 'written-partial');
  assert.match(r.message, /stays English-only: the Ukrainian translation was rejected \(expected 2 bullet points, got 1\)/);
  r = await run();
  assert.equal(r.status, 'written');
  assert.deepEqual(readDraft(dir, '0.9.15').drafts.map(d => d.locale), ['en', 'uk']);

  r = await rn.exportChangelogDraft({ version: '0.9.16', notesText: rn.renderNotesFile(`${EN_NOTES}\n- Closed TPT12.`, 'e'.repeat(64)), changelogDir: dir, keyPrefixes: ['TPT'], translate });
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /task identifier/);
  r = await rn.exportChangelogDraft({ version: '0.9.16', notesText: rn.renderNotesFile(rn.stubNotes('v0.9.15'), 'e'.repeat(64)), changelogDir: dir, translate });
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /no-changes stub/);
  r = await rn.exportChangelogDraft({ version: '0.9.16', notesText: '', changelogDir: dir, translate });
  assert.equal(r.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(dir, 'v0.9.16.json')));
  assert.equal(calls.length, 3);
});

test('main generate --changelog-dir: a draft only from usable notes; dry runs never write or call the model; a draft crash keeps the notes status', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = buildSrc(t);
  const stage = path.join(f.home, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const d = buildDest(f.git, f.home, { tag: 'v0.9.2' });
  const paths = path.join(f.home, 'paths');
  fs.writeFileSync(paths, exported.join('\n') + '\n');
  const drafts = path.join(f.home, 'drafts');
  const outLines = [];
  const kv = () => Object.fromEntries(outLines.map(l => l.trim().split(/=(.*)/s).slice(0, 2)));
  const prompts = [];
  let notesReply = EN_NOTES;
  const deps = {
    stdout: (s) => outLines.push(s), stderr: () => {},
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: 'm' }), stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude', 'codex', 'gemini', 'pi'] },
    fetchComments: async () => ({ status: 404, body: {} }),
    runPrompt: async (p) => { prompts.push(p); return p.includes('=== SOURCE START ===') ? UK_NOTES : notesReply; },
  };
  const common = ['generate', '--src', f.src, '--ref', 'HEAD', '--dest', d.dest, '--stage', stage, '--version', '0.9.3', '--project-root', f.home,
    '--base-status', 'resolved', '--base', f.c0, '--prev-tag', 'v0.9.2', '--paths', paths];
  const run = async (extra = [], dep = deps) => { outLines.length = 0; assert.equal(await rn.main([...common, ...extra], dep), 0); return kv(); };

  let r = await run(['--dry-run']);
  assert.ok(!Object.keys(r).some(k => k.startsWith('changelog')), 'no flag, no changelog keys');
  r = await run(['--dry-run', '--changelog-dir', drafts]);
  assert.equal(r.status, 'dry-run');
  assert.equal(r.changelog, 'would-write');
  assert.equal(r.changelog_prev, 'skipped', 'the v0.9.2 tag carries no notes');
  assert.equal(prompts.length, 0);
  assert.ok(!fs.existsSync(drafts));

  notesReply = null;
  r = await run(['--changelog-dir', drafts]);
  assert.equal(r.status, 'failed');
  assert.equal(r.changelog, 'skipped');
  assert.match(r.changelog_message, /no usable release notes for v0\.9\.3 in this run \(failed\)/);
  assert.ok(!fs.existsSync(drafts), 'failed generation writes no draft');

  notesReply = EN_NOTES;
  prompts.length = 0;
  r = await run(['--changelog-dir', drafts]);
  assert.equal(r.status, 'generated', JSON.stringify(r));
  assert.equal(r.changelog, 'written', r.changelog_message);
  assert.equal(r.changelog_locales, 'en,uk');
  assert.equal(r.changelog_file, path.join(drafts, 'v0.9.3.json'));
  assert.equal(prompts.length, 2, 'the notes, then the translation');
  const staged = fs.readFileSync(path.join(stage, 'docs/releases/v0.9.3.md'), 'utf8');
  assert.equal(readDraft(drafts, '0.9.3').drafts[0].body, rn.changelogBodyFromNotes(staged));
  assert.equal(readDraft(drafts, '0.9.3').drafts[0].body, EN_NOTES);

  fs.mkdirSync(path.join(d.dest, 'docs/releases'), { recursive: true });
  fs.writeFileSync(path.join(d.dest, 'docs/releases/v0.9.3.md'), staged);
  fs.rmSync(path.join(stage, 'docs'), { recursive: true });
  r = await run(['--changelog-dir', drafts]);
  assert.equal(r.status, 'up-to-date');
  assert.equal(r.changelog, 'up-to-date');
  assert.equal(prompts.length, 2);

  const fresh = path.join(f.home, 'fresh-drafts');
  r = await run(['--dry-run', '--changelog-dir', fresh]);
  assert.equal(r.status, 'up-to-date');
  assert.equal(r.changelog, 'would-write');
  assert.equal(prompts.length, 2);
  assert.ok(!fs.existsSync(fresh));

  fs.writeFileSync(path.join(d.dest, 'docs/releases/v0.9.3.md'), staged.replace('work again', 'work again, reliably'));
  r = await run(['--changelog-dir', drafts]);
  assert.equal(r.status, 'kept-edited');
  assert.equal(r.changelog, 'written');
  assert.equal(prompts.length, 3);
  assert.ok(readDraft(drafts, '0.9.3').drafts[0].body.includes('reliably'));

  const g = realGit();
  r = await run(['--changelog-dir', drafts], { ...deps, git: (cwd, a, o) => { if (a[0] === 'show') throw new Error('boom'); return g(cwd, a, o); } });
  assert.equal(r.status, 'kept-edited');
  assert.equal(r.changelog, 'failed');
  assert.match(r.changelog_message, /changelog draft step crashed: boom/);
});

test('main generate --changelog-dir: the previous release and a frozen version draft from their tagged notes; untagged drafts in between go', async (t) => {
  if (fx.skipUnless(t)) return;
  const home = scratch(t, 'rn-tags-');
  const git = fx.makeGit(home);
  const dest = path.join(home, 'dest');
  fx.initRepo(git, dest, { files: { 'package.json': '{"version":"0.9.2"}\n' } });
  fx.commit(git, dest, { 'docs/releases/v0.9.2.md': rn.renderNotesFile(EN_NOTES, 'e'.repeat(64)) }, 'Release notes v0.9.2');
  git(dest, ['tag', '-a', 'v0.9.2', '-m', 'TipΔTask v0.9.2']);
  fx.commit(git, dest, { 'src/a.js': '1\n' }, 'Untagged work');
  git(dest, ['tag', '-a', 'v0.9.5', '-m', 'TipΔTask v0.9.5']);
  const drafts = path.join(home, 'drafts');
  fs.mkdirSync(drafts);
  fs.writeFileSync(path.join(drafts, 'v0.9.3.json'), '{}\n');
  fs.writeFileSync(path.join(drafts, 'v0.9.1.json'), '{}\n');
  const outLines = [];
  const kv = () => Object.fromEntries(outLines.map(l => l.trim().split(/=(.*)/s).slice(0, 2)));
  const prompts = [];
  const deps = {
    stdout: (s) => outLines.push(s), stderr: () => {},
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: 'm' }), stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude'] },
    runPrompt: async (p) => { prompts.push(p); return UK_NOTES; },
  };
  const base = ['generate', '--src', home, '--ref', 'HEAD', '--dest', dest, '--stage', path.join(home, 'stage'), '--project-root', home, '--changelog-dir', drafts];
  const run = async (extra) => { outLines.length = 0; assert.equal(await rn.main([...base, ...extra], deps), 0); return kv(); };

  let r = await run(['--version', '0.9.4', '--base-status', 'skipped-unresolved-base', '--prev-tag', 'v0.9.2', '--dry-run']);
  assert.equal(r.status, 'skipped-unresolved-base');
  assert.equal(r.changelog, 'skipped');
  assert.equal(r.changelog_prev, 'would-write');
  assert.equal(r.changelog_prev_version, '0.9.2');
  assert.equal(r.changelog_stale, 'v0.9.3.json');
  assert.ok(fs.existsSync(path.join(drafts, 'v0.9.3.json')), 'a dry run deletes nothing');
  assert.equal(prompts.length, 0);

  r = await run(['--version', '0.9.4', '--base-status', 'skipped-unresolved-base', '--prev-tag', 'v0.9.2']);
  assert.equal(r.changelog_prev, 'written', r.changelog_prev_message);
  assert.equal(readDraft(drafts, '0.9.2').drafts[0].body, EN_NOTES);
  assert.deepEqual(fs.readdirSync(drafts).sort(), ['v0.9.1.json', 'v0.9.2.json'], 'the untagged v0.9.3 draft goes; older ones stay');
  assert.equal(prompts.length, 1);

  r = await run(['--version', '0.9.2', '--base-status', 'frozen', '--prev-tag', 'v0.9.2']);
  assert.equal(r.status, 'frozen');
  assert.equal(r.changelog, 'up-to-date', r.changelog_message);
  assert.equal(r.changelog_prev, undefined, 'the frozen version is not drafted twice');
  assert.equal(prompts.length, 1);

  r = await run(['--version', '0.9.5', '--base-status', 'frozen', '--prev-tag', 'v0.9.5']);
  assert.equal(r.changelog, 'skipped');
  assert.match(r.changelog_message, /the v0\.9\.5 tag carries no docs\/releases\/v0\.9\.5\.md/);
});

test('changelog-draft rebuilds one draft from a notes file; a provider problem only drops the Ukrainian entry', async (t) => {
  const dir = scratch(t);
  const notesFile = path.join(dir, 'v0.9.5.md');
  fs.writeFileSync(notesFile, rn.renderNotesFile(EN_NOTES, 'e'.repeat(64)));
  const outLines = [];
  const kv = () => Object.fromEntries(outLines.map(l => l.trim().split(/=(.*)/s).slice(0, 2)));
  const deps = {
    stdout: (s) => outLines.push(s), stderr: () => {},
    oneShot: { resolveDefaultSelection: () => ({ providerId: 'claude', model: 'm' }), stripSensitiveEnv: e => e },
    registry: { SELECTABLE_PROVIDERS: ['claude'] },
    runPrompt: async () => UK_NOTES,
  };
  const drafts = path.join(dir, 'drafts');
  assert.equal(await rn.main(['changelog-draft', '--notes', notesFile, '--version', 'v0.9.5', '--changelog-dir', drafts, '--project-root', dir], deps), 0);
  let r = kv();
  assert.equal(r.changelog, 'written', r.changelog_message);
  assert.equal(readDraft(drafts, '0.9.5').drafts[1].body, UK_NOTES);
  outLines.length = 0;
  assert.equal(await rn.main(['changelog-draft', '--notes', path.join(dir, 'missing.md'), '--version', '0.9.5', '--changelog-dir', drafts], deps), 1);
  assert.equal(kv().changelog, 'failed');
  outLines.length = 0;
  assert.equal(await rn.main(['changelog-draft', '--notes', notesFile, '--version', 'latest', '--changelog-dir', drafts], deps), 2);
  outLines.length = 0;
  assert.equal(await rn.main(['changelog-draft', '--notes', notesFile, '--version', '0.9.6', '--changelog-dir', drafts, '--project-root', dir, '--provider', 'nope'], { ...deps, runPrompt: undefined }), 0);
  r = kv();
  assert.equal(r.changelog, 'written-partial');
  assert.match(r.changelog_message, /unknown provider "nope"/);
  assert.deepEqual(readDraft(drafts, '0.9.6').drafts.map(x => x.locale), ['en']);
});
