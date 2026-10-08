'use strict';

// (C1532) About + Third-Party Licenses windows.
//
// About TipΔTask — shown from the Help menu on Windows/Linux (which have no
// native About panel; `{ role: 'about' }` is macOS-only) and reachable from
// the macOS app menu's own native About panel via its "Third-Party Licenses"
// button, same as the Help-menu route.
//
// Third-Party Licenses — renders THIRD-PARTY-NOTICES.md (C1531) so the Pi
// Coding Agent MIT attribution (and its 136-package dependency closure) is
// reachable from the UI, not just shipped on disk. See tt-electron-app.md
// § About + Third-Party Licenses windows for the full contract.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { mt } = require('./menu-i18n');

let aboutWindow = null;
let noticesWindow = null;

// (C1531) Two copies ship today — see tt-electron-app.md § Licensing:
//   1. Inside app.asar (package.json build.files) — __dirname-relative, same
//      value in dev (<checkout>/THIRD-PARTY-NOTICES.md) and packaged
//      (app.asar/THIRD-PARTY-NOTICES.md). Readable via fs (Electron's asar
//      read shim) and BrowserWindow.loadFile, but NOT via shell.openPath —
//      the OS file opener cannot see inside a read-only asar archive. This
//      is why the notices render in-window instead of via shell.openPath.
//   2. extraResources plain-file copy at Resources/pi/node_modules/... (real
//      on-disk file, packaged builds only), staged by stage-pi-bundle.js —
//      same resolution precedent as spawn-utils.js's resolvePiLaunch().
//      Kept as a fallback in case (1) is ever excluded from build.files.
function resolveNoticesPath() {
  const inAsar = path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(inAsar)) return inAsar;
  if (process.resourcesPath) {
    const extraRes = path.join(process.resourcesPath, 'pi', 'node_modules', 'THIRD-PARTY-NOTICES.md');
    if (fs.existsSync(extraRes)) return extraRes;
  }
  return null;
}

function createChildWindow({ file, width, height, resizable, title }) {
  const win = new BrowserWindow({
    width,
    height,
    resizable,
    minimizable: true,
    maximizable: resizable,
    fullscreenable: false,
    title,
    // (TPT563) Taskbar-visible on Windows; without an icon its button shows blank.
    ...(process.platform === 'win32' ? { icon: path.join(__dirname, '..', 'assets', 'icon.ico') } : {}),
    backgroundColor: '#f1f1ef', // matches splash.html's --splash-paper
    webPreferences: {
      preload: path.join(__dirname, 'about-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Never let this small window navigate away or spawn a child window — the
  // notices text is full of license/repo URLs, which belong in the real
  // browser, not loaded in place of the notices page itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  // assets/** ships inside app.asar (package.json build.files) and loadFile
  // reads through Electron's asar shim, same precedent as the splash window.
  win.loadFile(path.join(__dirname, '..', 'assets', file));
  return win;
}

function openAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) { aboutWindow.focus(); return; }
  const strings = {
    title: mt('menu.about'),
    versionLabel: mt('about.version'),
    credit: mt('about.credit'),
    licensesButton: mt('menu.thirdPartyLicenses'),
  };
  aboutWindow = createChildWindow({ file: 'about.html', width: 440, height: 440, resizable: false, title: strings.title });
  aboutWindow.on('closed', () => { aboutWindow = null; });
  aboutWindow.webContents.once('did-finish-load', () => {
    aboutWindow.webContents.send('about:data', { appVersion: app.getVersion(), strings });
  });
}

function openNoticesWindow() {
  if (noticesWindow && !noticesWindow.isDestroyed()) { noticesWindow.focus(); return; }
  const strings = { title: mt('menu.thirdPartyLicenses'), notFound: mt('about.noticesNotFound') };
  const noticesPath = resolveNoticesPath();
  if (!noticesPath) {
    dialog.showMessageBox({ type: 'error', title: strings.title, message: strings.notFound });
    return;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(noticesPath, 'utf8');
  } catch (e) {
    console.warn('[about-window] failed reading notices file:', e.message);
  }

  let html = null;
  try {
    // Lazy require — pay marked's module-load cost only when the user
    // actually opens this window (C1173 discipline), not on every app boot.
    const { marked } = require('marked');
    html = marked.parse(raw);
  } catch (e) {
    console.warn('[about-window] marked render failed, falling back to plain text:', e.message);
  }

  noticesWindow = createChildWindow({ file: 'notices.html', width: 760, height: 820, resizable: true, title: strings.title });
  noticesWindow.on('closed', () => { noticesWindow = null; });
  noticesWindow.webContents.once('did-finish-load', () => {
    noticesWindow.webContents.send('about:data', { strings, html, text: html ? null : raw });
  });
}

// Shared by both windows' "Third-Party Licenses" buttons — about.html's and,
// were notices.html ever nested inside it, its own. Registered once here
// rather than in main.js since it's this module's own window that sends it.
ipcMain.on('about:open-licenses', () => openNoticesWindow());

module.exports = { openAboutWindow, openNoticesWindow, resolveNoticesPath };
