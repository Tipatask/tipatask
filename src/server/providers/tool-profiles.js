'use strict';

// Named tool fences for headless agent-chat turns. A session with no `toolProfile` runs under
// its provider's objective fence (read-only planner). Pure data + argv fragments — the spawn
// sites (claude-session.js, codex-session.js, pi-session.js) own everything that touches disk.
//
// taskChat: the agent may read the KB and source and change TASKS, never code. Each provider
// enforces that with its own mechanism:
//   claude — --allowedTools/--disallowedTools plus a strict two-server MCP config
//   codex  — read-only sandbox (fresh and resumed turns) plus per-server MCP tool filters
//   pi     — a --tools allowlist with no bash/edit/write, naming the bridged MCP tools when the
//            MCP bridge (providers/pi-ext/mcp-bridge.mjs) is loaded, else the one REST tool

const TASK_CHAT = 'taskChat';

const REMOTE_MCP = 'tipatask';
const LOCAL_MCP = 'tipatask-local';
const remote = name => `mcp__${REMOTE_MCP}__${name}`;
const local = name => `mcp__${LOCAL_MCP}__${name}`;

// Remote `tipatask` tools a task chat may call: task CRUD, comments, tags, KB reads.
const TASK_CHAT_REMOTE_TOOLS = Object.freeze([
  'list_tasks', 'get_task', 'list_task_id_meta', 'create_task', 'update_task', 'delete_task',
  'create_task_comment', 'list_task_resolutions',
  'list_system_tags', 'get_project_tags', 'create_system_tag', 'ensure_project_tag',
  'get_tag_architecture', 'get_tag_architectures',
  'list_knowledge_conflicts', 'get_knowledge_conflict',
]);
// Remote tools kept out of a chat: maintenance/placeholder operations with no chat use.
const TASK_CHAT_REMOTE_DENIED = Object.freeze(['purge_stale_reservations', 'reserve_task_keys']);
// The only `tipatask-local` tool a chat gets. The rest write the local KB checkout, run the
// task-completion flow, or report git state.
const TASK_CHAT_LOCAL_TOOLS = Object.freeze(['batch_grep_tags']);
const TASK_CHAT_LOCAL_DENIED = Object.freeze(['push_knowledge', 'pull_knowledge', 'complete_task', 'git_worktree_status']);

const PI_TASK_API_TOOL = 'tipatask_api';

// Pi tool name the MCP bridge registers for an MCP tool: `<server>__<tool>`, the rule of
// mcpToolName() in providers/pi-ext/mcp-bridge.mjs (both server names are already legal).
const piBridged = server => name => `${server}__${name}`;

// Read-only remote tools an objective planner may call: task reads, tag and KB lookups.
const OBJECTIVE_REMOTE_READ_TOOLS = Object.freeze([
  'list_tasks', 'get_task', 'list_task_id_meta', 'list_task_resolutions',
  'list_system_tags', 'get_project_tags', 'get_tag_architecture', 'get_tag_architectures',
]);

// Bridged names a Pi task chat may call — the same lists Claude's task chat allows by name.
const PI_TASK_CHAT_MCP_TOOLS = Object.freeze([
  ...TASK_CHAT_REMOTE_TOOLS.map(piBridged(REMOTE_MCP)),
  ...TASK_CHAT_LOCAL_TOOLS.map(piBridged(LOCAL_MCP)),
]);
const PI_OBJECTIVE_MCP_TOOLS = Object.freeze([
  ...OBJECTIVE_REMOTE_READ_TOOLS.map(piBridged(REMOTE_MCP)),
  ...TASK_CHAT_LOCAL_TOOLS.map(piBridged(LOCAL_MCP)),
]);

// Pi's objective (read-only planner) fence. `tools` are always on; `mcpTools` replace
// `restTools` when the MCP bridge is loaded for the turn (piToolAllowlist()).
const PI_OBJECTIVE_PROFILE = Object.freeze({
  tools: Object.freeze(['read']),
  restTools: Object.freeze([]),
  mcpTools: PI_OBJECTIVE_MCP_TOOLS,
});

const CODEX_OBJECTIVE_PROFILE = Object.freeze({
  sandbox: 'read-only', mcpServers: [REMOTE_MCP, LOCAL_MCP],
  remoteDisabledTools: ['create_task', 'update_task', 'delete_task', 'create_task_comment',
    'create_system_tag', 'ensure_project_tag', 'purge_stale_reservations'],
  localEnabledTools: TASK_CHAT_LOCAL_TOOLS,
});

