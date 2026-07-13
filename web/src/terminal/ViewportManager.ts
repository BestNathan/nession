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
  /** Terminal background colour, painted on the mount container (see below). */
  background?: string;
}

export class ViewportManager {
  private observer: ResizeObserver;
  private profile: DeviceProfile;
  private targetCols: number;
  private wheelCleanup: (() => void) | null = null;
  private disposed = false;

  constructor(
    private term: Terminal,
    private fitAddon: FitAddon,
    private container: HTMLElement,
    options: ViewportOptions = {},
  ) {
    this.profile = options.profile ?? detectProfile(container.clientWidth);
    this.targetCols = DEFAULT_TARGET_COLS;
    this.applyProfile();

    // FitAddon computes rows with Math.floor(containerHeight / cellHeight), so
    // it always discards the sub-row remainder (containerHeight mod cellHeight).
    // With a fractional cell height that remainder is a few pixels the terminal
    // never paints, exposing the page background as a thin light line below the
    // canvas. Two defences (both work regardless of xterm internals):
    //   1. paint the mount container with the terminal background so any
    //      remainder is the terminal's own colour, not the page's, and
    //   2. center the xterm element vertically so the remainder is split evenly
    //      top/bottom instead of pooling as one visible strip at the bottom.
    if (options.background) {
      this.container.style.backgroundColor = options.background;
    }
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.container.style.justifyContent = 'center';

    this.observer = new ResizeObserver(() => {
      if (this.disposed) {
        return;
      }
      this.fit();
    });
    this.observer.observe(container);

    this.installWheelIntercept();

    requestAnimationFrame(() => {
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
    if (cols >= this.targetCols || currentFont <= FONT_MIN) {
      return;
    }

    const newFont = Math.max(FONT_MIN, Math.round(currentFont * cols / this.targetCols));
    if (newFont >= currentFont) {
      return;
    }

    this.term.options.fontSize = newFont;
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
