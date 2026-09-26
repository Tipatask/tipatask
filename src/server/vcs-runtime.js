'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const version = require('../../package.json').version;
const files = ['package.json', 'src/server/vcs-settings.js', 'src/server/vcs-context.js',
  'src/server/vcs-runtime.js', 'src/server/api-backend.js', 'src/server/ws-handlers.js',
  'src/server/index.js', 'src/mcp/server.js',
  'src/server/task-agent/base-agent.js', 'src/server/task-agent/codex-agent.js',
  'src/server/terminal-session.js', 'src/server/git-merge/completion-guard.js'];

function fingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file).update(fs.readFileSync(path.join(root, file)));
  return hash.digest('hex');
}

// Capture loaded runtime identity, not just whatever version is on disk at completion.
const loadedFingerprint = fingerprint();
function vcsRuntime() {
  let diskFingerprint = null;
  try { diskFingerprint = fingerprint(); } catch {}
  return { version, source: root, packaged: /(?:^|[/\\])app\.asar(?:[/\\]|$)/.test(root),
    fingerprint: loadedFingerprint, stale: diskFingerprint !== loadedFingerprint, protocol: 1 };
}

module.exports = { vcsRuntime };
