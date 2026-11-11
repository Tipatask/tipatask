// (TPT9239) Where a task run was started. GET /api/sessions marks a run the web app started on
// this device (through the device relay) with `origin: 'web'` on its sessionMeta row, and that
// run's own `config` and `terminal-state` frames carry the same field; a run started in Task App
// carries none. The left-nav session row (task-board.js) and the terminal header
// (console-modal.js) show a globe for it. Pure, with no imports, so node tests load it directly.

export const WEB_ORIGIN = 'web';

// A globe on a 12px grid: outline, equator and one meridian. Strokes follow currentColor.
export const WEB_ORIGIN_SVG = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<circle cx="6" cy="6" r="4.6"/><path d="M1.4 6h9.2"/>'
  + '<path d="M6 1.4c1.3 1.25 1.95 2.8 1.95 4.6S7.3 9.35 6 10.6C4.7 9.35 4.05 7.8 4.05 6S4.7 2.65 6 1.4z"/></svg>';

// The origin a sessionMeta row or a session frame names: 'web', or null for any other run.
export function sessionOrigin(source) {
  return source && source.origin === WEB_ORIGIN ? WEB_ORIGIN : null;
}

// Corner badge on a left-nav row's agent icon. Decorative: the row's tooltip and aria-label name
// the web origin in words.
export const SESSION_ORIGIN_BADGE = `<span class="session-origin-badge" aria-hidden="true">${WEB_ORIGIN_SVG}</span>`;

// Terminal header badge beside the agent dot. `label` must already be attribute-escaped.
export function terminalOriginBadge(label) {
  return `<span class="terminal-origin-badge" role="img" aria-label="${label}" title="${label}">${WEB_ORIGIN_SVG}</span>`;
}
