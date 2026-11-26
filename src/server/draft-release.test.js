'use strict';

// scripts/draft-release.js against a stand-in GitHub API on a loopback port. The stand-in keeps
// the behaviors the script exists for: several drafts may share one tag, a release's own
// `assets` array hides partial (`starter`) uploads that the assets listing shows, and an
// upload under a name that already has a record is refused with 422 already_exists, and a draft
// updated without `tag_name` loses its tag (the field becomes the `untagged-…` of its address)
// while naming the tag moves the draft to a new address. Two more behaviors cover the worst
// case, whether or not GitHub shows them: a `starter` record refuses its name too, and a request
// can be answered 5xx although its effect was stored.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/draft-release.js');
const {
  assetMatches, assetProblem, assetUploadUrl, collectFiles, contentTypeFor, createGithub, createReporter, draftRelease,
  githubAssetName, httpRequest, isRetryable, main, parseArgs, pickDraft, retryPause,
} = require(SCRIPT);

const TOKEN = 'tkn-for-tests';
const REPO = 'acme/app';
const TAG = 'v1.2.3';
const EXE = 'TipATask Setup 1.2.3.exe';
const EXE_STORED = 'TipATask.Setup.1.2.3.exe';

const sha256 = (data) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function startGithub(t) {
  const state = { releases: [], nextId: 500, calls: [], faults: [] };
  let base = '';

  const asset = (record) => ({
    id: record.id, name: record.name, label: record.label, state: record.state, size: record.size, digest: record.digest, content_type: record.contentType,
  });
  const view = (release) => ({
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    draft: release.draft,
    html_url: `https://github.test/${REPO}/releases/tag/${release.draft ? release.slug : release.tag_name}`,
    upload_url: `${base}/uploads/repos/${REPO}/releases/${release.id}/assets{?name,label}`,
    assets: release.assets.filter((record) => record.state === 'uploaded').map(asset),
  });
  const addRelease = (fields) => {
    const id = state.nextId += 1;
    const release = { id, slug: `untagged-${id}`, moves: 0, tag_name: TAG, name: TAG, body: 'old body', draft: true, assets: [], ...fields };
    state.releases.push(release);
    return release;
  };
  const addAsset = (release, name, data, extra = {}) => {
    const buffer = Buffer.from(data);
    const record = { id: state.nextId += 1, name, label: '', state: 'uploaded', size: buffer.length, digest: sha256(buffer), contentType: 'application/octet-stream', data: buffer, ...extra };
    release.assets.push(record);
    return record;
  };
  const takeFault = (route, name) => {
    const index = state.faults.findIndex((fault) => fault.route === route && (!fault.name || fault.name === name));
    if (index === -1) return null;
    const fault = state.faults[index];
    fault.times = (fault.times || 1) - 1;
    if (fault.times <= 0) state.faults.splice(index, 1);
    return fault;
  };
  const send = (res, status, payload, headers = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json', 'x-github-request-id': 'REQ1', ...headers });
    res.end(text);
  };
  const page = (items, url) => {
    const perPage = Number(url.searchParams.get('per_page')) || 30;
    const start = ((Number(url.searchParams.get('page')) || 1) - 1) * perPage;
    return items.slice(start, start + perPage);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const upload = url.pathname.match(new RegExp(`^/uploads/repos/${REPO}/releases/(\\d+)/assets$`));
    const api = url.pathname.startsWith(`/repos/${REPO}/`) ? url.pathname.slice(`/repos/${REPO}`.length) : null;
    const route = upload ? 'UPLOAD' : `${req.method} ${String(api).replace(/\d+/g, ':id')}`;
    const uploadName = upload ? url.searchParams.get('name') : null;
    const call = { route, name: uploadName, query: url.search, agent: req.headers['user-agent'], contentType: req.headers['content-type'] };
    state.calls.push(call);

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      await readBody(req);
      return send(res, 401, { message: 'Bad credentials' });
    }

    if (upload) {
      const release = state.releases.find((candidate) => candidate.id === Number(upload[1]));
      const stored = uploadName.replace(/[^A-Za-z0-9\-_+@]+/g, '.');
      const label = url.searchParams.get('label') || '';
      const fault = takeFault('UPLOAD', uploadName);
      const starter = () => release.assets.push({ id: state.nextId += 1, name: stored, label, state: 'starter', size: Number(req.headers['content-length']), digest: null, contentType: req.headers['content-type'] });
      if (fault && fault.early) {
        // Answer before the body was read, then drop the connection.
        res.writeHead(fault.status, { connection: 'close' });
        return res.end(fault.body || '', () => req.socket.destroy());
      }
      if (fault && fault.reset) {
        starter();
        return req.once('data', () => req.socket.destroy());
      }
      const data = await readBody(req);
      if (release.assets.some((record) => record.name === stored)) {
        return send(res, 422, { message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
      }
      if (fault && !fault.commit) {
        if (fault.leaveStarter) starter();
        return send(res, fault.status, fault.body || '');
      }
      const record = addAsset(release, stored, data, { label, contentType: req.headers['content-type'] });
      if (fault) return send(res, fault.status, fault.body || '');
      return send(res, 201, fault && fault.answer ? fault.answer : asset(record));
    }

    const body = await readBody(req);
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    call.json = json;
    const fault = takeFault(route);
    if (fault && !fault.commit) return send(res, fault.status, fault.body || '', fault.headers);
    const id = Number((api || '').match(/\d+/) || 0);
    const release = state.releases.find((candidate) => candidate.id === id);

    if (route === 'GET /releases') return send(res, 200, page([...state.releases].sort((a, b) => b.id - a.id).map(view), url));
    if (route === 'POST /releases') {
      const created = addRelease({ tag_name: json.tag_name, name: json.name, body: json.body, draft: json.draft === true });
      return fault ? send(res, fault.status, fault.body || '') : send(res, 201, view(created));
    }
    if (route === 'PATCH /releases/:id' && release) {
      Object.assign(release, json);
      if (release.draft) {
        // As GitHub does: a draft keeps its tag only when the update names it, and naming it
        // moves the draft to a new address.
        if (json.tag_name === undefined) release.tag_name = release.slug;
        else release.slug = `untagged-${release.id}-${release.moves += 1}`;
      }
      return send(res, 200, view(release));
    }
    if (route === 'GET /releases/:id/assets' && release) return send(res, 200, page(release.assets.map(asset), url));
    if (route === 'DELETE /releases/assets/:id') {
      const owner = state.releases.find((candidate) => candidate.assets.some((record) => record.id === id));
      if (!owner) return send(res, 404, { message: 'Not Found' });
      owner.assets = owner.assets.filter((record) => record.id !== id);
      res.writeHead(204);
      return res.end();
    }
    return send(res, 404, { message: 'Not Found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  return {
    state,
    url: base,
    addRelease,
    addAsset,
    fail: (fault) => state.faults.push(fault),
    count: (route, name) => state.calls.filter((call) => call.route === route && (!name || call.name === name)).length,
    drafts: () => state.releases.filter((release) => release.draft && release.tag_name === TAG),
  };
}

function makeDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
  return dir;
}

const INSTALLERS = () => ({
  [EXE]: crypto.randomBytes(3 * 1024 * 1024), // large enough to arrive in many chunks
  'TipATask-1.2.3-arm64.dmg': 'dmg bytes',
  'tipatask-app_1.2.3_amd64.deb': 'deb bytes',
  SHA256SUMS: 'sums\n',
});

// Runs draftRelease() the way main() does, with recorded pauses instead of real ones.
async function publish(github, dir, { body = 'release notes\n', dryRun = false, retryDelays = [10, 20, 30] } = {}) {
  const lines = [];
  const sleeps = [];
  const report = createReporter((line) => lines.push(line));
  const sleep = async (ms) => { sleeps.push(ms); };
  const client = createGithub({ token: TOKEN, repo: REPO, apiUrl: github.url, sleep, retryDelays, report });
  const files = await collectFiles(dir);
  const run = draftRelease({ github: client, tag: TAG, body, files, dryRun, sleep, retryDelays, report });
  return { run, lines, sleeps, files };
}

const actions = (result) => Object.fromEntries(result.assets.map((entry) => [entry.name, entry.action]));

function assertComplete(github, release, files) {
  assert.deepEqual(release.assets.map((record) => record.state), files.map(() => 'uploaded'));
  for (const file of files) {
    const stored = release.assets.find((record) => record.name === file.assetName);
    assert.ok(stored, `${file.name} is an asset`);
    assert.equal(stored.digest, file.digest, `${file.name} holds the file's bytes`);
  }
}

test('a tag without a release gets one draft holding every file', async (t) => {
  const github = await startGithub(t);
  const { run, sleeps, files } = await publish(github, makeDir(t, INSTALLERS()));
  const result = await run;

  assert.equal(github.drafts().length, 1);
  const [release] = github.drafts();
  assert.deepEqual([release.name, release.body, release.draft], [TAG, 'release notes\n', true]);
  assert.equal(result.created, true);
  assert.equal(result.release.id, release.id);
  assertComplete(github, release, files);
  assert.deepEqual(actions(result), Object.fromEntries(files.map((file) => [file.name, 'uploaded'])));
  assert.deepEqual(sleeps, [], 'nothing failed, so nothing waited');
  assert.equal(github.count('POST /releases'), 1);

  // GitHub rewrites the name with spaces; the label keeps the real one, as earlier releases have it.
  const exe = release.assets.find((record) => record.name === EXE_STORED);
  assert.equal(exe.label, EXE);
  assert.equal(exe.contentType, 'application/x-msdos-program');
  assert.equal(release.assets.find((record) => record.name === 'SHA256SUMS').label, '');
  assert.ok(github.state.calls.every((call) => call.agent === 'tipatask-draft-release'));
});

test('creation is retried with growing pauses when GitHub answers 500 and 502', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'POST /releases', status: 500, body: '' });
  github.fail({ route: 'POST /releases', status: 502, body: 'Server Error' });
  const { run, lines, sleeps, files } = await publish(github, makeDir(t, INSTALLERS()));
  const result = await run;

  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(github.count('POST /releases'), 3);
  assert.equal(github.drafts().length, 1);
  assertComplete(github, github.drafts()[0], files);
  assert.equal(result.created, true);
  // The 500 had no body: the log still says what failed.
  assert.ok(lines.some((line) => /retry: creating the draft release failed: POST .*HTTP 500: \(empty response body\)/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /HTTP 502: Server Error \(request REQ1\)/.test(line)));
});

