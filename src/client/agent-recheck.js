// Shared "agents changed" client helpers for the three surfaces that show a Re-Check button
// (agents-modal.js, setup-modal.js, project-creation-wizard.js) and for the objective chat's
// model selector. A separate module rather than part of agent-select.js: that one takes its
// fetch source injected (`browserFallback`) so it needs no project-header/fetch knowledge, and
// this is where that knowledge lives.
//
// Why server-first: Electron main and the forked todo-server each keep their OWN agent-detection
// caches (task-agent/base-agent.js `_detectResult` + spawn-utils.js `_binCache`), and the forked
// server is the process that serves every objective-provider list. A Re-Check that only re-detects
// in Electron main (the `setup:get-available-agents` IPC) leaves a just-installed CLI invisible to
// the chat model selector until restart.
import { loadAgents } from './agent-select.js';
import { projectHeader } from './utils.js';

// An explicit project path wins over location.search: a dedicated setup window has no
// `?projectPath=` until `project:changed` rewrites it, and that rewrite can lose the race with
// the request that needs the header.
function headerFor(projectPath) {
  return projectPath ? { 'x-tipatask-project': projectPath } : projectHeader();
}

// GET /api/agent-config — `?refresh=1` when `force` makes the server bust its bin/detect caches
// and re-detect before answering. Also the browser-mode source for loadAgents() (agent-select.js),
// used when the Electron IPC bridge is absent.
export async function fetchAgentStatusesFromServer(force = false) {
  const r = await fetch(`/api/agent-config${force ? '?refresh=1' : ''}`, { cache: 'no-store', headers: projectHeader() });
  if (!r.ok) return null;
  const data = await r.json();
  return Array.isArray(data.agentStatuses) ? data.agentStatuses : null;
}

// Re-Check: ask the forked server first (it re-detects in the process that actually serves the
// providers, with asynchronous CLI probes); main-process IPC
// stays as the fallback if the server can't answer. Returns [{id,label,available,reason}].
export async function recheckAgents() {
  let agents = null;
  try { agents = await fetchAgentStatusesFromServer(true); } catch { agents = null; }
  if (!Array.isArray(agents) || !agents.length) {
    agents = await loadAgents({ force: true, browserFallback: fetchAgentStatusesFromServer });
  }
  return agents;
}

// Re-fetch the objective chat's provider list and hand it to chat-ui.js. An event rather than an
// import so chat-ui.js never becomes a dependency of the setup/agents modals — and chat-ui.js
// stays the ONLY writer of state.objectiveProviders (its listener diffs the new list against the
// one it last applied to decide whether a repaint is needed). Reads the non-blocking `{peek:true}`
// provider payload (no synchronous CLI probe). Resolves to the payload, or null on any failure.
export async function refreshObjectiveProviders(projectPath) {
  try {
    const r = await fetch('/api/objective/providers', { cache: 'no-store', headers: headerFor(projectPath) });
    const p = r.ok ? await r.json() : null;
    if (!p || !Array.isArray(p.objectiveProviders)) return null;
    document.dispatchEvent(new CustomEvent('tiptask:providers-changed', { detail: p }));
    return p;
  } catch {
    return null;
  }
}

// After a setup save wrote AVAILABLE_AGENTS/TASK_AGENT to disk from Electron MAIN
// (`project:open-existing`, `api:auth.reauth-save`), the forked server has been told nothing:
// main's `websocket` module is a different instance, so it cannot broadcast to the server's
// clients. `applyOnly` makes POST /api/agents-config skip the disk write (already done) and run
// exactly the server-side re-detect + `providers:changed` broadcast. Best-effort — a failure here
// must never fail the save. Ends with an explicit provider re-fetch so the list the chat sees is
// ordered AFTER that re-detect: window adoption emits `project:changed` as soon as main's handler
// returns, which can beat this POST, and the WS broadcast alone can't cover that (the attention
// socket is being rebound at that moment).
export async function notifyServerAgentsSaved(projectPath, { availableAgents, taskAgent } = {}) {
  try {
    await fetch('/api/agents-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headerFor(projectPath) },
      body: JSON.stringify({ availableAgents: availableAgents || [], taskAgent: taskAgent || '', applyOnly: true }),
    });
  } catch { /* best-effort */ }
  await refreshObjectiveProviders(projectPath);
}
