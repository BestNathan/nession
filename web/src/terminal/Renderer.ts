import type { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

/** Check whether the runtime supports WebGL rendering. */
export function detectWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl') || canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

export class Renderer {
  type: 'webgl' | 'canvas';

  constructor(private term: Terminal, preferred?: 'webgl' | 'canvas') {
    if (preferred === 'webgl' && detectWebGLSupport()) {
      try {
        const webgl = new WebglAddon();
        // @xterm/addon-webgl's dispose() throws "Cannot read properties of
        // undefined (reading '_isDisposed')" if the addon is disposed before
        // its GL renderer finished initializing — which happens under React
        // StrictMode's dev mount→unmount→mount. Wrap dispose so teardown never
        // throws and crashes the React tree. loadAddon() captures this
        // reference and calls it through its own wrapper, so the addon is still
        // unregistered correctly on terminal.dispose().
        const rawDispose = webgl.dispose.bind(webgl);
        webgl.dispose = () => {
          try {
            rawDispose();
          } catch {
            /* GL renderer never initialized — safe to ignore */
          }
        };
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.fallbackToCanvas();
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

  /** Load the Canvas renderer after a WebGL context loss so the terminal
   *  keeps rendering instead of relying on xterm's implicit DOM fallback. */
  private fallbackToCanvas(): void {
    try {
      this.term.loadAddon(new CanvasAddon());
      this.type = 'canvas';
    } catch {
      /* terminal disposed mid-loss — nothing to do */
    }
  }
}