test('a create request answered 502 that did create the release is not posted again', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'POST /releases', status: 502, body: '', commit: true });
  const { run, lines, sleeps, files } = await publish(github, makeDir(t, INSTALLERS()));
  const result = await run;

  assert.equal(github.count('POST /releases'), 1, 'the second look found the draft');
  assert.equal(github.drafts().length, 1);
  assert.deepEqual(sleeps, [10]);
  assert.equal(result.created, false);
  assert.ok(lines.some((line) => line.includes('A failed create request did create draft release')));
  assertComplete(github, github.drafts()[0], files);
});

test('a re-run reuses the draft, keeps identical assets and rewrites a changed body', async (t) => {
  const github = await startGithub(t);
  const dir = makeDir(t, INSTALLERS());
  await (await publish(github, dir)).run;
  const uploadsBefore = github.count('UPLOAD');

  const { run, files } = await publish(github, dir, { body: 'edited notes\n' });
  const result = await run;

  assert.equal(github.drafts().length, 1);
  assert.equal(github.count('POST /releases'), 1, 'no second release');
  assert.equal(github.count('UPLOAD'), uploadsBefore, 'nothing was uploaded again');
  assert.equal(github.count('DELETE /releases/assets/:id'), 0);
  assert.deepEqual(actions(result), Object.fromEntries(files.map((file) => [file.name, 'kept'])));
  assert.equal(result.bodyUpdated, true);
  assert.equal(github.drafts()[0].body, 'edited notes\n');

  // GitHub takes the tag from a draft updated without it: the rewrite named the tag, so the
  // draft is still the tag's release, and the result carries the address the update moved it to.
  const [release] = github.state.releases;
  assert.equal(release.tag_name, TAG);
  assert.equal(result.release.tag_name, TAG);
  assert.equal(result.release.html_url, `https://github.test/${REPO}/releases/tag/untagged-${release.id}-1`);

  // Same notes, apart from the line endings the web editor saves: no rewrite.
  github.drafts()[0].body = 'edited notes\r\n';
  const again = await (await publish(github, dir, { body: 'edited notes\n' })).run;
  assert.equal(again.bodyUpdated, false);
  assert.equal(github.count('PATCH /releases/:id'), 1);
  assert.deepEqual([again.created, again.release.id], [false, release.id], 'the run after the rewrite found the same draft');
  assert.equal(github.state.releases.length, 1);
});

