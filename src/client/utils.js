import { buildObjectiveSystemPrompt } from '../objective-system-prompt.mjs';
// ── Draft persistence (sessionStorage) ──
import state from './state.js';
import proposalResults from '../objective-proposal-result.js';
import { DRAFT_KEY_OBJECTIVE } from './constants.js';
import { getLocale, t, tc } from './i18n.js';
import { startName, inProgressName, completeName, canceledName, statusNames, activeNames, isLockedTargetStatus } from './status-registry.js';
import { groupTitle, groupNewLabel } from './group-label.js';
import { sanitizeMarkdownHtml } from './markdown-sanitize.js';
import { attachmentFromUrl, escapeHtml, fileChipHtml, imageBlockHtml, tidyImageBlocks } from './attachment-markup.js';

const { describeProposalResult } = proposalResults;

/** Returns the sessionStorage key for the objective draft, scoped to the active tab. */
export function getObjectiveDraftKey() {
  return state.activeTabId ? `${DRAFT_KEY_OBJECTIVE}-${state.activeTabId}` : DRAFT_KEY_OBJECTIVE;
}

// (C1162) A tab is pristine = no conversation, no typed draft — safe to reuse instead of
// spawning a new one. tab: {chatState} entry from state.tabsState. draft: loadDraft() result.
export function isPristineObjectiveTab(tab, draft) {
  if (!tab) return false;
  const msgs = tab.chatState && tab.chatState.messages;
  if (msgs && msgs.length) return false;
  return !(draft && String(draft.text || '').trim());
}

// ── Subtask context: capture-once, never live (C1410) ──
// Bug: tabSubtaskCtx() (chat-ui.js) used to fall back to state.subtaskStack — a GLOBAL pushed
// by board drill-down/Split and never popped on leaving chat — for any tab whose own
// subtaskCtx was undefined. Board navigation after a tab existed silently stamped
// "Creating subtasks for: X" onto that tab's banner AND its saved parentId, even for a tab
// with a fully unrelated (or restored) transcript. Fix: every tab-creation site now calls
// one of these three pure helpers to set tab.subtaskCtx EXPLICITLY at creation — object or
// null, never left undefined — so tabSubtaskContext() below never needs a live fallback.

// stack: state.subtaskStack. Top-of-stack snapshot for a BRAND-NEW empty tab (+ button,
// first-ever send) — the only case that still inherits ambient board drill-down context.
export function captureSubtaskCtx(stack) {
  if (!stack || !stack.length) return null;
  const top = stack[stack.length - 1];
  if (!top || !top.taskKey) return null;
  return { taskKey: top.taskKey, title: top.title || top.taskKey };
}

// tab: state.tabsState entry. Read-only, no fallback — a tab with subtaskCtx left undefined
// (a creation site that forgot to set it) is a bug at the call site, not a cue to guess.
export function tabSubtaskContext(tab) {
  return (tab && tab.subtaskCtx) || null;
}

// cs: state.chatState (or a restored snapshot). Used by session restore, which has no live
// board stack to consult — the tab's own persisted parentTaskKey is the only honest source.
export function subtaskCtxFromChatState(cs) {
  const key = cs && cs.parentTaskKey;
  return key ? { taskKey: key, title: key } : null;
}

// (C1440) Every push onto state.subtaskStack goes through here. Guard: if the stack top is
// already this taskKey, skip — loadAndRender() is async and the parent card stays clickable
// until the re-render lands, so N rapid clicks on one Show Subtasks button used to stack N
// identical crumbs (duplicate breadcrumb segments). Only the TOP is compared: a legitimate
// A → B → A path can't happen via parent/child links, and deduping the whole stack would
// silently swallow a real drill level. Returns true if it pushed, false if it skipped —
// callers still run the rest of their navigation (activeTab/loadAndRender/close) either way.
export function pushSubtaskCrumb(stack, entry) {
  if (!stack || !entry || !entry.taskKey) return false;
  const top = stack[stack.length - 1];
  if (top && top.taskKey === entry.taskKey) return false;
  stack.push({ taskKey: entry.taskKey, title: entry.title });
  return true;
}

export function saveDraft(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
}

export function loadDraft(key) {
  try {
    const d = sessionStorage.getItem(key);
    return d ? JSON.parse(d) : null;
  } catch { return null; }
}

export function clearDraft(key) {
  try { sessionStorage.removeItem(key); } catch {}
}

// ── Save-time id collision set (C1017) ──
// A new-card proposal's id equalling a LIVE reservation placeholder's id is not a
// collision — it IS that reservation (booked via reserve_task_keys) being finalized.
// Excluding placeholders here is what lets ensureNewTaskClientId() keep the planner's
// reserved key instead of rewriting it to a synthetic "new-<ts>-<seq>" id, which used
// to force the server to burn a second key and orphan the original reservation row
// on every accepted objective-chat task.
export function buildUsedIds(tasks) {
  return new Set(
    (tasks || [])
      .filter(t => !t.isReservation)
      .map(t => String(t.id || ''))
      .filter(Boolean)
  );
}

// The other half of the fix described in buildUsedIds() above: keeping the planner's
// reserved key on the accepted card is only safe if that card REPLACES the reservation's
// own entry in the `tasks` array (read fresh from ./TODO.md just before save) instead of
// sitting alongside it. A bare push() left two entries with the same id — the server then
// burns a second reservation for the "duplicate", drops the real content in its first-wins
// dedup, and finalizes the placeholder text onto the new row while orphaning the original
// (C1378 et al). Call this instead of tasks.push() wherever a card's id might already be a
// live row read from the same task list.
export function upsertTaskEntry(tasks, task) {
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
}

// ── HTML escaping for data attributes ──
export function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// (C1385) Decide whether the fixed-position card-title tooltip should stay left-anchored
// at the hovered title (today's behavior) or flip to right-anchored so it doesn't run off
// the viewport's right edge. Pure function — no DOM — so it's directly unit-testable;
// task-card.js's title `mouseenter` handler is the only caller. Mirrors the horizontal
// clamp idiom `_positionMentionDropdown()` already uses in task-board.js, but measures the
// tooltip's real width instead of a hardcoded one, since the tooltip is already in the DOM
// (appended to document.body) by the time it's positioned.
//   titleRect: the hovered .card-title's getBoundingClientRect() (needs .left/.right)
//   tipWidth: the tooltip element's measured width (0/NaN → fails open to no-flip)
//   viewportWidth: caller passes document.documentElement.clientWidth (excludes the
//     always-on vertical scrollbar — see `html { overflow-y: scroll }` in styles.css)
//   margin: minimum gutter kept from either viewport edge, default 8px
// Returns { flip, left, right } — exactly one of left/right is non-null.
export function computeTooltipAnchor(titleRect, tipWidth, viewportWidth, margin = 8) {
  if (!Number.isFinite(tipWidth) || tipWidth <= 0) {
    return { flip: false, left: titleRect.left, right: null };
  }
  const fits = titleRect.left + tipWidth <= viewportWidth - margin;
  if (fits) {
    return { flip: false, left: titleRect.left, right: null };
  }
  // Flip: right-anchor to the title's right edge. If that would still push the tooltip's
  // left edge past the margin (title too far right AND tooltip too wide to fit even
  // flipped), clamp to the margin instead of letting it run off the left edge.
  const rightAnchored = viewportWidth - titleRect.right;
  const right = (titleRect.right - tipWidth < margin) ? margin : rightAnchored;
  return { flip: true, left: null, right };
}

// (TPT346) True when `inner` extends past `outer` by more than `tolerance` px on any side, i.e.
// the clipping box hides part of it. Pure: DOMRect-likes in, boolean out. A missing `outer`
// (nothing to clip against) is never clipped. The tolerance absorbs the card's 1-2px border,
// since the caller compares against the card's border box.
export function isRectClipped(inner, outer, tolerance = 1) {
  if (!inner || !outer) return false;
  return inner.top < outer.top - tolerance
    || inner.left < outer.left - tolerance
    || inner.bottom > outer.bottom + tolerance
    || inner.right > outer.right + tolerance;
}

