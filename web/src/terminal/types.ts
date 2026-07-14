import type { ITheme } from '@xterm/xterm';
import type { P2PConnection } from '../hooks/useP2PConnection';
import type { WebSocketService } from '../services/websocket';

/** Banner state surfaced to the React layer for UI rendering. */
export type ReconnectBanner = 'none' | 'reconnecting' | 'failed';

/** Connection state tracked internally by ConnectionManager. */
export type ConnectionState = 'connected' | 'reconnecting' | 'lost';

/** State exposed by TerminalView to React for banner rendering. */
export interface TerminalViewState {
  banner: ReconnectBanner;
  reconnectAttempt: number;
  isConnected: boolean;
}

/** Options passed to ConnectionManager constructor. */
export interface ConnectionOptions {
  mode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection?: P2PConnection;
  serverConnection?: WebSocketService;
}

/** Options passed to TerminalView constructor. */
export interface TerminalViewOptions {
  rendererType?: 'webgl' | 'canvas';
  theme?: ITheme;
  connection: ConnectionOptions;
  deviceProfile?: DeviceProfile;
  targetColumns?: number;
}

/** Device class presets for responsive rendering. */
export interface DeviceProfile {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
}

/** Imperative methods exposed by the Terminal React component via ref. */
export interface TerminalHandle {
  sendText: (text: string) => void;
  refit: () => void;
}

/** Props for the Terminal React component — unchanged from current API. */
export interface TerminalProps {
  sessionId: string;
  sessionName: string;
  mode: 'p2p' | 'relay';
  p2pConnection?: P2PConnection | null;
  serverConnection?: WebSocketService;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onBannerChange?: (blocked: boolean) => void;
  onCtrlD?: () => void;
  /** Renderer chosen at attach; forced to 'canvas' if WebGL unsupported. */
  renderer?: 'webgl' | 'canvas';
}
