'use strict';

const fs = require('fs');
const path = require('path');

const cache = require('./architecture-cache');

const { resolveProjectRoot } = require('../server/project-root');

// Project root when the caller passes none: TIPATASK_PROJECT_ROOT (the spawned MCP server's
// env), else the nearest ancestor of cwd holding .tipatask/config.json, else cwd. Never
// derived from where this checkout lives.
const REPO_ROOT = resolveProjectRoot();
// Conventional source roots; whichever of these exist under the project are scanned. When
// none exists the whole project is walked (walkFiles skips node_modules/.git/dist).
const DEFAULT_SEARCH_PATHS = ['src', 'lib', 'app', 'api', 'packages', 'ai/architecture'];
const FALLBACK_SEARCH_PATHS = ['.'];
const DEFAULT_MAX_HITS = 30;
const DEFAULT_MAX_PATTERNS = 8;

const GENERIC_NAMES = new Set([
  'server', 'client', 'index', 'utils', 'helper', 'config', 'base', 'types', 'main',
  'app', 'api', 'db', 'model', 'schema', 'styles', 'template', 'common', 'core', 'lib',
  'auth', 'router', 'layout', 'build', 'routes', 'middleware', 'migrations', 'test',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function derivePatternsFromArchDoc(content, tagName, maxPatterns) {
  const max = maxPatterns || DEFAULT_MAX_PATTERNS;
  const patterns = new Set([tagName]);

  for (const m of content.matchAll(/`([^`]+\.(?:js|ts|mjs|cjs|json|md|css|html|sh|toml|env|yml|yaml))`/g)) {
    const base = path.basename(m[1]);
    if (base.length <= 3 || base.includes('*')) continue;
    patterns.add(base);
    const noExt = base.replace(/\.[^.]+$/, '');
    if (noExt.length >= 5 && !GENERIC_NAMES.has(noExt) && /[A-Za-z]/.test(noExt)) {
      patterns.add(noExt);
    }
    if (patterns.size >= max) break;
  }

  for (const m of content.matchAll(/^### ([a-z][a-zA-Z0-9_]{3,})\s*$/gm)) {
    if (!GENERIC_NAMES.has(m[1])) patterns.add(m[1]);
    if (patterns.size >= max) break;
  }

  return [...patterns].slice(0, max);
}

// Extract relative file paths listed in an arch doc's Files table.
function deriveFileListFromArchDoc(content) {
  const paths = [];
  for (const m of content.matchAll(/\|\s*`([^`]+\.[a-z]{1,5})`\s*\|/g)) {
    const p = m[1];
    if (!p.includes('*') && p.includes('/')) paths.push(p);
  }
  return paths;
}

function walkFiles(dir, cb) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkFiles(full, cb); continue; }
    if (/\.(js|ts|mjs|cjs|json|md)$/.test(e.name)) cb(full);
  }
}

/**
 * runBatchGrep({ tagNames, paths, maxHitsPerTag, maxPatternsPerTag, symbols, crossRefs, validateOnly })
 *
 * Scans codebase ONCE and groups hits by tag. Replaces N sequential Grep calls.
 *
 * New params (all optional, backward-compatible):
 *   symbols: string[]   — extra identifiers to search; hits returned under results.__symbols__[sym]
 *   crossRefs: boolean  — compute cross-tag file overlap; adds crossRefs: {"tagA→tagB": {hits,files}}
 *   validateOnly: bool  — skip detail, return {counts:{tag:n}, missingTags:[...]} only
 *
 * Returns { results, tagPatterns, totalHits, elapsedMs, crossRefs?, counts?, missingTags? }.
 */
