'use strict';

// (TPT9002) Server-side string table for the text the Task App server itself writes into a task
// terminal: the grey/yellow `[Task App] …` notices (terminal-session.js emitTerminalNotice() /
// emitTerminalWarning(), process-group.js's watchdog texts, index.js's completion gate) and the
// watchdog exit `reasonText`. These lines go straight into the PTY stream as `data` frames — the
// kill/pause/resume ones also into `session.buffer`, the replay every reattach gets — so the
// server localizes them at emit time from the project's `.tipatask/config.json` `language`
// (terminal-session.js sessionLocale()); the client cannot translate raw PTY bytes.
//
// Separate from src/client/i18n.js on purpose (that is an ES module for the browser bundle); this
// is a plain CJS module with no requires, the same flat dot-key + `{param}` shape. `en` is the
// exact wording the server always printed (tests assert it), `uk` follows the client table's
// glossary (задача, сесія, проєкт, сторож). The `[Task App]` prefix, ANSI colours and the
// joining spaces stay in code. Server log lines and the exit resolution comment keep English:
// the builders that produce them are called with no locale.

const en = {
  // ── terminal-session.js notices ──
  'notice.approval.stalledRetrying': '{label} approval looks stalled (no real activity yet) — retrying once.',
  'notice.approval.stalledAfterRetry': '{label} approval still looks stalled after a retry (no real activity — the model may keep returning an empty or malformed reply). Check the model configured for this project.',
  'notice.plan.alreadyApproved': 'Plan is already approved.',
  'notice.plan.approved': 'Plan approved. Continuing in execution mode.',
  'notice.plan.approvedInTui': 'Plan approved inside the agent — continuing in execution mode.',
  'notice.nudge.commit': 'Task is still in progress without its required commit — nudging the agent to commit and complete ({count}).',
  'notice.nudge.complete': 'Task is still in progress though its completion check passes — nudging the agent to complete ({count}).',
  'notice.token.refreshed': 'API token refreshed — valid until {until}.',
  'notice.token.expiresNotRefreshed': 'API token expires at {when} and could not be refreshed ({error}). Task tools stop then.',
  'notice.token.headExpired': 'The API token this session started with expired at {when}.',
  'notice.token.headExpires': 'The API token this session started with expires at {when}.',
  'notice.token.savedReconnect': '{head} A fresh token is saved — in the agent type /mcp → tipatask → Reconnect (restart the session if MCP still answers 401).',
  'notice.token.savedRestart': '{head} A fresh token is saved, but this agent only reads it at launch — task tools stop at {when}, so restart the session to pick it up. Until then the agent can fall back to REST (see CLAUDE.md, MCP 401 fallback).',
  'notice.token.notSaved': '{head} It could not be refreshed automatically. Sign in again (Project ▸ Re-authenticate / Change Account), then in the agent type /mcp → tipatask → Reconnect.',
  // (TPT9008) The `{error}` of notice.token.expiresNotRefreshed — token-refresh.js's sentences by refreshCode.
  'notice.token.refreshError.request_failed': 'token refresh request failed',
  'notice.token.refreshError.request_failed_cause': 'token refresh request failed ({cause})',
  'notice.token.refreshError.request_timeout': 'token refresh request failed (timeout)',
  'notice.token.refreshError.rejected': 'token refresh rejected (HTTP {status})',
  'notice.token.refreshError.unreadable_response': 'token refresh returned an unreadable response',
  'notice.token.refreshError.no_usable_token': 'token refresh returned no usable token',
  'notice.token.refreshError.scope_changed': 'token refresh changed account or scope — sign in again',
  'notice.token.refreshError.project_scope': 'Stored token is scoped to another project — sign in again to obtain an account token.',
  'notice.token.refreshError.not_newer': 'refresh returned no newer token',
  'notice.token.refreshError.missing_input': 'token refresh needs projectRoot, baseUrl, token and projectId',
  'notice.token.refreshError.fetch_unavailable': 'fetch is unavailable',
  'notice.submit.notReachedRestart': 'The task prompt did not reach the composer — restart the task.',
  'notice.submit.notReachedRepaste': 'The task prompt did not reach the composer — pasting it again.',
  'notice.submit.typedPressEnter': 'The task prompt is typed but was not submitted — press Enter to start it.',
  'notice.submit.typedRetryEnter': 'The task prompt was typed but not submitted — pressing Enter again.',
  'notice.inject.mcpAutoApproved': 'Auto-approved project MCP servers.',
  'notice.inject.firstRunWaiting': 'Claude Code first-run setup is waiting for your input. Answer the prompts above — the task prompt will be sent automatically once setup finishes.',
  'notice.inject.firstRunStillWaiting': 'Still waiting on Claude Code first-run setup.',
  'notice.inject.firstRunNotFinished': 'Claude Code first-run setup did not finish — the task prompt was NOT sent. Finish setup, then restart the task.',
  'notice.inject.questionWaiting': 'A question is waiting above — the task prompt will be sent once you answer it.',
  'notice.inject.questionNotSent': 'A question is waiting above — the task prompt was NOT sent. Answer it, then restart the task.',
  'notice.inject.mcpTrustWaiting': 'Waiting for MCP server trust approval before sending task prompt.',
  'notice.inject.designRunning': '/design running — the task prompt will be sent once it finishes.',
  'notice.inject.designDialogNotSent': '/design is still waiting on a dialog above — the task prompt was NOT sent. Answer it, then restart the task.',
  'notice.inject.designTooLong': '/design is taking unusually long — sending the task prompt now.',
  'notice.inject.designStillRunning': '/design is still running — the task prompt will be sent once it finishes.',
  'notice.planning.command': 'Planning mode. Review the plan, then type {command} and press Enter to continue.',
  'notice.planning.dialog': 'Planning mode. Review the plan, then use the approval dialog to continue.',
  'notice.paste.imageNotAttached': 'Image paste did not attach — the CLI may not support this on the installed version, or the paste was interrupted.',
  // ── index.js completion gate ──
  'notice.completion.blocked': 'Completion verification blocked: {reason}. Recheck live VCS settings and use tipatask-local complete_task after required merges and checks.',
  // ── process-group.js / terminal-session.js watchdog texts ──
  'watchdog.reason.count-growth': 'sustained process-count growth',
  'watchdog.reason.count-ceiling': 'process emergency ceiling reached',
  'watchdog.reason.memory-growth': 'sustained high RSS and memory growth',
  'watchdog.reason.memory-pressure': 'sustained high RSS, host memory pressure, and growth in this tree',
  'watchdog.reason.count': 'descendant warning threshold reached',
  'watchdog.reason.memory': 'RSS warning threshold reached',
  'watchdog.reason.default': 'resource watchdog intervention',
  'watchdog.tree': '{count} descendant processes',
  'watchdog.treeRss': '{count} descendant processes using {rssMb} MiB',
  'watchdog.policy.count': 'after {consecutive} consecutive checks ≥{threshold} each growing by ≥{growth}, or immediately at ≥{ceiling}',
  'watchdog.policy.countMemory': 'after {consecutive} consecutive checks ≥{threshold} each growing by ≥{growth}, or immediately at ≥{ceiling} processes, or once RSS stays >{rssActionMb} MiB for {rssSamples} 30-second samples and grows by ≥{rssGrowthMb} MiB in each of two intervals (≥{rssPressureGrowthMb} MiB with sustained host memory pressure)',
  'watchdog.killPolicy': 'kill {policy}',
  'watchdog.summaryOther': '{n} other',
  'watchdog.topProcesses': 'Top processes: {summary}.',
  'watchdog.warn.headMemory': 'This session\'s process tree uses {rssMb} MiB; RSS warning threshold {limitMb} MiB ({count} descendant processes)',
  'watchdog.warn.headCount': '{tree} under this session',
  'watchdog.warn.base': '{head} — {reason}; the session keeps running.',
  'watchdog.warn.loadOne': '{n} session active.',
  'watchdog.warn.loadMany': '{n} sessions active.',
  'watchdog.warn.advisory': 'Advisory concurrency budgets: {descendants} descendants, {rssMb} MiB; these do not trigger intervention.',
  'watchdog.warn.nextKill': 'Automatic termination enabled (kill {policy}).',
  'watchdog.warn.nextPause': 'The watchdog will pause it — nothing is killed and it can be resumed — {policy}.',
  'watchdog.warn.nextWarn': 'The watchdog only warns: automatic pause and termination are disabled.',
  'watchdog.killed': 'Watchdog killed this session: {reason}; {tree} (kill {policy}).',
  'watchdog.paused': 'Watchdog paused this session: {reason}; {tree} (warn ≥{threshold}; pause {policy}). Nothing was killed — every process is stopped and keeps its state. Resume the session to continue, or terminate it to free its memory.',
  'watchdog.resumed': 'Session resumed. The watchdog pauses it again only if it keeps growing.',
};

