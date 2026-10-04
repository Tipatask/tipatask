import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const { parseObjectiveResult, buildUsedIds, upsertTaskEntry, buildObjectivePrompt, isPristineObjectiveTab, captureSubtaskCtx, tabSubtaskContext, subtaskCtxFromChatState, pushSubtaskCrumb, createLiveInserter, isSubmitShortcut, submitShortcutLabel, canSubmitObjective, renderMarkdown, truncateMarkdownAtParagraph, computeTooltipAnchor, isRectClipped, loadErrorGuidance, taskOpenErrorLabel, TODO_SERVER_CMD, TODO_SERVER_URL } = await import('./utils.js');

function installRendererWindow() {
  const prior = globalThis.window;
  const dom = new JSDOM('', { url: 'http://localhost:4455/' });
  globalThis.window = dom.window;
  return () => {
    dom.window.close();
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  };
}

// Minimal fake <textarea>-shaped object — createLiveInserter only ever touches .value,
// .selectionStart/.selectionEnd, and .dispatchEvent(), so no real DOM is needed here.
function fakeField(initialValue = '', cursor = initialValue.length) {
  return {
    value: initialValue,
    selectionStart: cursor,
    selectionEnd: cursor,
    _dispatched: [],
    dispatchEvent(evt) { this._dispatched.push(evt.type); return true; },
  };
}

// C1017: buildUsedIds() is the collision set ensureNewTaskClientId() checks against
// when deciding whether to keep a proposal card's planner-reserved id. Reservation
// placeholders must be excluded — otherwise every accepted objective task's reserved
// key gets discarded and the server burns a second one, orphaning the first row.
test('buildUsedIds excludes live reservation placeholders but keeps real tasks', () => {
  const tasks = [
    { id: 'C214', title: 'New task', description: 'Reserved key — pending finalization.', status: 'pending', isReservation: true },
    { id: 'C210', title: 'Real existing task', status: 'in_progress', isReservation: false },
    { id: 'C211', title: 'Another real task', status: 'completed' }, // isReservation absent (legacy row)
  ];

  const used = buildUsedIds(tasks);

  assert.equal(used.has('C214'), false, 'reservation placeholder must not block reuse of its own key');
  assert.equal(used.has('C210'), true);
  assert.equal(used.has('C211'), true);
});

test('buildUsedIds tolerates missing/empty ids and a missing tasks array', () => {
  assert.deepEqual([...buildUsedIds(undefined)], []);
  assert.deepEqual([...buildUsedIds([{ title: 'no id' }, { id: '', title: 'blank id' }])], []);
});

// C1378: the save flow reads ./TODO.md fresh right before saving, so `tasks` can already
// contain the reservation placeholder row for a card whose id buildUsedIds() (above) let
// it keep. upsertTaskEntry() must replace that entry in place — a bare push() leaves two
// entries with the same id, which makes the server burn a second reservation and silently
// finalize the placeholder's own content onto it instead of the real proposed task.
test('upsertTaskEntry replaces an existing same-id entry in place, preserving array order', () => {
  const reservation = { id: 'C500', title: 'New task', description: 'Reserved key — pending finalization.', isReservation: true };
  const other = { id: 'C210', title: 'Unrelated task' };
  const tasks = [other, reservation];
  const real = { id: 'C500', title: 'Write the onboarding doc', description: 'Real content', isReservation: false };

  upsertTaskEntry(tasks, real);

  assert.equal(tasks.length, 2, 'must not grow the array — no duplicate entry left behind');
  assert.equal(tasks[0], other, 'unrelated entries must be undisturbed');
  assert.equal(tasks[1], real, 'the reservation entry is replaced by the real task, same position');
  assert.equal(tasks.some(t => t.title === 'New task'), false, 'no placeholder content survives');
});

test('upsertTaskEntry appends when no existing entry has that id', () => {
  const tasks = [{ id: 'C210', title: 'Existing' }];
  const brandNew = { id: 'new-abc-1', title: 'Freshly proposed task' };

  upsertTaskEntry(tasks, brandNew);

  assert.equal(tasks.length, 2);
  assert.equal(tasks[1], brandNew);
});

test('upsertTaskEntry on an empty array just appends', () => {
  const tasks = [];
  const t = { id: 'C1', title: 'First' };
  upsertTaskEntry(tasks, t);
  assert.deepEqual(tasks, [t]);
});

// (C1258) renderMarkdown() is called once per visible task card on every loadAndRender() —
// including a pure left-nav Tasks<->Create switch that repaints identical descriptions. These
// tests stub the browser-global `marked` library (loaded via <script> tag in the real app, not
// present under node:test) so a re-parse is directly observable via a call counter.
test('renderMarkdown memoizes marked.parse() calls for identical raw text', () => {
  const restoreWindow = installRendererWindow();
  const realMarked = globalThis.marked;
  let parseCalls = 0;
  globalThis.marked = { use() {}, parse: (text) => { parseCalls++; return `<p>${text}</p>`; } };
  try {
    const first = renderMarkdown('c1258-memo-hit test text');
    const second = renderMarkdown('c1258-memo-hit test text');
    assert.equal(parseCalls, 1, 'identical raw text on the second call must hit the cache, not re-parse');
    assert.equal(first, second);

    renderMarkdown('c1258-memo-hit a different string');
    assert.equal(parseCalls, 2, 'different raw text must still be a cache miss');
  } finally {
    globalThis.marked = realMarked;
    restoreWindow();
  }
});

