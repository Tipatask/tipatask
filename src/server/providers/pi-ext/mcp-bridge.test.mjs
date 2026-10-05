import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import bridge, {
  CONFIG_ENV, connectMcpServers, expandEnvVars, flattenToolResult, mcpToolName, readMcpConfig, registerMcpTools,
} from "./mcp-bridge.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const SDK_SERVER = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
const SDK_STDIO = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
const ZOD = pathToFileURL(require.resolve("zod")).href;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-bridge-"));
}

// A real stdio MCP server with one `echo` tool and one tool that reports an error.
function writeStubServer(dir) {
  const file = path.join(dir, "stub-server.mjs");
  fs.writeFileSync(file, `
import { McpServer } from ${JSON.stringify(SDK_SERVER)};
import { StdioServerTransport } from ${JSON.stringify(SDK_STDIO)};
import { z } from ${JSON.stringify(ZOD)};
const server = new McpServer({ name: "stub", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: "echo:" + text + ":" + (process.env.STUB_MARK || "") }] }));
server.registerTool("fail", { description: "Always fails" },
  async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
await server.connect(new StdioServerTransport());
`);
  return file;
}

function writeConfig(dir, servers) {
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

function stubConfig(dir) {
  const server = writeStubServer(dir);
  return writeConfig(dir, {
    stub: { command: process.execPath, args: [server], env: { STUB_MARK: "${MARK:-fallback}" } },
    broken: { command: path.join(dir, "does-not-exist") },
    nothing: { note: "no command or url" },
  });
}

test("expandEnvVars handles ${VAR} and ${VAR:-default}", () => {
  const env = { A: "one", EMPTY: "" };
  assert.equal(expandEnvVars("${A}/x", env), "one/x");
  assert.equal(expandEnvVars("${MISSING}", env), "");
  assert.equal(expandEnvVars("${MISSING:-d}", env), "d");
  assert.equal(expandEnvVars("${EMPTY:-d}", env), "d");
  assert.equal(expandEnvVars("${A:-d}", env), "one");
  assert.equal(expandEnvVars("plain $A", env), "plain $A");
});

test("readMcpConfig tolerates missing and malformed files", () => {
  const dir = scratch();
  assert.deepEqual(readMcpConfig(path.join(dir, "absent.json")), {});
  assert.deepEqual(readMcpConfig(""), {});
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.deepEqual(readMcpConfig(path.join(dir, "bad.json")), {});
  fs.writeFileSync(path.join(dir, "arr.json"), JSON.stringify({ mcpServers: [] }));
  assert.deepEqual(readMcpConfig(path.join(dir, "arr.json")), {});
  const ok = writeConfig(dir, { a: { command: "x" } });
  assert.deepEqual(readMcpConfig(ok), { a: { command: "x" } });
});

test("mcpToolName prefixes the server and keeps provider-safe characters", () => {
  assert.equal(mcpToolName("tipatask-local", "list_tasks"), "tipatask-local__list_tasks");
  assert.equal(mcpToolName("my.server", "do thing"), "my_server__do_thing");
  assert.equal(mcpToolName("s", "x".repeat(100)).length, 64);
});

test("flattenToolResult joins text and summarizes other content", () => {
  assert.equal(flattenToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(flattenToolResult({ content: [{ type: "image", mimeType: "image/png", data: "x" }] }), "[image: image/png]");
  assert.equal(flattenToolResult({ content: [{ type: "resource", resource: { uri: "u", text: "body" } }] }), "body");
  assert.equal(flattenToolResult({ content: [{ type: "resource", resource: { uri: "file:///b", blob: "x" } }] }), "[resource: file:///b]");
  assert.equal(flattenToolResult({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
  assert.equal(flattenToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }), "Error: boom");
  const long = flattenToolResult({ content: [{ type: "text", text: "z".repeat(70000) }] });
  assert.match(long, /truncated, 70000 chars total/);
  assert.equal(flattenToolResult(undefined), "");
});

test("connectMcpServers lists a stdio server's tools and isolates broken entries", async () => {
  const dir = scratch();
  const conn = await connectMcpServers(stubConfig(dir), { env: { ...process.env, MARK: "m1" } });
  try {
    assert.deepEqual(conn.servers.map((s) => s.name), ["stub"]);
    assert.deepEqual(conn.servers[0].tools.map((t) => t.name).sort(), ["echo", "fail"]);
    assert.deepEqual(conn.errors.map((e) => e.name).sort(), ["broken", "nothing"]);
    const result = await conn.servers[0].client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.equal(flattenToolResult(result), "echo:hi:m1", "entry env is expanded against the bridge env");
  } finally {
    await conn.close();
    await conn.close();
  }
});

test("default export registers <server>__<tool> on session_start and closes on shutdown", async () => {
  const dir = scratch();
  const config = stubConfig(dir);
  const handlers = {};
  const tools = new Map();
  const pi = {
    on(event, fn) { handlers[event] = fn; },
    registerTool(def) { tools.set(def.name, def); },
  };
  const previous = process.env[CONFIG_ENV];
  process.env[CONFIG_ENV] = config;
  try {
    bridge(pi);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = previous;
  }
  assert.equal(tools.size, 0, "the factory itself spawns nothing");
  await handlers.session_start({}, {});
  try {
    assert.deepEqual([...tools.keys()].sort(), ["stub__echo", "stub__fail"]);
    const echo = tools.get("stub__echo");
    assert.equal(echo.parameters.type, "object");
    assert.equal(echo.parameters.$schema, undefined);
    assert.deepEqual(echo.parameters.required, ["text"]);
    const out = await echo.execute("call-1", { text: "yo" }, undefined);
    assert.equal(out.content[0].text, "echo:yo:fallback");
    const failed = await tools.get("stub__fail").execute("call-2", {}, undefined);
    assert.equal(failed.content[0].text, "Error: boom");
  } finally {
    await handlers.session_shutdown({}, {});
  }
  const afterClose = await tools.get("stub__echo").execute("call-3", { text: "x" }, undefined);
  assert.match(afterClose.content[0].text, /^MCP call failed:/);
});

test("default export is a no-op without the config env var", () => {
  const previous = process.env[CONFIG_ENV];
  delete process.env[CONFIG_ENV];
  const calls = [];
  try {
    bridge({ on: (e) => calls.push(e), registerTool: () => calls.push("tool") });
  } finally {
    if (previous !== undefined) process.env[CONFIG_ENV] = previous;
  }
  assert.deepEqual(calls, []);
});

test("registerMcpTools skips a name collision instead of overwriting", () => {
  const names = [];
  const registered = registerMcpTools({ registerTool: (d) => names.push(d.name) }, [
    { name: "a.b", client: {}, tools: [{ name: "t" }] },
    { name: "a_b", client: {}, tools: [{ name: "t" }] },
  ]);
  assert.deepEqual(registered, ["a_b__t"]);
  assert.deepEqual(names, ["a_b__t"]);
});

test("bundlePiExt inlines the SDK and the bundle runs with no node_modules nearby", async () => {
  const { bundlePiExt } = require(path.join(SERVER_ROOT, "build.js"));
  const dir = scratch();
  const out = await bundlePiExt(path.join(dir, "bundle", "mcp-bridge.mjs"));
  const src = fs.readFileSync(out, "utf8");
  // Real import statements only — the SDK's JSDoc examples ("* import { … } from '@modelcontextprotocol/…'")
  // survive bundling as comments.
  assert.doesNotMatch(src, /^\s*(?:import|export)\b[^\n;]*\bfrom\s*["']@modelcontextprotocol/m);
  assert.doesNotMatch(src, /\b(?:require|import)\(\s*["']@modelcontextprotocol/);
  const isolated = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-isolated-")), "mcp-bridge.mjs");
  fs.copyFileSync(out, isolated);
  const mod = await import(pathToFileURL(isolated).href);
  assert.equal(typeof mod.connectMcpServers, "function");
  assert.equal(typeof mod.default, "function");
  const conn = await mod.connectMcpServers(stubConfig(dir));
  try {
    assert.deepEqual(conn.servers[0].tools.map((t) => t.name).sort(), ["echo", "fail"]);
    const result = await conn.servers[0].client.callTool({ name: "echo", arguments: { text: "b" } });
    assert.equal(mod.flattenToolResult(result), "echo:b:fallback");
  } finally {
    await conn.close();
  }
});
