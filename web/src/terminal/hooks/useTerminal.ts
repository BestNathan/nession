// web/src/terminal/hooks/useTerminal.ts
import { useMemo, useEffect, useRef } from 'react';
import { TerminalController } from '../controller/TerminalController';
import { createTerminalRuntimeAdapter } from '../adapters/TerminalRuntimeAdapter';
import type { TerminalSession } from '../state/session';
import type { TerminalTransport } from '../transport/TerminalTransport';
import type { DeviceProfile, TerminalScrollbackMode } from '../types';
import type { SessionRuntime } from '@/runtime/SessionRuntime';

export interface UseTerminalOptions {
  sessionId: string;
  sessionName: string;
  mode: 'p2p' | 'relay';
  transportFactory: () => TerminalTransport;
  rendererType?: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
  /** Device class — 'mobile' enables the IME-friendly input textarea. */
  deviceProfile?: DeviceProfile;
  /** Whether history is owned by xterm's browser buffer or the legacy path. */
  scrollbackMode?: TerminalScrollbackMode;
  /** Shared session lifecycle owner receiving viewport readiness and size. */
  runtime?: SessionRuntime | null;
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
 * down the live terminal view. Only the session identity fields (id/name/mode)
 * and the transport factory are memo deps; the factory itself is kept stable by
 * the caller (a ref-backed wrapper) so frequently-changing connection objects
 * never recreate the controller.
 *
 * Address switches never recreate the controller: the legacy pane passes no
 * transportEpoch to TerminalViewport, and the session-first pane gates its
 * viewport rebuild on `transportKey` (routeIntentEpoch:transportGeneration:
 * activeUrl), not on the controller. Recreating the controller here would
 * dispose xterm on every route rotation.
 */
export function useTerminal(options: UseTerminalOptions): TerminalController | null {
  const {
    sessionId,
    sessionName,
    mode,
    transportFactory,
    rendererType,
    fontSize,
    scrollback,
    deviceProfile,
    scrollbackMode = 'legacy',
    runtime,
  } = options;

  const controller = useMemo(() => {
    if (!sessionId) { return null; }
    const session: TerminalSession = {
      id: sessionId,
      name: sessionName,
      // Live status is owned by terminalSessionStateAtom (the state machine);
      // the controller never reads it.
      status: 'idle',
      mode,
      startedAt: 0,
    };
    // The runtime adapter is injected at construction — BEFORE any viewport can
    // attach. TerminalViewport attaches the controller in a useLayoutEffect,
    // and the controller publishes transport readiness during that attach; a
    // late (passive-effect) binding used to miss that first event, leaving
    // terminalTransportReadyAtom false and blocking the SessionRuntime's
    // transportReady-gated attach forever (issue #598).
    const events = createTerminalRuntimeAdapter(runtime);
    return new TerminalController(
      session,
      transportFactory,
      {
        rendererType: rendererType ?? 'canvas',
        fontSize,
        scrollback,
        deviceProfile,
        scrollbackMode,
        events,
      },
    );
  }, [sessionId, sessionName, mode, transportFactory, rendererType, fontSize, scrollback, deviceProfile, scrollbackMode, runtime]);

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
