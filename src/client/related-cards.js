// Pure family-graph helper for "Highlight Related" (C1569). No DOM, no imports — mirrors
// dep-graph.js/board-count-domain.js so it stays unit-testable under `node --test`.
// Consumed by applyRelatedHighlight() in task-card.js.

// nodes: [{ id, dbId, parentDbId }] lifted off rendered cards by the caller (DOM-free here).
// '', null, undefined all mean "no value" for dbId/parentDbId — a root card's data-parent-db-id
// is the empty string, not absent, so treating '' as a real key would wrongly bucket every
// root card as a sibling of every other root card.
//
// Returns the set of task ids: rootId + all its descendants (BFS over parentDbId -> children,
// cycle-guarded) + its parent's id (only if the parent's own node is present in `nodes`) + every
// other child of that parent (siblings). Root not present in `nodes` -> just {rootId}.
export function collectFamilyIds(nodes, rootId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map();
  const childrenByParentDbId = new Map();
  for (const n of list) {
    if (!n || n.id == null) continue;
    byId.set(n.id, n);
    const pdb = n.parentDbId;
    if (pdb === '' || pdb == null) continue; // empty-string trap — never index a "no parent" bucket
    const key = String(pdb);
    if (!childrenByParentDbId.has(key)) childrenByParentDbId.set(key, []);
    childrenByParentDbId.get(key).push(n);
  }

  const root = byId.get(rootId);
  const family = new Set([rootId]);
  if (!root) return family;

  // Descendants: BFS over parentDbId -> children, keyed by each visited node's own dbId.
  const dbQueue = root.dbId != null && root.dbId !== '' ? [String(root.dbId)] : [];
  const visitedDbIds = new Set(dbQueue);
  while (dbQueue.length > 0) {
    const parentDbId = dbQueue.shift();
    const children = childrenByParentDbId.get(parentDbId) || [];
    for (const child of children) {
      if (family.has(child.id)) continue; // guard against a parent_id cycle in the data
      family.add(child.id);
      const childDbId = child.dbId != null && child.dbId !== '' ? String(child.dbId) : null;
      if (childDbId && !visitedDbIds.has(childDbId)) {
        visitedDbIds.add(childDbId);
        dbQueue.push(childDbId);
      }
    }
  }

  // Parent + siblings: only when the parent's own node is present (its dbId matches some
  // node's own dbId) — an absent parent (not in this fetch/DOM) means no siblings to find either.
  const parentDbId = root.parentDbId;
  if (parentDbId !== '' && parentDbId != null) {
    const parentKey = String(parentDbId);
    const parent = list.find(n => n && n.dbId != null && n.dbId !== '' && String(n.dbId) === parentKey);
    if (parent) {
      family.add(parent.id);
      const siblings = childrenByParentDbId.get(parentKey) || [];
      for (const sib of siblings) family.add(sib.id);
    }
  }

  return family;
}
