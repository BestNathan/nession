import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScalingManager } from '../ScalingManager';
import { TABLET_BREAKPOINT, DESKTOP_BREAKPOINT } from '../DeviceProfile';

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

function createWrapper(): HTMLElement {
  return document.createElement('div');
}

describe('ScalingManager', () => {
  beforeEach(() => {
    setViewportWidth(1440);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('device detection', () => {
    it('detects mobile when viewport < TABLET_BREAKPOINT', () => {
      setViewportWidth(TABLET_BREAKPOINT - 1);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.6);
    });

    it('detects tablet when viewport is TABLET_BREAKPOINT..DESKTOP_BREAKPOINT-1', () => {
      setViewportWidth(TABLET_BREAKPOINT);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.8);
    });

    it('detects desktop when viewport >= DESKTOP_BREAKPOINT', () => {
      setViewportWidth(DESKTOP_BREAKPOINT);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(1.0);
    });
  });

  describe('default scale', () => {
    it('applies default scale for mobile (0.6)', () => {
      setViewportWidth(375);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.6);
    });

    it('applies default scale for tablet (0.8)', () => {
      setViewportWidth(900);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.8);
    });

    it('applies default scale for desktop (1.0)', () => {
      setViewportWidth(1920);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(1.0);
    });
  });

  describe('zoomIn', () => {
    it('increases scale by 0.1', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomIn();
      expect(manager.getScale()).toBeCloseTo(1.1);
    });

    it('clamps to maximum 3.0', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      for (let i = 0; i < 25; i++) {
        manager.zoomIn();
      }
      expect(manager.getScale()).toBeCloseTo(3.0);
    });

    it('does not exceed 3.0 even with many calls', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      for (let i = 0; i < 100; i++) {
        manager.zoomIn();
      }
      expect(manager.getScale()).toBeLessThanOrEqual(3.0);
    });

    it('does not accumulate floating-point drift after many steps', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      for (let i = 0; i < 10; i++) {
        manager.zoomIn();
      }
      // 1.0 + 10*0.1 should be exactly 2.0, not 2.0000000000000004
      expect(manager.getScale()).toBe(2);
    });
  });

  describe('zoomOut', () => {
    it('decreases scale by 0.1', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomOut();
      expect(manager.getScale()).toBeCloseTo(0.9);
    });

    it('clamps to minimum 0.3', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      for (let i = 0; i < 20; i++) {
        manager.zoomOut();
      }
      expect(manager.getScale()).toBeCloseTo(0.3);
    });

    it('does not go below 0.3 even with many calls', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      for (let i = 0; i < 100; i++) {
        manager.zoomOut();
      }
      expect(manager.getScale()).toBeGreaterThanOrEqual(0.3);
    });

    it('does not accumulate floating-point drift after many steps', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      // 1.0 - 7*0.1 should be exactly 0.3, not 0.30000000000000004 or similar
      for (let i = 0; i < 7; i++) {
        manager.zoomOut();
      }
      expect(manager.getScale()).toBe(0.3);
    });
  });

  describe('reset', () => {
    it('resets to default scale after zoom changes', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomIn();
      manager.zoomIn();
      manager.zoomIn();
      manager.reset();
      expect(manager.getScale()).toBeCloseTo(1.0);
    });

    it('resets to mobile default when viewport is mobile', () => {
      setViewportWidth(400);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomIn();
      manager.zoomIn();
      manager.reset();
      expect(manager.getScale()).toBeCloseTo(0.6);
    });

    it('resets to tablet default when viewport is tablet', () => {
      setViewportWidth(900);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomOut();
      manager.reset();
      expect(manager.getScale()).toBeCloseTo(0.8);
    });
  });

  describe('dispose', () => {
    it('clears all inline styles from the wrapper element', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(wrapper.style.transform).toBe('scale(1)');
      manager.dispose();
      expect(wrapper.style.transform).toBe('');
      expect(wrapper.style.transformOrigin).toBe('');
      expect(wrapper.style.width).toBe('');
      expect(wrapper.style.height).toBe('');
    });
  });

  describe('wrapper style adjustments', () => {
    it('applies CSS transform scale to wrapper', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      new ScalingManager(wrapper);
      expect(wrapper.style.transform).toBe('scale(1)');
      expect(wrapper.style.transformOrigin).toBe('top left');
    });

    it('adjusts wrapper width to inverse of scale', () => {
      setViewportWidth(375);
      const wrapper = createWrapper();
      new ScalingManager(wrapper);
      // mobile default is 0.6, inverse is 1/0.6 * 100 = 166.666...%
      const expectedWidth = `${(1 / 0.6) * 100}%`;
      expect(wrapper.style.width).toBe(expectedWidth);
    });

    it('adjusts wrapper height to inverse of scale', () => {
      setViewportWidth(375);
      const wrapper = createWrapper();
      new ScalingManager(wrapper);
      const expectedHeight = `${(1 / 0.6) * 100}%`;
      expect(wrapper.style.height).toBe(expectedHeight);
    });

    it('updates wrapper styles on zoomIn', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomIn();
      expect(wrapper.style.transform).toBe('scale(1.1)');
      const expectedWidth = `${(1 / 1.1) * 100}%`;
      expect(wrapper.style.width).toBe(expectedWidth);
    });

    it('updates wrapper styles on zoomOut', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomOut();
      expect(wrapper.style.transform).toBe('scale(0.9)');
      const expectedWidth = `${(1 / 0.9) * 100}%`;
      expect(wrapper.style.width).toBe(expectedWidth);
    });

    it('updates wrapper styles on reset', () => {
      setViewportWidth(1440);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      manager.zoomIn();
      manager.zoomIn();
      manager.reset();
      expect(wrapper.style.transform).toBe('scale(1)');
      expect(wrapper.style.width).toBe('100%');
      expect(wrapper.style.height).toBe('100%');
    });
  });
});
