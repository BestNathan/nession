import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';
import type { P2PConnection, P2PMessage } from '../../hooks/useP2PConnection';

// A P2PConnection whose waitForConnection resolves only when we say so, and
// whose connectionState we can flip. Mirrors the real hook contract closely
// enough for ConnectionManager's attach() path.
function makeDeferredP2P() {
  let resolveWait: () => void = () => {};
  let state: P2PConnection['connectionState'] = 'connecting';
  const handlers = new Set<(m: P2PMessage) => void>();
  const conn: P2PConnection = {
    get connectionState() { return state; },
    get reconnectAttempt() { return 0; },
    sendMessage: vi.fn(),
    onMessage: vi.fn((h: (m: P2PMessage) => void) => { handlers.add(h); return () => handlers.delete(h); }),
    close: vi.fn(),
    waitForConnection: vi.fn(
      () => new Promise<void>((resolve) => { resolveWait = resolve; }),
    ),
  };
  return {
    conn,
    open: () => { state = 'connected'; resolveWait(); },
  };
}

describe('ConnectionManager P2P attach (issue #51)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does NOT send client.attach before the socket is connected', async () => {
    const { conn } = makeDeferredP2P();
    const cm = new ConnectionManager({
      mode: 'p2p', sessionName: 's', sessionId: 'a:s', p2pConnection: conn,
    });

    // attach() is pending on waitForConnection — nothing sent yet.
    const p = cm.attach();
    await Promise.resolve(); // let the microtask chain run one turn
    expect(conn.sendMessage).not.toHaveBeenCalled();
    void p;
  });

  it('sends client.attach exactly once after the socket opens', async () => {
    const { conn, open } = makeDeferredP2P();
    const cm = new ConnectionManager({
      mode: 'p2p', sessionName: 'mysess', sessionId: 'a:mysess', p2pConnection: conn,
    });

    const p = cm.attach();
    await Promise.resolve();
    expect(conn.sendMessage).not.toHaveBeenCalled();

    open();          // socket becomes OPEN → waitForConnection resolves
    await p;         // attach() proceeds past the await

    expect(conn.sendMessage).toHaveBeenCalledTimes(1);
    const sent = (conn.sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(sent.msg_type).toBe('client.attach');
    expect((sent.payload as Record<string, unknown>).session_name).toBe('mysess');
  });

  it('does not send if disposed while waiting for the socket', async () => {
    const { conn, open } = makeDeferredP2P();
    const cm = new ConnectionManager({
      mode: 'p2p', sessionName: 's', sessionId: 'a:s', p2pConnection: conn,
    });

    const p = cm.attach();
    cm.dispose();    // disposed before the socket opens
    open();
    await p;

    expect(conn.sendMessage).not.toHaveBeenCalled();
  });
});
