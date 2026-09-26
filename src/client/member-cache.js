// ── Project member cache: stale-while-revalidate (C1520) ──
// Pure, no DOM/network import — same idiom as subtask-count.js/board-count-domain.js/
// group-label.js — so the dedupe/diff logic is unit-testable under bare `node --test`
// without dragging in task-board.js.
//
// Old behavior (`ensureProjectMembers()` in task-board.js): fetch once per browser
// session, cache forever — a member added via the web app never showed up in the
// Task App's assignee combo/bulk picker without a full window reload, and a single
// failed fetch permanently blanked the list (`catch { state.projectMembers = [] }`).
//
// New behavior: `ensure()` keeps the old "return cached, else fetch" contract for
// boot/cold-start callers. `revalidate()` always re-fetches (joining an in-flight
// request instead of firing a second one) and reports whether the payload actually
// changed, so a caller only needs to repaint when `changed` is true — the cached
// list keeps rendering meanwhile. A rejected revalidate never clobbers a previously
// good cached list; only a rejection with nothing cached yet falls back to `[]`.

// Order-sensitive shallow compare — the API returns a stable member order, so an
// actual add/remove/rename always changes something at some index.
export function membersEqual(a, b) {
  const listA = Array.isArray(a) ? a : [];
  const listB = Array.isArray(b) ? b : [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i++) {
    const m1 = listA[i] || {};
    const m2 = listB[i] || {};
    if (m1.id !== m2.id) return false;
    if (m1.user_id !== m2.user_id) return false;
    if (m1.name !== m2.name) return false;
    if (m1.avatar_url !== m2.avatar_url) return false;
  }
  return true;
}

// createMemberCache({ fetchMembers, normalize }) → { ensure, revalidate, peek }
// fetchMembers(): Promise<rawMembers[]> — e.g. api.members.list()
// normalize(rawMember): normalizedMember|null — e.g. task-board.js's _normalizeProjectMember
export function createMemberCache({ fetchMembers, normalize }) {
  let cached = null; // null = never settled; [] = settled empty (real or post-failure)
  let inflight = null;

  function _normalizeAll(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return normalize ? list.map(normalize).filter(Boolean) : list;
  }

  // Resolves { ok, members } — never rejects. `ok: false` on a transient failure,
  // `members` in that case is the prior good cache (or [] before any success) so
  // callers never see undefined, but they can still tell "failed" from "fetched empty".
  function _fetch() {
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => fetchMembers())
      .then((raw) => ({ ok: true, members: _normalizeAll(raw) }))
      .catch(() => ({ ok: false, members: cached ?? [] }))
      .finally(() => { inflight = null; });
    return inflight;
  }

  // Old ensureProjectMembers() contract: cached array wins outright, no network call.
  async function ensure() {
    if (Array.isArray(cached)) return cached;
    const { ok, members } = await _fetch();
    if (ok) cached = members;
    return ok ? cached : members;
  }

  // Always hits the network (joins an in-flight one) — resolves { members, changed }.
  // `changed` is false whenever a successful fetch comes back identical, or the
  // fetch failed, so callers can gate a repaint on it without also checking for
  // errors. A successful fetch always updates `cached` (even to a same-length
  // equal list) so a genuinely empty project doesn't keep re-fetching forever.
  async function revalidate() {
    const before = cached;
    const { ok, members } = await _fetch();
    if (!ok) return { members: cached ?? [], changed: false };
    const changed = !membersEqual(before, members);
    cached = members;
    return { members: cached, changed };
  }

  function peek() {
    return cached;
  }

  return { ensure, revalidate, peek };
}
