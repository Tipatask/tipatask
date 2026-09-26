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

  function onViewportScroll() {
    // Renderer scroll events leave the buffer where parsing last put it. Native
    // scrollbar/selection scrolling changes it, including while writes are queued.
    const position = term.buffer.active.viewportY;
    if (position !== settledViewport) {
      cancelFollow();
      following = !inputFrame && _isPinnedToBottom(term);
      settledViewport = position;
    }
  }

  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
    term.element.addEventListener(type, onScrollInput, { capture: true, passive: true });
  }
  viewport?.addEventListener('scroll', onViewportScroll);

  function scrollIfFollowing() {
    if (disposed) return;
    if (following && !inputFrame) term.scrollToBottom();
    settledViewport = term.buffer.active.viewportY;
  }

  return {
    write(data, callback) {
      if (disposed) return;
      const pinned = _isPinnedToBottom(term);
      if (!pending && !frame) following = pinned && !inputFrame;
      else if (pinned && !inputFrame) following = true;
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
          frame = requestAnimationFrame(() => {
            frame = 0;
            scrollIfFollowing();
          });
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
    },
  };
}
