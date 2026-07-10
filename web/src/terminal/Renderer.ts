import type { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

export class Renderer {
  readonly type: 'webgl' | 'canvas';

  constructor(term: Terminal, preferred?: 'webgl' | 'canvas') {
    if (preferred === 'webgl' && Renderer.supportsWebGL()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
        this.type = 'webgl';
        return;
      } catch {
        console.warn('[Renderer] WebGL unavailable, falling back to Canvas');
      }
    }
    term.loadAddon(new CanvasAddon());
    this.type = 'canvas';
  }

  /** Check whether the runtime supports WebGL rendering. */
  private static supportsWebGL(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl') || canvas.getContext('webgl2'));
    } catch {
      return false;
    }
  }
}
