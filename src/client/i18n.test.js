import assert from 'node:assert/strict';
import { test } from 'node:test';

const { LOCALES } = await import('./i18n.js');

// (C1202) Cheap parity guard — this project's convention (CLAUDE.md: "i18n: FE + BE for
// user-visible strings") is every en key gets a uk translation, but nothing enforced that
// mechanically before this. Catches the whole class of "added en.voice.foo, forgot uk.voice.foo"
// mistakes, which is exactly how this task's own new voice.* keys could have silently drifted.
//
// One-directional on purpose (en subset-of locale, not set-equality): pluralForm() in this file
// gives Ukrainian three CLDR categories (one/few/many) but English only two (one/many) — uk
// legitimately defines `*.few` keys en never needs (tc()'s own header comment: "missing form
// falls back to .many"). Flagging those as "extra" would be a false positive on correct,
// intentional asymmetry, not a real translation gap.
test('every locale defines at least every key en defines', () => {
  const enKeys = new Set(Object.keys(LOCALES.en));
  for (const [locale, table] of Object.entries(LOCALES)) {
    if (locale === 'en') continue;
    const localeKeys = new Set(Object.keys(table));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    assert.deepEqual(missing, [], `${locale} is missing keys present in en`);
  }
});

// (C1262) Key-presence parity above says nothing about a key's PLACEHOLDERS surviving
// translation — a uk string that dropped `{shortcut}` would pass the test above yet ship a mic
// tooltip/aria-label with no combo in it, exactly the regression this task exists to prevent.
// audio-recorder.js has no DOM test harness (see tt-audio-input.md), so this is the only
// mechanical guard on voice.record/voice.stop keeping their interpolation param.
test('voice.record and voice.stop keep the {shortcut} placeholder in every locale', () => {
  for (const key of ['voice.record', 'voice.stop']) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.includes('{shortcut}'), `${locale}.${key} must contain {shortcut}`);
    }
  }
});

// (C1436) btn.subtasksCount feeds the objective card's "Subtasks N/M" label from
// childrenCount/completedChildrenCount — a translation that dropped either placeholder
// would silently ship a label with no numbers in it.
test('btn.subtasksCount keeps {done} and {total} placeholders in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    const str = table['btn.subtasksCount'];
    assert.ok(str?.includes('{done}'), `${locale}.btn.subtasksCount must contain {done}`);
    assert.ok(str?.includes('{total}'), `${locale}.btn.subtasksCount must contain {total}`);
  }
});

// (C1392) board.taskOpenFailedBrowser feeds taskOpenErrorLabel() (utils.js) with both
// {id} and {url} — a translation that dropped either would silently ship a Retry banner
// that doesn't name the failed task or the recovery URL.
test('board.taskOpenFailedBrowser keeps {id} and {url} placeholders in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    const str = table['board.taskOpenFailedBrowser'];
    assert.ok(str?.includes('{id}'), `${locale}.board.taskOpenFailedBrowser must contain {id}`);
    assert.ok(str?.includes('{url}'), `${locale}.board.taskOpenFailedBrowser must contain {url}`);
  }
});

// (C1458) nav.confirmTerminateSession feeds console-modal.js's requestSessionClose() with
// the task id/title — a translation that dropped {key} would silently ship a confirm dialog
// that doesn't say which session it's about to kill.
test('nav.confirmTerminateSession keeps the {key} placeholder in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['nav.confirmTerminateSession']?.includes('{key}'), `${locale}.nav.confirmTerminateSession must contain {key}`);
  }
});

// (C1463) nav.confirmCloseObjectiveTab feeds the objective tab's close confirm dialog with
// the objective's task key — a translation that dropped {key} would silently ship a confirm
// dialog that doesn't say which objective's sessions it's about to terminate.
test('nav.confirmCloseObjectiveTab keeps the {key} placeholder in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['nav.confirmCloseObjectiveTab']?.includes('{key}'), `${locale}.nav.confirmCloseObjectiveTab must contain {key}`);
  }
});

// (C1463) nav.objectiveTabClose feeds the objective tab's close-button tooltip with the
// objective's task key — a translation that dropped {key} would silently ship a tooltip
// that doesn't say which tab it closes.
test('nav.objectiveTabClose keeps the {key} placeholder in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['nav.objectiveTabClose']?.includes('{key}'), `${locale}.nav.objectiveTabClose must contain {key}`);
  }
});

