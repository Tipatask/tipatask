'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { getApiCredentials } = require('../api-credentials');
const { resolveAttachmentDir } = require('../attachment-paths');
const { isTaskKeyLike } = require('../task-key-format');
const { getApiOrigin, resolveInternalAttachmentUrl } = require('./attachment-url');

const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const DATA_IMAGE_URI_RE = /^data:(image\/(?:jpeg|png|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

// C1012: real task_keys are always uppercase — a project's own prefix + digits (e.g.
// 'TPT214'), the legacy 'C'/'H' + digits, or an uppercase project-name-derived epic
// prefix ("TIP-3"). Non-task session ids passed as taskId (objective chat
// "obj-<timestamp>", spec chat "specChat:C123") are lowercase or colon-containing and
// never match, so the images-by-task listing below is only ever fetched for a real
// task. (C1483: was a bespoke REAL_TASK_KEY_RE capped at 4-char prefixes, 2 short of
// the TASK_KEY_RE contract's 6 — replaced with the shared isTaskKeyLike().)
const MAX_LISTED_IMAGES = 10;

function extractImageRefs(text) {
  if (!text) return [];
  const refs = [];
  IMAGE_REF_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_REF_RE.exec(text)) !== null) {
    refs.push({ full: m[0], alt: m[1], url: m[2], start: m.index, end: m.index + m[0].length });
  }
  return refs;
}

function parseDataImageUri(url) {
  const match = DATA_IMAGE_URI_RE.exec(url || '');
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw new Error('Empty image data');
  if (buf.length > MAX_INLINE_IMAGE_BYTES) throw new Error('Image too large (>10 MB)');
  return { mimeType, data: match[2], buf, ext: MIME_EXT[mimeType] };
}

function isDataImageUri(url) {
  return /^data:image\//i.test(url || '');
}

function saveDataImage(url, dir) {
  const parsed = parseDataImageUri(url);
  if (!parsed) throw new Error('Unsupported or malformed image data URI');
  const localPath = path.join(dir, `${crypto.randomUUID()}${parsed.ext}`);
  fs.writeFileSync(localPath, parsed.buf);
  return localPath;
}

function isInternalImageUrl(url, apiBaseUrl, projectId) {
  if (!url) return false;
  if (!apiBaseUrl) return /^\/api\/projects\/\d+\/images\/\d+$/.test(url);
  return !!resolveInternalAttachmentUrl(url, { baseUrl: apiBaseUrl, projectId }, 'images');
}

// Strips a known apiBaseUrl prefix so an absolute markdown ref and a relative
// listed url pointing at the same image compare equal for dedup.
function canonicalInternalPath(url, apiBaseUrl, projectId) {
  return resolveInternalAttachmentUrl(url, { baseUrl: apiBaseUrl, projectId }, 'images')?.path || url;
}

async function fetchAndSave(url, dir, { baseUrl, token, projectId }) {
  const attachment = resolveInternalAttachmentUrl(url, { baseUrl, projectId }, 'images');
  if (!attachment) throw new Error('Rejected image attachment URL');
  const requestUrl = attachment.href;
  const res = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`GET ${requestUrl} returned ${res.status}`);
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = MIME_EXT[contentType];
  if (!ext) {
    throw new Error(`Unsupported image MIME type: ${contentType}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = `${crypto.randomUUID()}${ext}`;
  const localPath = path.join(dir, filename);
  fs.writeFileSync(localPath, buf);
  return localPath;
}

// Images linked via task_images.task_key (C1012) — attached to the task but never
// inlined as markdown, so extractImageRefs() alone would miss them (this was the
// root complaint: an agent reporting it never saw an image that was only a DB
// attachment). Hits the API route directly rather than going through
// backend.listTaskImages() — this module only ever resolves per-call credentials
// via getApiCredentials(projectRoot), not a backend instance, and reaching for the
// api-backend singleton here would reintroduce the exact C1013 bug (that singleton
// live-reads the *global* config.PROJECT_ROOT, not this call's bound project).
// Never throws — a missing/old-API listing must not block markdown-ref localization.
async function fetchTaskImageUrls(taskId, { baseUrl, token, projectId }) {
  if (!isTaskKeyLike(taskId)) return [];
  try {
    const requestUrl = `${getApiOrigin(baseUrl)}/api/projects/${projectId}/images/task/${encodeURIComponent(taskId)}`;
    const res = await fetch(requestUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // 404 = API server predates this route (C1012) — not an error, just no listing available.
      if (res.status !== 404) console.warn(`[image-attach] task=${taskId} images listing returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const images = Array.isArray(data.images) ? data.images : [];
    if (images.length > MAX_LISTED_IMAGES) {
      console.warn(`[image-attach] task=${taskId} has ${images.length} linked images — only downloading the first ${MAX_LISTED_IMAGES}`);
    }
    return images.slice(0, MAX_LISTED_IMAGES).map(img => img.url).filter(Boolean);
  } catch (err) {
    console.warn(`[image-attach] task=${taskId} images listing failed: ${err.message}`);
    return [];
  }
}

function rewriteRefs(text, urlToPath) {
  if (!text || !urlToPath.size) return text;
  IMAGE_REF_RE.lastIndex = 0;
  return text.replace(IMAGE_REF_RE, (match, alt, url) => {
    const localPath = urlToPath.get(url);
    if (!localPath) return match;
    return alt ? `${alt}: @${localPath}` : `@${localPath}`;
  });
}