test('renderMarkdown never caches the marked-unavailable fallback, so it self-heals once marked loads', () => {
  const restoreWindow = installRendererWindow();
  const realMarked = globalThis.marked;
  delete globalThis.marked;
  const text = 'c1258-poison-guard <b>raw</b> & text';
  try {
    // marked not yet loaded — falls through to the escapeAttr() catch path.
    const beforeMarkedLoaded = renderMarkdown(text);
    assert.match(beforeMarkedLoaded, /&amp;/, 'must use the escaped fallback while marked is unavailable');

    // marked "finishes loading" — a poisoned cache entry would keep returning the escaped
    // fallback forever instead of picking this up.
    let parseCalls = 0;
    globalThis.marked = { use() {}, parse: (t) => { parseCalls++; return `<p>${t}</p>`; } };
    const afterMarkedLoaded = renderMarkdown(text);
    assert.equal(parseCalls, 1, 'the fallback path must not have cached — this call must actually parse');
    assert.notEqual(afterMarkedLoaded, beforeMarkedLoaded);
  } finally {
    globalThis.marked = realMarked;
    restoreWindow();
  }
});

test('renderMarkdown returns empty string for falsy input', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('renderMarkdown preserves paragraphs, lists, and line breaks inside a step', async () => {
  const restoreWindow = installRendererWindow();
  const realMarked = globalThis.marked;
  const { marked: browserMarked } = await import('marked');
  globalThis.marked = browserMarked;
  try {
    const html = renderMarkdown('Context line one\nline two.\n\nSecond paragraph.\n\n1. First step\n   continuation\n\n2. Second step\n\n- Bullet');
    assert.match(html, /<p>Context line one<br>line two\.<\/p>/);
    assert.match(html, /<p>Second paragraph\.<\/p>/);
    assert.match(html, /<ol>[\s\S]*First step<br>continuation[\s\S]*Second step[\s\S]*<\/ol>/);
    assert.match(html, /<ul>[\s\S]*Bullet[\s\S]*<\/ul>/);
  } finally {
    globalThis.marked = realMarked;
    restoreWindow();
  }
});

// The final sanitizer pass needs a renderer window, like the real client.
async function withRealMarked(run) {
  const restoreWindow = installRendererWindow();
  const previous = globalThis.marked;
  const { Marked } = await import('marked');
  globalThis.marked = new Marked();
  try {
    run();
  } finally {
    globalThis.marked = previous;
    restoreWindow();
  }
}

test('renderMarkdown preserves mailto href and image src containing @', async () => {
  await withRealMarked(() => {
    const html = renderMarkdown('[mail](mailto:alice@example.com) ![image](https://example.test/@assets/icon.png)');
    assert.match(html, /<a href="mailto:alice@example\.com">mail<\/a>/);
    assert.match(html, /<img src="https:\/\/example\.test\/@assets\/icon\.png" alt="image">/);
    assert.doesNotMatch(html, /file-ref/);
  });
});

test('renderMarkdown highlights plain file references once and escapes surrounding text', async () => {
  await withRealMarked(() => {
    const input = 'Open @src/file.js & review **@src/other.ts**; email alice@example.com';
    const html = renderMarkdown(input);
    assert.match(html, /Open <span class="file-ref">@src\/file\.js<\/span> &amp; review/);
    assert.match(html, /<strong><span class="file-ref">@src\/other\.ts<\/span><\/strong>/);
    assert.equal((html.match(/class="file-ref"/g) || []).length, 2);
    assert.match(html, /alice@example\.com/);
    assert.equal(renderMarkdown(input), html);
    assert.doesNotMatch(renderMarkdown(input), /<span class="file-ref"><span/);
  });
});

test('renderMarkdown skips existing link text and inline or fenced code', async () => {
  await withRealMarked(() => {
    const html = renderMarkdown('[@src/file.js](/task) `@src/file.js`\n\n```js\n@src/file.js\n```');
    assert.match(html, /<a href="\/task">@src\/file\.js<\/a>/);
    assert.match(html, /<code>@src\/file\.js<\/code>/);
    assert.match(html, /<pre><code class="language-js">@src\/file\.js/);
    assert.doesNotMatch(html, /file-ref/);
  });
});

test('truncateMarkdownAtParagraph keeps full raw blocks before the limit', () => {
  const text = `First paragraph.\n\n${'Second paragraph content. '.repeat(8)}\n\nThird paragraph.`;
  const preview = truncateMarkdownAtParagraph(text, 100);

  assert.equal(preview, 'First paragraph.\n\n… (truncated)');
  assert.equal(truncateMarkdownAtParagraph('One paragraph only', 100), 'One paragraph only');
  assert.equal(truncateMarkdownAtParagraph('abcdefghij', 5), 'abcde\n\n… (truncated)');
});

test('parseObjectiveResult forces status to pending on new tasks, strips it on modified', () => {
  const parsed = parseObjectiveResult(`Text before.

\`\`\`json
{
  "changes": [
    { "type": "new", "task": { "id": "C1", "title": "Done", "description": "x", "category": "CODING", "status": "completed" } },
    { "type": "modified", "task": { "id": "C2", "title": "Active", "description": "y", "category": "CODING", "status": "in_progress" } }
  ]
}
\`\`\``);

  assert.deepEqual(parsed.changes.map(c => c.task.status), ['pending', undefined]);
});

// C1143: two proposed tasks touching the same source file must never emit identical
// priority/no-dependency — the planner must declare the edge so resolve-sprints
// (sprint-assign.js minStepForDeps/healDependencyOrdering) pushes the downstream
// task into a later sprint instead of the executor running both in parallel against
// a tree where the sibling's edits don't exist yet.
test('OBJECTIVE_SYSTEM_PROMPT documents the dependency-detection rule with a WRONG/RIGHT pair', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /DEPENDENCY DETECTION/);
  assert.match(systemPrompt, /do NOT count/);
  assert.match(systemPrompt, /api\/src\/routes\/tasks\.js.*same priority, no dependency link/);
  assert.match(systemPrompt, /dependencies":\["C1"\]/);
});

