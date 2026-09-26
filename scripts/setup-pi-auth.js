#!/usr/bin/env node
'use strict';

// Idempotent bootstrap of ~/.pi/agent/auth.json (Method A) from OPENROUTER_API_KEY.
// Run once after installing pi and setting the key in your project config or env.
//
// Usage (from the Task App checkout or the project root):
//   OPENROUTER_API_KEY=sk-or-v1-... node scripts/setup-pi-auth.js
//
// Env overrides:
//   PI_CODING_AGENT_DIR — override Pi config dir (default: ~/.pi/agent)
//
// Key format written (per pi.dev auth.md / confirmed OpenRouter setup):
//   { "openrouter": { "type": "api_key", "key": "<key>" } }
//
// Idempotent: if auth.json already contains openrouter.key, exits cleanly without
// touching the file. Never fatal — warns and exits 0 on any FS error so it never
// breaks a spawn pipeline.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.log('[setup-pi-auth] OPENROUTER_API_KEY not set — skipping auth.json bootstrap.');
  process.exit(0);
}

const configDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), '.pi', 'agent');
const authPath = path.join(configDir, 'auth.json');

try {
  const existing = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (existing && existing.openrouter && existing.openrouter.key) {
    console.log(`[setup-pi-auth] auth.json already configured — skipping (${authPath})`);
    process.exit(0);
  }
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.warn(`[setup-pi-auth] could not read existing auth.json (${e.message}) — will overwrite.`);
  }
}

try {
  fs.mkdirSync(configDir, { recursive: true });
  const content = JSON.stringify({ openrouter: { type: 'api_key', key } }, null, 2) + '\n';
  fs.writeFileSync(authPath, content, 'utf8');
  console.log(`[setup-pi-auth] wrote auth.json → ${authPath}`);
} catch (e) {
  console.warn(`[setup-pi-auth] failed to write auth.json: ${e.message}`);
  process.exit(0);
}
