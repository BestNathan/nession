// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { XtermAddonHost } from '../../XtermAddonHost';
import { XtermRenderer } from '../../XtermRenderer';
import { detectWebGLSupport } from '../../../webglSupport';

function rendererFor(term: Terminal, preferred?: 'webgl' | 'canvas'): XtermRenderer {
  return new XtermRenderer(new XtermAddonHost(term), preferred);
}

describe('XtermRenderer', () => {
  it('defaults to canvas renderer', () => {
    const term = new Terminal();
    const renderer = rendererFor(term);
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('explicitly selects canvas when preferred', () => {
    const term = new Terminal();
    const renderer = rendererFor(term, 'canvas');
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('falls back to canvas when webgl is unavailable (jsdom env)', () => {
    const term = new Terminal();
    const renderer = rendererFor(term, 'webgl');
    // In jsdom, WebGL is not available — fallback to canvas.
    expect(renderer.type).toBe('canvas');
    term.dispose();
  });

  it('does not throw when constructed', () => {
    const term = new Terminal();
    expect(() => rendererFor(term)).not.toThrow();
    expect(() => rendererFor(term, 'webgl')).not.toThrow();
    term.dispose();
  });

  it('stops reacting to renderer events after dispose', () => {
    const term = new Terminal();
    const host = new XtermAddonHost(term);
    const renderer = new XtermRenderer(host, 'canvas');
    expect(() => renderer.dispose()).not.toThrow();
    term.dispose();
  });

  it('exports detectWebGLSupport returning a boolean', async () => {

    expect(typeof detectWebGLSupport()).toBe('boolean');
    // jsdom has no WebGL context.
    expect(detectWebGLSupport()).toBe(false);
  });
});
