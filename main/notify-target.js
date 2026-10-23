'use strict';

// Target-window selection and verified raise for desktop notification actions: the banner's
// Show More and card clicks (main/desktop-notifications.js → main.js onShowMore/onClick).
// No `electron` import — every dependency is injected, so the rules are unit-testable.

const path = require('node:path');

// Waits between focus attempts. A window that takes focus normally is confirmed on the first
// check; the later ones cover a Space switch still in flight.
const RAISE_RETRY_MS = [150, 300, 450];
// Shorter confirm loop after a fallback stage: the app has already had its first chance.
const FALLBACK_RETRY_MS = [150, 300];
// Longest wait for the LaunchServices `open` fallback.
const OPEN_TIMEOUT_MS = 1500;

const alive = (w) => !!w && !w.isDestroyed();
const usable = (w) => alive(w) && w.isVisible() && !w.isMinimized();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "On screen" per window, from Electron's macOS `show`/`hide` events: they follow the window's
// occlusion state (covered by another window, moved out of view by a Space switch, minimized),
// not just show()/hide(). `isVisible()` cannot tell — on macOS it is true for a window that is
// ordered in and not minimized, covered or not. An untracked window counts as on screen, so no
// fallback ever runs on a guess.
const screenState = new WeakMap();
function trackOnScreen(w) {
  if (!alive(w) || screenState.has(w)) return;
  screenState.set(w, null);
  w.on('show', () => screenState.set(w, true));
  w.on('hide', () => screenState.set(w, false));
}
const onScreen = (w) => screenState.get(w) !== false;

// The confirm loop: checks `confirm` after each wait and re-issues `focus` while it is false.
async function settle(w, { focus, confirm, wait, retryMs }) {
  for (const ms of retryMs) {
    await wait(ms);
    if (!alive(w)) return false;
    if (confirm(w)) return true;
    focus(w);
  }
  await wait(retryMs.at(-1) ?? 0);
  return alive(w) && confirm(w);
}

// Brings `w` in front of the user and resolves true once `confirm(w)` holds (the window is key,
// by default; createRaiseDeps() adds "on screen" and "the app is active" on macOS). `focus` is
// issued, then verified and re-issued a few times: one call is not proof — macOS can activate
// the app yet leave the always-on-top banner panel key (the user sits on another app's
// fullscreen Space), or make a window on another Space key without ever showing it. When that
// still fails, each applicable `fallback` — { name, applies(w), begin(w), end?(w) } — runs in
// turn, followed by the same verified focus; `end` runs after its stage whatever the outcome.
// `trace` gets one { stage, ok, stages } at the end.
async function raiseWindow(w, { focus, confirm = (target) => target.isFocused(), fallbacks = [], wait = sleep,
  retryMs = RAISE_RETRY_MS, fallbackRetryMs = FALLBACK_RETRY_MS, trace = () => {} } = {}) {
  if (!alive(w) || !focus(w)) return false;
  const stages = ['focus'];
  if (await settle(w, { focus, confirm, wait, retryMs })) {
    trace({ stage: 'focus', ok: true, stages });
    return true;
  }
  for (const fallback of fallbacks) {
    if (!alive(w) || !fallback.applies(w)) continue;
    stages.push(fallback.name);
    let began = false;
    try { began = !!(await fallback.begin(w)); } catch { began = false; }
    if (!began) continue;
    let ok = false;
    try {
      if (alive(w) && focus(w)) ok = await settle(w, { focus, confirm, wait, retryMs: fallbackRetryMs });
    } finally {
      if (fallback.end && alive(w)) { try { await fallback.end(w); } catch { /* best effort */ } }
    }
    if (ok) {
      trace({ stage: fallback.name, ok: true, stages });
      return true;
    }
  }
  const ok = alive(w) && confirm(w);
  trace({ stage: stages.at(-1), ok, stages });
  return ok;
}

// The .app bundle an executable runs from (…/X.app/Contents/MacOS/X → …/X.app), else null.
function appBundlePath(execPath) {
  let dir = execPath ? path.resolve(execPath) : '';
  while (dir && dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// macOS: the checks and fallbacks main.js's focusNotificationTarget() hands to raiseWindow().
// Other platforms get none, so there "confirmed" stays "the window is key".
//   confirm: key, not minimized, the app active, and on screen (trackOnScreen()).
//   launch-services: the app did not activate — `activate` is a request on macOS 14+, which
//     the system may refuse — so the running bundle is opened through LaunchServices
//     (`open -a <bundle>`), which is honored like a Dock click.
//   active-space: the app is active but the window stays off screen, i.e. it lives on another
//     Space (or is covered): it joins every Space for the raise and is then settled on the
//     user's current one.
function createRaiseDeps({ app, platform = process.platform, exec = null, execPath = process.execPath,
  onScreen: isOnScreen = onScreen } = {}) {
  if (platform !== 'darwin' || !app) return {};
  const active = () => { try { return app.isActive(); } catch { return true; } };
  const bundle = appBundlePath(execPath);
  return {
    confirm: (w) => w.isFocused() && !w.isMinimized() && active() && isOnScreen(w),
    fallbacks: [
      { name: 'launch-services',
        applies: () => !active() && !!bundle && typeof exec === 'function',
        begin: () => new Promise((resolve) => {
          let done = false;
          const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
          try { exec('open', ['-a', bundle], { timeout: OPEN_TIMEOUT_MS }, (error) => finish(!error)); }
          catch { finish(false); }
        }) },
      { name: 'active-space',
        applies: (w) => active() && !w.isMinimized() && !isOnScreen(w),
        begin: (w) => { w.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true }); return true; },
        end: (w) => { w.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); } },
    ],
  };
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
// It is raised like Show More's target, and resolves once that raise settled; a window that
// would not take focus is still returned, so the click lands there.
async function resolveClickTarget(origin, { originWindow, projectOf, reopen, raise }) {
  let w = originWindow(origin);
  if (alive(w) && origin?.projectPath && projectOf(w) !== origin.projectPath) w = null;
  if (!alive(w) && origin?.projectPath) w = await reopen(origin.projectPath);
  if (!alive(w)) return null;
  await raise(w);
  return alive(w) ? w : null;
}

module.exports = { raiseWindow, resolveShowMoreTarget, resolveClickTarget, createRaiseDeps, trackOnScreen, onScreen,
  appBundlePath, RAISE_RETRY_MS, FALLBACK_RETRY_MS, OPEN_TIMEOUT_MS };
