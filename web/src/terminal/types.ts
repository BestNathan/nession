import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { RelayServerTransport } from '@/runtime/relayServerConnection';

/** Banner state surfaced to the React layer for UI rendering. */
export type ReconnectBanner = 'none' | 'reconnecting' | 'failed';

/** Options passed to ConnectionManager constructor. */
export interface ConnectionOptions {
  mode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection?: P2PConnection;
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
