import type { AgentSocketClient } from './AgentSocketClient';
import type { P2PConnection, P2PConnectionState, P2PMessage } from './p2pTypes';

/**
 * Adapts {@link AgentSocketClient} to the legacy {@link P2PConnection} surface
 * used by ConnectionManager, attach drivers, and fileOps during migration.
 */
export class P2PConnectionAdapter implements P2PConnection {
  constructor(private readonly client: AgentSocketClient) {}

  get connectionState(): P2PConnectionState {
    return this.client.connectionState;
  }

  get reconnectAttempt(): number {
    return this.client.reconnectAttempts;
  }

  sendMessage(msg: Record<string, unknown>): void {
    this.client.send({
      msg_type: String(msg.msg_type ?? ''),
      id: String(msg.id ?? ''),
      timestamp: Number(msg.timestamp ?? Date.now()),
      payload: msg.payload,
    });
  }

  onMessage(handler: (msg: P2PMessage) => void): () => void {
    return this.client.onLegacyMessage(handler);
  }

  close(): void {
    this.client.close();
  }

  waitForConnection(timeoutMs?: number): Promise<void> {
    return this.client.waitForConnection(timeoutMs);
  }
}

export function createP2PConnectionAdapter(client: AgentSocketClient): P2PConnection {
  return new P2PConnectionAdapter(client);
}
