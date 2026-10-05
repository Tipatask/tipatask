// Pi extension that bridges MCP servers into native Pi tools. Pi has no MCP support by design;
// this extension reads a `.mcp.json`-shaped file named by TIPATASK_PI_MCP_CONFIG, opens one
// @modelcontextprotocol/sdk Client per server and registers every tool the server lists as
// `<server>__<tool>`. Pi loads it with `-e <path>` from USER_DATA_ROOT/pi-ext/, where there is no
// node_modules, so build.js's bundlePiExt() inlines the SDK into dist/pi-ext/mcp-bridge.mjs and
// providers/pi-task-tools.js stages that bundle — Pi never loads this source file directly.
//
// Servers are connected in `session_start`, not in the factory: Pi may run extension factories
// in invocations that never start a session, and must not leave MCP child processes behind.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CONFIG_ENV = "TIPATASK_PI_MCP_CONFIG";
const MAX_RESULT_CHARS = 60000;
const MAX_TOOL_NAME = 64;
const CONNECT_TIMEOUT_MS = 15000;
const HEADERS_HELPER_TIMEOUT_MS = 10000;
const CLIENT_INFO = { name: "tipatask-pi-mcp-bridge", version: "1.0.0" };

// `${VAR}` and `${VAR:-default}`, the same expansion Claude Code applies to .mcp.json.
export function expandEnvVars(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    return fallback !== undefined ? fallback : "";
  });
}

function expandRecord(record, env) {
  const out = {};
  if (!record || typeof record !== "object") return out;
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue;
    out[k] = expandEnvVars(String(v), env);
  }
  return out;
}

// Returns the `mcpServers` map, or {} when the file is missing, unreadable or malformed.
export function readMcpConfig(configPath) {
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const servers = parsed && parsed.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
  } catch {
    return {};
  }
}

// Provider tool names must match ^[A-Za-z0-9_-]{1,64}$.
export function mcpToolName(server, tool) {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

export function flattenToolResult(result) {
  const parts = [];
  for (const item of (result && Array.isArray(result.content)) ? result.content : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") parts.push(String(item.text ?? ""));
    else if (item.type === "resource" && item.resource) {
      if (typeof item.resource.text === "string") parts.push(item.resource.text);
      else parts.push(`[resource: ${item.resource.uri || "binary"}]`);
    } else if (item.type === "resource_link") parts.push(`[resource: ${item.uri || item.name || "link"}]`);
    else if (item.type === "image" || item.type === "audio") parts.push(`[${item.type}: ${item.mimeType || "unknown"}]`);
    else parts.push(`[${item.type || "content"}]`);
  }
  let out = parts.join("\n");
  if (!out && result && result.structuredContent !== undefined) out = JSON.stringify(result.structuredContent);
  if (!out && result && result.toolResult !== undefined) out = JSON.stringify(result.toolResult);
  if (result && result.isError) out = `Error: ${out || "tool reported an error"}`;
  if (out.length > MAX_RESULT_CHARS) {
    out = `${out.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${out.length} chars total — narrow the request)`;
  }
  return out;
}

// headersHelper is a shell command printing a JSON object of header name → value
// (src/mcp/auth-header-helper.js). Any failure contributes no headers; the values are never logged.
function runHeadersHelper(command, name, url, env) {
  if (!command) return {};
  try {
    const res = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      timeout: HEADERS_HELPER_TIMEOUT_MS,
      env: { ...env, CLAUDE_CODE_MCP_SERVER_NAME: name, CLAUDE_CODE_MCP_SERVER_URL: url },
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || !res.stdout) return {};
    const parsed = JSON.parse(res.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const headers = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") headers[k] = v;
    return headers;
  } catch {
    return {};
  }
}

function buildTransport(name, entry, env) {
  if (entry.command) {
    return new StdioClientTransport({
      command: expandEnvVars(String(entry.command), env),
      args: Array.isArray(entry.args) ? entry.args.map((a) => expandEnvVars(String(a), env)) : [],
      env: { ...env, ...expandRecord(entry.env, env) },
      cwd: entry.cwd ? expandEnvVars(String(entry.cwd), env) : undefined,
      // Pi's --mode json owns stdout; server chatter must not reach the parent's streams.
      stderr: "ignore",
    });
  }
  if (entry.url) {
    const type = entry.type || "http";
    if (type !== "http" && type !== "streamable-http") throw new Error(`unsupported transport type "${type}"`);
    const url = expandEnvVars(String(entry.url), env);
    const headers = { ...expandRecord(entry.headers, env), ...runHeadersHelper(entry.headersHelper, name, url, env) };
    return new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  }
  throw new Error("entry has neither `command` nor `url`");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function connectOne(name, entry, env, timeoutMs) {
  const client = new Client(CLIENT_INFO);
  try {
    await withTimeout((async () => {
      await client.connect(buildTransport(name, entry, env));
    })(), timeoutMs, "connect");
    const tools = [];
    let cursor;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeoutMs, "tools/list");
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    return { name, client, tools };
  } catch (err) {
    try { await client.close(); } catch { /* already closed */ }
    throw err;
  }
}

// Opens one MCP client per server in the config file. One failing server never blocks the others:
// it is closed and reported in `errors`. `close()` is idempotent.
export async function connectMcpServers(configPath, { env = process.env, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const entries = Object.entries(readMcpConfig(configPath))
    .filter(([, entry]) => entry && typeof entry === "object" && !entry.disabled);
  const settled = await Promise.allSettled(entries.map(([name, entry]) => connectOne(name, entry, env, timeoutMs)));
  const servers = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") servers.push(s.value);
    else errors.push({ name: entries[i][0], message: (s.reason && s.reason.message) || String(s.reason) });
  });
  let closed = false;
  return {
    servers,
    errors,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(servers.map((s) => s.client.close()));
    },
  };
}

function toolParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") return { type: "object", properties: {} };
  const { $schema, ...rest } = inputSchema;
  if (!rest.type) rest.type = "object";
  if (rest.type === "object" && !rest.properties) rest.properties = {};
  return rest;
}

function text(value) {
  return { content: [{ type: "text", text: value }], details: {} };
}

export function registerMcpTools(pi, servers) {
  const registered = [];
  const seen = new Set();
  for (const { name: server, client, tools } of servers) {
    for (const tool of tools) {
      const name = mcpToolName(server, tool.name);
      if (seen.has(name)) {
        console.error(`[mcp-bridge] skipped ${server}/${tool.name}: tool name ${name} already registered`);
        continue;
      }
      seen.add(name);
      pi.registerTool({
        name,
        label: `${server}: ${tool.title || (tool.annotations && tool.annotations.title) || tool.name}`,
        description: tool.description || `MCP tool ${tool.name} from server ${server}`,
        parameters: toolParameters(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          try {
            const result = await client.callTool({ name: tool.name, arguments: params || {} }, undefined, { signal });
            return text(flattenToolResult(result));
          } catch (err) {
            return text(`MCP call failed: ${(err && err.message) || String(err)}`);
          }
        },
      });
      registered.push(name);
    }
  }
  return registered;
}

export default function (pi) {
  const configPath = process.env[CONFIG_ENV];
  if (!configPath) return;
  let connection = null;
  pi.on("session_start", async () => {
    if (connection) return;
    connection = await connectMcpServers(configPath);
    for (const e of connection.errors) console.error(`[mcp-bridge] server ${e.name} unavailable: ${e.message}`);
    registerMcpTools(pi, connection.servers);
  });
  pi.on("session_shutdown", async () => {
    const open = connection;
    connection = null;
    if (open) await open.close();
  });
}
