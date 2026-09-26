'use strict';

// (C1176) Tests for the local voice-model downloader. Every test injects a fake { registry,
// baseUrl, rootDir } — no real network, no multi-hundred-MB downloads in CI. Registry sizes
// here are 4-64KB fakes; real-model integrity (sizes/sha256/URLs against the real
// VOICE_MODEL_REGISTRY) is asserted separately at the bottom with zero network or fs calls.
// scripts/probe-voice-model.js is what actually hits huggingface.co.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const manager = require('./voice-model-manager');
const {
  VOICE_MODEL_IDS, VOICE_MODEL_REGISTRY, VOICE_MODEL_ERRORS,
  voiceModelsRoot, voiceModelDir, resolveVoiceModelUrl,
  getVoiceModelStatus, listVoiceModels, downloadVoiceModel, abortVoiceModelDownload, deleteVoiceModel,
} = manager;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fakeBytes(n, seed = 0) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + seed) & 0xff;
  return buf;
}

// Builds a one-model fake registry from real byte buffers, and a local HTTP server that can
// serve them whole, ranged, truncated, or 404. Tracks every request path + Range header seen.
function buildFixture({ files, modelId = 'fake-model' } = {}) {
  const fileMap = new Map(); // name -> buffer
  const registryFiles = files.map(({ name, bytes }) => {
    fileMap.set(name, bytes);
    return { role: name, name, size: bytes.length, sha256: sha256(bytes) };
  });
  const registry = {
    [modelId]: {
      id: modelId, label: modelId, kind: 'test', repo: 'test/repo', revision: 'a'.repeat(40),
      files: registryFiles,
    },
  };
  return { registry, fileMap, modelId };
}

async function withFakeHub({ fileMap, truncateAfter = null, ignoreRange = false, force404 = false, dripDelayMs = null }, run) {
  const requests = []; // { path, range }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname.split('/').pop());
    requests.push({ path: url.pathname, range: req.headers.range || null });

    if (force404 || !fileMap.has(name)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const full = fileMap.get(name);
    const range = req.headers.range;
    let body, status = 200, headers;
    if (range && !ignoreRange) {
      const m = /^bytes=(\d+)-$/.exec(range);
      const start = m ? Number(m[1]) : 0;
      body = full.subarray(start);
      if (truncateAfter != null) body = body.subarray(0, truncateAfter);
      status = 206;
      headers = { 'Content-Range': `bytes ${start}-${full.length - 1}/${full.length}`, 'Content-Length': String(body.length) };
    } else {
      body = truncateAfter != null ? full.subarray(0, truncateAfter) : full;
      headers = { 'Content-Length': String(body.length) };
    }

    if (dripDelayMs != null) {
      // Feed the body in two halves with a pause between, so a test can reliably abort or
      // race against a download that would otherwise complete in well under 1ms over loopback.
      res.writeHead(status, headers);
      const mid = Math.floor(body.length / 2);
      res.write(body.subarray(0, mid));
      await new Promise((resolve) => setTimeout(resolve, dripDelayMs));
      return res.end(body.subarray(mid));
    }
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, rootDir, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ── happy path + idempotency ──

test('downloadVoiceModel: happy path — files land byte-exact, marker written, no leftovers', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(5000, 1) }, { name: 'b.bin', bytes: fakeBytes(2000, 2) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    const result = await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    assert.equal(result.skipped, false);
    assert.equal(result.files.length, 2);

    const dir = path.join(rootDir, modelId);
    for (const f of files) {
      const onDisk = fs.readFileSync(path.join(dir, f.name));
      assert.ok(onDisk.equals(f.bytes), `${f.name} bytes mismatch`);
    }
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete.json'), 'utf8'));
    assert.equal(marker.modelId, modelId);
    assert.equal(marker.revision, registry[modelId].revision);
    assert.equal(marker.totalBytes, 7000);

    const leftover = fs.readdirSync(dir).filter((n) => n.endsWith('.part') || n.endsWith('.part.json') || n === '.download.lock');
    assert.deepEqual(leftover, []);
  });
});

