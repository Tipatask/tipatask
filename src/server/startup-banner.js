'use strict';

// PHPStorm-style splash printed once on Task App boot, before the server starts
// listening. Purely cosmetic console output — no i18n needed (dev-tool splash,
// not user-facing UI copy). TIPATASK_NO_BANNER=1 suppresses it.
//
// The supported way to run TipΔTask is the Electron desktop app, which forks this server
// with TIPATASK_ELECTRON_HOST=1. A bare `node todo-server.js` is the browser/debug mode,
// and the banner says so.

// 5x5 block-letter bitmap font — only the glyphs "TIPATASK" needs.
const FONT = {
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
};

function renderWord(word) {
  const rows = ['', '', '', '', ''];
  for (const ch of word) {
    const glyph = FONT[ch] || ['     ', '     ', '     ', '     ', '     '];
    for (let i = 0; i < 5; i++) rows[i] += (rows[i] ? ' ' : '') + glyph[i];
  }
  return rows;
}

// (C1352/C1353) The file task backend is retired — api is the only reachable backend, so this
// no longer branches on config.TASK_BACKEND.
function backendLine(config) {
  const project = config.API_PROJECT_ID ? `#${config.API_PROJECT_ID}` : '(no project set)';
  const base = config.API_BASE_URL ? ` @ ${config.API_BASE_URL}` : '';
  return `api  ${project}${base}`;
}

function modeLines(env) {
  if (env.TIPATASK_ELECTRON_HOST === '1' || process.versions.electron) {
    return ['  Mode    : desktop app (embedded server)'];
  }
  return [
    '  Mode    : browser / debug — the supported UI is the TipΔTask desktop app',
    '            (npm run electron); this server-only mode is for debugging the web layer.',
  ];
}

// Pure body builder (no console/TTY) so the banner is unit-testable.
function buildStartupBannerLines({ config, version, env = process.env }) {
  const art = renderWord('TIPATASK');
  const width = art[0].length;
  const rule = '─'.repeat(width);
  return [
    '',
    rule,
    ...art,
    rule,
    `  Version : v${version}`,
    ...modeLines(env),
    `  Port    : ${config.PORT}`,
    `  Backend : ${backendLine(config)}`,
    `  Agent   : ${config.TASK_AGENT}`,
    `  Board   : http://127.0.0.1:${config.PORT}/todo.html`,
    rule,
    '',
  ];
}

function printStartupBanner() {
  if (process.env.TIPATASK_NO_BANNER === '1') return;

  const config = require('./config');
  let version = '?';
  try { version = require('../../package.json').version; } catch {}

  const text = buildStartupBannerLines({ config, version }).join('\n');
  // Guard is isTTY-agnostic (prints under nodemon/pm2 log pipes too) — color is
  // the only thing gated on isTTY, so piped output stays free of raw escape codes.
  const output = process.stdout.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
  console.log(output);
}

module.exports = { printStartupBanner, buildStartupBannerLines };
