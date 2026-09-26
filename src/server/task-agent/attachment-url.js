'use strict';

// Attachment downloads carry the project's bearer token. Only direct API attachment
// routes for that same project may reach a credential-bearing fetch.
function getApiOrigin(baseUrl) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Invalid API_BASE_URL for attachment fetch');
  }
  return base.origin;
}

function resolveInternalAttachmentUrl(url, { baseUrl, projectId }, kind) {
  if (typeof url !== 'string' || !url || !['images', 'files'].includes(kind) ||
      !/^\d+$/.test(String(projectId)) || /[%\\\s]/.test(url)) return null;

  try {
    const origin = getApiOrigin(baseUrl);
    // Root-relative API paths and absolute HTTP(S) URLs are the two supported forms.
    // In particular, //host/path must never inherit the configured API's scheme.
    const relative = url.startsWith('/') && !url.startsWith('//');
    if (!relative && !/^https?:\/\//i.test(url)) return null;
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin || parsed.username || parsed.password ||
        parsed.search || parsed.hash) return null;

    const match = /^\/api\/projects\/(\d+)\/(images|files)\/(\d+)$/.exec(parsed.pathname);
    if (!match || match[1] !== String(projectId) || match[2] !== kind) return null;
    return { href: parsed.href, path: parsed.pathname, id: match[3] };
  } catch {
    return null;
  }
}

module.exports = { getApiOrigin, resolveInternalAttachmentUrl };
