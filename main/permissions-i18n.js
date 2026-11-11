'use strict';

// Startup OS permission copy (main/os-permissions.js, tt-electron-app.md § Startup OS
// Permissions) in every project language the Task App supports: English, Ukrainian, Simplified
// Chinese and Spanish. The dialogs speak the first startup project's language, which can be any
// of the four, so these strings live apart from main/menu-i18n.js, whose native-menu table covers
// en and uk only. Plain CJS data with no electron import and no I/O at load (C1173).
//
// macOS pane and folder names follow the system's own localization (System Settings →
// Privacy & Security → …), so a reader finds the same words on screen. Product names, the `+`
// button and the {names}/{list} placeholders stay intact in every locale.

const en = {
  // One-time explanation shown before the macOS permission prompts at startup, and the silent
  // probe notification that confirms notification access (closed as soon as shown).
  'permissions.title': 'Permissions',
  'permissions.message': 'TipΔTask needs a few macOS permissions',
  'permissions.detail': 'TipΔTask asks for them now, once, so agents never stop mid-task waiting on a system prompt.\n\n• Notifications: tells you when an agent needs your input or finishes a task.\n• Microphone: voice input in task forms and chats.\n• Folders: Desktop, Documents, Downloads and your project folders, so agents can read and change files there.\n• Screen Recording and Accessibility: computer use, so agents can see the screen and work in apps to check their changes.\n\nmacOS asks about each permission you have not answered yet. Screen Recording and Accessibility are turned on in System Settings, and TipΔTask shows you where. You can change any of them later in System Settings.',
  'permissions.continue': 'Continue',
  'permissions.probeTitle': 'TipΔTask notifications are on',
  'permissions.probeBody': 'This is how TipΔTask tells you an agent needs you.',
  // App Management guidance (ensureStartupAppManagementPermission()).
  'permissions.appManagementMessage': 'Set up App Management for TipΔTask',
  'permissions.appManagementDetail': 'App Management lets agents update or delete other apps on your Mac when a task requires it.\n\nOpen System Settings → Privacy & Security → App Management. Enable TipATask if you want to allow this. If it is missing, use + to add TipATask from Applications. If it is already enabled, no change is needed.\n\nmacOS does not let TipΔTask check or request this permission directly. Opening Settings does not grant access. You can skip this now and use the same Settings path later. If macOS asks you to quit and reopen TipATask, do so after running tasks finish.',
  'permissions.openSettings': 'Open System Settings',
  'permissions.later': 'Later',
  // Computer-use prompt (ensureComputerUsePermissions()): {names} is the missing items' names
  // joined in the dialog's language, {list} one item line per missing item.
  'permissions.computerUseMessage': 'Turn on {names} for TipΔTask',
  'permissions.computerUseDetail': "Computer use lets agents check their changes the way you would: they look at the screen and work in apps.\n\n{list}\n\nTurn on TipATask in each list. If it is missing, use + to add TipATask from Applications. If macOS asks you to quit and reopen TipATask, do so after running tasks finish.\n\nTipΔTask asks again at the next launch while an item is still off. Choose Don't Ask Again to stop asking about the items listed here.",
  'permissions.screenRecording': 'Screen Recording',
  'permissions.screenRecordingItem': '• Screen Recording (System Settings → Privacy & Security → Screen & System Audio Recording): agents take screenshots to see the result of their changes.',
  'permissions.accessibility': 'Accessibility',
  'permissions.accessibilityItem': '• Accessibility (System Settings → Privacy & Security → Accessibility): agents click and type in apps to try their changes.',
  'permissions.dontAskAgain': "Don't Ask Again",
};

