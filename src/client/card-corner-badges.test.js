import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT9149) A board card keeps room for its absolute corner badges: the member avatar
// (bottom-left), the effort chip and the agent badge (bottom-right) sit in a bottom band of the
// card's padding, never on its last row. CSS isn't executable under node, so the invariants are
// source-scanned, same as card-desc-scroll.test.js; the rendered geometry is checked in Chrome.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const cardJs = readFileSync(new URL('./task-card.js', import.meta.url), 'utf8');

const MEMBER_BAND = /\n\s*\.card:not\(\.card--preview\):is\(\.has-member-badge, \.has-effort-badge\)/;
const AGENT_BAND = /\n\s*\.card:not\(\.card--preview\)\.has-agent-badge/;

const ruleRe = selectorRe => new RegExp(selectorRe.source + String.raw`\s*\{([^}]*)\}`);

// Body of the first rule whose selector text matches `selectorRe` (selector must end at `{`).
function ruleBody(selectorRe) {
  const m = css.match(ruleRe(selectorRe));
  assert.ok(m, `rule ${selectorRe} not found`);
  return m[1];
}

// A length in px, written plain or as a var() fallback.
function px(body, prop) {
  const m = body.match(new RegExp(String.raw`(?:^|[\s;])${prop}:\s*(?:var\(--[\w-]+,\s*)?(\d+(?:\.\d+)?)px`));
  assert.ok(m, `${prop} (px) not found in ${body}`);
  return Number(m[1]);
}

const tokens = (() => {
  const m = css.match(/\n\s*\.card \{([^}]*--card-badge-inset[^}]*)\}/);
  assert.ok(m, 'corner badge token block not found');
  const read = name => {
    const v = m[1].match(new RegExp(String.raw`--${name}:\s*(\d+)px;`));
    assert.ok(v, `--${name} not declared`);
    return Number(v[1]);
  };
  return {
    inset: read('card-badge-inset'),
    member: read('card-member-badge-size'),
    agent: read('card-agent-badge-size'),
    clearance: read('card-badge-clearance'),
  };
})();

test('renderCard() hooks each corner badge onto a board card root; previews and proposals carry none', () => {
  // The class is set exactly when the badge markup is, so the band follows the badge.
  assert.match(cardJs, /\$\{agentBadge \? ' has-agent-badge' : ''\}/);
  assert.match(cardJs, /\$\{effortBadge \? ' has-effort-badge' : ''\}/);
  assert.match(cardJs, /\$\{memberBadge \? ' has-member-badge' : ''\}/);
  // Only board cards draw corner badges. Previews (task chat card, Discuss card) end their meta row
  // with the badges (TPT9153); proposal callers put them in metaHtml (TPT9147).
  assert.match(cardJs, /const agentBadge = preview \? '' : renderAgentBadge\(t\);/);
  assert.match(cardJs, /const effortBadge = preview \? '' : renderEffortBadge\(t\);/);
  assert.match(cardJs, /const memberBadge = preview \? '' : renderMemberBadge\(t\);/);
});

test('a preview card puts its badges statically at the end of the meta row, not in the corners', () => {
  // Effort chip, member avatar, agent badge: the New Task Preview's order (TPT9147).
  assert.match(cardJs, /const previewBadges = preview && !proposal \? `\$\{renderEffortBadge\(t\)\}\$\{renderMemberBadge\(t\)\}\$\{renderAgentBadge\(t\)\}` : '';/);
  assert.match(cardJs, /\$\{previewBadges \? `<span class="preview-meta-badges">\$\{previewBadges\}<\/span>` : ''\}<\/div>`;/);
  // Scoped to every preview card, so it reaches .task-chat-widget--task and .chat-discuss-card ones.
  const group = ruleBody(/\n\s*\.card\.card--preview \.preview-meta-badges/);
  assert.match(group, /display:\s*inline-flex/);
  assert.match(group, /margin-left:\s*auto/);
  assert.match(ruleBody(/\n\s*\.card\.card--preview \.preview-meta-badges :is\(\.member-badge, \.effort-badge, \.agent-badge\)/), /position:\s*static/);
  // Neither preview container may put a badge back in a corner.
  assert.doesNotMatch(css, /(?:\.task-chat-widget--task|\.chat-discuss-card) \.card--preview[^{]*\.(?:member|effort|agent)-badge[^{]*\{[^}]*position:\s*absolute/);
});

test('the avatar and the agent badge are placed from the shared corner badge tokens', () => {
  const agent = ruleBody(/\n\s*\.agent-badge/);
  assert.match(agent, /position:\s*absolute/);
  assert.match(agent, /bottom:\s*var\(--card-badge-inset, \d+px\)/);
  assert.match(agent, /right:\s*var\(--card-badge-inset, \d+px\)/);
  assert.match(agent, /width:\s*var\(--card-agent-badge-size, \d+px\)/);
  assert.match(agent, /height:\s*var\(--card-agent-badge-size, \d+px\)/);
  const member = ruleBody(/\n\s*\.member-badge/);
  assert.match(member, /position:\s*absolute/);
  assert.match(member, /bottom:\s*var\(--card-badge-inset, \d+px\)/);
  assert.match(member, /left:\s*var\(--card-badge-inset, \d+px\)/);
  assert.match(member, /width:\s*var\(--card-member-badge-size, \d+px\)/);
  assert.match(member, /height:\s*var\(--card-member-badge-size, \d+px\)/);
  // The fallbacks are the token values, so a badge looks the same inside and outside a card.
  assert.equal(px(agent, 'bottom'), tokens.inset);
  assert.equal(px(agent, 'width'), tokens.agent);
  assert.equal(px(member, 'bottom'), tokens.inset);
  assert.equal(px(member, 'width'), tokens.member);
});

test('a board card with a corner badge makes its bottom padding the badge band', () => {
  assert.match(
    ruleBody(MEMBER_BAND),
    /padding-bottom:\s*calc\(var\(--card-badge-inset\) \+ var\(--card-member-badge-size\) \+ var\(--card-badge-clearance\)\)/,
  );
  assert.match(
    ruleBody(AGENT_BAND),
    /padding-bottom:\s*calc\(var\(--card-badge-inset\) \+ var\(--card-agent-badge-size\) \+ var\(--card-badge-clearance\)\)/,
  );
  // Same specificity, so the taller agent band must come later to win on a card with both.
  assert.ok(css.search(ruleRe(AGENT_BAND)) > css.search(ruleRe(MEMBER_BAND)), 'agent band rule must follow the member band rule');
  assert.ok(tokens.agent >= tokens.member, 'the agent band is the taller one');
  assert.ok(tokens.clearance > 0, 'the band leaves air between the last row and the badges');
});

test('the effort chip stays inside the band of the badges it sits beside', () => {
  const chip = ruleBody(/\n\s*\.effort-badge/);
  assert.match(chip, /position:\s*absolute/);
  const padding = chip.match(/padding:\s*(\d+)px/);
  const border = chip.match(/border:\s*(\d+)px solid/);
  assert.ok(padding && border, 'effort chip padding/border not found');
  const top = px(chip, 'bottom') + px(chip, 'line-height') + 2 * Number(padding[1]) + 2 * Number(border[1]);
  // has-effort-badge alone reserves the avatar-sized band, so the chip must fit under it too.
  assert.ok(top <= tokens.inset + tokens.member, `effort chip top edge ${top}px is above the avatar band`);
});