test('OBJECTIVE_SYSTEM_PROMPT requires blank-line markdown paragraphs in task descriptions', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /Format descriptions as Markdown paragraphs/);
  assert.match(systemPrompt, /MUST contain \\n\\n paragraph breaks/);
  assert.match(systemPrompt, /1\. @path\/file\.js[\s\S]*\\n\\n2\. @other\/path\/file\.js/);
});

// C1410: a screenshot showed the model appearing to echo a pasted rule back as prose
// (in fact a user-pasted recipe rendered as a user bubble, plus an empty assistant
// bubble — see tt-objective-chat-prompt-builder.md § No-JSON turn end). Real fix: an
// anti-echo WRONG/RIGHT pair next to the existing NO PROSE OUTPUT contract, and a
// corrected objective_summary line — since C1415 a lone proposed task gets no parent
// task, but the prompt still claimed one was always auto-created.
test('OBJECTIVE_SYSTEM_PROMPT documents the anti-echo rule and the corrected parent-task condition', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /echoing an instruction back to the user/);
  assert.match(systemPrompt, /Understood — when only one task is created there must not be a parent objective task/);
  assert.match(systemPrompt, /auto-created ONLY when this objective proposes more than one new task/);
  assert.doesNotMatch(systemPrompt, /auto-created parent task that owns every task from this objective as a child/);
});

// C1439: the prompt used to hardcode a project-agnostic "Action tags: feature, bugfix,
// refactor, migration, config, security, css" list, contradicting its own new_tags rule
// (any tag not in get_project_tags needs a new_tags entry) — the model followed the
// hardcoded list and emitted e.g. "config" with no new_tags entry, which 400'd the save
// in any project that hadn't happened to register all seven. Direct regression guard on
// the root cause: the hardcoded literal list must never come back, and every place the
// prompt tells the model what to do with an unregistered tag must agree.
test('OBJECTIVE_SYSTEM_PROMPT derives tag vocabulary from get_project_tags, not a hardcoded action-tag list', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.doesNotMatch(systemPrompt, /Action tags: feature, bugfix, refactor, migration, config, security, css/);
  assert.match(systemPrompt, /Pick every tag from get_project_tags/);
  assert.match(systemPrompt, /EVERY tag you use that is not already in get_project_tags — tt-\* or plain — in new_tags/);
  assert.match(systemPrompt, /tt-\* or plain, action tags included.*MUST appear in new_tags/);
  // The JSON shape example must show a plain-tag new_tags entry (no architecture_hint),
  // not only a tt-* one — the model had no concrete pattern to copy for a plain tag.
  assert.match(systemPrompt, /"new_tags":.*"name": "config", "description": "[^"]+" \}\]/);
});

// C1558: projects.use_objective_grouping gates parent-task creation project-wide. The
// default (opts omitted, or groupingEnabled:true) must stay BYTE-IDENTICAL to pre-C1558
// output — the systemPrompt is the cached --append-system-prompt prefix, and any drift on
// the common case would invalidate the CLI prompt cache for every default project.
test('OBJECTIVE_SYSTEM_PROMPT is byte-identical by default and states the grouping-off rule when disabled (C1558)', () => {
  const { systemPrompt: defaultPrompt } = buildObjectivePrompt('any objective', null, null);
  const { systemPrompt: explicitOnPrompt } = buildObjectivePrompt('any objective', null, null, { groupingEnabled: true });
  const { systemPrompt: offPrompt } = buildObjectivePrompt('any objective', null, null, { groupingEnabled: false });

  assert.equal(explicitOnPrompt, defaultPrompt);
  assert.match(defaultPrompt, /auto-created ONLY when this objective proposes more than one new task/);

  assert.notEqual(offPrompt, defaultPrompt);
  assert.doesNotMatch(offPrompt, /auto-created ONLY when this objective proposes more than one new task/);
  assert.match(offPrompt, /grouping turned OFF/);
  assert.match(offPrompt, /every proposed task is saved standalone, never wrapped in a parent container/);
});

