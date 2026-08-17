import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputSourceManager } from '../InputSourceManager';

describe('InputSourceManager', () => {
  let manager: InputSourceManager;

  beforeEach(() => {
    manager = new InputSourceManager();
  });

  describe('setActiveSource', () => {
    it('should set active source', () => {
      manager.setActiveSource('keyboard');
      expect(manager.getActiveSource()).toBe('keyboard');
    });

    it('should update active source when changed', () => {
      manager.setActiveSource('keyboard');
      manager.setActiveSource('touch');
      expect(manager.getActiveSource()).toBe('touch');
    });

    it('should not trigger callback when source is same', () => {
      const callback = vi.fn();
      manager.onSourceChange(callback);

      manager.setActiveSource('keyboard');
      manager.setActiveSource('keyboard'); // Same source

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should trigger callback when source changes', () => {
      const callback = vi.fn();
      manager.onSourceChange(callback);

      manager.setActiveSource('keyboard');
      expect(callback).toHaveBeenCalledWith('keyboard');

      manager.setActiveSource('touch');
      expect(callback).toHaveBeenCalledWith('touch');
    });
  });

  describe('getActiveSource', () => {
    it('should return null initially', () => {
      expect(manager.getActiveSource()).toBeNull();
    });

    it('should return current active source', () => {
      manager.setActiveSource('keyboard');
      expect(manager.getActiveSource()).toBe('keyboard');
    });
  });

  describe('onSourceChange', () => {
    it('should register callback', () => {
      const callback = vi.fn();
      manager.onSourceChange(callback);

      manager.setActiveSource('keyboard');
      expect(callback).toHaveBeenCalledWith('keyboard');
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = manager.onSourceChange(callback);

      manager.setActiveSource('keyboard');
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      manager.setActiveSource('touch');
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should support multiple callbacks', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.onSourceChange(callback1);
      manager.onSourceChange(callback2);

      manager.setActiveSource('keyboard');

      expect(callback1).toHaveBeenCalledWith('keyboard');
      expect(callback2).toHaveBeenCalledWith('keyboard');
    });
  });

  describe('dispose', () => {
    it('should reset active source to null', () => {
      manager.setActiveSource('keyboard');
      manager.dispose();
      expect(manager.getActiveSource()).toBeNull();
    });

    it('should clear all callbacks', () => {
      const callback = vi.fn();
      manager.onSourceChange(callback);

      manager.dispose();
      manager.setActiveSource('keyboard');

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