// (C1458) chat-task-preview.js builds one line per dependency conflict from this key —
// a translation that dropped any of these four would silently ship a conflict dialog
// missing the task id, its step, the blocking dependency, or the step to raise it to.
test('chat.pinnedStepConflictLine keeps all four placeholders in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    const str = table['chat.pinnedStepConflictLine'];
    for (const ph of ['{taskId}', '{taskStep}', '{depId}', '{depStep}', '{next}']) {
      assert.ok(str?.includes(ph), `${locale}.chat.pinnedStepConflictLine must contain ${ph}`);
    }
  }
});

// (TPT20) chat.confirmCloseTabUnsaved feeds the objective tab-close confirm dialog with the
// live-card count and the tab's own title — a translation that dropped either placeholder
// would silently ship a discard warning that doesn't say how much is about to be lost or
// which tab it's about to lose. Only checks forms a locale actually defines (en has no .few).
test('chat.confirmCloseTabUnsaved keeps {n} and {title} placeholders in every present plural form', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const form of ['one', 'few', 'many']) {
      const str = table[`chat.confirmCloseTabUnsaved.${form}`];
      if (str === undefined) continue;
      assert.ok(str.includes('{n}'), `${locale}.chat.confirmCloseTabUnsaved.${form} must contain {n}`);
      assert.ok(str.includes('{title}'), `${locale}.chat.confirmCloseTabUnsaved.${form} must contain {title}`);
    }
  }
});

// (TPT310) agentQuotaSidebar.updatedAt feeds the left-nav plan-usage block's "Updated HH:MM" line,
// and (TPT689) agentQuotaSidebar.staleAt leads a stale bar's tooltip with the reading's time — a
// translation that dropped {time} would ship either line with no timestamp. The block's other
// strings are plain labels, covered by the en-subset parity check above.
test('agentQuotaSidebar.updatedAt and staleAt keep the {time} placeholder in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['agentQuotaSidebar.updatedAt', 'agentQuotaSidebar.staleAt']) {
      assert.ok(table[key]?.includes('{time}'), `${locale}.${key} must contain {time}`);
    }
  }
});

// (TPT311) The bar captions ("Claude 5-hour", "Codex · 7 дн.") are built from these three patterns —
// a translation that dropped {name} would print a bare duration on every bar, one that dropped {n}
// would print the same caption for a 5-hour and a 7-day window.
test('agentQuotaSidebar.window.* keep the {name} and {n} placeholders in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['hours', 'days', 'minutes']) {
      const str = table[`agentQuotaSidebar.window.${key}`];
      assert.ok(str?.includes('{name}'), `${locale}.agentQuotaSidebar.window.${key} must contain {name}`);
      assert.ok(str?.includes('{n}'), `${locale}.agentQuotaSidebar.window.${key} must contain {n}`);
    }
  }
});

// (TPT345) The merge panel's blocker/conflict copy interpolates task and repo names — a
// translation that dropped a placeholder would ship a blocker line that doesn't say which
// task or branch it is about.
test('merge.commitAs keeps {key} and {title}, merge.conflictTitle keeps {repo} and {branch} in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['merge.commitAs']?.includes('{key}'), `${locale}.merge.commitAs must contain {key}`);
    assert.ok(table['merge.commitAs']?.includes('{title}'), `${locale}.merge.commitAs must contain {title}`);
    assert.ok(table['merge.conflictTitle']?.includes('{repo}'), `${locale}.merge.conflictTitle must contain {repo}`);
    assert.ok(table['merge.conflictTitle']?.includes('{branch}'), `${locale}.merge.conflictTitle must contain {branch}`);
    assert.ok(table['merge.worktreeDirtyOnComplete']?.includes('{key}'), `${locale}.merge.worktreeDirtyOnComplete must contain {key}`);
    assert.ok(table['merge.cleanupResult']?.includes('{worktrees}') && table['merge.cleanupResult']?.includes('{branches}'), `${locale}.merge.cleanupResult placeholders`);
  }
});

test('merge.* plural keys keep {n} in every present plural form', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['merge.wtDirty', 'merge.conflictCount', 'merge.checksNewFailures', 'merge.mainDirty', 'merge.selectedCount']) {
      let seen = 0;
      for (const form of ['one', 'few', 'many']) {
        const str = table[`${key}.${form}`];
        if (str === undefined) continue;
        seen++;
        assert.ok(str.includes('{n}'), `${locale}.${key}.${form} must contain {n}`);
      }
      assert.ok(seen >= 2, `${locale}.${key} must define at least one and many`);
    }
  }
});