// C1559: a web-origin "Start in Task App" handoff seeds the chat with cs.originTaskKey set.
// Default (opts omitted, or originTaskKey:null) must stay BYTE-IDENTICAL to pre-C1559
// output — same --append-system-prompt cache-prefix contract C1558 established.
test('OBJECTIVE_SYSTEM_PROMPT is byte-identical by default and states the origin-linked rule when originTaskKey is set (C1559)', () => {
  const { systemPrompt: defaultPrompt } = buildObjectivePrompt('any objective', null, null);
  const { systemPrompt: explicitNullPrompt } = buildObjectivePrompt('any objective', null, null, { originTaskKey: null });
  const { systemPrompt: originPrompt } = buildObjectivePrompt('any objective', null, null, { originTaskKey: 'C900' });

  assert.equal(explicitNullPrompt, defaultPrompt);
  assert.notEqual(originPrompt, defaultPrompt);

  // Never emit a stray `modified` card against the origin itself.
  assert.match(originPrompt, /NEVER propose "type":"modified" with "id":"C900"/);
  // States both resolution branches, independent of the grouping setting.
  assert.match(originPrompt, /REFINING the existing task C900/);
  assert.match(originPrompt, /regardless of this project's grouping setting/);
  // Origin mode wins even when grouping is explicitly off — the flag never governs it.
  const { systemPrompt: originOffPrompt } = buildObjectivePrompt('any objective', null, null, { groupingEnabled: false, originTaskKey: 'C900' });
  assert.match(originOffPrompt, /REFINING the existing task C900/);
  assert.doesNotMatch(originOffPrompt, /grouping turned OFF/);
});

// C1482: setup seeding was generating tasks with descriptive-slug keys (e.g.
// "C-kb-dev-scripts") instead of reserve_task_keys output — the "id" hard rule must
// explicitly forbid a slug and give a prefix-agnostic example (TPT/H, not just C),
// since per-project task_prefix (C1480) means "C" is no longer the only real prefix.
test('OBJECTIVE_SYSTEM_PROMPT forbids descriptive-slug task ids and gives a prefix-agnostic reserve_task_keys example (C1482)', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /real key returned by reserve_task_keys/);
  assert.match(systemPrompt, /descriptive slug like "C-kb-dev-scripts"/);
  assert.match(systemPrompt, /"TPT214" or "H3"/);
});

// TPT488: a "modified" description used to be rewritten from the title alone (the planner
// never saw the original), dropping requirements. The prompt now demands the full original,
// a minimal targeted edit, and exempts existing text from the C871 length/style rules.
test('OBJECTIVE_SYSTEM_PROMPT requires the full original and a targeted edit for modified descriptions (TPT488)', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /DESCRIPTION PRESERVATION/);
  assert.match(systemPrompt, /FULL ORIGINAL REQUIRED/);
  assert.match(systemPrompt, /### Referenced task descriptions/);
  assert.match(systemPrompt, /call mcp__tipatask__get_task\(task_key\) first/);
  assert.match(systemPrompt, /OMIT `description` from the card, keep any other field changes, and add a doc_updates entry/);
  assert.match(systemPrompt, /NEVER reconstruct a description from the title, tags, or memory/);
  assert.match(systemPrompt, /Remove or replace a detail ONLY when the objective explicitly supersedes it/);
  assert.match(systemPrompt, /does NOT apply to existing text in a modified description/);
  assert.match(systemPrompt, /applies to NEW task descriptions and to steps you ADD to a modified one/);
  assert.match(systemPrompt, /ALLOWED tools \(only these 5\):[^\n]*mcp__tipatask__get_task/);
  // tags-only modifications still omit description entirely
  assert.match(systemPrompt, /When the change is tags-only, priority-only, or dependencies-only, do NOT include `description` at all/);
});

