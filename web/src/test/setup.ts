/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

// getAnimations polyfill for jsdom — not implemented in jsdom but called by
// @base-ui/react/scroll-area's ScrollAreaViewport. Without this, 26 uncaught
// exceptions cause vitest to exit 1 even though all tests pass.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// ResizeObserver polyfill for jsdom (used by Terminal.tsx ResizeObserver).
globalThis.ResizeObserver = class ResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(_target: Element, _options?: ResizeObserverOptions): void {
    void _target;
    void _options;
    // no-op
  }
  unobserve(_target: Element): void {
    void _target;
    // no-op
  }
  disconnect(): void {
    // no-op
  }
};
