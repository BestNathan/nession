import {
  APP_VIEWPORT_SNAPSHOT_EVENT,
  KEYBOARD_AVOIDANCE_SCROLLABLE_ATTRIBUTE,
  KEYBOARD_AVOIDANCE_TARGET_MOVED_EVENT,
  KEYBOARD_REVEAL_MARGIN_PX,
  findAppViewportEnvironment,
  isEditableElement,
  readPublishedAppViewport,
} from '@/platform/viewport/appViewport';
import { beginTouchAxis, lockTouchAxis } from '@/shared/lib/touchAxis';
import { isTouchOwned } from '@/shared/lib/touchOwnership';

interface OuterScrollGesture {
  tracker: ReturnType<typeof beginTouchAxis>;
  lastY: number;
  /** This contact was handed to the outer page; never switches mid-gesture. */
  outerOwned: boolean;
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

/**
 * The imperative half of the App's keyboard-avoidance scrollport (#3523).
 *
 * Kept out of the React component so the scroll owners, the ephemeral extent
 * and the gesture ownership rule are one reviewable unit. The class writes only
 * to its own scrollport element and the after-content spacer: it never writes
 * a height on the measured work surface, which is why a visual-viewport change
 * cannot reach `TerminalGeometry` or the PTY.
 */
export class KeyboardAvoidanceScroller {
  private resizeObserver: ResizeObserver | null = null;
  private observedTarget: HTMLElement | null = null;
  private cancelScheduled: (() => void) | null = null;
  private gesture: OuterScrollGesture | null = null;
  private environmentRoot: HTMLElement | null = null;
  private attached = false;
  private active = true;
  /** The next frame may move the page to reveal its focused control. */
  private revealIntent = false;
  /**
   * The user has manually spent the outer range since the last reveal. A
   * reconcile caused by an unrelated signal (a composer resize, an input
   * event) must not snap the page back under their finger; only focus, caret
   * movement or changed visible geometry may reveal again.
   */
  private userScrolled = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly extent: HTMLElement,
  ) {}

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.environmentRoot = findAppViewportEnvironment(this.root);
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.schedule(false))
      : null;
    this.environmentRoot?.addEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, this.onSnapshot);
    this.root.addEventListener('focusin', this.onFocusIn);
    this.root.addEventListener('focusout', this.onChange);
    this.root.addEventListener('input', this.onChange);
    this.root.addEventListener(KEYBOARD_AVOIDANCE_TARGET_MOVED_EVENT, this.onTargetMoved);
    this.root.addEventListener('scroll', this.onScroll, { passive: true });
    this.root.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true });
    this.root.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    this.schedule();
  }

  detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
    this.cancelPending();
    this.environmentRoot?.removeEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, this.onSnapshot);
    this.root.removeEventListener('focusin', this.onFocusIn);
    this.root.removeEventListener('focusout', this.onChange);
    this.root.removeEventListener('input', this.onChange);
    this.root.removeEventListener(KEYBOARD_AVOIDANCE_TARGET_MOVED_EVENT, this.onTargetMoved);
    this.root.removeEventListener('scroll', this.onScroll);
    this.root.removeEventListener('touchstart', this.onTouchStart, true);
    this.root.removeEventListener('touchmove', this.onTouchMove, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedTarget = null;
    this.gesture = null;
    this.release();
  }

  /**
   * The layer the user is in changed. Leaving blurs the control that owned the
   * keyboard, so a covered layer cannot keep the visible keyboard open.
   */
  setActive(active: boolean): void {
    const wasActive = this.active;
    this.active = active;
    if (active) {
      this.schedule();
      return;
    }
    this.release();
    if (wasActive) {
      this.blurFocusTarget();
    }
  }

  private readonly onChange = (): void => {
    this.schedule(false);
  };

  private readonly onFocusIn = (): void => {
    this.schedule(true);
  };

  private readonly onTargetMoved = (): void => {
    this.schedule(true);
  };

  private readonly onSnapshot = (): void => {
    this.schedule(true);
  };

  private readonly onScroll = (): void => {
    if (this.isScrollable()) {
      this.root.dataset.keyboardAvoidanceScrollTop = String(this.root.scrollTop);
    }
  };

  private schedule(reveal = true): void {
    if (!this.attached) {
      return;
    }
    if (reveal) {
      this.revealIntent = true;
    }
    this.cancelPending();
    this.cancelScheduled = scheduleFrame(() => {
      this.cancelScheduled = null;
      this.reconcile();
    });
  }

  private cancelPending(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private focusedTarget(): HTMLElement | null {
    const activeElement = typeof document === 'undefined' ? null : document.activeElement;
    return activeElement instanceof HTMLElement
      && this.root.contains(activeElement)
      && isEditableElement(activeElement)
      ? activeElement
      : null;
  }

  private blurFocusTarget(): void {
    const target = this.focusedTarget();
    target?.blur();
  }

  /**
   * Reveal the focused control, or release the range when there is nothing
   * left to reveal. Every position is in scroll-content coordinates
   * (`rect - scrollport.top + scrollTop`), so scrolling cannot feed back into
   * a larger requirement and oscillate.
   */
  private reconcile(): void {
    if (!this.attached || !this.active) {
      return;
    }
    const snapshot = readPublishedAppViewport(this.environmentRoot);
    const target = this.focusedTarget();
    if (!this.environmentRoot || !snapshot || snapshot.keyboard !== 'open' || target === null) {
      this.release();
      return;
    }
    this.observeTarget(target);
    const shellRect = this.environmentRoot.getBoundingClientRect();
    const visibleTopPage = shellRect.top + snapshot.visibleBounds.top;
    const visibleBottomPage = visibleTopPage + snapshot.visibleBounds.height;
    const targetRect = target.getBoundingClientRect();
    const required = this.requiredScroll(target, snapshot.visibleBounds.top + snapshot.visibleBounds.height);
    if (required === 0) {
      this.release();
      return;
    }
    this.extent.style.height = `${required}px`;
    this.root.style.overflowY = 'auto';
    this.root.setAttribute(KEYBOARD_AVOIDANCE_SCROLLABLE_ATTRIBUTE, 'true');
    this.root.dataset.keyboardAvoidanceExtent = String(required);
    const maxScroll = this.maxScroll();
    const revealIntent = this.revealIntent;
    this.revealIntent = false;
    // Reveal only when the control is outside the visible rectangle **and**
    // either this frame was told to (focus/caret/geometry) or the user has not
    // manually spent the range. A resize-observer or input event must not snap
    // the page back under the user's finger.
    const needsReveal = targetRect.top < visibleTopPage
      || targetRect.bottom + KEYBOARD_REVEAL_MARGIN_PX > visibleBottomPage;
    if (needsReveal && (revealIntent || !this.userScrolled)) {
      this.userScrolled = false;
      this.root.scrollTop = Math.min(required, maxScroll);
    } else {
      this.root.scrollTop = Math.min(Math.max(0, this.root.scrollTop), maxScroll);
    }
    this.root.dataset.keyboardAvoidanceScrollTop = String(this.root.scrollTop);
  }

  private requiredScroll(target: HTMLElement, visibleBottom: number): number {
    const shellRect = this.environmentRoot?.getBoundingClientRect();
    if (!shellRect) {
      return 0;
    }
    const rootRect = this.root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const contentBottom = targetRect.bottom - rootRect.top + this.root.scrollTop;
    const visibleBottomInRoot = visibleBottom - (rootRect.top - shellRect.top);
    return Math.max(
      0,
      Math.ceil(contentBottom + KEYBOARD_REVEAL_MARGIN_PX - visibleBottomInRoot),
    );
  }

  private release(): void {
    this.observeTarget(null);
    this.userScrolled = false;
    this.root.removeAttribute(KEYBOARD_AVOIDANCE_SCROLLABLE_ATTRIBUTE);
    this.root.removeAttribute('data-keyboard-avoidance-extent');
    this.root.removeAttribute('data-keyboard-avoidance-scroll-top');
    this.root.style.overflowY = 'hidden';
    this.extent.style.height = '0px';
    if (this.root.scrollTop !== 0) {
      this.root.scrollTop = 0;
    }
  }

  private observeTarget(target: HTMLElement | null): void {
    if (target === this.observedTarget) {
      return;
    }
    this.observedTarget = target;
    const observer = this.resizeObserver;
    if (!observer) {
      return;
    }
    observer.disconnect();
    if (target) {
      observer.observe(target);
    }
  }

  private maxScroll(): number {
    return Math.max(0, this.root.scrollHeight - this.root.clientHeight);
  }

  private isScrollable(): boolean {
    return this.root.getAttribute(KEYBOARD_AVOIDANCE_SCROLLABLE_ATTRIBUTE) === 'true';
  }

  /**
   * Only a touch that begins in the Terminal viewport is a candidate. Capsule
   * text selection, composer interaction, form controls and horizontal pager
   * gestures keep their own owner, and a longer press can hand the finger to
   * the Terminal direction pad (#2657), which wins immediately.
   */
  private readonly onTouchStart = (event: TouchEvent): void => {
    this.gesture = null;
    if (!this.isScrollable() || event.touches.length !== 1) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-terminal-viewport]')) {
      return;
    }
    if (target.closest('textarea, input, [contenteditable="true"]')) {
      return;
    }
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    this.gesture = {
      tracker: beginTouchAxis(touch.clientX, touch.clientY),
      lastY: touch.clientY,
      outerOwned: false,
    };
  };

  /**
   * Decide the owner at axis lock and freeze it for the contact. The outer page
   * spends its own range only while it has one in the drag direction; otherwise
   * the Terminal's existing #2659/`CapsuleOcclusionScroll` path keeps the
   * gesture untouched. One delta is never dispatched to both.
   */
  private readonly onTouchMove = (event: TouchEvent): void => {
    const gesture = this.gesture;
    if (!gesture || !this.isScrollable()) {
      return;
    }
    if (event.touches.length !== 1) {
      this.gesture = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    if (isTouchOwned(touch.identifier)) {
      this.gesture = null;
      return;
    }
    const axis = lockTouchAxis(gesture.tracker, touch);
    if (axis === 'horizontal') {
      this.gesture = null;
      return;
    }
    if (axis !== 'vertical') {
      return;
    }
    const delta = touch.clientY - gesture.lastY;
    gesture.lastY = touch.clientY;
    const maxScroll = this.maxScroll();
    if (!gesture.outerOwned) {
      const canScroll = delta < 0
        ? this.root.scrollTop < maxScroll - 0.5
        : this.root.scrollTop > 0.5;
      if (!canScroll) {
        this.gesture = null;
        return;
      }
      gesture.outerOwned = true;
    }
    event.preventDefault();
    event.stopPropagation();
    if (delta === 0) {
      return;
    }
    const next = Math.min(maxScroll, Math.max(0, this.root.scrollTop - delta));
    this.userScrolled = true;
    this.root.scrollTop = next;
    this.root.dataset.keyboardAvoidanceScrollTop = String(next);
  };
}
