'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { safeFolder, digest } = require('../image-task-store');
const { safeSegment } = require('../attachment-paths');

// Preserve the extension and ordinary workspace filenames across a read-edit-publish cycle.
function inputFilename(filename) {
  const name = filename.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/u, '') || 'file';
  const ext = path.extname(name);
  const suffix = Buffer.byteLength(ext) <= 32 ? ext : '';
  const stem = Buffer.from(path.basename(name, suffix)).subarray(0, 215).toString().replace(/\uFFFD$/u, '');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.toLowerCase() === '.git';
  return (reserved ? '_' : '') + stem + suffix;
}

async function materializeRevision(folder, row, ref) {
  const bytes = Buffer.from(row.data, 'base64');
  if (row.url !== ref.url || bytes.length !== row.size_bytes || digest(bytes) !== row.sha256) {
    throw new Error('Artifact input failed verification: ' + ref.url);
  }
  const dest = path.join(folder, `${ref.project}-${ref.id}-r${ref.revision}`);
  const name = inputFilename(row.filename);
  const file = path.join(dest, name);
  const temp = await fs.mkdtemp(path.join(folder, '.incoming-'));
  try {
    await fs.writeFile(path.join(temp, name), bytes, { flag: 'wx', mode: 0o600 });
    // Rename a complete directory into place. A simultaneous spawn can only see a
    // whole revision, including on volumes without hard links.
    try { await fs.rename(temp, dest); }
    catch (err) {
      const existing = await fs.lstat(dest).catch(() => null);
      if (!existing?.isDirectory()) throw err;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== bytes.length || digest(await fs.readFile(file)) !== row.sha256) {
        throw new Error('Move the modified local input before reloading its pinned revision: ' + file);
      }
    }
    return file;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

// Only canonical project-relative links emitted by the picker are inputs. Fetch the
// revision by ID and treat its original source path as metadata.
async function localizeArtifactRefs({ prompt, taskCommentsBlock, description, taskId, projectRoot, backend }) {
  const refs = new Map();
  const pattern = /\]\((\/api\/projects\/(\d+)\/files\/artifacts\/(\d{1,10})\/revisions\/(\d{1,10})\/content)\)/g;
  for (const text of [prompt, taskCommentsBlock, description]) {
    for (const [, url, project, id, revision] of (text || '').matchAll(pattern)) {
      refs.set(url, { url, project, id, revision });
    }
  }
  if (!refs.size) return { prompt, taskCommentsBlock };
  projectRoot ||= require('../project-root').resolveProjectRoot();
  const store = backend || require('../api-backend').createApiBackend(null, projectRoot);
  try {
    const credentials = store.getCredentials();
    const entries = [...refs.values()];
    if (entries.some(ref => ref.project !== String(credentials.projectId))) throw new Error('Artifact input belongs to a different project');
    const folder = await safeFolder(projectRoot, path.join('.tipatask', 'artifacts', 'task-' + safeSegment(taskId)));
    const ignore = path.join(path.dirname(folder), '.gitignore');
    await fs.writeFile(ignore, '*\n', { flag: 'wx' }).catch(err => { if (err.code !== 'EEXIST') throw err; });
    let result = prompt || '';
    for (const ref of entries) {
      const row = await store.getArtifact(ref.id, ref.revision, credentials);
      const file = await materializeRevision(folder, row, ref);
      const line = `Artifact ${ref.id}, revision ${ref.revision} (${row.revision_name})${row.source_path ? ' from ' + row.source_path : ''}: @${file}`;
      if (!result.split('\n').includes(line)) result += '\n' + line;
    }
    return { prompt: result, taskCommentsBlock };
  } finally {
    if (!backend) store.dispose();
  }
}

module.exports = { localizeArtifactRefs };
