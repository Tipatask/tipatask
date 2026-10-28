// Unit tests for setup-modal.js's pure, DOM-free exports (TPT161): the mode-specific step
// lists, the forward-navigation helper, the C1122 pi-row save filter, and the re-auth
// savedConfig builder. Back navigation is a plain history-stack pop with no domain logic,
// so it isn't tested here — see _goto()/_back() in setup-modal.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { stepsFor, nextStep, computePiSaveRows, buildReauthConfig } = await import('./setup-modal.js');

test('stepsFor: setup mode includes the device step, reauth never does', () => {
  assert.deepEqual(stepsFor('setup'), ['signin', 'project', 'device', 'agent', 'confirm']);
  assert.deepEqual(stepsFor('reauth'), ['signin', 'project', 'agent', 'confirm']);
  assert.ok(!stepsFor('reauth').includes('device'));
  // No step list anywhere carries an API-URL step (TPT161's whole point).
  assert.ok(!stepsFor('setup').some(s => /api/i.test(s)));
  assert.ok(!stepsFor('reauth').some(s => /api/i.test(s)));
});

test('nextStep: setup walks signin -> project -> device -> agent -> confirm', () => {
  assert.equal(nextStep('setup', 'signin'), 'project');
  assert.equal(nextStep('setup', 'project'), 'device');
  assert.equal(nextStep('setup', 'device'), 'agent');
  assert.equal(nextStep('setup', 'agent'), 'confirm');
});

test('nextStep: reauth skips the project picker only when a project is already known', () => {
  assert.equal(nextStep('reauth', 'signin', { skipProject: true }), 'agent');
  assert.equal(nextStep('reauth', 'signin', { skipProject: false }), 'project');
  assert.equal(nextStep('reauth', 'signin'), 'project'); // default: not skipped
  assert.equal(nextStep('reauth', 'project'), 'agent'); // never 'device'
  assert.equal(nextStep('reauth', 'agent'), 'confirm');
});

test('computePiSaveRows: a key-required row needs both model AND apiKey; trims, drops incomplete rows', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: '  a  ', apiKey: ' k ' },
      { model: '', apiKey: 'x' },
      { model: 'b', apiKey: '' },
      { model: 'c', apiKey: 'k2' },
    ]),
    // (TPT172) an OpenRouter row is SAVED with its openrouter/ prefix even when typed without it.
    [{ model: 'openrouter/a', apiKey: 'k' }, { model: 'openrouter/c', apiKey: 'k2' }],
  );
  assert.deepEqual(computePiSaveRows([]), []);
  assert.deepEqual(computePiSaveRows(undefined), []);
});

test('computePiSaveRows: a DeepSeek row keeps provider; an OpenRouter row stays {model, apiKey}', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
      { model: 'openrouter/x', apiKey: 'sk-or', provider: 'openrouter' },
    ]),
    [
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
      { model: 'openrouter/x', apiKey: 'sk-or' },
    ],
  );
});

test('buildReauthConfig: a DeepSeek row passes through PI_MODELS with its provider', () => {
  const piSaveRows = computePiSaveRows([{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }]);
  const cfg = buildReauthConfig({
    baseCfg: {},
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'pi',
    availableAgents: ['pi'],
    piSaveRows,
  });
  assert.deepEqual(cfg.PI_MODELS, [{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }]);
});

