// Real Chromium keyboard regression for the Task Edit and Edit Agents dialogs.
// Run after npm run build: electron scripts/probe-dialog-focus.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'dialog-focus-probe-entry.js')],
  outfile: path.join(root, 'dist/dialog-focus-probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
});

async function main() {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850 });
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (event) => {
    if (/error|failed/i.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(root, 'fixtures/dialog-focus.html'));
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Accessibility.enable');

  const run = async (expression) => {
    try { return await wc.executeJavaScript(expression); }
    catch (error) { throw new Error(`${error.message}; console: ${errors.join(' | ')}`, { cause: error }); }
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${expression}; console: ${errors.join(' | ')}`);
  };
  const key = async (name, shift = false) => {
    const code = name === 'Tab' ? 9 : name === 'Enter' ? 13 : name === 'Escape' ? 27 : 32;
    const modifiers = shift ? 8 : 0;
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, modifiers,
    });
    if (name === 'Enter' || name === ' ') {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'char', key: name, code: name, text: name === 'Enter' ? '\r' : ' ',
        windowsVirtualKeyCode: code, modifiers,
      });
    }
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, modifiers,
    });
  };
  const active = () => run('document.activeElement?.className || document.activeElement?.id || ""');

  await wait('!!window.probe && !!document.querySelector(".card-edit-btn")');
  await run('document.querySelector(".btn-select-card").focus()');
  await key('Tab');
  assert.match(await active(), /card-edit-btn/, 'card Edit action is reachable by Tab');
  await key('Enter');
  await wait('!!document.querySelector(".task-edit-panel")');
  assert.match(await active(), /modal-title-input/, 'Task Edit focuses title');
  assert.equal(await run('document.querySelector("#app").inert && document.querySelector("#settings-modal").inert'), true);
  assert.equal(await run('document.querySelector(".task-edit-panel").getAttribute("aria-label")'), 'Edit task TPT335');
  assert.equal(await run('document.querySelector(".modal-title-input").getAttribute("aria-label")'), 'Title');
  assert.equal(await run('document.querySelector(".modal-desc-display").getAttribute("role")'), 'button');
  let ax = (await wc.debugger.sendCommand('Accessibility.getFullAXTree')).nodes;
  assert.ok(ax.some(node => !node.ignored && node.role?.value === 'dialog' && node.name?.value === 'Edit task TPT335'),
    'Task Edit name reaches Chromium accessibility tree');
  assert.ok(ax.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === 'Edit description'),
    'description editor action reaches accessibility tree');
  await key('Tab');
  assert.match(await active(), /modal-desc-display/, 'Tab reaches description editor');
  await key('Enter');
  assert.match(await active(), /modal-desc-textarea/, 'Enter opens description editor');
  await wc.debugger.sendCommand('Input.insertText', { text: ' keyboard' });
  assert.equal(await run('document.querySelector(".modal-desc-textarea").value'), ' keyboardOriginal description');
  await key('Escape');
  assert.match(await active(), /modal-desc-display/, 'editor Escape returns to display');
  assert.equal(await run('!!document.querySelector(".task-edit-panel")'), true);

  await run('document.querySelector(".modal-status-select").focus()');
  await key('Tab', true);
  assert.equal(await run('document.querySelector("#task-edit-modal").contains(document.activeElement)'), true,
    'Shift+Tab wraps inside Task Edit');
  await run('document.querySelector("#background-button").focus()');
  assert.equal(await run('document.querySelector("#task-edit-modal").contains(document.activeElement)'), true,
    'programmatic focus cannot escape to background');
  await key('Escape');
  await wait('!!document.querySelector(".modal-overlay--over-modal")');
  assert.equal(await run('document.querySelector("#task-edit-modal").inert'), true, 'confirmation makes underlying dialog inert');
  assert.equal(await run('document.activeElement.classList.contains("btn-cancel")'), true);
  await key('Tab', true);
  assert.equal(await run('document.activeElement.classList.contains("btn-confirm")'), true, 'confirmation wraps backward');
  await key('Escape');
  await wait('!document.querySelector(".modal-overlay--over-modal")');
  assert.equal(await run('!!document.querySelector(".task-edit-panel")'), true, 'confirmation Escape keeps Task Edit open');
  await run('document.querySelector(".btn-modal-save").focus()');
  await key('Enter');
  await wait('document.querySelector("#task-edit-modal").hidden');
  assert.match(await active(), /card-edit-btn/, 'Save returns focus to card Edit action');
  assert.equal(await run('window.probe.saved.description'), ' keyboardOriginal description');
  assert.equal(await run('document.querySelector("#app").inert'), false);

  await key('Enter');
  await wait('!!document.querySelector(".task-edit-panel")');
  await run('document.querySelector(".modal-title-input").select()');
  await wc.debugger.sendCommand('Input.insertText', { text: 'Changed title' });
  assert.equal(await run('document.querySelector(".modal-title-input").value'), 'Changed title');
  await run('document.querySelector(".btn-modal-reset").focus()');
  await key('Enter');
  assert.equal(await run('document.querySelector(".modal-title-input").value'), 'Keyboard task');
  assert.match(await active(), /modal-title-input/, 'Reset rebuild restores a valid focus target');
  await run('document.querySelector(".modal-dep-input").focus()');
  await key('Tab');
  assert.equal(await run('document.activeElement.classList.contains("modal-status-select")'), true,
    'Tab from the last field wraps to the first');
  await run('document.querySelector(".modal-title-input").select()');
  await wc.debugger.sendCommand('Input.insertText', { text: 'Discarded title' });
  await key('Escape');
  await wait('!!document.querySelector(".modal-overlay--over-modal")');
  await key('Tab');
  assert.equal(await run('document.activeElement.classList.contains("btn-confirm")'), true);
  await key('Enter');
  await wait('document.querySelector("#task-edit-modal").hidden');
  assert.match(await active(), /card-edit-btn/, 'confirmed discard returns to card action');

  await run('window.probe.openReadOnly()');
  await wait('!!document.querySelector(".task-edit-panel")');
  assert.equal(await run('document.querySelector(".modal-title-input").readOnly'), true);
  assert.equal(await run('document.querySelector(".modal-desc-display").hasAttribute("tabindex")'), false);
  await run('document.querySelector(".modal-desc-display").click()');
  assert.equal(await run('!!document.querySelector(".modal-desc-textarea")'), false, 'read-only description remains read-only');
  assert.equal(await run('document.querySelector(".btn-modal-save").disabled'), true);
  await run('document.querySelector(".btn-modal-cancel").focus()');
  await key('Enter');
  await wait('document.querySelector("#task-edit-modal").hidden');

  await run('document.querySelector("#settings-modal").classList.add("open"); document.querySelector("#settings-agents-edit").focus()');
  await key('Enter');
  await wait('!!document.querySelector("#agents-modal-save")');
  assert.equal(await run('document.activeElement.classList.contains("setup-modal-close")'), true, 'Agents focuses Close');
  assert.equal(await run('document.querySelector("#settings-modal").inert && document.querySelector("#app").inert'), true);
  assert.equal(await run('document.querySelector(".agents-modal").getAttribute("aria-labelledby")'), 'agents-modal-title');
  ax = (await wc.debugger.sendCommand('Accessibility.getFullAXTree')).nodes;
  assert.ok(ax.some(node => !node.ignored && node.role?.value === 'dialog' && node.name?.value === 'Edit Agents'),
    'Agents name reaches Chromium accessibility tree');
  await run('document.querySelector(".setup-modal-close").focus()');
  await key('Tab', true);
  assert.equal(await run('document.querySelector(".agents-modal").contains(document.activeElement)'), true);
  await key('Escape');
  await wait('!document.querySelector(".agents-modal")');
  assert.equal(await run('document.activeElement.id'), 'settings-agents-edit', 'Agents Escape returns focus');
  assert.equal(await run('document.querySelector("#settings-modal").classList.contains("open")'), true);

  await run('window.probe.setLocale("uk"); document.querySelector("#settings-agents-edit").focus()');
  await key('Enter');
  await wait('!!document.querySelector("#agents-modal-cancel")');
  assert.equal(await run('document.querySelector("#agents-modal-title").textContent'), 'Редагувати агентів');
  await run('document.querySelector("#agents-modal-cancel").focus()');
  await key('Enter');
  await wait('!document.querySelector(".agents-modal")');
  assert.equal(await run('document.activeElement.id'), 'settings-agents-edit', 'Agents Cancel returns focus');

  await run('window.probe.openReadOnly()');
  await wait('!!document.querySelector(".task-edit-panel")');
  assert.equal(await run('document.querySelector(".task-edit-panel").getAttribute("aria-label")'), 'Деталі завдання TPT335');
  assert.equal(await run('document.querySelector(".modal-title-input").getAttribute("aria-label")'), 'Назва');
  await key('Escape');
  await wait('document.querySelector("#task-edit-modal").hidden');

  await run('window.probe.setLocale("en"); document.querySelector("#settings-agents-edit").focus()');
  await key('Enter');
  await wait('!!document.querySelector("#agents-modal-save") && !document.querySelector("#agents-modal-save").disabled');
  await run('document.querySelector("#agents-modal-save").focus()');
  await key('Enter');
  await wait('!document.querySelector(".agents-modal")');
  assert.equal(await run('document.activeElement.id'), 'settings-agents-edit', 'Agents Save returns focus');

  // Run the production Electron renderer block and markup. Only the native IPC boundary
  // is stubbed; chooser opening, keyboard handling and cleanup are the real handlers.
  const template = fs.readFileSync(path.join(root, 'src/client/template.html'), 'utf8');
  const projectMarkup = template.slice(template.indexOf('<div id="project-open-modal"'), template.indexOf('<script src="/bundle.js"'));
  const projectScript = template.slice(template.indexOf('// ── Electron project management'), template.lastIndexOf('</script>'));
  await run(`
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(projectMarkup)});
    window.TipTask = { dialogFocus: window.probe.dialogFocus, projectOpenFlow: window.probe.projectOpenFlow };
    window.probe.openedProjects = [];
    window.probe.pick = null;
    window.electronAPI = {
      getProjectPath: () => '/current',
      pickAndOpenProject: async () => window.probe.pick,
      focusProjectWindow: async () => ({ ok: false }),
      openProject: (dir, target) => window.probe.openedProjects.push({ dir, target }),
      onProjectChanged() {},
      onProjectMenu: (callback) => { window.probe.projectMenu = callback; },
    };
    (function(state, t) { ${projectScript} })(window.probe.state, window.probe.t);
    document.querySelector('#settings-modal').classList.remove('open');
    document.querySelector('.card-edit-btn').click();
  `);
  await wait('!!document.querySelector(".task-edit-panel")');
  await run('document.querySelector(".modal-title-input").focus()');
  await run('window.probe.projectMenu("open")');
  assert.equal(await run('document.activeElement.classList.contains("modal-title-input")'), true,
    'cancelling native folder picker preserves task focus');
  await run('window.probe.pick = { path: "/configured", config: {} }; window.probe.projectMenu("open")');
  assert.deepEqual(await run('window.probe.openedProjects.pop()'), { dir: '/configured', target: 'new' },
    'configured project follows production Open dispatch');

  const openChooser = () => run('window.dispatchEvent(new CustomEvent("project-created", { detail: { projectPath: "/picked" } }))');
  const click = async (selector) => {
    const { x, y } = await run(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const assertTaskRestored = async () => {
    await wait('document.querySelector("#project-open-modal").style.display === "none"');
    assert.equal(await run('!!document.querySelector(".task-edit-panel") && !document.querySelector("#task-edit-modal").inert'), true,
      'chooser close preserves interactive task modal');
    assert.equal(await run('document.activeElement.classList.contains("modal-title-input")'), true,
      'chooser close restores task focus');
  };
  await openChooser();
  assert.equal(await run('document.activeElement.id'), 'btn-project-cancel');
  assert.equal(await run('!document.querySelector("#project-open-modal").inert && document.querySelector("#task-edit-modal").inert'), true);
  assert.equal(await run(`(() => {
    const button = document.querySelector('#btn-project-new');
    const rect = button.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;
  })()`), true, 'Open Project button wins actual Chromium hit testing over task modal');
  ax = (await wc.debugger.sendCommand('Accessibility.getFullAXTree')).nodes;
  assert.ok(ax.some(node => !node.ignored && node.role?.value === 'dialog' && node.name?.value === 'Open Project'),
    'Open Project has a named dialog in the accessibility tree');
  await key('Tab', true);
  assert.equal(await run('document.activeElement.id'), 'btn-project-new', 'Tab wraps within Open Project');
  await key('Tab');
  assert.equal(await run('document.activeElement.id'), 'btn-project-cancel');
  await click('#btn-project-cancel');
  await assertTaskRestored();

  // Repeated show events reuse one layer; one Escape removes it without closing Task Edit.
  for (let i = 0; i < 3; i++) await openChooser();
  assert.equal(await run('document.querySelectorAll("#project-open-modal").length'), 1);
  await key('Escape');
  await assertTaskRestored();
  await openChooser();
  await click('#btn-project-new');
  assert.deepEqual(await run('window.probe.openedProjects.pop()'), { dir: '/picked', target: 'new' });
  await assertTaskRestored();
  await openChooser();
  await key('Tab');
  assert.equal(await run('document.activeElement.id'), 'btn-project-current');
  await key('Enter');
  assert.deepEqual(await run('window.probe.openedProjects.pop()'), { dir: '/picked', target: 'current' });
  await assertTaskRestored();

  await run('window.probe.state.activeSessions.add("running");');
  await openChooser();
  assert.equal(await run('document.querySelector("#btn-project-current").disabled'), true);
  await key('Tab');
  assert.equal(await run('document.activeElement.id'), 'btn-project-new', 'active session guard stays intact');
  await key('Escape');
  await assertTaskRestored();
  await run('window.probe.state.activeSessions.clear()');
  await key('Escape');
  await wait('document.querySelector("#task-edit-modal").hidden');
  assert.equal(await run('document.querySelector("#app").inert'), false, 'no blocking layer remains after all dialogs close');

  console.log('Dialog focus browser probe passed');
  if (process.argv.includes('--voiceover-smoke')) {
    await run('document.querySelector("#settings-modal").classList.remove("open"); document.querySelector(".card-edit-btn").click()');
    await wait('!!document.querySelector(".task-edit-panel")');
    win.show();
    win.focus();
    await run('document.querySelector(".modal-title-input").focus()');
    console.log(`VoiceOver Task Edit ready; PID ${process.pid}`);
    await new Promise(resolve => setTimeout(resolve, 45000));
    await run('window.probe.closeTaskEditModal(true); document.querySelector("#settings-modal").classList.add("open"); document.querySelector("#settings-agents-edit").click()');
    await wait('!!document.querySelector(".agents-modal")');
    win.focus();
    console.log(`VoiceOver Agents ready; PID ${process.pid}`);
    await new Promise(resolve => setTimeout(resolve, 45000));
  }
  wc.debugger.detach();
  win.close();
}

app.whenReady().then(main).then(() => app.quit()).catch(err => {
  console.error(err);
  app.exit(1);
});