test('a draft updated without its tag is no longer the tag\'s release, so the rewrite must name the tag', async (t) => {
  const github = await startGithub(t);
  const release = github.addRelease({});
  const client = createGithub({ token: TOKEN, repo: REPO, apiUrl: github.url, retryDelays: [] });

  // The stand-in follows GitHub here: this is the request the script must never send.
  const dropped = await client.updateRelease(release.id, { body: 'only the body' });
  assert.equal(dropped.tag_name, `untagged-${release.id}`);
  assert.equal(github.drafts().length, 0, 'a lookup by tag misses the draft');
  const restored = await client.updateRelease(release.id, { tag_name: TAG });
  assert.deepEqual([restored.tag_name, restored.body], [TAG, 'only the body']);
  assert.notEqual(restored.html_url, dropped.html_url, 'naming the tag moves the draft');

  // An answer that does not carry the tag fails the run before anything is uploaded.
  github.fail({ route: 'PATCH /releases/:id', status: 200, body: JSON.stringify({ id: release.id, tag_name: `untagged-${release.id}`, draft: true }) });
  const { run } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));
  await assert.rejects(run, (error) => {
    assert.equal(error.message, `updating draft release ${release.id} did not keep its tag ${TAG}: GitHub answered tag_name "untagged-${release.id}" for release ${release.id}`);
    assert.ok(!error.transient);
    return true;
  });
  assert.equal(github.count('UPLOAD'), 0);
  const sent = github.state.calls.filter((call) => call.route === 'PATCH /releases/:id').map((call) => call.json);
  assert.deepEqual(sent[sent.length - 1], { body: 'release notes\n', tag_name: TAG }, 'the rewrite sends the tag with the body');
});

