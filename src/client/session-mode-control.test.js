import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSessionModeControl } from './session-mode-control.js';
import { t, setLocale } from './i18n.js';

// (TPT9139) The terminal header's permission-mode control: a selector only for a running run the
// server marks `supported`, "Switching to …" until the server confirms, one toast per outcome, and
// never the requested mode on screen as if it applied.
const RUN = 1790780000000;
const live = (confirmed, extra = {}) => ({ requested: confirmed, confirmed, pending: false, error: null, supported: true, ...extra });

function harness(tc, { request } = {}) {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  tc.after(() => { control.destroy(); globalThis.document = previous; window.happyDOM.abort(); setLocale('en'); });
  const toasts = [];
  const requests = [];
  const control = createSessionModeControl({
    t,
    toast: (text, type, opts) => toasts.push({ text, type, durationMs: opts?.durationMs }),
    request: mode => { requests.push(mode); return request ? request(mode) : { ok: true, state: live(control.state.confirmed, { requested: mode, pending: true }) }; },
  });
  window.document.body.innerHTML = '<div class="terminal-header"><span class="task-label"><span class="terminal-task-caption">Claude Code</span></span></div>';
  window.document.querySelector('.task-label').appendChild(control.root);
  const root = control.root;
  const trigger = () => root.querySelector('.permission-mode-select-trigger');
  const label = () => (root.querySelector('.permission-mode-select-trigger .permission-mode-select-label')
    || root.querySelector('.session-mode-label'))?.textContent;
  const options = () => [...(root.querySelector('[role="listbox"]') || window.document.querySelector('.session-mode-menu'))?.querySelectorAll('[role="option"]') || []];
  const pick = value => {
    trigger().click();
    const row = [...window.document.querySelectorAll('.session-mode-menu [role="option"]')].find(r => r.dataset.value === value);
    assert.ok(row, `option ${value} is offered`);
    row.click();
  };
  return { window, control, root, trigger, label, options, pick, toasts, requests };
}

test('a run whose agent cannot switch live keeps a static chip; a legacy run with no mode shows nothing', tc => {
  const h = harness(tc);
  h.control.update(live('plan', { supported: false }), { startedAt: RUN, running: true, source: 'project' });
  assert.equal(h.root.hidden, false);
  assert.equal(h.trigger(), null, 'no selector for an unsupported run');
  const chip = h.root.querySelector('.session-mode-chip.terminal-permission-mode');
  assert.equal(chip.textContent, 'Plan mode');
  assert.ok(chip.querySelector('svg.permission-mode-icon--plan'));
  assert.equal(chip.title, 'Run: Plan mode. Inherited from the project at start. Changes apply on the next run.');
  assert.equal(h.root.previousElementSibling.className, 'terminal-task-caption', 'sits right after the agent caption');
  h.control.update('auto', { running: true, source: 'task' });
  assert.equal(h.label(), 'Auto mode', 'a bare scalar mode is never switchable');
  assert.equal(h.trigger(), null);
  h.control.update(live(null, { supported: false }), { running: true });
  assert.equal(h.root.hidden, true);
});

test('Plan → Bypass: the request shows "Switching to Bypass…" with a spinner until confirmed, then Bypass with no way back to Plan', tc => {
  const h = harness(tc);
  h.control.update(live('plan'), { startedAt: RUN, running: true, source: 'task' });
  assert.equal(h.control.interactive, true);
  assert.equal(h.label(), 'Plan mode');
  assert.deepEqual(h.options().map(o => o.dataset.value), ['plan', 'auto', 'bypass']);
  assert.equal(h.trigger().getAttribute('aria-label'), 'Permission mode for this run: Plan mode');
  assert.match(h.trigger().title, /without restarting/);
  h.trigger().focus();
  h.pick('bypass');
  assert.deepEqual(h.requests, ['bypass']);
  assert.equal(h.label(), 'Switching to Bypass…');
  assert.notEqual(h.label(), 'Bypass', 'the requested mode is never shown as applied');
  assert.ok(h.trigger().querySelector('.session-spinner'));
  assert.ok(h.root.classList.contains('session-mode-pending'));
  assert.equal(h.root.getAttribute('aria-busy'), 'true');
  assert.equal(h.trigger().getAttribute('aria-disabled'), 'true');
  assert.equal(h.trigger().title, 'Plan mode stays in effect until the agent confirms Bypass.');
  assert.equal(h.root.querySelector('.session-mode-status').textContent, 'Switching to Bypass…');
  assert.equal(h.window.document.activeElement, h.trigger(), 'focus stays on the control');
  h.trigger().click();
  assert.equal(h.window.document.querySelector('.session-mode-menu:not([hidden])'), null, 'a pending control cannot open');
  assert.deepEqual(h.toasts, []);

  // The server's own pending echo changes nothing; its confirmation lands once.
  h.control.update(live('plan', { requested: 'bypass', pending: true }), { startedAt: RUN, running: true });
  assert.equal(h.label(), 'Switching to Bypass…');
  h.control.update(live('bypass'), { startedAt: RUN, running: true });
  assert.equal(h.label(), 'Bypass');
  assert.equal(h.root.classList.contains('session-mode-pending'), false);
  assert.equal(h.root.hasAttribute('aria-busy'), false);
  assert.deepEqual(h.options().map(o => o.dataset.value), ['bypass', 'auto'], 'Plan is not offered once left');
  assert.deepEqual(h.toasts, [{ text: 'Bypass now applies to this run. An action already running is not cancelled.', type: 'success', durationMs: 5000 }]);
  h.control.update(live('bypass'), { startedAt: RUN, running: true });
  assert.equal(h.toasts.length, 1, 'a repeated state frame toasts nothing');
  assert.equal(h.window.document.activeElement, h.trigger());
});

