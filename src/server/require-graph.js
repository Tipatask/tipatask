'use strict';

const path = require('node:path').posix;

// readFile is synchronous and returns source text/Buffer, or null/undefined for a
// missing file. Filesystem ENOENT/ENOTDIR/EISDIR errors also mean no candidate;
// other read failures propagate. No modules are executed while walking.
function collectRelativeRequires(entryFiles, { readFile }) {
  const resolved = new Set();
  const missing = [];
  const sources = new Map();
  const normalize = file => path.normalize(file.replace(/\\/g, '/'));

  function read(file) {
    if (!sources.has(file)) {
      let source;
      try { source = readFile(file); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
      }
      sources.set(file, source == null ? null : source.toString());
    }
    return sources.get(file);
  }

  function visit(file, source) {
    if (resolved.has(file)) return;
    resolved.add(file);
    // JSON and native modules are dependencies, but contain no JavaScript requires.
    if (/\.(?:json|node)$/.test(file)) return;
    const requires = /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"\r\n]+)\1\s*\)/g;
    for (const match of source.matchAll(requires)) {
      const spec = match[2];
      const base = path.join(path.dirname(file), spec);
      const target = [base, `${base}.js`, path.join(base, 'index.js')]
        .find(candidate => read(candidate) !== null);
      if (target) visit(target, read(target));
      else missing.push({ from: file, spec });
    }
  }

  for (const entry of entryFiles) {
    const file = normalize(entry);
    const source = read(file);
    if (source === null) missing.push({ from: file, spec: entry });
    else visit(file, source);
  }
  return { resolved, missing };
}

module.exports = { collectRelativeRequires };
