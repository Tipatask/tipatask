'use strict';

// TPT701 — scripts/release-notes.js: release-base resolution (real git fixtures), bounded
// evidence, prompt/output validation, the notes-file marker and the rerun rules, and the
// generate flow with injected provider/comment deps. No model calls, no network.

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
