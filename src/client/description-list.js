// ── (TPT264) Proposal description list normalizer — pure, DOM-free ──
// The planner contract says a numbered list is used only for 2+ steps; a single-step
// description is prose. Models still occasionally emit a lone "1." item (notably in split
// mode), which renders as a one-entry ordered list. chat-task-preview.js runs this over
// every proposal card before render and before save.
//
// Same extraction rationale as subtask-preview.js: chat-task-preview.js pulls in DOM-only
// imports and can't be loaded under `node --test`.

const NUMBERED_ITEM_RE = /^(\s*)(\d+)[.)]\s+/;
const FENCE_RE = /^\s*(```|~~~)/;

// Strips the marker of the only numbered-list item when that item is "1." / "1)".
// Lines inside fenced code blocks are ignored. Any other shape (0 items, 2+ items, a
// lone item not numbered 1) is returned unchanged. Idempotent; non-strings pass through.
export function normalizeSingleItemList(text) {
  if (typeof text !== 'string' || !text) return text;
  const lines = text.split('\n');
  let inFence = false;
  let hitIdx = -1;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence || !NUMBERED_ITEM_RE.test(lines[i])) continue;
    count += 1;
    hitIdx = i;
    if (count > 1) return text;
  }
  if (count !== 1) return text;
  const m = lines[hitIdx].match(NUMBERED_ITEM_RE);
  if (m[2] !== '1') return text;
  lines[hitIdx] = lines[hitIdx].slice(m[0].length);
  return lines.join('\n');
}
