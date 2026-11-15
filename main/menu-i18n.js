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
// menus, the three folder-picker dialog titles, the Export save dialog (TPT9167),
// the Import open dialog and its invalid-archive error dialog (TPT9169, main/project-import.js),
// the quit/close confirm dialogs, and the `about.*` strings pushed into the
// About/Third-Party Licenses windows (main/about-window.js, C1532). The startup
// permission dialogs (main/os-permissions.js) speak all four project languages, so
// their `permissions.*` strings live in main/permissions-i18n.js instead.
// NOT covered, by design (documented in tt-electron-app.md, not silently skipped):
//   - Electron's role: menu items (Edit/View/Window roles) — those render from
//     Electron's own OS-locale-driven built-in labels, not from this table.
//   - The startup dialog.showErrorBox('TipΔTask — startup failed', ...) — fires
//     before any project (hence any locale) is known.

const en = {
  // Project access dialog, shared with the native/renderer translation table.
  "projectAccess.title": "Cannot open project",
  "projectAccess.denied": "This project is not available to the current account.",
  "projectAccess.signin": "Sign in again to open this project.",
  "projectAccess.detail": "The project may belong to another account or may no longer exist. Re-authenticate with an account that has access, then TipATask will try opening it again.",
  "projectAccess.retryDetail": "The project was not opened. Please try opening it again.",
  "projectAccess.reauthenticate": "Re-authenticate",
  "projectAccess.cancel": "Cancel",
  "projectAccess.close": "Close",
  "projectAccess.unavailable": "Could not check project access. Check your connection and try again.",
  "projectAccess.signinFailed": "Sign-in did not finish successfully. Please try again.",

  // (TPT9318) Two entries since the Open / Create Project split: Open Project sets up an
  // unconfigured folder in compose mode (no Preset step), Create Project offers A/B/C.
  'menu.openProject': 'Open Project…',
  'menu.createProject': 'Create Project…',
  'menu.recentProjects': 'Recent Projects',
  'menu.noRecentProjects': 'No Recent Projects',
  'menu.closeProject': 'Close Project',
  'menu.renameProject': 'Rename Project…',
  'menu.settings': 'Settings…',
  'menu.mergeTaskBranches': 'Merge task branches…',
  // (TPT9167) Project ▸ Export… — saves the project as a .zip (main/project-export.js).
  'menu.exportProject': 'Export…',
  // (TPT9169) Project ▸ Import… — a new project from an Export archive (main/project-import.js).
  'menu.importProject': 'Import…',
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
  // (TPT480/TPT505) View ▸ Notifications ▸ app-level "Show on Top" checkbox.
  'menu.notifications': 'Notifications',
  'menu.notificationsOnTop': 'Show on Top of Other Apps',

  'about.version': 'Version',
  'about.credit': 'Includes Pi Coding Agent (MIT License)',
  'about.noticesNotFound': 'THIRD-PARTY-NOTICES.md could not be found in this build.',

  'dialog.openProjectDirectory': 'Open Project Directory',
  'dialog.selectProjectDirectory': 'Select Project Directory',
  'dialog.selectOrCreateProjectFolder': 'Select or Create Project Folder',
  'dialog.exportProjectTitle': 'Export Project',
  'dialog.zipArchive': 'ZIP Archive',
  'dialog.importProjectTitle': 'Import Project',
  'dialog.importInvalidMessage': 'This file cannot be imported',
  'dialog.ok': 'OK',
  // (TPT9169) The invalid-archive dialog's reason, one per validateProjectArchive() code
  // (ARCHIVE_ERROR_CODES, src/server/project-archive.js); importError.unknown covers any other.
  'importError.unreadable': 'The file could not be read. Check that it still exists and that TipΔTask can open it.',
  'importError.not_zip': 'The file is not a ZIP archive.',
  'importError.too_large': 'The archive, or a file inside it, is larger than an import allows.',
  'importError.unsafe_path': 'The archive contains a file path that points outside the project folder.',
  'importError.unexpected_entry': 'The archive contains files that a TipΔTask project export never includes.',
  'importError.duplicate_entry': 'The archive contains the same file more than once.',
  'importError.corrupt': 'The archive is damaged or encrypted.',
  'importError.missing_manifest': 'This is not a TipΔTask project export: manifest.json is missing.',
  'importError.invalid_manifest': 'This is not a TipΔTask project export: manifest.json is not valid.',
  'importError.unsupported_version': 'The archive was made by a newer version of TipΔTask. Update TipΔTask, then import it again.',
  'importError.missing_tasks': 'The archive has no tasks.json.',
  'importError.invalid_tasks': "The archive's tasks.json is not valid.",
  'importError.unknown': 'The archive could not be checked.',

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
  // Project access dialog, shared with the native/renderer translation table.
  "projectAccess.title": "Не вдалося відкрити проєкт",
  "projectAccess.denied": "Цей проєкт недоступний для поточного облікового запису.",
  "projectAccess.signin": "Увійдіть знову, щоб відкрити цей проєкт.",
  "projectAccess.detail": "Проєкт може належати іншому обліковому запису або більше не існувати. Повторно автентифікуйтеся через обліковий запис із доступом, і TipATask знову спробує відкрити проєкт.",
  "projectAccess.retryDetail": "Проєкт не відкрито. Спробуйте відкрити його ще раз.",
  "projectAccess.reauthenticate": "Повторна автентифікація",
  "projectAccess.cancel": "Скасувати",
  "projectAccess.close": "Закрити",
  "projectAccess.unavailable": "Не вдалося перевірити доступ до проєкту. Перевірте з’єднання та спробуйте ще раз.",
  "projectAccess.signinFailed": "Не вдалося завершити вхід. Спробуйте ще раз.",

  'menu.openProject': 'Відкрити проєкт…',
  'menu.createProject': 'Створити проєкт…',
  'menu.recentProjects': 'Останні проєкти',
  'menu.noRecentProjects': 'Немає останніх проєктів',
  'menu.closeProject': 'Закрити проєкт',
  'menu.renameProject': 'Перейменувати проєкт…',
  'menu.settings': 'Налаштування…',
  'menu.mergeTaskBranches': 'Злити гілки завдань…',
  'menu.exportProject': 'Експортувати…',
  'menu.importProject': 'Імпортувати…',
  'menu.knowledgeBase': 'База знань',
  'menu.kbSync': 'Синхронізувати',
  'menu.kbReindex': 'Переіндексувати',
  'menu.reauthenticate': 'Повторна автентифікація / Змінити обліковий запис',
  'menu.quit': 'Вийти з TipΔTask',
  'menu.project': 'Проєкт',
  'menu.startStopVoice': 'Почати / Зупинити голосове введення',
  'menu.voiceDiagnostics': 'Діагностика голосового ярлика…',
  'menu.learnMore': 'Дізнатися більше',
  'menu.about': 'Про TipΔTask',
  'menu.thirdPartyLicenses': 'Ліцензії третіх сторін',
  'menu.notifications': 'Сповіщення',
  'menu.notificationsOnTop': 'Показувати поверх інших програм',

  'about.version': 'Версія',
  'about.credit': 'Включає Pi Coding Agent (ліцензія MIT)',
  'about.noticesNotFound': 'Файл THIRD-PARTY-NOTICES.md не знайдено в цій збірці.',

  'dialog.openProjectDirectory': 'Відкрити каталог проєкту',
  'dialog.selectProjectDirectory': 'Виберіть каталог проєкту',
  'dialog.selectOrCreateProjectFolder': 'Виберіть або створіть папку проєкту',
  'dialog.exportProjectTitle': 'Експорт проєкту',
  'dialog.zipArchive': 'ZIP-архів',
  'dialog.importProjectTitle': 'Імпорт проєкту',
  'dialog.importInvalidMessage': 'Цей файл не можна імпортувати',
  'dialog.ok': 'Гаразд',
  'importError.unreadable': 'Не вдалося прочитати файл. Перевірте, що він досі існує і TipΔTask може його відкрити.',
  'importError.not_zip': 'Файл не є ZIP-архівом.',
  'importError.too_large': 'Архів або файл у ньому більший, ніж дозволяє імпорт.',
  'importError.unsafe_path': 'Архів містить шлях до файлу, що веде за межі папки проєкту.',
  'importError.unexpected_entry': 'Архів містить файли, яких експорт проєкту TipΔTask ніколи не додає.',
  'importError.duplicate_entry': 'Архів містить той самий файл кілька разів.',
  'importError.corrupt': 'Архів пошкоджено або зашифровано.',
  'importError.missing_manifest': 'Це не експорт проєкту TipΔTask: бракує manifest.json.',
  'importError.invalid_manifest': 'Це не експорт проєкту TipΔTask: manifest.json недійсний.',
  'importError.unsupported_version': 'Архів створено новішою версією TipΔTask. Оновіть TipΔTask і повторіть імпорт.',
  'importError.missing_tasks': 'В архіві немає tasks.json.',
  'importError.invalid_tasks': 'Файл tasks.json в архіві недійсний.',
  'importError.unknown': 'Не вдалося перевірити архів.',

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
