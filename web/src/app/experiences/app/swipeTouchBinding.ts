import { isTouchOwned } from '@/shared/lib/touchOwnership';
import type { SwipeEndResult, SwipeGesture, SwipeSnapshot, SwipeTouch } from './swipeGesture';

export interface SwipeTouchBindingOptions {
  engine: SwipeGesture;
  publish: () => void;
  standDown: (reason: string) => void;
  complete: (end: SwipeEndResult, before: SwipeSnapshot) => void;
  isSettling: () => boolean;
}

function touchFrom(event: TouchEvent): SwipeTouch | null {
  const touch = event.changedTouches?.[0] ?? event.touches?.[0];
  if (!touch) {
    return null;
  }
  // `Touch.identifier` is always present in a real browser. The fallback keeps
  // synthetic events (jsdom, test harnesses) usable; a real sequence never has
  // two concurrent touches without identifiers.
  return {
    identifier: touch.identifier ?? 0,
    clientX: touch.clientX,
    clientY: touch.clientY,
    target: event.target,
  };
}

function findTouch(list: TouchList | undefined, identifier: number): SwipeTouch | null {
  if (!list || list.length === 0) {
    return null;
  }
  for (let index = 0; index < list.length; index += 1) {
    const touch = list[index];
    if (touch && touch.identifier === identifier) {
      return {
        identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        target: touch.target,
      };
    }
  }
  // A synthetic sequence (jsdom, test harnesses) may omit identifiers. With a
  // single touch in the list there is no ambiguity: that touch is the one the
  // engine tracked. Real browser sequences always carry an identifier.
  if (list.length === 1) {
    const touch = list[0];
    if (touch) {
      return {
        identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        target: touch.target,
      };
    }
  }
  return null;
}

/**
 * Bind the App shell's touch listeners for `useSwipePager` (#2724).
 *
 * Touch Events own a physical contact for its whole lifetime, correlated by
 * `Touch.identifier`. Pointer Events are deliberately not consulted for touch:
 * a browser-generated `pointercancel`/`lostpointercapture` races the native
 * touch sequence and must not end a drag the finger is still holding. The
 * listener on the shell root is capture-phase and non-passive only for
 * `touchmove`, and it suppresses nested movement only after the shell has
 * actually claimed a horizontal navigation — ordinary vertical Terminal/TUI
 * scrolling and selection are untouched before the claim and after a visual
 * surrender.
 *
 * Returns the unbind function.
 */
export function bindSwipeTouchListeners(
  root: HTMLElement,
  { engine, publish, standDown, complete, isSettling }: SwipeTouchBindingOptions,
): () => void {
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      if (engine.trackedIdentifier() !== null) {
        standDown('multitouch');
      }
      return;
    }
    if (isSettling()) {
      return;
    }
    // A new single-finger contact means the previous one lost its end. Retire
    // it rather than letting two contacts share one state machine.
    if (engine.trackedIdentifier() !== null) {
      standDown('stale-gesture');
    }
    const touch = touchFrom(event);
    if (touch === null) {
      return;
    }
    if (isTouchOwned(touch.identifier)) {
      return;
    }
    if (engine.start(touch)) {
      publish();
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    const identifier = engine.trackedIdentifier();
    if (identifier === null) {
      return;
    }
    if (event.touches.length !== 1) {
      standDown('multitouch');
      return;
    }
    const touch = findTouch(event.touches, identifier);
    if (touch === null) {
      standDown('finger-lost');
      return;
    }
    // The registry subscription normally stands down first; this is the
    // ordering-independent backstop for a claim made after the touched start.
    if (isTouchOwned(identifier)) {
      standDown('owned-elsewhere');
      return;
    }
    // A non-cancelable move means the browser already committed the contact
    // to native scrolling. The shell cannot take those pixels back, so it
    // must stand down rather than page under a moving buffer.
    if (!event.cancelable) {
      standDown('native-scroll');
      return;
    }

    const result = engine.move(touch);
    publish();
    if (result.preventDefault) {
      event.preventDefault();
      // After the shell owns the drag, the move is navigation's alone. The
      // Terminal, TUI and Capsule must not also consume the same pixels.
      event.stopPropagation();
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    const identifier = engine.trackedIdentifier();
    if (identifier === null) {
      return;
    }
    if (event.touches.length > 0) {
      // Another finger is still down; the owned contact is not this one.
      standDown('multitouch');
      return;
    }
    const touch = findTouch(event.changedTouches, identifier) ?? undefined;
    const before = engine.snapshot();
    const end = engine.end(touch);
    publish();
    complete(end, before);
  };

  const onTouchCancel = (event: TouchEvent) => {
    const identifier = engine.trackedIdentifier();
    if (identifier === null) {
      return;
    }
    if (
      event.changedTouches
      && event.changedTouches.length > 0
      && findTouch(event.changedTouches, identifier) === null
    ) {
      return;
    }
    standDown('native-touchcancel');
  };

  const onHide = () => {
    if (document.visibilityState !== 'visible') {
      standDown('page-hidden');
    }
  };
  const onPageHide = () => {
    standDown('page-hidden');
  };
  const onBlur = () => {
    standDown('window-blur');
  };

  root.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  root.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  root.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  root.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onHide);

  return () => {
    root.removeEventListener('touchstart', onTouchStart, { capture: true });
    root.removeEventListener('touchmove', onTouchMove, { capture: true });
    root.removeEventListener('touchend', onTouchEnd, { capture: true });
    root.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onHide);
  };
}
