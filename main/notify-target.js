'use strict';

// Target-window selection and verified raise for desktop notification actions: the banner's
// Show More and card clicks (main/desktop-notifications.js → main.js onShowMore/onClick).
// No `electron` import — every dependency is injected, so the rules are unit-testable.

// Waits between focus attempts. A window that takes focus normally is confirmed on the first
// check; the later ones cover a Space switch still in flight.
const RAISE_RETRY_MS = [150, 300, 450];

const alive = (w) => !!w && !w.isDestroyed();
const usable = (w) => alive(w) && w.isVisible() && !w.isMinimized();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Focuses `w` and resolves true once it really is the focused window, re-issuing the focus a
// few times before giving up. One focus call is not proof: macOS can activate the app yet
// leave the always-on-top banner panel key — the user sits on another app's fullscreen Space,
// or the target lives on another Space — so the project window never comes forward.
async function raiseWindow(w, { focus, wait = sleep, retryMs = RAISE_RETRY_MS } = {}) {
  if (!alive(w) || !focus(w)) return false;
  for (const ms of retryMs) {
    await wait(ms);
    if (!alive(w)) return false;
    if (w.isFocused()) return true;
    focus(w);
  }
  await wait(retryMs.at(-1) ?? 0);
  return alive(w) && w.isFocused();
}

// Show More target. Candidates in order: the alert's own window (the window owning its
// project now, else the one that sent it), then every other open project window — visible,
// non-minimized ones first. The first that takes focus wins. When none does, the first live
// candidate still gets the list, so it is there once the user reaches that window. With no
// project window left at all, the alert's project is reopened.
async function resolveShowMoreTarget(origin, { originWindow, projectWindows, reopen, raise }) {
  const candidates = [];
  const add = (w) => { if (alive(w) && !candidates.includes(w)) candidates.push(w); };
  add(originWindow(origin));
  const others = projectWindows().filter(alive);
  others.filter(usable).forEach(add);
  others.forEach(add);
  for (const w of candidates) if (await raise(w)) return w;
  if (candidates.length) return candidates.find(alive) || null;
  const reopened = origin?.projectPath ? await reopen(origin.projectPath) : null;
  if (!alive(reopened)) return null;
  await raise(reopened);
  return alive(reopened) ? reopened : null;
}

// Card click target: only the alert's own project can act on it. The window owning that
// project now (never a window since rebound to another project), else the project reopened.
async function resolveClickTarget(origin, { originWindow, projectOf, reopen }) {
  let w = originWindow(origin);
  if (alive(w) && origin?.projectPath && projectOf(w) !== origin.projectPath) w = null;
  if (!alive(w) && origin?.projectPath) w = await reopen(origin.projectPath);
  return alive(w) ? w : null;
}

module.exports = { raiseWindow, resolveShowMoreTarget, resolveClickTarget, RAISE_RETRY_MS };