// (C1133) 'openrouter/anthropic/claude-3.5-sonnet' → 'claude-3.5-sonnet' (full id kept
// in title=). Lives here (not console-modal.js) so task-board.js can share it without a
// console-modal.js → task-board.js import cycle (console-modal.js already imports
// updateClaudeButtons from task-board.js).
export function shortModelName(model) {
  const parts = String(model).split('/').filter(Boolean);
  return parts[parts.length - 1] || String(model);
}

// ── Markdown rendering ──
// Uses the global `marked` library loaded via <script> tag in HTML.
// Configure each parser object once so a late-loaded parser (or a test parser) gets the
// same renderers as the first one.
const _configuredMarkdownParsers = new WeakSet();
const FILE_REF_RE = /(^|[^\w.@/-])@([\w./-]+\.\w+)(?![\w./@-])/g;
// marked's own URL cleaning, for the images its replaced image renderer still draws itself.
function cleanMarkdownUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}
function configureMarked() {
  if (typeof marked === 'undefined' || _configuredMarkdownParsers.has(marked)) return;
  const linkTextTokens = new WeakSet();
  function skipLinkText(tokens) {
    for (const token of tokens || []) {
      if (token.type === 'text') linkTextTokens.add(token);
      if (token.tokens) skipLinkText(token.tokens);
    }
  }
  // Escape raw HTML in markdown source — task descriptions frequently mention
  // Vue/HTML tags as prose (e.g. "Add a <div class='main-input'> block"); without
  // escaping, marked emits them as live HTML, breaking surrounding DOM.
  marked.use({
    walkTokens(token) {
      if (token.type === 'link') skipLinkText(token.tokens);
    },
    renderer: {
      html({ text }) { return escapeAttr(text); },
      // (TPT9411) Attachments read the same in every read-only view (attachment-markup.js): an
      // image is a block on lines of its own, an uploaded file or project artifact an inline chip
      // with its name, both at the same-origin address. The URL decides which one a reference is,
      // whether it was written as an image or as a link; other links keep marked's own markup.
      image(token) {
        const alt = token.tokens ? this.parser.parseInline(token.tokens, this.parser.textRenderer) : token.text;
        const attachment = attachmentFromUrl(token.href);
        if (attachment && attachment.kind === 'file') {
          return fileChipHtml({ href: attachment.href, name: alt, title: token.title || alt, artifact: attachment.artifact });
        }
        const src = attachment ? attachment.src : cleanMarkdownUrl(token.href);
        if (src === null) return escapeHtml(alt);
        return imageBlockHtml({ src, alt, title: token.title || '' });
      },
      link(token) {
        const attachment = attachmentFromUrl(token.href);
        if (!attachment) return false;
        const text = this.parser.parseInline(token.tokens, this.parser.textRenderer);
        if (attachment.kind === 'image') return imageBlockHtml({ src: attachment.src, alt: text, title: token.title || '' });
        return fileChipHtml({
          href: attachment.href,
          nameHtml: this.parser.parseInline(token.tokens),
          title: token.title || text,
          artifact: attachment.artifact,
        });
      },
      text(token) {
        if (token.type !== 'text' || token.tokens || linkTextTokens.has(token)) return false;
        const source = token.text;
        const matches = [...source.matchAll(FILE_REF_RE)];
        if (!matches.length) return false;

        // Render each ordinary text segment through Marked's default text renderer for
        // escaping. Only the path's restricted characters go into our span markup.
        let html = '';
        let cursor = 0;
        for (const match of matches) {
          const before = source.slice(cursor, match.index) + match[1];
          html += this.parser.parseInline([{ type: 'text', text: before, escaped: token.escaped }]);
          html += `<span class="file-ref">@${match[2]}</span>`;
          cursor = match.index + match[0].length;
        }
        html += this.parser.parseInline([{ type: 'text', text: source.slice(cursor), escaped: token.escaped }]);
        return html;
      },
    },
  });
  _configuredMarkdownParsers.add(marked);
}

// (C1258) marked.parse(), attachment transforms, and sanitization run once per description.
// renderBoardContent() runs this once
// per card across every visible sprint tier (collapsed tiers are CSS-only, so their cards get
// fully built too), and renderObjectiveContent() runs it once per preview card across the whole
// chat transcript — both on EVERY loadAndRender(), including a pure left-nav Tasks<->Create
// switch. Output is a pure function of `text` (the token renderer and replace() passes are
// deterministic with no locale/theme/project dependency), so a raw-text->html memo is sound.
// Insertion-ordered Map + delete-oldest-on-overflow = LRU: recently-used entries get bumped to
// the end on a hit, so "descriptions currently on screen" naturally survive eviction.
const MARKDOWN_CACHE_LIMIT = 1000;
const _markdownCache = new Map();

// `opts.cache === false` renders without reading or writing the memo — for text that changes
// on every call (a reply still streaming), which would otherwise evict the entries that matter.
export function renderMarkdown(text, opts) {
  if (!text) return '';
  const useCache = !(opts && opts.cache === false);
  const cached = useCache ? _markdownCache.get(text) : undefined;
  if (cached !== undefined) {
    // Refresh recency (Map preserves insertion order — delete+set moves this key to the end).
    _markdownCache.delete(text);
    _markdownCache.set(text, cached);
    return cached;
  }
  try {
    configureMarked();
    // Uploaded images and files already point at the same-origin proxies (/api/images/…,
    // /api/files/…): the image and link renderers above rewrite them. A file chip carries the
    // `file-attachment-link` class, so the delegated click handler (file-attach.js
    // ensureFileLinkHandler) routes the click through electronAPI.openExternal instead of letting
    // an in-app anchor click navigate the Electron renderer away from the app (C1246).
    let html = tidyImageBlocks(marked.parse(text, { breaks: true, gfm: true }));
    html = html.replace(
      /<!-- trello:start -->([\s\S]*?)<!-- trello:end -->/g,
      '<div class="trello-appendix">$1</div>'
    );
    // Keep this last: every prior HTML rewrite must pass through the same DOM and
    // URL policy before callers insert the result with innerHTML.
    html = sanitizeMarkdownHtml(html);
    if (!useCache) return html;
    _markdownCache.set(text, html);
    if (_markdownCache.size > MARKDOWN_CACHE_LIMIT) {
      _markdownCache.delete(_markdownCache.keys().next().value);
    }
    return html;
  } catch (e) {
    // (C1258) NOT cached — this fires when `marked` hasn't loaded yet (configureMarked() bails
    // above and marked.parse throws ReferenceError). Caching the escaped fallback here would
    // permanently poison the entry for this text even after marked finishes loading.
    return escapeAttr(text);
  }
}

// Keep a card-sized markdown preview structurally valid by stopping before the last
// complete blank-line-separated block. A single oversized block still gets a hard
// character cut so malformed or paragraph-free input cannot bypass the limit.
export function truncateMarkdownAtParagraph(text, maxLength) {
  const raw = String(text || '');
  if (!Number.isFinite(maxLength) || maxLength < 1 || raw.length <= maxLength) return raw;

  const head = raw.slice(0, maxLength);
  let boundary = -1;
  for (const match of head.matchAll(/\n[ \t]*\n/g)) boundary = match.index;
  const complete = boundary > 0 ? head.slice(0, boundary).trimEnd() : head.trimEnd();
  return `${complete}\n\n… (truncated)`;
}

