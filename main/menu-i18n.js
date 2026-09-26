'use strict';

// (C1388) Main-process string table for the native Electron menu + the folder-picker/
// confirm dialogs main.js owns. Separate from src/client/i18n.js on purpose: the
// renderer's i18n module can't be required here (it's an ES module meant for the
// browser bundle, and locale there is read from DOM/window state that doesn't exist
// in main). This is a plain CJS module with no electron import — pure data + two
// getter/setter functions, safe to require at module scope (see main.js's C1173
// module-load-cost comment: this file does zero I/O).
//
// Coverage: every explicit label in createMenu()'s Project/Edit/View/Window/Help
// menus, the three folder-picker dialog titles, the quit/close confirm dialogs,
// and the `about.*` strings pushed into the About/Third-Party Licenses windows
// (main/about-window.js, C1532).
// NOT covered, by design (documented in tt-electron-app.md, not silently skipped):
//   - Electron's role: menu items (Edit/View/Window roles) — those render from
//     Electron's own OS-locale-driven built-in labels, not from this table.
//   - The startup dialog.showErrorBox('TipΔTask — startup failed', ...) — fires
//     before any project (hence any locale) is known.

const en = {
  'menu.openOrCreateProject': 'Open / Create Project…',
  'menu.recentProjects': 'Recent Projects',
  'menu.noRecentProjects': 'No Recent Projects',
  'menu.closeProject': 'Close Project',
  'menu.renameProject': 'Rename Project…',
  'menu.settings': 'Settings…',
  'menu.mergeTaskBranches': 'Merge task branches…',
  'menu.knowledgeBase': 'Knowledge Base',
  'menu.kbSync': 'Sync',
  'menu.kbReindex': 'Re-Index',
  'menu.reauthenticate': 'Re-authenticate / Change Account',
  'menu.quit': 'Quit TipΔTask',
  'menu.project': 'Project',
  'menu.startStopVoice': 'Start / Stop Voice Input',
  'menu.voiceDiagnostics': 'Voice Shortcut Diagnostics…',
  'menu.learnMore': 'Learn More',
  'menu.about': 'About TipΔTask',
  'menu.thirdPartyLicenses': 'Third-Party Licenses',

  'about.version': 'Version',
  'about.credit': 'Includes Pi Coding Agent (MIT License)',
  'about.noticesNotFound': 'THIRD-PARTY-NOTICES.md could not be found in this build.',

  'dialog.openProjectDirectory': 'Open Project Directory',
  'dialog.selectProjectDirectory': 'Select Project Directory',
  'dialog.selectOrCreateProjectFolder': 'Select or Create Project Folder',

  'confirm.quitTitle': 'Quit TipΔTask',
  'confirm.quitMessage': 'Are you sure you want to quit?',
  'confirm.quitDetail': 'Active agent and terminal sessions will be terminated.',
  'confirm.quitButtons': ['Quit', 'Cancel'],
  'confirm.closeProjectTitle': 'Close Project',
  'confirm.closeProjectMessage': 'Close this project window?',
  'confirm.closeProjectButtons': ['Close', 'Cancel'],
  'confirm.closeProjectDetailSessions': '{n} agent session(s) will be terminated.',
};

const uk = {
  'menu.openOrCreateProject': 'Відкрити / Створити проєкт…',
  'menu.recentProjects': 'Останні проєкти',
  'menu.noRecentProjects': 'Немає останніх проєктів',
  'menu.closeProject': 'Закрити проєкт',
  'menu.renameProject': 'Перейменувати проєкт…',
  'menu.settings': 'Налаштування…',
  'menu.mergeTaskBranches': 'Злити гілки задач…',
  'menu.knowledgeBase': 'База знань',
  'menu.kbSync': 'Синхронізувати',
  'menu.kbReindex': 'Переіндексувати',
  'menu.reauthenticate': 'Повторна автентифікація / Змінити акаунт',
  'menu.quit': 'Вийти з TipΔTask',
  'menu.project': 'Проєкт',
  'menu.startStopVoice': 'Почати / Зупинити голосове введення',
  'menu.voiceDiagnostics': 'Діагностика голосового ярлика…',
  'menu.learnMore': 'Дізнатися більше',
  'menu.about': 'Про TipΔTask',
  'menu.thirdPartyLicenses': 'Ліцензії третіх сторін',

  'about.version': 'Версія',
  'about.credit': 'Включає Pi Coding Agent (ліцензія MIT)',
  'about.noticesNotFound': 'Файл THIRD-PARTY-NOTICES.md не знайдено в цій збірці.',

  'dialog.openProjectDirectory': 'Відкрити каталог проєкту',
  'dialog.selectProjectDirectory': 'Виберіть каталог проєкту',
  'dialog.selectOrCreateProjectFolder': 'Виберіть або створіть папку проєкту',

  'confirm.quitTitle': 'Вийти з TipΔTask',
  'confirm.quitMessage': 'Ви впевнені, що хочете вийти?',
  'confirm.quitDetail': 'Активні сесії агентів і термінала буде завершено.',
  'confirm.quitButtons': ['Вийти', 'Скасувати'],
  'confirm.closeProjectTitle': 'Закрити проєкт',
  'confirm.closeProjectMessage': 'Закрити це вікно проєкту?',
  'confirm.closeProjectButtons': ['Закрити', 'Скасувати'],
  'confirm.closeProjectDetailSessions': 'Активні сесії агента ({n}) буде завершено.',
};

const LOCALES = { en, uk };
let current = 'en';

function setMenuLocale(lang) {
  current = LOCALES[lang] ? lang : 'en';
}

function getMenuLocale() {
  return current;
}

// mt() mirrors src/client/i18n.js's t() fallback chain (current locale -> en -> key
// itself) but has no interpolation — nothing in this table needs {param} substitution.
function mt(key) {
  const table = LOCALES[current];
  return (table && table[key]) ?? en[key] ?? key;
}

module.exports = { LOCALES, setMenuLocale, getMenuLocale, mt };
