// Diff rendered text: Markdown source offsets do not map to DOM text nodes.
// Compare lines before words to avoid matches across unrelated paragraphs; collectTextSegments
// preserves <br> separators that textContent would lose.

// ── Tokenize into alternating word / whitespace tokens (whitespace tokens matter —
//    they must be preserved so re-joining ops reproduces the original text exactly) ──
function tokenizeWords(text) {
  return String(text ?? '').match(/\s+|[^\s]+/g) || [];
}

// ── Longest Common Subsequence over two token arrays → aligned diff ops ──
// Classic O(n*m) DP. Callers are responsible for keeping n*m bounded (see the size
// guard in diffWords below) — this function itself has no bail-out.
function lcsOps(oldTokens, newTokens) {
  const n = oldTokens.length, m = newTokens.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return newTokens.map(text => ({ type: 'added', text }));
  if (m === 0) return oldTokens.map(text => ({ type: 'removed', text }));

  // dp[i][j] = LCS length of oldTokens[i:] and newTokens[j:]
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // One op per token, deliberately NOT merged here — this function is reused both
  // for word-level tokens (where adjacent same-type tokens concatenating back
  // together is harmless, since whitespace tokens are themselves the separators)
  // and for line-level tokens (where each "token" is a whole line string with no
  // separator of its own). Merging line tokens here would silently glue two
  // consecutive changed lines together with no '\n' between them — the exact bug
  // this comment replaces (see diffWords' hunk-pairing loop, which depends on one
  // lcsOps entry per original line to collect a hunk's removed/added runs
  // correctly). Callers that want tidy merged text run the outer merge pass in
  // diffWords instead, where the right separators are already in place.
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      ops.push({ type: 'same', text: oldTokens[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'removed', text: oldTokens[i] });
      i++;
    } else {
      ops.push({ type: 'added', text: newTokens[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'removed', text: oldTokens[i] }); i++; }
  while (j < m) { ops.push({ type: 'added', text: newTokens[j] }); j++; }
  return ops;
}

// Above this many word-tokens per side, the O(n*m) DP is too expensive to run on
// every keystroke (n*m cells; e.g. 2500*2500 = 6.25M). Bail to one coarse
// removed-then-added block pair instead of hanging the UI.
const WORD_DIFF_TOKEN_LIMIT = 2500;

// ── Word-level diff INSIDE one aligned pair of changed lines ──
function diffLineWords(oldLine, newLine) {
  if (oldLine === newLine) return [{ type: 'same', text: oldLine }];
  const oldTokens = tokenizeWords(oldLine);
  const newTokens = tokenizeWords(newLine);
  if (oldTokens.length > WORD_DIFF_TOKEN_LIMIT || newTokens.length > WORD_DIFF_TOKEN_LIMIT) {
    const ops = [];
    if (oldLine) ops.push({ type: 'removed', text: oldLine });
    if (newLine) ops.push({ type: 'added', text: newLine });
    return ops;
  }
  return lcsOps(oldTokens, newTokens);
}

// ── Public: two-tier word diff — LCS over lines first, word-LCS inside changed pairs ──
// Returns a flat ops array: [{type:'same'|'removed'|'added', text}]. Concatenating
// all `text` where type!=='removed' reproduces newText; where type!=='added'
// reproduces oldText.
export function diffWords(oldText, newText) {
  const a = String(oldText ?? '');
  const b = String(newText ?? '');
  if (a === b) return a ? [{ type: 'same', text: a }] : [];

  // Trim a common prefix/suffix of whole lines first — cheap and shrinks the
  // interesting middle before any LCS runs.
  const oldLines = a.split('\n');
  const newLines = b.split('\n');
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--; endNew--;
  }

  const prefixLines = oldLines.slice(0, start);
  const midOld = oldLines.slice(start, endOld + 1);
  const midNew = newLines.slice(start, endNew + 1);
  const suffixLines = oldLines.slice(endOld + 1);

  // Each entry is the ops for exactly ONE original line, with no embedded '\n' —
  // separators are inserted once, between entries, so there is exactly one join
  // point per line boundary regardless of how many lines came from prefix/middle/suffix.
  const lineEntries = [];
  for (const line of prefixLines) lineEntries.push([{ type: 'same', text: line }]);

  const lineOps = lcsOps(midOld, midNew);
  // Group into hunks and word-diff them positionally. NOTE: when 2+ consecutive
  // lines change, the line-level LCS emits ALL removed lines first, then ALL added
  // lines (dp[i+1][j] >= dp[i][j+1] always favors "removed" on a full mismatch) —
  // it does NOT interleave them as removed/added/removed/added per line. Pairing
  // "this removed op with whatever comes right after" would therefore pair UNRELATED
  // lines together (e.g. old line 2 with new line 1) and word-diff them, producing
  // garbage spans that can cross line boundaries mid-word. Instead, collect the full
  // contiguous removed-run and the full contiguous added-run of a hunk, then pair
  // them positionally (line i of the run with line i) — the standard "N old lines
  // replaced by M new lines" diff behavior — and treat any length surplus as pure
  // whole-line removals/additions.
  let k = 0;
  while (k < lineOps.length) {
    const op = lineOps[k];
    if (op.type === 'same') {
      lineEntries.push([{ type: 'same', text: op.text }]);
      k++;
      continue;
    }
    const removedRun = [];
    while (k < lineOps.length && lineOps[k].type === 'removed') { removedRun.push(lineOps[k].text); k++; }
    const addedRun = [];
    while (k < lineOps.length && lineOps[k].type === 'added') { addedRun.push(lineOps[k].text); k++; }
    const pairCount = Math.min(removedRun.length, addedRun.length);
    for (let p = 0; p < pairCount; p++) lineEntries.push(diffLineWords(removedRun[p], addedRun[p]));
    for (let p = pairCount; p < removedRun.length; p++) lineEntries.push([{ type: 'removed', text: removedRun[p] }]);
    for (let p = pairCount; p < addedRun.length; p++) lineEntries.push([{ type: 'added', text: addedRun[p] }]);
  }

  for (const line of suffixLines) lineEntries.push([{ type: 'same', text: line }]);

  const ops = [];
  lineEntries.forEach((entry, idx) => {
    if (idx > 0) ops.push({ type: 'same', text: '\n' });
    ops.push(...entry);
  });

  // Merge adjacent same-type ops (cosmetic — keeps opsToRanges simpler); drop empties.
  const merged = [];
  for (const o of ops) {
    if (!o.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === o.type) last.text += o.text;
    else merged.push({ ...o });
  }
  return merged;
}

