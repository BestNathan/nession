import {
  APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE,
  computeAppViewportSnapshot,
  isEditableElement,
  publishAppViewportSnapshot,
  sameViewportSnapshot,
  type AppSafeArea,
  type AppViewportSnapshot,
  type ViewportRect,
  type VisualViewportReading,
} from './appViewport';

/**
 * Everything the environment reads, as a port.
 *
 * The production host reads `window.visualViewport`, the shell's own box and
 * the focused element. Tests supply the same surface without a layout engine,
 * which is what lets the coordinate rules and the coalescing/dedupe contract be
 * proved deterministically instead of inferred from a browser screenshot.
 */
export interface AppViewportEnvironmentHost {
  readLayoutBounds(): ViewportRect;
  readVisualViewport(): VisualViewportReading | null;
  readEditableFocus(): boolean;
  readSafeArea(): AppSafeArea;
  /** Wire the browser events that can change any of the readings above. */
  subscribe(onChange: () => void): () => void;
  scheduleFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}

export type AppViewportListener = (snapshot: AppViewportSnapshot) => void;

/**
 * Coalesces viewport inputs into one published snapshot per animation frame.
 *
 * `visualViewport.resize` and `visualViewport.scroll` are inputs; window
 * resize, orientation and focus are triggers/fallbacks. Updates that do not
 * change a meaningful number are dropped before they reach any consumer, so a
 * keyboard animation cannot produce a publish/scroll storm.
 */
export class AppViewportEnvironment {
  private snapshot: AppViewportSnapshot | null = null;
  private revision = 0;
  private pendingFrame: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<AppViewportListener>();
  private started = false;

  constructor(
    private readonly shell: HTMLElement,
    private readonly host: AppViewportEnvironmentHost,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribe = this.host.subscribe(() => this.schedule());
    this.schedule();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pendingFrame !== null) {
      this.host.cancelFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    this.listeners.clear();
    this.shell.removeAttribute(APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE);
  }

  current(): AppViewportSnapshot | null {
    return this.snapshot;
  }

  subscribe(listener: AppViewportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedule(): void {
    if (!this.started || this.pendingFrame !== null) {
      return;
    }
    this.pendingFrame = this.host.scheduleFrame(() => {
      this.pendingFrame = null;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.started) {
      return;
    }
    const editableFocus = this.host.readEditableFocus();
    const next = computeAppViewportSnapshot({
      layoutBounds: this.host.readLayoutBounds(),
      visualViewport: this.host.readVisualViewport(),
      safeArea: this.host.readSafeArea(),
      editableFocus,
      revision: this.revision + 1,
    });
    if (this.snapshot !== null && sameViewportSnapshot(this.snapshot, next)) {
      return;
    }
    this.revision = next.revision;
    this.snapshot = next;
    publishAppViewportSnapshot(this.shell, next);
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readVisualViewport(): VisualViewportReading | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const viewport = window.visualViewport;
  if (!viewport) {
    return null;
  }
  return {
    offsetLeft: viewport.offsetLeft,
    offsetTop: viewport.offsetTop,
    width: viewport.width,
    height: viewport.height,
    scale: viewport.scale,
  };
}

function readLayoutBounds(shell: HTMLElement): ViewportRect {
  const rect = shell.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function readEditableFocus(shell: HTMLElement): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const active = document.activeElement;
  // A control outside the App frame (a body-portalled dialog) never summons the
  // App's avoidance scroll; the surface that owns it owns its own focus.
  if (!(active instanceof Element) || !shell.contains(active)) {
    return false;
  }
  return isEditableElement(active);
}

/**
 * The safe-area probe.
 *
 * `env(safe-area-inset-*)` is only readable through computed style, so a
 * zero-sized probe carries the four paddings and this reads them back. The
 * `--nession-test-safe-area-*` variables are the deterministic Chromium input
 * the design contract requires; production browsers simply do not set them.
 */
function createSafeAreaReader(shell: HTMLElement): () => AppSafeArea {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.dataset.appSafeAreaProbe = 'true';
  probe.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'visibility:hidden',
    'pointer-events:none',
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
  ].join(';');
  shell.appendChild(probe);
  return () => {
    const shellStyle = getComputedStyle(shell);
    const probeStyle = getComputedStyle(probe);
    const override = (name: string, fallback: number): number => {
      const raw = shellStyle.getPropertyValue(name).trim();
      if (raw === '') {
        return fallback;
      }
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
    };
    return {
      top: override('--nession-test-safe-area-top', px(probeStyle.paddingTop)),
      right: override('--nession-test-safe-area-right', px(probeStyle.paddingRight)),
      bottom: override('--nession-test-safe-area-bottom', px(probeStyle.paddingBottom)),
      left: override('--nession-test-safe-area-left', px(probeStyle.paddingLeft)),
    };
  };
}

function browserFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => callback());
  }
  return window.setTimeout(callback, 0);
}

function cancelBrowserFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

/** The production host for one App shell element. */
export function createBrowserAppViewportEnvironmentHost(
  shell: HTMLElement,
): AppViewportEnvironmentHost {
  const readSafeArea = createSafeAreaReader(shell);
  return {
    readLayoutBounds: () => readLayoutBounds(shell),
    readVisualViewport,
    readEditableFocus: () => readEditableFocus(shell),
    readSafeArea,
    subscribe: (onChange) => {
      const viewport = typeof window === 'undefined' ? null : window.visualViewport;
      window.addEventListener('resize', onChange);
      window.addEventListener('orientationchange', onChange);
      viewport?.addEventListener('resize', onChange);
      viewport?.addEventListener('scroll', onChange);
      // Focus decides whether reduced visibility is an actionable keyboard
      // session; the geometry itself still arrives through the viewport events.
      document.addEventListener('focusin', onChange, true);
      document.addEventListener('focusout', onChange, true);
      return () => {
        window.removeEventListener('resize', onChange);
        window.removeEventListener('orientationchange', onChange);
        viewport?.removeEventListener('resize', onChange);
        viewport?.removeEventListener('scroll', onChange);
        document.removeEventListener('focusin', onChange, true);
        document.removeEventListener('focusout', onChange, true);
      };
    },
    scheduleFrame: browserFrame,
    cancelFrame: cancelBrowserFrame,
  };
}
