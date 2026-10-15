'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ARCH_REPLY_CHAR_BUDGET, buildArchitectureReply } = require('./arch-budget');

const script = path.resolve(__dirname, '../../scripts/tool-result-cache.js');
const SINGLE = 'mcp__tipatask__get_tag_architecture';
const BATCH = 'mcp__tipatask__get_tag_architectures';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-budget-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const arch = path.join(root, 'ai/architecture');
  fs.mkdirSync(arch, { recursive: true });
  const cachePath = path.join(root, 'tipatask-arch-cache-arch-budget-test.json');
  function seed(docs) {
    const cache = {};
    for (const [tag, content] of docs) {
      const file = path.join(arch, `${tag}.md`);
      fs.writeFileSync(file, typeof content === 'string' ? content : '# Doc');
      cache[tag] = { content, mtime: fs.statSync(file).mtimeMs, ts: Date.now() };
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  }
  function invoke(hook, tool, input, response) {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, TMPDIR: root, TIPATASK_TURN_ID: 'arch-budget-test', API_PROJECT_ID: 'arch-budget-test', TIPATASK_PROJECT_ROOT: root, TIPATASK_OBJECTIVE_TASK_ID: '' },
      input: JSON.stringify({ hook_event_name: hook, tool_name: tool, tool_input: input, tool_response: response }),
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  return { seed, invoke, read: () => JSON.parse(fs.readFileSync(cachePath, 'utf8')) };
}

test('small cached architecture replies still serve through the hook', t => {
  const f = fixture(t);
  f.seed([['tt-doc', '# Doc\n## Files\nfile.js\n']]);
  const output = f.invoke('PreToolUse', SINGLE, { tag_name: 'tt-doc' });
  assert.ok(output.length <= ARCH_REPLY_CHAR_BUDGET);
  const hook = JSON.parse(output).hookSpecificOutput;
  assert.equal(hook.permissionDecision, 'deny');
  assert.match(hook.permissionDecisionReason, /file\.js/);
});

test('legacy large cache entries and combined large batches fall through to MCP', t => {
  const f = fixture(t);
  f.seed([['tt-large', 'x'.repeat(70000)], ['tt-first', 'a'.repeat(35000)], ['tt-second', 'b'.repeat(35000)]]);
  assert.equal(f.invoke('PreToolUse', SINGLE, { tag_name: 'tt-large' }), '');
  assert.equal(f.invoke('PreToolUse', BATCH, { tag_names: ['tt-first', 'tt-second'] }), '');
});

test('section reads neither hit nor overwrite full-document cache entries', t => {
  const f = fixture(t);
  const doc = '## Files\nfile.js\n## API\napi\n';
  f.seed([['tt-doc', doc]]);
  for (const [tool, input] of [[SINGLE, { tag_name: 'tt-doc', section: 'Files' }], [BATCH, { tag_names: ['tt-doc'], section: 'Files' }]]) {
    assert.equal(f.invoke('PreToolUse', tool, input), '');
    f.invoke('PostToolUse', tool, input, buildArchitectureReply([['tt-doc', doc]], { single: tool === SINGLE, section: 'Files' }));
    assert.equal(f.read()['tt-doc'].content, doc);
  }
});

test('outline responses are not stored as full docs; full batch siblings still cache', t => {
  const f = fixture(t);
  f.seed([]);
  const large = '## Files\n' + 'x'.repeat(70000);
  f.invoke('PostToolUse', SINGLE, { tag_name: 'tt-large' }, buildArchitectureReply([['tt-large', large]], { single: true }));
  assert.deepEqual(f.read(), {});
  f.invoke('PostToolUse', BATCH, { tag_names: ['tt-large', 'tt-small', 'tt-missing'] }, buildArchitectureReply([['tt-large', large], ['tt-small', '# Small'], ['tt-missing', null]]));
  assert.deepEqual(Object.keys(f.read()), ['tt-small']);
  assert.equal(f.read()['tt-small'].content, '# Small');
});

test('old object or JSON-string outlines in cache cannot satisfy later reads', t => {
  const f = fixture(t);
  const outline = { truncated: true, chars: 70000, sections: [], hint: 'Read local file' };
  f.seed([['tt-object', outline], ['tt-json', JSON.stringify(outline)]]);
  assert.equal(f.invoke('PreToolUse', SINGLE, { tag_name: 'tt-json' }), '');
  assert.equal(f.invoke('PreToolUse', BATCH, { tag_names: ['tt-object'] }), '');
});
