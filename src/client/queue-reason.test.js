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