// ── DOM: skip transitions for one painted frame ──
// (TPT9023) Classes re-applied to freshly rendered nodes after a forced layout (has-active-session,
// highlight rings, a re-opened card) would otherwise transition in from the bare markup. A
// transition only starts when its after-change style allows one, so holding `no-transition` on
// `el` until a frame has painted shows them in their final state. The token lets a later call
// extend the window instead of having an earlier call's second frame cut it short.
export function skipTransitionsForFrame(el) {
  const token = (el._skipTransitionsToken || 0) + 1;
  el._skipTransitionsToken = token;
  el.classList.add('no-transition');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (el._skipTransitionsToken === token) el.classList.remove('no-transition');
  }));
}

// ── DOM: mark truncated cards ──
export function markTruncatedCards() {
  // (C1259) Read pass then write pass — reading scrollHeight/clientHeight then writing a
  // class/style on the SAME element inside one loop forces a synchronous layout recalc
  // per element (write invalidates layout, next element's read has to redo it). Splitting
  // into "measure everything, then mutate everything" collapses that back down to one
  // layout pass for the whole card grid.
  const els = document.querySelectorAll('.card, .preview-card');
  const measurements = Array.from(els, el => {
    // (TPT344) A board card's root never overflows any more — its .card-desc shrinks to fit the
    // max-height instead — so a clipped description is what marks it truncated. Previews clamp
    // their description on purpose (styles.css) and keep measuring the root only.
    const desc = el.matches('.card--preview, .preview-card') ? null : el.querySelector(':scope > .card-desc');
    const truncated = el.scrollHeight > el.clientHeight || (desc !== null && desc.scrollHeight > desc.clientHeight);
    return { el, truncated, scrollHeight: el.scrollHeight };
  });
  for (const { el, truncated, scrollHeight } of measurements) {
    el.classList.toggle('is-truncated', truncated);
    if (truncated) {
      el.style.setProperty('--full-height', scrollHeight + 'px');
    } else {
      el.style.removeProperty('--full-height');
    }
  }
}

// ── Textarea auto-grow (C1470) — measure-with-overflow-hidden, clamp, re-enable scroll
//    only at the cap. Same idiom already inlined 5x in the repo (chat-ui.js's
//    autoGrowComposer, task-board.js's title/comment composers, recipe-sidebar.js);
//    new call sites should use this instead of adding a 6th copy. capPx is a resolved
//    pixel cap (e.g. window.innerHeight * 0.6), not a CSS unit string. ──
export function autoGrowTextarea(el, capPx) {
  if (!el || !el.isConnected) return;
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  if (el.scrollHeight > capPx) {
    el.style.height = capPx + 'px';
    el.style.overflowY = 'auto';
  } else {
    el.style.height = el.scrollHeight + 'px';
    el.style.overflowY = '';
  }
}

