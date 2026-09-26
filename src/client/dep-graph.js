// Pure dependency-cycle guard for the deps typeahead (C1093). No DOM, no imports —
// mirrors utils.js/dep-priority.js so it stays trivially unit-testable under
// `node --test`. Consumed by _createDepsChipInput() in task-board.js to filter
// cycle-causing candidates out of the dropdown before they can be picked.

// Builds a task-key -> [dependency task-keys] graph from a project task list.
// `entries` is [{id, dependencies}] (extra fields like title/status are ignored).
// Keys are lowercased throughout to match the chip input's existing case-
// insensitive dedupe (see addDep()'s `d.toLowerCase()` in task-board.js).
export function buildDepGraph(entries) {
  const graph = new Map();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const key = String(entry.id).toLowerCase();
    const deps = Array.isArray(entry.dependencies) ? entry.dependencies : [];
    graph.set(key, deps.filter(Boolean).map(d => String(d).toLowerCase()));
  }
  return graph;
}

// Returns the set of task keys (lowercased) that must NOT be offered as a new
// dependency of any task in `roots`, because doing so would close a cycle —
// i.e. every key that already (transitively) depends on a root, plus the
// roots themselves (self-dependency).
//
// Implementation: BFS outward from `roots` over the REVERSE graph (dep -> the
// tasks that list it as a dependency). One O(V+E) pass covers every root and
// every candidate at once — no per-candidate BFS in the dropdown's filter loop.
// A visited set bounds the walk so a pre-existing cycle in the data terminates
// instead of looping forever (same guard as dep-priority.js's cascade and
// task-card.js's getFullDependencyChain).
//
// Note: a root's own OUTGOING edges (what it currently/would depend on) never
// affect this result, by construction — the BFS only ever walks edges INTO a
// root (who already depends on it). A newly added root->candidate edge can only
// close a cycle if candidate already reaches root through edges that don't
// originate at root, so there is deliberately no "what would root's deps become"
// parameter here; passing a REPLACE-in-progress pick list wouldn't change the
// blocked set (see dep-graph.test.js for the worked argument).
export function collectCycleBlocked(graph, roots) {
  const blocked = new Set();
  const g = graph instanceof Map ? graph : new Map();
  const rootKeys = (Array.isArray(roots) ? roots : []).filter(Boolean).map(r => String(r).toLowerCase());
  if (!rootKeys.length) return blocked;

  const reverse = new Map();
  for (const [node, deps] of g) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, []);
      reverse.get(dep).push(node);
    }
  }

  const visited = new Set(rootKeys);
  const queue = [...rootKeys];
  rootKeys.forEach(r => blocked.add(r));
  while (queue.length) {
    const current = queue.shift();
    const dependents = reverse.get(current) || [];
    for (const n of dependents) {
      if (visited.has(n)) continue;
      visited.add(n);
      blocked.add(n);
      queue.push(n);
    }
  }
  return blocked;
}
