'use strict';

const readline = require('node:readline');
const { request } = require('./http');

// ANSI escape helpers
const ESC = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  CYAN: '\x1b[36m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  HIDE_CURSOR: '\x1b[?25l',
  SHOW_CURSOR: '\x1b[?25h',
  CLEAR_LINE: '\x1b[2K',
  UP: (n) => `\x1b[${n}A`,
  DOWN: (n) => `\x1b[${n}B`,
};

/**
 * Prompt for text input.
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
function prompt(message, defaultValue) {
  return new Promise((resolve) => {
    const hint = defaultValue ? ` ${ESC.DIM}(${defaultValue})${ESC.RESET}` : '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Simple y/N confirmation prompt.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirm(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${message} ${ESC.DIM}[y/N]${ESC.RESET} `);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      const ch = data.toString().trim().toLowerCase();
      process.stdout.write(ch + '\n');
      resolve(ch === 'y');
    });
  });
}

/**
 * Interactive arrow-key selector.
 * @param {string} heading
 * @param {{ label: string, value: any, selected?: boolean }[]} items
 * @returns {Promise<any>}
 */
function selectFromItems(heading, items) {
  let cursor = items.findIndex(item => item.selected);
  if (cursor === -1) cursor = 0;

  function render() {
    // Move up to redraw (except on first render)
    for (let i = 0; i < items.length; i++) {
      process.stdout.write(`${ESC.CLEAR_LINE}\r`);
      if (i === cursor) {
        process.stdout.write(`  ${ESC.CYAN}> ${items[i].label}${ESC.RESET}\n`);
      } else {
        process.stdout.write(`    ${items[i].label}\n`);
      }
    }
    // Move cursor back up to top of list for next redraw
    if (items.length > 0) {
      process.stdout.write(ESC.UP(items.length));
    }
  }

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-interactive fallback: just pick the first item
      resolve(items[0].value);
      return;
    }

    process.stdout.write(`\n  ${ESC.BOLD}${heading}:${ESC.RESET}\n\n`);
    process.stdout.write(ESC.HIDE_CURSOR);
    render();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      process.stdout.write(ESC.SHOW_CURSOR);
      // Move past the list
      process.stdout.write(ESC.DOWN(items.length));
      process.stdout.write('\n');
    }

    function onKey(key) {
      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        reject(new Error('Aborted'));
        return;
      }
      // q
      if (key === 'q') {
        cleanup();
        reject(new Error('Aborted'));
        return;
      }
      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(items[cursor].value);
        return;
      }
      // Arrow keys (escape sequences)
      if (key === '\x1b[A' || key === 'k') {
        // Up
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        // Down
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      }
    }

    process.stdin.on('data', onKey);
  });
}

/**
 * Interactive checkbox multi-selector.
 * @param {string} heading
 * @param {{ label: string, value: any, selected?: boolean }[]} items
 * @returns {Promise<any[]>}
 */
function multiSelect(heading, items) {
  const selected = new Set(
    items.map((item, i) => (item.selected !== false ? i : -1)).filter(i => i >= 0)
  );
  let cursor = 0;

  function render() {
    for (let i = 0; i < items.length; i++) {
      process.stdout.write(`${ESC.CLEAR_LINE}\r`);
      const check = selected.has(i) ? `${ESC.GREEN}[x]${ESC.RESET}` : `[ ]`;
      if (i === cursor) {
        process.stdout.write(`  ${ESC.CYAN}> ${check} ${items[i].label}${ESC.RESET}\n`);
      } else {
        process.stdout.write(`    ${check} ${items[i].label}\n`);
      }
    }
    if (items.length > 0) {
      process.stdout.write(ESC.UP(items.length));
    }
  }

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      resolve(items.filter((_, i) => selected.has(i)).map(item => item.value));
      return;
    }

    process.stdout.write(`\n  ${ESC.BOLD}${heading}:${ESC.RESET}  ${ESC.DIM}(space to toggle, enter to confirm)${ESC.RESET}\n\n`);
    process.stdout.write(ESC.HIDE_CURSOR);
    render();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      process.stdout.write(ESC.SHOW_CURSOR);
      process.stdout.write(ESC.DOWN(items.length));
      process.stdout.write('\n');
    }

    function onKey(key) {
      if (key === '\x03') { cleanup(); reject(new Error('Aborted')); return; }
      if (key === 'q')    { cleanup(); reject(new Error('Aborted')); return; }
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(items.filter((_, i) => selected.has(i)).map(item => item.value));
        return;
      }
      if (key === ' ') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        render();
      } else if (key === '\x1b[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      }
    }

    process.stdin.on('data', onKey);
  });
}

/**
 * Interactive arrow-key project selector.
 * @param {{ id: string|number, name: string, taskCount?: number }[]} projects
 * @returns {Promise<object|'CREATE_NEW'>}
 */
function selectProject(projects) {
  return selectFromItems('Select a project', [
    ...projects.map((p) => ({
      label: `${p.name} ${ESC.DIM}(${p.taskCount ?? 0} tasks)${ESC.RESET}`,
      value: p,
    })),
    {
      label: `${ESC.GREEN}+ Create new project${ESC.RESET}`,
      value: 'CREATE_NEW',
    },
  ]);
}

/**
 * Interactive arrow-key task-agent selector.
 * @param {{ id: string, label: string }[]} agents
 * @param {string} selectedId
 * @returns {Promise<{ id: string, label: string }>}
 */
function selectAgent(agents, selectedId) {
  return selectFromItems('Select a default task agent', agents.map((agent) => ({
    label: agent.label,
    value: agent,
    selected: agent.id === selectedId,
  })));
}

/**
 * Prompt user to create a new project via the API.
 * @param {string} apiBaseUrl
 * @param {string} token
 * @returns {Promise<object>}
 */
async function createProject(apiBaseUrl, token) {
  let name = '';
  while (!name) {
    name = await prompt('  Project name');
    if (!name) {
      console.log('  Project name is required.');
    }
  }
  const description = await prompt('  Description (optional)');

  const { status, data } = await request(`${apiBaseUrl}/api/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { name, description: description || undefined },
  });

  if (status >= 400) {
    throw new Error(`Failed to create project: ${JSON.stringify(data)}`);
  }

  return data.project || data;
}

/**
 * Render a fixed-width TUI splash box with a faint Δ watermark.
 * @param {string[]} lines - First element is the title, rest are status rows.
 */
function drawSplash(lines) {
  const W = 54;
  const inner = W - 2;
  const top    = `╭${'─'.repeat(inner)}╮`;
  const bottom = `╰${'─'.repeat(inner)}╯`;
  const blank  = `│${' '.repeat(inner)}│`;

  function pad(s) {
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    const space = Math.max(0, inner - visible.length);
    const left  = Math.floor(space / 2);
    return `│${' '.repeat(left)}${s}${' '.repeat(space - left)}│`;
  }

  const watermark = pad(`${ESC.DIM}Δ${ESC.RESET}`);
  const title = lines[0] ? [pad(lines[0])] : [];
  const status = lines.slice(1).map(pad);

  const out = [top, blank, ...title, blank, watermark, blank, ...status, blank, bottom];
  process.stdout.write('\n' + out.join('\n') + '\n\n');
}

module.exports = { prompt, confirm, selectFromItems, multiSelect, selectProject, selectAgent, createProject, drawSplash };