test('buildReauthConfig: writes PI_MODELS and deletes the legacy flat pair when rows are present', () => {
  const cfg = buildReauthConfig({
    baseCfg: { PI_MODEL: 'old', OPENROUTER_API_KEY: 'oldkey', DEVICE_ID: '9', DEVICE_NAME: 'Mac' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'scoped-tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'claude',
    availableAgents: ['claude', 'pi'],
    piSaveRows: [{ model: 'openrouter/x', apiKey: 'sk-1' }],
  });
  assert.equal(cfg.PI_MODEL, undefined);
  assert.equal(cfg.OPENROUTER_API_KEY, undefined);
  assert.deepEqual(cfg.PI_MODELS, [{ model: 'openrouter/x', apiKey: 'sk-1' }]);
  assert.equal(cfg.API_PROJECT_ID, '5');
  assert.equal(cfg.API_TOKEN, 'scoped-tok');
  assert.equal(cfg.DEVICE_ID, '9'); // carried forward from baseCfg untouched
  assert.equal(cfg.projectName, 'Tipatask');
});

test('buildReauthConfig: never writes an empty PI_MODELS array and leaves an existing legacy pair alone', () => {
  const cfg = buildReauthConfig({
    baseCfg: { PI_MODEL: 'old', OPENROUTER_API_KEY: 'oldkey' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'claude',
    availableAgents: ['claude'],
    piSaveRows: [],
  });
  assert.ok(!('PI_MODELS' in cfg));
  assert.equal(cfg.PI_MODEL, 'old');
  assert.equal(cfg.OPENROUTER_API_KEY, 'oldkey');
});

test('buildReauthConfig: falls back to baseCfg TASK_AGENT/AVAILABLE_AGENTS, never to an invented claude', () => {
  const cfg = buildReauthConfig({
    baseCfg: { TASK_AGENT: 'codex', AVAILABLE_AGENTS: 'codex' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 1, name: 'P' },
    taskAgent: '',
    availableAgents: [],
    piSaveRows: [],
  });
  assert.equal(cfg.TASK_AGENT, 'codex');
  assert.equal(cfg.AVAILABLE_AGENTS, 'codex');

  const cfgNoFallback = buildReauthConfig({
    baseCfg: {},
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 1, name: 'P' },
    taskAgent: '',
    availableAgents: [],
    piSaveRows: [],
  });
  // (TPT678) Nothing picked and nothing on disk: no key is written, so readers use their own default.
  assert.equal(cfgNoFallback.TASK_AGENT, undefined);
  assert.equal(cfgNoFallback.AVAILABLE_AGENTS, undefined);
  assert.ok(!JSON.stringify(cfgNoFallback).includes('claude'));
});

test('stepsFor/nextStep: account-only mode is Sign-in then Confirm, nothing else', () => {
  assert.deepEqual(stepsFor('account'), ['signin', 'confirm']);
  assert.equal(nextStep('account', 'signin'), 'confirm');
  assert.equal(nextStep('account', 'signin', { skipProject: true }), 'confirm');
});

// ── (TPT9169) Import mode ──

const {
  defaultImportName, archiveOriginText, archiveCountTexts, importFolderNotice, importProgressText, importErrorText,
} = await import('./setup-modal.js');
const { setLocale, LOCALES } = await import('./i18n.js');

test('stepsFor/nextStep: import mode is Sign-in, Name, Folder, Agent, Confirm — no project picker, no device', () => {
  assert.deepEqual(stepsFor('import'), ['signin', 'name', 'folder', 'agent', 'confirm']);
  assert.equal(nextStep('import', 'signin'), 'name');
  assert.equal(nextStep('import', 'name'), 'folder');
  assert.equal(nextStep('import', 'folder'), 'agent');
  assert.equal(nextStep('import', 'agent'), 'confirm');
  assert.equal(nextStep('import', 'signin', { skipProject: true }), 'name', 'skipProject is a re-auth notion');
});

test('defaultImportName: the exported name, else the archive name without -export.zip', () => {
  assert.equal(defaultImportName({ projectName: '  Acme  ' }, 'x.zip'), 'Acme');
  assert.equal(defaultImportName({ projectName: null }, 'acme-export.zip'), 'acme');
  assert.equal(defaultImportName({}, 'Backup.ZIP'), 'Backup');
  assert.equal(defaultImportName({ projectName: 'n'.repeat(300) }, '').length, 255);
  assert.equal(defaultImportName(null, null), '');
});

test('import summary texts render in both locales, with Ukrainian plural forms', () => {
  try {
    setLocale('en');
    assert.deepEqual(archiveCountTexts({ taskCount: 1, sprintCount: 2, kbFileCount: 5 }), ['1 task', '2 sprints', '5 knowledge base files']);
    assert.equal(archiveOriginText({ projectName: 'Acme', exportedAt: '2026-10-28T09:00:00.000Z' }), 'Exported from “Acme” on Oct 28, 2026');
    assert.equal(archiveOriginText({ projectName: 'Acme' }), 'Exported from “Acme”');
    assert.equal(archiveOriginText({ exportedAt: 'not a date' }), null);
    setLocale('uk');
    assert.deepEqual(archiveCountTexts({ taskCount: 1, sprintCount: 3, kbFileCount: 11 }), ['1 задача', '3 спринти', '11 файлів бази знань']);
    assert.match(archiveOriginText({ projectName: 'Acme', exportedAt: '2026-10-28T09:00:00.000Z' }), /^Експортовано з «Acme» 28 жовт\.? 2026/);
  } finally {
    setLocale('en');
  }
});

test('importFolderNotice: refusals are errors; ai/architecture files are a warning naming what is kept', () => {
  try {
    setLocale('en');
    assert.deepEqual(importFolderNotice(null), { kind: 'muted', text: 'Checking the folder…' });
    assert.equal(importFolderNotice({ ok: true, blocked: 'configured' }).kind, 'error');
    assert.equal(importFolderNotice({ ok: true, blocked: 'configured' }).text, LOCALES.en['import.folderConfigured']);
    assert.equal(importFolderNotice({ ok: true, blocked: 'open' }).text, LOCALES.en['import.folderOpen']);
    assert.equal(importFolderNotice({ ok: false, code: 'expired' }).text, LOCALES.en['import.errExpired']);
    assert.deepEqual(importFolderNotice({ ok: true, blocked: null, architectureFiles: 0, existingKbFiles: [] }), { kind: '', text: '' });
    assert.deepEqual(importFolderNotice({ ok: true, blocked: null, architectureFiles: 4, existingKbFiles: [] }), {
      kind: 'warning',
      text: "This folder already contains 4 files in ai/architecture. The archive's files are added next to them; none of them is replaced.",
    });
    const kept = ['CLAUDE.md', 'ai/architecture/GENERAL.md', 'ai/architecture/tt-a.md', 'ai/architecture/tt-b.md', 'ai/architecture/tt-c.md'];
    assert.deepEqual(importFolderNotice({ ok: true, blocked: null, architectureFiles: 1, existingKbFiles: kept }), {
      kind: 'warning',
      text: 'This folder already contains 1 file in ai/architecture. Files already in the folder are kept, so 5 files from the archive are not written: '
        + 'CLAUDE.md, ai/architecture/GENERAL.md, ai/architecture/tt-a.md and 2 more.',
    });
    setLocale('uk');
    const uk = importFolderNotice({ ok: true, blocked: null, architectureFiles: 2, existingKbFiles: ['CLAUDE.md'] });
    assert.equal(uk.kind, 'warning');
    assert.equal(uk.text, 'У цій папці вже є 2 файли в ai/architecture. Файли, що вже є в папці, залишаться, тож 1 файл з архіву не буде записано: CLAUDE.md.');
  } finally {
    setLocale('en');
  }
});

test('importProgressText / importErrorText cover every step and failure code', () => {
  setLocale('en');
  assert.equal(importProgressText({ step: 'project' }), 'Creating the project…');
  assert.equal(importProgressText({ step: 'tasks', done: 3, total: 12 }), 'Importing tasks: 3 of 12…');
  assert.equal(importProgressText({ step: 'tasks', done: 0, total: 0 }), 'Importing tasks…');
  for (const step of ['kb', 'statuses', 'tags', 'sprints', 'finish']) {
    assert.equal(importProgressText({ step }), LOCALES.en[`import.progress.${step}`]);
  }
  assert.equal(importProgressText({ step: 'something-new' }), LOCALES.en['common.working']);

  assert.equal(importErrorText({ code: 'expired' }), LOCALES.en['import.errExpired']);
  assert.equal(importErrorText({ code: 'folder', blocked: 'configured' }), LOCALES.en['import.folderConfigured']);
  assert.equal(importErrorText({ code: 'create', error: 'quota' }), 'The project could not be created: quota');
  assert.equal(importErrorText({ code: 'import', step: 'tasks', error: 'API unreachable', removed: true }),
    'The import stopped at “Tasks” (API unreachable). The partly imported project was removed, so you can import the archive again.');
  assert.equal(importErrorText({ code: 'import', step: null, error: 'boom', removed: false, projectName: 'Acme' }),
    'The import stopped (boom). The partly imported project “Acme” could not be removed. Delete it in the web app before importing again.');
  assert.equal(importErrorText({ code: 'failed', error: 'IPC gone' }), 'The import stopped (IPC gone).');
  assert.equal(importErrorText(undefined), 'The import stopped (unknown error).');
});

test('every import.* key is translated in every locale', () => {
  const keys = Object.keys(LOCALES.en).filter((k) => k.startsWith('import.'));
  assert.ok(keys.length >= 60, `import.* keys: ${keys.length}`);
  for (const key of keys) {
    for (const [locale, table] of Object.entries(LOCALES)) assert.ok(table[key]?.trim(), `${locale}.${key}`);
  }
  const same = keys.filter((k) => LOCALES.uk[k] === LOCALES.en[k]);
  assert.deepEqual(same, [], 'no import.* key left in English in uk');
  for (const key of ['import.tasks', 'import.sprints', 'import.kbFiles', 'import.files', 'import.folderHasKb', 'import.folderKeeps', 'import.kept']) {
    for (const form of ['one', 'few', 'many']) assert.ok(LOCALES.uk[`${key}.${form}`]?.includes('{n}'), `uk ${key}.${form}`);
  }
});
