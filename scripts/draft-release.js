#!/usr/bin/env node
'use strict';

/*
 * Draft release step of .github/workflows/build.yml (job `release`, "Draft release").
 *
 * Makes ONE draft GitHub Release of a tag hold every file of a directory (the installers of
 * all build legs plus SHA256SUMS), and can be repeated until it does:
 *
 *   - Release. A draft that already exists for the tag is reused, never joined by a second one.
 *     Only when there is none is one created. A 5xx answer to the create request does not say
 *     whether GitHub created the release, so after a failed attempt the script waits, looks for
 *     a draft again and only then posts again. A PUBLISHED release of the tag is never touched:
 *     the run fails instead.
 *   - Assets, one file at a time. An asset that is already uploaded with the file's size and
 *     SHA-256 is kept. Anything else under that name is deleted first: an asset with other
 *     content, or the `starter` record a failed upload leaves behind. Then the file is
 *     uploaded. An upload refused because the name is taken (HTTP 422 already_exists) is
 *     handled the same way on the next attempt: list, delete, upload.
 *   - Retries. Listing, creating, updating, deleting and uploading are each retried with a
 *     growing pause on network errors, HTTP 5xx, 408, 429 and rate-limit 403. Every failure is
 *     reported with its HTTP status and GitHub's message, also when the answer had no body.
 *   - Result. The run is green only when every file is an uploaded asset of that one draft.
 *     Other drafts of the same tag are reported as a warning and left alone.
 *
 * Only `node:` built-ins are used, so the job runs it with the runner's preinstalled Node
 * (18 or newer), without setup-node or `npm ci`: nothing else has to download while GitHub
 * is degraded.
 *
 * Usage:
 *   node scripts/draft-release.js --tag v1.2.3 --notes notes.md --dir installers [--dry-run]
 * Environment: GITHUB_TOKEN (or GH_TOKEN) with contents:write, GITHUB_REPOSITORY (owner/name),
 * optional GITHUB_API_URL; --repo and --api-url override the last two. --dry-run only reads
 * and prints what a real run would do.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const API_VERSION = '2022-11-28';
const USER_AGENT = 'tipatask-draft-release';
const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Pauses before attempts 2..6 of one operation: about four minutes in all.
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000];
const MAX_RETRY_PAUSE_MS = 5 * 60 * 1000;
// Idle limits, not totals: a large upload may take long as long as bytes keep moving.
const API_IDLE_TIMEOUT_MS = 60 * 1000;
const UPLOAD_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// The media types earlier releases carry (what the `mime-types` table gives these extensions).
const CONTENT_TYPES = {
  '.deb': 'application/x-debian-package',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/x-msdos-program',
};

class UsageError extends Error {}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function oneLine(text, max = 300) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function requestTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url);
  }
}

// GitHub's own words for a failed request, never an empty string: a 5xx often has no body at all.
function githubDetail(data, text) {
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) {
    const errors = Array.isArray(data.errors)
      ? data.errors.map((e) => (e && (e.code || e.message)) || JSON.stringify(e)).filter(Boolean)
      : [];
    return errors.length ? `${data.message} (${errors.join(', ')})` : data.message;
  }
  return oneLine(text || '') || '(empty response body)';
}

class HttpError extends Error {
  constructor({ method, url, status, headers, text }) {
    const data = parseJson(text);
    const requestId = headers && headers['x-github-request-id'];
    super(`${method} ${requestTarget(url)} answered HTTP ${status}: ${githubDetail(data, text)}`
      + `${requestId ? ` (request ${requestId})` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers || {};
    this.data = data;
  }
}

function networkError(method, url, cause) {
  const reason = (cause && (cause.message || cause.code)) || 'connection failed';
  const error = new Error(`${method} ${requestTarget(url)} failed: ${reason}`);
  error.network = true;
  error.code = cause && cause.code;
  return error;
}

function describe(error) {
  return (error && error.message) || String(error || 'unknown error');
}

// The error a step gives up with. `transient` = the cause was a passing condition (a 5xx, a
// dropped connection, a name still blocked), so running the job again can succeed.
function failure(message, cause) {
  const error = new Error(message);
  error.transient = isRetryable(cause) || hasErrorCode(cause, 'already_exists');
  return error;
}

function hasErrorCode(error, code) {
  const errors = error && error.data && error.data.errors;
  return Array.isArray(errors) && errors.some((e) => e && e.code === code);
}

function rateLimited(error) {
  const headers = (error && error.headers) || {};
  return headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0';
}

function isRetryable(error) {
  if (!error) return false;
  if (error.network) return true;
  const status = error.status;
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  return status === 403 && rateLimited(error);
}

// The pause before the next attempt: the schedule's, or longer when GitHub names one.
function retryPause(error, scheduledMs, now = Date.now()) {
  const headers = (error && error.headers) || {};
  let pause = scheduledMs;
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    pause = Math.max(pause, retryAfter * 1000);
  } else if (headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(headers['x-ratelimit-reset']) * 1000;
    if (Number.isFinite(reset) && reset > now) pause = Math.max(pause, reset - now);
  }
  return Math.min(pause, MAX_RETRY_PAUSE_MS);
}

function seconds(ms) {
  return Math.max(1, Math.round(ms / 1000));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

// One HTTP exchange. Resolves with any status; rejects only when no complete answer arrived.
// A file body is streamed from disk with its Content-Length, never read into memory.
function httpRequest({ method = 'GET', url, headers = {}, body = null, filePath = null, fileSize = 0, idleTimeoutMs = API_IDLE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const requestHeaders = { ...headers };
    let payload = null;
    if (filePath) {
      requestHeaders['content-length'] = String(fileSize);
    } else if (body !== null && body !== undefined) {
      payload = Buffer.from(body);
      requestHeaders['content-length'] = String(payload.length);
    }

    let source = null;
    let settled = false;
    let answering = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      if (source) source.destroy();
      finish(value);
    };

    // agent:false = one connection per request, closed afterwards: nothing keeps the process
    // alive at the end and a connection that failed is never reused.
    const request = transport.request(target, { method, headers: requestHeaders, agent: false }, (response) => {
      answering = true;
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      response.on('end', () => {
        settle(resolve, { status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') });
        // An answer that came before the whole body was sent (an early error): stop sending.
        if (!request.writableFinished) request.destroy();
      });
      response.on('error', (error) => settle(reject, error));
      response.on('close', () => {
        if (!response.complete) settle(reject, new Error('the connection closed before the answer was complete'));
      });
    });

    request.setTimeout(idleTimeoutMs, () => {
      request.destroy(Object.assign(new Error(`no data moved for ${seconds(idleTimeoutMs)}s`), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => {
      // While an answer is being read, a write error (EPIPE on an early answer) is not the result.
      if (!answering) settle(reject, error);
    });

    if (filePath) {
      source = fs.createReadStream(filePath);
      source.on('error', (error) => {
        request.destroy(error);
        settle(reject, error);
      });
      source.pipe(request);
    } else {
      request.end(payload || undefined);
    }
  });
}

/*
 * The name GitHub stores an uploaded asset under. It rewrites file names: diacritics are
 * dropped and every run of characters outside [A-Za-z0-9-_+@] becomes one dot, so
 * "TipATask Setup 1.2.3.exe" is stored as "TipATask.Setup.1.2.3.exe". Same rule as the GitHub
 * CLI's sanitizeFileName(), which mirrors the platform for `gh release upload --clobber`.
 */