test('partial uploads and assets with other content are deleted and uploaded again', async (t) => {
  const github = await startGithub(t);
  const dir = makeDir(t, INSTALLERS());
  const release = github.addRelease({ body: 'release notes\n' });
  // The state a failed run leaves: one asset complete, one of other content, one `starter` record.
  github.addAsset(release, EXE_STORED, fs.readFileSync(path.join(dir, EXE)), { label: EXE });
  github.addAsset(release, 'TipATask-1.2.3-arm64.dmg', 'bytes of an earlier build');
  github.addAsset(release, 'SHA256SUMS', '', { state: 'starter', size: 5, digest: null });

  const { run, lines, files } = await publish(github, dir);
  const result = await run;

  assert.deepEqual(actions(result), {
    [EXE]: 'kept',
    'TipATask-1.2.3-arm64.dmg': 'replaced',
    'tipatask-app_1.2.3_amd64.deb': 'uploaded',
    SHA256SUMS: 'uploaded',
  });
  assert.equal(github.count('UPLOAD', EXE), 0, 'the identical installer is not sent again');
  assert.equal(github.count('DELETE /releases/assets/:id'), 2);
  assert.equal(github.count('POST /releases'), 0);
  assert.equal(result.bodyUpdated, false);
  assertComplete(github, release, files);
  assert.ok(lines.some((line) => /deleting {2}SHA256SUMS \(asset \d+: partial upload, state starter\)/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /deleting {2}TipATask-1\.2\.3-arm64\.dmg \(asset \d+: other content\)/.test(line)));
});

test('an upload that breaks off is retried after its starter record is deleted', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'UPLOAD', name: EXE, reset: true });
  github.fail({ route: 'UPLOAD', name: 'SHA256SUMS', status: 502, body: '', leaveStarter: true, times: 2 });
  const { run, lines, sleeps, files } = await publish(github, makeDir(t, INSTALLERS()));
  const result = await run;

  assertComplete(github, github.drafts()[0], files);
  assert.equal(github.count('UPLOAD', EXE), 2);
  assert.equal(github.count('UPLOAD', 'SHA256SUMS'), 3);
  assert.equal(github.count('DELETE /releases/assets/:id'), 3, 'one starter record per failed upload');
  assert.deepEqual(sleeps, [10, 20, 10], 'each file starts its own schedule (SHA256SUMS sorts first)');
  assert.deepEqual(actions(result), Object.fromEntries(files.map((file) => [file.name, 'uploaded'])));
  assert.ok(lines.some((line) => /retry: uploading SHA256SUMS failed: POST .*HTTP 502: \(empty response body\)/.test(line)), lines.join('\n'));
});

test('an upload answered 502 although GitHub stored it is not sent twice', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'UPLOAD', name: 'tipatask-app_1.2.3_amd64.deb', status: 502, body: 'Bad Gateway', commit: true });
  const { run, lines, files } = await publish(github, makeDir(t, INSTALLERS()));
  const result = await run;

  assert.equal(github.count('UPLOAD', 'tipatask-app_1.2.3_amd64.deb'), 1);
  assert.equal(github.count('DELETE /releases/assets/:id'), 0);
  assert.equal(actions(result)['tipatask-app_1.2.3_amd64.deb'], 'uploaded');
  assertComplete(github, github.drafts()[0], files);
  assert.ok(lines.some((line) => line.includes('stored by GitHub although the upload request failed')));
});

