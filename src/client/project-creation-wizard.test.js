import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

const { presetIcon, setupAuthWeb, visibleSteps } = await import('./project-creation-wizard.js');

test('each work preset has distinct decorative artwork that inherits its card color', () => {
  const ids = ['software', 'science', 'marketing', 'sales', 'finance', 'health', 'home', 'personal-growth'];
  const icons = ids.map(presetIcon);
  for (const [index, icon] of icons.entries()) {
    assert.match(icon, /^<svg\b/, ids[index]);
    assert.match(icon, /stroke="currentColor"/);
    assert.match(icon, /aria-hidden="true"/);
    assert.match(icon, /focusable="false"/);
  }
  assert.equal(new Set(icons).size, ids.length);
  assert.equal(presetIcon('unknown'), '');
});

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
    /Desktop sign-in is unavailable\. Restart TipATask, choose Open Project or Create Project, and try again\./,
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

test('visibleSteps keeps work selection on both create entries and gates software onboarding', () => {
  assert.deepEqual(visibleSteps(), [1, 2, 'profile', 3, 4, 5, 7]);
  assert.deepEqual(visibleSteps({ software: true }), [1, 2, 'profile', 3, 4, 5, 6, 7]);
  assert.deepEqual(visibleSteps({ software: true, presetLocked: true }), [1, 2, 'profile', 3, 4, 5, 7]);
  for (const presetLocked of [true, false]) {
    assert.deepEqual(visibleSteps({ existing: true, software: true, presetLocked }), [1, 2, 'profile', 3, 4, 7]);
  }
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
  const fn = src.slice(src.indexOf('async function openOrCreateProject('), src.indexOf('function _showProjectRenameModal'));
  assert.match(fn, /if \(focusResult\?\.canceled\) \{ if \(unbound\) _showChooseModal\(\); return; \}/);
  assert.match(fn, /if \(unbound\) _showChooseModal\(\);\n\s+\}/);
});

// (TPT9316) Preset letters follow display order (A = compose the knowledge base as you go), and
// every value is one the main process knows: the compose value matches project-seeder.js, and
// the other two are exactly the seeding presets (PRESET_TASKS).
test('PRESETS: A compose-as-you-go, then the two seeding presets B and C, matching the server', async () => {
  const { PRESETS, COMPOSE_PRESET } = await import('./project-creation-wizard.js');
  assert.deepEqual(PRESETS.map((p) => [p.letter, p.mode, p.value]), [
    ['A', 'compose', 'compose-as-you-go'],
    ['B', 'new', 'original-specification'],
    ['C', 'existing', 'existing-code'],
  ]);
  assert.equal(COMPOSE_PRESET, 'compose-as-you-go');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  assert.equal(require('../server/project-seeder.js').COMPOSE_PRESET, COMPOSE_PRESET);
  assert.deepEqual(
    PRESETS.filter((p) => p.value !== COMPOSE_PRESET).map((p) => p.value).sort(),
    Object.keys(require('../cli/seed-setup-tasks.js').PRESET_TASKS).sort(),
  );
  for (const p of PRESETS) assert.ok(p.name && p.desc, `${p.letter} has a name and description`);
});
