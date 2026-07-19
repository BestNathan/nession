/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

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
