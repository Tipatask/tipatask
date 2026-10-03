// xterm writes are asynchronous and may be parsed in several batches. Keep the
// pre-write follow decision until the queue drains, unless the reader scrolls.
export function _isPinnedToBottom(term) {
  const { viewportY, baseY } = term.buffer.active;
  return viewportY >= baseY;
}

export function createTerminalOutputWriter(term) {
  let pending = 0;
  let following = false;
  let disposed = false;
  let frame = 0;
  let inputFrame = 0;
  let pointerDown = false;
  let settledViewport = term.buffer.active.viewportY;
  const viewport = term.element.querySelector('.xterm-viewport');

  function cancelFollow() {
    following = false;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  // Cancel before xterm/browser scrolling runs, so an already queued write cannot
  // pull the reader back down. Wait for the native scroll to settle before taking
  // another pre-write snapshot (wheel scrolling can be applied on the next frame).
  function onScrollInput(event) {
    if (event.type === 'keydown' && !(event.shiftKey && /^(PageUp|PageDown|Home|End)$/.test(event.key))) return;
    if (event.type === 'pointerdown' && event.target !== viewport) return;
    cancelFollow();
    cancelAnimationFrame(inputFrame);
    inputFrame = requestAnimationFrame(() => {
      inputFrame = requestAnimationFrame(() => {
        inputFrame = 0;
        following = _isPinnedToBottom(term);
        settledViewport = term.buffer.active.viewportY;
      });
    });
  }

  // A held scrollbar or selection can keep scrolling long after the initial
  // pointer event. Renderer-generated scroll events have no such user intent.
  function onPointerDown() { pointerDown = true; }
  function onPointerUp() { pointerDown = false; }

  function onViewportScroll() {
    // Renderer scroll events leave the buffer where parsing last put it. Native
    // scrollbar/selection scrolling changes it, including while writes are queued.
    const position = term.buffer.active.viewportY;
    if (position !== settledViewport) {
      if ((pending || frame) && !inputFrame && !pointerDown) return;
      cancelFollow();
      following = !inputFrame && _isPinnedToBottom(term);
      settledViewport = position;
    }
  }

  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
    term.element.addEventListener(type, onScrollInput, { capture: true, passive: true });
  }
  viewport?.addEventListener('scroll', onViewportScroll);
  term.element.addEventListener('pointerdown', onPointerDown, true);
  const pointerTarget = term.element.ownerDocument || term.element;
  pointerTarget.addEventListener('pointerup', onPointerUp, true);
  pointerTarget.addEventListener('pointercancel', onPointerUp, true);

  function scrollIfFollowing() {
    if (disposed) return;
    if (following && !inputFrame) term.scrollToBottom();
    settledViewport = term.buffer.active.viewportY;
  }

  function captureFollow() {
    const pinned = _isPinnedToBottom(term);
    if (!pending && !frame) following = pinned && !inputFrame;
    else if (pinned && !inputFrame) following = true;
  }

  function settle() {
    cancelAnimationFrame(frame);
    // xterm synchronizes its native viewport in a render frame of its own.
    // Keep the follow decision until that frame and the resulting scroll settle.
    frame = requestAnimationFrame(() => {
      scrollIfFollowing();
      frame = requestAnimationFrame(() => {
        scrollIfFollowing();
        frame = 0;
      });
    });
  }

  return {
    refresh(fit) {
      if (disposed) return;
      captureFollow();
      fit();
      scrollIfFollowing();
      settle();
    },
    write(data, callback) {
      if (disposed) return;
      captureFollow();
      cancelAnimationFrame(frame);
      frame = 0;
      pending++;
      term.write(data, () => {
        if (disposed) return;
        pending--;
        callback?.();
        if (disposed) return;
        scrollIfFollowing();
        if (!pending) {
          // One final pass after the entire queued burst and its layout work.
          settle();
        }
      });
    },
    dispose() {
      disposed = true;
      cancelFollow();
      cancelAnimationFrame(inputFrame);
      for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
        term.element.removeEventListener(type, onScrollInput, true);
      }
      viewport?.removeEventListener('scroll', onViewportScroll);
      term.element.removeEventListener('pointerdown', onPointerDown, true);
      pointerTarget.removeEventListener('pointerup', onPointerUp, true);
      pointerTarget.removeEventListener('pointercancel', onPointerUp, true);
    },
  };
}