test('reauth.accountSwitched keeps the {email} placeholder in every locale', () => {
  for (const [lang, table] of Object.entries(LOCALES)) {
    assert.match(table['reauth.accountSwitched'], /\{email\}/, `${lang} reauth.accountSwitched`);
  }
});

// (TPT614) task-finish.js's toasts name the task and the server's reason — a translation that
// dropped {key} or {msg} would ship a toast that doesn't say which task or why it failed.
test('card.finishNothingToDo keeps {key} and card.finishFailed keeps {msg} in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['card.finishNothingToDo']?.includes('{key}'), `${locale}.card.finishNothingToDo must contain {key}`);
    assert.ok(table['card.finishFailed']?.includes('{msg}'), `${locale}.card.finishFailed must contain {msg}`);
  }
});

// (TPT697) openAgentSelectorModal() (console-modal.js) renders its title and Remember label from
// these keys — both were hardcoded English before, so a Ukrainian project still showed English.
// The parity check above can't catch a key dropped from every table at once.
test('agentSelector.title and agentSelector.remember are translated in every locale', () => {
  for (const key of ['agentSelector.title', 'agentSelector.remember']) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key} must be a non-empty string`);
    }
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must not be the English text`);
  }
});

// (TPT9063) The permission-mode card button + dialog keys (permission-mode.js /
// task-permission-mode.js): translated in every locale, with their placeholders intact.
test('permissionMode.* keys are translated in every locale and keep their placeholders', () => {
  const keys = Object.keys(LOCALES.en).filter((k) => k.startsWith('permissionMode.'));
  assert.equal(keys.length, 20);
  for (const key of keys) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key} must be a non-empty string`);
    }
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must not be the English text`);
  }
  const placeholders = {
    'permissionMode.projectDefaultWith': ['{mode}'], 'permissionMode.tip': ['{mode}'],
    'permissionMode.hint.inherited': ['{mode}', '{hint}'], 'permissionMode.title': ['{key}'],
    'permissionMode.taskSaved': ['{key}'], 'permissionMode.failed': ['{msg}'], 'permissionMode.errLoad': ['{id}', '{msg}'],
  };
  for (const [key, params] of Object.entries(placeholders)) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const p of params) assert.ok(table[key].includes(p), `${locale}.${key} must contain ${p}`);
    }
  }
});

// (TPT9008) The ESTART reason sub-keys: each agent's detect() codes (+ Pi's no_tool_calls), and the
// shared detection_failed. objective-teardown-wiring.test.js checks their English against the server.
const ESTART_REASON_KEYS = [
  ...['claude', 'codex', 'pi'].flatMap((agent) => [`cli_not_found.${agent}`, `cli_missing.${agent}`]),
  ...['claude', 'codex'].flatMap((agent) => [`not_logged_in.${agent}`, `login_check_failed.${agent}`]),
  'probe_failed.pi', 'probe_failed_output.pi', 'no_tool_calls.pi', 'detection_failed',
].map((reason) => `terminal.error.ESTART.${reason}`);
const REFRESH_CODES = ['request_failed', 'request_failed_cause', 'request_timeout', 'rejected', 'unreadable_response',
  'no_usable_token', 'scope_changed', 'project_scope', 'not_newer', 'missing_input', 'fetch_unavailable'];

