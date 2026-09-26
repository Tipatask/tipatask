import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT309) Terminal header wears the board's card / bulk-action-bar treatment. There is no DOM
// harness for console-modal.js and CSS isn't executable under node, so — like
// card-header-row.test.js — the invariants are source-scanned.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('./console-modal.js', import.meta.url), 'utf8');

// Body of the first rule whose selector text matches `selectorRe` (selector must end at `{`).
function ruleBody(selectorRe) {
  const m = css.match(new RegExp(selectorRe.source + String.raw`\s*\{([^}]*)\}`));
  assert.ok(m, `rule ${selectorRe} not found`);
  return m[1];
}

// The terminal-header CSS region: from the header comment through the voice button rules.
const region = (() => {
  const start = css.indexOf('/* ── Terminal header (TPT309)');
  const end = css.indexOf('.terminal-body {', start);
  assert.ok(start > -1 && end > start, 'terminal-header CSS region not found');
  return css.slice(start, end);
})();

test('shared control height token is 32px, matching --card-ctrl-h and the bulk controls', () => {
  assert.match(ruleBody(/\.terminal-header/), /--terminal-header-control-height:\s*32px/);
  assert.match(css, /--card-ctrl-h:\s*32px/);
});

test('header chrome uses theme tokens, not the fixed Catppuccin hexes', () => {
  assert.doesNotMatch(region, /#(?:181825|313244|45475a|cdd6f4|f38ba8|a6e3a1|9399b2)\b/i);
  const header = ruleBody(/\.terminal-header/);
  assert.match(header, /background:\s*var\(--c-bg-card\)/);
  assert.match(header, /border-bottom:\s*1px solid var\(--c-border-input\)/);
});

test('terminal container and body stay a fixed dark ground', () => {
  assert.match(ruleBody(/\.terminal-container/), /background:\s*#1e1e2e/);
});

test('one shared rule sizes the text controls from the token with a 6px radius', () => {
  const body = ruleBody(/\.btn-show-task, \.btn-close-terminal, \.btn-terminate-terminal/);
  assert.match(body, /height:\s*var\(--terminal-header-control-height\)/);
  assert.match(body, /border-radius:\s*6px/);
  assert.match(body, /border:\s*1px solid var\(--c-border-input\)/);
});

test('voice button is a square of the same token height', () => {
  const body = ruleBody(/\.terminal-voice-btn/);
  assert.match(body, /width:\s*var\(--terminal-header-control-height\)/);
  assert.match(body, /height:\s*var\(--terminal-header-control-height\)/);
  assert.match(body, /border-radius:\s*6px/);
});

test('Terminate is the danger variant and controls get a focus-visible ring', () => {
  // Line-anchored: a bare `.btn-terminate-terminal` would first match the tail of the shared
  // `.btn-show-task, .btn-close-terminal, .btn-terminate-terminal` list rule.
  const danger = ruleBody(/\n\s*\.btn-terminate-terminal/);
  assert.match(danger, /border-color:\s*var\(--c-danger\)/);
  assert.match(danger, /color:\s*var\(--c-danger\)/);
  assert.match(region, /\.btn-terminate-terminal:focus-visible/);
  assert.match(region, /box-shadow:\s*0 0 0 2px var\(--c-primary-light\)/);
});

test('key never shrinks, title ellipsizes, caption is capped', () => {
  assert.match(ruleBody(/\.terminal-task-key/), /flex:\s*0 0 auto/);
  const title = ruleBody(/\.terminal-task-title/);
  assert.match(title, /min-width:\s*0/);
  assert.match(title, /text-overflow:\s*ellipsis/);
  // Caption does not shrink with the title (flex 0 0 auto) — the title gives way first.
  const caption = ruleBody(/\.terminal-task-caption/);
  assert.match(caption, /max-width:\s*45%/);
  assert.match(caption, /flex:\s*0 0 auto/);
});

test('<=480px keeps the four controls on one row: caption text hidden, tighter control padding', () => {
  const m = css.match(/@media \(max-width: 480px\)\s*\{([^@]*?\.terminal-task-caption-text\s*\{[^}]*\}[^@]*?)\}\s*\n/);
  assert.ok(m, '480px terminal-header block not found');
  assert.match(m[1], /\.terminal-task-caption-text\s*\{\s*display:\s*none/);
  assert.match(m[1], /\.terminal-header-actions\s*\{\s*gap:\s*6px/);
  assert.match(m[1], /padding:\s*0 10px/);
  // the full caption stays reachable when its text is hidden
  const fn = js.match(/function renderTaskLabel\(agentId, caption\)[\s\S]*?\n  \}/)[0];
  assert.match(fn, /class="terminal-task-caption" title="\$\{safeCaption\}"/);
});

test('narrow widths: actions wrap to their own row at <=640px, overlay padding shrinks at <=480px', () => {
  const m = css.match(/@media \(max-width: 640px\)\s*\{\s*\.terminal-header-actions\s*\{([^}]*)\}/);
  assert.ok(m, '640px .terminal-header-actions rule not found');
  assert.match(m[1], /flex:\s*1 1 100%/);
  assert.match(m[1], /border-top:\s*1px solid var\(--c-border-input\)/);
  assert.match(css, /@media \(max-width: 480px\)\s*\{[^@]*\.terminal-overlay\s*\{\s*padding:\s*8px/);
});

test('renderTaskLabel(agentId, caption) emits key / title / caption chip with an agent dot', () => {
  const fn = js.match(/function renderTaskLabel\(agentId, caption\)[\s\S]*?\n  \}/);
  assert.ok(fn, 'renderTaskLabel(agentId, caption) not found');
  for (const cls of ['terminal-task-key', 'terminal-task-title', 'terminal-task-caption',
    'terminal-task-caption-text', 'terminal-agent-dot']) {
    assert.ok(fn[0].includes(cls), `${cls} missing from renderTaskLabel`);
  }
  // C1342 regression: the flex-edge-collapse fix (&nbsp; glue) is replaced by chip + gap; no
  // inline text separator may creep back in.
  assert.doesNotMatch(fn[0], /&nbsp;/);
  // Dot takes the colour modifier only — never the absolutely-positioned .agent-badge base.
  assert.match(fn[0], /terminal-agent-dot agent-badge--\$\{/);
  assert.doesNotMatch(fn[0], /class="agent-badge /);
  assert.equal(fn[0].includes("return 'New Objective'"), true);
});

test('every renderTaskLabel call site passes the agent id', () => {
  const calls = [...js.matchAll(/renderTaskLabel\(([^)]*)/g)].map(m => m[1]).filter(a => !a.startsWith('agentId'));
  assert.ok(calls.length >= 2, 'expected the initial paint and updateTaskLabel() call sites');
  for (const args of calls) assert.match(args, /^(initialAgentId|lastKnownAgentId),/);
});

test('both consoles wrap their buttons in .terminal-header-actions', () => {
  const wraps = js.match(/<div class="terminal-header-actions">/g) || [];
  assert.equal(wraps.length, 2, 'openTerminal + openObjectiveConsole must each wrap their actions');
  const task = js.slice(js.indexOf('function renderTaskLabel'));
  const actions = task.slice(task.indexOf('<div class="terminal-header-actions">'));
  const order = ['btn-show-task', 'terminal-voice-btn', 'btn-terminate-terminal', 'btn-close-terminal']
    .map(c => actions.indexOf(c));
  assert.ok(order.every(i => i > -1), 'an openTerminal header action is missing');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'action order changed');
});

test('status dot stays a bare class (className is overwritten wholesale on state change)', () => {
  const dots = js.match(/<span class="status-dot"[^>]*><\/span>/g) || [];
  assert.equal(dots.length, 2);
});
