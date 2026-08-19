import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { Renderer } from '@/terminal/Renderer';

describe('Renderer', () => {
  it('defaults to canvas renderer', () => {
    const term = new Terminal();
    const renderer = new Renderer(term);
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('explicitly selects canvas when preferred', () => {
    const term = new Terminal();
    const renderer = new Renderer(term, 'canvas');
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('falls back to canvas when webgl is unavailable (jsdom env)', () => {
    const term = new Terminal();
    const renderer = new Renderer(term, 'webgl');
    // In jsdom, WebGL is not available — fallback to canvas.
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('does not throw when constructed', () => {
    const term = new Terminal();
    expect(() => new Renderer(term)).not.toThrow();
    expect(() => new Renderer(term, 'webgl')).not.toThrow();
    term.dispose();
  });

  it('exports detectWebGLSupport returning a boolean', async () => {
    const { detectWebGLSupport } = await import('@/terminal/Renderer');
    expect(typeof detectWebGLSupport()).toBe('boolean');
    // jsdom has no WebGL context.
    expect(detectWebGLSupport()).toBe(false);
  });
});