// ── Textarea insertion ──
export function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.selectionStart = el.selectionEnd = pos;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Where a caret offset in text `prev` lands once the text becomes `next`. Only the span between
// the two texts' common head and tail changed: an offset before that span stays, one after it
// moves by the length change, one inside it lands at the span's new end. (TPT9346) Also used for a
// caret remembered while its editor is closed (Task Edit's description).
export function caretMapper(prev, next) {
  const limit = Math.min(prev.length, next.length);
  let head = 0;
  while (head < limit && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < limit - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return (pos) => {
    if (pos <= head) return pos;
    if (pos >= prev.length - tail) return pos + next.length - prev.length;
    return next.length - tail;
  };
}

// Give a text field a new value without moving its caret off the text it was on — assigning
// `.value` alone puts the caret at the end, so the next insertAtCursor() would append. The caret
// follows caretMapper(). Fires no event. Returns whether the value changed.
export function setValueKeepingCaret(el, value) {
  const prev = String(el.value ?? '');
  const next = String(value ?? '');
  if (prev === next) return false;
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = el;
  const map = caretMapper(prev, next);
  el.value = next;
  if (Number.isInteger(start) && Number.isInteger(end)) el.setSelectionRange(map(start), map(end), direction || 'none');
  return true;
}

// Update partial transcripts in place and dispatch input events. Replace the
// owned span only while its text and cursor still match; user edits or focus
// changes must not be overwritten. Final segments freeze.
export function createLiveInserter(el, { resolve } = {}) {
  let target = el;
  let anchor = el.selectionStart ?? el.value.length;
  let lastText = '';
  let lastValue = el.value;
  let hypothesis = '';
  let consumedWords = 0;
  let separated = false;
  const words = text => [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];

  function field() {
    if (target && target.isConnected !== false) return target;
    const next = resolve ? resolve()
      : (target.id && typeof document !== 'undefined' ? document.getElementById(target.id) : null);
    if (next && next !== target) {
      // A byte-identical draft with the same caret is still our span. Any other replacement
      // requires a fresh anchor; never infer ownership from a coincidental substring match.
      if (next.value === lastValue && next.selectionStart === anchor + lastText.length &&
          next.selectionEnd === next.selectionStart) {
        target = next;
        return target;
      }
      consumedWords = next.value === lastValue ? words(hypothesis).length : 0;
      if (next.value !== lastValue) hypothesis = '';
      target = next;
      anchor = target.selectionEnd ?? target.value.length;
      lastText = '';
      lastValue = target.value;
      separated = consumedWords > 0;
    }
    return target;
  }

  function stillOwnsField() {
    const f = field();
    if (!f || f.isConnected === false) return false;
    const expectedCursor = anchor + lastText.length;
    if (f.selectionStart !== expectedCursor || f.selectionEnd !== expectedCursor) return false;
    return f.value === lastValue && f.value.slice(anchor, expectedCursor) === lastText;
  }

  function resetAnchorToCursor() {
    const f = field();
    // Never replace a selection made by the user while dictation is live.
    anchor = f.selectionEnd ?? f.value.length;
    lastText = '';
    lastValue = f.value;
    consumedWords = Math.max(consumedWords, words(hypothesis).length);
    separated = anchor > 0 && !/\s/.test(f.value[anchor - 1]);
  }

  function write(text) {
    const f = field();
    const before = f.value.slice(0, anchor);
    const after = f.value.slice(anchor + lastText.length);
    f.value = before + text + after;
    lastText = text;
    lastValue = f.value;
    const pos = anchor + text.length;
    f.selectionStart = f.selectionEnd = pos;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function update(text, final) {
    const f = field();
    if (!f || f.isConnected === false) return;
    if (!stillOwnsField()) resetAnchorToCursor();
    let suffix = text;
    if (consumedWords) {
      const remaining = words(text)[consumedWords];
      suffix = remaining ? text.slice(remaining.index) : '';
    }
    hypothesis = text;
    // A punctuation-only revision after an edit belongs to the user's frozen span.
    if (suffix || lastText) {
      if (suffix && separated && anchor > 0 && !/\s/.test(f.value[anchor - 1])) suffix = ` ${suffix}`;
      if (final && suffix && !/\s$/.test(suffix)) suffix += ' ';
      write(suffix);
    }
    if (final) {
      anchor += lastText.length;
      lastText = '';
      hypothesis = '';
      consumedWords = 0;
      // If a user edit consumed the entire final, separate the next dictated sentence.
      separated = anchor > 0 && !/\s/.test(f.value[anchor - 1]);
    }
  }

  return {
    // Replace the currently-shown (not-yet-final) span with `text`.
    setPartial(text) {
      update(text, false);
    },
    // Freeze `text` as real content and advance past it, so the next setPartial()/commit()
    // starts a fresh span rather than overwriting this one.
    commit(text) {
      update(text, true);
    },
  };
}

// ── ANSI escape stripping ──
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z@`]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[>=]|\r/g, '');
}

// ── Strip JSON blocks from display text ──
export function stripJsonFromDisplay(text) {
  let result = text;
  // 1) Remove ```json ... ``` blocks — greedy [\s\S]* spans nested backticks
  //    inside JSON string values (e.g. task descriptions with code fences).
  //    Safe during streaming: incomplete blocks lack closing ``` so regex is a no-op.
  result = result.replace(/```json\s*[\s\S]*```/gi, '');
  // 2) Remove generic ``` { ... } ``` blocks (greedy)
  result = result.replace(/```\s*\n\s*\{[\s\S]*\}\s*\n\s*```/g, '');
  // 3) Remove tool-call XML wrappers (lazy is fine — no nesting issue)
  result = result.replace(/<tool_call>[\s\S]*?<\/tool_result>/g, '');
  // 4) Remove bare {"changes": [...]} or {"tasks": [...]} — greedy to span nested brackets
  result = result.replace(/\{(?:"changes"|"tasks")\s*:\s*\[[\s\S]*\]\s*\}/g, '');
  // 5) Fallback: if JSON fingerprints still remain, brace-walk to remove the block
  if (/"changes"\s*:/.test(result) || /"tasks"\s*:/.test(result) || /"category"\s*:\s*"(?:CODING|HUMAN)"/.test(result)) {
    result = removeBracedJsonBlock(result);
  }
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

// Helper: find outermost { ... } containing "changes"/"tasks" and remove it
function removeBracedJsonBlock(text) {
  const marker = text.search(/"(?:changes|tasks)"/);
  if (marker === -1) {
    const catMatch = text.search(/"category"\s*:\s*"(?:CODING|HUMAN)"/);
    if (catMatch === -1) return text;
  }
  const anchor = marker !== -1 ? marker : text.search(/"category"\s*:\s*"(?:CODING|HUMAN)"/);
  // Walk left to find outermost {
  let depth = 0;
  let start = -1;
  for (let i = anchor; i >= 0; i--) {
    if (text[i] === '}') depth++;
    if (text[i] === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return text;
  // Walk right from start to find matching }
  depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + 1);
}

// ── Sprint combo-box helpers ──

export function renderSprintCombobox({ id, current, keys, variant, includeBacklog = false, globalMaxKey } = {}) {
  const sorted = [...(keys || [])].map(Number).filter(k => Number.isFinite(k) && k > 0).sort((a, b) => a - b);
  const maxKey = Math.max(sorted.length ? sorted[sorted.length - 1] : 0, globalMaxKey ?? 0);
  const newLabel = groupNewLabel(maxKey + 1);
  const isBacklog = includeBacklog && (
    current === null ||
    current === 'null' ||
    (current !== undefined && current !== '' && Number(current) === 0)
  );
  const currentStr = isBacklog ? 'null' : (current != null ? String(current) : '');

  let inputVal = '';
  if (isBacklog) inputVal = 'Backlog';
  else if (currentStr === '__new__') inputVal = newLabel;
  else if (currentStr !== '' && !isNaN(Number(currentStr)) && Number(currentStr) > 0) inputVal = groupTitle(currentStr);

  const reversed = [...sorted].reverse();
  const visibleKeys = reversed.slice(0, 10);
  const hiddenKeys = reversed.slice(10);

  const visibleItems = visibleKeys.map(k =>
    `<div class="sprint-combo-item" data-value="${k}">${groupTitle(k)}</div>`
  ).join('');
  const hiddenItems = hiddenKeys.map(k =>
    `<div class="sprint-combo-item" data-value="${k}" data-sprint-hidden hidden>${groupTitle(k)}</div>`
  ).join('');
  const backlogItem = includeBacklog
    ? '<div class="sprint-combo-item sprint-combo-item--backlog" data-value="null">Backlog</div>'
    : '';

  const isPlainWithId = variant !== 'pill' && id && id !== '__bulk__';
  const inputIdAttr = isPlainWithId ? ` id="${id}"` : '';
  const placeholderAttr = variant !== 'pill' && !inputVal ? ' placeholder="-- Select --"' : '';
  const valueAttr = inputVal ? ` value="${inputVal}"` : '';

  return `<div class="sprint-combo sprint-combo--${variant}" data-id="${id}" data-current="${currentStr}"><input class="sprint-combo-input" type="text"${inputIdAttr} readonly${valueAttr}${placeholderAttr}><div class="sprint-combo-dropdown" hidden>${backlogItem}<div class="sprint-combo-item sprint-combo-item--new" data-value="__new__">${newLabel}</div>${visibleItems}${hiddenItems}</div></div>`;
}

export function initSprintCombobox(combo, { onSelect }) {
  const input = combo.querySelector('.sprint-combo-input');
  const dropdown = combo.querySelector('.sprint-combo-dropdown');
  if (!input || !dropdown) return;

  let _scrollHandler = null;
  let _resizeHandler = null;

  const getItems = () => [...dropdown.querySelectorAll('.sprint-combo-item')];
  const getVisible = () => getItems().filter(el => !el.hidden);

  function setActive(item) {
    getItems().forEach(el => el.classList.remove('active'));
    if (item) item.classList.add('active');
  }

  function restoreItemVisibility() {
    getItems().forEach(el => {
      if (!el.classList.contains('sprint-combo-item--new')) {
        el.hidden = el.hasAttribute('data-sprint-hidden');
      } else {
        el.hidden = false;
      }
    });
  }

  function getLabelForValue(val) {
    const items = getItems();
    const match = items.find(el => el.dataset.value === String(val));
    if (match) return match.textContent;
    return '';
  }

  function positionDropdown() {
    const rect = input.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.minWidth = rect.width + 'px';
    const h = dropdown.offsetHeight || 260;
    if (rect.bottom + h + 2 > window.innerHeight && rect.top > h + 2) {
      dropdown.style.top = (rect.top - h - 2) + 'px';
    } else {
      dropdown.style.top = (rect.bottom + 2) + 'px';
    }
  }

  function commit(item) {
    if (!item) return;
    const rawVal = item.dataset.value;
    const prevVal = combo.dataset.current;
    combo.dataset.current = rawVal;
    input.value = item.textContent;
    close();
    onSelect(rawVal, prevVal);
    combo.dispatchEvent(new CustomEvent('sprint-combo:change', { bubbles: true }));
  }

  function open() {
    if (!dropdown.hidden) return;
    input.readOnly = false;
    restoreItemVisibility();
    dropdown.dataset.portaled = '1';
    combo._portaledDropdown = dropdown;
    document.body.appendChild(dropdown);
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '3100'; // C1358: dialog band moved to 3000+, keep in sync
    dropdown.hidden = false;
    positionDropdown();
    const match = getItems().find(el => el.dataset.value === combo.dataset.current);
    setActive(match || null);
    if (match) match.scrollIntoView({ block: 'nearest' });
    _scrollHandler = positionDropdown;
    _resizeHandler = positionDropdown;
    window.addEventListener('scroll', _scrollHandler, true);
    window.addEventListener('resize', _resizeHandler);
  }

  function close() {
    if (_scrollHandler) { window.removeEventListener('scroll', _scrollHandler, true); _scrollHandler = null; }
    if (_resizeHandler) { window.removeEventListener('resize', _resizeHandler); _resizeHandler = null; }
    input.readOnly = true;
    dropdown.hidden = true;
    if (dropdown.dataset.portaled) {
      delete dropdown.dataset.portaled;
      combo._portaledDropdown = null;
      if (combo.isConnected) {
        combo.appendChild(dropdown);
      } else {
        dropdown.remove();
        return;
      }
      dropdown.style.position = '';
      dropdown.style.zIndex = '';
      dropdown.style.left = '';
      dropdown.style.top = '';
      dropdown.style.minWidth = '';
    }
    const label = getLabelForValue(combo.dataset.current);
    input.value = label || '';
    if (!label && input.placeholder) input.value = '';
    restoreItemVisibility();
    getItems().forEach(el => el.classList.remove('active'));
  }

  input.addEventListener('click', open);
  input.addEventListener('focus', open);

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    getItems().forEach(el => {
      if (el.classList.contains('sprint-combo-item--new')) { el.hidden = false; return; }
      el.hidden = !el.textContent.toLowerCase().includes(q);
    });
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden) { if (e.key === 'Enter' || e.key === 'ArrowDown') open(); return; }
    const visible = getVisible();
    const activeIdx = visible.findIndex(el => el.classList.contains('active'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(visible[(activeIdx + 1) % visible.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(visible[(activeIdx - 1 + visible.length) % visible.length]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = visible.find(el => el.classList.contains('active'));
      if (active) commit(active); else close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.sprint-combo-item');
    if (item) { e.preventDefault(); commit(item); }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { if (!dropdown.hidden) close(); }, 150);
  });
}

export function refreshSprintComboboxItems(combo, keys, { includeBacklog = false, globalMaxKey } = {}) {
  const dropdown = combo && (combo._portaledDropdown || combo.querySelector('.sprint-combo-dropdown'));
  if (!dropdown) return;
  const sorted = [...(keys || [])].map(Number).filter(k => Number.isFinite(k) && k > 0).sort((a, b) => a - b);
  const maxKey = globalMaxKey !== undefined ? globalMaxKey : (sorted.length ? sorted[sorted.length - 1] : 0);
  const newLabel = groupNewLabel(maxKey + 1);
  const reversed = [...sorted].reverse();
  const visibleKeys = reversed.slice(0, 10);
  const hiddenKeys = reversed.slice(10);
  const visibleItems = visibleKeys.map(k =>
    `<div class="sprint-combo-item" data-value="${k}">${groupTitle(k)}</div>`
  ).join('');
  const hiddenItems = hiddenKeys.map(k =>
    `<div class="sprint-combo-item" data-value="${k}" data-sprint-hidden hidden>${groupTitle(k)}</div>`
  ).join('');
  const backlogItem = includeBacklog
    ? '<div class="sprint-combo-item sprint-combo-item--backlog" data-value="null">Backlog</div>'
    : '';
  dropdown.innerHTML = `${backlogItem}<div class="sprint-combo-item sprint-combo-item--new" data-value="__new__">${newLabel}</div>${visibleItems}${hiddenItems}`;
}

// Highest sprint number from authoritative API sprint records (lags-proof floor for state.tierKeys)
export function sprintRecordMax(sprints) {
  return (sprints || []).reduce((m, s) => Math.max(m, s.number ?? s.id ?? 0), 0);
}

// ── Normalize parsed JSON: accept "tasks" key as alias for "changes" ──
// Claude sometimes outputs {"tasks":[...]} instead of {"changes":[...]}.
// Also normalizes flat task objects into the {type, task} wrapper shape.
function normalizeProposals(parsed) {
  if (!parsed) return null;
  if (!parsed.changes && parsed.tasks && Array.isArray(parsed.tasks)) {
    parsed.changes = parsed.tasks.map(t =>
      (t.type && t.task) ? t : { type: 'new', task: t }
    );
  }
  if (parsed.changes && Array.isArray(parsed.changes)) {
    const proposedCount = parsed.changes.length;
    parsed.changes = parsed.changes.filter(c => c && ['new', 'modified'].includes(c.type) && c.task && typeof c.task === 'object' && !Array.isArray(c.task));
    for (const c of parsed.changes) {
      if (c.task.description) c.task.description = c.task.description.replace(/(?<!\\)~/g, '\\~');
      // C1072: only new cards default to the start status — a modified card must never
      // carry a status nobody asked to change (Object.assign downstream would flip a
      // live in_progress/on_fire task back to the start status).
      if (c.type === 'new') c.task.status = startName();
      else delete c.task.status;
    }
    parsed.changes = parsed.changes.filter(c => c.type !== 'modified'
      || !isLockedTargetStatus(state.taskStatusById.get(c.task?.id || c.task?.task_key)));
    parsed.proposalResult = describeProposalResult(parsed, proposedCount);
  }
  return parsed;
}

// ── Parse objective result JSON (5-strategy fallback) ──
export function parseObjectiveResult(rawContent) {
  // Strategy 1: lazy-matched ```json blocks
  const blocks = [...rawContent.matchAll(/```json\s*([\s\S]*?)```/gi)];
  let proposals;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = normalizeProposals(JSON.parse(blocks[i][1]));
      if (parsed.changes) { proposals = parsed; break; }
    } catch {}
  }
  // Strategy 2: greedy match
  if (!proposals) {
    const openPattern = /```json\s*/gi;
    let openMatch;
    while (!proposals && (openMatch = openPattern.exec(rawContent))) {
      const contentStart = openMatch.index + openMatch[0].length;
      const closePattern = /```/g;
      closePattern.lastIndex = contentStart;
      const closePositions = [];
      let closeMatch;
      while ((closeMatch = closePattern.exec(rawContent))) {
        closePositions.push(closeMatch.index);
      }
      for (let i = closePositions.length - 1; i >= 0; i--) {
        const candidate = rawContent.slice(contentStart, closePositions[i]);
        try {
          const parsed = normalizeProposals(JSON.parse(candidate));
          if (parsed.changes) { proposals = parsed; break; }
        } catch {}
      }
    }
  }
  // Strategy 3: generic code blocks
  if (!proposals) {
    const genericBlocks = [...rawContent.matchAll(/```\s*\n([\s\S]*?)```/g)];
    for (const gb of genericBlocks) {
      try {
        const parsed = normalizeProposals(JSON.parse(gb[1]));
        if (parsed.changes) { proposals = parsed; break; }
      } catch {}
    }
  }
  // Strategy 4: raw JSON object (supports both "changes" and "tasks" keys)
  if (!proposals) {
    const jsonMatch = rawContent.match(/\{(?:"changes"|"tasks")\s*:\s*\[[\s\S]*\]\s*\}/);
    if (jsonMatch) {
      try { proposals = normalizeProposals(JSON.parse(jsonMatch[0])); } catch {}
    }
  }
  // Strategy 5: strip tool-call XML and retry
  if (!proposals) {
    const stripped = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_result>/g, '').trim();
    if (stripped !== rawContent) {
      const strippedBlocks = [...stripped.matchAll(/```json\s*([\s\S]*?)```/gi)];
      if (strippedBlocks.length > 0) {
        try { proposals = normalizeProposals(JSON.parse(strippedBlocks[strippedBlocks.length - 1][1])); } catch {}
      }
      if (!proposals) {
        const jsonMatch2 = stripped.match(/\{(?:"changes"|"tasks")\s*:\s*\[[\s\S]*\]\s*\}/);
        if (jsonMatch2) { try { proposals = normalizeProposals(JSON.parse(jsonMatch2[0])); } catch {} }
      }
    }
  }
  if (!proposals) {
    const preview = rawContent.slice(0, 300).replace(/\n/g, '\\n');
    const err = new Error(`No JSON found in Claude's output`);
    err.preview = preview;
    err.rawLength = rawContent.length;
    throw err;
  }
  if (!proposals.changes || !Array.isArray(proposals.changes)) {
    const err = new Error('JSON missing "changes" array');
    err.preview = rawContent.slice(0, 300).replace(/\n/g, '\\n');
    err.rawLength = rawContent.length;
    throw err;
  }
  return proposals;
}

