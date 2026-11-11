import { api } from './api-client.js';
import { t } from './i18n.js';

let generation = 0;
let loaded = null;
let saving = null;
const wired = new WeakSet();
let listening = false;
const toggleElement = () => document.getElementById('settings-remote-control-toggle');
const projectQuery = () => new URLSearchParams(location.search).get('projectPath');

function showNotice(key, failed = false) {
  const notice = document.getElementById('settings-remote-control-notice');
  if (!notice) return;
  notice.hidden = !key;
  notice.textContent = key ? t(key) : '';
  notice.setAttribute('role', failed ? 'alert' : 'status');
}

// Re-read on every Settings open. A pending save finishes before a reopened dialog reads it.
export async function populateRemoteControlSettings() {
  const current = ++generation;
  const toggle = toggleElement();
  if (!toggle) return;
  loaded = null;
  toggle.disabled = true;
  toggle.checked = false;
  showNotice();
  const query = projectQuery();
  try {
    await saving;
    const context = await api.project.config();
    if (current !== generation) return;
    if (query !== projectQuery()) return populateRemoteControlSettings();
    if (!context?.projectPath || !context.config?.API_BASE_URL || !context.config.API_PROJECT_ID) {
      showNotice('settings.remoteControl.unavailable');
      return;
    }
    if (context.remoteControl?.available !== true) {
      showNotice('settings.remoteControl.desktopRequired');
      return;
    }
    loaded = { projectPath: context.projectPath, query, enabled: context.remoteControl.enabled === true,
      context: context.remoteControl.context };
    toggle.checked = loaded.enabled;
    toggle.disabled = false;
    if (context.remoteControl.migrationRequired) showNotice('settings.remoteControl.confirmAgain');
  } catch {
    if (current === generation) showNotice('settings.remoteControl.loadFailed', true);
  }
}

async function saveRemoteControlSetting() {
  if (saving || !loaded) return;
  const context = loaded;
  if (context.query !== projectQuery()) return populateRemoteControlSettings();
  const current = generation;
  const toggle = toggleElement();
  const enabled = toggle.checked;
  const restoreFocus = document.activeElement === toggle;
  toggle.disabled = true;
  showNotice();
  const pending = api.project.setRemoteControl(enabled, context.context, context.projectPath)
    .then(result => {
      if (current !== generation) return;
      context.enabled = enabled;
      context.context = result.remoteControl.context;
      showNotice(enabled ? 'settings.remoteControl.enabled' : 'settings.remoteControl.disabled');
    }, () => {
      if (current !== generation) return;
      toggle.checked = context.enabled;
      showNotice('settings.remoteControl.saveFailed', true);
    })
    .finally(() => {
      if (saving === pending) saving = null;
      if (current === generation) {
        toggle.disabled = false;
        if (restoreFocus && (document.activeElement === document.body || document.activeElement === toggle)) {
          toggle.focus({ preventScroll: true });
        }
      }
    });
  saving = pending;
  await pending;
}

export function initRemoteControlSettings() {
  if (!listening && window.electronAPI?.onRemoteControlChanged) {
    listening = true;
    window.electronAPI.onRemoteControlChanged(() => populateRemoteControlSettings());
  }
  const toggle = toggleElement();
  if (!toggle || wired.has(toggle)) return;
  wired.add(toggle);
  toggle.addEventListener('change', saveRemoteControlSetting);
}
