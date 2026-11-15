'use strict';
// Shared browser machinery for the #3523 App viewport/keyboard Cases.
//
// Native OS keyboards are not reproducible in Chromium, and `window.visualViewport`
// is read-only. The canonical app-owned contract is nevertheless deterministic:
// the App Environment reads offset/width/height/scale from `window.visualViewport`
// and re-reads on its `resize`/`scroll` events. This helper installs a fixture
// visual viewport *before* the app boots and drives those numbers, so the Case
// proves Nession's own geometry/focus/scroll behavior rather than claiming native
// iOS/Android IME animation.
//
// It never changes `window.innerWidth/innerHeight`: a visual-viewport shrink must
// not be confused with a layout resize, and the terminal must not re-fit.

async function installVisualViewportFixture(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const state = {
      offsetLeft: 0,
      offsetTop: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      scale: 1,
    };
    const dispatch = (type) => {
      const event = new Event(type);
      for (const handler of listeners.get(type) ?? []) {
        handler.call(viewport, event);
      }
      const onviewport = viewport['on' + type];
      if (typeof onviewport === 'function') onviewport.call(viewport, event);
    };
    const viewport = {
      get offsetLeft() { return state.offsetLeft; },
      get offsetTop() { return state.offsetTop; },
      get width() { return state.width; },
      get height() { return state.height; },
      get scale() { return state.scale; },
      addEventListener(type, handler) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener(type, handler) {
        listeners.get(type)?.delete(handler);
      },
      dispatchEvent(event) {
        dispatch(event.type);
        return true;
      },
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => viewport,
    });
    window.__nessionViewportFixture = {
      state,
      set(next) {
        Object.assign(state, next);
        dispatch('resize');
      },
      /** Shrink the visible rectangle from the bottom, like a soft keyboard. */
      setKeyboardInset(insetPx) {
        state.offsetTop = 0;
        state.offsetLeft = 0;
        state.width = window.innerWidth;
        state.height = Math.max(0, window.innerHeight - Math.max(0, insetPx));
        state.scale = 1;
        dispatch('resize');
      },
      reset() {
        state.offsetLeft = 0;
        state.offsetTop = 0;
        state.width = window.innerWidth;
        state.height = window.innerHeight;
        state.scale = 1;
        dispatch('resize');
      },
    };
  });
}

async function setKeyboardInset(page, insetPx) {
  await page.evaluate((px) => window.__nessionViewportFixture.setKeyboardInset(px), insetPx);
}

async function setVisualViewport(page, next) {
  await page.evaluate((value) => window.__nessionViewportFixture.set(value), next);
}

/**
 * Remove the API entirely and notify the page. `visibleBounds` must fall back
 * to the layout rectangle and no avoidance/terminal-resize state may appear.
 */
async function removeVisualViewport(page) {
  await page.evaluate(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => undefined,
    });
    window.dispatchEvent(new Event('resize'));
  });
}

/**
 * Every PTY resize this page sends. The keyboard-only contract is **zero**
 * frames; recording frames rather than the final grid is what makes a transient
 * resize impossible to hide.
 */
function recordResizeRequests(page) {
  const requests = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame?.msg_type === 'agent.terminal.resize') {
          requests.push(frame.payload ?? {});
        }
      } catch {
        // A non-JSON frame (control ping, binary) is not a resize.
      }
    });
  });
  return requests;
}

async function resetVisualViewport(page) {
  await page.evaluate(() => window.__nessionViewportFixture.reset());
}

/** The App Environment's published snapshot, as the DOM states it. */
async function viewportEnvironment(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return null;
    const number = (name) => Number(element.dataset[name] ?? 0);
    return {
      revision: number('appViewportRevision'),
      layoutWidth: number('appLayoutWidth'),
      layoutHeight: number('appLayoutHeight'),
      visibleLeft: number('appVisibleLeft'),
      visibleTop: number('appVisibleTop'),
      visibleWidth: number('appVisibleWidth'),
      visibleHeight: number('appVisibleHeight'),
      occludedTop: number('appOccludedTop'),
      occludedRight: number('appOccludedRight'),
      occludedBottom: number('appOccludedBottom'),
      occludedLeft: number('appOccludedLeft'),
      safeAreaTop: number('appSafeAreaTop'),
      safeAreaRight: number('appSafeAreaRight'),
      safeAreaBottom: number('appSafeAreaBottom'),
      safeAreaLeft: number('appSafeAreaLeft'),
      editableFocus: element.dataset.appEditableFocus === 'true',
      keyboard: element.dataset.appKeyboard,
    };
  });
}

/** The Experience scrollport's real scroll range and the focused control. */
async function avoidanceState(page) {
  return page.evaluate(() => {
    const scrollport = document.querySelector('[data-keyboard-avoidance-scrollport]');
    if (!(scrollport instanceof HTMLElement)) return null;
    const active = document.activeElement;
    const targetRect = active instanceof HTMLElement ? active.getBoundingClientRect() : null;
    return {
      scrollTop: scrollport.scrollTop,
      scrollHeight: scrollport.scrollHeight,
      clientHeight: scrollport.clientHeight,
      extent: Number(scrollport.dataset.keyboardAvoidanceExtent ?? 0),
      scrollable: scrollport.getAttribute('data-keyboard-avoidance-scrollable') === 'true',
      overflowY: getComputedStyle(scrollport).overflowY,
      activeTag: active?.tagName ?? null,
      activeTestId: active instanceof HTMLElement ? active.dataset.testid ?? null : null,
      targetBottom: targetRect?.bottom ?? null,
      targetTop: targetRect?.top ?? null,
    };
  });
}

/**
 * Geometry facts that must not move on a keyboard-only change.
 *
 * `rows`/`resizes` come from the fixture's own xterm probe, so a re-fit that
 * returned to the same row count is still visible as a resize.
 */
async function terminalFacts(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    const well = document.querySelector('[data-testid="terminal-well"]');
    const xterm = document.querySelector('.xterm');
    const viewport = document.querySelector('.xterm-viewport');
    if (!(host instanceof HTMLElement) || !(well instanceof HTMLElement)) return null;
    return {
      rows: Number(host.dataset.terminalRows ?? 0),
      resizes: Number(host.dataset.terminalResizes ?? 0),
      hostHeight: host.getBoundingClientRect().height,
      hostWidth: host.getBoundingClientRect().width,
      wellHeight: well.getBoundingClientRect().height,
      xtermCount: document.querySelectorAll('.xterm').length,
      xtermScrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
      xtermIdentity: xterm instanceof HTMLElement ? xterm.getAttribute('data-keyboard-fixture-instance') : null,
    };
  });
}

async function markTerminal(page) {
  await page.evaluate(() => {
    const xterm = document.querySelector('.xterm');
    xterm?.setAttribute('data-keyboard-fixture-instance', 'original');
  });
}

async function focusCapsuleComposer(page) {
  await page.getByTestId('capsule-ghost-input').focus();
}

async function blurActive(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

module.exports = {
  installVisualViewportFixture,
  setKeyboardInset,
  setVisualViewport,
  removeVisualViewport,
  resetVisualViewport,
  recordResizeRequests,
  viewportEnvironment,
  avoidanceState,
  terminalFacts,
  markTerminal,
  focusCapsuleComposer,
  blurActive,
};
