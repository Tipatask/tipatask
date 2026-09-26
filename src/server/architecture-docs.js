'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const ARCH_DIR = path.join(config.PROJECT_ROOT, 'ai/architecture');
const FILE_REF_RE = /(?:^|\s)@([\w.\/-]+\.\w+)/g;

function extractFilePaths(text) {
  const refs = new Set();
  let m;
  while ((m = FILE_REF_RE.exec(text)) !== null) refs.add(m[1]);
  return refs;
}

function buildStub(tag, tasks) {
  const tagged = tasks.filter(t => Array.isArray(t.tags) && t.tags.includes(tag));
  if (tagged.length === 0) return null;

  const overview = tagged[0].title || tag;

  const allPaths = new Set();
  for (const t of tagged) {
    const desc = [t.title || '', t.description || ''].join(' ');
    FILE_REF_RE.lastIndex = 0;
    for (const p of extractFilePaths(desc)) allPaths.add(p);
  }
  const keyFiles = allPaths.size > 0
    ? [...allPaths].map(p => `- \`${p}\``).join('\n')
    : '_(none detected)_';

  const behavior = tagged
    .map((t, i) => `${i + 1}. ${t.title || '(untitled)'}`)
    .join('\n');

  return `# ${tag}\n\n## Overview\n\n${overview}\n\n## Key Files\n\n${keyFiles}\n\n## Behavior\n\n${behavior}\n\n## Implementation Notes\n\n_(auto-generated stub — expand with specific schema, endpoints, state, and interaction details)_\n`;
}

async function ensureArchitectureDocs(tasks) {
  const ttTags = new Set();
  for (const t of tasks) {
    if (Array.isArray(t.tags)) {
      for (const tag of t.tags) {
        if (tag.startsWith('tt-')) ttTags.add(tag);
      }
    }
  }
  if (ttTags.size === 0) return;

  for (const tag of ttTags) {
    const filePath = path.join(ARCH_DIR, tag + '.md');
    try {
      await fs.access(filePath);
      // exists — skip
    } catch {
      const stub = buildStub(tag, tasks);
      if (!stub) continue;
      await fs.writeFile(filePath, stub, 'utf8');
      console.log(`[arch-docs] Created stub: ai/architecture/${tag}.md`);
    }
  }
}

async function ensureArchitectureDocsForChanges(changes) {
  const tasks = changes
    .filter(c => c.task)
    .map(c => c.task);
  await ensureArchitectureDocs(tasks);
}

// buildStub exported for tag-doc-link.js (C1237) — task-derived stub fallback when a
// new tt-* tag's new_tags entry carries no architecture_hint.
module.exports = { ensureArchitectureDocs, ensureArchitectureDocsForChanges, buildStub };
