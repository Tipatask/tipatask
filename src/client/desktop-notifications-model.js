// Pure page model for the always-on-top desktop banner surface (TPT480). No DOM, no IPC —
// node-testable. main/desktop-notifications.js mirrors DESKTOP_PAGE_SIZE for window sizing
// (CJS main cannot import this ES module); keep the two in sync.

export const DESKTOP_PAGE_SIZE = 5;

// `entries` is the main-process snapshot, newest first. The banner window shows only the
// newest page; "Show More" hands the full list to a project window instead of scrolling.
export function desktopPageModel(entries, pageSize = DESKTOP_PAGE_SIZE) {
  const list = Array.isArray(entries) ? entries : [];
  return { total: list.length, visible: list.slice(0, pageSize), hasMore: list.length > pageSize, hidden: Math.max(0, list.length - pageSize) };
}
