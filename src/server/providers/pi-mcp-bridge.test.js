'use strict';

// The Pi-facing contract of the MCP bridge extension (pi-ext/mcp-bridge.mjs), exercised the way
// Pi drives it: the default-export factory with a fake `pi`, over a real stub stdio MCP server.
// pi-ext/mcp-bridge.test.mjs covers the pure helpers and the esbuild bundle; this suite pins what
// a Pi or SDK bump must not change — tool naming, argument forwarding, result flattening, and an
// unreachable server being skipped with a logged warning that carries no header values.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SDK_SERVER = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const SDK_STDIO = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const ZOD = pathToFileURL(require.resolve('zod')).href;
const SECRET = 'secret-header-value-7c41';

const loadBridge = () => import(pathToFileURL(path.join(__dirname, 'pi-ext', 'mcp-bridge.mjs')).href);

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-bridge-cjs-'));
}

// A real stdio MCP server with one `echo` tool. Its reply has two text parts: the echoed text and
// the arguments exactly as the server received them.
function writeStubServer(dir) {
  const file = path.join(dir, 'stub-server.mjs');
  fs.writeFileSync(file, `
import { McpServer } from ${JSON.stringify(SDK_SERVER)};
import { StdioServerTransport } from ${JSON.stringify(SDK_STDIO)};
import { z } from ${JSON.stringify(ZOD)};
const server = new McpServer({ name: "stub", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo text back",
  inputSchema: { text: z.string(), n: z.number().optional(), tags: z.array(z.string()).optional() },
}, async (args) => ({ content: [
  { type: "text", text: "echo:" + args.text },
  { type: "text", text: JSON.stringify(args) },
] }));
await server.connect(new StdioServerTransport());
`);
  return file;
}

function writeConfig(dir, servers) {
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

// A loopback port with nothing listening on it.
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function fakePi() {
  const handlers = {};
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, fn) { handlers[event] = fn; },
    registerTool(def) { tools.set(def.name, def); },
  };
}

test('connectMcpServers + registerMcpTools: registers stub__echo, forwards args, flattens text parts', async () => {
  const { connectMcpServers, registerMcpTools } = await loadBridge();
  const dir = scratch();
  const conn = await connectMcpServers(writeConfig(dir, { stub: { command: process.execPath, args: [writeStubServer(dir)] } }));
  try {
    assert.deepEqual(conn.errors, []);
    const pi = fakePi();
    assert.deepEqual(registerMcpTools(pi, conn.servers), ['stub__echo']);
    assert.deepEqual([...pi.tools.keys()], ['stub__echo']);

    const echo = pi.tools.get('stub__echo');
    assert.deepEqual(echo.parameters.required, ['text']);
    assert.equal(echo.parameters.$schema, undefined);
    const out = await echo.execute('call-1', { text: 'hi', n: 3, tags: ['a', 'b'] }, undefined);
    assert.deepEqual(out.content, [{ type: 'text', text: 'echo:hi\n{"text":"hi","n":3,"tags":["a","b"]}' }]);
  } finally {
    await conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default export: unreachable servers are skipped with a warning, the reachable one still registers', async (t) => {
  const { default: bridge, CONFIG_ENV } = await loadBridge();
  const dir = scratch();
  const port = await closedPort();
  const config = writeConfig(dir, {
    stub: { command: process.execPath, args: [writeStubServer(dir)] },
    gone: { command: path.join(dir, 'no-such-binary') },
    offline: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${SECRET}` } },
  });
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });

  const pi = fakePi();
  const previous = process.env[CONFIG_ENV];
  process.env[CONFIG_ENV] = config;
  try {
    bridge(pi);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = previous;
  }
  assert.equal(pi.tools.size, 0, 'the factory only subscribes');

  await pi.handlers.session_start({}, {});
  try {
    assert.deepEqual([...pi.tools.keys()], ['stub__echo']);
    const warnings = logged.filter((l) => l.startsWith('[mcp-bridge] server '));
    assert.equal(warnings.length, 2, JSON.stringify(logged));
    assert.ok(warnings.some((l) => l.startsWith('[mcp-bridge] server gone unavailable: ')), JSON.stringify(warnings));
    assert.ok(warnings.some((l) => l.startsWith('[mcp-bridge] server offline unavailable: ')), JSON.stringify(warnings));
    assert.ok(!logged.some((l) => l.includes(SECRET)), 'header values are never logged');

    const out = await pi.tools.get('stub__echo').execute('call-1', { text: 'still here' }, undefined);
    assert.equal(out.content[0].text, 'echo:still here\n{"text":"still here"}');
  } finally {
    await pi.handlers.session_shutdown({}, {});
  }
  const afterClose = await pi.tools.get('stub__echo').execute('call-2', { text: 'x' }, undefined);
  assert.match(afterClose.content[0].text, /^MCP call failed:/);
  fs.rmSync(dir, { recursive: true, force: true });
});
