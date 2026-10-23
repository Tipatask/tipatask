import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BANNER_ENTRY = path.join(ROOT, 'src', 'client', 'desktop-notifications.js');

// (TPT9061) Electron loads main/*.html and assets/*.html straight from the source tree (from
// app.asar when packaged), so a <script type="module"> there runs our client modules unbundled:
// main/desktop-notifications.html → desktop-notifications.js → notification-page.js → i18n.js.
// A browser module loader has no CommonJS interop, no import map for bare specifiers and no
// extension, index or case-insensitive resolution. One such import anywhere in the graph fails
// module linking and the page renders nothing (a CommonJS import in i18n.js left the banner with
// no cards), while the esbuild board bundle and Node's own interop in the other client tests keep
// passing. Pages under src/ are served bundled, so only the loadFile() directories are walked.
//
// Matching is intentionally simple, like dialogs.test.js: line-anchored regexes over code lines
// with comment lines dropped, not a parser — good enough for our own sources.
const PAGE_DIRS = ['main', 'assets'];
const STATIC_IMPORT = /^\s*import\s*(?:[\w$*{},\s]+?\s*from\s*)?(['"])([^'"\n]+)\1/gm;
const RE_EXPORT = /^\s*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const LITERAL_IMPORT_CALL = /import\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/y;
const COMMONJS = [
  [/\bmodule\.exports\b/, 'module.exports'],
  [/(?<![\w$.])exports\.[\w$]+\s*=(?!=)/, 'exports.<name> ='],
  [/(?<![\w$.])require\s*\(/, 'require()'],
];

// Source lines with comment-only lines blanked and trailing `//` comments cut; keeps line numbers.
function codeLines(source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
    return line.replace(/(^|\s)\/\/.*$/, '$1');
  });
}

// Import specifiers in source order; null for an import() whose argument is not a string literal.
function importSpecifiers(source) {
  const code = codeLines(source).join('\n');
  const found = [];
  for (const re of [STATIC_IMPORT, RE_EXPORT]) {
    for (const m of code.matchAll(re)) found.push([m.index, m[2]]);
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) {
    LITERAL_IMPORT_CALL.lastIndex = m.index;
    found.push([m.index, LITERAL_IMPORT_CALL.exec(code)?.[2] ?? null]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, spec]) => spec);
}

function commonJsMarkers(source) {
  return codeLines(source).flatMap((line, i) =>
    COMMONJS.filter(([re]) => re.test(line)).map(([, what]) => ({ line: i + 1, what })));
}

// Node's format for the file: .mjs, or .js under the nearest package.json's "type" (CommonJS when
// it has none). Page modules must be ES modules for Node too, so the browser and Node agree.
function nodeFormat(file) {
  if (file.endsWith('.mjs')) return 'module';
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).type === 'module' ? 'module' : 'commonjs';
    if (dir === ROOT || dir === path.dirname(dir)) return 'commonjs';
  }
}

// The exact on-disk spelling: macOS volumes ignore case but app.asar does not, so a miscased
// import would load in development and fail only in the packaged app.
function existsExactly(file) {
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let at = ROOT;
  for (const part of rel.split(path.sep)) {
    try {
      if (!fs.readdirSync(at).includes(part)) return false;
    } catch {
      return false;
    }
    at = path.join(at, part);
  }
  return fs.statSync(at).isFile();
}

function moduleEntries() {
  return PAGE_DIRS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    return fs.readdirSync(abs).filter((name) => name.endsWith('.html')).flatMap((name) => {
      const html = fs.readFileSync(path.join(abs, name), 'utf8');
      return [...html.matchAll(/<script\b([^>]*)>/gi)]
        .filter(([, attrs]) => /\btype\s*=\s*["']module["']/i.test(attrs))
        .map(([, attrs]) => attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1])
        .filter(Boolean)
        .map((src) => path.resolve(abs, src));
    });
  });
}

// Breadth-first over the relative imports; returns every reached file and every problem found.
function walk(entries) {
  const reached = new Set();
  const violations = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (reached.has(file)) continue;
    reached.add(file);
    const rel = path.relative(ROOT, file);
    if (!existsExactly(file)) { violations.push(`${rel}: page script is not an existing file exactly as written`); continue; }
    if (nodeFormat(file) !== 'module') violations.push(`${rel}: CommonJS for Node (.js outside a "type": "module" package)`);
    const source = fs.readFileSync(file, 'utf8');
    for (const { line, what } of commonJsMarkers(source)) violations.push(`${rel}:${line}: CommonJS ${what}`);
    for (const spec of importSpecifiers(source)) {
      if (spec === null) { violations.push(`${rel}: import() of a non-literal specifier cannot be checked`); continue; }
      if (!/^\.\.?\//.test(spec)) { violations.push(`${rel}: bare specifier '${spec}' (no import map on this page)`); continue; }
      const target = path.resolve(path.dirname(file), spec);
      if (!/\.m?js$/.test(target)) { violations.push(`${rel}: '${spec}' is not a .js/.mjs module`); continue; }
      if (!existsExactly(target)) {
        violations.push(`${rel}: '${spec}' is not an existing file exactly as written (no extension, index or case-insensitive resolution)`);
        continue;
      }
      queue.push(target);
    }
  }
  return { reached, violations };
}

test('every module a raw module page reaches is a browser-loadable ES module', () => {
  const entries = moduleEntries();
  assert.ok(entries.includes(BANNER_ENTRY),
    `banner entry not discovered: ${entries.map((e) => path.relative(ROOT, e)).join(', ') || 'none'}`);
  const { reached, violations } = walk(entries);
  assert.ok(reached.size > entries.length, 'the walk followed no imports');
  assert.deepEqual(violations, [], 'A raw module page cannot load these and would render nothing. Make a shared module an'
    + ` ES module (.mjs, like src/image-task-copy.mjs) or keep it out of the page's import graph:\n${violations.join('\n')}`);
});

test('the import scanner and CommonJS checks read our module syntax', () => {
  const esm = [
    'import { a,',
    "  b } from './multi.js';",
    "import './side-effect.js';",
    "export * from '../re-export.mjs';",
    "export * as ns from './ns.js';",
    'export {',
    '  c,',
    "} from './braces.js';",
    "// import { gone } from './commented.js';",
    "const lazy = () => import('./lazy.js');",
    'const opaque = () => import(name);',
    "obj.require('x'); // require() in a comment",
    "export const label = { 'gmail.from': 'From' };",
    'export function f() { return 1; }',
  ].join('\n');
  assert.deepEqual(importSpecifiers(esm),
    ['./multi.js', './side-effect.js', '../re-export.mjs', './ns.js', './braces.js', './lazy.js', null]);
  assert.deepEqual(commonJsMarkers(esm), []);
  const cjs = "'use strict';\nconst x = require('./x');\nexports.y = 1;\nmodule.exports = { x };";
  assert.deepEqual(commonJsMarkers(cjs).map(({ line, what }) => `${line} ${what}`),
    ['2 require()', '3 exports.<name> =', '4 module.exports']);
  assert.equal(nodeFormat(path.join(ROOT, 'src', 'shared.js')), 'commonjs');
  assert.equal(nodeFormat(path.join(ROOT, 'src', 'shared.mjs')), 'module');
  assert.equal(nodeFormat(path.join(ROOT, 'src', 'client', 'page.js')), 'module');
  assert.equal(existsExactly(BANNER_ENTRY), true);
  assert.equal(existsExactly(path.join(ROOT, 'src', 'client', 'Desktop-notifications.js')), false);
});
