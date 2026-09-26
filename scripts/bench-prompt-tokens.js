'use strict';
// C479: one-shot prompt size auditor. Not part of default build.
// Usage: node scripts/bench-prompt-tokens.js [--out=file.json]
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { getStaticBundle } = require('./src/server/static-context');
const { buildObjectivePrompt } = require('./dist/client-bundle'); // may not exist in bare run
const fs = require('fs');

const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
const tok = c => Math.round(c / 3.6);

// systemPrompt is in client utils.js — read as string and extract template
const utilsSrc = fs.readFileSync('./src/client/utils.js', 'utf8');
const spStart = utilsSrc.indexOf('const systemPrompt = `') + 'const systemPrompt = `'.length;
const spEnd = utilsSrc.indexOf('`;\n\n  let userPrompt', spStart);
const systemPrompt = utilsSrc.slice(spStart, spEnd)
  .replace(/\\n/g, '\n').replace(/\\`/g, '`').replace(/\\\\/g, '\\');

const staticBundle = getStaticBundle();

const sections = [
  ['staticBundle', staticBundle],
  ['  GENERAL.md (est)', staticBundle.slice(staticBundle.indexOf('## General Architecture'), staticBundle.indexOf('## Tag Taxonomy'))],
  ['  Tag taxonomy', staticBundle.slice(staticBundle.indexOf('## Tag Taxonomy'), staticBundle.indexOf('## MCP Tool Schemas'))],
  ['  MCP schemas', staticBundle.slice(staticBundle.indexOf('## MCP Tool Schemas'), staticBundle.indexOf('## Project Conventions') > -1 ? staticBundle.indexOf('## Project Conventions') : staticBundle.length)],
  ['  CONVENTIONS', staticBundle.includes('## Project Conventions') ? staticBundle.slice(staticBundle.indexOf('## Project Conventions')) : '(absent)'],
  ['systemPrompt', systemPrompt],
];

const markers = [
  ['  Intro', '^'],
  ['  Writing Style', 'Writing Style'],
  ['  File-specificity', '━━ FILE-SPECIFICITY'],
  ['  State machine', '━━ TASK STATE MACHINE'],
  ['  WORKFLOW', '━━ REQUIRED WORKFLOW'],
  ['  Tag-names rule', 'Tag names on tasks must'],
  ['  Output format', '━━ REQUIRED OUTPUT FORMAT'],
  ['  Rules+NEW-TAG+CRITICAL', 'Rules:'],
];

// segment systemPrompt by markers
const spSections = [];
const offs = markers.map(([n, p]) => ({ n, off: p === '^' ? 0 : systemPrompt.search(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) })).filter(x => x.off >= 0).sort((a, b) => a.off - b.off);
for (let i = 0; i < offs.length; i++) {
  const next = offs[i + 1] ? offs[i + 1].off : systemPrompt.length;
  spSections.push([offs[i].n, systemPrompt.slice(offs[i].off, next)]);
}

const results = {};
console.log('\n=== Prompt size audit ===');
for (const [name, text] of [...sections, ...spSections]) {
  const chars = typeof text === 'string' ? text.length : 0;
  const t = tok(chars);
  results[name] = { chars, tok: t };
  const bar = '█'.repeat(Math.round(chars / 300));
  console.log(`${name.padEnd(34)} ${String(chars).padStart(6)} c  ~${String(t).padStart(5)} tok  ${bar}`);
}
const totalChars = staticBundle.length + systemPrompt.length;
results['TOTAL'] = { chars: totalChars, tok: tok(totalChars) };
console.log(`\n${'TOTAL PREFIX'.padEnd(34)} ${String(totalChars).padStart(6)} c  ~${String(tok(totalChars)).padStart(5)} tok`);

if (out) {
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('Saved to', out);
}