test('an upload answered before its body was read is retried', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'UPLOAD', name: EXE, status: 503, body: 'try later', early: true });
  const { run, sleeps, files } = await publish(github, makeDir(t, INSTALLERS()));
  await run;

  assert.equal(github.count('UPLOAD', EXE), 2);
  assert.deepEqual(sleeps, [10]);
  assertComplete(github, github.drafts()[0], files);
});

test('a name blocked by a record the listing did not show is cleared on the next round', async (t) => {
  const github = await startGithub(t);
  const release = github.addRelease({ body: 'release notes\n' });
  github.addAsset(release, 'SHA256SUMS', '', { state: 'starter', size: 5, digest: null });
  // The assets listing lags once: it answers an empty list although the starter record exists.
  github.fail({ route: 'GET /releases/:id/assets', status: 200, body: '[]' });
  const { run, lines, sleeps, files } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));
  await run;

  assert.equal(github.count('UPLOAD'), 2, 'the first upload met the blocked name');
  assert.equal(github.count('DELETE /releases/assets/:id'), 1);
  assert.deepEqual(sleeps, [10]);
  assertComplete(github, release, files);
  assert.ok(lines.some((line) => /retry: uploading SHA256SUMS failed: POST .*HTTP 422: Validation Failed \(already_exists\)/.test(line)), lines.join('\n'));
});

test('an upload that keeps failing gives up with the status and the file name', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'UPLOAD', name: 'SHA256SUMS', status: 500, body: '', times: 99 });
  const { run, sleeps } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));

  await assert.rejects(run, (error) => {
    assert.match(error.message, /^SHA256SUMS: the upload failed after 4 attempt\(s\): POST .*HTTP 500: \(empty response body\)/);
    assert.equal(error.transient, true);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.deepEqual(sleeps, [10, 20, 30]);
  assert.equal(github.count('UPLOAD'), 4);
});

test('an answer that will not change is not retried', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'POST /releases', status: 403, body: JSON.stringify({ message: 'Resource not accessible by integration' }) });
  const { run, sleeps } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));

  await assert.rejects(run, (error) => {
    assert.match(error.message, /creating the draft release of v1\.2\.3 failed after 1 attempt\(s\): POST .*HTTP 403: Resource not accessible by integration/);
    assert.equal(error.transient, false);
    return true;
  });
  assert.deepEqual(sleeps, []);
  assert.equal(github.count('UPLOAD'), 0);
});

test('reads are retried and a rate limit sets the pause', async (t) => {
  const github = await startGithub(t);
  github.fail({ route: 'GET /releases', status: 503, body: '' });
  github.fail({ route: 'GET /releases', status: 403, body: JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), headers: { 'retry-after': '7' } });
  const { run, sleeps, files } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));
  await run;

  assert.deepEqual(sleeps, [10, 7000]);
  assertComplete(github, github.drafts()[0], files);
});

test('a published release of the tag is never changed', async (t) => {
  const github = await startGithub(t);
  const published = github.addRelease({ draft: false, body: 'published notes' });
  const leftover = github.addRelease({});
  const { run } = await publish(github, makeDir(t, INSTALLERS()));

  await assert.rejects(run, (error) => {
    assert.match(error.message, /release v1\.2\.3 is already published/);
    assert.ok(error.message.includes(String(published.id)));
    assert.ok(error.message.includes(`Leftover draft(s) of the same tag: ${leftover.id}`));
    assert.ok(!error.transient);
    return true;
  });
  assert.deepEqual(github.state.calls.map((call) => call.route), ['GET /releases'], 'nothing was written');
  assert.equal(published.body, 'published notes');
});

test('of several drafts the fullest is completed and the others are reported, not deleted', async (t) => {
  const github = await startGithub(t);
  const dir = makeDir(t, INSTALLERS());
  const empty = github.addRelease({});
  const partial = github.addRelease({});
  github.addAsset(partial, 'SHA256SUMS', 'sums\n');
  const newer = github.addRelease({});
  github.addRelease({ tag_name: 'v1.2.2' });

  const { run, files } = await publish(github, dir);
  const result = await run;

  assert.equal(result.release.id, partial.id);
  assertComplete(github, partial, files);
  assert.deepEqual(result.duplicates.map((other) => other.id).sort(), [empty.id, newer.id].sort());
  assert.equal(github.drafts().length, 3, 'the duplicates are left for the maintainer');
  assert.equal(github.count('POST /releases'), 0);

  assert.equal(pickDraft([{ id: 9, assets: [] }, { id: 4, assets: [] }]).id, 4, 'the oldest on a tie');
  assert.equal(pickDraft([{ id: 4 }, { id: 9, assets: [{ state: 'uploaded' }] }]).id, 9);
});

