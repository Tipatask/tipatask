'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { localizeArtifactRefs } = require('./artifact-attach');

test('materialization pins, verifies and safely reopens the same workspace input', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-artifact-input-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const url = '/api/projects/2/files/artifacts/11/revisions/3/content';
  const bytes = Buffer.from('measured,value\nx,8\n');
  const row = { url, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length, revision_name: 'Measured', filename: 'data.csv' };
  const credentials = { projectId: 2 };
  let reads = 0;
  const backend = { getCredentials: () => credentials, getArtifact: async (id, revision, context) => {
    reads++;
    assert.equal(id, '11');
    assert.equal(revision, '3');
    assert.equal(context, credentials);
    return row;
  } };
  const options = { projectRoot, backend, taskId: 'TPT1', prompt: 'Reuse the measurements',
    description: '[data](' + url + ')', taskCommentsBlock: '[also data](' + url + ')' };
  const result = await localizeArtifactRefs(options);
  const file = result.prompt.match(/: @(.+)$/)[1];
  assert.equal(path.basename(file), 'data.csv');
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(reads, 1);
  assert.equal((await localizeArtifactRefs({ ...options, prompt: result.prompt })).prompt, result.prompt);
  await fs.writeFile(file, 'unfinished edit');
  await assert.rejects(localizeArtifactRefs(options), /modified local input/);
  assert.equal(await fs.readFile(file, 'utf8'), 'unfinished edit');
  row.data = Buffer.from('corrupt').toString('base64');
  await assert.rejects(localizeArtifactRefs(options), /failed verification/);
  const before = reads;
  await assert.rejects(localizeArtifactRefs({ ...options, description: '[foreign](' + url.replace('projects/2', 'projects/3') + ')' }), /different project/);
  assert.equal(reads, before, 'foreign inputs never trigger authenticated downloads');
});