const uk = {
  'permissions.title': 'Дозволи',
  'permissions.message': 'TipΔTask потребує кількох дозволів macOS',
  'permissions.detail': 'TipΔTask просить їх зараз, один раз, щоб агенти не зупинялися посеред завдання в очікуванні системного запиту.\n\n• Сповіщення: повідомляють, коли агенту потрібна ваша відповідь або завдання завершено.\n• Мікрофон: голосове введення у формах завдань і чатах.\n• Папки: Робочий стіл, Документи, Завантаження та папки ваших проєктів, щоб агенти могли читати й змінювати там файли.\n• Запис екрана й Доступність: керування комп’ютером, щоб агенти бачили екран і працювали в програмах, перевіряючи свої зміни.\n\nmacOS запитає про кожен дозвіл, на який ви ще не відповіли. Запис екрана й Доступність вмикаються в Системних параметрах, і TipΔTask покаже, де саме. Змінити будь-який із цих дозволів можна пізніше в Системних параметрах.',
  'permissions.continue': 'Продовжити',
  'permissions.probeTitle': 'Сповіщення TipΔTask увімкнено',
  'permissions.probeBody': 'Так TipΔTask повідомлятиме, що агенту потрібна ваша увага.',
  'permissions.appManagementMessage': 'Налаштуйте керування програмами для TipΔTask',
  'permissions.appManagementDetail': 'Дозвіл на керування програмами дає агентам змогу оновлювати або видаляти інші програми на вашому Mac, коли цього потребує завдання.\n\nВідкрийте Системні параметри → Приватність і безпека → Керування програмами. Увімкніть TipATask, якщо хочете це дозволити. Якщо програми немає в списку, додайте TipATask із папки «Програми» кнопкою +. Якщо дозвіл уже ввімкнено, нічого змінювати не потрібно.\n\nmacOS не дозволяє TipΔTask безпосередньо перевірити або запросити цей дозвіл. Відкриття параметрів не надає доступу. Можна пропустити цей крок і пізніше скористатися тим самим шляхом. Якщо macOS попросить закрити й знову відкрити TipATask, зробіть це після завершення запущених завдань.',
  'permissions.openSettings': 'Відкрити Системні параметри',
  'permissions.later': 'Пізніше',
  'permissions.computerUseMessage': 'Увімкніть {names} для TipΔTask',
  'permissions.computerUseDetail': 'Керування комп’ютером дає агентам змогу перевіряти свої зміни так, як це робили б ви: дивитися на екран і працювати в програмах.\n\n{list}\n\nУвімкніть TipATask у кожному списку. Якщо програми немає в списку, додайте TipATask із папки «Програми» кнопкою +. Якщо macOS попросить закрити й знову відкрити TipATask, зробіть це після завершення запущених завдань.\n\nПоки якийсь із цих дозволів вимкнено, TipΔTask запитає знову під час наступного запуску. Виберіть «Більше не питати», щоб припинити запити щодо перелічених тут дозволів.',
  'permissions.screenRecording': 'Запис екрана',
  'permissions.screenRecordingItem': '• Запис екрана (Системні параметри → Приватність і безпека → Записування системного звуку й екрана): агенти роблять знімки екрана, щоб бачити результат своїх змін.',
  'permissions.accessibility': 'Доступність',
  'permissions.accessibilityItem': '• Доступність (Системні параметри → Приватність і безпека → Доступність): агенти клацають і вводять текст у програмах, щоб випробувати свої зміни.',
  'permissions.dontAskAgain': 'Більше не питати',
};

const zh = {
  'permissions.title': '权限',
  'permissions.message': 'TipΔTask 需要几项 macOS 权限',
  'permissions.detail': 'TipΔTask 现在一次性请求这些权限，以免智能体在任务进行中因等待系统提示而停下。\n\n• 通知：在智能体需要您回应或完成任务时提醒您。\n• 麦克风：在任务表单和聊天中使用语音输入。\n• 文件夹：桌面、文稿、下载以及您的项目文件夹，以便智能体在其中读取和修改文件。\n• 录屏和辅助功能：用于电脑操控，让智能体能看到屏幕并在应用中操作，以检查自己的更改。\n\nmacOS 会就您尚未答复的每项权限进行询问。录屏和辅助功能需在系统设置中开启，TipΔTask 会告诉您位置。您之后可以随时在系统设置中更改这些权限。',
  'permissions.continue': '继续',
  'permissions.probeTitle': 'TipΔTask 通知已开启',
  'permissions.probeBody': 'TipΔTask 会通过这种方式告诉您智能体需要您。',
  'permissions.appManagementMessage': '为 TipΔTask 设置 App管理',
  'permissions.appManagementDetail': 'App管理权限允许智能体在任务需要时更新或删除您 Mac 上的其他应用。\n\n打开系统设置 → 隐私与安全性 → App管理。如果您想允许此操作，请启用 TipATask。如果列表中没有它，请使用 + 从“应用程序”文件夹添加 TipATask。如果已经启用，则无需更改。\n\nmacOS 不允许 TipΔTask 直接检查或请求此权限。打开设置并不会授予访问权限。您可以现在跳过，以后按同一路径在设置中操作。如果 macOS 要求您退出并重新打开 TipATask，请在正在运行的任务完成后再操作。',
  'permissions.openSettings': '打开系统设置',
  'permissions.later': '稍后',
  'permissions.computerUseMessage': '为 TipΔTask 开启{names}',
  'permissions.computerUseDetail': '电脑操控让智能体像您一样检查自己的更改：查看屏幕并在应用中操作。\n\n{list}\n\n请在每个列表中开启 TipATask。如果列表中没有它，请使用 + 从“应用程序”文件夹添加 TipATask。如果 macOS 要求您退出并重新打开 TipATask，请在正在运行的任务完成后再操作。\n\n只要仍有权限未开启，TipΔTask 会在下次启动时再次询问。选择“不再询问”即可不再询问此处列出的权限。',
  'permissions.screenRecording': '录屏',
  'permissions.screenRecordingItem': '• 录屏（系统设置 → 隐私与安全性 → 录屏与系统录音）：智能体截取屏幕，查看更改的效果。',
  'permissions.accessibility': '辅助功能',
  'permissions.accessibilityItem': '• 辅助功能（系统设置 → 隐私与安全性 → 辅助功能）：智能体在应用中点按和输入，以试用自己的更改。',
  'permissions.dontAskAgain': '不再询问',
};