// `<nested>/src` for every nested git checkout (gitlink) the project records — a project that
// vendors another repo (e.g. this Task App as a submodule) keeps that repo's source outside
// the conventional roots above. Read from git's index via discoverNestedRepos(), so no
// directory name is ever assumed. Never throws: no git / not a git checkout → [].
function nestedSourceDirs(baseRoot) {
  try {
    const { discoverNestedRepos } = require('./git-worktree');
    return discoverNestedRepos(baseRoot)
      .map(n => path.join(n.path, 'src'))
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
}

function runBatchGrep({ tagNames, paths, maxHitsPerTag, maxPatternsPerTag, symbols, crossRefs, validateOnly, projectRoot }) {
  const maxHits = maxHitsPerTag || DEFAULT_MAX_HITS;
  const maxPatterns = maxPatternsPerTag || DEFAULT_MAX_PATTERNS;

  // Base root for code search + relative-path reporting. Defaults to REPO_ROOT (dev/dogfood
  // resolution unchanged); the forked multi-project server passes the active project root so
  // grep scans the right tree (C894).
  const baseRoot = projectRoot ? path.resolve(projectRoot) : REPO_ROOT;

  const resolveExisting = (list) => list
    .map(p => (path.isAbsolute(p) ? p : path.join(baseRoot, p)))
    .filter(p => { try { fs.statSync(p); return true; } catch { return false; } });
  let searchPaths = resolveExisting(paths || DEFAULT_SEARCH_PATHS);
  if (!paths) {
    for (const dir of nestedSourceDirs(baseRoot)) {
      if (!searchPaths.some(p => dir === p || dir.startsWith(p + path.sep))) searchPaths.push(dir);
    }
    if (searchPaths.length === 0) searchPaths = resolveExisting(FALLBACK_SEARCH_PATHS);
  }

  // Load arch docs — uses architecture-cache (mtime-cached, avoids redundant reads).
  const tagPatterns = {};
  const tagFileLists = {};  // tag → [relative file paths from arch doc]
  const missingTags = [];
  for (const tag of tagNames) {
    const content = cache.getTagArchitecture(tag, projectRoot);
    if (content === null) {
      missingTags.push(tag);
      tagPatterns[tag] = [tag];
      tagFileLists[tag] = [];
      continue;
    }
    tagPatterns[tag] = derivePatternsFromArchDoc(content, tag, maxPatterns);
    tagFileLists[tag] = deriveFileListFromArchDoc(content);
  }

  if (validateOnly) {
    // Fast path: just check for hits without accumulating detail
    const counts = {};
    for (const tag of tagNames) counts[tag] = 0;

    const tagRegexes = {};
    for (const [tag, patterns] of Object.entries(tagPatterns)) {
      tagRegexes[tag] = patterns.map(p => new RegExp(escapeRegex(p)));
    }

    for (const searchPath of searchPaths) {
      walkFiles(searchPath, (filePath) => {
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
        for (const line of content.split('\n')) {
          for (const [tag, regexes] of Object.entries(tagRegexes)) {
            if (regexes.some(re => re.test(line))) counts[tag]++;
          }
        }
      });
    }

    return { counts, missingTags, tagPatterns, elapsedMs: 0 };
  }

  // Build regex lists — tags + optional symbols pseudo-group
  const tagRegexes = {};
  for (const [tag, patterns] of Object.entries(tagPatterns)) {
    tagRegexes[tag] = patterns.map(p => ({ pattern: p, re: new RegExp(escapeRegex(p)) }));
  }

  const symbolList = (symbols || []).filter(s => s && s.length >= 2);
  const symRegexes = symbolList.map(s => ({ pattern: s, re: new RegExp(escapeRegex(s)) }));

  const t0 = Date.now();
  const results = {};
  for (const tag of tagNames) results[tag] = [];
  const symResults = {};  // symbol → [{file,line,text}]
  for (const s of symbolList) symResults[s] = [];

  const tagKeys = Object.keys(tagRegexes);
  let done = false;

  for (const searchPath of searchPaths) {
    if (done) break;
    walkFiles(searchPath, (filePath) => {
      if (done) return;
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
      const lines = content.split('\n');
      const relPath = path.relative(baseRoot, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const tag of tagKeys) {
          if (results[tag].length >= maxHits) continue;
          for (const { pattern, re } of tagRegexes[tag]) {
            if (re.test(line)) {
              results[tag].push({ file: relPath, line: i + 1, text: line.trim().slice(0, 200), pattern });
              break;
            }
          }
        }
        for (const { pattern, re } of symRegexes) {
          const bucket = symResults[pattern];
          if (bucket.length >= maxHits) continue;
          if (re.test(line)) {
            bucket.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 200) });
          }
        }
      }

      // All buckets full → no more scanning needed
      if (symRegexes.length === 0 && tagKeys.every(t => results[t].length >= maxHits)) done = true;
    });
  }

  if (symbolList.length > 0) results.__symbols__ = symResults;

  const elapsedMs = Date.now() - t0;
  const totalHits = Object.values(results).reduce((s, h) => {
    if (h && typeof h === 'object' && !Array.isArray(h)) {
      return s + Object.values(h).reduce((a, b) => a + b.length, 0);
    }
    return s + h.length;
  }, 0);

  const out = { results, tagPatterns, totalHits, elapsedMs };
  if (missingTags.length > 0) out.missingTags = missingTags;

  if (crossRefs && tagNames.length >= 2) {
    // For each hit in tagA, check if its file is listed in tagB's arch doc.
    // Cheap — derived from already-collected results, no extra file scan.
    const xrefs = {};
    for (const tagA of tagNames) {
      for (const tagB of tagNames) {
        if (tagA === tagB) continue;
        const bFiles = tagFileLists[tagB];
        if (!bFiles.length) continue;
        const hits = results[tagA].filter(h => bFiles.some(bf => h.file.includes(bf) || bf.includes(path.basename(h.file))));
        if (hits.length > 0) {
          const uniqueFiles = [...new Set(hits.map(h => h.file))];
          xrefs[`${tagA}→${tagB}`] = { hits: hits.length, files: uniqueFiles };
        }
      }
    }
    out.crossRefs = xrefs;
  }

  return out;
}

module.exports = { runBatchGrep, derivePatternsFromArchDoc, deriveFileListFromArchDoc, walkFiles, nestedSourceDirs, GENERIC_NAMES, REPO_ROOT, DEFAULT_SEARCH_PATHS };
