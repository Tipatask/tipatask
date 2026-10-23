'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { raiseWindow, resolveShowMoreTarget, resolveClickTarget, createRaiseDeps, trackOnScreen, onScreen, appBundlePath,
  OPEN_TIMEOUT_MS } = require('../../main/notify-target');

// Window stub: `takesFocusAfter` = number of focus calls needed before it is really focused.
function fakeWindow({ takesFocusAfter = 1, visible = true, minimized = false, project = null } = {}) {
  const w = { focusCalls: 0, destroyed: false, project, name: project,
    isDestroyed: () => w.destroyed, isVisible: () => visible, isMinimized: () => minimized,
    isFocused: () => w.focusCalls >= takesFocusAfter };
  return w;
}
const focus = (w) => { w.focusCalls += 1; return true; };
const wait = async () => {};
const raise = (w) => raiseWindow(w, { focus, wait });

test('raiseWindow confirms focus and repeats it until the window is really focused', async () => {
  const easy = fakeWindow();
  assert.equal(await raise(easy), true);
  assert.equal(easy.focusCalls, 1, 'a window that takes focus is focused once');

  // The app activated but the banner panel stayed key: the second call wins.
  const late = fakeWindow({ takesFocusAfter: 2 });
  assert.equal(await raise(late), true);
  assert.equal(late.focusCalls, 2);

  const never = fakeWindow({ takesFocusAfter: Infinity });
  assert.equal(await raise(never), false);
  assert.equal(never.focusCalls, 4, 'bounded: the first call plus three repeats');

  const closing = fakeWindow({ takesFocusAfter: Infinity });
  assert.equal(await raiseWindow(closing, { focus, wait: async () => { closing.destroyed = true; } }), false);
  assert.equal(await raise(null), false);
  assert.equal(await raiseWindow(fakeWindow(), { focus: () => false, wait }), false);
});

test('Show More: own window, then any open project window, then the project reopened', async () => {
  const origin = { projectPath: '/a', windowId: 1 };
  const own = fakeWindow({ project: '/a' });
  const other = fakeWindow({ project: '/b' });
  const reopened = [];
  const deps = (over = {}) => ({ originWindow: () => own, projectWindows: () => [other, own], raise,
    reopen: async (dir) => { reopened.push(dir); return fakeWindow({ project: dir }); }, ...over });

  assert.equal(await resolveShowMoreTarget(origin, deps()), own);
  assert.equal(other.focusCalls, 0, 'no other window is touched when the own one comes forward');

  // Own window closed: another open project window takes the list, nothing is reopened.
  assert.equal(await resolveShowMoreTarget(origin, deps({ originWindow: () => null, projectWindows: () => [other] })), other);
  assert.deepEqual(reopened, []);

  // Own window will not take focus: the next window that does wins; usable ones go first.
  const stuck = fakeWindow({ project: '/a', takesFocusAfter: Infinity });
  const minimized = fakeWindow({ project: '/c', minimized: true });
  const visible = fakeWindow({ project: '/b' });
  assert.equal(await resolveShowMoreTarget(origin,
    deps({ originWindow: () => stuck, projectWindows: () => [minimized, stuck, visible] })), visible);
  assert.equal(minimized.focusCalls, 0);

  // Nothing takes focus: the list still goes to the first live candidate.
  assert.equal(await resolveShowMoreTarget(origin, deps({ originWindow: () => stuck, projectWindows: () => [stuck] })), stuck);

  // No project window left: the alert's project is reopened and raised.
  const fresh = await resolveShowMoreTarget(origin, deps({ originWindow: () => null, projectWindows: () => [] }));
  assert.deepEqual(reopened, ['/a']);
  assert.equal(fresh.project, '/a');
  assert.equal(fresh.focusCalls, 1);

  // Nothing to reopen (no project path, or the reopen was refused).
  assert.equal(await resolveShowMoreTarget({ windowId: 1 }, deps({ originWindow: () => null, projectWindows: () => [] })), null);
  assert.equal(await resolveShowMoreTarget(origin,
    deps({ originWindow: () => null, projectWindows: () => [], reopen: async () => null })), null);
});