// TPT502: `active` includes in_progress tasks, so an id-only check let the planner rewrite
// work an executor had already started. Only pending/on_fire targets may be modified.
test('OBJECTIVE_SYSTEM_PROMPT gates modified cards on pending/on_fire status (TPT502)', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);

  assert.match(systemPrompt, /STATUS GATE \(hard rule/);
  assert.match(systemPrompt, /read its `status`/);
  assert.match(systemPrompt, /ONLY a task whose status is pending or on_fire may be modified/);
  assert.match(systemPrompt, /status is in_progress, completed, canceled — or one absent from `active` — MUST NEVER be modified/);
  assert.match(systemPrompt, /propose "type": "new" using a key returned by reserve_task_keys instead/);
  assert.match(systemPrompt, /WRONG \(status gate — C42 is "in_progress" in active\): \{"type":"modified","task":\{"id":"C42"/);
  assert.match(systemPrompt, /RIGHT \(status gate — locked C42 untouched, follow-up is a new card\): \{"type":"new","task":\{"id":"<key from reserve_task_keys, e\.g\. TPT215>".*"dependencies":\["C42"\]/);
  assert.match(systemPrompt, /overlaps the objective AND passes the STATUS GATE, propose "modified"/);
});

test('OBJECTIVE_SYSTEM_PROMPT Show on Top example keeps focus, dismissal, pagination and cleanup in the RIGHT edit (TPT488)', () => {
  const { systemPrompt } = buildObjectivePrompt('any objective', null, null);
  const right = systemPrompt.match(/RIGHT \(targeted edit[^\n]*/)[0];
  const wrongLine = systemPrompt.match(/WRONG \(rewrite[^\n]*/)[0];
  const wrong = wrongLine.slice(wrongLine.indexOf('{'));

  for (const detail of ['syncNotificationSurface()', 'focused', 'dismissNotification()', 'pagination', 'completion cleanup', 'Show on Top']) {
    assert.ok(right.includes(detail), `RIGHT example must keep ${detail}`);
  }
  for (const detail of ['syncNotificationSurface()', 'dismissNotification()', 'pagination', 'completion cleanup']) {
    assert.ok(!wrong.includes(detail), `WRONG example illustrates dropping ${detail}`);
  }
  // RIGHT keeps the original steps 1-3 in order and appends the new step as 4.
  assert.match(right, /1\. @main\/desktop-notifications\.js[\s\S]*2\. @src\/client\/notification-center\.js[\s\S]*3\. @ai\/architecture\/tt-notifications\.md[\s\S]*4\. @src\/client\/desktop-notification-panel\.js/);
});

test('buildObjectivePrompt revision turn carries the preservation contract for modified cards (TPT488)', () => {
  const prior = [
    { type: 'modified', task: { id: 'C5', description: '1. @a.js keep me; verify X.' } },
    { type: 'modified', task: { id: 'C6', tags: ['tt-x', 'bugfix'] } },
  ];
  const { userPrompt, systemPrompt } = buildObjectivePrompt('objective', prior, 'also add Y to C5');

  assert.match(userPrompt, /DESCRIPTION PRESERVATION still applies/);
  assert.match(userPrompt, /start from the description in its previous proposal above and apply ONLY the change this feedback asks for/);
  assert.match(userPrompt, /stays description-less unless this feedback asks to change its description/);
  assert.ok(userPrompt.includes('1. @a.js keep me; verify X.'), 'previous description is handed back verbatim');
  // first-turn prompt carries no revision text; system prompt identical across turns
  assert.doesNotMatch(buildObjectivePrompt('objective', null, null).userPrompt, /DESCRIPTION PRESERVATION/);
  assert.equal(systemPrompt, buildObjectivePrompt('objective', null, null).systemPrompt);
});

// C1162: spawnObjectiveTab() (chat-ui.js) reuses a pristine tab instead of always
// allocating a new one — isPristineObjectiveTab() is its pure decision function.
test('isPristineObjectiveTab: no tab is never pristine', () => {
  assert.equal(isPristineObjectiveTab(null, null), false);
  assert.equal(isPristineObjectiveTab(undefined, { text: '' }), false);
});

test('isPristineObjectiveTab: blank tab with no draft is pristine', () => {
  assert.equal(isPristineObjectiveTab({ tabId: 'obj-new-1', chatState: null }, null), true);
  assert.equal(isPristineObjectiveTab({ tabId: 'obj-new-1', chatState: { messages: [] } }, { text: '' }), true);
});

test('isPristineObjectiveTab: a typed draft blocks reuse even with no messages', () => {
  assert.equal(isPristineObjectiveTab({ tabId: 'obj-new-1', chatState: null }, { text: 'half-typed brief' }), false);
  assert.equal(isPristineObjectiveTab({ tabId: 'obj-new-1', chatState: null }, { text: '   ' }), true, 'whitespace-only draft still counts as blank');
});

test('isPristineObjectiveTab: any conversation blocks reuse', () => {
  const tab = { tabId: 'obj-123', chatState: { messages: [{ role: 'user', content: 'hi' }] } };
  assert.equal(isPristineObjectiveTab(tab, null), false);
});

// ── Subtask context: capture-once, never live (C1410) ──
// A board drill-down/Split push onto the GLOBAL state.subtaskStack used to leak into any tab
// whose own subtaskCtx was left undefined, via a live fallback read at render time. Fix: every
// tab-creation site captures a snapshot ONCE; tabSubtaskContext() never falls back to the stack.

test('captureSubtaskCtx: empty or missing stack captures nothing', () => {
  assert.equal(captureSubtaskCtx([]), null);
  assert.equal(captureSubtaskCtx(undefined), null);
  assert.equal(captureSubtaskCtx(null), null);
});

test('captureSubtaskCtx: snapshots the top of the stack, title falls back to taskKey', () => {
  const stack = [{ taskKey: 'C1', title: 'First' }, { taskKey: 'C2', title: 'Second' }];
  assert.deepEqual(captureSubtaskCtx(stack), { taskKey: 'C2', title: 'Second' });
  assert.deepEqual(captureSubtaskCtx([{ taskKey: 'C3' }]), { taskKey: 'C3', title: 'C3' });
});

test('tabSubtaskContext: no live fallback to a global stack — regression guard for C1410', () => {
  // The bug: subtaskCtx undefined used to fall through to state.subtaskStack. This helper
  // takes no stack argument at all — the contract is that it CANNOT reach for one.
  assert.equal(tabSubtaskContext(null), null);
  assert.equal(tabSubtaskContext({ tabId: 'obj-1' }), null); // subtaskCtx never set
  assert.equal(tabSubtaskContext({ tabId: 'obj-1', subtaskCtx: null }), null); // explicit none
  assert.deepEqual(
    tabSubtaskContext({ tabId: 'obj-1', subtaskCtx: { taskKey: 'C9', title: 'Restrict X' } }),
    { taskKey: 'C9', title: 'Restrict X' }
  );
});

test('subtaskCtxFromChatState: derives restore-time context from the persisted parentTaskKey only', () => {
  assert.equal(subtaskCtxFromChatState(null), null);
  assert.equal(subtaskCtxFromChatState({ parentTaskKey: null }), null);
  assert.deepEqual(subtaskCtxFromChatState({ parentTaskKey: 'C42' }), { taskKey: 'C42', title: 'C42' });
});

// ── pushSubtaskCrumb: dedup consecutive pushes on the same parent (C1440) ──
// Bug: repeat-clicking Show Subtasks on the same card pushed a new {taskKey,title} entry
// every time (loadAndRender() is async, the button stays clickable until it resolves), so
// the breadcrumb bar showed the same segment N times for N clicks. Every subtaskStack.push()
// call site now routes through this guarded helper instead of pushing directly.

test('pushSubtaskCrumb: 10 consecutive clicks on the same card leave the stack at length 1', () => {
  const stack = [];
  for (let i = 0; i < 10; i++) {
    pushSubtaskCrumb(stack, { taskKey: 'C123', title: 'Parent objective' });
  }
  assert.equal(stack.length, 1);
  assert.deepEqual(stack[0], { taskKey: 'C123', title: 'Parent objective' });
});

test('pushSubtaskCrumb: distinct keys still append, drilling deeper works', () => {
  const stack = [];
  assert.equal(pushSubtaskCrumb(stack, { taskKey: 'C1', title: 'Parent' }), true);
  assert.equal(pushSubtaskCrumb(stack, { taskKey: 'C2', title: 'Child' }), true);
  assert.equal(stack.length, 2);
  assert.deepEqual(stack, [{ taskKey: 'C1', title: 'Parent' }, { taskKey: 'C2', title: 'Child' }]);
});

test('pushSubtaskCrumb: guard is top-of-stack only — a non-top repeat still appends', () => {
  const stack = [{ taskKey: 'C1', title: 'A' }, { taskKey: 'C2', title: 'B' }];
  assert.equal(pushSubtaskCrumb(stack, { taskKey: 'C1', title: 'A' }), true);
  assert.equal(stack.length, 3);
});

test('pushSubtaskCrumb: missing taskKey or stack is a no-op, never throws', () => {
  const stack = [{ taskKey: 'C1', title: 'A' }];
  assert.equal(pushSubtaskCrumb(stack, { title: 'no key' }), false);
  assert.equal(pushSubtaskCrumb(stack, null), false);
  assert.equal(pushSubtaskCrumb(null, { taskKey: 'C1', title: 'A' }), false);
  assert.equal(stack.length, 1, 'stack must be untouched by every no-op case');
});

// ── createLiveInserter (C1185) ──

test('createLiveInserter: setPartial replaces the shown span in place, not append-on-top', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.setPartial('hel');
  assert.equal(el.value, 'hel');
  live.setPartial('hello');
  assert.equal(el.value, 'hello', 'second partial must REPLACE the first, not concatenate');
  assert.deepEqual(el._dispatched, ['input', 'input']);
});

test('createLiveInserter: commit freezes text with a trailing space and starts a fresh span', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.setPartial('hel');
  live.setPartial('hello');
  live.commit('hello');
  assert.equal(el.value, 'hello ');
  live.setPartial('wor');
  assert.equal(el.value, 'hello wor', 'next partial must land after the committed text, not overwrite it');
  live.commit('world');
  assert.equal(el.value, 'hello world ');
});

test('createLiveInserter: commit does not double a trailing space already present', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.commit('hello ');
  assert.equal(el.value, 'hello ', 'must not become "hello  " (double space)');
});

test('createLiveInserter: inserts starting at the field\'s existing content and cursor position', () => {
  const el = fakeField('prefix: ', 8);
  const live = createLiveInserter(el);
  live.setPartial('hello');
  assert.equal(el.value, 'prefix: hello');
});

test('createLiveInserter: preserves a corrected word without replaying it on commit', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.setPartial('hel');
  assert.equal(el.value, 'hel');
  // Simulate the user typing over the live span themselves (e.g. correcting a word) —
  // el.value no longer matches what the inserter last wrote there.
  el.value = 'help';
  el.selectionStart = el.selectionEnd = el.value.length;
  live.commit('hello');
  // The edited word now belongs to the user; a revision must not replay it.
  assert.equal(el.value, 'help', 'must preserve the correction without replaying the recognized word');
});

test('createLiveInserter: detects an edit even when it only extends the span (cursor moved, content still matches)', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.setPartial('hel');
  // The user types one more character right after the live span — "hel" itself is untouched,
  // but the cursor is no longer where our last write left it.
  el.value = 'help';
  el.selectionStart = el.selectionEnd = 4;
  live.setPartial('hello');
  assert.equal(el.value, 'help', 'must preserve typed suffix without replaying the word');
});

