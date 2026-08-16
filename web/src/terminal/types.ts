import type { P2PConnection } from '../hooks/useP2PConnection';
import type { WebSocketService } from '../services/websocket';

/** Banner state surfaced to the React layer for UI rendering. */
export type ReconnectBanner = 'none' | 'reconnecting' | 'failed';

/** Connection state tracked internally by ConnectionManager. */
export type ConnectionState = 'connected' | 'reconnecting' | 'lost';

/** Options passed to ConnectionManager constructor. */
export interface ConnectionOptions {
  mode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection?: P2PConnection;
  serverConnection?: WebSocketService;
  /** Manual relay endpoint URL from the attach dialog. */
  relayUrl?: string | null;
}

/** Device class for responsive rendering. */
export type DeviceProfile = 'mobile' | 'desktop';

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
