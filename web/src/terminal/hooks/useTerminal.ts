// web/src/terminal/hooks/useTerminal.ts
import { useMemo } from 'react';
import { TerminalController } from '../controller/TerminalController';
import type { TerminalSession } from '../state/session';
import type { TerminalTransport } from '../transport/TerminalTransport';

export interface UseTerminalOptions {
  sessionId: string;
  sessionName: string;
  mode: 'p2p' | 'relay';
  transportFactory: () => TerminalTransport;
  rendererType?: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
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
  } = options;

  return useMemo(() => {
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
      { rendererType: rendererType ?? 'canvas', fontSize, scrollback },
    );
  }, [sessionId, sessionName, mode, transportFactory, rendererType, fontSize, scrollback]);
}
