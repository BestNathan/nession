import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScalingManager } from '../ScalingManager';

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
    it('detects mobile when viewport <= 768px', () => {
      setViewportWidth(768);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.6);
    });

    it('detects tablet when viewport is between 769 and 1024px', () => {
      setViewportWidth(1024);
      const wrapper = createWrapper();
      const manager = new ScalingManager(wrapper);
      expect(manager.getScale()).toBeCloseTo(0.8);
    });

    it('detects desktop when viewport > 1024px', () => {
      setViewportWidth(1440);
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
