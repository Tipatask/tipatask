import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT277) Card header control row: every control in .controls-row shares one set of sizing
// tokens. (TPT306) The hover .card-btn-group sits at the end of .card-top: Select, with a narrow
// drop-down menu for the other actions. CSS isn't executable under node, so the invariants are
// source-scanned.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const cardJs = readFileSync(new URL('./task-card.js', import.meta.url), 'utf8');
const boardJs = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');

// Body of the first rule whose selector text matches `selectorRe` (selector must end at `{`).
function ruleBody(selectorRe) {
  const m = css.match(new RegExp(selectorRe.source + String.raw`\s*\{([^}]*)\}`));
  assert.ok(m, `rule ${selectorRe} not found`);
  return m[1];
}

const CONTROLS = ['.card-status-select', '.btn-claude', '.btn-start-discussion',
  '.btn-terminate', '.btn-open-subtask-board', '.btn-create-subtasks'];

// (TPT279) Tokens live on .card so the proposal card's meta row reads the same values.
test('sizing tokens are declared on .card', () => {
  const body = [...css.matchAll(/\n\s*\.card\s*\{([^}]*)\}/g)].map(m => m[1])
    .find(b => b.includes('--card-ctrl-h'));
  assert.ok(body, '.card token rule not found');
  assert.match(body, /--card-ctrl-h:\s*32px/);
  for (const tok of ['--card-ctrl-font', '--card-ctrl-radius', '--card-ctrl-pad-x', '--card-ctrl-line']) {
    assert.match(body, new RegExp(tok + ':'), `${tok} missing`);
  }
});

test('one shared rule sizes every header control from the tokens', () => {
  const m = css.match(/\.task-card-hover-controls :is\(([^)]*)\)\s*\{([^}]*)\}/);
  assert.ok(m, 'shared :is() control rule not found');
  const [, list, body] = m;
  for (const cls of CONTROLS) assert.ok(list.includes(cls), `${cls} not in shared rule`);
  assert.match(body, /min-height:\s*var\(--card-ctrl-h\)/);
  assert.match(body, /font-size:\s*var\(--card-ctrl-font\)/);
  assert.match(body, /line-height:\s*var\(--card-ctrl-line\)/);
  assert.match(body, /border-radius:\s*var\(--card-ctrl-radius\)/);
  // display gating of the subtask buttons (display:none until expanded/objective) must survive.
  assert.doesNotMatch(body, /(^|[\s;])display:/);
});

test('.controls-row is a centred, wrapping 8px-gap flex row', () => {
  const body = ruleBody(/\.task-card-hover-controls \.controls-row/);
  assert.match(body, /display:\s*flex/);
  assert.match(body, /align-items:\s*center/);
  assert.match(body, /gap:\s*8px/);
  assert.match(body, /flex-wrap:\s*wrap/);
});

