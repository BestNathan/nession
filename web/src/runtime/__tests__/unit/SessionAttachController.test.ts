import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionAttachController } from '@/runtime/SessionAttachController';
import { AttachStateMachine, ATTACH_TIMEOUT_MS } from '@/runtime/AttachStateMachine';
import type { P2PConnection } from '@/services/socket/p2pTypes';

function makeP2pConn() {
  const handlers: Array<(msg: { msg_type: string; id: string; timestamp: number; payload: unknown }) => void> = [];
  const conn = {
    sendMessage: vi.fn(),
    onMessage: vi.fn((handler: (msg: { msg_type: string; id: string; timestamp: number; payload: unknown }) => void) => {
      handlers.push(handler);
      return () => {};
    }),
    get connectionState() {
      return 'connected' as const;
    },
  } as unknown as P2PConnection;
  return { conn, handlers };
}

describe('SessionAttachController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches ATTACH_OK when agent responds ok', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const controller = new SessionAttachController(sm);
    const phases: string[] = [];
    controller.subscribeOutcomes((r) => phases.push(r.phase));

    const { conn, handlers } = makeP2pConn();
    controller.startP2PAttach({
      sessionName: 's1',
      p2pConnection: conn,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });

    const attachId = (conn.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].id as string;
    for (const h of handlers) {
      h({ msg_type: 'ok', id: attachId, timestamp: 0, payload: {} });
    }

    expect(phases).toContain('attached');
    expect(sm.phase).toBe('attached');
  });

  it('signals force-relay after ATTACH_TIMEOUT budget exhausted', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const controller = new SessionAttachController(sm);
    let sawForceRelay = false;
    controller.subscribeOutcomes((r) => {
      if (r.forceRelay) {
        sawForceRelay = true;
      }
    });

    const { conn } = makeP2pConn();
    controller.startP2PAttach({
      sessionName: 's1',
      p2pConnection: conn,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });

    for (let i = 0; i <= 10; i += 1) {
      controller.startP2PAttach({
        sessionName: 's1',
        p2pConnection: conn,
        manualRoute: false,
        lastResize: null,
        transportGeneration: i,
      });
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
    }

    expect(sawForceRelay).toBe(true);
    expect(sm.phase).toBe('connecting');
  });

  it('does not send duplicate attach for the same transport generation', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const controller = new SessionAttachController(sm);
    const { conn } = makeP2pConn();

    controller.startP2PAttach({
      sessionName: 's1',
      p2pConnection: conn,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 3,
    });
    controller.startP2PAttach({
      sessionName: 's1',
      p2pConnection: conn,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 3,
    });

    expect(conn.sendMessage).toHaveBeenCalledTimes(1);
  });
});