test('card click: the window owning the project now, else the project reopened — raised once', async () => {
  const origin = { projectPath: '/a', windowId: 1 };
  const own = fakeWindow({ project: '/a' });
  const reopened = [];
  let raised = [];
  const deps = (over = {}) => ({ originWindow: () => own, projectOf: (w) => w.project,
    reopen: async (dir) => { reopened.push(dir); return fakeWindow({ project: dir }); },
    raise: async (w) => { raised.push(w); return raise(w); }, ...over });

  assert.equal(await resolveClickTarget(origin, deps()), own);
  assert.deepEqual(reopened, []);
  assert.deepEqual(raised, [own], 'the verified raise Show More uses, once');
  assert.equal(own.focusCalls, 1);

  // The sending window was rebound to another project: never act there, reopen the project.
  raised = [];
  const rebound = fakeWindow({ project: '/other' });
  const fresh = await resolveClickTarget(origin, deps({ originWindow: () => rebound }));
  assert.equal(fresh.project, '/a');
  assert.deepEqual(raised, [fresh], 'the reopened window is raised, never the rebound one');
  assert.equal(rebound.focusCalls, 0);
  // The window is gone.
  raised = [];
  const reopenedWindow = await resolveClickTarget(origin, deps({ originWindow: () => null }));
  assert.equal(reopenedWindow.project, '/a');
  assert.deepEqual(raised, [reopenedWindow]);
  assert.deepEqual(reopened, ['/a', '/a']);

  // An alert from a window with no project keeps routing to that window while it lives.
  raised = [];
  const unbound = fakeWindow();
  assert.equal(await resolveClickTarget({ windowId: 2 }, deps({ originWindow: () => unbound })), unbound);
  assert.deepEqual(raised, [unbound]);
  raised = [];
  assert.equal(await resolveClickTarget({ windowId: 2 }, deps({ originWindow: () => null })), null);
  assert.equal(await resolveClickTarget(origin, deps({ originWindow: () => null, reopen: async () => null })), null);
  assert.deepEqual(raised, [], 'nothing to raise without a window');
});

test('card click: resolves only after the raise settled, keeps a window that would not focus', async () => {
  const origin = { projectPath: '/a', windowId: 1 };
  const own = fakeWindow({ project: '/a' });
  let finish;
  const deps = (over = {}) => ({ originWindow: () => own, projectOf: (w) => w.project, reopen: async () => null,
    raise: () => new Promise((resolve) => { finish = resolve; }), ...over });

  let resolved = null;
  const pending = resolveClickTarget(origin, deps()).then((w) => { resolved = w; });
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, null, 'the click is not delivered while the window is still being raised');
  finish(false);
  await pending;
  assert.equal(resolved, own, 'a window that would not take focus still receives the click');

  // The window closed during the raise: nothing to deliver to.
  const closing = fakeWindow({ project: '/a' });
  assert.equal(await resolveClickTarget(origin, deps({ originWindow: () => closing,
    raise: async () => { closing.destroyed = true; return false; } })), null);
});

// (TPT9056) The raise ladder: fallbacks run in order, only when they apply, each followed by
// the same verified focus; `end` runs after its stage whatever happened.
test('raiseWindow: fallbacks run in order when they apply, with a verified focus each; end always runs', async () => {
  const calls = [];
  const stage = (name, { applies = () => true, began = true } = {}) => ({ name,
    applies: (t) => { calls.push(`applies:${name}`); return applies(t); },
    begin: () => { calls.push(`begin:${name}`); return began; },
    end: () => { calls.push(`end:${name}`); } });
  const traces = [];
  const trace = (t) => traces.push(t);

  // Confirmed only once the second stage began: the first applies but does not help, a stage
  // that does not apply is skipped, later ones never run.
  const w = fakeWindow({ takesFocusAfter: Infinity });
  const confirm = (t) => t.focusCalls > 0 && calls.includes('begin:second');
  assert.equal(await raiseWindow(w, { focus, confirm, wait, trace,
    fallbacks: [stage('skipped', { applies: () => false }), stage('first'), stage('second'), stage('never')] }), true);
  assert.deepEqual(calls, ['applies:skipped', 'applies:first', 'begin:first', 'end:first', 'applies:second', 'begin:second', 'end:second']);
  assert.deepEqual(traces, [{ stage: 'second', ok: true, stages: ['focus', 'first', 'second'] }]);
  assert.equal(w.focusCalls, 1 + 3 + 1 + 2 + 1, 'bounded: the primary loop, then one focus plus two retries per stage that ran');

  // A stage whose begin refuses (false, or throws) is skipped without a focus or an end.
  calls.length = 0; traces.length = 0;
  assert.equal(await raiseWindow(fakeWindow({ takesFocusAfter: Infinity }), { focus, confirm: () => false, wait, trace,
    fallbacks: [stage('refused', { began: false }), { name: 'broken', applies: () => true, begin: () => { throw new Error('x'); } }, stage('tried')] }), false);
  assert.deepEqual(calls, ['applies:refused', 'begin:refused', 'applies:tried', 'begin:tried', 'end:tried']);
  assert.deepEqual(traces, [{ stage: 'tried', ok: false, stages: ['focus', 'refused', 'broken', 'tried'] }]);

  // No fallback at all reports the plain outcome; a window destroyed inside a stage ends it
  // without end() and without a result.
  traces.length = 0;
  assert.equal(await raiseWindow(fakeWindow({ takesFocusAfter: Infinity }), { focus, wait, trace }), false);
  assert.deepEqual(traces, [{ stage: 'focus', ok: false, stages: ['focus'] }]);
  calls.length = 0;
  const closing = fakeWindow({ takesFocusAfter: Infinity });
  assert.equal(await raiseWindow(closing, { focus, confirm: () => false, wait,
    fallbacks: [{ name: 'closing', applies: () => true, begin: () => { closing.destroyed = true; return true; }, end: () => calls.push('end:closing') }] }), false);
  assert.deepEqual(calls, []);
  // The default trace is a no-op; the default confirm is the key window, as before.
  assert.equal(await raiseWindow(fakeWindow({ takesFocusAfter: 2 }), { focus, wait, fallbacks: [stage('unused')] }), true);
  assert.deepEqual(calls, []);
});

