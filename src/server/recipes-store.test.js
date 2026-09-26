'use strict';

// (C1346) Regression + unit tests for recipes-store.js — the single implementation of the
// recipes-directory contract that replaced two duplicated copies (file-ops.js's global
// DATA_ROOT/recipes dir, the actual root cause of the reauth ENOTDIR crash, and
// file-backend.js's per-project variant). See api-backend-recipes-dir.test.js for the
// api-backend.js integration and tt-recipe-history.md for the full writeup.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { resolveRecipesDir, ensureRecipesDir, listRecipes, writeRecipe } = require('./recipes-store');
const config = require('./config');

// ── resolveRecipesDir ──

test('resolveRecipesDir: <projectRoot>/.tipatask/recipes for a real, unrelated project root', () => {
  const got = resolveRecipesDir('/Users/alice/Projects/SomeExternalProject');
  assert.equal(got, path.join('/Users/alice/Projects/SomeExternalProject', '.tipatask', 'recipes'));
});

test('resolveRecipesDir: null when projectRoot is null/falsy (e.g. no project bound)', () => {
  assert.equal(resolveRecipesDir(null), null);
  assert.equal(resolveRecipesDir(''), null);
  assert.equal(resolveRecipesDir(undefined), null);
});

test('(C1318) resolveRecipesDir: null when projectRoot IS the app bundle (contains SERVER_ROOT)', () => {
  // config.SERVER_ROOT in this dev/test process is a real on-disk path, not the asar shape —
  // exercise the guard directly against a value we control instead.
  const bundleLikeRoot = config.SERVER_ROOT; // projectRoot === serverRoot itself
  assert.equal(config.containsPath(bundleLikeRoot, config.SERVER_ROOT), true);
  assert.equal(resolveRecipesDir(bundleLikeRoot), null);
});

test('(C1318) resolveRecipesDir: null when projectRoot is an ANCESTOR of SERVER_ROOT', () => {
  const ancestor = path.resolve(config.SERVER_ROOT, '..', '..');
  assert.equal(config.containsPath(ancestor, config.SERVER_ROOT), true);
  assert.equal(resolveRecipesDir(ancestor), null);
});

// ── ensureRecipesDir / listRecipes / writeRecipe (pure, real tmpdir) ──

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-recipes-store-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ensureRecipesDir is idempotent (mkdir -p, second call no-ops)', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  await ensureRecipesDir(dir); // must not throw
  const stat = await fs.stat(dir);
  assert.ok(stat.isDirectory());
}));

test('listRecipes: [] for a directory that does not exist yet (no throw)', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'does-not-exist');
  assert.deepEqual(await listRecipes(dir), []);
}));

test('writeRecipe numbers sequentially 0001 -> 0002 and slugs the first 4 words', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);

  const r1 = await writeRecipe(dir, 'First recipe about widgets and gadgets and more', { fallbackSlug: 'recipe' });
  assert.equal(r1.filename, '0001_first_recipe_about_widgets.md');
  assert.equal(r1.duplicate, false);

  const r2 = await writeRecipe(dir, 'Second, totally different content here', { fallbackSlug: 'recipe' });
  assert.equal(r2.filename, '0002_second_totally_different_content.md');
  assert.equal(r2.duplicate, false);

  const recipes = await listRecipes(dir);
  assert.equal(recipes.length, 2);
  // sort().reverse() — newest (highest number) first
  assert.equal(recipes[0].filename, '0002_second_totally_different_content.md');
}));

test('writeRecipe dedupes against the LATEST recipe -> {duplicate:true}, no new file on disk', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  await writeRecipe(dir, 'Same content over and over', { fallbackSlug: 'recipe' });
  const again = await writeRecipe(dir, 'Same content over and over', { fallbackSlug: 'recipe' });
  assert.equal(again.duplicate, true);
  assert.equal(again.filename, '0001_same_content_over_and.md');
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
}));

test('writeRecipe honours fallbackSlug — "objective" vs "recipe" (locks the pre-existing divergence between file-ops.js and file-backend.js)', () => withTmpDir(async (tmp) => {
  // A single whitespace-free token of only punctuation sanitizes to an EMPTY slug (no
  // underscore survives — join('_') only inserts one between >=2 split tokens), which is the
  // only shape that actually exercises the `|| fallbackSlug` branch.
  const punctOnly = '!!!???---***';

  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, punctOnly, { fallbackSlug: 'objective' });
  assert.equal(r.filename, '0001_objective.md');

  const dir2 = path.join(tmp, 'recipes2');
  await ensureRecipesDir(dir2);
  const r2 = await writeRecipe(dir2, punctOnly, { fallbackSlug: 'recipe' });
  assert.equal(r2.filename, '0001_recipe.md');
}));

// ── writeRecipe: transliterated slug (C1576) ──

test('(C1576) non-Latin content transliterates instead of collapsing to the fallback — Ukrainian, exact', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, 'Створити модуль оплати замовлень', { fallbackSlug: 'objective' });
  assert.equal(r.filename, '0001_stvoryty_modul_oplaty_zamovlen.md');
}));

