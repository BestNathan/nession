import type { ITerminalAddon } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { XtermAddonHost } from './XtermAddonHost';
import { detectWebGLSupport } from '../webglSupport';

/** The WebGL addon surface used here, so failure injection can stand in. */
export interface WebglAddonLike extends ITerminalAddon {
  onContextLoss(listener: () => void): void;
}

/**
 * Failure-injection seams for the renderer tests (#2581 SC-04). Production
 * passes none of these; a test supplies a fake WebGL addon to fire a context
 * loss deterministically in jsdom, where no real GPU context exists.
 */
export interface RendererHooks {
  webglSupported?: () => boolean;
  createWebgl?: () => WebglAddonLike;
  createCanvas?: () => ITerminalAddon;
}

/**
 * Renderer lifecycle for one xterm instance (WebGL with Canvas fallback).
 *
 * The fallback path is exercised by failure injection in the renderer tests:
 * a lost context disposes the WebGL addon and installs Canvas on the same
 * terminal, so the buffer and callbacks survive. `dispose()` stops reacting to
 * a context loss that arrives after the emulator is gone.
 */
export class XtermRenderer {
  type: 'webgl' | 'canvas';
  private disposed = false;

  private readonly hooks: RendererHooks;

  constructor(
    private readonly addons: XtermAddonHost,
    preferred?: 'webgl' | 'canvas',
    hooks: RendererHooks = {},
  ) {
    this.hooks = hooks;
    const webglSupported = hooks.webglSupported ?? detectWebGLSupport;
    if (preferred === 'webgl' && webglSupported()) {
      try {
        const webgl = hooks.createWebgl?.() ?? new WebglAddon();
        // @xterm/addon-webgl's dispose() throws "Cannot read properties of
        // undefined (reading '_isDisposed')" if the addon is disposed before
        // its GL renderer finished initializing — which happens under React
        // StrictMode's dev mount→unmount→mount. Wrap dispose so teardown never
        // throws and crashes the React tree.
        const rawDispose = webgl.dispose.bind(webgl);
        webgl.dispose = () => {
          try {
            rawDispose();
          } catch {
            /* GL renderer never initialized — safe to ignore */
          }
        };
        const webglType = webgl.constructor as new (...args: never[]) => ITerminalAddon;
        webgl.onContextLoss(() => {
          if (this.disposed) { return; }
          this.addons.dispose(webglType);
          this.fallbackToCanvas();
        });
        this.addons.register(webgl);
        this.type = 'webgl';
        return;
      } catch {
        console.warn('[Renderer] WebGL unavailable, falling back to Canvas');
      }
    }
    this.addons.register(new CanvasAddon());
    this.type = 'canvas';
  }

  /** Load the Canvas renderer after a WebGL context loss so the terminal
   *  keeps rendering instead of relying on xterm's implicit DOM fallback. */
  private fallbackToCanvas(): void {
    try {
      this.addons.register(this.hooks.createCanvas?.() ?? new CanvasAddon());
      this.type = 'canvas';
    } catch {
      /* terminal disposed mid-loss — nothing to do */
    }
  }

  /** Stop reacting to renderer events; addon disposal belongs to the terminal. */
  dispose(): void {
    this.disposed = true;
    this.addons.disposeTracking();
  }
}