function fakeApp({ active = true, hidden = false } = {}) {
  return { active, hidden, isActive() { return this.active; }, isHidden() { return this.hidden; } };
}
function macWindow(over = {}) {
  const w = fakeWindow(over);
  w.workspaces = [];
  w.setVisibleOnAllWorkspaces = (visible, options) => w.workspaces.push({ visible, options });
  return w;
}
const EXE = '/Applications/TipATask.app/Contents/MacOS/TipATask';

test('createRaiseDeps: macOS confirms key + not minimized + app active + on screen; other platforms add nothing', () => {
  assert.deepEqual(createRaiseDeps({ app: fakeApp(), platform: 'win32', execPath: EXE, exec: () => {} }), {});
  assert.deepEqual(createRaiseDeps({ app: fakeApp(), platform: 'linux', execPath: EXE, exec: () => {} }), {});
  assert.deepEqual(createRaiseDeps({ platform: 'darwin', execPath: EXE, exec: () => {} }), {}, 'no app, no checks');
  const app = fakeApp();
  const screen = new Map();
  const deps = createRaiseDeps({ app, platform: 'darwin', exec: () => {}, execPath: EXE, onScreen: (w) => screen.get(w) !== false });
  assert.deepEqual(deps.fallbacks.map((f) => f.name), ['launch-services', 'active-space']);
  const w = macWindow();
  assert.equal(deps.confirm(w), false, 'not key yet');
  focus(w);
  assert.equal(deps.confirm(w), true);
  app.active = false;
  assert.equal(deps.confirm(w), false, 'key but the app is not active');
  app.active = true;
  screen.set(w, false);
  assert.equal(deps.confirm(w), false, 'key and active but off screen (another Space, covered)');
  screen.set(w, true);
  assert.equal(deps.confirm(w), true);
  const minimized = macWindow({ minimized: true });
  focus(minimized);
  assert.equal(deps.confirm(minimized), false);
  const throwing = createRaiseDeps({ app: { isActive() { throw new Error('gone'); } }, platform: 'darwin', exec: () => {}, execPath: EXE });
  assert.equal(throwing.confirm(w), true, 'an unreadable activation state never blocks a confirmed raise');
});

