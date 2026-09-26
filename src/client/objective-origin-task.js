// Resolve accepted cards for an existing origin task. A childless web objective
// is refined in place; Rehash Split promotes an ordinary task and saves its
// accepted new cards as children. Pure helper for plain Node tests.

// cs: chat state (cs.originTaskKey, cs.parentTaskKey, cs.objectiveParentKey,
// cs.originResolution). proposedNewCount: the message's TOTAL `type:'new'` card
// count (C1415 — proposed, not accepted).
// -> web-origin plan or { mode:'split', originKey, childIds }
export function resolveOriginPlan(cs, proposedNewCount, childIds = []) {
  // A Rehash → Split chat promotes its existing task in place. Keep this ahead
  // of the web-origin/subtask precedence ladder: split carries parentTaskKey,
  // but that key is exactly the origin that must become an objective parent.
  if (cs?.rehashIntent === 'split' && cs.taskKey && cs.parentTaskKey === cs.taskKey && Number(proposedNewCount) > 0) {
    return {
      mode: 'split',
      originKey: cs.taskKey,
      childIds: [...new Set(childIds.map(String))],
    };
  }
  const originTaskKey = (cs && cs.originTaskKey) || null;
  if (!originTaskKey) return { mode: 'none', originTaskKey: null };
  // Subtask mode wins — user-visible, explicitly entered/dismissible, unlike
  // origin mode which is inferred from a URL. Structurally exclusive today (a
  // C1389 handoff tab spawns with subtaskCtx: null) but write the precedence
  // down and test it rather than rely on that never changing.
  if (cs.parentTaskKey) return { mode: 'none', originTaskKey };
  if (cs.originResolution === 'single') return { mode: 'none', originTaskKey };
  if (cs.objectiveParentKey) return { mode: 'none', originTaskKey };
  const count = Number(proposedNewCount);
  if (count === 1) return { mode: 'single', originTaskKey };
  if (count > 1) return { mode: 'parent', originTaskKey };
  return { mode: 'none', originTaskKey };
}

// The save request identifies only children actually being written in this PUT.
// Stamp a scoped snapshot's origin too, so its old isObjective:false value cannot
// undo the server's promotion when overwriteRaw() diffs the request against live rows.
export function attachSplitOriginPayload(data, plan) {
  if (plan?.mode !== 'split' || !plan.childIds.length) return data;
  data.splitOrigin = { originKey: plan.originKey, childIds: plan.childIds };
  const origin = data.tasks?.find(t => String(t.id) === String(plan.originKey));
  if (origin) origin.isObjective = true;
  return data;
}

// Rewrites a `new` card in place into a `modified` card targeting originTaskKey
// — "refined in place, turned into a regular task" (C1560 item 4). Deleted
// fields are refilled from the live row by the caller's hydrateModifiedCard()
// (chat-task-preview.js), a no-op Object.assign when the row already matches;
// fields NOT deleted here (title/description/tags/dependencies/category) keep
// the card's refined values.
export function adoptOriginKey(card, originTaskKey) {
  const t = card && card.task;
  if (!t) return card;
  t.id = originTaskKey;
  delete t.status;    // a modified card never carries status (C1072)
  delete t.priority;  // planning refines content, not schedule — keep the origin's sprint
  delete t.order;
  delete t.assignee;  // never reassign someone else's task
  delete t.parentId;
  t.isObjective = false; // undoes the C1341 stamp — "turning it into a regular task"
  card.type = 'modified';
  card._originAdopted = true;
  return card;
}

// The planner will sometimes ALSO propose a `modified` card targeting the
// origin key (its own system-prompt rule: "if active task overlaps objective,
// propose modified"). That card must never reach the save — in 'single' mode it
// would race the adopted card for the same row; in 'parent' mode it would
// overwrite the origin content B1 deliberately preserves. Returns the indexes
// (into `cards`, i.e. msg.cards) of every such stray card.
export function originConflictCardIndexes(cards, originTaskKey) {
  if (!Array.isArray(cards) || !originTaskKey) return [];
  const out = [];
  cards.forEach((c, i) => {
    if (c && c.type === 'modified' && c.task && String(c.task.id) === String(originTaskKey)) {
      out.push(i);
    }
  });
  return out;
}