test('createLiveInserter: dispatches an input event on every write so autosize/draft-save listeners fire', () => {
  const el = fakeField('', 0);
  const live = createLiveInserter(el);
  live.setPartial('a');
  live.commit('a');
  assert.equal(el._dispatched.length, 2);
  assert.ok(el._dispatched.every((t) => t === 'input'));
});

// ── createLiveInserter re-resolution (C1200) ──
// A re-render (e.g. objective-chat's #chat-input rebuilt from a template string) can detach the
// element an inserter was anchored to. `resolve` lets it recover instead of writing into a
// disconnected node forever.

test('createLiveInserter: re-resolves to a fresh element when the tracked one is detached, and commits there', () => {
  const oldEl = fakeField('orphan text', 11);
  const newEl = fakeField('abc', 3);
  const live = createLiveInserter(oldEl, { resolve: () => newEl });
  oldEl.isConnected = false; // simulates the re-render's app.innerHTML replacing the DOM node
  live.commit('hello');
  assert.equal(oldEl.value, 'orphan text', 'the detached element must be left untouched');
  assert.equal(newEl.value, 'abchello ', 'commit must land in the live field at ITS cursor, not the stale anchor');
});

test('createLiveInserter: re-resolving never maps the old anchor onto the new element, so it cannot duplicate already-committed text', () => {
  const oldEl = fakeField('', 0);
  const newEl = fakeField('', 0);
  let resolveTarget = oldEl;
  const live = createLiveInserter(oldEl, { resolve: () => resolveTarget });
  live.commit('hello'); // still targeting oldEl (connected) — 'hello ' committed there
  assert.equal(oldEl.value, 'hello ');
  // Re-render: oldEl detaches. newEl already carries the SAME text (e.g. a draft round-trip
  // re-inflated it) with the cursor at its end — the dangerous case for a naive offset-remap.
  oldEl.isConnected = false;
  newEl.value = 'hello ';
  newEl.selectionStart = newEl.selectionEnd = 6;
  resolveTarget = newEl;
  live.setPartial('wor');
  assert.equal(newEl.value, 'hello wor', 'must append fresh at newEl\'s live cursor, never re-write "hello " a second time');
});

