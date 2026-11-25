'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { buffer } = require('node:stream/consumers');

const TEXT_LIMIT = 1024 * 1024;
const MEDIA_LIMIT = 10 * TEXT_LIMIT;
const MEDIA_MIME = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.pdf': 'application/pdf',
}));
const PROTECTED_NAMES = new Set([
  '.git', '.tipatask', '.tipatask-account.json', '.mcp.json', '.ssh', '.npmrc', '.netrc',
  '.git-credentials', '.credentials.json', '.envrc',
]);
const AGENT_CONFIG_PATHS = [
  '/.codex/auth.json', '/.codex/config.toml', '/.claude/settings.json', '/.claude/settings.local.json',
  '/.pi/agent/auth.json', '/.pi/agent/models.json',
];

const ERRORS = {
  400: ['PREVIEW_INVALID_PATH', 'Expected a relative file path.'],
  403: ['PREVIEW_FORBIDDEN', 'Access to this file is forbidden.'],
  404: ['PREVIEW_NOT_FOUND', 'Preview file not found.'],
  413: ['PREVIEW_TOO_LARGE', 'File exceeds the media preview limit.'],
  500: ['PREVIEW_READ_FAILED', 'Could not read the file preview.'],
};

function previewError(statusCode) {
  const [code, message] = ERRORS[statusCode];
  return Object.assign(new Error(message), { statusCode, code });
}

function fileError(err) {
  if (err.statusCode) return err;
  if (['ENOENT', 'ENOTDIR', 'EISDIR', 'ENXIO'].includes(err.code)) return previewError(404);
  if (['EACCES', 'EPERM', 'ELOOP'].includes(err.code)) return previewError(403);
  if (['EINVAL', 'ENAMETOOLONG'].includes(err.code)) return previewError(400);
  return previewError(500);
}

function checkRelativePath(relative) {
  if (typeof relative !== 'string' || !relative.trim() || relative.includes('\0')) throw previewError(400);
  const parts = relative.toLowerCase().split(/[\\/]/);
  if (path.win32.isAbsolute(relative) || /^[a-z]:/i.test(relative) || parts.includes('..')) throw previewError(403);
  // Win32 strips trailing dots/spaces and supports alternate data streams after a colon.
  if (process.platform === 'win32' && relative.includes(':')) throw previewError(403);
  const names = parts.map(part => part.replace(/[. ]+$/, '')).filter(Boolean);
  if (names.some(name => PROTECTED_NAMES.has(name) || /\.env(?:\.|$)/.test(name))) throw previewError(403);
  const portable = '/' + names.join('/') + '/';
  if (AGENT_CONFIG_PATHS.some(file => portable.includes(file + '/'))) throw previewError(403);
}

async function resolvePreviewPath(projectRoot, relPath) {
  if (!projectRoot) throw previewError(403);
  checkRelativePath(relPath);
  try {
    const root = await fs.realpath(projectRoot);
    const target = await fs.realpath(path.resolve(root, relPath));
    const relative = path.relative(root, target);
    if (!relative) throw previewError(404);
    checkRelativePath(relative);
    return target;
  } catch (err) { throw fileError(err); }
}

async function readFilePreview(projectRoot, relPath) {
  const target = await resolvePreviewPath(projectRoot, relPath);
  try {
    // Check the regular file before open (devices and pipes can have open-time side effects).
    if (!(await fs.lstat(target)).isFile()) throw previewError(404);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || target !== await resolvePreviewPath(projectRoot, relPath)) throw previewError(403);
      const named = await fs.lstat(target, { bigint: true });
      if (stat.dev !== named.dev || stat.ino !== named.ino) throw previewError(403);
      const size = Number(stat.size);
      const ext = path.extname(target).toLowerCase();
      const mediaMime = MEDIA_MIME.get(ext);
      if (mediaMime && size > MEDIA_LIMIT) throw previewError(413);
      const limit = mediaMime ? MEDIA_LIMIT : TEXT_LIMIT;
      // Inclusive stream end: one extra byte detects growth or a truncated text prefix.
      const bytes = await buffer(handle.createReadStream({ end: limit, autoClose: false }));
      const preview = { path: path.normalize(relPath).split(path.sep).join('/'), size, truncated: false };
      if (mediaMime) {
        if (bytes.length > limit) throw previewError(413);
        return { ...preview, kind: ext === '.pdf' ? 'pdf' : 'image', mime: mediaMime, content: bytes.toString('base64') };
      }
      const truncated = bytes.length > limit;
      let content;
      try {
        // A truncated prefix may stop in the middle of a valid UTF-8 character.
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, limit), { stream: truncated });
      } catch (err) {
        if (err.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw err;
      }
      if (content === undefined || /[\x00-\x08\x0e-\x1f\x7f]/.test(content)) {
        return { ...preview, kind: 'binary', mime: 'application/octet-stream', content: null };
      }
      const markdown = ext === '.md' || ext === '.markdown';
      return { ...preview, kind: markdown ? 'markdown' : 'text', mime: markdown ? 'text/markdown' : 'text/plain', truncated, content };
    } finally { await handle.close(); }
  } catch (err) { throw fileError(err); }
}

module.exports = { resolvePreviewPath, readFilePreview };
