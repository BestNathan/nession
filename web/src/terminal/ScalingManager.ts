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
    if (width <= 768) {
      return 'mobile';
    }
    if (width <= 1024) {
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
    this.scale = Math.min(3.0, this.scale + 0.1);
    this.applyScale();
  }

  zoomOut(): void {
    this.scale = Math.max(0.3, this.scale - 0.1);
    this.applyScale();
  }

  reset(): void {
    this.scale = this.getDefaultScale();
    this.applyScale();
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