// opts.groupingEnabled (C1558) — projects.use_objective_grouping, default true. Threaded
// straight to buildObjectiveSystemPrompt(); the default keeps the systemPrompt byte-identical
// to pre-C1558 output so the --append-system-prompt cache prefix never churns for the common
// case. chat-ui.js is the only caller and passes getObjectiveGroupingEnabled() (group-label.js).
// opts.originTaskKey (C1559) — same no-churn contract, threaded straight through. chat-ui.js
// passes tabOriginTaskKey() (the active TAB's own captured key, never state.chatState directly
// — see chat-ui.js's buildObjectivePrompt() call sites for why that distinction matters after
// a WS-restart clearActiveTab()).
// (TPT254) Prompt body substituted for a blank subtask kickoff. Payload only — it never
// becomes originalUserText, a transcript bubble, or an Objective History recipe.
export const BLANK_SUBTASK_BRIEF = 'Split this task into subtasks.';

export function buildObjectivePrompt(userText, existingChanges, feedbackText, { groupingEnabled = true, originTaskKey = null } = {}) {
  let userPrompt;
  if (existingChanges && feedbackText) {
    userPrompt = `Objective from the user:\n\n${userText}\n\n---\n\nPrevious task proposals (to revise):\n\n\`\`\`json\n${JSON.stringify({ changes: existingChanges }, null, 2)}\n\`\`\`\n\nUser feedback on previous proposals:\n\n${feedbackText}\n\nPlease revise the proposals above based on this feedback. Re-run the READ-ONLY WORKFLOW only for tags/files not already consulted in this session. Reuse the task keys already reserved for previously-proposed tasks you are carrying over; call reserve_task_keys only for genuinely new tasks this revision introduces. For every carried-over "modified" card, DESCRIPTION PRESERVATION still applies: start from the description in its previous proposal above and apply ONLY the change this feedback asks for — keep every requirement, @path, function name and verification check it already holds unless the feedback explicitly removes it. A carried-over "modified" card with no \`description\` in its previous proposal (tags-only, priority-only, dependencies-only) stays description-less unless this feedback asks to change its description — then load the full current description first. Do NOT Edit/Write files. Output the complete updated task list.`;
  } else {
    userPrompt = `Objective from the user:\n\n${userText}`;
  }

  return { systemPrompt: buildObjectiveSystemPrompt({
    groupingEnabled, originTaskKey, names: statusNames(), active: activeNames(),
    roles: { start: startName(), in_progress: inProgressName(), complete: completeName(), canceled: canceledName() },
  }), userPrompt };
}

