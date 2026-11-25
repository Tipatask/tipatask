'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { buffer } = require('node:stream/consumers');
const path = require('node:path');
const { inside } = require('../server/image-task-store');

const MAX_BYTES = 1024 * 1024;

async function publishArtifact(argv, { projectRoot, taskKey, backend }) {
  const [file, revisionName, kind, mimeType, artifactId, baseRevision] = argv;
  if (![4, 6].includes(argv.length) || !taskKey || !file || (argv.length === 6
    && ![artifactId, baseRevision].every(n => /^[1-9]\d{0,9}$/.test(n)))) {
    throw new Error('Expected a task run and publish-artifact FILE "revision name" KIND MIME [ARTIFACT_ID BASE_REVISION]');
  }
  const root = await fs.realpath(projectRoot);
  const source = await fs.realpath(path.resolve(file));
  if (!inside(root, source)) throw new Error('Artifact file must be inside the task workspace');
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Expected a regular workspace file of up to 1 MiB');
    // The file can grow after stat. Read at most one byte beyond the limit.
    bytes = await buffer(handle.createReadStream({ end: MAX_BYTES }));
    if (bytes.length > MAX_BYTES) throw new Error('Artifact exceeds 1 MiB');
  } finally { await handle.close(); }
  return backend.saveArtifactRevision(artifactId, {
    taskKey, revisionName, kind, mimeType, filename: path.basename(file), data: bytes.toString('base64'),
    ...(kind === 'source' && { sourcePath: path.relative(root, source).split(path.sep).join('/') }),
    ...(baseRevision && { baseRevision: Number(baseRevision) }),
  });
}

module.exports = { publishArtifact };
