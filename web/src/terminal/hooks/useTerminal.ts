// web/src/terminal/hooks/useTerminal.ts
import { useMemo, useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { TerminalController } from '../controller/TerminalController';
import type { TerminalSession } from '../state/session';
import type { TerminalTransport } from '../transport/TerminalTransport';
import type { DeviceProfile, TerminalScrollbackMode } from '../types';
import { p2pEpochAtom } from '../../atoms/connection';

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
 * The p2pEpoch is included so that switching addresses (which bumps the epoch)
 * recreates the controller and remounts xterm with the new transport.
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
  } = options;

  // p2pEpoch bumps when the user switches addresses — TerminalViewport re-attaches
  // (transportKey) to rewire ConnectionManager; recreating the controller here
  // would dispose xterm on every route rotation.
  const p2pEpoch = useAtomValue(p2pEpochAtom);
  void p2pEpoch;

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
    return new TerminalController(
      session,
      transportFactory,
      {
        rendererType: rendererType ?? 'canvas',
        fontSize,
        scrollback,
        deviceProfile,
        scrollbackMode,
      },
    );
  }, [sessionId, sessionName, mode, transportFactory, rendererType, fontSize, scrollback, deviceProfile, scrollbackMode]);

  // Dispose replaced controllers (session switch). Never dispose synchronously
  // in cleanup: StrictMode replays effects as unmount→remount and would
  // otherwise destroy xterm before the same controller is re-used.
  const activeControllerRef = useRef<TerminalController | null>(null);
  const controllerEffectGenerationRef = useRef(0);
  useEffect(() => {
    const previous = activeControllerRef.current;
    const generation = ++controllerEffectGenerationRef.current;
    activeControllerRef.current = controller;

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