// (C1242) isSubmitShortcut — Cmd/Ctrl+Enter predicate shared by the objective composer and the
// New Task form. Plain Enter must stay false now that it inserts a newline instead of sending.
test('isSubmitShortcut: Cmd+Enter and Ctrl+Enter match, plain Enter and other modifier combos do not', () => {
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter' }), false, 'plain Enter no longer submits — it is a newline');
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, shiftKey: true }), false, 'Shift+Cmd+Enter excluded');
  assert.equal(isSubmitShortcut({ key: 'Enter', ctrlKey: true, altKey: true }), false, 'Alt+Ctrl+Enter excluded');
  assert.equal(isSubmitShortcut({ key: 'a', metaKey: true }), false, 'wrong key entirely');
  assert.equal(isSubmitShortcut(null), false, 'null event must not throw');
  assert.equal(isSubmitShortcut(undefined), false, 'undefined event must not throw');
});

// (TPT254) canSubmitObjective — the one predicate behind both the Send button and the
// Cmd/Ctrl+Enter handler. Blank text is a valid submit only when the caller opts in via
// allowBlank (a subtask/split tab's first turn); busy always wins.
test('canSubmitObjective: ordinary chat still requires non-blank text', () => {
  assert.equal(canSubmitObjective('Build a calendar', {}), true);
  assert.equal(canSubmitObjective('', {}), false);
  assert.equal(canSubmitObjective('   \n\t ', {}), false, 'whitespace-only is not text');
  assert.equal(canSubmitObjective(null, {}), false, 'missing value must not throw');
});

test('canSubmitObjective: allowBlank lets a subtask tab submit an empty composer', () => {
  assert.equal(canSubmitObjective('', { allowBlank: true }), true);
  assert.equal(canSubmitObjective('  \n ', { allowBlank: true }), true);
  assert.equal(canSubmitObjective('Use three tasks', { allowBlank: true }), true);
});

test('canSubmitObjective: busy refuses both modes — the anti-double-dispatch term', () => {
  assert.equal(canSubmitObjective('', { allowBlank: true, busy: true }), false, 'blank split send no longer self-debounces via a cleared composer');
  assert.equal(canSubmitObjective('Build a calendar', { busy: true }), false);
});

test('submitShortcutLabel: mac shows the glyph combo, non-mac shows the text combo', () => {
  assert.equal(submitShortcutLabel(true), '⌘↵');
  assert.equal(submitShortcutLabel(false), 'Ctrl+Enter');
});

// (C1385) computeTooltipAnchor — decides whether the card-title tooltip stays
// left-anchored or flips to right-anchored so it never runs off the viewport's right
// edge. Pure geometry, no DOM.
test('computeTooltipAnchor: tooltip fits from the title\'s left edge → no flip, left-anchored as before', () => {
  const titleRect = { left: 40, right: 160 };
  const result = computeTooltipAnchor(titleRect, 100, 1200);
  assert.deepEqual(result, { flip: false, left: 40, right: null });
});

test('computeTooltipAnchor: card near the right edge, tooltip would overflow → flips, right-anchored to the title\'s right edge', () => {
  const titleRect = { left: 1150, right: 1190 };
  const result = computeTooltipAnchor(titleRect, 100, 1200);
  // 1150 + 100 = 1250 > 1200 - 8 → flips. Right-anchored: 1200 - 1190 = 10.
  assert.equal(result.flip, true);
  assert.equal(result.left, null);
  assert.equal(result.right, 10);
});

test('computeTooltipAnchor: tooltip too wide to fit even right-anchored → clamps to the margin instead of overflowing the left edge', () => {
  const titleRect = { left: 900, right: 1190 };
  // Right-anchoring alone would put the left edge at 1190 - 1190 = 0, inside the margin(8).
  const result = computeTooltipAnchor(titleRect, 1190, 1200);
  assert.equal(result.flip, true);
  assert.equal(result.left, null);
  assert.equal(result.right, 8);
});

test('computeTooltipAnchor: exact boundary (fits exactly at the margin) → no flip', () => {
  const titleRect = { left: 100, right: 200 };
  // left(100) + tipWidth(1092) === viewportWidth(1200) - margin(8) → fits exactly.
  const result = computeTooltipAnchor(titleRect, 1092, 1200);
  assert.equal(result.flip, false);
  assert.equal(result.left, 100);
});

test('computeTooltipAnchor: zero or NaN tooltip width fails open to no-flip rather than mispositioning', () => {
  const titleRect = { left: 1150, right: 1190 };
  assert.deepEqual(computeTooltipAnchor(titleRect, 0, 1200), { flip: false, left: 1150, right: null });
  assert.deepEqual(computeTooltipAnchor(titleRect, NaN, 1200), { flip: false, left: 1150, right: null });
});

// (TPT346) isRectClipped — the gate that skips a proposal title's hover pill when the card
// already shows the whole (wrapped) title.
test('isRectClipped: a rect fully inside its container is not clipped', () => {
  const card = { top: 100, left: 50, right: 320, bottom: 400 };
  assert.equal(isRectClipped({ top: 120, left: 66, right: 304, bottom: 170 }, card), false);
});

