// Which of the project's configured Pi ("Other Model") rows can start a task. The provider list
// (server providers/registry.js listObjectiveProviders()) carries the pi entry's configured row
// ids as `configuredModels` and the subset whose PI_MODELS row sets `tools: false` as
// `toolLessModels`. A tool-less row still runs objective planning, but a task terminal never
// starts on it, so the task-start pickers — the launch modal (console-modal.js) and the agent
// pickers and bulk agent lists (task-board.js) — offer only the rest. No imports and no DOM, so it
// is unit-tested directly (pi-task-models.test.js).

function piEntry(providers) {
  return (Array.isArray(providers) ? providers : []).find((p) => p && p.id === 'pi') || null;
}

function idList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))];
}

// The configured ids a task can start on, in row order. The first one is what a start that names
// no model runs (server pi-custom-endpoint.js piTaskDefaultEntry()). [] when the pi entry is
// missing, not loaded yet, or has no configured rows.
export function piTaskModelIds(providers) {
  const pi = piEntry(providers);
  if (!pi) return [];
  const toolLess = new Set(idList(pi.toolLessModels));
  return idList(pi.configuredModels).filter((id) => !toolLess.has(id));
}

// True only when the project has configured Pi rows and none of them can run a task: Pi can plan
// but not start a task. An empty or not-yet-loaded list says nothing, so it answers false and
// callers keep their existing fallbacks.
export function piOnlyToolLess(providers) {
  const pi = piEntry(providers);
  return !!pi && idList(pi.configuredModels).length > 0 && piTaskModelIds(providers).length === 0;
}

// Explain a saved pin that the server will discard at task start. Unknown/empty provider rows
// cannot prove a pin is stale. Match pins like the server does (case/space insensitive), and
// name the full fallback id so similarly named models remain distinguishable. The caller
// supplies its translator to keep this module independent of UI state and DOM imports.
export function piTaskPinHint(providers, model, translate) {
  const pin = String(model || '').trim().toLowerCase();
  if (!pin || !idList(piEntry(providers)?.configuredModels).length) return '';
  const models = piTaskModelIds(providers);
  if (models.some(id => id.toLowerCase() === pin)) return '';
  return models.length
    ? translate('agent.piModelFallback', { model: models[0] })
    : translate('agent.piModelUnavailable');
}
