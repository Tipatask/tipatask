import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

const { setupAuthWeb, visibleSteps } = await import('./project-creation-wizard.js');

test('setupAuthWeb reports an actionable IPC failure and allows an immediate retry', async () => {
  let attempts = 0;
  const invoke = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Error invoking remote method 'setup:auth-web': TypeError: Cannot read properties of null (reading 'port')");
    }
    return { token: 'token-2', user: { email: 'user@example.com' } };
  };

  await assert.rejects(
    setupAuthWeb('https://tt.example.test', invoke),
    (error) => {
      assert.match(error.message, /^Desktop sign-in could not start:/);
      assert.match(error.message, /Try Sign in again without closing this wizard/);
      assert.doesNotMatch(error.message, /Error invoking remote method/);
      return true;
    },
  );

  assert.deepEqual(
    await setupAuthWeb('https://tt.example.test', invoke),
    { token: 'token-2', user: { email: 'user@example.com' } },
  );
  assert.equal(attempts, 2);
});

test('setupAuthWeb explains how to recover when desktop IPC is unavailable', async () => {
  await assert.rejects(
    setupAuthWeb('https://tt.example.test', null),
    /Desktop sign-in is unavailable\. Restart TipATask, reopen Open \/ Create Project, and try again\./,
  );
});