test('isRectClipped: any edge past the container is clipped', () => {
  const card = { top: 100, left: 50, right: 320, bottom: 400 };
  assert.equal(isRectClipped({ top: 120, left: 66, right: 304, bottom: 450 }, card), true, 'bottom');
  assert.equal(isRectClipped({ top: 120, left: 66, right: 360, bottom: 170 }, card), true, 'right');
  assert.equal(isRectClipped({ top: 60, left: 66, right: 304, bottom: 170 }, card), true, 'top');
  assert.equal(isRectClipped({ top: 120, left: 10, right: 304, bottom: 170 }, card), true, 'left');
});

test('isRectClipped: overhang within the tolerance (border box) is not clipped', () => {
  const card = { top: 100, left: 50, right: 320, bottom: 400 };
  assert.equal(isRectClipped({ top: 99.5, left: 50, right: 320.5, bottom: 401 }, card), false);
  assert.equal(isRectClipped({ top: 120, left: 66, right: 304, bottom: 402 }, card, 3), false);
  assert.equal(isRectClipped({ top: 120, left: 66, right: 304, bottom: 402 }, card, 0), true);
});

test('isRectClipped: a missing container or rect is never clipped', () => {
  assert.equal(isRectClipped({ top: 0, left: 0, right: 10, bottom: 10 }, undefined), false);
  assert.equal(isRectClipped(null, { top: 0, left: 0, right: 10, bottom: 10 }), false);
});

// (C1392) loadErrorGuidance()/taskOpenErrorLabel() are the pure source of truth behind
// both renderTaskLoadError() (template.html) and the task-open error banner (task-board.js)
// — this is the mechanical guard that "the browser branch still shows the localhost:4455
// instructions" (the task's own verification criterion), checkable with no DOM.
test('loadErrorGuidance: browser mode names the dev-server command and the :4455 URL', () => {
  const g = loadErrorGuidance({ isElectron: false });
  assert.equal(g.command, TODO_SERVER_CMD);
  assert.ok(g.command.includes('todo-server.js'));
  assert.ok(g.followUp.includes(TODO_SERVER_URL), 'followUp must still name http://localhost:4455/todo.html');
});

test('loadErrorGuidance: Electron mode never tells a packaged-app user to run a dev server', () => {
  const g = loadErrorGuidance({ isElectron: true });
  assert.equal(g.command, null);
  assert.ok(!g.hint.includes('localhost:4455'));
  assert.ok(!g.followUp.includes('localhost:4455'));
});

test('taskOpenErrorLabel: browser variant names both the task id and the :4455 URL, Electron variant names neither', () => {
  const browser = taskOpenErrorLabel({ isElectron: false, taskId: 'C1392' });
  assert.ok(browser.includes('C1392'));
  assert.ok(browser.includes(TODO_SERVER_URL));

  const electron = taskOpenErrorLabel({ isElectron: true, taskId: 'C1392' });
  assert.ok(electron.includes('C1392'));
  assert.ok(!electron.includes(TODO_SERVER_URL));
  assert.ok(!electron.includes('node '), 'Electron label must not suggest running a dev-server command');
});


test('live insertion: provisional punctuation revises across pauses and multiple sentences commit exactly once', () => {
  const el = fakeField('Note: ');
  const live = createLiveInserter(el);
  live.setPartial('Please keep.');
  live.setPartial('Please keep thinking.');
  live.setPartial('Please keep thinking about it');
  live.commit('Please keep thinking about it.');
  live.setPartial('Next sentence.');
  live.setPartial('Next sentence continues');
  live.commit('Next sentence continues.');
  assert.equal(el.value, 'Note: Please keep thinking about it. Next sentence continues. ');
});

test('live insertion: corrections survive revisions and only new words are appended', () => {
  const el = fakeField();
  const live = createLiveInserter(el);
  live.setPartial('Call John.');
  el.value = 'Call Jane!';
  el.selectionStart = el.selectionEnd = el.value.length;
  live.setPartial('Call John tomorrow.');
  live.setPartial('Call John tomorrow morning');
  live.commit('Call John tomorrow morning.');
  assert.equal(el.value, 'Call Jane! tomorrow morning. ');
  live.commit('Thank you.');
  assert.equal(el.value, 'Call Jane! tomorrow morning. Thank you. ');
});

test('live insertion: selections and surrounding text are preserved on ownership loss', () => {
  const el = fakeField('Prefix: ', 8);
  const live = createLiveInserter(el);
  live.setPartial('hello');
  el.selectionStart = 0;
  el.selectionEnd = 6;
  live.commit('hello');
  assert.equal(el.value, 'Prefix: hello');
  assert.equal(el.selectionStart, 0);
  assert.equal(el.selectionEnd, 6);
  live.setPartial('new words');
  assert.equal(el.value, 'Prefix new words: hello', 'append after selection without deleting it');
});

test('live insertion: replacement field containing pending text does not duplicate it', () => {
  const oldEl = fakeField();
  const replacement = fakeField();
  const live = createLiveInserter(oldEl, { resolve: () => replacement });
  live.setPartial('Keep thinking.');
  replacement.value = oldEl.value;
  replacement.selectionStart = replacement.selectionEnd = replacement.value.length;
  oldEl.isConnected = false;
  live.setPartial('Keep thinking about it');
  live.commit('Keep thinking about it.');
  assert.equal(replacement.value, 'Keep thinking about it. ');
});

test('live insertion: shortening and empty partials replace only the owned span', () => {
  const el = fakeField('before  after', 7);
  const live = createLiveInserter(el);
  live.setPartial('hello there.');
  live.setPartial('hello');
  assert.equal(el.value, 'before hello after');
  live.setPartial('');
  assert.equal(el.value, 'before  after');
  live.commit('hello.');
  assert.equal(el.value, 'before hello.  after');
});
