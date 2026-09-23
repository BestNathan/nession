import type { TerminalAgentApi } from '@/product/terminal';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';

/** Banner state surfaced to the React layer for UI rendering. */
export type ReconnectBanner = 'none' | 'reconnecting' | 'failed';

/** Options passed to ConnectionManager constructor. */
export interface ConnectionOptions {
  mode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  /** P2P-mode agent terminal capability (see product/terminal). */
  agentApi?: TerminalAgentApi;
  /** Relay-mode server connection handle (see relayServerHandle). */
  serverConnection?: RelayServerTransport;
  /** Manual relay endpoint URL from the attach dialog. */
  relayUrl?: string | null;
  /** When false, input/resize is buffered until attach completes. */
  isAttached?: () => boolean;
}

/** Device class for responsive rendering. */
export type DeviceProfile = 'mobile' | 'desktop';

/** Scrollback ownership for the terminal surface. */
export type TerminalScrollbackMode = 'local-buffer' | 'legacy';

/** Device profile configuration. */
export interface DeviceProfileConfig {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
}

/** Options passed to TerminalInstance constructor. */
export interface TerminalInstanceOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  /**
   * xterm's own `lineHeight`: a multiple of the terminal font's measured box,
   * not of `fontSize` the way CSS `line-height` is. Owned by
   * `experience.{web,app}.terminal.lineHeight`.
   */
  lineHeight?: number;
  scrollback?: number;
}

/** Input source types for the two-layer input system. */
export type InputSource =
  | 'keyboard'           // Physical keyboard (Desktop)
  | 'touch'              // Touch screen (Mobile)
  | 'mouse'              // Mouse (selection/click)
  | 'component-input'    // InputPanel component
  | 'component-quickcmd' // QuickCommandsPanel component
  | string;              // Extensible for future sources

/** Input event passed through the two-layer input system. */
export interface InputEvent {
  source: InputSource;
  data: string;
  timestamp: number;
}

/**
 * Discriminated union of terminal input modes.
 *
 * Extracted from terminal/state/input.ts during the Phase 3 runtime split —
 * runtime consumers (InputRouter, TerminalController) must not depend on the
 * Jotai state layer, so the type lives here and state/ re-exports it.
 */
export type InputMode =
  | { type: 'terminal' }
  | { type: 'command' }
  | { type: 'search' }
  | { type: 'ai' }
  | { type: 'custom'; id: string };

/**
 * Attach lifecycle status of the local terminal connection.
 *
 * Defined in `src/types.ts` so the `shared` atoms can name it too; re-exported
 * here so runtime consumers keep their existing import.
 */
import type { TerminalStatus } from '../../types';
export type { TerminalStatus };

/**
 * Local terminal connection instance — distinct from the backend `Session`
 * concept.
 */
export interface TerminalSession {
  id: string;
  name: string;
  status: TerminalStatus;
  mode: 'p2p' | 'relay';
  startedAt: number;
}