// Preview-card renderer helper (chat-task-preview.js renderCard()) — returns
// the index of the message's card that WILL be adopted onto the origin on save
// (mode 'single' only), so the preview can relabel it NEW -> MODIFIED-against-
// <originKey> instead of the badge lying about the outcome. Deliberately the
// SAME resolution logic the save path uses (resolveOriginPlan), so label and
// save can never drift apart. Returns null outside 'single' mode or once
// msg.cards holds no `new` card.
export function previewOriginSingleTarget(cs, msg) {
  const cards = (msg && msg.cards) || [];
  const proposedNewCount = cards.filter(c => c.type === 'new').length;
  const plan = resolveOriginPlan(cs, proposedNewCount);
  if (plan.mode !== 'single') return null;
  const idx = cards.findIndex(c => c.type === 'new');
  return idx >= 0 ? idx : null;
}

// ── Out-of-subtree modified-card guard (TPT15) ──
// An origin-linked chat spawned with an empty/thin seed can leave the planner with
// nothing about the objective to go on but the active-task list it's shown for
// "modified" overlap detection — and it will propose a "modified" card against one of
// those unrelated tasks. Nothing upstream of the preview stops that proposal from
// reaching Save; this guard only changes its DEFAULT accepted state so it's not
// written unless the user deliberately opts in.
//
// "Subtree" = the origin task itself, plus every child this SAME chat has already
// confirmed (Accepted+Saved) under it — i.e. real backend rows this chat legitimately
// owns. A `new` card's task.id is already a real reserved key from the planner (C1017),
// so once confirmed it IS the child's real id — no separate id-remap lookup needed.
// Returns null when this chat isn't origin-linked (cs.originTaskKey unset) — callers
// treat null as "guard doesn't apply here", never as an empty subtree.
export function originSubtreeKeys(cs) {
  const originTaskKey = (cs && cs.originTaskKey) || null;
  if (!originTaskKey) return null;
  const keys = new Set([String(originTaskKey)]);
  for (const m of (cs.messages || [])) {
    const cards = m.cards || [];
    const confirmed = m.confirmedMask || [];
    cards.forEach((c, i) => {
      if (c && c.type === 'new' && confirmed[i] && c.task && c.task.id != null) {
        keys.add(String(c.task.id));
      }
    });
  }
  return keys;
}

// Indexes (into `cards`) of every `type: 'modified'` card whose target is NOT in the
// origin's subtree (see originSubtreeKeys above). Deliberately excludes a card
// targeting the origin key itself — that case is handled at save time by
// originConflictCardIndexes(), which drops it outright; this guard must not also flag
// it (double-handling the same card two different ways). Returns [] when the chat
// isn't origin-linked, or when `cards` isn't an array.
export function outOfSubtreeModifiedIndexes(cs, cards) {
  const subtree = originSubtreeKeys(cs);
  if (!subtree || !Array.isArray(cards)) return [];
  const out = [];
  cards.forEach((c, i) => {
    if (!c || c.type !== 'modified' || !c.task || c.task.id == null) return;
    const id = String(c.task.id);
    if (id === String(cs.originTaskKey)) return; // owned by originConflictCardIndexes instead
    if (!subtree.has(id)) out.push(i);
  });
  return out;
}

// Builds a fresh acceptedMask for `cards` — true everywhere except the out-of-subtree
// `modified` cards flagged above, which start UNCHECKED (opt-in, not dropped: the user
// can still click Accept). Outside origin mode this is identical to the previous
// `cards.map(() => true)` call sites replace verbatim — no behavior change when
// cs.originTaskKey is unset.
export function buildInitialAcceptedMask(cs, cards) {
  const list = Array.isArray(cards) ? cards : [];
  const flagged = new Set(outOfSubtreeModifiedIndexes(cs, list));
  return list.map((_, i) => !flagged.has(i));
}

// (TPT16) The seeded prompt a planning-branch handoff (board .btn-create-subtasks,
// /start-task's open-objective push, ?objectiveTask= URL fallback) drops into
// #chat-input. `task`: { title, description } (or null/undefined — every entry point
// bails before calling this if the fetch failed). `fallbackKey`: the task key to use
// as the heading when title is blank.
// Description is carried VERBATIM — do not reformat, escape, truncate, or strip it.
// Embedded markdown image/file refs (![…](/api/projects/N/images/M), file-attachment
// links) must survive untouched, or both the planner and the composer's own
// rebuildObjectiveImagePreviews() thumbnail strip (chat-ui.js) lose them.
export function buildObjectiveSeed(task, fallbackKey) {
  const title = (task && task.title) || fallbackKey || '';
  const description = (task && task.description) || '';
  return `### ${title}\n\n${description}`.trim();
}
