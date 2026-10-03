import { pushNotification, dismissNotification, getNotificationEntries } from './notification-center.js';
import { setLocale } from './i18n.js';

window.desktopNotifications.onState((entries) => {
  const ids = new Set(entries.map((entry) => entry.id));
  for (const old of getNotificationEntries()) if (!ids.has(old.tag)) dismissNotification(old.tag);
  // pushNotification prepends. Reverse the snapshot to retain newest-first ordering.
  for (const entry of [...entries].reverse()) {
    setLocale(entry.locale);
    pushNotification({ ...entry, tag: entry.id, showClearAll: false,
      onClick: () => window.desktopNotifications.act(entry.id, 'click'),
      onDismiss: () => window.desktopNotifications.act(entry.id, 'close') });
  }
});