test('downloadVoiceModel: second call is a no-op cache hit — zero further requests', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(3000, 3) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir, requests }) => {
    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    const countAfterFirst = requests.length;
    const second = await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    assert.equal(second.skipped, true);
    assert.equal(requests.length, countAfterFirst, 'no HTTP requests on a cached hit');
  });
});

test('downloadVoiceModel: force:true re-downloads even when cached', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(3000, 4) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir, requests }) => {
    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    const countAfterFirst = requests.length;
    const second = await downloadVoiceModel(modelId, { registry, baseUrl, rootDir, force: true });
    assert.equal(second.skipped, false);
    assert.ok(requests.length > countAfterFirst);
  });
});

// ── failure modes ──

test('downloadVoiceModel: size mismatch rejects, leaves no destination/.part/sidecar', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(4000, 5) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap, truncateAfter: 100 }, async ({ baseUrl, rootDir }) => {
    await assert.rejects(
      downloadVoiceModel(modelId, { registry, baseUrl, rootDir }),
      (err) => err.code === VOICE_MODEL_ERRORS.SIZE_MISMATCH
    );
    const dir = path.join(rootDir, modelId);
    assert.equal(fs.existsSync(path.join(dir, 'a.bin')), false);
    assert.equal(fs.existsSync(path.join(dir, 'a.bin.part')), false);
    assert.equal(fs.existsSync(path.join(dir, 'a.bin.part.json')), false);
  });
});

test('downloadVoiceModel: unknown modelId rejects VOICE_MODEL_UNKNOWN before touching fs', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    await assert.rejects(
      downloadVoiceModel('nope', { registry: VOICE_MODEL_REGISTRY, rootDir }),
      (err) => err.code === VOICE_MODEL_ERRORS.UNKNOWN
    );
    assert.deepEqual(fs.readdirSync(rootDir), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('downloadVoiceModel: prototype-pollution-shaped ids are rejected as unknown, not resolved', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    for (const bad of ['__proto__', 'constructor', 'toString', '../escape', 'a/b']) {
      await assert.rejects(
        downloadVoiceModel(bad, { registry: VOICE_MODEL_REGISTRY, rootDir }),
        (err) => err.code === VOICE_MODEL_ERRORS.UNKNOWN,
        `expected ${bad} to be rejected`
      );
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('downloadVoiceModel: 404 rejects VOICE_MODEL_HTTP with err.status', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(1000, 6) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap, force404: true }, async ({ baseUrl, rootDir }) => {
    await assert.rejects(
      downloadVoiceModel(modelId, { registry, baseUrl, rootDir }),
      (err) => err.code === VOICE_MODEL_ERRORS.HTTP && err.status === 404
    );
  });
});

// ── progress ──

test('downloadVoiceModel: progress events are well-formed and monotonic, ending at 100%', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(20000, 7) }, { name: 'b.bin', bytes: fakeBytes(5000, 8) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    const events = [];
    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir, onProgress: (p) => events.push(p) });
    assert.ok(events.length >= 2);
    let lastPercent = -1;
    for (const e of events) {
      for (const key of ['modelId', 'file', 'fileIndex', 'fileCount', 'receivedBytes', 'totalBytes', 'percent']) {
        assert.ok(key in e, `missing ${key}`);
      }
      assert.ok(e.percent >= lastPercent, 'percent must be non-decreasing');
      lastPercent = e.percent;
      assert.ok(e.fileIndex >= 0 && e.fileIndex < e.fileCount);
    }
    assert.equal(events[events.length - 1].percent, 100);
  });
});

// ── abort ──

test('downloadVoiceModel: abort via signal rejects ABORTED, keeps the .part for a future resume', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(500000, 9) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    const controller = new AbortController();
    const p = downloadVoiceModel(modelId, {
      registry, baseUrl, rootDir, signal: controller.signal,
      onProgress: (evt) => { if (evt.receivedBytes > 1000) controller.abort(); },
    });
    await assert.rejects(p, (err) => err.code === VOICE_MODEL_ERRORS.ABORTED);
    const dir = path.join(rootDir, modelId);
    assert.equal(fs.existsSync(path.join(dir, 'a.bin')), false);
    assert.equal(fs.existsSync(path.join(dir, 'a.bin.part')), true);
  });
});

// ── resume ──

