import { useLayoutEffect, useState, type RefObject } from 'react';
import {
  TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT,
  TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE,
  type TerminalClearancePolicy,
  type TerminalClearanceState,
} from '@/platform/terminal-runtime/capsule/clearancePolicy';

export interface TerminalClearanceUiState {
  readonly policy: TerminalClearancePolicy;
  readonly fallback: boolean;
}

const DEFAULT_STATE: TerminalClearanceUiState = {
  policy: 'scroll-clearance',
  fallback: false,
};

/**
 * Observe the terminal runtime's upper-panel clearance state (#3492).
 *
 * The runtime owns the mode-derived policy and whether the terminal could give
 * the panel the rows it asked for. Product only consumes that fact to offer a
 * compact Peek when the application's bottom rows would otherwise be covered.
 * The same fact is mirrored as a host attribute that the E2E specs read.
 */
export function useTerminalClearanceState(
  shellRef: RefObject<HTMLElement | null>,
): TerminalClearanceUiState {
  const [state, setState] = useState<TerminalClearanceUiState>(DEFAULT_STATE);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const host = shell?.closest('[data-terminal-capsule-host]');
    if (!(host instanceof HTMLElement)) {
      return;
    }
    const readAttribute = (): boolean =>
      host.getAttribute(TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE) === 'compact';
    setState((current) => {
      const fallback = readAttribute();
      return current.fallback === fallback ? current : { ...current, fallback };
    });

    const listener = (event: Event) => {
      const detail = (event as CustomEvent<TerminalClearanceState>).detail;
      if (!detail) {
        return;
      }
      setState({ policy: detail.policy, fallback: detail.fallback });
    };
    host.addEventListener(TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT, listener);
    return () => {
      host.removeEventListener(TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT, listener);
    };
  }, [shellRef]);

  return state;
}
