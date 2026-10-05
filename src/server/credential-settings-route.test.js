'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpHandler } = require('./ws-handlers');
const { writeProjectConfig, readProjectConfig } = require('./project-config');

function req(method, url, root, payload) {
  const request = { method, url, headers: { 'x-tipatask-project': root } };
  request[Symbol.asyncIterator] = async function* () { if (payload) yield JSON.stringify(payload); };
  return request;
}
function response() {
  return { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body || ''; } };
}

test('browser settings routes return no stored secret and resolve saves within project', async (t) => {
  const roots = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-safe-http-')));
  t.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  for (const [i, root] of roots.entries()) {
    writeProjectConfig(root, {
      API_BASE_URL: `https://server-${i}.test`, API_TOKEN: `sentinel-token-${i}`, ASSEMBLYAI_API_KEY: `sentinel-voice-${i}`,
      PI_MODELS: [{ model: 'm1', apiKey: `sentinel-pi-${i}` }],
      TASK_AGENT: 'pi', AVAILABLE_AGENTS: 'pi', API_PROJECT_ID: String(i + 1),
    });
  }
  const handler = createHttpHandler(new Map(), () => ({}), {});
  const call = async (method, url, root, body) => {
    const res = response();
    await handler(req(method, url, root, body), res);
    return { status: res.status, data: JSON.parse(res.body) };
  };
  const project = await call('GET', '/api/project-config', roots[0]);
  const agents = await call('GET', '/api/agents-config', roots[0]);
  assert.equal(project.status, 200);
  assert.equal(agents.status, 200);
  for (const reply of [project.data, agents.data]) {
    for (const secret of ['sentinel-token-0', 'sentinel-voice-0', 'sentinel-pi-0']) {
      assert.equal(JSON.stringify(reply).includes(secret), false, `${secret} leaked from HTTP read`);
    }
  }
  assert.equal(agents.data.selection.piModels[0].hasApiKey, true);
  const saved = await call('POST', '/api/project-config', roots[0], project.data.config);
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.data).includes('sentinel-pi-0'), false);
  assert.equal(readProjectConfig(roots[0]).PI_MODELS[0].apiKey, 'sentinel-pi-0');
  assert.equal(readProjectConfig(roots[1]).PI_MODELS[0].apiKey, 'sentinel-pi-1');
  const replaced = await call('POST', '/api/project-config', roots[0], {
    PI_MODELS: [{ model: 'm1', apiKeyAction: 'replace', apiKey: 'replacement-pi' }],
  });
  assert.equal(replaced.status, 200);
  assert.equal(readProjectConfig(roots[0]).PI_MODELS[0].apiKey, 'replacement-pi');
  const removed = await call('POST', '/api/project-config', roots[0], { PI_MODELS: [] });
  assert.equal(removed.status, 200);
  assert.deepEqual(readProjectConfig(roots[0]).PI_MODELS, []);
  assert.equal(readProjectConfig(roots[1]).PI_MODELS[0].apiKey, 'sentinel-pi-1');
  const cleared = await call('POST', '/api/project-config', roots[0], { assemblyaiKey: { action: 'clear' } });
  assert.equal(cleared.status, 200);
  assert.equal(readProjectConfig(roots[0]).ASSEMBLYAI_API_KEY, '');
  assert.equal(readProjectConfig(roots[1]).ASSEMBLYAI_API_KEY, 'sentinel-voice-1');
});
