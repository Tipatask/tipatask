import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, setLocale, t } from './i18n.js';
import { queueReasonText } from './queue-reason.js';

for (const locale of ['en', 'uk']) {
  test(`${locale}: queue details translate all coordination causes without fallback`, () => {
    setLocale(locale);
    try {
      for (const reason of ['unregistered-server', 'stale-or-orphaned-owner', 'census-unavailable', 'mismatched-policy', 'lock-busy', 'state-invalid']) {
        const key = `queue.coordination.${reason}`;
        assert.ok(Object.hasOwn(LOCALES[locale], key));
        const diagnostic = { reason: 'coordination', [reason.includes('lock') || reason === 'state-invalid' ? 'detail' : 'coordinationReason']: reason };
        assert.equal(queueReasonText(diagnostic), LOCALES[locale][key]);
        assert.doesNotMatch(queueReasonText(diagnostic), /queue\.|\{\w+\}/);
      }
      const diagnostic = { reason: 'coordination', coordinationReason: 'unregistered-server', unregisteredPids: [42, 99] };
      const output = queueReasonText(diagnostic);
      assert.ok(Object.hasOwn(LOCALES[locale], 'queue.coordination.unregistered-server-pids'));
      assert.match(output, /42, 99/); assert.match(output, /2/);
      assert.doesNotMatch(output, /\{\w+\}/);
      assert.equal(queueReasonText({ ...diagnostic, detail: 'lock-busy' }), t('queue.coordination.lock-busy'));
      assert.equal(queueReasonText({ ...diagnostic, reason: 'device-cap' }), `${t('queue.reason.device-cap')} ${output}`);
      assert.equal(queueReasonText({ reason: 'coordination', detail: '\x1b[31mraw error' }), t('queue.reason.coordination'));
      assert.equal(queueReasonText({ reason: 'new-reason' }), t('queue.reason.coordination'));
      assert.equal(queueReasonText({ reason: 'project-cap' }), t('queue.reason.project-cap'));
      assert.doesNotMatch(queueReasonText({ ...diagnostic, unregisteredPids: ['\x1b[31m'] }), /\x1b|undefined/);
    } finally { setLocale('en'); }
  });
}

for (const locale of ['en', 'uk']) {
  test(`${locale}: device-cap waits show actual counts and only supported ramp explanations`, () => {
    setLocale(locale);
    try {
      const at = Date.UTC(2026, 9, 14, 12, 5), before = at - 60000;
      const ramp = { reason: 'device-cap', running: 6, cap: 6, rampCap: 6, rampCeiling: 8, rampNextStepAt: at };
      const base = t('queue.ramp.running', { running: 6, cap: 6 });
      const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      const next = `${base} ${t('queue.ramp.next', { next: 7, time })}`;
      assert.equal(queueReasonText(ramp, before), next);
      assert.ok(next.includes(time));
      assert.equal(queueReasonText({ ...ramp, reason: undefined }, before), next); // a missing reason is a device-cap wait
      // Elapsed or unknown timing makes no promise about a later increase.
      for (const rampNextStepAt of [at, null, 'soon', Number.MAX_SAFE_INTEGER]) {
        assert.equal(queueReasonText({ ...ramp, rampNextStepAt }, at), base);
      }
      const max = t('queue.ramp.running', { running: 8, cap: 8 });
      assert.equal(queueReasonText({ ...ramp, running: 8, cap: 8, rampCap: 8 }, before), max);
      assert.equal(queueReasonText({ ...ramp, running: 8, cap: 8, rampCap: 8, alarm: 'headroom' }, before), max);
      assert.equal(queueReasonText({ ...ramp, coordinationReason: 'stale-or-orphaned-owner' }, before),
        `${base} ${t('queue.ramp.held', { cap: 6, reason: t('queue.coordination.stale-or-orphaned-owner') })}`);
      for (const alarm of ['headroom', 'swap', 'pressure', 'coordination']) {
        const held = `${base} ${t('queue.ramp.held', { cap: 6, reason: t(`queue.ramp.reason.${alarm}`) })}`;
        assert.equal(queueReasonText({ ...ramp, alarm }, before), held, 'alarm overrides a future timestamp');
        assert.equal(queueReasonText({ ...ramp, alarm, rampNextStepAt: null }, before), held);
        assert.doesNotMatch(held, /queue\.|\{\w+\}|undefined|NaN/);
      }
      assert.equal(queueReasonText({ ...ramp, alarm: 'unknown-alarm' }, before), base);
      // Full reservation budget is not the ramp step threshold; do not invent an alarm.
      assert.equal(queueReasonText({ ...ramp, requiredBytes: 100, headroomBytes: 1 }, before), next);
      // Only cap waits mention the limit; static/pressure rows and malformed values add nothing.
      assert.equal(queueReasonText({ ...ramp, reason: 'spacing' }, before), t('queue.reason.spacing'));
      assert.equal(queueReasonText({ reason: 'device-cap', rampCap: null, rampCeiling: null, rampNextStepAt: null }, before), t('queue.reason.device-cap'));
      for (const bad of [{ rampCap: '6' }, { rampCap: 9 }, { rampCap: 0 }, { rampCeiling: null }]) {
        assert.equal(queueReasonText({ ...ramp, ...bad }, before), base, JSON.stringify(bad));
      }
      for (const output of [next, base, max]) {
        assert.doesNotMatch(output, /queue\.|\{\w+\}|undefined|NaN/);
      }
    } finally { setLocale('en'); }
  });
}

test('English device-cap terminal wording uses the effective cap, not the ramp ceiling', () => {
  setLocale('en');
  const text = queueReasonText({ reason: 'device-cap', running: 6, cap: 6, rampCap: 6, rampCeiling: 8 });
  assert.equal(`${t('queue.badge', { position: 1 })}: ${text}`,
    'Queued #1: 6 of 6 agent sessions running. Starts when one finishes.');
});