test('assets that are not among the files are reported and kept', async (t) => {
  const github = await startGithub(t);
  const release = github.addRelease({ body: 'release notes\n' });
  const stray = github.addAsset(release, 'notes-by-hand.txt', 'kept');
  const { run } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));
  const result = await run;

  assert.deepEqual(result.extras, [{ id: stray.id, name: 'notes-by-hand.txt', state: 'uploaded' }]);
  assert.equal(release.assets.length, 2);
});

test('a dry run reads the plan and writes nothing', async (t) => {
  const github = await startGithub(t);
  const dir = makeDir(t, INSTALLERS());
  const release = github.addRelease({});
  github.addAsset(release, EXE_STORED, fs.readFileSync(path.join(dir, EXE)), { label: EXE });
  github.addAsset(release, 'SHA256SUMS', '', { state: 'starter', size: 5, digest: null });

  const { run, lines } = await publish(github, dir, { dryRun: true });
  const result = await run;

  assert.deepEqual(actions(result), {
    [EXE]: 'kept',
    'TipATask-1.2.3-arm64.dmg': 'would-upload',
    'tipatask-app_1.2.3_amd64.deb': 'would-upload',
    SHA256SUMS: 'would-replace',
  });
  assert.equal(result.bodyUpdated, true);
  assert.ok(lines.includes('Would rewrite the draft body from the notes file.'));
  assert.ok(github.state.calls.every((call) => call.route.startsWith('GET ')), 'only reads');
  assert.equal(release.body, 'old body');
  assert.equal(release.assets.length, 2);

  const bare = await startGithub(t);
  const fresh = await (await publish(bare, dir, { dryRun: true })).run;
  assert.equal(fresh.release, null);
  assert.deepEqual([...new Set(Object.values(actions(fresh)))], ['would-upload']);
  assert.equal(bare.state.releases.length, 0);
});

test('the draft is found on a later page of the release list', async (t) => {
  const github = await startGithub(t);
  const draft = github.addRelease({ body: 'release notes\n' });
  for (let i = 0; i < 130; i += 1) github.addRelease({ tag_name: `v0.0.${i}`, draft: false });
  const { run, files } = await publish(github, makeDir(t, { SHA256SUMS: 'sums\n' }));
  const result = await run;

  assert.equal(result.release.id, draft.id);
  assert.equal(github.count('POST /releases'), 0);
  assert.ok(github.state.calls.some((call) => call.route === 'GET /releases' && call.query.includes('page=2')));
  assertComplete(github, draft, files);
});

test('GitHub asset names follow the rewrite rule', () => {
  // Pairs as GitHub stored them on published releases.
  assert.equal(githubAssetName('TipATask Setup 0.9.24.exe'), 'TipATask.Setup.0.9.24.exe');
  for (const name of ['TipATask-0.9.24-arm64.dmg', 'TipATask-0.9.24.AppImage', 'tipatask-app_0.9.24_amd64.deb', 'tipatask-app-0.9.24.pacman', 'SHA256SUMS']) {
    assert.equal(githubAssetName(name), name);
  }
  assert.equal(githubAssetName('a  b..c'), 'a.b.c');
  assert.equal(githubAssetName('Crème brûlée.zip'), 'Creme.brulee.zip');
  assert.equal(githubAssetName('.env'), 'default.env');
  assert.equal(githubAssetName('a b'), 'a.b');
  assert.equal(githubAssetName('(1)'), 'default.1');
  assert.equal(githubAssetName('v1+b@x_y-z'), 'v1+b@x_y-z');
});

