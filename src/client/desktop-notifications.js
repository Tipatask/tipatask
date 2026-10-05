import { renderNotificationPage } from './notification-page.js';
import { setLocale } from './i18n.js';

const act = (id, action) => window.desktopNotifications.act(id, action);
const THEME_KEYS = ['bg', 'text', 'muted', 'border', 'primary', 'warning', 'success', 'shadow'];

// The in-app host's palette, forwarded by main so both surfaces look the same. Missing tokens
// fall back to desktop-notifications.css's brand defaults (paper/ink by OS appearance).
function applyTheme(theme) {
  const root = document.documentElement;
  for (const key of THEME_KEYS) {
    if (theme?.[key]) root.style.setProperty(`--tt-notif-${key}`, theme[key]);
    else root.style.removeProperty(`--tt-notif-${key}`);
  }
}

// Fixed-height page: header with Hide (TPT505 — never Clear All here), the five newest cards,
// and a footer with the "Show" on-top checkbox and centered Show More. Never scrolls — the full
// list opens in the newest notification's project window (main's show-more action).
export function renderDesktopPage(state) {
  const entries = Array.isArray(state) ? state : (state?.entries || []);
  applyTheme(Array.isArray(state) ? null : state?.theme);
  if (entries.length) setLocale(entries[0].locale);
  renderNotificationPage(document.body, entries, act, { headerAction: 'hide', onTopToggle: true });
}

window.desktopNotifications.onState(renderDesktopPage);