test('downloadVoiceModel: a truncated first attempt is resumed via Range on retry and ends byte-exact', async () => {
  const bytes = fakeBytes(300000, 10);
  const files = [{ name: 'a.bin', bytes }];
  const { registry, fileMap, modelId } = buildFixture({ files });

  // First attempt: server truncates the response, so the client sees a size mismatch and the
  // .part is deliberately shorter than the final file (unlike the "unlink on mismatch" path
  // above, we want to simulate a .part left behind by a network drop mid-stream, not the
  // size-check's own cleanup — so we drive this at the downloadOneFile level directly).
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    const dir = path.join(rootDir, modelId);
    await fsp.mkdir(dir, { recursive: true });
    const entry = registry[modelId].files[0];
    const url = resolveVoiceModelUrl({ baseUrl, repo: registry[modelId].repo, revision: registry[modelId].revision, file: entry.name });
    const destPath = path.join(dir, entry.name);
    const sidecarFile = destPath + '.part.json';

    // Simulate a partial prior attempt: write the first 100000 bytes as a `.part` + matching
    // sidecar, exactly what a real interrupted downloadOneFile would leave behind.
    fs.writeFileSync(destPath + '.part', bytes.subarray(0, 100000));
    fs.writeFileSync(sidecarFile, JSON.stringify({ url, sha256: entry.sha256, size: entry.size, startedAt: new Date().toISOString() }));

    const result = await manager.downloadOneFile({
      url, destPath, size: entry.size, sha256: entry.sha256, sidecarFile, allowResume: true,
      onBytes: () => {},
    });
    assert.equal(result.bytes, entry.size);
    assert.ok(fs.readFileSync(destPath).equals(bytes));
  });
});

test('downloadOneFile: server ignoring Range (answers 200) causes a clean restart, not corruption', async () => {
  const bytes = fakeBytes(50000, 11);
  const files = [{ name: 'a.bin', bytes }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap, ignoreRange: true }, async ({ baseUrl, rootDir, requests }) => {
    const dir = path.join(rootDir, modelId);
    await fsp.mkdir(dir, { recursive: true });
    const entry = registry[modelId].files[0];
    const url = resolveVoiceModelUrl({ baseUrl, repo: registry[modelId].repo, revision: registry[modelId].revision, file: entry.name });
    const destPath = path.join(dir, entry.name);
    const sidecarFile = destPath + '.part.json';
    fs.writeFileSync(destPath + '.part', bytes.subarray(0, 20000));
    fs.writeFileSync(sidecarFile, JSON.stringify({ url, sha256: entry.sha256, size: entry.size, startedAt: new Date().toISOString() }));

    const result = await manager.downloadOneFile({ url, destPath, size: entry.size, sha256: entry.sha256, sidecarFile, allowResume: true, onBytes: () => {} });
    assert.equal(result.bytes, entry.size);
    assert.ok(fs.readFileSync(destPath).equals(bytes));
    assert.ok(requests.some((r) => r.range === 'bytes=20000-'), 'client did request a range');
  });
});

test('downloadOneFile: a sidecar sha256 mismatch (stale .part from a revision bump) is not resumed', async () => {
  const bytes = fakeBytes(40000, 12);
  const files = [{ name: 'a.bin', bytes }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir, requests }) => {
    const dir = path.join(rootDir, modelId);
    await fsp.mkdir(dir, { recursive: true });
    const entry = registry[modelId].files[0];
    const url = resolveVoiceModelUrl({ baseUrl, repo: registry[modelId].repo, revision: registry[modelId].revision, file: entry.name });
    const destPath = path.join(dir, entry.name);
    const sidecarFile = destPath + '.part.json';
    fs.writeFileSync(destPath + '.part', fakeBytes(10000, 999)); // unrelated bytes
    fs.writeFileSync(sidecarFile, JSON.stringify({ url, sha256: 'f'.repeat(64), size: entry.size, startedAt: new Date().toISOString() }));

    const result = await manager.downloadOneFile({ url, destPath, size: entry.size, sha256: entry.sha256, sidecarFile, allowResume: true, onBytes: () => {} });
    assert.equal(result.bytes, entry.size);
    assert.ok(fs.readFileSync(destPath).equals(bytes));
    assert.ok(requests.every((r) => r.range == null), 'no Range header sent — restarted clean');
  });
});

