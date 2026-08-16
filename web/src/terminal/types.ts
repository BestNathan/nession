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

/** Device class presets for responsive rendering. */
export interface DeviceProfile {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
}