test('launch-services fallback opens this .app bundle, only while the app is not active', async () => {
  const opened = [];
  const exec = (file, args, options, callback) => { opened.push({ file, args, timeout: options.timeout }); callback(null); };
  const app = fakeApp({ active: false });
  const deps = createRaiseDeps({ app, platform: 'darwin', exec, execPath: EXE });
  const [ls] = deps.fallbacks;
  assert.equal(ls.applies(macWindow()), true);
  assert.equal(await ls.begin(), true);
  assert.deepEqual(opened, [{ file: 'open', args: ['-a', '/Applications/TipATask.app'], timeout: OPEN_TIMEOUT_MS }]);
  app.active = true;
  assert.equal(ls.applies(macWindow()), false, 'an active app needs no LaunchServices open');
  assert.equal(ls.end, undefined);

  const failing = createRaiseDeps({ app: fakeApp({ active: false }), platform: 'darwin', execPath: EXE,
    exec: (_file, _args, _options, callback) => callback(new Error('open: timed out')) });
  assert.equal(await failing.fallbacks[0].begin(), false, 'a failed open is reported, not thrown');
  const throwing = createRaiseDeps({ app: fakeApp({ active: false }), platform: 'darwin', execPath: EXE, exec: () => { throw new Error('ENOENT'); } });
  assert.equal(await throwing.fallbacks[0].begin(), false);
  const noBundle = createRaiseDeps({ app: fakeApp({ active: false }), platform: 'darwin', exec, execPath: '/usr/local/bin/electron' });
  assert.equal(noBundle.fallbacks[0].applies(macWindow()), false, 'not inside an .app: nothing to open');
  const noExec = createRaiseDeps({ app: fakeApp({ active: false }), platform: 'darwin', execPath: EXE });
  assert.equal(noExec.fallbacks[0].applies(macWindow()), false, 'no exec injected: never applies');

  assert.equal(appBundlePath(EXE), '/Applications/TipATask.app');
  assert.equal(appBundlePath('/Users/x/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    '/Users/x/repo/node_modules/electron/dist/Electron.app');
  assert.equal(appBundlePath('/usr/local/bin/node'), null);
  assert.equal(appBundlePath(''), null);
  assert.equal(appBundlePath(null), null);
});

test('active-space fallback joins every Space for the raise and settles the window on the current one', async () => {
  const app = fakeApp();
  const screen = new Map();
  const deps = createRaiseDeps({ app, platform: 'darwin', exec: () => {}, execPath: EXE, onScreen: (w) => screen.get(w) !== false });
  const [, space] = deps.fallbacks;
  const w = macWindow();
  assert.equal(space.applies(w), false, 'on screen (unknown counts as on screen)');
  screen.set(w, false);
  assert.equal(space.applies(w), true, 'active app, window off screen');
  app.active = false;
  assert.equal(space.applies(w), false, "an inactive app is the LaunchServices stage's job");
  app.active = true;
  const minimized = macWindow({ minimized: true });
  screen.set(minimized, false);
  assert.equal(space.applies(minimized), false, 'a minimized window is restored by focus, not pulled');
  assert.equal(space.begin(w), true);
  space.end(w);
  assert.deepEqual(w.workspaces, [{ visible: true, options: { skipTransformProcessType: true } },
    { visible: false, options: { skipTransformProcessType: true } }]);

  // Through raiseWindow: the window is key but off screen after the focus loop, comes on screen
  // once it joined every Space, and is pinned to the current Space afterwards.
  const far = macWindow();
  screen.set(far, false);
  const seq = [];
  far.setVisibleOnAllWorkspaces = (visible) => { seq.push(visible ? 'join' : 'leave'); if (visible) screen.set(far, true); };
  const traces = [];
  assert.equal(await raiseWindow(far, { focus: (t) => { seq.push('focus'); return focus(t); }, ...deps, wait, trace: (t) => traces.push(t) }), true);
  assert.deepEqual(traces, [{ stage: 'active-space', ok: true, stages: ['focus', 'active-space'] }]);
  assert.deepEqual(seq, ['focus', 'focus', 'focus', 'focus', 'join', 'focus', 'leave']);

  // The app never activated: LaunchServices runs first, and the Space stage only if still needed.
  const inactive = fakeApp({ active: false });
  const opened = [];
  const late = createRaiseDeps({ app: inactive, platform: 'darwin', execPath: EXE, onScreen: (w) => screen.get(w) !== false,
    exec: (_f, _a, _o, callback) => { opened.push(1); inactive.active = true; callback(null); } });
  const target = macWindow();
  assert.equal(await raiseWindow(target, { focus, ...late, wait, trace: (t) => traces.push(t) }), true);
  assert.deepEqual(opened, [1]);
  assert.equal(traces.at(-1).stage, 'launch-services');
  assert.deepEqual(target.workspaces, [], 'on screen once active: no Space pull');
});

test('trackOnScreen follows show/hide events; untracked windows count as on screen', () => {
  const w = new EventEmitter();
  w.isDestroyed = () => false;
  assert.equal(onScreen(w), true);
  trackOnScreen(w);
  assert.equal(onScreen(w), true, 'unknown until the first event');
  w.emit('hide');
  assert.equal(onScreen(w), false);
  w.emit('show');
  assert.equal(onScreen(w), true);
  trackOnScreen(w);
  assert.equal(w.listenerCount('show'), 1, 'tracking is idempotent');
  trackOnScreen(null);
  const gone = new EventEmitter();
  gone.isDestroyed = () => true;
  trackOnScreen(gone);
  assert.equal(gone.listenerCount('hide'), 0, 'a destroyed window is left alone');
});