test('(C1576) non-Latin content transliterates instead of collapsing to the fallback — German umlauts/eszett, exact', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, 'Größe der Projektdatei ändern', { fallbackSlug: 'objective' });
  assert.equal(r.filename, '0001_grosse_der_projektdatei_andern.md');
}));

test('(C1576) ASCII accented content transliterates — regression guard, exact', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, 'Café Français menu update', { fallbackSlug: 'objective' });
  assert.equal(r.filename, '0001_cafe_francais_menu_update.md');
}));

test('(C1576) Japanese title transliterates to a Latin slug instead of falling back (shape-only — kanji romanize as pinyin, see transliteration.test.js)', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, '東京プロジェクトの計画', { fallbackSlug: 'objective' });
  assert.match(r.filename, /^0001_[a-z0-9_]+\.md$/);
  assert.notEqual(r.filename, '0001_objective.md');
}));

test('(C1576) Chinese title transliterates via pinyin to a Latin slug instead of falling back (shape-only)', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, '项目管理系统更新说明', { fallbackSlug: 'objective' });
  assert.match(r.filename, /^0001_[a-z0-9_]+\.md$/);
  assert.notEqual(r.filename, '0001_objective.md');
}));

test('(C1576) emoji-only content still falls back — transliteration finds no words either', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, '🚀🔥', { fallbackSlug: 'objective' });
  assert.equal(r.filename, '0001_objective.md');
}));

// ── writeRecipe: preferredFilename (C1576) ──

test('(C1576) preferredFilename: a valid API-assigned name is adopted verbatim, counter included', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, 'Some recipe content here', {
    fallbackSlug: 'objective',
    preferredFilename: '0042_some_recipe_name.md',
  });
  assert.equal(r.filename, '0042_some_recipe_name.md');
  assert.equal(r.duplicate, false);
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['0042_some_recipe_name.md']);
}));

test('(C1576) preferredFilename: path traversal is rejected, falls back to local generation, nothing escapes dir', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r = await writeRecipe(dir, 'Some recipe content here', {
    fallbackSlug: 'objective',
    preferredFilename: '../../evil.md',
  });
  assert.equal(r.filename, '0001_some_recipe_content_here.md');
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['0001_some_recipe_content_here.md']);
  // Nothing written outside tmp itself.
  const outsideFiles = await fs.readdir(tmp);
  assert.deepEqual(outsideFiles.sort(), ['recipes']);
}));

test('(C1576) preferredFilename: wrong-shape values are rejected, falls back to local generation', () => withTmpDir(async (tmp) => {
  const cases = ['no-counter.md', '0001_UPPER.md', '0001_ok.txt', '', '0001_.md'];
  for (const bad of cases) {
    const dir = path.join(tmp, `recipes-${cases.indexOf(bad)}`);
    await ensureRecipesDir(dir);
    const r = await writeRecipe(dir, 'Fixed content for this case', {
      fallbackSlug: 'objective',
      preferredFilename: bad,
    });
    assert.equal(r.filename, '0001_fixed_content_for_this.md', `bad preferredFilename ${JSON.stringify(bad)} should have been rejected`);
  }
}));

test('(C1576) preferredFilename: absent/null leaves behavior unchanged', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const r1 = await writeRecipe(dir, 'Some recipe content here', { fallbackSlug: 'objective' });
  assert.equal(r1.filename, '0001_some_recipe_content_here.md');
  const r2 = await writeRecipe(dir, 'More recipe content here', { fallbackSlug: 'objective', preferredFilename: null });
  assert.equal(r2.filename, '0002_more_recipe_content_here.md');
}));

test('(C1576) preferredFilename does not defeat the latest-content dedup check', () => withTmpDir(async (tmp) => {
  const dir = path.join(tmp, 'recipes');
  await ensureRecipesDir(dir);
  const first = await writeRecipe(dir, 'Same content over and over', { fallbackSlug: 'objective' });
  assert.equal(first.filename, '0001_same_content_over_and.md');

  const again = await writeRecipe(dir, 'Same content over and over', {
    fallbackSlug: 'objective',
    preferredFilename: '0099_a_different_name.md',
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.filename, '0001_same_content_over_and.md');
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['0001_same_content_over_and.md']);
}));

test('(C1346) ensureRecipesDir into an in-asar-shaped path throws the mkdir error a caller can catch — this module itself does not assert; that is file-ops.js\'s job at its own call sites', () => withTmpDir(async (tmp) => {
  // recipes-store.js is deliberately dumb about asar — the guard lives in resolveRecipesDir
  // (config-driven) and in file-ops.js's own assertWritableDataDir call. Sanity: a directory
  // under a path component that is actually a FILE (not a directory) fails with ENOTDIR, same
  // shape as the original bug, proving ensureRecipesDir surfaces the real fs error rather than
  // swallowing it.
  const blocker = path.join(tmp, 'not-a-dir');
  await fs.writeFile(blocker, 'i am a file');
  await assert.rejects(() => ensureRecipesDir(path.join(blocker, 'recipes')), /ENOTDIR/);
}));