// The wizard's wizard-complete payload is built inside a DOM-bound handler that can't run under
// node, so guard the wiring at the source level: it must use the shared save-row helper (which
// keeps the per-row `provider`) rather than a hand-rolled {model, apiKey} mapping that would
// silently drop it on the next refactor.
test('wizard-complete builds piModels through the shared computePiSaveRows helper', async () => {
  const src = fs.readFileSync(new URL('./project-creation-wizard.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bcomputePiSaveRows\b[^}]*\} from '\.\/agent-select\.js'/);
  assert.match(src, /piModels: piEnabled \? computePiSaveRows\(_piModels\) : \[\]/);

  // setup-modal re-exports the very same function, so both save paths share one filter.
  const shared = (await import('./agent-select.js')).computePiSaveRows;
  assert.equal((await import('./setup-modal.js')).computePiSaveRows, shared);
});

// (TPT174) The Agent step's credential hint must be a response to a blocked Next click, not
// first-paint chrome. That needs three things to hold together, none of which is observable
// without a DOM, so they are pinned at source level (same approach as the test above):
//   1. the message node ships EMPTY;
//   2. Next is NOT re-derived from piCredentialsMissing() — disabling it under the exact condition
//      the message explains made the message unreachable (a dead button with no reason);
//   3. the click handler still does the validating + writing, and onChange clears the message.
test('Agent step shows the credential hint only after a blocked Next click', () => {
  const src = fs.readFileSync(new URL('./project-creation-wizard.js', import.meta.url), 'utf8');
  const start = src.indexOf('function _renderStep4(');
  const end = src.indexOf('// ── Step 5', start);
  assert.ok(start !== -1 && end > start, 'could not locate _renderStep4()');
  const step4 = src.slice(start, end);

  // 1. Empty on first paint.
  assert.match(step4, /<div class="setup-modal-msg setup-modal-msg--error" id="wiz-agent-msg"><\/div>/);

  // 2. Next is never disabled by the credential check — only the initial "still loading" markup
  //    and the post-load `= false` may touch it.
  assert.doesNotMatch(step4, /nextBtn\.disabled\s*=[^;]*piCredentialsMissing/);
  assert.match(step4, /nextBtn\.disabled = false;/);

  // 3. The message is written inside the Next click handler (after the credentials check)…
  const click = step4.slice(step4.indexOf("nextBtn.addEventListener('click'"));
  assert.match(click, /piCredentialsMissing\(\{ availableAgents: _availableAgents, piModels: _piModels \}\)/);
  assert.match(click, /msgEl\.textContent = t\('agentSelect\.fixOtherModelRows'\)/);
  assert.match(click, /msgEl\.textContent = t\('wizard\.selectDefaultAgent'\)/);
  // …and nowhere before it: the only pre-click writes to the message node are the clearing ones.
  const beforeClick = step4.slice(0, step4.indexOf("nextBtn.addEventListener('click'"));
  assert.doesNotMatch(beforeClick, /msgEl\.textContent = t\(/);

  // …and edits (onChange) clear it, so it never outlives the state it described.
  assert.match(step4, /onChange:[\s\S]*?msgEl\.textContent = '';[\s\S]*?onReCheck/);
});

// (TPT557) The wizard is the single entry for an unconfigured folder: its Create Project step
// either creates a new API project (6 steps, Preset included) or links an existing one (5 steps —
// nothing to seed, so the Preset step is skipped and the Confirm button reads "Open Project").
test('visibleSteps: a new project walks all six steps, an existing one skips Preset (5)', () => {
  assert.deepEqual(visibleSteps(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(visibleSteps({ existing: false }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(visibleSteps({ existing: true }), [1, 2, 3, 4, 6]);
});

test('existing-project pick skips Preset on both Next and Back, and emits preset: null', () => {
  const src = fs.readFileSync(new URL('./project-creation-wizard.js', import.meta.url), 'utf8');
  // Dots come from visibleSteps(), never a fixed six.
  assert.match(src, /visibleSteps\(\{ existing: _isExisting\(\) \}\)\.map\(/);
  // Agent → (Preset | Confirm), Confirm Back → (Preset | Agent).
  const step4 = src.slice(src.indexOf('function _renderStep4('), src.indexOf('// ── Step 5'));
  assert.match(step4, /_goto\(_isExisting\(\) \? 6 : 5\)/);
  const step6 = src.slice(src.indexOf('function _renderStep6('));
  assert.match(step6, /_goto\(existing \? 4 : 5\)/);
  // Captions + payload branch on the same flag.
  assert.match(step6, /existing \? t\('wizard\.confirmExistingProject'\) : t\('wizard\.confirmNewProject'\)/);
  assert.match(step6, /existing \? t\('wizard\.openProjectBtn'\) : t\('wizard\.createProjectBtn'\)/);
  assert.match(step6, /preset: existing \|\| !_preset \? null : \{ letter: _preset\.letter/);
});

test('index.js links an existing pick through project:open-existing without adopting the window', () => {
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const listener = src.slice(src.indexOf("window.addEventListener('create-project'"));
  const branch = listener.slice(0, listener.indexOf('completeProjectWizard'));
  assert.match(branch, /if \(detail\?\.apiProject && !detail\.apiProject\.isNew\)/);
  assert.match(branch, /openExistingProject\?\.\(\{/);
  assert.match(branch, /adopt: false,/);
  // Success lands in the same Current/New Window chooser the create path uses.
  assert.match(branch, /new CustomEvent\('project-created'/);
});

test('headerHtml: closable:false leaves out the × button, default keeps it (TPT564)', async () => {
  const { headerHtml } = await import('./setup-modal-header.js');
  assert.match(headerHtml({ title: 'T', projectPath: '/p' }), /setup-modal-close/);
  assert.doesNotMatch(headerHtml({ title: 'T', projectPath: '/p', closable: false }), /setup-modal-close/);
});

test('unbound window: create-project opens the wizard locked and routes every exit back to Get Started (TPT564)', () => {
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(src, /const unbound = !window\.electronAPI\?\.getProjectPath\?\.\(\);/);
  assert.match(src, /locked: unbound,/);
  assert.match(src, /onCancel: unbound \? showGetStarted : undefined,/);
  assert.match(src, /new CustomEvent\('show-get-started'\)/);
  // Both failed-completion branches reopen Get Started — the wizard is already closed by then.
  assert.equal((src.match(/'error'\);\n\s+showGetStarted\(\);/g) || []).length, 2);
});

test('template.html: locked Get Started ignores Escape and comes back after a cancelled pick (TPT564)', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, /_chooseLocked = _isUnboundWindowSync\(\);/);
  assert.match(src, /_chooseModal\?\.style\.display === 'flex' && !_chooseLocked/);
  assert.match(src, /window\.addEventListener\('show-get-started', \(\) => _showChooseModal\(\)\);/);
  const fn = src.slice(src.indexOf('async function openOrCreateProject()'), src.indexOf('function _showProjectRenameModal'));
  assert.match(fn, /if \(focusResult\?\.canceled\) \{ if \(unbound\) _showChooseModal\(\); return; \}/);
  assert.match(fn, /if \(unbound\) _showChooseModal\(\);\n\s+\}/);
});