// ── Convert diffWords() ops into char-range pairs for each side, whitespace-only
//    ranges dropped (a highlighted bare newline/space reads as a stray sliver) ──
export function opsToRanges(ops) {
  let oldPos = 0, newPos = 0;
  const oldRanges = [];
  const newRanges = [];
  let changeCount = 0;
  const isWhitespaceOnly = (s) => /^\s*$/.test(s);
  for (const op of ops) {
    const len = op.text.length;
    if (op.type === 'same') {
      oldPos += len; newPos += len;
    } else if (op.type === 'removed') {
      if (!isWhitespaceOnly(op.text)) { oldRanges.push([oldPos, oldPos + len]); changeCount++; }
      oldPos += len;
    } else { // added
      if (!isWhitespaceOnly(op.text)) { newRanges.push([newPos, newPos + len]); changeCount++; }
      newPos += len;
    }
  }
  return { oldRanges, newRanges, changed: oldRanges.length > 0 || newRanges.length > 0, changeCount };
}

// ── Escape + wrap ranges over a plain string (title panel — no DOM needed) ──
export function highlightPlainText(text, ranges, cls) {
  const s = String(text ?? '');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!ranges || ranges.length === 0) return esc(s);
  let out = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) out += esc(s.slice(pos, start));
    out += `<span class="${cls}">${esc(s.slice(start, end))}</span>`;
    pos = end;
  }
  if (pos < s.length) out += esc(s.slice(pos));
  return out;
}

// ── Unescape the \~ tilde-escaping objective-chat proposals carry (see
//    chat-task-preview.js escapeMarkdownTilde) before a raw-text comparison, so a
//    proposal that merely round-trips through escaping doesn't read as "changed" ──
export function normalizeRaw(text) {
  return String(text ?? '').replace(/\\~/g, '~');
}

