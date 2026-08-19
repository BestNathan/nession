/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

// ── jsdom polyfills ───────────────────────────────────────────────────────────

// getAnimations — required by @base-ui/react/scroll-area's ScrollAreaViewport.
if (typeof Element !== 'undefined' && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// ResizeObserver — used by Terminal.tsx.
globalThis.ResizeObserver = class ResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(_target: Element, _options?: ResizeObserverOptions): void {
    void _target;
    void _options;
  }
  unobserve(_target: Element): void {
    void _target;
  }
  disconnect(): void {}
};

// HTMLCanvasElement.getContext — xterm.js probes WebGL support via canvas;
// jsdom doesn't implement WebGL. Return null so xterm falls back to DOM renderer.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    ...args: unknown[]
  ) {
    if (contextId === '2d') {
      // The overloaded return types of getContext are mutually incompatible;
      // `any` cast is the only way to delegate to the original while keeping a
      // single-function override that works for all contextId values.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (HTMLCanvasElement.prototype.getContext as any).call(this, contextId, ...args);
    }
    // webgl / webgl2 / bitmaprenderer — not implemented, return null.
    return null;
  };
}

// ── Suppress known-harmless third-party noise ─────────────────────────────────

const SUPPRESS_PATTERNS: string[] = [
  'not wrapped in act',                      // @base-ui/react scroll-area RAF
  "HTMLCanvasElement's getContext() method", // jsdom — xterm WebGL probe
  'Function components cannot be given refs', // @base-ui/react FloatingFocusManager
];

function makeFilter(orig: typeof console.error) {
  return (...args: unknown[]) => {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg && SUPPRESS_PATTERNS.some(p => msg.includes(p))) {
      return;
    }
    orig.call(console, ...args);
  };
}
console.error = makeFilter(console.error);
console.warn = makeFilter(console.warn as typeof console.error);
