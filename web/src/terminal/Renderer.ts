import type { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

/**
 * Check whether the runtime supports WebGL rendering backed by a real GPU.
 *
 * On headless servers the browser may offer a WebGL context backed by a
 * software rasteriser (SwiftShader, llvmpipe, etc.).  xterm.js's WebGL addon
 * activate() fails silently with these — it never sets _renderService — and
 * xterm's own Viewport constructor (which runs a setTimeout after open())
 * crashes on `_renderService.dimensions`.  We use two layers:
 *
 * 1. `failIfMajorPerformanceCaveat: true` — the standard WebGL context
 *    creation attribute that makes `getContext` return `null` when the
 *    implementation is software-only.  Works everywhere, no extension needed.
 *
 * 2. `WEBGL_debug_renderer_info` — a secondary string-based check for
 *    environments where layer 1 is ignored (privacy-respecting user agents
 *    that don't honour the hint but still expose the extension).
 */
export function detectWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');

    // Layer 1 — standard: refuse contexts with major performance caveats
    // (i.e. software rasterisers).  This is the primary defence.
    const opts: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl =
      canvas.getContext('webgl', opts) ||
      canvas.getContext('webgl2', opts);
    if (!gl) { return false; }

    // Layer 2 — backup: if the driver still reports a software rasteriser
    // string, refuse it even when the UA didn't honour the hint above.
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const renderer = String(
        gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '',
      );
      if (
        /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(
          renderer,
        )
      ) {
        return false;
      }
    }
    return true;
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