// ── Metadata delta for the compact "what else changed" row. Deliberately excludes
//    `status` — a modified proposal's status is absent unless the user explicitly
//    edited it in the proposal modal (see chat-task-preview.js assertPendingProposalStatus,
//    C1072) — showing it here would read as a false "in_progress → pending" on every card. ──
export function summarizeMetadata(oldTask, newTask) {
  const old = oldTask || {};
  const next = newTask || {};
  const setDiff = (a, b) => {
    const as = new Set(a || []);
    const bs = new Set(b || []);
    return {
      added: (b || []).filter(x => !as.has(x)),
      removed: (a || []).filter(x => !bs.has(x)),
    };
  };
  const summary = {
    tags: setDiff(old.tags, next.tags),
    dependencies: setDiff(old.dependencies, next.dependencies),
    priority: null,
    category: null,
    assignee: null,
  };
  if ((old.priority ?? 0) !== (next.priority ?? 0)) {
    summary.priority = { from: old.priority ?? 0, to: next.priority ?? 0 };
  }
  if ((old.category || null) !== (next.category || null)) {
    summary.category = { from: old.category || null, to: next.category || null };
  }
  if ((old.assignee ?? null) !== (next.assignee ?? null)) {
    summary.assignee = { from: old.assignee ?? null, to: next.assignee ?? null };
  }
  summary.changed = summary.tags.added.length > 0 || summary.tags.removed.length > 0
    || summary.dependencies.added.length > 0 || summary.dependencies.removed.length > 0
    || summary.priority !== null || summary.category !== null || summary.assignee !== null;
  return summary;
}

// ════════════════════════════════════════════════════════════════════════
// DOM helpers — call-time DOM only, used exclusively from task-board.js
// ════════════════════════════════════════════════════════════════════════

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE']);

// ── Walk rootEl's rendered DOM, building one plain-text string with a synthetic '\n'
//    inserted for <br>/<hr> and at block-element boundaries — fixes the .textContent
//    word-fusion bug where "line A<br>line B" collapses to "line Aline B" (marked's
//    breaks:true emits <br> with no adjacent whitespace text node). Block boundaries
//    are otherwise already safe: marked emits real whitespace text nodes between
//    blocks/<li>s that survive innerHTML parsing, so this is a defensive superset. ──
export function collectTextSegments(rootEl) {
  let text = '';
  const segments = [];
  const appendSynthetic = () => {
    if (text.length === 0 || text[text.length - 1] !== '\n') text += '\n';
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue;
      if (t) { segments.push({ node, start: text.length, end: text.length + t.length }); text += t; }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'BR' || tag === 'HR') { appendSynthetic(); return; }
    if (tag === 'IMG') return; // no text contribution
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) appendSynthetic();
    for (const child of node.childNodes) walk(child);
    if (isBlock) appendSynthetic();
  };
  for (const child of rootEl.childNodes) walk(child);
  return { text, segments };
}

// ── Map click-to-edit caret position (C1470): given the ordered list of rendered
//    text-node strings (from collectTextSegments' segments, mapped to .node.nodeValue)
//    and which node/offset the click resolved to, find where that lands in the RAW
//    markdown source. Rendered text strips markdown syntax chars (# * ` [ ] etc) and
//    collapses blank lines, so raw offsets can't be derived by index math — walk both
//    strings in parallel, using a monotonic indexOf to find each rendered node's text
//    inside raw. Monotonic (never searches backward) keeps repeated words aligned (the
//    Nth "the" in the render matches the Nth "the" in raw) and means a miss just stalls
//    the cursor instead of jumping to some earlier duplicate.
//    NOT diffWords-based: diffWords pairs removed/added LINE runs positionally, but
//    rendered text collapses raw blank lines and reflows block boundaries so line counts
//    diverge — multi-paragraph descriptions would mispair. Also diffWords is O(n*m) on
//    the near-total-rewrite case (every line differs once syntax is stripped), which is
//    exactly what runs on every single click here. ──
export function mapRenderedOffsetToRaw(nodeTexts, hitIndex, hitOffset, raw) {
  const src = String(raw ?? '');
  let cursor = 0;
  let resolved = null;
  for (let i = 0; i < nodeTexts.length; i++) {
    const nodeText = nodeTexts[i];
    if (!nodeText) continue;

    // Exact match — the common case, rendered text is a literal raw substring.
    let foundAt = src.indexOf(nodeText, cursor);
    let matchLen = nodeText.length;
    let toRawOffset = (o) => o; // identity: exact match, offsets agree 1:1

    if (foundAt === -1) {
      // (C1470) "\~" escape divergence — utils.js escapes every bare "~" in a saved
      // description as "\~" (GFM-strikethrough guard, see feedback_tilde_escape memory),
      // and marked unescapes it back to "~" on render. Retry assuming raw has "\~"
      // wherever nodeText has "~"; each "~" costs +1 char, so hitOffset needs remapping.
      const reEscaped = nodeText.replace(/~/g, '\\~');
      foundAt = src.indexOf(reEscaped, cursor);
      if (foundAt !== -1) {
        matchLen = reEscaped.length;
        toRawOffset = (o) => {
          let mapped = 0;
          for (let k = 0; k < o; k++) mapped += nodeText[k] === '~' ? 2 : 1;
          return mapped;
        };
      } else {
        // Last resort: short literal anchor from the node's start.
        const anchor = nodeText.slice(0, 24);
        foundAt = anchor ? src.indexOf(anchor, cursor) : -1;
        if (foundAt === -1) {
          if (i === hitIndex) return resolved; // never resolved this node — best-effort
          continue; // skip node, cursor stays put
        }
        matchLen = anchor.length;
      }
    }

    if (i === hitIndex) {
      const clamped = Math.max(0, Math.min(hitOffset, nodeText.length));
      resolved = foundAt + toRawOffset(clamped);
      break;
    }
    cursor = foundAt + matchLen;
  }
  return resolved;
}

