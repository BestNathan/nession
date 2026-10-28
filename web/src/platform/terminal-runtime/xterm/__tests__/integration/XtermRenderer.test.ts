// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
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

  it('falls back to Canvas on a lost WebGL context and ignores a stale loss after dispose', () => {
    // Failure injection (#2581 SC-04): jsdom has no GPU context, so a fake
    // WebGL addon captures the context-loss callback and fires it. The
    // terminal's buffer is not rebuilt — only the renderer addon changes.
    const term = new Terminal();
    const addons = new XtermAddonHost(term);
    let loseContext: () => void = () => {};
    let webglDisposals = 0;
    const webgl = {
      activate: vi.fn(),
      // The renderer wraps dispose; count the underlying call instead of
      // asserting on a spy the wrapper would replace.
      dispose: () => { webglDisposals += 1; },
      onContextLoss: (listener: () => void) => { loseContext = listener; },
    };
    const renderer = new XtermRenderer(addons, 'webgl', {
      webglSupported: () => true,
      createWebgl: () => webgl,
    });

    expect(renderer.type).toBe('webgl');
    expect(addons.get(CanvasAddon)).toBeUndefined();

    loseContext();

    expect(webglDisposals).toBe(1);
    expect(renderer.type).toBe('canvas');
    expect(addons.get(CanvasAddon)).toBeDefined();

    renderer.dispose();
    // A context loss delivered after teardown must not install another addon
    // or touch a disposed host.
    expect(() => loseContext()).not.toThrow();
    expect(renderer.type).toBe('canvas');
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
