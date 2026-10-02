// Pi extension loaded by task-chat turns (`pi --no-extensions -e <this file>`). It registers the
// single `tipatask_api` tool — Pi's replacement for the tipatask MCP task tools, and the only
// way a Pi task chat can change anything: the turn runs with no bash, edit or write tool.
// Every request goes through resolveTipataskRequest(), which pins the URL to this project's API
// root and to a fixed list of method + path shapes. Credentials come from the spawn environment
// and never appear in a tool result.

import { Type } from "typebox";
import requestGate from "./tipatask-request.cjs";

const { resolveTipataskRequest } = requestGate;

const MAX_RESULT_CHARS = 60000;

function text(value) {
  return { content: [{ type: "text", text: value }], details: {} };
}

export default function (pi) {
  pi.registerTool({
    name: "tipatask_api",
    label: "Tipatask API",
    description:
      "Call the Tipatask REST API for the current project: read, create, update, comment on, tag and delete tasks. " +
      "`path` is relative to the project (for example /tasks/TPT1). Returns the HTTP status and the JSON response.",
    promptSnippet: "Read and change Tipatask tasks, comments and tags over REST",
    parameters: Type.Object({
      method: Type.Optional(Type.String({ description: "GET (default), POST, PATCH or DELETE" })),
      path: Type.String({ description: "Project-relative path, e.g. /tasks, /tasks/TPT1/comments, /tags" }),
      body: Type.Optional(Type.Any({ description: "JSON object body for POST and PATCH" })),
    }),
    async execute(_toolCallId, params, signal) {
      const request = resolveTipataskRequest(params, process.env);
      if (!request.ok) return text(`Rejected: ${request.error}`);
      try {
        const res = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal,
        });
        const raw = await res.text();
        const shown = raw.length > MAX_RESULT_CHARS
          ? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${raw.length} chars total — narrow the request)`
          : raw;
        return text(`HTTP ${res.status}\n${shown}`);
      } catch (err) {
        return text(`Request failed: ${err && err.message ? err.message : String(err)}`);
      }
    },
  });
}
