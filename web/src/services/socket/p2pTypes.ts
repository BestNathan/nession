/** Legacy P2P wire message shape shared by terminal transport and file ops. */
export interface P2PMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type P2PConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type MessageHandler = (msg: P2PMessage) => void;

/** Legacy adapter surface consumed by ConnectionManager and fileOps during migration. */
export interface P2PConnection {
  sendMessage: (msg: Record<string, unknown>) => void;
  onMessage: (handler: MessageHandler) => () => void;
  connectionState: P2PConnectionState;
  reconnectAttempt: number;
  close: () => void;
  waitForConnection: (timeoutMs?: number) => Promise<void>;
}