const PROFILES = Object.freeze({
  [TASK_CHAT]: Object.freeze({
    claude: Object.freeze({
      allowedTools: Object.freeze(['Read', ...TASK_CHAT_LOCAL_TOOLS.map(local), ...TASK_CHAT_REMOTE_TOOLS.map(remote)]),
      // The project's .claude/settings.local.json allows mcp__tipatask__* and
      // mcp__tipatask-local__* wholesale, so every MCP tool a chat must not reach is denied by
      // name. ToolSearch is deliberately absent: MCP tool schemas can be deferred behind it.
      // AskUserQuestion has no one to answer it in a headless turn — a chat asks through the
      // fenced `ask_user` block instead (task-chat-widgets.js).
      disallowedTools: Object.freeze([
        'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob',
        'WebFetch', 'WebSearch', 'Task', 'Agent', 'AskUserQuestion',
        ...TASK_CHAT_REMOTE_DENIED.map(remote),
        ...TASK_CHAT_LOCAL_DENIED.map(local),
      ]),
      mcpServers: Object.freeze([REMOTE_MCP, LOCAL_MCP]),
    }),
    codex: Object.freeze({
      sandbox: 'read-only',
      mcpServers: Object.freeze([REMOTE_MCP, LOCAL_MCP]),
      remoteDisabledTools: TASK_CHAT_REMOTE_DENIED,
      localEnabledTools: TASK_CHAT_LOCAL_TOOLS,
    }),
    pi: Object.freeze({
      tools: Object.freeze(['read', 'grep', 'find', 'ls']),
      restTools: Object.freeze([PI_TASK_API_TOOL]),
      mcpTools: PI_TASK_CHAT_MCP_TOOLS,
    }),
  }),
});

// Providers that can enforce a profile at all. Gemini is restricted to objective reading and has no task-mutation transport.
const PROFILE_PROVIDERS = Object.freeze(['claude', 'codex', 'pi']);

function toolProfileFor(session, provider) {
  const profile = session && session.toolProfile && PROFILES[session.toolProfile];
  return (profile && profile[provider]) || null;
}

function providerSupportsProfile(session, provider) {
  if (!session || !session.toolProfile) return true;
  return PROFILE_PROVIDERS.includes(provider);
}

// The `--tools` allowlist of a headless Pi turn. With the bridge, the bridged MCP tools take
// the REST tool's place; Pi activates a tool the bridge registers in session_start only because
// its name is on this list. Without it the REST fallback (pi-ext/task-tools.mjs) is the task tool.
function piToolAllowlist(profile, { bridge = false } = {}) {
  const p = profile || PI_OBJECTIVE_PROFILE;
  return [...p.tools, ...((bridge ? p.mcpTools : p.restTools) || [])];
}

function tomlStringArray(values) {
  return `[${values.map(v => JSON.stringify(v)).join(',')}]`;
}

// Codex has no allow/deny flags: the fence is `-c key=value` config overrides, which both
// `codex exec` and `codex exec resume` accept. `otherMcpServers` are the remaining servers in
// the project's .codex/config.toml for legacy bare-key callers. Real headless spawns
// replace the complete MCP map with buildScopedCodexMcpOverride().
function codexProfileConfigArgs(profile, { resume = false, otherMcpServers = [] } = {}) {
  if (!profile) return [];
  const overrides = [];
  if (resume) overrides.push(`sandbox_mode=${JSON.stringify(profile.sandbox)}`);
  overrides.push(`mcp_servers.${REMOTE_MCP}.disabled_tools=${tomlStringArray(profile.remoteDisabledTools)}`);
  overrides.push(`mcp_servers.${LOCAL_MCP}.enabled_tools=${tomlStringArray(profile.localEnabledTools)}`);
  for (const name of otherMcpServers) {
    if (profile.mcpServers.includes(name)) continue;
    // Legacy bare-key callers only; real spawns replace the whole MCP map.
    if (/^[A-Za-z0-9_-]+$/.test(name)) overrides.push(`mcp_servers.${name}.enabled=false`);
  }
  return overrides.flatMap(o => ['-c', o]);
}

module.exports = {
  TASK_CHAT,
  PROFILES,
  PROFILE_PROVIDERS,
  PI_TASK_API_TOOL,
  PI_OBJECTIVE_PROFILE,
  PI_TASK_CHAT_MCP_TOOLS,
  PI_OBJECTIVE_MCP_TOOLS,
  CODEX_OBJECTIVE_PROFILE,
  piToolAllowlist,
  toolProfileFor,
  providerSupportsProfile,
  codexProfileConfigArgs,
};