// (TPT700) console-modal.js renders the terminal's status-dot tooltips, the lines it writes into the
// xterm, the plan-ready bar, the MCP auth dialog and the Debug Console header from these keys — all
// hardcoded English before. The parity check above can't catch a key dropped from every table at once.
test('terminal modal copy is translated in every locale', () => {
  const keys = [
    'console.title', 'btn.dismiss', 'terminal.discussion', 'terminal.planReady', 'terminal.planProceed',
    'terminal.mcpAuth.title', 'terminal.mcpAuth.initial', 'terminal.mcpAuth.reauth', 'terminal.mcpAuth.openSettings',
    'terminal.imageReadFailed', 'terminal.imagePasteReason.clipboardUnreadable',
    'terminal.imagePasteReason.notConnected', 'terminal.imagePasteReason.emptyData',
    ...['connected', 'planningCommand', 'planningDialog', 'executing', 'exited', 'exitedCode', 'error',
      'disconnected', 'connectionError'].map((name) => `terminal.status.${name}`),
    'terminal.processExitedCode', 'terminal.tokens', 'terminal.imagePasteFailed', 'terminal.voiceError',
    // (TPT9002) Coded server frames, rendered by terminal-frame-text.js.
    ...['EASSIGNEE', 'ECLAIM', 'EAUTH', 'EAUTH.expired', 'EAUTH.expiring', 'EAUTH.expiringNotRefreshed', 'ESTART',
      'ESTARTING', 'ENOSESSION', 'EBADREQUEST', 'ESETUP', 'EAGENT'].map((code) => `terminal.error.${code}`),
    ...['EIMAGE_NOT_RUNNING', 'EIMAGE_MISSING', 'EIMAGE_TYPE', 'EIMAGE_EMPTY', 'EIMAGE_TOO_LARGE'].map((code) => `terminal.pasteError.${code}`),
    // (TPT9008) Agent-detection / tool-compat reasons of an ESTART frame, and token-refresh failures.
    ...ESTART_REASON_KEYS,
    ...REFRESH_CODES.map((code) => `terminal.error.EAUTH.refresh.${code}`),
  ];
  for (const key of keys) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key} must be a non-empty string`);
    }
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must not be the English text`);
  }
});

// (TPT700) A translation that dropped a placeholder would ship a planning tooltip without the
// approval command, an exit line without the code, a token footer without its counts, or a
// paste/voice notice without the reason.
test('terminal modal interpolated keys keep their placeholders in every locale', () => {
  const placeholders = {
    'terminal.status.planningCommand': ['{command}'],
    'terminal.status.exitedCode': ['{code}'],
    'terminal.processExitedCode': ['{code}'],
    'terminal.tokens': ['{input}', '{output}', '{cost}'],
    'terminal.imagePasteFailed': ['{reason}'],
    'terminal.voiceError': ['{msg}'],
    // (TPT9002) Coded server frames: a dropped placeholder would hide the agent, the task key,
    // the expiry time, the refresh error, the image type or the size cap.
    'terminal.error.EAUTH.expired': ['{when}'],
    'terminal.error.EAUTH.expiring': ['{when}'],
    'terminal.error.EAUTH.expiringNotRefreshed': ['{when}', '{error}'],
    'terminal.error.ESTART': ['{label}', '{message}'],
    'terminal.error.ESTARTING': ['{taskId}'],
    'terminal.error.ENOSESSION': ['{taskId}'],
    'terminal.error.ESETUP': ['{message}'],
    'terminal.error.EAGENT': ['{agent}'],
    'terminal.pasteError.EIMAGE_TYPE': ['{type}'],
    'terminal.pasteError.EIMAGE_TOO_LARGE': ['{maxMb}'],
    // (TPT9008) Every ESTART reason names the agent; Pi's also carry the probe line or the model and
    // its host, and a refresh failure its HTTP status or network cause.
    ...Object.fromEntries(ESTART_REASON_KEYS.map((key) => [key, ['{label}']])),
    'terminal.error.ESTART.probe_failed_output.pi': ['{label}', '{output}'],
    'terminal.error.ESTART.no_tool_calls.pi': ['{label}', '{model}', '{host}'],
    'terminal.error.EAUTH.refresh.rejected': ['{status}'],
    'terminal.error.EAUTH.refresh.request_failed_cause': ['{cause}'],
  };
  for (const [key, required] of Object.entries(placeholders)) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const ph of required) assert.ok(table[key]?.includes(ph), `${locale}.${key} must contain ${ph}`);
    }
  }
});

