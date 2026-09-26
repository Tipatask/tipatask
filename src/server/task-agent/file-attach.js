'use strict';

// C1247 — task_files CLI injection. Structural mirror of image-attach.js (read that module's
// comments for the shared reasoning — credential resolution, fail-open discipline, C1012-style
// by-task listing merge). This module handles *generic* file attachments (task_files, C1246)
// instead of images (task_images).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { getApiCredentials } = require('../api-credentials');
const { resolveAttachmentDir } = require('../attachment-paths');
const { isTaskKeyLike } = require('../task-key-format');
const { getApiOrigin, resolveInternalAttachmentUrl } = require('./attachment-url');

// Plain markdown link, deliberately excluding image syntax via a negative lookbehind —
// `![alt](url)` is image-attach.js's territory, not this module's. An ordinary link whose text
// happens to look like an image ref (`[screenshot.png](url)`) is still a *link* here; whether
// it gets localized depends only on isInternalFileUrl() below, not on the link text.
const FILE_REF_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;

// Keep in sync with api/src/routes/files.js FILE_MIME_EXT — this is the authoritative source,
// this table is a read-only mirror used to (a) validate a downloaded response actually is one
// of the allowed document types before writing it to disk, and (b) force the on-disk extension
// from the *verified* Content-Type rather than trusting the stored original_filename, so a
// mismatched row (reachable via MCP/API, which validate mimeType but never cross-check it
// against the filename's extension) can never land on disk with an image extension and get
// swept up by codex-session.js's IMAGE_ATTACH_RE (which matches on extension alone).
const FILE_MIME_EXT = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/yaml': '.yaml',
  'text/yaml': '.yaml',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
};

// (C1483: was a bespoke REAL_TASK_KEY_RE capped at 4-char prefixes, 2 short of the
// TASK_KEY_RE contract's 6 — replaced with the shared isTaskKeyLike(), mirrors
// image-attach.js's C1012 comment.)
const MAX_LISTED_FILES = 10;
// task_files.task_key is always NULL in current practice (the only upload path,
// src/client/file-attach.js, hardcodes taskKey: null on every call) — this listing exists for
// parity with images and to pick up any future upload path that does stamp task_key, not
// because it does anything useful today. Shorter timeout than images' 8s reflects that it is
// pure added latency in the common case.
const LISTING_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // slack above the API's 1 MB upload cap for base64/JSON overhead

const FILE_BLOCK_HEADER = 'Task file attachments (read these before implementing):';

function extractFileRefs(text) {
  if (!text) return [];
  const refs = [];
  FILE_REF_RE.lastIndex = 0;
  let m;
  while ((m = FILE_REF_RE.exec(text)) !== null) {
    refs.push({ full: m[0], alt: m[1], url: m[2], start: m.index, end: m.index + m[0].length });
  }
  return refs;
}

// Only the relative and apiBaseUrl-absolute shapes — the same two shapes image-attach.js
// recognizes. There is no "/api/files/:pid/:id" equivalent to support: that shape is the Task
// App's local same-origin proxy (ws-handlers.js), it doesn't exist on the API server, and
// fetching it here would 404. If a pasted link ever uses that form it is simply left untouched
// (fail-open), same as any other external URL.
function isInternalFileUrl(url, apiBaseUrl, projectId) {
  if (!url) return false;
  if (!apiBaseUrl) return /^\/api\/projects\/\d+\/files\/\d+$/.test(url);
  return !!resolveInternalAttachmentUrl(url, { baseUrl: apiBaseUrl, projectId }, 'files');
}

function canonicalInternalPath(url, apiBaseUrl, projectId) {
  return resolveInternalAttachmentUrl(url, { baseUrl: apiBaseUrl, projectId }, 'files')?.path || url;
}

function fileIdFromUrl(url) {
  const m = /\/files\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

function sanitizeBase(name) {
  const clean = String(name || '').replace(/[\\/]/g, '').replace(/\.\./g, '').trim();
  const base = path.basename(clean, path.extname(clean));
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}

// filename*=UTF-8''<pct-encoded> takes priority (RFC 5987, what files.js actually sends);
// falls back to the plain filename="..." param. Never throws — a malformed header must not
// abort a download that otherwise succeeded.
function nameFromContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  if (plain) return plain[1];
  return null;
}

