import { useCallback, useEffect, useRef } from 'react';

/**
 * Markers that a user is *using* this terminal, not merely holding it open.
 *
 * The product contract (#2286): the most recently **activated** terminal
 * client owns the shared ControlLease and drives the PTY size. "Activated" is
 * a meaningful foreground action — opening the session's terminal, returning
 * to its surface, focusing the window on it, or touching it — and never a
 * passive event. A background tab's reflow, a ReplayObserver fire, a capsule
 * inset or a transport reconnect alone must leave the lease where it is.
 */
export interface TerminalActivationOptions {
  sessionName: string;
  /** The Terminal surface is the foreground surface for this session. */
  foreground: boolean;
  /** The Agent acknowledged this client's attach to the session. */
  attached: boolean;
  /** Acquire the lease; resolves true only when ownership moved to this client. */
  adoptControl: () => Promise<boolean>;
  /** This client is now the Controller: state its measured viewport. */
  onAdopted: () => void;
}

export interface TerminalActivation {
  /**
   * A real user gesture on the terminal surface (pointer or key). Wired by the
   * composition; every other trigger lives in this hook.
   */
  onTerminalGesture: () => void;
}

export function useTerminalActivation(
  options: TerminalActivationOptions,
): TerminalActivation {
  const latest = useRef(options);
  latest.current = options;

  /** The session whose first attach already requested activation. */
  const openedSession = useRef<string | null>(null);
  /** A gesture arrived before the session was attached; act once it is. */
  const pendingGesture = useRef(false);
  /** One acquire at a time: focus + gesture can land in the same tick. */
  const inFlight = useRef(false);
  const wasForeground = useRef(options.foreground);

  const run = useCallback(() => {
    if (inFlight.current) {
      return;
    }
    const session = latest.current.sessionName;
    inFlight.current = true;
    void latest.current
      .adoptControl()
      .then((adopted) => {
        // The session changed while the acquire was in flight: the reply is
        // about a lease this surface no longer represents.
        if (adopted && latest.current.sessionName === session) {
          latest.current.onAdopted();
        }
      })
      .catch(() => {
        // A failed acquire is not a state change. The next meaningful
        // activation retries; the observer bar's explicit action remains.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  /** A trigger that only makes sense on the foreground, attached terminal. */
  const activateIfReady = useCallback(() => {
    const { foreground, attached } = latest.current;
    if (!foreground || !attached) {
      return false;
    }
    run();
    return true;
  }, [run]);

  // Opening the session's terminal: the first time this surface is both
  // foreground and attached, that is a meaningful foreground activation.
  // Later attach transitions on the same session are reconnects, and must not
  // take the lease back on their own.
  useEffect(() => {
    if (!options.foreground || !options.attached) {
      return;
    }
    if (openedSession.current === options.sessionName) {
      return;
    }
    openedSession.current = options.sessionName;
    run();
  }, [options.foreground, options.attached, options.sessionName, run]);

  // Returning to the terminal surface after another surface held the work
  // area is an activation of its own, even though the session never detached.
  useEffect(() => {
    const was = wasForeground.current;
    wasForeground.current = options.foreground;
    if (!was && options.foreground && options.attached
      && openedSession.current === options.sessionName) {
      run();
    }
  }, [options.foreground, options.attached, options.sessionName, run]);

  // The document/window coming back to the foreground on a visible terminal
  // is the PC-returns case. It is a user action, not a reconnect: the runtime
  // may also start reconnecting here, but the activation is what takes the
  // lease.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        activateIfReady();
      }
    };
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') {
        activateIfReady();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activateIfReady]);

  // A gesture that landed while the session was still attaching is intent that
  // must not be dropped; attach replaces nothing about it.
  useEffect(() => {
    if (!pendingGesture.current || !options.attached || !options.foreground) {
      return;
    }
    pendingGesture.current = false;
    run();
  }, [options.attached, options.foreground, run]);

  const onTerminalGesture = useCallback(() => {
    if (activateIfReady()) {
      return;
    }
    if (latest.current.foreground) {
      pendingGesture.current = true;
    }
  }, [activateIfReady]);

  return { onTerminalGesture };
}
