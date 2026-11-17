import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { registrationRepairMessage } from './notifications.js';
import { setLocale, t, tc } from './i18n.js';

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = name => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const wiring = source.slice(source.indexOf("  const notifRepairBtn = modal.querySelector('#settings-notifications-repair');"), source.indexOf('  // Apply authoritative per-project theme'));
const installer = '/Volumes/Installer disk/TipATask.app';
const copy = '/tmp/build/TipATask.app';

for (const locale of ['en', 'uk', 'zh', 'es']) {
  test(`Settings keeps repair blockers visible and retries through verified success (${locale})`, async () => {
    const window = new Window();
    setLocale(locale);
    try {
      window.electronAPI = { platform: 'darwin' };
      window.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
      let status = { transport: 'electron', delivery: 'native', permission: 'granted', lastError: 'not-registered', conflicts: 2, installerVolumes: [installer] };
      let result;
      let resolveRepair;
      const toasts = [];
      const context = vm.createContext({
        document: window.document, window, t, tc, registrationRepairMessage,
        getNotificationStatus: () => status,
        refreshNotificationStatus: async () => {},
        getNotificationsOnTop: () => false,
        readNotificationsOnTop: async () => false,
        repairNotificationRegistration: () => new Promise(resolve => { resolveRepair = () => { status = { ...status, ...result.registration, registrationRepair: result }; resolve(result); }; }),
        showToast: (message, kind) => toasts.push({ message, kind }),
      });
      vm.runInContext(`${productionFunction('_notifStatusKey')}\n${productionFunction('_renderSettingsOnTopSwitch')}\n`
        + `${productionFunction('_populateSettingsNotificationsRows')}\nconst modal = document.getElementById('settings-modal');\n${wiring}`, context);
      await context._populateSettingsNotificationsRows();
      const button = window.document.getElementById('settings-notifications-repair');
      const hint = window.document.getElementById('settings-notifications-hint');
      const text = () => window.document.getElementById('settings-notifications-hint-text').textContent;
      assert.match(text(), /Installer disk/);
      assert.ok(!text().includes('"TipATask.app"'));
      for (const next of [
        { ok: false, outcome: 'blocked-installer', registration: { installerVolumes: [installer] } },
        { ok: false, outcome: 'repair-error', reason: 'permission denied', registration: { conflicts: 1, installerVolumes: [] } },
        { ok: false, outcome: 'verification-failed', registration: { conflicts: 1, conflictPaths: [copy], installerVolumes: [] } },
        { ok: false, outcome: 'verification-failed', reason: 'dump timed out', registration: { checked: false, conflicts: null, installerVolumes: [] } },
        { ok: true, outcome: 'verified', relaunchNeeded: true, registration: { conflicts: 0, installerVolumes: [] } },
      ]) {
        result = next;
        button.click();
        assert.equal(button.disabled, true, 'repair stays disabled while IPC is pending');
        resolveRepair();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(button.disabled, false);
        assert.equal(toasts.at(-1).message, registrationRepairMessage(result, t));
        assert.equal(toasts.at(-1).kind, result.ok ? 'success' : 'error');
        if (!result.ok) {
          assert.equal(hint.hidden, false);
          assert.equal(button.hidden, false);
          assert.equal(text(), registrationRepairMessage(result, t));
          await context._populateSettingsNotificationsRows();
          assert.equal(text(), registrationRepairMessage(result, t), 'blocker survives Settings reopen');
        } else {
          assert.equal(button.hidden, true);
          assert.equal(hint.hidden, false, 'Notification Center remains unverified until reopen');
        }
      }
      status = { ...status, delivery: 'desktop', lastError: null };
      await context._populateSettingsNotificationsRows();
      assert.equal(hint.hidden, true);
      assert.equal(button.hidden, true);
    } finally {
      setLocale('en');
      await window.happyDOM.close();
    }
  });
}
