import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { renderAgentSelect, setPiProviders, computePiSaveRows } from './agent-select.js';
import { LOCALES, setLocale } from './i18n.js';
import { piTaskModelIds } from './pi-task-models.js';
import { taskChatProviders } from './task-chat-model.js';
import { renderImageTask } from './image-task-view.js';

test('image rows remain task choices while text chats have no image model choices', () => {
  const providers = [{ id: 'pi', models: [{ value: 'text' }], configuredModels: ['image', 'text', 'tool-less'], toolLessModels: ['image', 'tool-less'], imageModels: ['image'] }];
  assert.deepEqual(piTaskModelIds(providers), ['image', 'text']);
  assert.deepEqual(taskChatProviders(providers)[0].models, [{ value: 'text' }]);
});

for (const locale of ['en', 'uk']) test(`shared image form and result recovery UI work in ${locale}`, async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = window.document;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'recraft/recraft-v3' }] });
  setLocale(locale);
  setPiProviders([{ id: 'openrouter', label: 'OpenRouter', keyRequired: true }, { id: 'custom', label: 'Custom endpoint', keyRequired: false, supportsBaseUrl: true }]);
  try {
    const host = document.createElement('div'); document.body.append(host);
    let saved;
    renderAgentSelect(host, { agents: [{ id: 'pi', label: 'Pi', available: true }], value: { taskAgent: 'pi', availableAgents: ['pi'], piModels: [{ model: 'openrouter/recraft/recraft-v3', purpose: 'image', hasApiKey: true, apiKeyAction: 'preserve', credentialRef: { model: 'openrouter/recraft/recraft-v3', provider: 'openrouter' }, imageDefaults: { count: 2, aspectRatio: '16:9', outputFolder: 'assets/images' } }] }, onChange: value => { saved = value; } });
    assert.equal(host.querySelector('.setup-modal-agent-badge').textContent, LOCALES[locale]['agentSelect.purposeImage']);
    host.querySelector('.sma-pi-edit').click();
    assert.equal(host.querySelector('.sma-pi-provider').disabled, true);
    assert.equal(host.querySelector('.setup-modal-agent-extra-field--tools').hidden, true);
    assert.equal(host.querySelector('.sma-pi-key').value, '');
    const folder = host.querySelector('.sma-pi-folder'); folder.value = 'art/output'; folder.dispatchEvent(new window.Event('input', { bubbles: true }));
    host.querySelector('.sma-pi-form-save').click();
    const rows = computePiSaveRows(saved.piModels);
    assert.equal(rows[0].purpose, 'image');
    assert.equal(rows[0].imageDefaults.outputFolder, 'art/output');
    assert.equal(rows[0].imageDefaults.count, 2);
    assert.equal(rows[0].apiKeyAction, 'preserve');
    assert.equal(rows[0].model, 'openrouter/recraft/recraft-v3');
    const terminal = document.createElement('div'); terminal.innerHTML = '<div class="terminal-header"></div>'; host.append(terminal);
    let retry;
    renderImageTask(terminal, { stage: 'failed', error: 'upload', runId: 'run', canRetry: true, canResume: true, files: [{ path: '/project/art/output/file.png', url: '/api/image-task/result?task=IMG1' }] }, value => { retry = value; });
    assert.match(terminal.querySelector('img').src, /\/api\/image-task\/result/);
    assert.equal(terminal.querySelector('figcaption').textContent, '/project/art/output/file.png');
    terminal.querySelector('button').click();
    assert.deepEqual(retry, { type: 'image-task-retry', mode: 'resume', runId: 'run' });
    assert.equal(terminal.querySelector('button').disabled, true);
  } finally {
    globalThis.document = previous.document; globalThis.fetch = previous.fetch; setLocale('en');
    await window.happyDOM.abort();
  }
});
