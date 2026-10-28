/**
 * Check whether the runtime supports WebGL rendering backed by a real GPU.
 *
 * On headless servers the browser may offer a WebGL context backed by a
 * software rasteriser (SwiftShader, llvmpipe, etc.). xterm.js's WebGL addon
 * activate() fails silently with these — it never sets _renderService — and
 * xterm's own Viewport constructor (which runs a setTimeout after open())
 * crashes on `_renderService.dimensions`. We use two layers:
 *
 * 1. `failIfMajorPerformanceCaveat: true` — the standard WebGL context
 *    creation attribute that makes `getContext` return `null` when the
 *    implementation is software-only. Works everywhere, no extension needed.
 *
 * 2. `WEBGL_debug_renderer_info` — a secondary string-based check for
 *    environments where layer 1 is ignored (privacy-respecting user agents
 *    that don't honour the hint but still expose the extension).
 *
 * This probe is xterm-free, so callers that only choose a renderer (the attach
 * dialog, deep-link planning) do not need the engine (#2581).
 */
export function detectWebGLSupport(): boolean {
  if (cachedWebGLSupport !== null) {
    return cachedWebGLSupport;
  }
  cachedWebGLSupport = probeWebGLSupport();
  return cachedWebGLSupport;
}

let cachedWebGLSupport: boolean | null = null;

function probeWebGLSupport(): boolean {
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
        releaseProbeContext(gl);
        return false;
      }
    }
    releaseProbeContext(gl);
    return true;
  } catch {
    return false;
  }
}

function releaseProbeContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  const ext = gl.getExtension('WEBGL_lose_context');
  ext?.loseContext();
}
