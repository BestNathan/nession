import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import type { P2PConnection, P2PMessage } from '@/services/socket/p2pTypes';
import type { ConnectionState } from '@/services/socket/types';
import type { RelayServerTransport } from '@/runtime/relayServerConnection';

const attached = { isAttached: () => true };

function makeMockP2P(): P2PConnection {
  return {
    connectionState: 'connected',
    reconnectAttempt: 0,
    sendMessage: vi.fn(),
    onMessage: () => () => {},
    close: vi.fn(),
    waitForConnection: () => Promise.resolve(),
  };
}

function makeMockWs(): RelayServerTransport {
  return {
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onRelayOutput: vi.fn().mockReturnValue(() => {}),
    onRelayResize: vi.fn().mockReturnValue(() => {}),
    onConnectionStateChange: vi.fn().mockReturnValue(() => {}),
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
    isReady: () => true,
  };
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('P2P mode', () => {
    it('send routes data as terminal.input message with base64 encoding', () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p, ...attached,
      });
      cm.send('hello');
      expect(p2p.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          msg_type: 'terminal.input',
          payload: expect.objectContaining({ session_name: 'test', data: expect.any(String) }),
        }),
      );
      cm.dispose();
    });

    it('buffers input until attached and flushes on the next send', () => {
      const p2p = makeMockP2P();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        p2pConnection: p2p,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      expect(p2p.sendMessage).not.toHaveBeenCalled();

      isAttached = true;
      cm.send('world');
      expect(p2p.sendMessage).toHaveBeenCalledTimes(2);
      expect((p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        msg_type: 'terminal.input',
        payload: expect.objectContaining({ session_name: 'test' }),
      });
      cm.dispose();
    });

    it('send is a no-op after dispose', () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p, ...attached,
      });
      cm.dispose();
      cm.send('hello');
      expect(p2p.sendMessage).not.toHaveBeenCalled();
    });

    it('keepalive pings are sent every 30 seconds', () => {
      const p2p = makeMockP2P();
      new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p, ...attached,
      });
      vi.advanceTimersByTime(30_000);
      expect(p2p.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ msg_type: 'keepalive.ping' }),
      );
    });

    it('keepalive stops after dispose', () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p, ...attached,
      });
      cm.dispose();
      const calls = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;
      vi.advanceTimersByTime(60_000);
      expect((p2p.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(calls);
    });

    it('should call onResize callback when terminal.resize message received', () => {
      const onResize = vi.fn();
      let messageHandler: (msg: P2PMessage) => void = () => {};
      const p2p = makeMockP2P();
      p2p.onMessage = (cb: (msg: P2PMessage) => void) => { messageHandler = cb; return () => {}; };

      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', p2pConnection: p2p, ...attached,
      });
      cm.onResize = onResize;

      // Simulate receiving terminal.resize message
      messageHandler({
        msg_type: 'terminal.resize',
        id: 'test-1',
        timestamp: Date.now(),
        payload: { cols: 120, rows: 40 },
      } as P2PMessage);

      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });

    it('should send terminal.resize message in P2P mode', () => {
      const mockSend = vi.fn();
      const mockP2P: P2PConnection = {
        connectionState: 'connected',
        sendMessage: mockSend,
        onMessage: vi.fn().mockReturnValue(() => {}),
        waitForConnection: vi.fn().mockResolvedValue(undefined),
        reconnectAttempt: 0,
        close: vi.fn(),
      };
      const manager = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'sess-1',
        p2pConnection: mockP2P,
        ...attached,
      });

      manager.sendResize(120, 40);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          msg_type: 'terminal.resize',
          payload: { session_name: 'test', cols: 120, rows: 40 },
        }),
      );
      manager.dispose();
    });

    it('buffers sendResize until attached and coalesces to the latest size', () => {
      const p2p = makeMockP2P();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        p2pConnection: p2p,
        isAttached: () => isAttached,
      });

      cm.sendResize(80, 24);
      cm.sendResize(100, 30);
      cm.sendResize(120, 40);
      expect(p2p.sendMessage).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushPendingResize();
      const resizeCalls = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0].msg_type === 'terminal.resize',
      );
      expect(resizeCalls).toHaveLength(1);
      expect(resizeCalls[0][0]).toMatchObject({
        msg_type: 'terminal.resize',
        payload: { session_name: 'test', cols: 120, rows: 40 },
      });
      cm.dispose();
    });

    it('flushAllOutbound sends buffered input first, then coalesced resize', () => {
      const p2p = makeMockP2P();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        p2pConnection: p2p,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      cm.sendResize(120, 40);
      expect(p2p.sendMessage).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushAllOutbound();

      const calls = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      // Input first, then resize — agent expects a live session before
      // accepting terminal.* I/O.
      expect(calls).toHaveLength(2);
      expect(calls[0][0].msg_type).toBe('terminal.input');
      expect(calls[1][0].msg_type).toBe('terminal.resize');
      cm.dispose();
    });

    it('suppresses not_attached errors while state !== attached', () => {
      const onError = vi.fn();
      let messageHandler: (msg: P2PMessage) => void = () => {};
      const p2p = makeMockP2P();
      p2p.onMessage = (cb: (msg: P2PMessage) => void) => { messageHandler = cb; return () => {}; };

      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        p2pConnection: p2p,
        isAttached: () => isAttached,
      });
      cm.onError = onError;

      messageHandler({
        msg_type: 'error',
        id: 'some-id',
        timestamp: Date.now(),
        payload: { message: 'not attached to session: test' },
      } as P2PMessage);
      expect(onError).not.toHaveBeenCalled();

      isAttached = true;
      messageHandler({
        msg_type: 'error',
        id: 'some-id',
        timestamp: Date.now(),
        payload: { message: 'not attached to session: test' },
      } as P2PMessage);
      expect(onError).toHaveBeenCalledTimes(1);
      cm.dispose();
    });
  });

  describe('Relay mode', () => {
    it('send routes data via serverConnection.sendRelayInput', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      cm.send('hello');
      expect(ws.sendRelayInput).toHaveBeenCalledWith('test', 'hello');
      cm.dispose();
    });

    it('subscribes to terminal output on construction', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      expect(ws.onRelayOutput).toHaveBeenCalledWith('test', expect.any(Function));
      cm.dispose();
    });

    it('reports only the durable connection edges — intra-budget loss is a no-op', () => {
      const ws = makeMockWs();
      let stateCb: (state: ConnectionState) => void = () => {};
      (ws.onConnectionStateChange as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (state: ConnectionState) => void) => { stateCb = cb; return () => {}; },
      );
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      const calls: string[] = [];
      cm.onStateChange = (s) => calls.push(s);

      // Post-handshake 'connected' (old 'authenticated') and budget-exhausted
      // 'disconnected' are the only edges this transport reports — the
      // intra-budget window surfaces as 'connecting'/'reconnecting', which the
      // manager mirrors by staying silent (old facade collapsed them onto
      // 'connecting', which ConnectionManager also ignored).
      stateCb('connected');
      stateCb('disconnected');
      stateCb('connecting');
      stateCb('reconnecting');

      expect(calls).toEqual([
        'connected',
        'disconnected',
      ]);
      cm.dispose();
    });

    it('should send terminal.resize message in relay mode via sendRelayResize', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws, ...attached,
      });

      cm.sendResize(120, 40);

      expect(ws.sendRelayResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    it('subscribes to terminal resize and invokes onResize callback', () => {
      const onResize = vi.fn();
      let resizeHandler: (cols: number, rows: number) => void = () => {};
      const ws = makeMockWs();
      (ws.onRelayResize as ReturnType<typeof vi.fn>).mockImplementation(
        (_sid: string, cb: (cols: number, rows: number) => void) => {
          resizeHandler = cb;
          return () => {};
        },
      );

      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws,
      });
      cm.onResize = onResize;

      expect(ws.onRelayResize).toHaveBeenCalledWith('test', expect.any(Function));

      // Simulate server broadcasting terminal.resize for this session
      resizeHandler(120, 40);

      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });

    it('buffers sendResize until attached in relay mode too (same outbound gate)', () => {
      const ws = makeMockWs();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'relay',
        sessionName: 'test',
        sessionId: 'a:test',
        serverConnection: ws,
        isAttached: () => isAttached,
      });

      cm.sendResize(120, 40);
      expect(ws.sendRelayResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushPendingResize();
      expect(ws.sendRelayResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });
  });
});