async function fetchAndSave(url, dir, fileId, { baseUrl, token, projectId }, listingFilename) {
  const attachment = resolveInternalAttachmentUrl(url, { baseUrl, projectId }, 'files');
  if (!attachment) throw new Error('Rejected file attachment URL');
  const requestUrl = attachment.href;
  const res = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${requestUrl} returned ${res.status}`);
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = FILE_MIME_EXT[contentType];
  if (!ext) {
    throw new Error(`Unsupported file MIME type: ${contentType}`);
  }
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_FILE_BYTES) {
    throw new Error(`File too large (${contentLength} bytes, max ${MAX_FILE_BYTES})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File too large (${buf.length} bytes, max ${MAX_FILE_BYTES})`);
  }
  const rawName = nameFromContentDisposition(res.headers.get('content-disposition')) || listingFilename || 'file';
  // On-disk name is always <fileId>-<sanitizedBase><extFromContentType> — deterministic
  // (a re-spawn overwrites identical bytes instead of accumulating duplicates) and collision-
  // free (two different files can share original_filename; their ids never collide) without
  // any per-call bookkeeping. Extension is always the one FILE_MIME_EXT derives from the
  // verified Content-Type, never taken from rawName — see the FILE_MIME_EXT comment above.
  const filename = `${fileId}-${sanitizeBase(rawName)}${ext}`;
  const localPath = path.join(dir, filename);
  fs.writeFileSync(localPath, buf);
  return localPath;
}

// Mirrors image-attach.js's fetchTaskImageUrls. Never throws. Returns [{url, filename}].
async function fetchTaskFileUrls(taskId, { baseUrl, token, projectId }) {
  if (!isTaskKeyLike(taskId)) return [];
  try {
    const requestUrl = `${getApiOrigin(baseUrl)}/api/projects/${projectId}/files/task/${encodeURIComponent(taskId)}`;
    const res = await fetch(requestUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[file-attach] task=${taskId} files listing returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length > MAX_LISTED_FILES) {
      console.warn(`[file-attach] task=${taskId} has ${files.length} linked files — only downloading the first ${MAX_LISTED_FILES}`);
    }
    return files.slice(0, MAX_LISTED_FILES)
      .filter(f => f && f.url)
      .map(f => ({ url: f.url, filename: f.filename }));
  } catch (err) {
    console.warn(`[file-attach] task=${taskId} files listing failed: ${err.message}`);
    return [];
  }
}

function rewriteRefs(text, urlToPath) {
  if (!text || !urlToPath.size) return text;
  FILE_REF_RE.lastIndex = 0;
  return text.replace(FILE_REF_RE, (match, alt, url) => {
    const localPath = urlToPath.get(url);
    if (!localPath) return match;
    return alt ? `${alt}: @${localPath}` : `@${localPath}`;
  });
}

// Download all internal file refs found in prompt + taskCommentsBlock, PLUS any files linked
// to the task via task_files.task_key but never inlined as a link, save to disk, and return
// rewritten versions with @<localpath> substitutions. Unlike images, EVERY localized file
// (markdown-sourced or listing-sourced) is also listed in one appended block — per product
// decision, the inline rewrite alone is easy to skim past for a document link the way it isn't
// for an inline image.
async function localizeFileRefs({ taskId, prompt, taskCommentsBlock, projectRoot }) {
  if (!taskId) return { prompt, taskCommentsBlock };

  const root = projectRoot || config.PROJECT_ROOT;
  const texts = [prompt || '', taskCommentsBlock || ''];
  const allRefs = texts.flatMap(t => extractFileRefs(t));

  let credentials;
  try {
    credentials = getApiCredentials(root);
  } catch (err) {
    const lostCount = [...new Set(allRefs.map(r => r.url))].filter(u => isInternalFileUrl(u, '')).length;
    if (lostCount > 0) {
      console.warn(`[file-attach] task=${taskId} credentials unavailable — leaving ${lostCount} internal file ref(s) unlocalized: ${err.message}`);
    }
    return { prompt, taskCommentsBlock };
  }
  const apiBaseUrl = credentials.baseUrl;

  const markdownUrls = [...new Set(allRefs.map(r => r.url))].filter(u => isInternalFileUrl(u, apiBaseUrl, credentials.projectId));
  const listed = await fetchTaskFileUrls(taskId, credentials);

  const seenCanonical = new Set(markdownUrls.map(u => canonicalInternalPath(u, apiBaseUrl, credentials.projectId)));
  const listingFilenameByUrl = new Map(listed.map(f => [f.url, f.filename]));
  const attachmentOnlyUrls = listed
    .map(f => f.url)
    .filter(u => {
      if (!isInternalFileUrl(u, apiBaseUrl, credentials.projectId)) return false;
      const canon = canonicalInternalPath(u, apiBaseUrl, credentials.projectId);
      if (seenCanonical.has(canon)) return false;
      seenCanonical.add(canon);
      return true;
    });

  const uniqueUrls = [...markdownUrls, ...attachmentOnlyUrls];
  if (uniqueUrls.length === 0) return { prompt, taskCommentsBlock };

  const dir = resolveAttachmentDir('files', root, taskId);

  const urlToPath = new Map();
  await Promise.all(uniqueUrls.map(async (url) => {
    const fileId = fileIdFromUrl(url) || crypto.randomUUID().slice(0, 8);
    try {
      const localPath = await fetchAndSave(url, dir, fileId, credentials, listingFilenameByUrl.get(url));
      urlToPath.set(url, localPath);
      console.log(`[file-attach] task=${taskId} saved ${url} → ${localPath}`);
    } catch (err) {
      console.warn(`[file-attach] task=${taskId} skipping ${url}: ${err.message}`);
    }
  }));

  if (urlToPath.size === 0) return { prompt, taskCommentsBlock };

  let outPrompt = rewriteRefs(prompt || '', urlToPath);
  const outComments = rewriteRefs(taskCommentsBlock || '', urlToPath);

  // Idempotency guard: if this prompt was already localized once (a retry re-running
  // getSpawnSpec, say), the inline rewrite is a no-op the second time around (rewriteRefs only
  // matches remaining [name](url) links, and those are already @<path> by then) but a naive
  // re-append would duplicate the block. Skip the append if it's already present.
  if (!outPrompt.includes(FILE_BLOCK_HEADER)) {
    const allPaths = [...urlToPath.values()];
    const block = [FILE_BLOCK_HEADER, ...allPaths.map(p => `@${p}`)].join('\n');
    outPrompt = outPrompt ? `${outPrompt}\n\n${block}` : block;
  }

  return { prompt: outPrompt, taskCommentsBlock: outComments };
}

module.exports = { localizeFileRefs };