// ── partial state / status ──

test('getVoiceModelStatus: partial when only some files are present, missing when none, ready after full download', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(1000, 13) }, { name: 'b.bin', bytes: fakeBytes(1000, 14) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    let status = await getVoiceModelStatus(modelId, { registry, rootDir });
    assert.equal(status.state, 'missing');

    const dir = voiceModelDir(modelId, { registry, rootDir });
    await fsp.mkdir(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.bin'), files[0].bytes);
    status = await getVoiceModelStatus(modelId, { registry, rootDir });
    assert.equal(status.state, 'partial');

    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    status = await getVoiceModelStatus(modelId, { registry, rootDir });
    assert.equal(status.state, 'ready');
  });
});

test('getVoiceModelStatus: stale when the on-disk marker revision no longer matches the registry', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(1000, 15) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    const dir = voiceModelDir(modelId, { registry, rootDir });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete.json'), 'utf8'));
    marker.revision = 'stale-revision';
    fs.writeFileSync(path.join(dir, '.complete.json'), JSON.stringify(marker));

    const status = await getVoiceModelStatus(modelId, { registry, rootDir });
    assert.equal(status.state, 'stale');
  });
});

test('listVoiceModels: returns one status entry per registry id', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(1000, 16) }];
  const { registry, modelId } = buildFixture({ files });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    const { models } = await listVoiceModels({ registry, rootDir });
    assert.equal(models.length, 1);
    assert.equal(models[0].modelId, modelId);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── concurrency ──

test('downloadVoiceModel: two concurrent calls for the same model share one in-flight download', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(80000, 17) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir, requests }) => {
    const [a, b] = await Promise.all([
      downloadVoiceModel(modelId, { registry, baseUrl, rootDir }),
      downloadVoiceModel(modelId, { registry, baseUrl, rootDir }),
    ]);
    assert.equal(a.skipped, false);
    assert.equal(b.skipped, false);
    assert.equal(requests.filter((r) => r.path.includes('a.bin')).length, 1, 'file requested exactly once, not twice');
  });
});

test('abortVoiceModelDownload: aborts an in-flight download by modelId', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(500000, 18) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  // dripDelayMs holds the response open past the first half, guaranteeing the download is
  // still in flight when we call abort — a fixed setTimeout race against a same-machine
  // loopback transfer is flaky (the transfer can simply finish first).
  await withFakeHub({ fileMap, dripDelayMs: 200 }, async ({ baseUrl, rootDir }) => {
    const p = downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const aborted = abortVoiceModelDownload(modelId, { registry, rootDir });
    assert.equal(aborted, true);
    await assert.rejects(p, (err) => err.code === VOICE_MODEL_ERRORS.ABORTED);
  });
});

// ── delete (C1197) ──

test('deleteVoiceModel: removes a fully downloaded model, listVoiceModels reports missing after', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(4000, 20) }, { name: 'b.bin', bytes: fakeBytes(1000, 21) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap }, async ({ baseUrl, rootDir }) => {
    await downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    const dir = path.join(rootDir, modelId);
    assert.equal(fs.existsSync(dir), true);

    const result = await deleteVoiceModel(modelId, { registry, rootDir });
    assert.equal(result.deleted, true);
    assert.ok(result.freedBytes >= 5000, 'freedBytes should cover both files');
    assert.equal(fs.existsSync(dir), false);

    const { models } = await listVoiceModels({ registry, rootDir });
    assert.equal(models.find((m) => m.modelId === modelId).state, 'missing');
  });
});

