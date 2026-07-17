import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { detectProfile } from './DeviceProfile';
import type { DeviceProfile } from './types';

const FONT_MIN = 10;
const FONT_MAX = 14;
const DEFAULT_TARGET_COLS = 80;

/** Optional construction settings for {@link ViewportManager}. */
export interface ViewportOptions {
  profile?: DeviceProfile;
}

export class ViewportManager {
  private observer: ResizeObserver;
  private profile: DeviceProfile;
  private targetCols: number;
  private wheelCleanup: (() => void) | null = null;
  private disposed = false;
  private rafHandle: number | null = null;

  constructor(
    private term: Terminal,
    private fitAddon: FitAddon,
    private container: HTMLElement,
    options: ViewportOptions = {},
  ) {
    this.profile = options.profile ?? detectProfile(container.clientWidth);
    this.targetCols = DEFAULT_TARGET_COLS;
    this.applyProfile();

    // NOTE: do NOT mutate container layout (display/flex) here. This runs
    // before TerminalView calls terminal.open(), and changing the box model
    // races with the renderer's initialisation.
    //
    // Observation is deferred to start() (called after terminal.open()) so
    // the ResizeObserver never fires while xterm's render service is still
    // undefined — syncScrollArea crashes otherwise (issue #51).
    this.observer = new ResizeObserver(() => {
      if (this.disposed) {
        return;
      }
      this.scheduleFit();
    });

    this.installWheelIntercept();
  }

  /**
   * Begin observing the container and perform the initial fit.
   *
   * Must be called AFTER {@link Terminal.open} — otherwise the ResizeObserver
   * fires during open() while the render service is still undefined, crashing
   * Viewport.syncScrollArea.
   */
  start(): void {
    if (this.disposed) { return; }
    this.observer.observe(this.container);
    this.scheduleFit();
  }

  /**
   * Coalesce bursts of fit requests (e.g. resize notifications during a drag)
   * into a single fit per animation frame to avoid layout thrashing.
   */
  private scheduleFit(): void {
    if (this.disposed || this.rafHandle !== null) {
      return;
    }
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      if (!this.disposed) {
        this.fit();
      }
    });
  }

  fit(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    this.detectAndApplyProfile();
    this.scaleFont();

    // Force xterm.js renderer to recalculate wrap state and cursor layer.
    // WebGL renderer has a known issue where viewport resize doesn't trigger
    // proper reflow of the cursor line, causing content to be "eaten" instead
    // of soft-wrapping. Calling refresh() forces the renderer to recompute.
    requestAnimationFrame(() => {
      if (!this.disposed) {
        this.term.refresh(0, this.term.rows - 1);
      }
    });
  }

  updateProfile(profile: DeviceProfile): void {
    this.profile = profile;
    this.applyProfile();
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    this.scaleFont();
  }

  setTargetColumns(cols: number): void {
    this.targetCols = cols;
  }

  dispose(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.disposed = true;
    this.observer.disconnect();
    this.wheelCleanup?.();
    this.wheelCleanup = null;
  }

  private applyProfile(): void {
    this.term.options.fontSize = this.profile.fontSize;
    this.term.options.lineHeight = this.profile.lineHeight;
  }

  private detectAndApplyProfile(): void {
    const detected = detectProfile(this.container.clientWidth);
    if (detected.fontSize !== this.profile.fontSize) {
      this.profile = detected;
      this.applyProfile();
    }
  }

  private scaleFont(): void {
    const currentFont = this.term.options.fontSize ?? FONT_MAX;
    const cols = this.term.cols;
    const profileFont = this.profile.fontSize;

    // Wide enough to hit target columns: restore toward the profile font size.
    if (cols >= this.targetCols) {
      if (currentFont < profileFont) {
        this.term.options.fontSize = profileFont;
        this.reflowAfterFontChange();
      }
      return;
    }

    // Too narrow: shrink so more columns fit, down to FONT_MIN.
    if (currentFont <= FONT_MIN) {
      return;
    }
    const newFont = Math.max(FONT_MIN, Math.round(currentFont * cols / this.targetCols));
    if (newFont >= currentFont) {
      return;
    }
    this.term.options.fontSize = newFont;
    this.reflowAfterFontChange();
  }

  /** Re-fit after a font-size change, two rAFs out so xterm applies metrics. */
  private reflowAfterFontChange(): void {
    requestAnimationFrame(() => {
      if (this.disposed) {
        return;
      }
      requestAnimationFrame(() => {
        if (this.disposed) {
          return;
        }
        try { this.fitAddon.fit(); } catch { /* ignore */ }
      });
    });
  }

  private installWheelIntercept(): void {
    const handleWheel = (e: WheelEvent) => {
      if (this.disposed) {
        return;
      }
      const buffer = this.term.buffer.active;
      if (buffer.length <= this.term.rows) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (delta !== 0) {
        this.term.scrollLines(delta);
      }
    };
    this.term.element?.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    this.wheelCleanup = () =>
      this.term.element?.removeEventListener('wheel', handleWheel, { capture: true });
  }
}