test('assets are matched, judged and addressed by name, state, size and digest', () => {
  const file = { name: EXE, assetName: EXE_STORED, size: 3, digest: 'sha256:aa' };
  assert.equal(assetMatches({ name: EXE_STORED }, file), true);
  assert.equal(assetMatches({ name: 'other', label: EXE }, file), true);
  assert.equal(assetMatches({ name: 'other', label: '' }, file), false);
  assert.equal(assetMatches(null, file), false);

  assert.equal(assetProblem({ state: 'uploaded', size: 3, digest: 'sha256:aa' }, file), null);
  assert.equal(assetProblem({ state: 'uploaded', size: 3, digest: null }, file), null, 'no digest reported: state and size decide');
  assert.match(assetProblem({ state: 'starter', size: 3 }, file), /state starter/);
  assert.match(assetProblem({ state: 'uploaded', size: 4 }, file), /4 bytes stored, the file has 3/);
  assert.match(assetProblem({ state: 'uploaded', size: 3, digest: 'sha256:bb' }, file), /sha256:bb/);
  assert.match(assetProblem(null, file), /no asset/);

  const release = { id: 7, upload_url: 'https://uploads.github.test/repos/acme/app/releases/7/assets{?name,label}' };
  const url = new URL(assetUploadUrl(release, file));
  assert.equal(url.pathname, '/repos/acme/app/releases/7/assets');
  assert.deepEqual([url.searchParams.get('name'), url.searchParams.get('label')], [EXE, EXE]);
  assert.equal(new URL(assetUploadUrl(release, { name: 'SHA256SUMS', assetName: 'SHA256SUMS' })).searchParams.has('label'), false);
  assert.throws(() => assetUploadUrl({ id: 7 }, file), /release 7 has no usable upload_url/);

  assert.equal(contentTypeFor('a.DMG'), 'application/x-apple-diskimage');
  assert.equal(contentTypeFor('a.deb'), 'application/x-debian-package');
  assert.equal(contentTypeFor('TipATask-1.2.3.AppImage'), 'application/octet-stream');
  assert.equal(contentTypeFor('SHA256SUMS'), 'application/octet-stream');
});

