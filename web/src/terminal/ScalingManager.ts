import { TABLET_BREAKPOINT, DESKTOP_BREAKPOINT } from './DeviceProfile';

const ZOOM_STEP = 0.1;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;

/**
 * Manages CSS transform scaling for terminal display.
 * Provides device-based auto-scaling and manual zoom controls.
 * Scaling is visual only — does not affect xterm.js internal dimensions.
 */
export class ScalingManager {
  private scale: number;
  private wrapperElement: HTMLElement;
  private deviceType: 'mobile' | 'tablet' | 'desktop';

  constructor(wrapperElement: HTMLElement) {
    this.wrapperElement = wrapperElement;
    this.deviceType = this.detectDevice();
    this.scale = this.getDefaultScale();
    this.applyScale();
  }

  private detectDevice(): 'mobile' | 'tablet' | 'desktop' {
    const width = window.innerWidth;
    if (width < TABLET_BREAKPOINT) {
      return 'mobile';
    }
    if (width < DESKTOP_BREAKPOINT) {
      return 'tablet';
    }
    return 'desktop';
  }

  private getDefaultScale(): number {
    switch (this.deviceType) {
      case 'mobile': return 0.6;
      case 'tablet': return 0.8;
      case 'desktop': return 1.0;
    }
  }

  zoomIn(): void {
    // Round to avoid IEEE 754 floating-point drift from repeated +0.1 steps
    this.scale = Math.min(MAX_SCALE, Math.round((this.scale + ZOOM_STEP) * 10) / 10);
    this.applyScale();
  }

  zoomOut(): void {
    // Round to avoid IEEE 754 floating-point drift from repeated -0.1 steps
    this.scale = Math.max(MIN_SCALE, Math.round((this.scale - ZOOM_STEP) * 10) / 10);
    this.applyScale();
  }

  reset(): void {
    this.scale = this.getDefaultScale();
    this.applyScale();
  }

  dispose(): void {
    this.wrapperElement.style.transform = '';
    this.wrapperElement.style.transformOrigin = '';
    this.wrapperElement.style.width = '';
    this.wrapperElement.style.height = '';
  }

  private applyScale(): void {
    this.wrapperElement.style.transform = `scale(${this.scale})`;
    this.wrapperElement.style.transformOrigin = 'top left';
    const inverseScale = 1 / this.scale;
    this.wrapperElement.style.width = `${inverseScale * 100}%`;
    this.wrapperElement.style.height = `${inverseScale * 100}%`;
  }

  getScale(): number {
    return this.scale;
  }
}
