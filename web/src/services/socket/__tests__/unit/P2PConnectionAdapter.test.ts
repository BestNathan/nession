import { describe, it, expect, vi } from 'vitest';
import { createP2PConnectionAdapter } from '@/services/socket/P2PConnectionAdapter';
import type { AgentSocketClient } from '@/services/socket/AgentSocketClient';

function makeClient(): AgentSocketClient {
  const legacyUnsubs = new Set<() => void>();
  return {
    connectionState: 'connected',
    reconnectAttempts: 2,
    send: vi.fn(),
    onLegacyMessage: vi.fn((handler) => {
      legacyUnsubs.add(() => {});
      void handler;
      return () => legacyUnsubs.delete(() => {});
    }),
    close: vi.fn(),
    waitForConnection: vi.fn(async () => {}),
  } as unknown as AgentSocketClient;
}

describe('P2PConnectionAdapter', () => {
  it('delegates to AgentSocketClient', async () => {
    const client = makeClient();
    const conn = createP2PConnectionAdapter(client);

    expect(conn.connectionState).toBe('connected');
    expect(conn.reconnectAttempt).toBe(2);

    conn.sendMessage({ msg_type: 'ping', id: '1', timestamp: 0, payload: {} });
    expect(client.send).toHaveBeenCalled();

    conn.onMessage(() => {});
    expect(client.onLegacyMessage).toHaveBeenCalled();

    conn.close();
    expect(client.close).toHaveBeenCalled();

    await conn.waitForConnection(1000);
    expect(client.waitForConnection).toHaveBeenCalledWith(1000);
  });
});
