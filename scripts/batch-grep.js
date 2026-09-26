'use strict';

// CLI wrapper around src/mcp/batch-grep.js
// Usage: node batch-grep.js <tag1> [tag2...] [--paths dir1,dir2] [--symbols a,b,c] [--cross-refs] [--validate-only] [--json]

const path = require('path');
const { runBatchGrep, REPO_ROOT } = require('../src/mcp/batch-grep');

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: node batch-grep.js <tag1> [tag2...] [--paths dir1,dir2] [--symbols a,b,c] [--cross-refs] [--validate-only] [--json]');
  console.log('Example: node batch-grep.js tt-api-tasks tt-mcp-server tt-task-board --cross-refs');
  console.log('         node batch-grep.js tt-task-board --symbols loadAndRender,renderTodoContent');
  console.log('         node batch-grep.js tt-api-tasks tt-task-board --validate-only');
  process.exit(args.length ? 0 : 1);
}

let jsonMode = false;
let customPaths = null;
let symbolList = [];
let crossRefs = false;
let validateOnly = false;
const tags = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') { jsonMode = true; continue; }
  if (args[i] === '--cross-refs') { crossRefs = true; continue; }
  if (args[i] === '--validate-only') { validateOnly = true; continue; }
  if (args[i] === '--paths' && args[i + 1]) { customPaths = args[++i].split(','); continue; }
  if (args[i] === '--symbols' && args[i + 1]) { symbolList = args[++i].split(','); continue; }
  tags.push(args[i]);
}

if (!tags.length) {
  console.error('[batch-grep] no tags specified'); process.exit(1);
}

let batchResult;
try {
  batchResult = runBatchGrep({
    tagNames: tags,
    paths: customPaths || undefined,
    symbols: symbolList.length ? symbolList : undefined,
    crossRefs,
    validateOnly,
  });
} catch (err) {
  console.error(`[batch-grep] ${err.message}`); process.exit(2);
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(batchResult, null, 2) + '\n');
} else if (validateOnly) {
  const { counts, missingTags, tagPatterns } = batchResult;
  for (const tag of tags) {
    console.log(`  ${tag}: ${counts[tag]} hits  (patterns: ${tagPatterns[tag].join(', ')})`);
  }
  if (missingTags && missingTags.length) console.log(`\n  Missing arch docs: ${missingTags.join(', ')}`);
} else {
  const { results, tagPatterns, totalHits, elapsedMs } = batchResult;
  const MAX_HITS_PER_TAG = 30;
  for (const tag of tags) {
    const hits = results[tag];
    console.log(`\n## ${tag} (${hits.length} hits)`);
    console.log(`   patterns: ${tagPatterns[tag].join(', ')}`);
    for (const h of hits) {
      console.log(`   ${h.file}:${h.line}  [${h.pattern}]  ${h.text}`);
    }
    if (hits.length >= MAX_HITS_PER_TAG) console.log(`   ... (capped at ${MAX_HITS_PER_TAG})`);
  }
  if (symbolList.length && results.__symbols__) {
    console.log('\n## __symbols__');
    for (const sym of symbolList) {
      const hits = results.__symbols__[sym] || [];
      console.log(`\n  ${sym} (${hits.length} hits)`);
      for (const h of hits) console.log(`   ${h.file}:${h.line}  ${h.text}`);
    }
  }
  if (crossRefs && batchResult.crossRefs) {
    console.log('\n## Cross-refs');
    for (const [pair, { hits, files }] of Object.entries(batchResult.crossRefs)) {
      console.log(`  ${pair}: ${hits} hit(s) in ${files.join(', ')}`);
    }
    if (!Object.keys(batchResult.crossRefs).length) console.log('  (no overlaps found)');
  }
  const seqEstMs = tags.length * 1200;
  console.log(`\n# batch-grep: ${tags.length} tags, ${Object.values(tagPatterns).flat().length} patterns, ${totalHits} hits in ${elapsedMs}ms (vs ~${seqEstMs}ms sequential)`);
}