test('a failed Auto → Bypass toasts the reason once, keeps Auto on screen and marks the control until the toast is gone', tc => {
  const h = harness(tc);
  h.control.update(live('auto'), { startedAt: RUN, running: true });
  assert.deepEqual(h.options().map(o => o.dataset.value), ['auto', 'bypass']);
  h.pick('bypass');
  const failure = live('auto', { requested: 'bypass', error: { code: 'EPERMISSION_MODE', reason: 'unconfirmed', message: 'The provider did not confirm the requested permission mode.' } });
  h.control.update(failure, { startedAt: RUN, running: true });
  assert.equal(h.label(), 'Auto mode');
  assert.deepEqual(h.toasts, [{ text: "Couldn't switch to Bypass: the agent didn't confirm the new mode. This run stays in Auto mode.", type: 'error', durationMs: 9000 }]);
  assert.ok(h.root.classList.contains('session-mode-error'));
  assert.equal(h.trigger().title, h.toasts[0].text);
  h.control.update(failure, { startedAt: RUN, running: true });
  assert.equal(h.toasts.length, 1, 'later frames still carrying the error stay quiet');
  // A retry that fails the same way is a new outcome.
  h.pick('bypass');
  h.control.update(failure, { startedAt: RUN, running: true });
  assert.equal(h.toasts.length, 2);
});

test('an unsupported refusal turns the selector back into the static chip; a request that never left the client reverts at once', tc => {
  const h = harness(tc, { request: mode => (mode === 'auto' ? { ok: false, reason: 'offline' } : { ok: true, state: live('plan', { requested: mode, pending: true }) }) });
  h.control.update(live('plan'), { startedAt: RUN, running: true });
  h.pick('auto');
  assert.equal(h.label(), 'Plan mode', 'the picked row never stays on the trigger');
  assert.equal(h.trigger().getAttribute('aria-disabled'), null);
  assert.equal(h.toasts.at(-1).text, "Couldn't switch to Auto mode: the terminal isn't connected. Try again once it reconnects. This run stays in Plan mode.");
  h.pick('bypass');
  h.control.update(live('plan', { requested: 'bypass', error: { code: 'EPERMISSION_MODE', reason: 'unsupported', message: '' } }), { startedAt: RUN, running: true });
  assert.equal(h.toasts.at(-1).text, "Couldn't switch to Bypass: this agent can't change permission mode while it runs. This run stays in Plan mode.");
  assert.equal(h.trigger(), null, 'the selector is hidden for this run');
  assert.equal(h.root.querySelector('.session-mode-chip').textContent, 'Plan mode');
});

test('reattach: a seeded pending request resolves through the replay; a replayed outcome this view never requested stays quiet', tc => {
  const h = harness(tc);
  h.control.update(live('plan', { requested: 'auto', pending: true }), { startedAt: RUN, running: true });
  assert.equal(h.label(), 'Switching to Auto mode…');
  h.control.update(live('auto'), { startedAt: RUN, running: true });
  assert.equal(h.label(), 'Auto mode');
  assert.equal(h.toasts.at(-1).type, 'success');

  const quiet = harness(tc);
  quiet.control.update(live('bypass', { requested: 'auto', error: { code: 'EPERMISSION_MODE', reason: 'failed', message: '' } }), { startedAt: RUN, running: true });
  assert.equal(quiet.label(), 'Bypass');
  assert.deepEqual(quiet.toasts, []);
  assert.equal(quiet.root.classList.contains('session-mode-error'), false);
  // A newer run's state is not this request's outcome either.
  quiet.pick('auto');
  quiet.control.update(live('plan'), { startedAt: RUN + 1, running: true });
  assert.deepEqual(quiet.toasts, []);
  assert.equal(quiet.label(), 'Plan mode');
});

test('once the process stops the chip shows the confirmed mode, never an unfinished request; Ukrainian copy', tc => {
  const h = harness(tc);
  h.control.update(live('plan', { requested: 'bypass', pending: true }), { startedAt: RUN, running: true });
  h.control.stop();
  assert.equal(h.trigger(), null);
  assert.equal(h.label(), 'Plan mode');
  assert.equal(h.root.classList.contains('session-mode-pending'), false);
  setLocale('uk');
  const uk = harness(tc);
  uk.control.update(live('plan', { requested: 'auto', pending: true }), { startedAt: RUN, running: true });
  assert.equal(uk.label(), 'Перемикання на «Автоматичний режим»…');
  uk.control.update(live('auto'), { startedAt: RUN, running: true });
  assert.equal(uk.toasts.at(-1).text, 'Тепер у цьому запуску діє «Автоматичний режим». Дію, що вже виконується, не буде скасовано.');
});