function githubAssetName(name) {
  const original = String(name);
  let value = original.normalize('NFD').replace(/\p{Mn}+/gu, '').normalize('NFC');
  if (value.startsWith('.')) value = `default${value}`;
  value = value.replace(/[^a-z0-9\-_+@]+/gi, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  if (value !== original && !value.includes('.')) value = `default.${value}`;
  return value;
}

function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Every regular, non-hidden file of `dir` (what the glob `dir/*` gives), sorted by name.
async function collectFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read the installers directory ${dir}: ${error.message}`);
  }
  const names = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  if (!names.length) throw new Error(`no files to publish in ${dir}`);
  const files = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const size = fs.statSync(filePath).size;
    if (size === 0) throw new Error(`${name} is empty: GitHub does not accept an empty release asset`);
    files.push({
      name,
      path: filePath,
      size,
      assetName: githubAssetName(name),
      contentType: contentTypeFor(name),
      digest: `sha256:${await sha256File(filePath)}`,
    });
  }
  const seen = new Map();
  for (const file of files) {
    if (seen.has(file.assetName)) {
      throw new Error(`${seen.get(file.assetName)} and ${file.name} would both be stored as ${file.assetName}`);
    }
    seen.set(file.assetName, file.name);
  }
  return files;
}

// An asset is the file's when it carries the file's name, GitHub's rewritten form of it, or the
// file's name as its label (set at upload whenever GitHub rewrites the name).
function assetMatches(asset, file) {
  return Boolean(asset) && (asset.name === file.name || asset.name === file.assetName || asset.label === file.name);
}

// Why a stored asset is not the file, or null when it is. GitHub reports the SHA-256 it computed
// as `digest`; an answer without one is judged by state and size.
function assetProblem(asset, file) {
  if (!asset || typeof asset !== 'object') return 'no asset in the answer';
  if (asset.state !== 'uploaded') return `state ${asset.state}`;
  if (asset.size !== file.size) return `${asset.size} bytes stored, the file has ${file.size}`;
  if (asset.digest && asset.digest !== file.digest) return `stored with ${asset.digest}, the file has ${file.digest}`;
  return null;
}

// Proof that nothing has to be uploaded: uploaded, same size AND the same SHA-256.
function isIdentical(asset, file) {
  return asset.state === 'uploaded' && asset.size === file.size && asset.digest === file.digest;
}

// Why an asset of the file's name cannot stay.
function staleReason(asset, file) {
  if (asset.state !== 'uploaded') return `partial upload, state ${asset.state}`;
  if (asset.size !== file.size || (asset.digest && asset.digest !== file.digest)) return 'other content';
  return 'no SHA-256 reported to compare';
}

function assetUploadUrl(release, file) {
  const template = String((release && release.upload_url) || '');
  const cut = template.indexOf('{');
  let url;
  try {
    url = new URL(cut === -1 ? template : template.slice(0, cut));
  } catch {
    throw new Error(`release ${release && release.id} has no usable upload_url`);
  }
  url.searchParams.set('name', file.name);
  // Keep the real file name visible on the release page when GitHub stores another one.
  if (file.assetName !== file.name) url.searchParams.set('label', file.name);
  return url.toString();
}

function sameText(a, b) {
  const normal = (text) => String(text || '').replace(/\r\n/g, '\n').trimEnd();
  return normal(a) === normal(b);
}

function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// Plain lines for the log; notice/warning/error become annotations on the workflow run.
function createReporter(write = (line) => console.log(line)) {
  const annotate = (level) => (title, message) => write(`::${level} title=${escapeProperty(title)}::${escapeData(message)}`);
  return { info: (message) => write(message), notice: annotate('notice'), warning: annotate('warning'), error: annotate('error') };
}

function createGithub({ token, repo, apiUrl = 'https://api.github.com', request = httpRequest, sleep = wait, retryDelays = RETRY_DELAYS_MS, report = createReporter() }) {
  const base = `${String(apiUrl).replace(/\/+$/, '')}/repos/${repo}`;
  const baseHeaders = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  };

  // One request, no retry. Throws HttpError for a non-2xx answer and a retryable network error
  // when no usable answer arrived.
  async function once(method, url, { json, file } = {}) {
    const headers = { ...baseHeaders };
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (file) headers['content-type'] = file.contentType;
    let answer;
    try {
      answer = await request({
        method,
        url,
        headers,
        body: json !== undefined ? JSON.stringify(json) : null,
        filePath: file ? file.path : null,
        fileSize: file ? file.size : 0,
        idleTimeoutMs: file ? UPLOAD_IDLE_TIMEOUT_MS : API_IDLE_TIMEOUT_MS,
      });
    } catch (error) {
      throw networkError(method, url, error);
    }
    if (answer.status < 200 || answer.status > 299) throw new HttpError({ method, url, ...answer });
    if (answer.status === 204 || !answer.text) return null;
    const data = parseJson(answer.text);
    if (data === undefined) throw networkError(method, url, new Error(`HTTP ${answer.status} with a body that is not JSON`));
    return data;
  }

  // For requests that are safe to repeat as they are (reads, PATCH, DELETE).
  async function retrying(what, attemptOnce) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await attemptOnce();
      } catch (error) {
        if (!isRetryable(error) || attempt >= retryDelays.length) throw error;
        const pause = retryPause(error, retryDelays[attempt]);
        report.info(`retry: ${what} failed: ${describe(error)}. Trying again in ${seconds(pause)}s (${retryDelays.length - attempt} attempts left).`);
        await sleep(pause);
      }
    }
  }

  async function paged(url, what) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const items = await retrying(what, () => once('GET', `${url}?per_page=${PER_PAGE}&page=${page}`));
      if (!Array.isArray(items)) throw new Error(`${what}: GitHub answered with something that is not a list`);
      all.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return all;
  }

  return {
    // Drafts included (the token needs push access to see them), each with its uploaded assets.
    listReleases: () => paged(`${base}/releases`, 'listing the releases'),
    // Not retried here: the caller looks for a draft the failed request left before posting again.
    createRelease: (fields) => once('POST', `${base}/releases`, { json: fields }),
    updateRelease: (id, fields) => retrying(`updating release ${id}`, () => once('PATCH', `${base}/releases/${id}`, { json: fields })),
    // Unlike the `assets` array inside a release, this list includes partial (`starter`) uploads.
    listAssets: (id) => paged(`${base}/releases/${id}/assets`, `listing the assets of release ${id}`),
    deleteAsset: (assetId) => retrying(`deleting asset ${assetId}`, async () => {
      try {
        await once('DELETE', `${base}/releases/assets/${assetId}`);
      } catch (error) {
        if (error.status !== 404) throw error; // already gone
      }
    }),
    // Not retried here: the caller clears what a failed upload left before sending again.
    uploadAsset: (release, file) => once('POST', assetUploadUrl(release, file), { file }),
  };
}

function uploadedCount(release) {
  return Array.isArray(release.assets) ? release.assets.filter((asset) => asset && asset.state === 'uploaded').length : 0;
}

// Of several drafts of one tag: the one holding the most uploaded assets, the oldest on a tie,
// so every run and re-run settles on the same draft and re-uploads as little as possible.
function pickDraft(drafts) {
  return [...drafts].sort((a, b) => uploadedCount(b) - uploadedCount(a) || a.id - b.id)[0];
}

async function findReleases(ctx) {
  const mine = (await ctx.github.listReleases()).filter((release) => release && release.tag_name === ctx.tag);
  return { drafts: mine.filter((release) => release.draft === true), published: mine.filter((release) => release.draft !== true) };
}

function describeRelease(release) {
  return `${release.id}${release.html_url ? ` (${release.html_url})` : ''}`;
}

async function ensureDraft(ctx) {
  const { github, tag, body, dryRun, retryDelays, sleep, report } = ctx;
  for (let attempt = 0; ; attempt += 1) {
    const { drafts, published } = await findReleases(ctx);
    if (published.length) {
      throw new Error(`release ${tag} is already published: ${published.map(describeRelease).join(', ')}. `
        + 'This job fills drafts only and never changes a published release; ship a fix as the next version.'
        + (drafts.length ? ` Leftover draft(s) of the same tag: ${drafts.map((draft) => draft.id).join(', ')}.` : ''));
    }
    if (drafts.length) {
      const release = pickDraft(drafts);
      report.info(attempt === 0
        ? `Reusing draft release ${release.id} of ${tag} (${uploadedCount(release)} uploaded asset(s)).`
        : `A failed create request did create draft release ${release.id} of ${tag}; using it.`);
      return { release, created: false };
    }
    if (dryRun) {
      report.info(`Would create a draft release for ${tag}.`);
      return { release: null, created: false };
    }
    try {
      report.info(`Creating a draft release for ${tag}...`);
      const release = await github.createRelease({ tag_name: tag, name: tag, body, draft: true });
      if (!release || !release.id) throw networkError('POST', '/releases', new Error('the answer names no release'));
      report.info(`Created draft release ${release.id} of ${tag}.`);
      return { release, created: true };
    } catch (error) {
      // already_exists: another run created the release meanwhile; the next look finds it.
      const again = attempt < retryDelays.length && (isRetryable(error) || hasErrorCode(error, 'already_exists'));
      if (!again) throw failure(`creating the draft release of ${tag} failed after ${attempt + 1} attempt(s): ${describe(error)}`, error);
      const pause = retryPause(error, retryDelays[attempt]);
      report.info(`retry: creating the draft release failed: ${describe(error)}. Looking for a draft again in ${seconds(pause)}s `
        + `(${retryDelays.length - attempt} attempts left).`);
      await sleep(pause);
    }
  }
}

async function ensureAsset(ctx, release, file) {
  const { github, dryRun, retryDelays, sleep, report } = ctx;
  let uploads = 0;
  let replaced = false;
  for (let attempt = 0; ; attempt += 1) {
    const sameName = (await github.listAssets(release.id)).filter((asset) => assetMatches(asset, file));
    const identical = sameName.find((asset) => isIdentical(asset, file));
    if (identical) {
      const action = uploads === 0 ? 'kept' : replaced ? 'replaced' : 'uploaded';
      report.info(uploads === 0
        ? `  kept      ${file.name} (already uploaded, same SHA-256)`
        : `  ${action.padEnd(9)} ${file.name} (stored by GitHub although the upload request failed)`);
      return { name: file.name, assetName: identical.name, size: file.size, action, uploads };
    }
    if (dryRun) {
      const action = sameName.length ? 'would-replace' : 'would-upload';
      const why = sameName.map((asset) => `asset ${asset.id}: ${staleReason(asset, file)}`).join('; ');
      report.info(`  ${action.padEnd(13)} ${file.name} (${formatBytes(file.size)})${why ? ` — ${why}` : ''}`);
      return { name: file.name, assetName: file.assetName, size: file.size, action, uploads };
    }
    for (const stale of sameName) {
      report.info(`  deleting  ${stale.name} (asset ${stale.id}: ${staleReason(stale, file)})`);
      await github.deleteAsset(stale.id);
      if (stale.state === 'uploaded' && uploads === 0) replaced = true;
    }
    uploads += 1;
    try {
      report.info(`  uploading ${file.name} (${formatBytes(file.size)})...`);
      const asset = await github.uploadAsset(release, file);
      const problem = assetProblem(asset, file);
      if (problem) throw networkError('POST', assetUploadUrl(release, file), new Error(`GitHub stored the upload wrongly (${problem})`));
      const action = replaced ? 'replaced' : 'uploaded';
      report.info(`  ${action.padEnd(9)} ${file.name}`);
      return { name: file.name, assetName: asset.name, size: file.size, action, uploads };
    } catch (error) {
      // already_exists: a record of the same name is in the way (one the listing did not show
      // yet); the next round lists again and deletes it.
      const again = attempt < retryDelays.length && (isRetryable(error) || hasErrorCode(error, 'already_exists'));
      if (!again) throw failure(`${file.name}: the upload failed after ${uploads} attempt(s): ${describe(error)}`, error);
      const pause = retryPause(error, retryDelays[attempt]);
      report.info(`retry: uploading ${file.name} failed: ${describe(error)}. Trying again in ${seconds(pause)}s `
        + `(${retryDelays.length - attempt} attempts left).`);
      await sleep(pause);
    }
  }
}

/*
 * Creates or completes the draft release of `tag` from `files` (see the header). Resolves with
 * { tag, dryRun, release, created, bodyUpdated, assets, extras, duplicates }; rejects with an
 * Error whose message says what failed. `release` is null only in a dry run without a draft.
 */
async function draftRelease({ github, tag, body, files, dryRun = false, sleep = wait, retryDelays = RETRY_DELAYS_MS, report = createReporter() }) {
  const ctx = { github, tag, body, files, dryRun, sleep, retryDelays, report };
  const draft = await ensureDraft(ctx);
  const result = { tag, dryRun, release: draft.release, created: draft.created, bodyUpdated: false, assets: [], extras: [], duplicates: [] };
  if (!draft.release) {
    for (const file of files) {
      report.info(`  would-upload  ${file.name} (${formatBytes(file.size)})`);
      result.assets.push({ name: file.name, assetName: file.assetName, size: file.size, action: 'would-upload', uploads: 0 });
    }
    return result;
  }

  if (!draft.created && !sameText(draft.release.body, body)) {
    if (dryRun) {
      report.info('Would rewrite the draft body from the notes file.');
    } else {
      await github.updateRelease(draft.release.id, { body });
      report.info('Rewrote the draft body from the notes file.');
    }
    result.bodyUpdated = true;
  }

  for (const file of files) result.assets.push(await ensureAsset(ctx, draft.release, file));

  // Each file is proven above (kept after a matching listing, or stored with a matching answer).
  // The two reads below only report leftovers, so their failure never fails a complete release.
  try {
    const assets = await github.listAssets(draft.release.id);
    result.extras = assets.filter((asset) => !files.some((file) => assetMatches(asset, file)))
      .map((asset) => ({ id: asset.id, name: asset.name, state: asset.state }));
  } catch (error) {
    report.info(`note: could not list the release assets once more: ${describe(error)}`);
  }
  try {
    const { drafts } = await findReleases(ctx);
    result.duplicates = drafts.filter((other) => other.id !== draft.release.id)
      .map((other) => ({ id: other.id, html_url: other.html_url, assets: uploadedCount(other) }));
  } catch (error) {
    report.info(`note: could not look for other drafts of ${tag}: ${describe(error)}`);
  }
  return result;
}

function parseArgs(argv) {
  const options = { dryRun: false, help: false };
  const valued = { '--tag': 'tag', '--notes': 'notes', '--dir': 'dir', '--repo': 'repo', '--api-url': 'apiUrl' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (valued[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new UsageError(`${arg} needs a value`);
      options[valued[arg]] = value;
      i += 1;
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }
  return options;
}

const USAGE = 'Usage: node scripts/draft-release.js --tag <tag> --notes <file> --dir <directory> [--repo owner/name] [--api-url URL] [--dry-run]\n'
  + 'Environment: GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY, GITHUB_API_URL.';

function summaryMarkdown(result, repo) {
  const lines = [
    `### Draft release ${result.tag}`,
    '',
    result.release ? `Release ${result.release.id} of \`${repo}\`: ${result.release.html_url || '(no URL in the answer)'}` : 'No draft release exists yet.',
    '',
    '| File | Size | Result |',
    '|---|---|---|',
    ...result.assets.map((asset) => `| \`${asset.name}\` | ${formatBytes(asset.size)} | ${asset.action} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function reportLeftovers(result, repo, report) {
  if (result.duplicates.length) {
    report.warning('Duplicate draft releases', `${result.tag} has ${result.duplicates.length} more draft release(s) besides ${result.release.id}: `
      + `${result.duplicates.map((d) => `${d.id} (${d.assets} uploaded asset(s))`).join(', ')}. This job keeps using ${result.release.id}. `
      + `Delete the others, each with: gh api -X DELETE repos/${repo}/releases/<id>`);
  }
  if (result.extras.length) {
    report.warning('Unexpected release assets', `draft release ${result.release.id} also holds asset(s) that are not among the files of this run: `
      + `${result.extras.map((e) => `${e.name} (asset ${e.id}, state ${e.state})`).join(', ')}. They were left alone.`);
  }
}

async function main(argv, env, write = (line) => console.log(line)) {
  const report = createReporter(write);
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      write(USAGE);
      return 0;
    }
    for (const [flag, key] of [['--tag', 'tag'], ['--notes', 'notes'], ['--dir', 'dir']]) {
      if (!options[key]) throw new UsageError(`${flag} is required`);
    }
    options.repo = options.repo || env.GITHUB_REPOSITORY;
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo || '')) throw new UsageError('set GITHUB_REPOSITORY or pass --repo owner/name');
    options.token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!options.token) throw new UsageError('set GITHUB_TOKEN (or GH_TOKEN) to a token with contents:write on the repository');
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    write(`draft-release: ${error.message}`);
    write(USAGE);
    return 2;
  }

  try {
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(`Node 18 or newer is required, this is ${process.version}`);
    let body;
    try {
      body = fs.readFileSync(options.notes, 'utf8');
    } catch (error) {
      throw new Error(`cannot read the release notes ${options.notes}: ${error.message}`);
    }
    if (!body.trim()) throw new Error(`the release notes ${options.notes} are empty`);
    const files = await collectFiles(options.dir);
    report.info(`${options.dryRun ? 'Dry run: ' : ''}${options.tag} in ${options.repo}: ${files.length} file(s), `
      + `${formatBytes(files.reduce((sum, file) => sum + file.size, 0))} (Node ${process.version}).`);

    const github = createGithub({ token: options.token, repo: options.repo, apiUrl: options.apiUrl || env.GITHUB_API_URL || 'https://api.github.com', report });
    const result = await draftRelease({ github, tag: options.tag, body, files, dryRun: options.dryRun, report });

    if (result.release) reportLeftovers(result, options.repo, report);
    if (options.dryRun) {
      report.info('Dry run: nothing was changed.');
      return 0;
    }
    const url = result.release.html_url || '';
    report.notice('Draft release', `Draft release ${result.release.id} of ${options.tag} holds all ${files.length} files${url ? `: ${url}` : ''}`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `release_id=${result.release.id}\nrelease_url=${url}\n`);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(result, options.repo));
    return 0;
  } catch (error) {
    const transient = Boolean(error && error.transient) || isRetryable(error);
    report.error('Draft release failed', `${describe(error)}${transient ? ' — Re-run this job: it continues with the same draft release and uploads only what is missing.' : ''}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  RETRY_DELAYS_MS,
  HttpError,
  assetMatches,
  assetProblem,
  assetUploadUrl,
  collectFiles,
  contentTypeFor,
  createGithub,
  createReporter,
  draftRelease,
  githubAssetName,
  httpRequest,
  isRetryable,
  main,
  parseArgs,
  pickDraft,
  retryPause,
};