const uk = {
  'notice.approval.stalledRetrying': 'Схвалення в {label} виглядає завислим (реальної активності ще немає) — повторна спроба.',
  'notice.approval.stalledAfterRetry': 'Схвалення в {label} і після повторної спроби виглядає завислим (реальної активності немає — модель може повертати порожню або некоректну відповідь). Перевірте модель, налаштовану для цього проєкту.',
  'notice.plan.alreadyApproved': 'План уже схвалено.',
  'notice.plan.approved': 'План схвалено. Продовжуємо в режимі виконання.',
  'notice.plan.approvedInTui': 'План схвалено всередині агента — продовжуємо в режимі виконання.',
  'notice.nudge.commit': 'Задача досі в роботі без обов’язкового коміту — нагадуємо агенту закомітити й завершити ({count}).',
  'notice.nudge.complete': 'Задача досі в роботі, хоча перевірка завершення проходить — нагадуємо агенту завершити її ({count}).',
  'notice.token.refreshed': 'API-токен оновлено — дійсний до {until}.',
  'notice.token.expiresNotRefreshed': 'Термін дії API-токена спливає ({when}), і оновити його не вдалося ({error}). Після цього інструменти задач перестануть працювати.',
  'notice.token.headExpired': 'Термін дії API-токена, з яким запущено цю сесію, минув ({when}).',
  'notice.token.headExpires': 'Термін дії API-токена, з яким запущено цю сесію, спливає ({when}).',
  'notice.token.savedReconnect': '{head} Новий токен збережено — в агенті введіть /mcp → tipatask → Reconnect (перезапустіть сесію, якщо MCP і далі відповідає 401).',
  'notice.token.savedRestart': '{head} Новий токен збережено, але цей агент читає його лише під час запуску — інструменти задач зупиняться ({when}), тож перезапустіть сесію, щоб підхопити його. До того агент може перейти на REST (див. CLAUDE.md, MCP 401 fallback).',
  'notice.token.notSaved': '{head} Автоматично оновити його не вдалося. Увійдіть знову (Проєкт ▸ Повторна автентифікація / Змінити акаунт), а потім в агенті введіть /mcp → tipatask → Reconnect.',
  'notice.token.refreshError.request_failed': 'запит на оновлення токена не вдався',
  'notice.token.refreshError.request_failed_cause': 'запит на оновлення токена не вдався ({cause})',
  'notice.token.refreshError.request_timeout': 'запит на оновлення токена не вдався (час очікування вичерпано)',
  'notice.token.refreshError.rejected': 'сервер відхилив оновлення токена (HTTP {status})',
  'notice.token.refreshError.unreadable_response': 'оновлення токена повернуло нечитабельну відповідь',
  'notice.token.refreshError.no_usable_token': 'оновлення токена не повернуло придатного токена',
  'notice.token.refreshError.scope_changed': 'оновлення токена змінило акаунт або область доступу — увійдіть знову',
  'notice.token.refreshError.project_scope': 'Збережений токен обмежено іншим проєктом — увійдіть знову, щоб отримати токен акаунта.',
  'notice.token.refreshError.not_newer': 'оновлення не повернуло новішого токена',
  'notice.token.refreshError.missing_input': 'для оновлення токена потрібні projectRoot, baseUrl, token і projectId',
  'notice.token.refreshError.fetch_unavailable': 'fetch недоступний',
  'notice.submit.notReachedRestart': 'Промпт задачі не потрапив у поле вводу — перезапустіть задачу.',
  'notice.submit.notReachedRepaste': 'Промпт задачі не потрапив у поле вводу — вставляємо його ще раз.',
  'notice.submit.typedPressEnter': 'Промпт задачі набрано, але не надіслано — натисніть Enter, щоб почати.',
  'notice.submit.typedRetryEnter': 'Промпт задачі набрано, але не надіслано — натискаємо Enter ще раз.',
  'notice.inject.mcpAutoApproved': 'MCP-сервери проєкту схвалено автоматично.',
  'notice.inject.firstRunWaiting': 'Початкове налаштування Claude Code чекає на ваш ввід. Дайте відповіді на запити вище — промпт задачі буде надіслано автоматично після завершення налаштування.',
  'notice.inject.firstRunStillWaiting': 'Досі очікуємо завершення початкового налаштування Claude Code.',
  'notice.inject.firstRunNotFinished': 'Початкове налаштування Claude Code не завершилося — промпт задачі НЕ надіслано. Завершіть налаштування, а потім перезапустіть задачу.',
  'notice.inject.questionWaiting': 'Вище очікує запитання — промпт задачі буде надіслано після вашої відповіді.',
  'notice.inject.questionNotSent': 'Вище очікує запитання — промпт задачі НЕ надіслано. Дайте відповідь, а потім перезапустіть задачу.',
  'notice.inject.mcpTrustWaiting': 'Очікуємо підтвердження довіри до MCP-серверів перед надсиланням промпту задачі.',
  'notice.inject.designRunning': '/design виконується — промпт задачі буде надіслано після його завершення.',
  'notice.inject.designDialogNotSent': '/design досі чекає на діалог вище — промпт задачі НЕ надіслано. Дайте відповідь, а потім перезапустіть задачу.',
  'notice.inject.designTooLong': '/design триває незвично довго — надсилаємо промпт задачі зараз.',
  'notice.inject.designStillRunning': '/design ще виконується — промпт задачі буде надіслано після його завершення.',
  'notice.planning.command': 'Режим планування. Перегляньте план, потім введіть {command} і натисніть Enter, щоб продовжити.',
  'notice.planning.dialog': 'Режим планування. Перегляньте план, потім скористайтеся діалогом схвалення, щоб продовжити.',
  'notice.paste.imageNotAttached': 'Вставлене зображення не прикріпилося — встановлена версія CLI може цього не підтримувати, або вставлення було перервано.',
  'notice.completion.blocked': 'Перевірку завершення заблоковано: {reason}. Перевірте актуальні налаштування VCS і скористайтеся tipatask-local complete_task після потрібних злиттів і перевірок.',
  'watchdog.reason.count-growth': 'тривале зростання кількості процесів',
  'watchdog.reason.count-ceiling': 'досягнуто аварійної межі кількості процесів',
  'watchdog.reason.memory-growth': 'тривале високе RSS і зростання пам’яті',
  'watchdog.reason.memory-pressure': 'тривале високе RSS, тиск на пам’ять системи та зростання цього дерева',
  'watchdog.reason.count': 'досягнуто порогу попередження за кількістю дочірніх процесів',
  'watchdog.reason.memory': 'досягнуто порогу попередження RSS',
  'watchdog.reason.default': 'втручання сторожа ресурсів',
  'watchdog.tree': 'дочірніх процесів: {count}',
  'watchdog.treeRss': 'дочірніх процесів: {count}, використовують {rssMb} МіБ',
  'watchdog.policy.count': 'після {consecutive} поспіль перевірок із ≥{threshold}, кожна зі зростанням на ≥{growth}, або одразу при ≥{ceiling}',
  'watchdog.policy.countMemory': 'після {consecutive} поспіль перевірок із ≥{threshold}, кожна зі зростанням на ≥{growth}, або одразу при ≥{ceiling} процесах, або коли RSS тримається >{rssActionMb} МіБ протягом {rssSamples} 30-секундних вимірів і зростає на ≥{rssGrowthMb} МіБ у кожному з двох інтервалів (≥{rssPressureGrowthMb} МіБ за тривалого тиску на пам’ять системи)',
  'watchdog.killPolicy': 'завершення {policy}',
  'watchdog.summaryOther': 'інших: {n}',
  'watchdog.topProcesses': 'Найбільше процесів: {summary}.',
  'watchdog.warn.headMemory': 'Дерево процесів цієї сесії використовує {rssMb} МіБ; поріг попередження RSS {limitMb} МіБ (дочірніх процесів: {count})',
  'watchdog.warn.headCount': '{tree} у цій сесії',
  'watchdog.warn.base': '{head} — {reason}; сесія продовжує працювати.',
  'watchdog.warn.loadOne': 'Активних сесій: {n}.',
  'watchdog.warn.loadMany': 'Активних сесій: {n}.',
  'watchdog.warn.advisory': 'Рекомендовані бюджети паралельності: {descendants} дочірніх процесів, {rssMb} МіБ; вони не спричиняють втручання.',
  'watchdog.warn.nextKill': 'Автоматичне завершення ввімкнено (завершення {policy}).',
  'watchdog.warn.nextPause': 'Сторож призупинить її — нічого не завершується, і сесію можна відновити — {policy}.',
  'watchdog.warn.nextWarn': 'Сторож лише попереджає: автоматичне призупинення й завершення вимкнено.',
  'watchdog.killed': 'Сторож завершив цю сесію: {reason}; {tree} (завершення {policy}).',
  'watchdog.paused': 'Сторож призупинив цю сесію: {reason}; {tree} (попередження ≥{threshold}; призупинення {policy}). Нічого не завершено — усі процеси зупинено, їхній стан збережено. Відновіть сесію, щоб продовжити, або завершіть її, щоб звільнити пам’ять.',
  'watchdog.resumed': 'Сесію відновлено. Сторож призупинить її знову, лише якщо вона продовжить зростати.',
};