// ── Apply char ranges (from opsToRanges, computed against collectTextSegments' text)
//    onto the live DOM by wrapping the covered portion of each affected text node in
//    <ins>/<del>. Mutates in reverse document order so earlier segment offsets stay
//    valid as later ones are split. Skips whitespace-only overlaps outside pre/code
//    (a highlighted bare space/newline reads as a stray colored sliver). ──
export function applyRanges(segments, ranges, cls, tag = 'span') {
  if (!ranges || ranges.length === 0) return;
  // Work backwards so mutating a segment doesn't invalidate earlier segments' node refs.
  for (let s = segments.length - 1; s >= 0; s--) {
    const seg = segments[s];
    const node = seg.node;
    if (!node.parentNode) continue; // already detached by an earlier (later-in-doc) split
    const overlaps = ranges.filter(([rs, re]) => re > seg.start && rs < seg.end);
    if (overlaps.length === 0) continue;
    const fullText = node.nodeValue;
    const inPre = !!node.parentElement?.closest('pre, code');
    // Build a list of [localStart, localEnd, isHighlighted] pieces covering the whole node.
    const pieces = [];
    let cursor = 0;
    for (const [rs, re] of overlaps.sort((x, y) => x[0] - y[0])) {
      const localStart = Math.max(0, rs - seg.start);
      const localEnd = Math.min(fullText.length, re - seg.start);
      if (localStart > cursor) pieces.push([cursor, localStart, false]);
      const chunk = fullText.slice(localStart, localEnd);
      const isWhitespace = /^\s*$/.test(chunk);
      pieces.push([localStart, localEnd, !isWhitespace || inPre]);
      cursor = localEnd;
    }
    if (cursor < fullText.length) pieces.push([cursor, fullText.length, false]);
    if (pieces.every(p => !p[2])) continue;

    const frag = document.createDocumentFragment();
    for (const [ps, pe, highlight] of pieces) {
      const chunk = fullText.slice(ps, pe);
      if (!chunk) continue;
      if (highlight) {
        const el = document.createElement(tag);
        el.className = cls;
        el.textContent = chunk;
        frag.appendChild(el);
      } else {
        frag.appendChild(document.createTextNode(chunk));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// ── Structural changes rendered-text diffing can't see: heading level, bold/italic,
//    link target, image swap, code-fence language. Compares top-level children
//    pairwise; where textContent matches but outerHTML differs, flags the NEW side's
//    child with a class for a subtle "formatting changed" indicator. ──
export function markStructuralBlockChanges(oldRoot, newRoot, cls) {
  const oldChildren = [...oldRoot.children];
  const newChildren = [...newRoot.children];
  const len = Math.min(oldChildren.length, newChildren.length);
  for (let i = 0; i < len; i++) {
    const a = oldChildren[i], b = newChildren[i];
    if (a.textContent === b.textContent && a.outerHTML !== b.outerHTML) {
      b.classList.add(cls);
    }
  }
}