test('no session-only size overrides reintroduce height drift', () => {
  assert.doesNotMatch(css, /\.card\.has-active-session \.btn-claude[^{]*\{[^}]*(padding|font-size)/);
  assert.doesNotMatch(css, /\.card\.has-active-session \.card-status-select\s*\{[^}]*(padding|font-size)/);
});

// (TPT306) Actions live in the title row: .card-top holds the id badge + title and, at its right
// end, the .card-btn-group anchor — Select first, then the drop-down .card-action-menu.
test('renderCard puts Select + the action menu at the end of .card-top', () => {
  const top = cardJs.indexOf('<div class="card-top');
  const title = cardJs.indexOf('<span class="card-title', top);
  const group = cardJs.indexOf('<div class="card-btn-group">');
  const select = cardJs.indexOf('${selectBtn}', group);
  const menu = cardJs.indexOf('<div class="card-action-menu"', group);
  const controls = cardJs.indexOf('<div class="task-card-hover-controls">');
  assert.ok(top > 0 && title > 0 && group > 0 && select > 0 && menu > 0 && controls > 0, 'card markup anchors not found');
  assert.ok(top < title && title < group && group < select && select < menu && menu < controls,
    'order must be card-top, title, group, Select, menu, hover controls');
  // .card-top closes right after the group — nothing else between the group and the controls.
  assert.match(cardJs.slice(menu, controls), /<\/div>\s*<\/div>`\}\s*<\/div>\s*\$\{preview \? previewMetaHtml/);
});

test('action menu holds Edit, Highlight Related, Rehash, Delete and conditional Merge', () => {
  assert.match(cardJs, /<div class="card-action-menu" role="group" aria-label="\$\{escapeAttr\(translate\('card\.actionsMenu'\)\)\}">\$\{editBtn\}\$\{chainBtn\}\$\{reiterateBtn\}\$\{deleteBtn\}\$\{mergeBtn\}<\/div>/);
});

test('the lower action row and the dead hamburger are gone', () => {
  for (const src of [cardJs, css]) {
    assert.doesNotMatch(src, /card-actions-row|card-actions-inner|card-hamburger/);
  }
});

test('.card-top never reserves width for the icon group', () => {
  assert.doesNotMatch(css, /--card-btn-group-reserve/);
  assert.doesNotMatch(css, /\.card-top\s*\{[^}]*transition:\s*padding-right/);
  assert.doesNotMatch(cardJs, /paddingRight = '88px'/);
});

test('.card-btn-group keeps its slot but only shows Select on hover, expand, select or focus', () => {
  const bodies = [...css.matchAll(/\n\s*\.card-btn-group\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.equal(bodies.length, 1, 'expected one .card-btn-group rule');
  const body = bodies[0];
  assert.match(body, /position:\s*relative/);
  assert.match(body, /display:\s*flex/);
  assert.match(body, /opacity:\s*0/);
  assert.match(body, /pointer-events:\s*none/);
  assert.match(body, /transition:[^;]*opacity 120ms/);
  // Negative block margin: the 32px Select must not grow the 26px title row.
  assert.match(body, /margin-block:\s*-3px/);
  assert.doesNotMatch(body, /position:\s*absolute|display:\s*none/);
  const m = css.match(/((?:\s*[^{}]*\.card-btn-group,)+\s*\.card-btn-group:focus-within)\s*\{([^}]*)\}/);
  assert.ok(m, 'reveal rule not found');
  const [, sels, reveal] = m;
  for (const sel of ['.card:hover .card-btn-group', '.card.card-expanded .card-btn-group', '.card.selected .card-btn-group']) {
    assert.ok(sels.includes(sel), `${sel} missing from reveal rule`);
  }
  assert.match(reveal, /opacity:\s*1/);
  assert.match(reveal, /pointer-events:\s*auto/);
});

// (TPT308) The tray wraps Select: closed it is the 42px box around the pill, open it grows down.
test('.card-action-menu is a narrow tray around Select that grows down on hover or focus', () => {
  const menu = ruleBody(/\n\s*\.card-action-menu/);
  assert.match(menu, /position:\s*absolute/);
  assert.match(menu, /top:\s*-5px/);
  assert.match(menu, /right:\s*-5px/);
  assert.match(menu, /flex-direction:\s*column/);
  assert.match(menu, /height:\s*42px/);
  assert.match(menu, /overflow:\s*clip/);
  assert.match(menu, /interpolate-size:\s*allow-keywords/);
  assert.match(menu, /opacity:\s*0/);
  assert.match(menu, /visibility:\s*hidden/);
  assert.match(menu, /pointer-events:\s*none/);
  assert.doesNotMatch(menu, /transform:/);
  // Close: shrink back to Select first, then fade.
  assert.match(menu, /transition:\s*height \d+ms ease, opacity 120ms ease \d+ms/);
  const m = css.match(/\.card-btn-group:hover \.card-action-menu,\s*\.card-btn-group:focus-within \.card-action-menu\s*\{([^}]*)\}/);
  assert.ok(m, 'hover/focus open rule not found');
  assert.match(m[1], /height:\s*auto/);
  assert.match(m[1], /opacity:\s*1/);
  assert.match(m[1], /visibility:\s*visible/);
  assert.match(m[1], /pointer-events:\s*auto/);
  // Open: fade in around Select first, then grow (height delayed after opacity).
  assert.match(m[1], /transition:\s*opacity 120ms ease, height \d+ms ease \d+ms/);
  // ::before is Select's 32px slot inside the tray.
  const spacer = ruleBody(/\n\s*\.card-action-menu::before/);
  assert.match(spacer, /content:\s*''/);
  assert.match(spacer, /flex:\s*0 0 32px/);
  // Select paints above the tray backdrop.
  const sel = ruleBody(/\n\s*\.card-btn-group \.btn-select-card/);
  assert.match(sel, /position:\s*relative/);
  assert.match(sel, /z-index:\s*1/);
  assert.match(menu, /z-index:\s*0/);
});

test('an open menu escapes a short card\'s clip', () => {
  const body = ruleBody(/\n\s*\.card:not\(\.is-truncated\):has\(\.card-btn-group:is\(:hover, :focus-within\)\)/);
  assert.match(body, /overflow:\s*visible !important/);
  assert.match(body, /z-index:/);
});

test('group button tooltips anchor left so they never cover the menu', () => {
  assert.match(cardJs, /if \(btn\.closest\('\.card-btn-group'\)\) \{\s*tip\.classList\.add\('tooltip-flip-left'\)/);
});

// (TPT278) Hover icon group: 32px minimum hit target, visible pill in every theme.
test('.card-btn-group buttons are 32px pills with a primary-accent hover', () => {
  const body = ruleBody(/\n\s*\.card-btn-group button/);
  assert.match(body, /width:\s*32px/);
  assert.match(body, /height:\s*32px/);
  assert.match(body, /display:\s*inline-flex/);
  assert.match(body, /align-items:\s*center/);
  assert.match(body, /justify-content:\s*center/);
  assert.match(body, /background:\s*var\(--c-bg-card\)/);
  assert.match(body, /border:\s*1px solid var\(--c-border\)/);
  assert.match(ruleBody(/\n\s*\.card-btn-group button:hover/), /var\(--c-primary\)/);
});

test('.btn-select-card has a full 32px hit box', () => {
  const body = ruleBody(/\n\s*\.btn-select-card/);
  assert.match(body, /width:\s*32px/);
  assert.match(body, /height:\s*32px/);
  assert.match(body, /display:\s*inline-flex/);
});

test('attention and discussing cards hide / disable the action group', () => {
  assert.match(css, /\.card\.needs-attention \.card-btn-group \{ display: none !important; \}/);
  assert.match(css, /\.card\.card--discussing \.card-btn-group,/);
  // Re-asserted after the reveal rule, which has equal specificity.
  assert.ok(css.lastIndexOf('.card.card--discussing .card-btn-group { pointer-events: none; }')
    > css.indexOf('.card-btn-group:focus-within {'));
});

test('card-ctl is in the shared control rule and survives in-place patches', () => {
  const m = css.match(/\.task-card-hover-controls :is\(([^)]*)\)\s*\{/);
  assert.ok(m && m[1].includes('.card-ctl'), '.card-ctl not in shared rule');
  // refreshCard() rewrites the select's className — it must keep card-ctl.
  assert.match(cardJs, /sel\.className = 'card-status-select card-ctl'/);
  // updateClaudeButtons() builds Terminate at runtime — same class as render-time controls.
  assert.doesNotMatch(boardJs, /termBtn\.className = 'btn-terminate';/);
});

// (TPT279) Objective-chat proposal card: head and meta rows follow the same control-row look.
test('proposal meta row shares the control sizing and is a centred, wrapping 8px-gap flex row', () => {
  const m = css.match(/([^{}]*)\.task-card-hover-controls :is\(/);
  assert.ok(m && m[1].includes('.card.preview-card .card-preview-meta .card-ctl'),
    'proposal .card-ctl not in the shared sizing rule');
  const body = ruleBody(/\n\s*\.card\.preview-card \.card-preview-meta/);
  assert.match(body, /display:\s*flex/);
  assert.match(body, /align-items:\s*center/);
  assert.match(body, /flex-wrap:\s*wrap/);
  assert.match(body, /gap:\s*8px/);
  // The agent badge is a static in-row item, never the board's absolute corner badge.
  assert.match(ruleBody(/\n\s*\.preview-card \.agent-badge/), /position:\s*static/);
});

test('proposal head row keeps the NEW/MODIFIED label and hints on one centred line', () => {
  const body = ruleBody(/\n\s*\.card\.preview-card \.preview-card-head/);
  assert.match(body, /display:\s*flex/);
  assert.match(body, /align-items:\s*center/);
  assert.match(body, /flex-wrap:\s*nowrap/);
  assert.match(body, /gap:\s*8px/);
  assert.doesNotMatch(ruleBody(/\n\s*\.preview-card \.change-label/), /align-self:\s*flex-start/);
});

// (TPT299) Proposal card tidy-up: one badge, full-width wrapping title, themed sprint select,
// board-pill accept/reject.
test('proposal title wraps on its own line and never marquee-scrolls', () => {
  assert.match(ruleBody(/\n\s*\.card\.preview-card \.id-badge\[hidden\]/), /display:\s*none/);
  const top = ruleBody(/\n\s*\.card\.preview-card \.card-top--proposal/);
  assert.match(top, /flex-wrap:\s*wrap/);
  const title = ruleBody(/\n\s*\.card\.preview-card \.card-top--proposal \.card-title/);
  assert.match(title, /flex:\s*1 1 100%/);
  assert.match(title, /white-space:\s*normal/);
  assert.match(title, /overflow:\s*visible/);
  const inner = ruleBody(/\n\s*\.card\.preview-card \.card-top--proposal \.card-title \.card-title-inner/);
  assert.match(inner, /animation:\s*none/);
  // Must come after the marquee rules it overrides (equal specificity).
  assert.ok(css.indexOf('.card-top--proposal .card-title .card-title-inner') > css.indexOf('animation: marquee-scroll'));
  assert.match(cardJs, /querySelectorAll\('\.card-title:not\(\.preview-title\)'\)/);
});

// (TPT346) A proposal title wraps in full, so the board's one-line hover pill is skipped for it
// unless the card clips the title, and any remaining pill wraps inside the title's own column.
test('proposal title hover pill is skipped unless clipped, and wraps in the title column', () => {
  const start = cardJs.indexOf("el.addEventListener('mouseenter'");
  assert.ok(start > 0, 'title mouseenter handler not found');
  const handler = cardJs.slice(start, cardJs.indexOf("el.addEventListener('mouseleave'", start));
  assert.match(handler, /el\.classList\.contains\('preview-title'\)/);
  assert.match(handler, /isProposalTitle && !isRectClipped\(rect, cardRect\)\) return/);
  assert.match(handler, /card-title-tooltip--wrap/);
  assert.match(handler, /tip\.style\.width = rect\.width/);
  // The wrap branch returns before the board path's right-edge flip, which it must not use.
  const wrapReturn = handler.search(/_titleTooltip = tip;\s*return;/);
  assert.ok(wrapReturn > 0 && wrapReturn < handler.indexOf('computeTooltipAnchor('));
  const pill = ruleBody(/\n\s*\.card-title-tooltip\.card-title-tooltip--wrap/);
  assert.match(pill, /white-space:\s*normal/);
  assert.match(pill, /overflow-wrap:\s*anywhere/);
  assert.match(pill, /max-width:\s*none/);
  assert.match(pill, /border:\s*0/);
  assert.match(pill, /padding:\s*0\.15rem 0/);
});

test('proposal sprint select has no native chrome and a theme-tracking chevron', () => {
  const body = ruleBody(/\n\s*\.preview-step-select/);
  assert.match(body, /(?<!-webkit-)appearance:\s*none/);
  assert.match(body, /-webkit-appearance:\s*none/);
  assert.match(body, /currentColor/);
  assert.doesNotMatch(body, /%23666/);
  assert.match(body, /border:\s*1px solid var\(--c-border-input\)/);
  assert.match(body, /background-color:\s*var\(--c-bg-card\)/);
  const meta = ruleBody(/\n\s*\.card\.preview-card \.card-preview-meta \.preview-step-select/);
  assert.match(meta, /border-radius:\s*8px/);
  assert.match(meta, /font-size:\s*0\.78rem/);
  assert.match(css, /\.theme-dark \.preview-step-select \{ color-scheme: dark; \}/);
});

// (TPT303) Compact at rest (status + content-sized sprint on one line), and the hover/click
// overlay keeps the slot's width, never compresses the title into the meta row, draws no bar.
test('proposal meta keeps status + sprint on one line and the overlay stays aligned', () => {
  const group = ruleBody(/\n\s*\.card\.preview-card \.preview-meta-controls/);
  assert.match(group, /display:\s*inline-flex/);
  assert.match(group, /flex-wrap:\s*nowrap/);
  assert.match(group, /min-width:\s*0/);
  const sel = ruleBody(/\n\s*\.card\.preview-card \.card-preview-meta \.preview-step-select/);
  assert.match(sel, /field-sizing:\s*content/);
  assert.match(sel, /min-width:\s*0/);
  assert.match(ruleBody(/\n\s*\.card\.preview-card > \*/), /flex-shrink:\s*0/);
  const expanded = ruleBody(/\n\s*\.preview-card\.card-expanded(?= \{ min-width)/);
  assert.match(expanded, /min-width:\s*0/);
  assert.match(expanded, /max-width:\s*none/);
  assert.match(expanded, /scrollbar-width:\s*none/);
  assert.match(css, /\.preview-card\.card-expanded::-webkit-scrollbar \{ display: none; \}/);
  assert.doesNotMatch(css, /\.preview-card\.card-expanded \{[^}]*min\(380px/);
  assert.match(cardJs, /card\.classList\.contains\('preview-card'\)\s*\?\s*window\.innerHeight - 20/);
});

test('proposal accept/reject match the board .card-btn-group button pill', () => {
  const board = ruleBody(/\n\s*\.card-btn-group button/);
  const pill = ruleBody(/\n\s*\.preview-card-actions \.btn-accept-card,\s*\.preview-card-actions \.btn-reject-card/);
  for (const prop of ['width', 'height', 'border', 'border-radius', 'background', 'box-shadow', 'transition']) {
    const want = board.match(new RegExp(String.raw`(?:^|\n)\s*${prop}:\s*([^;]+);`));
    const got = pill.match(new RegExp(String.raw`(?:^|\n)\s*${prop}:\s*([^;]+);`));
    assert.ok(want && got && want[1].trim() === got[1].trim(), `${prop} differs: ${want?.[1]} vs ${got?.[1]}`);
  }
  assert.match(ruleBody(/\n\s*\.preview-card-actions \.btn-accept-card:not\(\.active\):hover/), /var\(--c-primary\)/);
  assert.match(css, /\.theme-dark \.preview-card-actions button:not\(\.active\) \{/);
});