// ── Spec Chat system prompt builder ──
// Returns system prompt string scoped to spec editing for a single task.
// Client sends this via { type: 'start-spec-chat', systemPrompt, taskKey, openingMessage? }.
export function buildSpecChatSystemPrompt(task) {
  const tagList = Array.isArray(task.tags) ? task.tags.join(', ') : '';
  return `⚠️ SPEC EDITOR MODE ⚠️
You are a task specification editor for task ${task.id}: "${task.title}".
Current tags: ${tagList || '(none)'}. Current priority: ${task.priority ?? '(unset)'}.

Your ONLY goal: help the user sharpen this task's specification — title, description, tags, and priority.

WORKFLOW:
1. Read the full task JSON in the first user message carefully.
2. Ask clarifying questions to understand intent, scope, and acceptance criteria. Be specific.
3. Iterate across turns until you fully understand what the task should accomplish.
4. When the user confirms they are satisfied (or asks you to propose changes), emit ONE fenced \`\`\`json block:

\`\`\`json
{"spec_update": {"title": "...", "description": "...", "tags": [...], "priority": N}}
\`\`\`

Only include fields that should change — all fields are optional. Description should be concise, human-readable numbered steps with exact file paths. Tags: 3-5, ≥1 tt-* feature tag + 1 action tag.

RULES:
- Never propose spec_update until the user explicitly confirms or requests it.
- Do NOT output any code implementations — spec only.
- Read-only tools available: Read, mcp__tipatask-local__batch_grep_tags, mcp__tipatask__get_tag_architecture.
- No Edit/Write/Bash/Glob/Grep — omitted intentionally.
- One \`\`\`json block per response maximum. No other JSON in responses.
- After emitting spec_update, explain what changed and why. Then await further input.`;
}

// ── Tag badge with description tooltip ──
export function renderTagBadge(name, descriptions) {
  const desc = descriptions && descriptions.get ? descriptions.get(name) : null;
  const title = desc ? ` title="${escapeAttr(desc)}"` : '';
  return `<span class="tag-badge"${title}>${escapeAttr(name)}</span>`;
}

// ── API connectivity banner ──
// Singleton #api-status-banner: bottom-right corner, z-index 10000.
// state: 'reconnecting' | 'disconnected' | 'connected'
// (TPT9007) Copy is apiStatus.*, resolved per call; `message` (the api-status frame's raw transport
// error) is shown verbatim and never parsed as HTML.
export function showApiStatusBanner(apiState, message, pendingCount = 0) {
  // Inject keyframes once
  if (!document.getElementById('api-status-banner-style')) {
    const s = document.createElement('style');
    s.id = 'api-status-banner-style';
    s.textContent = '@keyframes api-banner-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  let banner = document.getElementById('api-status-banner');

  if (apiState === 'connected') {
    if (!banner) return; // no prior offline banner → no-op
    clearTimeout(banner._dismissTimer);
    banner.style.background = '#2ea043';
    banner.style.opacity = '1';
    banner.textContent = t('apiStatus.reconnected');
    banner._dismissTimer = setTimeout(() => {
      banner.style.opacity = '0';
      setTimeout(() => banner && banner.remove(), 300);
    }, 1500);
    return;
  }

  // disconnected / reconnecting — create or reuse
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'api-status-banner';
    banner.style.cssText = 'position:fixed;bottom:2rem;right:1.5rem;color:#fff;padding:0.45rem 1rem;border-radius:6px;font-size:0.85rem;z-index:10000;display:flex;align-items:center;gap:0.5rem;transition:opacity 0.3s ease;';
    document.body.appendChild(banner);
    requestAnimationFrame(() => { banner.style.opacity = '1'; });
  } else {
    clearTimeout(banner._dismissTimer);
  }

  if (apiState === 'reconnecting') {
    banner.style.background = '#444';
    const spinSvg = '<svg width="12" height="12" viewBox="0 0 12 12" style="animation:api-banner-spin 1s linear infinite;flex-shrink:0"><circle cx="6" cy="6" r="4.5" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><path d="M6 1.5A4.5 4.5 0 0 1 10.5 6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
    const label = pendingCount
      ? tc('apiStatus.reconnectingQueued', pendingCount)
      : (message || t('apiStatus.reconnecting'));
    banner.innerHTML = spinSvg + escapeAttr(label);
  } else {
    // disconnected
    banner.style.background = '#c53030';
    banner.textContent = t('apiStatus.offline', { msg: message || t('apiStatus.unreachable') });
  }
  const closeBtn = document.createElement('button');
  closeBtn.setAttribute('aria-label', t('btn.dismiss'));
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;padding:0 0 0 0.5rem;font-size:1.1rem;line-height:1;opacity:0.7;flex-shrink:0;margin-left:auto;';
  closeBtn.onclick = () => {
    clearTimeout(banner._dismissTimer);
    banner.style.opacity = '0';
    setTimeout(() => banner && banner.remove(), 300);
  };
  banner.appendChild(closeBtn);
}

// ── Global saving indicator (background-save spinner badge, C1007) ──
// Singleton #tt-saving-indicator, appended to document.body so it survives
// full #app re-renders (board loadAndRender rebuilds #app innerHTML wholesale).
// Ref-counted so overlapping saves (e.g. a bulk action firing while another
// save is still in flight) don't hide the badge prematurely.
let _savingIndicatorCount = 0;

