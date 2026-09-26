'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('./architecture-cache');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cache-unit-'));
  const dir = path.join(root, 'ai', 'architecture');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, write(name, content) { fs.writeFileSync(path.join(dir, name), content); } };
}

test('missing architecture directory fails softly without falling back to another project', t => {
  const p = project(t);
  const missing = path.join(p.root, 'absent');
  assert.equal(cache.loadAll(missing).count, 0);
  assert.match(cache.loadAll(missing).error, /ENOENT/);
  assert.deepEqual(cache.listSystemTags(missing), []);
  assert.equal(cache.getTagArchitecture('tt-missing', missing), null);
});

test('bulk load builds sorted taxonomy and a valid index while ignoring non-tag files', t => {
  const p = project(t);
  t.mock.method(fs, 'watch', () => { throw new Error('watch unavailable'); });
  p.write('tt-z.md', '# tt-z — Last — details\nbody');
  p.write('tt-a.md', '# First module\nbody');
  p.write('GENERAL.md', '# General');
  p.write('tt-ignore.txt', '# Ignore');
  assert.equal(cache.loadAll(p.root).count, 2);
  const tags = cache.listSystemTags(p.root);
  assert.deepEqual(tags.map(x => [x.tag, x.description]), [['tt-a', 'First module'], ['tt-z', 'Last — details']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, '_index.json'), 'utf8')).tags, tags);
  assert.equal(cache.getTagArchitecture('tt-z', p.root), '# tt-z — Last — details\nbody');
});

test('watch failure uses TTL and mtime revalidation, then observes changed and deleted content', t => {
  const p = project(t);
  t.mock.method(fs, 'watch', () => { throw new Error('watch unavailable'); });
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  p.write('tt-a.md', '# Original');
  cache.loadAll(p.root);
  cache.resetStats();
  t.mock.timers.tick(600001);
  assert.equal(cache.getTagArchitecture('tt-a', p.root), '# Original');
  assert.equal(cache.getStats().mtimeRevalidations, 1);
  p.write('tt-a.md', '# Updated');
  fs.utimesSync(path.join(p.dir, 'tt-a.md'), new Date(5000), new Date(5000));
  assert.equal(cache.getTagArchitecture('tt-a', p.root), '# Original', 'fresh entry stays cached');
  t.mock.timers.tick(600001);
  assert.equal(cache.getTagArchitecture('tt-a', p.root), '# Updated');
  fs.unlinkSync(path.join(p.dir, 'tt-a.md'));
  t.mock.timers.tick(600001);
  assert.equal(cache.getTagArchitecture('tt-a', p.root), null);
});

test('KB pull invalidation refreshes only matching tags in the specified project', t => {
  const a = project(t);
  const b = project(t);
  a.write('tt-a.md', '# A');
  b.write('tt-a.md', '# B');
  assert.equal(cache.getTagArchitecture('tt-a', a.root), '# A');
  assert.equal(cache.getTagArchitecture('tt-a', b.root), '# B');
  a.write('tt-a.md', '# A changed');
  b.write('tt-a.md', '# B changed');
  cache.invalidateArchForKeys(null, a.root);
  cache.invalidateArchForKeys(['CLAUDE.md', null, 'ai/architecture/GENERAL.md'], a.root);
  assert.equal(cache.getTagArchitecture('tt-a', a.root), '# A');
  cache.invalidateArchForKeys(['ai/architecture/tt-a.md'], a.root);
  assert.equal(cache.getTagArchitecture('tt-a', a.root), '# A changed');
  assert.equal(cache.getTagArchitecture('tt-a', b.root), '# B');
});

test('malformed taxonomy index falls back to scanning tag files', t => {
  const p = project(t);
  t.mock.method(fs, 'watch', () => { throw new Error('watch unavailable'); });
  p.write('tt-a.md', '# tt-a — Real module');
  p.write('_index.json', '{broken');
  const tags = cache.listSystemTags(p.root);
  assert.deepEqual(tags.map(x => x.tag), ['tt-a']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, '_index.json'), 'utf8')).tags[0].description, 'Real module');
});