// (TPT9007) The objective chat (chat-ui.js), its Debug Console lines (chat-ui.js handlers +
// objective-progress-log.js) and the corner api-status banner (utils.js) render from these keys —
// all hardcoded English before. The parity check above can't catch a key dropped from every table.
test('objective chat, Debug Console and api-status banner copy is translated in every locale', () => {
  const keys = [
    ...['restarted', 'turnFailed', 'unknownError', 'retryAttempt', 'streamInterrupted', 'contextTrimmed',
      'resultTokens', 'turnDivider'].map((name) => `console.${name}`),
    ...['spawned', 'cliInit', 'modelThinking', 'working', 'piStderr', 'piRetry', 'piRetryEnd', 'piNoToolsRetry',
      'piCompaction', 'piCompactionEnd'].map((stage) => `console.stage.${stage}`),
    ...['tab.newObjective', 'tab.close', 'objectiveReady', 'objectiveComplete', 'objectiveReadyBody',
      'placeholderFollowUp', 'placeholderBrief', 'historyButton', 'wordCountHint', 'olderHidden', 'originCaption',
      'originExit', 'image.previewAlt', 'image.uploadedAlt', 'image.remove', 'image.uploadFailed', 'autoRevising',
      'noTasksRetrying', 'retrying', 'contextTrimmed', 'connectionLostReconnecting', 'connectionLostRetry',
      'connectionLost', 'sessionExpired'].map((name) => `chat.${name}`),
    ...['spawned', 'cliInit', 'modelThinking', 'working', 'piRetry', 'piNoToolsRetry', 'piCompaction', 'listTasks',
      'listSystemTags', 'getTagArchitecture', 'getTagArchitectures', 'getTask', 'batchGrepTags', 'tool',
      'thinking'].map((name) => `chat.progress.${name}`),
    ...['modelLabel', 'selection', 'circuitOpen', 'queueFull', 'spawn', 'spawnDetail', 'history', 'finalize',
      'streamFailed', 'streamFailedRetried', 'streamModel', 'streamDetails', 'retryOrRefine', 'noCards', 'noCardsGot',
      'retryOrRefineInstructions', 'selectionRetry', 'throttleRetry', 'spawnRetry', 'historyRetry', 'finalizeRetry',
      'streamRetry'].map((name) => `chat.error.${name}`),
    'btn.send',
    ...['reconnected', 'reconnecting', 'offline', 'unreachable'].map((name) => `apiStatus.${name}`),
  ];
  for (const key of keys) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key} must be a non-empty string`);
    }
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must not be the English text`);
  }
  // Plural stems resolved with tc(): en one/many, uk one/few/many, each keeping {n}.
  for (const stem of ['console.turnFailedTries', 'console.resultCards', 'chat.wordCount', 'chat.loadEarlier',
    'apiStatus.reconnectingQueued']) {
    for (const [locale, forms] of [['en', ['one', 'many']], ['uk', ['one', 'few', 'many']]]) {
      for (const form of forms) {
        assert.ok(LOCALES[locale][`${stem}.${form}`]?.includes('{n}'), `${locale}.${stem}.${form} must contain {n}`);
      }
    }
  }
});

// (TPT9007) A translation that dropped a placeholder would ship a Debug Console line without the
// failure, attempt or count, an error sentence without the provider or reason, or a banner without
// the transport error.
test('objective chat, Debug Console and api-status banner keys keep their placeholders in every locale', () => {
  const placeholders = {
    'console.turnFailed': ['{msg}'],
    'console.turnFailedTries.one': ['{reason}'],
    'console.turnFailedTries.many': ['{reason}'],
    'console.retryAttempt': ['{attempt}', '{reason}'],
    'console.contextTrimmed': ['{n}'],
    'console.resultTokens': ['{input}', '{output}'],
    'console.turnDivider': ['{n}'],
    'chat.objectiveReady': ['{title}'],
    'chat.objectiveReadyBody': ['{n}'],
    'chat.olderHidden': ['{n}'],
    'chat.image.previewAlt': ['{name}'],
    'chat.retrying': ['{attempt}', '{reason}'],
    'chat.contextTrimmed': ['{n}'],
    'chat.progress.tool': ['{name}'],
    'chat.progress.thinking': ['{text}'],
    'chat.error.selection': ['{reason}'],
    'chat.error.spawn': ['{label}'],
    'chat.error.spawnDetail': ['{label}', '{detail}'],
    'chat.error.streamFailed': ['{label}', '{reason}'],
    'chat.error.streamFailedRetried': ['{label}', '{n}', '{reason}'],
    'chat.error.streamModel': ['{model}'],
    'chat.error.streamDetails': ['{detail}'],
    'chat.error.noCards': ['{label}'],
    'chat.error.noCardsGot': ['{preview}'],
    'chat.error.spawnRetry': ['{label}'],
    'chat.error.streamRetry': ['{label}', '{reason}'],
    'apiStatus.offline': ['{msg}'],
  };
  for (const [key, required] of Object.entries(placeholders)) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const ph of required) assert.ok(table[key]?.includes(ph), `${locale}.${key} must contain ${ph}`);
    }
  }
  assert.ok(LOCALES.uk['console.turnFailedTries.few']?.includes('{reason}'), 'uk.console.turnFailedTries.few must contain {reason}');
});
