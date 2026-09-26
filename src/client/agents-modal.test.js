import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

// agents-modal.js imports cleanly under node (module scope only declares variables; every DOM
// access is inside a function), but openAgentsModal()/_save() need a document and the Electron
// bridge, so the modal's WIRING to the shared Pi helpers is guarded at the source level — the
// same pattern project-creation-wizard.test.js uses for the wizard's save path. The helpers'
// own behavior (prefix round trip, DeepSeek passthrough, default-first ordering) is covered
// in agent-select.test.js; this file only pins that THIS modal routes through them.
const SRC = fs.readFileSync(new URL('./agents-modal.js', import.meta.url), 'utf8');

const { normalizePiModels, computePiSaveRows } = await import('./agent-select.js');
const { LOCALES } = await import('./i18n.js');
const modal = await import('./agents-modal.js');

// A source-regex test can't catch a broken import specifier or a syntax error — this can.
test('the modal module still imports cleanly with its agent-select deps', () => {
  assert.equal(typeof modal.openAgentsModal, 'function');
  assert.equal(typeof modal.closeAgentsModal, 'function');
});

test('Edit Agents save builds piModels through the shared computePiSaveRows filter', () => {
  assert.match(SRC, /import \{[^}]*\bcomputePiSaveRows\b[^}]*\} from '\.\/agent-select\.js'/);
  assert.match(SRC, /piModels: _draft\.availableAgents\.includes\('pi'\) \? computePiSaveRows\(_draft\.piModels\) : \[\]/);
});

test('Edit Agents seeds Pi rows through normalizePiModels on both load branches, no hand-rolled blank row', () => {
  assert.match(SRC, /import \{[^}]*\bnormalizePiModels\b[^}]*\} from '\.\/agent-select\.js'/);
  // Electron branch (cfg.PI_MODELS / legacy flat pair) and the shared _draft assembly.
  assert.match(SRC, /piModels: normalizePiModels\(\{[^}]*piModels: [^}]*cfg\.PI_MODELS/s);
  assert.match(SRC, /piModels: normalizePiModels\(selection \|\| \{\}\)/);
  assert.equal(SRC.includes("[{ model: '', apiKey: '' }]"), false, 'the synthetic blank seed row is gone');
});

test('detecting-agents placeholder is translated, not a hardcoded English string', () => {
  assert.match(SRC, /t\('setup\.detectingAgents'\)/);
  assert.equal(SRC.includes('Detecting installed agents…'), false);
});

// The path an UNTOUCHED save takes: _load() seeds display form, renderAgentSelect() never emits
// (it only does on initial render when it pruned something), so _save() converts what _load()
// stored. Without computePiSaveRows() on that path the prefix would be dropped from disk.
test('untouched save: stored row -> display form on load -> identical stored row on save', () => {
  const stored = { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-x' };
  const loaded = normalizePiModels({ piModels: [stored] });
  assert.equal(loaded[0].model, 'anthropic/claude-sonnet-4.5', 'reopening shows the unprefixed id');
  assert.deepEqual(computePiSaveRows(loaded), [stored], 'saving writes it back with the prefix, once');
});

test('agentsModal.errPi no longer talks about "rows" in either locale', () => {
  for (const lang of ['en', 'uk']) {
    const s = LOCALES[lang]['agentsModal.errPi'];
    assert.ok(s, `${lang} string present`);
    assert.doesNotMatch(s, /Other Model rows/i, `${lang} wording updated`);
    assert.doesNotMatch(s, /рядк/i, `${lang} wording updated (any case form)`);
  }
});
