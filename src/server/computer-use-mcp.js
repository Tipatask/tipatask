'use strict';

// Per-connection native state + a per-run live gate. No saved app grants, global input,
// clipboard, shell tools, or fallback to Claude's sessionless standalone server.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const os = require('node:os');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const SESSION_ERROR = 'Computer-use session unavailable or expired. Start a fresh task from an updated Task App; standalone registration cannot restore app grants.';
const app = { type: 'string', description: 'Exact installed application bundle identifier. Never use the live TipATask app.' };
const tools = [
  { name: 'request_access', description: 'Ask the user to approve specific apps for this tool connection. Denial grants no authority. OS permissions are separate.', properties: { apps: { type: 'array', items: app, minItems: 1, maxItems: 8 }, reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['apps', 'reason'] },
  { name: 'list_granted_applications', description: 'List this connection’s app grants. A fresh connection starts empty.', properties: {}, required: [] },
  { name: 'open_application', description: 'Open or activate an explicitly approved app for interaction.', properties: { app }, required: ['app'] },
  { name: 'screenshot', description: 'Capture only one approved app window. Coordinates refer to this image, never the full desktop.', properties: { app, window_id: { type: 'integer', minimum: 1 } }, required: ['app'] },
  { name: 'left_click', description: 'Press or focus the accessible control at coordinates inside the last approved-app screenshot. Unsupported controls return an error; no global mouse input.', properties: { app, coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, required: ['app', 'coordinate'] },
  { name: 'type', description: 'Insert text at the selection of the approved app’s focused accessible text control after a screenshot. No clipboard, global keys or system combinations.', properties: { app, text: { type: 'string', maxLength: 2000 } }, required: ['app', 'text'] },
].map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

function nativeClient(binary, env = process.env) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: env.LANG || 'en_US.UTF-8',
    TIPATASK_DESKTOP_URL: env.TIPATASK_DESKTOP_URL || '',
    TIPATASK_DESKTOP_TOKEN: env.TIPATASK_DESKTOP_TOKEN || '',
    TIPATASK_DESKTOP_LOCALE: env.TIPATASK_DESKTOP_LOCALE || 'en',
  } });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-1500); });
  let pending = null;
  const lines = readline.createInterface({ input: child.stdout });
  const close = (code, signal) => { pending?.reject(new Error(`Desktop helper exited (${signal || code || 'connection closed'}). ${stderr.trim()} Restart the task to obtain fresh app consent.`)); pending = null; };
  child.on('error', close);
  child.on('exit', close);
  child.stdin.on('error', close);
  lines.on('line', line => {
    const request = pending;
    pending = null;
    if (!request) return;
    try { const result = JSON.parse(line); if (result.error) throw new Error(result.error); request.resolve(result); }
    catch (err) { request.reject(err); }
  });
  return {
    call(name, args) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.killed) return reject(new Error('Desktop helper is not running.'));
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error('Desktop helper timed out. Restart the tool connection and approve the test app again.'));
          child.kill();
        }, 135000);
        pending = { resolve(value) { clearTimeout(timer); resolve(value); }, reject(err) { clearTimeout(timer); reject(err); } };
        child.stdin.write(JSON.stringify({ name, arguments: args }) + '\n');
      });
    },
    close() { close(); lines.close(); child.stdin.destroy(); child.kill(); },
  };
}

async function serve({ binary, env = process.env, native = nativeClient } = {}) {
  let helper = null;
  let tail = Promise.resolve();
  const server = new Server({ name: 'tipatask-computer-use', version: '1.0.0' }, { capabilities: { tools: {} } });
  const check = async (name, args) => {
    const url = env.TIPATASK_DESKTOP_URL;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/check$/.test(url || '') || !env.TIPATASK_DESKTOP_TOKEN) throw new Error(SESSION_ERROR);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.TIPATASK_DESKTOP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: `computer-use__${name}`, tool_input: args }), signal: AbortSignal.timeout(15000) });
    } catch { throw new Error(SESSION_ERROR); }
    if (!response.ok) throw new Error(SESSION_ERROR);
    const verdict = await response.json();
    if (verdict.decision !== 'allow') throw new Error(verdict.reason || SESSION_ERROR);
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Discovery must prove live session authority; enumeration alone is not availability.
    await check('list_granted_applications', {});
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, request => {
    const run = tail.then(async () => {
      try {
        const { name, arguments: args = {} } = request.params;
        if (!tools.some(tool => tool.name === name)) throw new Error('Unsupported desktop action.');
        await check(name, args);
        helper ||= native(binary, env);
        const result = await helper.call(name, args);
        // Consent/capture can take time. Recheck before returning any authority or pixels.
        await check(name, args);
        if (result.image) {
          const { image, ...metadata } = result;
          return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: 'image/png', data: image }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err.message === SESSION_ERROR) { helper?.close(); helper = null; }
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    });
    tail = run.catch(() => {});
    return run;
  });
  const close = () => { helper?.close(); helper = null; };
  server.onclose = close;
  process.once('SIGTERM', () => { close(); process.exit(0); });
  process.stdin.once('end', close);
  await server.connect(new StdioServerTransport());
  return server;
}

if (require.main === module) serve({ binary: process.argv[2] }).catch(() => { process.stderr.write(SESSION_ERROR + '\n'); process.exitCode = 1; });
module.exports = { serve, SESSION_ERROR };
