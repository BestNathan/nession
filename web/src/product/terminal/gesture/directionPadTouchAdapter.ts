import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalSemanticKey } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import { claimTouchOwnership, releaseAllTouchOwnership } from '@/shared/lib/touchOwnership';
import {
  createDirectionPadEngine,
  type DirectionPadDirection,
  type DirectionPadEngine,
  type DirectionPadState,
} from './directionPadEngine';
import { clampDirectionPadAnchor, type DirectionPadAnchor } from './directionPadGeometry';
import type { DirectionPadView } from './directionPadView';

const ARROW_KEYS: Record<DirectionPadDirection, TerminalSemanticKey> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/** Re-check the tracked target while the pad owns the touch. */
const WATCHDOG_MS = 250;
/** Ignore the browser's compatibility click after a consumed touchend. */
const CLICK_SUPPRESSION_MS = 700;

function findTouch(list: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < list.length; index += 1) {
    const touch = list[index];
    if (touch && touch.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

/**
 * Keep xterm's scroll offset where it was when the pad armed.
 *
 * The gesture's capture listener already consumes every owned touchmove, so
 * nothing should scroll. This is the second guard the interaction contract
 * asks for: a browser that had already started a scroll gesture, or a stale
 * scroll from the pre-arm phase, cannot move the buffer underneath the pad.
 * It is scoped to one viewport and removed on release; ordinary touch
 * scrolling outside the gesture is untouched.
 */
function lockViewportScroll(container: HTMLElement): () => void {
  const viewport = container.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport) {
    return () => {};
  }
  const top = viewport.scrollTop;
  const left = viewport.scrollLeft;
  const onScroll = () => {
    if (viewport.scrollTop !== top) {
      viewport.scrollTop = top;
    }
    if (viewport.scrollLeft !== left) {
      viewport.scrollLeft = left;
    }
  };
  viewport.addEventListener('scroll', onScroll, { passive: true });
  return () => viewport.removeEventListener('scroll', onScroll);
}

export interface DirectionPadTouchAdapterOptions {
  container: HTMLElement;
  controller: TerminalController;
  /** The App shell's reserved edge band, supplied by the App layer. */
  touchEdgeReservation?: (target: EventTarget | null, clientX: number) => boolean;
  onView: (view: DirectionPadView | null) => void;
}

export interface DirectionPadTouchAdapter {
  dispose(): void;
}

/**
 * Browser half of the Mobile Terminal direction pad (#2657).
 *
 * One class owns the touch sequence, the event listeners and the engine; the
 * React hook only mounts it and re-renders from `onView`. A stationary
 * single-finger touch arms after the engine's hold, at which point the adapter
 * claims that `Touch.identifier` in the shared ownership registry and consumes
 * every move/end for it. Before arming nothing is prevented or stopped, so
 * scrolling, taps and the App's edge pager behave exactly as before.
 *
 * Arrow bytes never originate here: directions go through
 * `TerminalController.sendPhysKey`, which asks the interaction controller for
 * the current cursor-key mode. The DOM target that received `touchstart` is
 * watched for the whole gesture; if xterm replaces it (a renderer swap), the
 * gesture is cancelled rather than left with a lost end.
 */
class DirectionPadTouchAdapterImpl implements DirectionPadTouchAdapter {
  private readonly container: HTMLElement;
  private readonly controller: TerminalController;
  private readonly touchEdgeReservation?: (
    target: EventTarget | null,
    clientX: number,
  ) => boolean;
  private readonly onView: (view: DirectionPadView | null) => void;
  private readonly engine: DirectionPadEngine;

  private trackedTarget: Node | null = null;
  private anchor: DirectionPadAnchor | null = null;
  private releaseClaim: (() => void) | null = null;
  private releaseScrollLock: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private suppressClickUntil = 0;
  private viewKey = '';
  private disposed = false;

  constructor({
    container,
    controller,
    touchEdgeReservation,
    onView,
  }: DirectionPadTouchAdapterOptions) {
    this.container = container;
    this.controller = controller;
    this.touchEdgeReservation = touchEdgeReservation;
    this.onView = onView;
    this.engine = createDirectionPadEngine({
      onState: (state) => this.publish(state),
      onArrow: (direction) => this.sendArrow(direction),
    });
    this.bind();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    window.removeEventListener('touchstart', this.onTouchStart, true);
    window.removeEventListener('touchmove', this.onTouchMove, true);
    window.removeEventListener('touchend', this.onTouchEnd, true);
    window.removeEventListener('touchcancel', this.onTouchCancel, true);
    window.removeEventListener('click', this.onClick, true);
    window.removeEventListener('contextmenu', this.onContextMenu, true);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.engine.cancel('unmount');
    this.stopOwnership();
    this.onView(null);
  }

  private bind(): void {
    window.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', this.onTouchCancel, { capture: true, passive: false });
    window.addEventListener('click', this.onClick, true);
    window.addEventListener('contextmenu', this.onContextMenu, true);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private owns(state: DirectionPadState): boolean {
    return state.phase === 'armed' || state.phase === 'moving';
  }

  private publish(state: DirectionPadState): void {
    if (this.owns(state)) {
      this.beginOwnership(state);
    } else if (state.phase === 'idle') {
      // A pending touch still holds its target open; only a finished gesture
      // drops the claim, the scroll lock and the tracked node.
      this.stopOwnership();
    }

    if (!this.owns(state) || this.anchor === null) {
      if (this.viewKey !== '') {
        this.viewKey = '';
        this.onView(null);
      }
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const next: DirectionPadView = {
      phase: state.phase === 'moving' ? 'moving' : 'armed',
      direction: state.direction,
      gear: state.gear,
      rate: state.rate,
      count: state.count,
      anchorX: this.anchor.x,
      anchorY: this.anchor.y,
      originX: state.originX - rect.left,
      originY: state.originY - rect.top,
      showOrigin: this.anchor.showOrigin,
    };
    const key = [
      next.phase,
      next.direction,
      next.gear,
      next.rate,
      next.count,
      next.anchorX,
      next.anchorY,
      next.originX,
      next.originY,
      next.showOrigin,
    ].join('|');
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.onView(next);
    }
  }

  private beginOwnership(state: DirectionPadState): void {
    if (this.anchor === null) {
      const rect = this.container.getBoundingClientRect();
      this.anchor = clampDirectionPadAnchor(
        state.originX - rect.left,
        state.originY - rect.top,
        rect.width,
        rect.height,
      );
    }
    if (this.releaseClaim === null) {
      this.releaseClaim = claimTouchOwnership(
        state.fingerId as number,
        'terminal-direction-pad',
      );
    }
    if (this.releaseScrollLock === null) {
      this.releaseScrollLock = lockViewportScroll(this.container);
    }
    if (this.watchdog === null) {
      this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_MS);
    }
  }

  private stopOwnership(): void {
    this.anchor = null;
    this.trackedTarget = null;
    this.releaseClaim?.();
    this.releaseClaim = null;
    this.releaseScrollLock?.();
    this.releaseScrollLock = null;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private checkLiveness(): void {
    if (this.trackedTarget !== null && !this.trackedTarget.isConnected) {
      this.engine.cancel('touch target detached');
      return;
    }
    if (document.visibilityState !== 'visible') {
      this.engine.cancel('page hidden');
      return;
    }
    if (this.controller.isObserverReadOnly) {
      this.engine.cancel('input lease lost');
    }
  }

  private sendArrow(direction: DirectionPadDirection): void {
    if (this.controller.isObserverReadOnly) {
      this.engine.cancel('input lease lost');
      return;
    }
    this.controller.sendPhysKey({ semanticKey: ARROW_KEYS[direction] });
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    const state = this.engine.snapshot();
    if (event.touches.length !== 1) {
      if (state.phase !== 'idle') {
        this.engine.cancel('multi-touch');
      }
      return;
    }
    if (state.phase !== 'idle') {
      // Only the new finger is down: the previous gesture lost its end.
      // Retire it and begin tracking this touch.
      this.engine.cancel('stale gesture');
    }
    const target = event.target;
    if (!(target instanceof Node) || !this.container.contains(target)) {
      return;
    }
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch) {
      return;
    }
    if (this.touchEdgeReservation?.(target, touch.clientX) === true) {
      return;
    }
    if (this.controller.isObserverReadOnly) {
      return;
    }
    const selection = document.getSelection();
    if (selection !== null && !selection.isCollapsed
      && selection.anchorNode !== null && this.container.contains(selection.anchorNode)) {
      return;
    }
    this.trackedTarget = target;
    this.engine.start(touch.identifier, touch.clientX, touch.clientY);
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const state = this.engine.snapshot();
    if (state.phase === 'idle') {
      return;
    }
    if (event.touches.length !== 1) {
      this.engine.cancel('multi-touch');
      return;
    }
    const touch = findTouch(event.touches, state.fingerId as number);
    if (!touch) {
      this.engine.cancel('finger lost');
      return;
    }
    if (state.phase === 'pending') {
      // The touch has not been claimed yet: native scrolling, the shell pager
      // and selection continue to see every event. A non-cancelable move means
      // the browser already committed it to native scrolling, so the pad must
      // stand down rather than arm under a moving buffer.
      if (!event.cancelable) {
        this.engine.cancel('native scroll took over');
        return;
      }
      this.engine.move(state.fingerId as number, touch.clientX, touch.clientY);
      return;
    }
    if (!event.cancelable) {
      // The browser already committed this touch to native scrolling.
      this.engine.cancel('native scroll took over');
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.engine.move(state.fingerId as number, touch.clientX, touch.clientY);
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    const state = this.engine.snapshot();
    if (state.phase === 'idle') {
      return;
    }
    const touch = findTouch(event.changedTouches, state.fingerId as number);
    if (!touch) {
      return;
    }
    if (this.owns(state)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
    }
    this.engine.end(state.fingerId as number, 'released');
  };

  private readonly onTouchCancel = (event: TouchEvent): void => {
    const state = this.engine.snapshot();
    if (state.phase === 'idle') {
      return;
    }
    if (!findTouch(event.changedTouches, state.fingerId as number)) {
      return;
    }
    if (this.owns(state)) {
      event.stopImmediatePropagation();
    }
    this.engine.cancel('touchcancel');
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (Date.now() >= this.suppressClickUntil || event.detail === 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || !this.container.contains(target)) {
      return;
    }
    this.suppressClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (this.owns(this.engine.snapshot())
      && target instanceof Node && this.container.contains(target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      this.engine.cancel('page hidden');
    }
  };

  private readonly onPageHide = (): void => {
    this.engine.cancel('pagehide');
    releaseAllTouchOwnership();
  };

  private readonly onBlur = (): void => {
    this.engine.cancel('window blur');
  };
}

/** Mount the browser adapter. The caller owns the returned lifecycle. */
export function createDirectionPadTouchAdapter(
  options: DirectionPadTouchAdapterOptions,
): DirectionPadTouchAdapter {
  return new DirectionPadTouchAdapterImpl(options);
}