const LOCALES = { en, uk };

// Unknown or missing language → 'en' (same rule as the client's setLocale()).
function normalizeLocale(lang) {
  return typeof lang === 'string' && Object.hasOwn(LOCALES, lang) ? lang : 'en';
}

// Every `{name}` occurrence is replaced; an absent param leaves its placeholder, as in i18n.js.
function interpolate(str, params) {
  if (!params) return str;
  let out = str;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

// Locale table → en → the bare key, then `{param}` substitution.
function terminalCopy(locale, key, params) {
  const table = LOCALES[normalizeLocale(locale)];
  return interpolate(table[key] ?? en[key] ?? key, params);
}

// (TPT9008) A token refresh failure (auth-guard.js `detail`: refreshCode, refreshParams,
// refreshError) in the session's language. An uncoded failure, a code this table does not know,
// or one missing a param its English template names keeps token-refresh.js's English sentence.
function refreshErrorCopy(locale, detail) {
  const code = detail && typeof detail.refreshCode === 'string' ? detail.refreshCode : '';
  const key = `notice.token.refreshError.${code}`;
  const params = detail && detail.refreshParams && typeof detail.refreshParams === 'object' ? detail.refreshParams : {};
  const complete = code && Object.hasOwn(en, key)
    && [...en[key].matchAll(/\{(\w+)\}/g)].every((m) => params[m[1]] != null);
  if (complete) return terminalCopy(locale, key, params);
  return (detail && detail.refreshError) || '';
}

module.exports = { LOCALES, normalizeLocale, terminalCopy, refreshErrorCopy };
