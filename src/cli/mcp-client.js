'use strict';

const path = require('node:path');

/**
 * Spawn the Tipatask MCP server as a child process and return a tiny
 * JSON-RPC client handle that lets callers invoke tools by name.
 *
 * The MCP SDK is ESM-only, so this helper wraps the async dynamic imports.
 *
 * @param {object} [opts]
 * @param {string} [opts.scriptPath]  Absolute path to the MCP server script.
 *                                    Defaults to this repo's `src/mcp/server.js`.
 * @param {string} [opts.cwd]         Working directory for the child.
 *                                    Defaults to the Task App repo root.
 */
async function spawnMcpClient(opts = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const scriptPath = opts.scriptPath || path.resolve(__dirname, '..', 'mcp', 'server.js');
  const cwd = opts.cwd || path.resolve(__dirname, '..', '..');

  const transport = new StdioClientTransport({
    command: process.execPath || 'node',
    args: [scriptPath],
    cwd,
    env: process.env,
  });

  const client = new Client(
    { name: 'tipatask-setup', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    /**
     * Call a tool by name with an argument object. Returns the first text
     * content block parsed as JSON when possible, else the raw string.
     */
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args || {} });
      const first = Array.isArray(result.content) ? result.content[0] : null;
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      }
      return result;
    },
    async close() {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}

module.exports = { spawnMcpClient };
