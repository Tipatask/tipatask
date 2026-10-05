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

// (TPT310) agentQuotaSidebar.updatedAt feeds the left-nav plan-usage block's "Updated HH:MM" line —
// a translation that dropped {time} would ship a caption with no timestamp. The block's other
// strings are plain labels, covered by the en-subset parity check above.
test('agentQuotaSidebar.updatedAt keeps the {time} placeholder in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['agentQuotaSidebar.updatedAt']?.includes('{time}'), `${locale}.agentQuotaSidebar.updatedAt must contain {time}`);
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
