import type {
  TerminalBufferSnapshot,
  TerminalModeSnapshot,
} from '../emulator';

/**
 * How an expanded upper Peek clears the terminal (#3492).
 *
 * `scroll-clearance` is #2710's reversible visual pan: the normal buffer keeps
 * its xterm rows and PTY size, and the rendered screen is shifted only while a
 * panel is open.
 *
 * `viewport-reserve` is the scoped exception for applications whose screen the
 * browser cannot pan: the alternate screen has no local scrollback, and a
 * mouse-reporting application owns wheel/pointer coordinates. Those views
 * instead give the upper panel real grid rows, so the application redraws its
 * own bottom/status/input rows above it. Columns are always canonical.
 */
export type TerminalClearancePolicy = 'scroll-clearance' | 'viewport-reserve';

/** The minimum rows a reserve must leave for the TUI to stay usable. */
export const MIN_RESERVED_ROWS = 6;

/**
 * The policy is a function of the terminal's actual state, never a process
 * name or a Product guess. Both a mouse-tracking normal-buffer application and
 * an alternate-screen application own their screen and pointer input, so both
 * reserve rows instead of being transformed.
 */
export function terminalClearancePolicyFor(
  modes: TerminalModeSnapshot,
  buffer: TerminalBufferSnapshot,
): TerminalClearancePolicy {
  if (modes.mouseTrackingMode !== 'none' || modes.alternateBuffer || buffer.type === 'alternate') {
    return 'viewport-reserve';
  }
  return 'scroll-clearance';
}

/**
 * The observed clearance state published to Product/UI.
 *
 * `fallback` is only meaningful for `viewport-reserve`: it says the terminal
 * could not give the panel the rows it asked for (no ControlLease authority,
 * or too little viewport), so the UI must offer a compact/collapsible Peek
 * rather than silently covering the application's bottom rows.
 */
export interface TerminalClearanceState {
  readonly policy: TerminalClearancePolicy;
  /** Upper-panel pixels the terminal actually reserved this frame. */
  readonly reservedPx: number;
  /** Upper-panel pixels the capsule reported for the open Peek. */
  readonly requestedPx: number;
  readonly fallback: boolean;
}

/** Host event carrying one {@link TerminalClearanceState}. */
export const TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT = 'terminal-capsule-clearance-state';

/** Host data attribute used for E2E assertions and initial UI state. */
export const TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE = 'data-terminal-clearance-fallback';