export function showSavingIndicator() {
  _savingIndicatorCount++;
  let el = document.getElementById('tt-saving-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tt-saving-indicator';
    el.className = 'tt-saving-indicator';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="tt-spinner" aria-hidden="true"></span><span class="tt-saving-label"></span>';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  }
  const label = el.querySelector('.tt-saving-label');
  if (label) label.textContent = t('common.saving');
}

export function hideSavingIndicator() {
  _savingIndicatorCount = Math.max(0, _savingIndicatorCount - 1);
  if (_savingIndicatorCount > 0) return;
  const el = document.getElementById('tt-saving-indicator');
  if (el) el.remove();
}

// ── Full-screen board loader (TPT111) ──
// Unlike the corner Saving… pill above, this is a click-blocking overlay: it covers the
// board from a card double-click until the task edit modal paints. Singleton
// #tt-board-loader, body-appended so it survives the #app rebuild loadAndRender() does
// underneath it (the terminal-bridge open path awaits loadAndRender() before opening the
// modal). Ref-counted — the modal-open error banner's Retry and the diff-mode "Open live
// task" hatch both re-enter openTaskEditModal(), and the terminal bridge wraps its own
// loadAndRender()+openTaskEditModal() pair in one show/hide around the modal's own.
// api-client's `_http()` has no request timeout, so a hung request could otherwise leave
// an inescapable blocker — a capture-phase Escape handler force-hides it (count reset to
// 0) as an escape hatch; the in-flight request is left to resolve or fail on its own.
let _boardLoaderCount = 0;
function _onBoardLoaderKeydown(e) {
  if (e.key === 'Escape') hideBoardLoader({ force: true });
}

export function showBoardLoader() {
  _boardLoaderCount++;
  if (document.getElementById('tt-board-loader')) return;
  const el = document.createElement('div');
  el.id = 'tt-board-loader';
  el.className = 'board-modal-loader';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = `<span class="tt-spinner-lg" aria-hidden="true"></span><span>${t('common.loading')}</span>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', _onBoardLoaderKeydown, true);
}

export function hideBoardLoader({ force = false } = {}) {
  _boardLoaderCount = force ? 0 : Math.max(0, _boardLoaderCount - 1);
  if (_boardLoaderCount > 0) return;
  document.removeEventListener('keydown', _onBoardLoaderKeydown, true);
  const el = document.getElementById('tt-board-loader');
  if (el) el.remove();
}

// ── Toast notification (C1050) — shares the #tt-saving-indicator pill layout ──
const TOAST_DEFAULT_MS = 2000;
const ERROR_TOAST_MS = 30000;

function addErrorToastControls(el) {
  el.classList.add('tt-toast--dismissible');
  const countdown = document.createElement('span');
  countdown.className = 'toast-countdown';
  countdown.setAttribute('role', 'timer');
  countdown.setAttribute('aria-label', t('toast.timeRemaining'));
  const formatSeconds = new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'second' });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', t('toast.closeError'));
  close.textContent = '×';
  el.append(countdown, close);

  let remainingMs = ERROR_TOAST_MS;
  let deadline;
  let timer = null;
  let hovered = false;
  let previousFocus;

  function tick() {
    timer = null;
    if (!el.isConnected) return;
    remainingMs = Math.max(0, deadline - window.performance.now());
    const seconds = Math.ceil(remainingMs / 1000);
    countdown.textContent = formatSeconds.format(seconds);
    if (seconds === 0) {
      el.style.opacity = '0';
      timer = window.setTimeout(() => el.remove(), 300);
    } else {
      timer = window.setTimeout(tick, remainingMs - (seconds - 1) * 1000);
    }
  }

  function pause() {
    if (timer === null || remainingMs === 0) return;
    remainingMs = Math.max(0, deadline - window.performance.now());
    if (remainingMs === 0) return; // The expiry callback is already due.
    window.clearTimeout(timer);
    timer = null;
    countdown.textContent = formatSeconds.format(Math.ceil(remainingMs / 1000));
  }

  function resume() {
    if (timer !== null || remainingMs === 0) return;
    deadline = window.performance.now() + remainingMs;
    tick();
  }

  el.addEventListener('mouseenter', () => { hovered = true; pause(); });
  el.addEventListener('mouseleave', () => {
    hovered = false;
    if (document.activeElement !== close) resume();
  });
  close.addEventListener('focus', (event) => { previousFocus = event.relatedTarget; pause(); });
  close.addEventListener('blur', () => { if (!hovered) resume(); });
  close.addEventListener('click', () => {
    const wasFocused = document.activeElement === close;
    remainingMs = 0;
    window.clearTimeout(timer);
    el.remove();
    if (wasFocused && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  });
  resume();
}

function showCornerBadge({ glyph, text, variant, error = false, durationMs = TOAST_DEFAULT_MS }) {
  const el = document.createElement('div');
  el.className = `tt-saving-indicator tt-saving-indicator--toast ${variant}`;
  const icon = document.createElement('span');
  icon.className = 'tt-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = glyph;
  const label = document.createElement('span');
  label.className = 'tt-saving-label';
  label.textContent = text;
  // Announce the error message once. The timer and close button sit outside the alert.
  const liveRegion = error ? label : el;
  liveRegion.setAttribute('role', error ? 'alert' : 'status');
  liveRegion.setAttribute('aria-live', error ? 'assertive' : 'polite');
  el.append(icon, label);
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  if (error) addErrorToastControls(el);
  else setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, durationMs);
}

export function showSaveToast(count) {
  showCornerBadge({ glyph: '✓', text: tc('common.tasksSaved', count), variant: 'tt-toast--success' });
}

// type: 'success' → green check, 'error' → red cross, default → gray info
// Errors use a fixed 30s countdown. opts.durationMs applies to success and info (default 2s).
export function showToast(message, type, opts = {}) {
  const glyph = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  const variant = type === 'success' ? 'tt-toast--success' : type === 'error' ? 'tt-toast--error' : 'tt-toast--info';
  const durationMs = Number.isFinite(opts.durationMs) && opts.durationMs > 0 ? opts.durationMs : TOAST_DEFAULT_MS;
  showCornerBadge({ glyph, text: message, variant, error: type === 'error', durationMs });
}

// Persistent toast with a handle to update its text and dismiss explicitly (C1040).
// Long operations such as Knowledge Base Re-Index update this element while running.
export function showProgressToast(initialText) {
  const el = document.createElement('div');
  el.className = 'tt-saving-indicator tt-saving-indicator--toast tt-toast--info';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const icon = document.createElement('span');
  icon.className = 'tt-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'ℹ';
  const label = document.createElement('span');
  label.className = 'tt-saving-label';
  label.textContent = initialText;
  el.append(icon, label);
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });

  let dismissed = false;
  const dismiss = (delayMs) => {
    if (dismissed) return;
    dismissed = true;
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, delayMs);
  };
  return {
    update(text) { if (!dismissed) label.textContent = text; },
    done(text) {
      if (dismissed) return;
      el.classList.replace('tt-toast--info', 'tt-toast--success');
      icon.textContent = '✓';
      label.textContent = text;
      dismiss(2000);
    },
    fail(text) {
      if (dismissed) return;
      dismissed = true;
      el.remove();
      showToast(text, 'error');
    },
    // Fade out with no outcome message — for an operation whose result shows up elsewhere
    // (a dictation landing in its field, TPT9158).
    close() {
      dismiss(0);
    },
  };
}

// ── Action banner (bottom-left, z-index 10001 — above api-status-banner) ──
// (C1388) Generic form extracted from the old reauth-only showReauthBanner() so the
// C1352 "project setup required" case (see § Setup-required banner below) can show its
// own persistent action banner without fighting the reauth banner for the same
// singleton #id and slot — each caller gets its own id, so a real 401 and a stale
// setup wizard can be flagged at the same time without either clobbering the other.
export function showActionBanner({ id, label, actionLabel, busyLabel, onAction } = {}) {
  let banner = document.getElementById(id);
  if (banner) return; // already shown
  banner = document.createElement('div');
  banner.id = id;
  banner.style.cssText = 'position:fixed;bottom:2rem;left:1.5rem;background:#7f1d1d;color:#fff;padding:0.5rem 0.75rem 0.5rem 1rem;border-radius:6px;font-size:0.85rem;z-index:10001;display:flex;align-items:center;gap:0.75rem;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const btn = document.createElement('button');
  btn.textContent = actionLabel;
  btn.style.cssText = 'background:#ef4444;border:none;color:#fff;padding:0.3rem 0.75rem;border-radius:4px;cursor:pointer;font-size:0.82rem;white-space:nowrap;';
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try { if (onAction) await onAction(); } finally {
      if (document.getElementById(id)) {
        btn.disabled = false;
        btn.textContent = actionLabel;
      }
    }
  });
  banner.appendChild(labelEl);
  banner.appendChild(btn);
  document.body.appendChild(banner);
}

export function hideActionBanner(id) {
  const b = document.getElementById(id);
  if (b) b.remove();
}

// ── Re-auth banner — thin wrapper over showActionBanner, id/copy unchanged so no
// existing caller (template.html's _onUnauthorized) needs to change. ──
export function showReauthBanner({ onReauth } = {}) {
  showActionBanner({
    id: 'reauth-banner',
    label: t('project.authExpired'),
    actionLabel: t('project.reauthenticate'),
    busyLabel: t('project.authenticating'),
    onAction: onReauth,
  });
}

export function hideReauthBanner() {
  hideActionBanner('reauth-banner');
}

// ── Setup-required banner (C1388 §D) — a real project window whose config went
// unreadable (C1352) and whose setup wizard was cancelled must NOT close (it may have
// live agent sessions); it stays open with this persistent affordance instead of a
// silently blank board. Distinct id/slot from reauth-banner so the two can never
// collide if both conditions somehow overlap.
export function showSetupRequiredBanner({ onSetup } = {}) {
  showActionBanner({
    id: 'setup-required-banner',
    label: t('project.setupRequired'),
    actionLabel: t('project.setupAction'),
    busyLabel: t('project.setupOpening'),
    onAction: onSetup,
  });
}

export function hideSetupRequiredBanner() {
  hideActionBanner('setup-required-banner');
}

// ── Load/open error guidance (C1392) ──
// Pure (no DOM, no window) so both renderTaskLoadError() (template.html's full-page
// .error-box) and _openTaskEditModalImpl()'s non-blocking banner (task-board.js) read
// one source of truth, and so utils.test.js can assert the browser branch still names
// :4455 without a DOM. Callers pass isElectron — the same `!!window.electronAPI?.api`
// predicate startOfflineRetry() uses (template.html).
export const TODO_SERVER_CMD = 'node todo-server.js';
export const TODO_SERVER_URL = 'http://localhost:4455/todo.html';

// Returns { title, hint, followUp, command } — named fields (not a lines[] array) so
// renderTaskLoadError() can keep its exact existing markup interleaving. command is
// null in Electron: never tell a packaged-app user to run a dev server.
export function loadErrorGuidance({ isElectron = false } = {}) {
  if (isElectron) {
    return {
      title: t('board.loadErrTitle'),
      hint: t('board.loadErrElectronHint'),
      followUp: t('board.loadErrElectronAction'),
      command: null,
    };
  }
  return {
    title: t('board.loadErrTitle'),
    hint: t('board.loadErrServeHint'),
    followUp: t('board.loadErrOpenUrl', { url: TODO_SERVER_URL }),
    command: TODO_SERVER_CMD,
  };
}

// One-line variant of the same branch, sized for showActionBanner()'s single label —
// used on the task-open failure path (distinct from the full-page load error above).
export function taskOpenErrorLabel({ isElectron = false, taskId = '' } = {}) {
  return isElectron
    ? t('board.taskOpenFailedElectron', { id: taskId })
    : t('board.taskOpenFailedBrowser', { id: taskId, url: TODO_SERVER_URL });
}

// ── Fetch with timeout + exponential backoff ──

function classifyFetchStage(url, startedAtPerfNow) {
  try {
    const abs = new URL(url, location.href).href;
    const entries = performance.getEntriesByName(abs, 'resource');
    const entry = entries.filter(e => e.startTime >= startedAtPerfNow).pop();
    if (!entry) return 'unknown';
    if (!entry.domainLookupEnd || entry.domainLookupEnd === entry.domainLookupStart) return 'dns';
    if (entry.secureConnectionStart > 0 && !entry.connectEnd) return 'tls';
    if (entry.connectEnd > 0 && !entry.requestStart) return 'connect';
    if (entry.requestStart > 0 && !entry.responseStart) return 'send';
    if (entry.responseStart > 0 && !entry.responseEnd) return 'receive';
    return 'complete';
  } catch {
    return 'unknown';
  }
}

// Returns the x-tipatask-project header object (or {}) for requests that must
// be scoped to the current Electron project window. In browser mode (no
// ?projectPath= query param) the returned object is empty — global files used.
export function projectHeader() {
  const p = new URLSearchParams(location.search).get('projectPath');
  return p ? { 'x-tipatask-project': p } : {};
}

export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = 30000,
    retries = 3,
    backoffMs = 500,
    retryOn = [408, 429, 500, 502, 503, 504],
    label = 'fetch',
    signal: outerSignal,
    ...fetchOpts
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (outerSignal && outerSignal.aborted) throw outerSignal.reason || new Error('aborted');
    const controller = new AbortController();
    const startedAt = performance.now();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const combined = outerSignal
      ? (() => {
          const h = () => controller.abort(outerSignal.reason || 'aborted');
          outerSignal.addEventListener('abort', h, { once: true });
          controller.signal.addEventListener('abort', () => outerSignal.removeEventListener('abort', h), { once: true });
          return controller.signal;
        })()
      : controller.signal;

    try {
      const res = await fetch(url, { ...fetchOpts, signal: combined });
      clearTimeout(timer);
      if (!retryOn.includes(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err && err.name === 'AbortError' && controller.signal.reason === 'timeout';
      const isUserAbort = outerSignal && outerSignal.aborted;
      if (isUserAbort) throw err;
      if (isTimeout) {
        const stage = classifyFetchStage(url, startedAt);
        console.warn(`[fetchWithRetry] ${label} timeout stage=${stage} attempt=${attempt + 1}/${retries} durationMs=${Math.round(performance.now() - startedAt)}`);
        lastErr = Object.assign(new Error(`timeout:${stage}`), { stage });
      } else {
        lastErr = err;
      }
    }

    if (attempt < retries - 1) {
      const delay = backoffMs * Math.pow(2, attempt) + Math.random() * 250;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const finalErr = new Error(`[fetchWithRetry] ${label} failed after ${retries} attempts: ${lastErr && lastErr.message}`);
  finalErr.cause = lastErr;
  throw finalErr;
}

// (C1242) Cmd/Ctrl+Enter submit predicate, shared by the objective composer and the New Task
// form's title/desc fields. Pure + DOM-event-shaped only (same style as voice-shortcut.js's
// matchesVoiceShortcut) so it's unit-testable with plain object stubs. Shift/Alt excluded so it
// never collides with Shift+Enter-newline or an Alt-combo.
export function isSubmitShortcut(e) {
  return !!(e && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey);
}

// (TPT254) Single submit predicate behind both the Send button and the Cmd/Ctrl+Enter
// handler in chat-ui.js attachChatHandlers(). `allowBlank` is decided by the caller — true
// only on a subtask/split tab's first turn, where the split target reaches the agent
// entirely through applyRehashIntent()'s --append-system-prompt directive, so the user's
// brief is optional rather than missing. `busy` must be a term here, not left to the DOM
// `disabled` attribute — reload() repaints asynchronously, and a blank send no longer
// clears the composer, so nothing else debounces a rapid second click.
export function canSubmitObjective(text, { allowBlank = false, busy = false } = {}) {
  if (busy) return false;
  return !!String(text ?? '').trim() || !!allowBlank;
}

// Same mac-detection as voiceShortcutLabel() (audio-recorder.js:73-74) — kept as its own pure
// export here since utils.js has no existing platform helper and voice-shortcut.js's is DOM-free
// by design too.
export function isMacPlatform() {
  return (typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin')
    || (typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || ''));
}

export function submitShortcutLabel(isMac = false) {
  return isMac ? '⌘↵' : 'Ctrl+Enter';
}
