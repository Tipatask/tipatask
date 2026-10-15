// TPT623 — which of a save's tags the project registry doesn't have yet. The Task App's
// manual New Task form and edit modal use it to show "Registering N new tags…" and (edit
// modal) to ask the server to auto-register them with an LLM-written description. Matching
// trims and case-folds, like the server's tag gate (tag-registry-gate.js foldTagName) and
// the tags table's case-insensitive collation. Pure — node-testable.

function fold(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// wanted: tag names; registry: project tags as strings or {name} rows.
export function unregisteredTagNames(wanted, registry) {
  const known = new Set((registry || []).map(r => fold(typeof r === 'string' ? r : r && r.name)).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const name of wanted || []) {
    const f = fold(name);
    if (!f || known.has(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(name);
  }
  return out;
}
