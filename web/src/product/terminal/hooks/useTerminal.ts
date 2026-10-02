// web/src/terminal/hooks/useTerminal.ts
import { useMemo, useEffect, useRef } from 'react';
import { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { createTerminalRuntimeAdapter } from '../adapters/TerminalRuntimeAdapter';
import type { TerminalSession } from '../state/session';
import type { DeviceProfile, TerminalScrollbackMode } from '@/platform/terminal-runtime/types';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

export interface UseTerminalOptions {
  sessionId: string;
  sessionName: string;
  mode: 'p2p' | 'relay';
  rendererType?: 'webgl' | 'canvas';
  fontSize?: number;
  /** xterm's line-height: a multiple of the font box, from the device profile's Experience tokens. */
  lineHeight?: number;
  scrollback?: number;
  /** Device class — 'mobile' enables the IME-friendly input textarea. */
  deviceProfile?: DeviceProfile;
  /** Whether history is owned by xterm's browser buffer or the legacy path. */
  scrollbackMode?: TerminalScrollbackMode;
  /**
   * The session's lifecycle owner — required. The controller is not created
   * without it: the runtime builds every transport the controller binds
   * (#1309), so a controller created before the lease lands could only bind a
   * transport the runtime did not issue. Waiting one commit also means the
   * adapter sees the runtime from construction, which is the #598 invariant.
   */
  runtime: SessionRuntime | null;
}

function isCurrentControllerGeneration(
  generationRef: { current: number },
  generation: number,
): boolean {
  return generationRef.current === generation;
}

/**
 * Create a stable {@link TerminalController} for the current session.
 *
 * The controller owns the xterm instance, so its identity must be stable across
 * every re-render — including each terminalState transition (connecting →
 * connected → attached), which derive a fresh session object but must NOT tear
 * down the live terminal view.
 *
 * Neither address switches nor P2P↔relay flips recreate the controller: the
 * runtime's transport-swap notification rewires the transport under the live
 * xterm (#1309), so `mode` is deliberately absent from the memo deps — a
 * fallback to relay no longer destroys the buffer the user is reading.
 * Recreating the controller here would dispose xterm on every route rotation.
 */
export function useTerminal(options: UseTerminalOptions): TerminalController | null {
  const {
    sessionId,
    sessionName,
    mode,
    rendererType,
    fontSize,
    lineHeight,
    scrollback,
    deviceProfile,
    scrollbackMode = 'legacy',
    runtime,
  } = options;

  // `mode` is creation-time display metadata with no readers — the live mode
  // is a runtime fact that swaps underneath (#1309). Read through a ref so the
  // memo can see the value without depending on it: depending on it would
  // recreate the controller on every P2P↔relay flip and destroy the buffer
  // the user is reading.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const controller = useMemo(() => {
    if (!sessionId || !runtime) { return null; }
    const session: TerminalSession = {
      id: sessionId,
      name: sessionName,
      // Live status is owned by the SessionRuntime's snapshot; the controller
      // never reads it.
      status: 'idle',
      mode: modeRef.current,
      startedAt: 0,
    };
    // The runtime adapter is injected at construction — BEFORE any viewport can
    // attach. TerminalViewport attaches the controller in a useLayoutEffect,
    // and the controller publishes transport readiness during that attach; a
    // late (passive-effect) binding used to miss that first event, leaving the
    // runtime's transportReady false and blocking the attach forever (#598).
    const events = createTerminalRuntimeAdapter(runtime);
    return new TerminalController(
      session,
      // The runtime is the transport authority: every ConnectionManager the
      // controller binds is built from the identity the runtime owns *now*,
      // tagged with the runtime's own transport generation.
      () => runtime.buildTransport(),
      {
        rendererType: rendererType ?? 'canvas',
        fontSize,
        lineHeight,
        scrollback,
        deviceProfile,
        scrollbackMode,
        events,
        transportBinding: {
          subscribe: (listener) => runtime.subscribeTransportSwap(listener),
        },
      },
    );
  }, [sessionId, sessionName, rendererType, fontSize, lineHeight, scrollback, deviceProfile, scrollbackMode, runtime]);

  // Dispose replaced controllers (session switch). Never dispose synchronously
  // in cleanup: StrictMode replays effects as unmount→remount and would
  // otherwise destroy xterm before the same controller is re-used.
  const activeControllerRef = useRef<TerminalController | null>(null);
  const controllerEffectGenerationRef = useRef(0);
  useEffect(() => {
    const previous = activeControllerRef.current;
    const generation = ++controllerEffectGenerationRef.current;
    activeControllerRef.current = controller;

    // The adapter now lives on the controller (injected at construction), so
    // dispose/detach publish readiness=false through it — no unbind here.
    if (previous && previous !== controller) {
      previous.dispose();
    }

    return () => {
      const retiring = controller;
      const cleanupGeneration = generation;
      queueMicrotask(() => {
        if (
          activeControllerRef.current === retiring
          && isCurrentControllerGeneration(controllerEffectGenerationRef, cleanupGeneration)
        ) {
          retiring?.dispose();
          activeControllerRef.current = null;
        }
      });
    };
  }, [controller]);

  return controller;
}
