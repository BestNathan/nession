import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import type { P2PConnection, P2PMessage } from '@/hooks/useP2PConnection';
import type { WebSocketService } from '@/services/websocket';

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

function makeMockWs(): WebSocketService {
  return {
    sendTerminalInput: vi.fn(),
    sendTerminalResize: vi.fn(),
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onTerminalOutput: vi.fn().mockReturnValue(() => {}),
    onTerminalResize: vi.fn().mockReturnValue(() => {}),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    requestAttach: vi.fn().mockResolvedValue({ mode: 'relay' }),
    isConnected: () => true,
  } as unknown as WebSocketService;
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // send() buffers input until the session state machine is 'attached'.
    getDefaultStore().set(terminalSessionStateAtom, 'attached');
  });

  afterEach(() => {
    vi.useRealTimers();
    getDefaultStore().set(terminalSessionStateAtom, 'idle');
  });

  describe('P2P mode', () => {
    it('send routes data as terminal.input message with base64 encoding', () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
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
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });

      // Not attached yet → input is buffered, nothing is sent (would race
      // ahead of client.attach).
      getDefaultStore().set(terminalSessionStateAtom, 'connecting');
      cm.send('hello');
      expect(p2p.sendMessage).not.toHaveBeenCalled();

      // Once attached, the next send flushes the buffered input first.
      getDefaultStore().set(terminalSessionStateAtom, 'attached');
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
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });
      cm.dispose();
      cm.send('hello');
      expect(p2p.sendMessage).not.toHaveBeenCalled();
    });

    it('keepalive pings are sent every 30 seconds', () => {
      const p2p = makeMockP2P();
      new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });
      vi.advanceTimersByTime(30_000);
      expect(p2p.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ msg_type: 'keepalive.ping' }),
      );
    });

    it('keepalive stops after dispose', () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
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
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', p2pConnection: p2p,
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
  });

  describe('Relay mode', () => {
    it('send routes data via serverConnection.sendRelayInput', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      cm.send('hello');
      expect(ws.sendRelayInput).toHaveBeenCalledWith('test', 'hello');
      cm.dispose();
    });

    it('subscribes to terminal output on construction', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      expect(ws.onTerminalOutput).toHaveBeenCalledWith('test', expect.any(Function));
      cm.dispose();
    });

    it('maps relay connection status to onStateChange (authenticated → connected, disconnected → lost)', () => {
      const ws = makeMockWs();
      let stateCb: (status: string) => void = () => {};
      (ws.onConnectionChange as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (status: string) => void) => { stateCb = cb; return () => {}; },
      );
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      const calls: Array<[string, number]> = [];
      cm.onStateChange = (s, attempt) => calls.push([s, attempt]);

      stateCb('authenticated');
      stateCb('disconnected');
      stateCb('connecting');
      stateCb('connected');

      expect(calls).toEqual([
        ['connected', 0],
        ['lost', 0],
      ]);
      cm.dispose();
    });

    it('should send terminal.resize message in relay mode via sendRelayResize', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws,
      });

      cm.sendResize(120, 40);

      expect(ws.sendRelayResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    it('subscribes to terminal resize and invokes onResize callback', () => {
      const onResize = vi.fn();
      let resizeHandler: (cols: number, rows: number) => void = () => {};
      const ws = makeMockWs();
      (ws.onTerminalResize as ReturnType<typeof vi.fn>).mockImplementation(
        (_sid: string, cb: (cols: number, rows: number) => void) => {
          resizeHandler = cb;
          return () => {};
        },
      );

      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws,
      });
      cm.onResize = onResize;

      expect(ws.onTerminalResize).toHaveBeenCalledWith('test', expect.any(Function));

      // Simulate server broadcasting terminal.resize for this session
      resizeHandler(120, 40);

      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });
  });
});