const es = {
  'permissions.title': 'Permisos',
  'permissions.message': 'TipΔTask necesita algunos permisos de macOS',
  'permissions.detail': 'TipΔTask los solicita ahora, una sola vez, para que los agentes no se detengan a mitad de una tarea esperando un aviso del sistema.\n\n• Notificaciones: le avisan cuando un agente necesita su respuesta o termina una tarea.\n• Micrófono: entrada de voz en los formularios de tareas y en los chats.\n• Carpetas: Escritorio, Documentos, Descargas y las carpetas de sus proyectos, para que los agentes puedan leer y modificar archivos en ellas.\n• Grabación de pantalla y Accesibilidad: control del ordenador, para que los agentes vean la pantalla y trabajen en las aplicaciones al comprobar sus cambios.\n\nmacOS le preguntará por cada permiso que aún no haya respondido. La grabación de pantalla y la accesibilidad se activan en Ajustes del Sistema, y TipΔTask le indica dónde. Puede cambiar cualquiera de ellos más tarde en Ajustes del Sistema.',
  'permissions.continue': 'Continuar',
  'permissions.probeTitle': 'Las notificaciones de TipΔTask están activadas',
  'permissions.probeBody': 'Así le avisará TipΔTask cuando un agente necesite su atención.',
  'permissions.appManagementMessage': 'Configure Gestión de las apps para TipΔTask',
  'permissions.appManagementDetail': 'Gestión de las apps permite que los agentes actualicen o eliminen otras aplicaciones de su Mac cuando una tarea lo requiera.\n\nAbra Ajustes del Sistema → Privacidad y seguridad → Gestión de las apps. Active TipATask si quiere permitirlo. Si no aparece, use + para añadir TipATask desde Aplicaciones. Si ya está activado, no es necesario cambiar nada.\n\nmacOS no permite que TipΔTask compruebe ni solicite este permiso directamente. Abrir Ajustes no concede el acceso. Puede omitir este paso ahora y usar la misma ruta de Ajustes más tarde. Si macOS le pide salir de TipATask y volver a abrirla, hágalo cuando terminen las tareas en curso.',
  'permissions.openSettings': 'Abrir Ajustes del Sistema',
  'permissions.later': 'Más tarde',
  'permissions.computerUseMessage': 'Active {names} para TipΔTask',
  'permissions.computerUseDetail': 'El control del ordenador permite que los agentes comprueben sus cambios como lo haría usted: miran la pantalla y trabajan en las aplicaciones.\n\n{list}\n\nActive TipATask en cada lista. Si no aparece, use + para añadir TipATask desde Aplicaciones. Si macOS le pide salir de TipATask y volver a abrirla, hágalo cuando terminen las tareas en curso.\n\nMientras algún permiso siga desactivado, TipΔTask volverá a preguntar en el próximo inicio. Elija «No volver a preguntar» para dejar de recibir avisos sobre los permisos de esta lista.',
  'permissions.screenRecording': 'Grabación de pantalla',
  'permissions.screenRecordingItem': '• Grabación de pantalla (Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla y del audio del sistema): los agentes hacen capturas de pantalla para ver el resultado de sus cambios.',
  'permissions.accessibility': 'Accesibilidad',
  'permissions.accessibilityItem': '• Accesibilidad (Ajustes del Sistema → Privacidad y seguridad → Accesibilidad): los agentes hacen clic y escriben en las aplicaciones para probar sus cambios.',
  'permissions.dontAskAgain': 'No volver a preguntar',
};

const LOCALES = { en, uk, zh, es };

// A supported locale code as given, anything else (unknown, empty, not a string) English.
function normalizeLocale(locale) {
  return typeof locale === 'string' && Object.hasOwn(LOCALES, locale) ? locale : 'en';
}

// The locale's table, English filling any key it lacks.
function permissionStrings(locale) {
  return { ...en, ...LOCALES[normalizeLocale(locale)] };
}

module.exports = { LOCALES, normalizeLocale, permissionStrings };
