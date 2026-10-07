'use strict';

const { createHash } = require('node:crypto');

// The HTML shell contains a short pre-paint theme script and the main app wiring.
// Hash their served text so script edits remain usable after a rebuild, without
// granting arbitrary inline scripts permission to run.
//
// The browser hashes the script text the HTML parser produced, and the parser
// turns CRLF and lone CR into LF first. Normalize the same way, or a file served
// with CRLF line endings (a Windows checkout) gets hashes that never match.
function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const scriptText = match[2].replace(/\r\n?/g, '\n');
    const digest = createHash('sha256').update(scriptText, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function contentSecurityPolicy(html) {
  const scriptHashes = inlineScriptHashes(html);
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`,
    // The shell and client render dynamic inline styles; script execution is
    // restricted independently while these existing styles keep working.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' http: https: data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    // Projects can select their API endpoint; local UI also uses WebSockets.
    "connect-src 'self' http: https: ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

module.exports = { contentSecurityPolicy, inlineScriptHashes };
