'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { raiseWindow, resolveShowMoreTarget, resolveClickTarget } = require('../../main/notify-target');

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

test('card click: the window owning the project now, else the project reopened', async () => {
  const origin = { projectPath: '/a', windowId: 1 };
  const own = fakeWindow({ project: '/a' });
  const reopened = [];
  const deps = (over = {}) => ({ originWindow: () => own, projectOf: (w) => w.project,
    reopen: async (dir) => { reopened.push(dir); return fakeWindow({ project: dir }); }, ...over });

  assert.equal(await resolveClickTarget(origin, deps()), own);
  assert.deepEqual(reopened, []);

  // The sending window was rebound to another project: never act there, reopen the project.
  const rebound = fakeWindow({ project: '/other' });
  assert.equal((await resolveClickTarget(origin, deps({ originWindow: () => rebound }))).project, '/a');
  // The window is gone.
  assert.equal((await resolveClickTarget(origin, deps({ originWindow: () => null }))).project, '/a');
  assert.deepEqual(reopened, ['/a', '/a']);

  // An alert from a window with no project keeps routing to that window while it lives.
  const unbound = fakeWindow();
  assert.equal(await resolveClickTarget({ windowId: 2 }, deps({ originWindow: () => unbound })), unbound);
  assert.equal(await resolveClickTarget({ windowId: 2 }, deps({ originWindow: () => null })), null);
  assert.equal(await resolveClickTarget(origin, deps({ originWindow: () => null, reopen: async () => null })), null);
});