// Download all internal image refs found in prompt + taskCommentsBlock, PLUS any
// images linked to the task via task_images.task_key but never inlined as markdown
// (C1012). Inline data:image/...;base64 refs are materialized locally without an image-upload
// API round-trip (legacy task bodies can contain these even when API credentials are absent).
// Save to disk, return rewritten versions with @<localpath> substitutions.
// Attachment-only images (no markdown ref anywhere) are appended to the prompt as a
// labeled block so the agent can't miss them the way a markdown-only scan would.
async function localizeImageRefs({ taskId, prompt, taskCommentsBlock, projectRoot }) {
  if (!taskId) return { prompt, taskCommentsBlock };

  const root = projectRoot || config.PROJECT_ROOT;
  const texts = [prompt || '', taskCommentsBlock || ''];
  const allRefs = texts.flatMap(t => extractImageRefs(t));

  const dataUrls = [...new Set(allRefs.map(r => r.url))].filter(isDataImageUri);
  const urlToPath = new Map();
  let dir = null;

  // Data URIs are already in hand. Materialize them before resolving API credentials so
  // a project whose API auth is temporarily unavailable still gives the agent a usable
  // local image instead of feeding it the raw base64 payload.
  if (dataUrls.length > 0) {
    dir = resolveAttachmentDir('images', root, taskId);
    await Promise.all(dataUrls.map(async (url) => {
      try {
        const localPath = saveDataImage(url, dir);
        urlToPath.set(url, localPath);
        console.log(`[image-attach] task=${taskId} materialized embedded image → ${localPath}`);
      } catch (err) {
        console.warn(`[image-attach] task=${taskId} skipping embedded image: ${err.message}`);
      }
    }));
  }

  let credentials;
  try {
    credentials = getApiCredentials(root);
  } catch (err) {
    // Count refs by the relative-path shape alone (isInternalImageUrl(url, '') still
    // matches it) — apiBaseUrl isn't available to test the absolute-URL shape without
    // credentials. Silent when there's nothing to lose (image-less prompts stay ~0ms).
    const lostCount = [...new Set(allRefs.map(r => r.url))]
      .filter(u => !isDataImageUri(u) && isInternalImageUrl(u, '')).length;
    if (lostCount > 0) {
      console.warn(`[image-attach] task=${taskId} credentials unavailable — leaving ${lostCount} internal image ref(s) unlocalized: ${err.message}`);
    }
    return {
      prompt: rewriteRefs(prompt || '', urlToPath),
      taskCommentsBlock: rewriteRefs(taskCommentsBlock || '', urlToPath),
    };
  }
  const apiBaseUrl = credentials.baseUrl;

  const markdownUrls = [...new Set(allRefs.map(r => r.url))]
    .filter(u => !isDataImageUri(u) && isInternalImageUrl(u, apiBaseUrl, credentials.projectId));
  const listedUrls = await fetchTaskImageUrls(taskId, credentials);

  // Dedupe by canonical path — an absolute markdown ref and the relative listed
  // url for the same image must not download or get attached twice.
  const seenCanonical = new Set(markdownUrls.map(u => canonicalInternalPath(u, apiBaseUrl, credentials.projectId)));
  const attachmentOnlyUrls = listedUrls.filter(u => {
    if (!isInternalImageUrl(u, apiBaseUrl, credentials.projectId)) return false;
    const canon = canonicalInternalPath(u, apiBaseUrl, credentials.projectId);
    if (seenCanonical.has(canon)) return false;
    seenCanonical.add(canon);
    return true;
  });

  const uniqueUrls = [...markdownUrls, ...attachmentOnlyUrls];
  if (uniqueUrls.length === 0) {
    return {
      prompt: rewriteRefs(prompt || '', urlToPath),
      taskCommentsBlock: rewriteRefs(taskCommentsBlock || '', urlToPath),
    };
  }

  // Credentials resolved (so a config.json exists at root) — safe to materialize the
  // directory now; resolveAttachmentDir() re-checks the same invariant defensively.
  if (!dir) dir = resolveAttachmentDir('images', root, taskId);

  await Promise.all(uniqueUrls.map(async (url) => {
    try {
      const localPath = await fetchAndSave(url, dir, credentials);
      urlToPath.set(url, localPath);
      console.log(`[image-attach] task=${taskId} saved ${url} → ${localPath}`);
    } catch (err) {
      console.warn(`[image-attach] task=${taskId} skipping ${url}: ${err.message}`);
    }
  }));

  if (urlToPath.size === 0) return { prompt, taskCommentsBlock };

  let outPrompt = rewriteRefs(prompt || '', urlToPath);
  const outComments = rewriteRefs(taskCommentsBlock || '', urlToPath);

  const attachmentPaths = attachmentOnlyUrls.map(u => urlToPath.get(u)).filter(Boolean);
  if (attachmentPaths.length > 0) {
    const block = ['Task images (inspect these before implementing):', ...attachmentPaths.map(p => `@${p}`)].join('\n');
    outPrompt = outPrompt ? `${outPrompt}\n\n${block}` : block;
  }

  return { prompt: outPrompt, taskCommentsBlock: outComments };
}

module.exports = { localizeImageRefs };