test('retry decisions follow the status and the headers', () => {
  const withStatus = (status, headers = {}) => ({ status, headers });
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryable(withStatus(status)), true, String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryable(withStatus(status)), false, String(status));
  assert.equal(isRetryable(withStatus(403, { 'retry-after': '3' })), true);
  assert.equal(isRetryable(withStatus(403, { 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isRetryable({ network: true }), true);
  assert.equal(isRetryable(null), false);

  assert.equal(retryPause(withStatus(502), 5000), 5000);
  assert.equal(retryPause(withStatus(429, { 'retry-after': '30' }), 5000), 30000);
  assert.equal(retryPause(withStatus(429, { 'retry-after': '1' }), 5000), 5000, 'never shorter than the schedule');
  assert.equal(retryPause(withStatus(429, { 'retry-after': '99999' }), 5000), 5 * 60 * 1000, 'capped');
  assert.equal(retryPause(withStatus(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }), 5000, 1000 * 1000), 60000);
});

test('the installers directory is read as the glob dir/* would give it', async (t) => {
  const dir = makeDir(t, { 'b.deb': 'bb', 'a.dmg': 'a', '.hidden': 'x' });
  fs.mkdirSync(path.join(dir, 'unpacked'));
  const files = await collectFiles(dir);
  assert.deepEqual(files.map((file) => [file.name, file.size, file.contentType]), [
    ['a.dmg', 1, 'application/x-apple-diskimage'],
    ['b.deb', 2, 'application/x-debian-package'],
  ]);
  assert.equal(files[0].digest, sha256('a'));

  await assert.rejects(collectFiles(makeDir(t, {})), /no files to publish/);
  await assert.rejects(collectFiles(makeDir(t, { 'empty.dmg': '' })), /empty\.dmg is empty/);
  await assert.rejects(collectFiles(makeDir(t, { 'a b.exe': '1', 'a.b.exe': '2' })), /would both be stored as a\.b\.exe/);
  await assert.rejects(collectFiles(path.join(dir, 'missing')), /cannot read the installers directory/);
});

test('a request with no answer fails after its idle limit', async (t) => {
  const server = http.createServer(() => {}); // accepts the request and never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  await assert.rejects(httpRequest({ url: `http://127.0.0.1:${server.address().port}/`, idleTimeoutMs: 50 }), { code: 'ETIMEDOUT' });
});

test('the command line validates its arguments before any request', async () => {
  assert.deepEqual(parseArgs(['--tag', 'v1', '--notes', 'n.md', '--dir', 'd', '--dry-run', '--repo', 'a/b', '--api-url', 'http://x']),
    { dryRun: true, help: false, tag: 'v1', notes: 'n.md', dir: 'd', repo: 'a/b', apiUrl: 'http://x' });
  assert.throws(() => parseArgs(['--tag']), /--tag needs a value/);
  assert.throws(() => parseArgs(['--force']), /unknown argument --force/);

  const run = async (argv, env) => {
    const lines = [];
    return { code: await main(argv, env, (line) => lines.push(line)), text: lines.join('\n') };
  };
  const complete = ['--tag', TAG, '--notes', 'n.md', '--dir', 'd'];
  assert.match((await run(['--notes', 'n.md', '--dir', 'd'], {})).text, /--tag is required/);
  assert.equal((await run(['--notes', 'n.md', '--dir', 'd'], {})).code, 2);
  assert.match((await run(complete, { GITHUB_TOKEN: TOKEN })).text, /set GITHUB_REPOSITORY or pass --repo owner\/name/);
  assert.match((await run(complete, { GITHUB_REPOSITORY: REPO })).text, /set GITHUB_TOKEN/);
  assert.deepEqual(await run(['--help'], {}).then((out) => [out.code, /^Usage: /.test(out.text)]), [0, true]);
});

test('the command reports a failure with its cause, without the token', async (t) => {
  const github = await startGithub(t);
  const dir = makeDir(t, { SHA256SUMS: 'sums\n' });
  const notes = path.join(makeDir(t, { 'notes.md': 'release notes\n' }), 'notes.md');
  const lines = [];
  const env = { GITHUB_TOKEN: 'a-wrong-token', GITHUB_REPOSITORY: REPO, GITHUB_API_URL: github.url };
  const code = await main(['--tag', TAG, '--notes', notes, '--dir', dir], env, (line) => lines.push(line));

  assert.equal(code, 1);
  const error = lines.find((line) => line.startsWith('::error title=Draft release failed::'));
  assert.match(error, /GET \/repos\/acme\/app\/releases\?per_page=100&page=1 answered HTTP 401: Bad credentials/);
  assert.ok(!error.includes('Re-run this job'), 'a wrong token is not fixed by a re-run');
  assert.ok(!lines.join('\n').includes('a-wrong-token'));

  const missing = [];
  assert.equal(await main(['--tag', TAG, '--notes', path.join(dir, 'none.md'), '--dir', dir], env, (line) => missing.push(line)), 1);
  assert.match(missing.join('\n'), /cannot read the release notes/);
});

test('the command tells a passing failure from a lasting one', async (t) => {
  const github = await startGithub(t);
  github.addRelease({ draft: false });
  const dir = makeDir(t, { SHA256SUMS: 'sums\n' });
  const notes = path.join(makeDir(t, { 'notes.md': 'release notes\n' }), 'notes.md');
  const lines = [];
  const env = { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: github.url };
  assert.equal(await main(['--tag', TAG, '--notes', notes, '--dir', dir], env, (line) => lines.push(line)), 1);
  const error = lines.find((line) => line.startsWith('::error '));
  assert.match(error, /already published/);
  assert.ok(!error.includes('Re-run this job'));
});

test('run as a program it fills the draft and reports through the workflow files', async (t) => {
  const github = await startGithub(t);
  const stale = github.addRelease({ body: 'release notes\n' });
  github.addRelease({});
  github.addAsset(stale, 'SHA256SUMS', 'sums\n');
  const dir = makeDir(t, INSTALLERS());
  const scratch = makeDir(t, { 'notes.md': 'release notes\n', output: '', summary: '' });
  const env = {
    ...process.env,
    GITHUB_TOKEN: TOKEN,
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: github.url,
    GITHUB_OUTPUT: path.join(scratch, 'output'),
    GITHUB_STEP_SUMMARY: path.join(scratch, 'summary'),
  };
  const child = spawn(process.execPath, [SCRIPT, '--tag', TAG, '--notes', path.join(scratch, 'notes.md'), '--dir', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 120000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(kill);

  assert.equal(code, 0, out);
  assert.equal(stale.assets.filter((record) => record.state === 'uploaded').length, 4);
  assert.match(out, new RegExp(`::notice title=Draft release::Draft release ${stale.id} of v1\\.2\\.3 holds all 4 files: https://github\\.test/`));
  assert.match(out, /::warning title=Duplicate draft releases::v1\.2\.3 has 1 more draft release\(s\)/);
  assert.match(out, /gh api -X DELETE repos\/acme\/app\/releases\/<id>/);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), `release_id=${stale.id}\nrelease_url=https://github.test/${REPO}/releases/tag/untagged-${stale.id}\n`);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /\| `SHA256SUMS` \| 5 bytes \| kept \|/);
  assert.match(summary, /\| `TipATask Setup 1\.2\.3\.exe` \| 3\.0 MB \| uploaded \|/);
  assert.ok(!out.includes(TOKEN));
});
