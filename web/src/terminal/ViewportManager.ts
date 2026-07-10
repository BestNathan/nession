import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { detectProfile } from './DeviceProfile';
import type { DeviceProfile } from './types';

const FONT_MIN = 10;
const FONT_MAX = 14;
const DEFAULT_TARGET_COLS = 80;

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
    profile?: DeviceProfile,
  ) {
    this.profile = profile ?? detectProfile(container.clientWidth);
    this.targetCols = DEFAULT_TARGET_COLS;
    this.applyProfile();

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
