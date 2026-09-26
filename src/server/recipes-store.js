'use strict';

// (C1346) Single implementation of the recipes-directory contract, previously duplicated in
// the now-deleted file-ops.js (a process-global DATA_ROOT/recipes dir, frozen at require time
// from config.DATA_ROOT — the root cause of the reauth ENOTDIR crash: in the Electron main
// process that global resolves inside the read-only app.asar) and the retired file-backend.js
// (a per-project variant, correct but a second copy of the same logic; both deleted with the
// file task backend, C1353). api-backend.js's local dual-write copy of a saved recipe is the
// sole caller now — see tt-recipe-history.md.
//
// Holds no module state: ensureRecipesDir/listRecipes/writeRecipe take the dir as an argument
// and don't care where it came from. Only resolveRecipesDir() reads config.js, for the C1318
// containment guard (config.js never requires this module back — no cycle). `fallbackSlug`
// defaults to 'recipe' but the one live caller (api-backend.js) always passes 'objective',
// preserving the pre-C1346 file-ops.js/TODO.md caller's naming byte-for-byte.
//
// (C1576) writeRecipe()'s `preferredFilename` lets that same caller pass the API's own
// recipes.filename through, so the mirror matches the DB exactly instead of running its
// own counter/slug — see writeRecipe() below for the validation and fallback.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { isAsarPath } = require('./spawn-utils');
const { transliterate } = require('./transliteration');

// (C1576) The exact shape both filename generators produce: 4-digit counter, 1..40 chars
// of [a-z0-9_], `.md`. preferredFilename arrives off the network (the API's recipes.filename
// column, via api-backend.js's saveRecipe()) so it is validated against this before it ever
// reaches path.join — see the caller in writeRecipe() below.
const SAFE_RECIPE_FILENAME_RE = /^\d{4}_[a-z0-9_]{1,40}\.md$/;

// (C1346) Resolve a PROJECT-scoped recipes dir under .tipatask/, not ai/todo/recipes — recipes
// are app-generated state with no external reader (getRecipes() in api mode reads only from
// the API; see tt-recipe-history.md), so they belong alongside the project's other app state
// (.tipatask/config.json, knowledge-versions.json, images/, files/), not inside ai/.
//
// Returns null (caller skips — no local copy, non-fatal) when projectRoot is missing, or when
// it is/contains the running app.asar. That guard matters: api-backend.js's _projectRoot falls
// back to config.PROJECT_ROOT when no project is bound, and in a packaged Electron build that
// guess is the app BUNDLE itself (C1318) — writing there would break the code signature's seal
// exactly like the TODO.md/recipes regression this task exists to fix, just via a new path.
function resolveRecipesDir(projectRoot) {
  if (!projectRoot) return null;
  if (isAsarPath(projectRoot)) return null;
  if (config.containsPath(projectRoot, config.SERVER_ROOT)) return null;
  return path.join(projectRoot, '.tipatask', 'recipes');
}

async function ensureRecipesDir(dir) {
  // (C1346/C1353) TRIPWIRE — the file task backend's own equivalent check (file-ops.js) was
  // deleted with that backend, C1353. This is now the last mkdir on this lineage's crash path
  // (a recipes dir resolving inside a packaged app.asar); see config.js#assertWritableDataDir.
  config.assertWritableDataDir(dir, 'recipes dir');
  await fs.mkdir(dir, { recursive: true });
}

async function listRecipes(dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const mdFiles = files.filter(f => /^\d{4}_.*\.md$/.test(f)).sort().reverse();
  const recipes = [];
  for (const filename of mdFiles) {
    const content = await fs.readFile(path.join(dir, filename), 'utf8');
    recipes.push({ filename, content });
  }
  return recipes;
}

async function writeRecipe(dir, content, { fallbackSlug = 'recipe', preferredFilename = null } = {}) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    files = [];
  }
  const mdFiles = files.filter(f => f.endsWith('.md'));
  const nums = mdFiles
    .map(f => { const m = f.match(/^(\d{4})_/); return m ? parseInt(m[1], 10) : 0; })
    .filter(n => n > 0);

  // Deduplicate: if the latest recipe has identical content, skip writing.
  if (nums.length > 0) {
    const maxNum = Math.max(...nums);
    const latestFile = mdFiles.find(f => f.startsWith(String(maxNum).padStart(4, '0') + '_'));
    if (latestFile) {
      const existing = await fs.readFile(path.join(dir, latestFile), 'utf8');
      if (existing.trim() === content.trim()) {
        return { filename: latestFile, duplicate: true };
      }
    }
  }

  // (C1576) Prefer the API-assigned filename (recipes.filename, threaded in by
  // api-backend.js's saveRecipe()) so the local mirror matches the DB byte-for-byte,
  // counter included — the local NNNN and the API's are computed from different
  // populations (this dir's contents vs. all of this project's DB rows) and drift apart
  // permanently otherwise. Validated + basename-checked since it arrived over the network.
  // Falls back to local generation (now transliterated, same rule as recipe-filename.js)
  // when absent or malformed. Either way, the dedup check above already ran first — a
  // preferred name can never resurrect a duplicate write.
  let filename;
  if (preferredFilename
      && SAFE_RECIPE_FILENAME_RE.test(preferredFilename)
      && path.basename(preferredFilename) === preferredFilename) {
    filename = preferredFilename;
  } else {
    const next = (nums.length > 0 ? Math.max(...nums) : 0) + 1;
    const prefix = String(next).padStart(4, '0');
    const slug = transliterate(content).split(/\s+/).slice(0, 4).join('_')
      .replace(/[^a-z0-9_]/g, '').slice(0, 40) || fallbackSlug;
    filename = `${prefix}_${slug}.md`;
  }

  await fs.writeFile(path.join(dir, filename), content.trim() + '\n', 'utf8');
  return { filename, duplicate: false };
}

module.exports = { resolveRecipesDir, ensureRecipesDir, listRecipes, writeRecipe };