test('deleteVoiceModel: unknown modelId rejects VOICE_MODEL_UNKNOWN, nothing touched', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    await assert.rejects(
      deleteVoiceModel('nope', { registry: VOICE_MODEL_REGISTRY, rootDir }),
      (err) => err.code === VOICE_MODEL_ERRORS.UNKNOWN
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('deleteVoiceModel: never-downloaded model resolves deleted:false, freedBytes:0 — idempotent', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(1000, 22) }];
  const { registry, modelId } = buildFixture({ files });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-'));
  try {
    const result = await deleteVoiceModel(modelId, { registry, rootDir });
    assert.equal(result.deleted, false);
    assert.equal(result.freedBytes, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('deleteVoiceModel: rejects VOICE_MODEL_LOCKED while a download is in flight, download still completes', async () => {
  const files = [{ name: 'a.bin', bytes: fakeBytes(500000, 23) }];
  const { registry, fileMap, modelId } = buildFixture({ files });
  await withFakeHub({ fileMap, dripDelayMs: 200 }, async ({ baseUrl, rootDir }) => {
    const dl = downloadVoiceModel(modelId, { registry, baseUrl, rootDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      deleteVoiceModel(modelId, { registry, rootDir }),
      (err) => err.code === VOICE_MODEL_ERRORS.LOCKED
    );
    const result = await dl;
    assert.equal(result.skipped, false);
    const dir = path.join(rootDir, modelId);
    assert.ok(fs.readFileSync(path.join(dir, 'a.bin')).equals(files[0].bytes));
  });
});

// ── path resolution ──

test('voiceModelsRoot: composes userDataRoot/vendor/voice-models', () => {
  const got = voiceModelsRoot({ userDataRoot: '/tmp/fake-userdata' });
  assert.equal(got, path.join('/tmp/fake-userdata', 'vendor', 'voice-models'));
});

test('voiceModelsRoot: defaults to config.USER_DATA_ROOT/vendor/voice-models', () => {
  const config = require('./config');
  const got = voiceModelsRoot();
  assert.equal(got, path.join(config.USER_DATA_ROOT, 'vendor', 'voice-models'));
});

test('resolveVoiceModelUrl: builds the huggingface resolve URL', () => {
  const url = resolveVoiceModelUrl({ baseUrl: 'https://huggingface.co', repo: 'org/repo', revision: 'deadbeef', file: 'x.onnx' });
  assert.equal(url, 'https://huggingface.co/org/repo/resolve/deadbeef/x.onnx');
});

// ── real registry integrity — no network, no fs ──

test('VOICE_MODEL_IDS: exactly the three supported models', () => {
  assert.deepEqual([...VOICE_MODEL_IDS].sort(), ['parakeet-v2', 'parakeet-v3', 'whisper-base']);
});

test('VOICE_MODEL_REGISTRY: every entry has a valid repo/revision, every file has size+sha256', () => {
  const seenHashes = new Set();
  for (const id of VOICE_MODEL_IDS) {
    const entry = VOICE_MODEL_REGISTRY[id];
    assert.equal(entry.id, id);
    assert.match(entry.repo, /^[\w.-]+\/[\w.-]+$/, `${id} repo shape`);
    assert.match(entry.revision, /^[0-9a-f]{40}$/, `${id} revision must be a full commit SHA, not a branch name`);
    assert.ok(entry.files.length >= 1, `${id} must have at least one file`);
    for (const f of entry.files) {
      assert.ok(f.name && typeof f.name === 'string', `${id} file name`);
      assert.ok(Number.isInteger(f.size) && f.size > 0, `${id}/${f.name} size`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${id}/${f.name} sha256 shape`);
      assert.ok(!seenHashes.has(f.sha256), `${id}/${f.name} sha256 collides with another file — copy-paste bug`);
      seenHashes.add(f.sha256);
    }
  }
});

test('VOICE_MODEL_REGISTRY: parakeet entries carry encoder/decoder/joiner/tokens, whisper carries encoder/decoder/tokens', () => {
  const roles = (id) => VOICE_MODEL_REGISTRY[id].files.map((f) => f.role).sort();
  assert.deepEqual(roles('parakeet-v2'), ['decoder', 'encoder', 'joiner', 'tokens']);
  assert.deepEqual(roles('parakeet-v3'), ['decoder', 'encoder', 'joiner', 'tokens']);
  assert.deepEqual(roles('whisper-base'), ['decoder', 'encoder', 'tokens']);
});

test('VOICE_MODEL_REGISTRY: resolveVoiceModelUrl produces the exact live URL for every real file', () => {
  for (const id of VOICE_MODEL_IDS) {
    const entry = VOICE_MODEL_REGISTRY[id];
    for (const f of entry.files) {
      const url = resolveVoiceModelUrl({ repo: entry.repo, revision: entry.revision, file: f.name });
      assert.equal(url, `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${f.name}`);
    }
  }
});
