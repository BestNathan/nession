import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';
import type { P2PConnection, P2PMessage } from '../../hooks/useP2PConnection';
import type { WebSocketService } from '../../services/websocket';

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
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('attach sends only client.attach, never a synthetic terminal.input (no phantom Enter)', async () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });
      await cm.attach();
      const send = p2p.sendMessage as ReturnType<typeof vi.fn>;
      const types = send.mock.calls.map((c) => (c[0] as { msg_type: string }).msg_type);
      expect(types).toContain('client.attach');
      // tmux attach-session already redraws on attach; injecting a '\r' left a
      // stray blank prompt line on every (re)attach — assert we no longer do it.
      expect(types).not.toContain('terminal.input');
      cm.dispose();
    });

    it('reattach re-sends client.attach', async () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });
      await cm.reattach();
      const send = p2p.sendMessage as ReturnType<typeof vi.fn>;
      const types = send.mock.calls.map((c) => (c[0] as { msg_type: string }).msg_type);
      expect(types).toContain('client.attach');
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
          payload: { cols: 120, rows: 40 },
        }),
      );
      manager.dispose();
    });
  });

  describe('Relay mode', () => {
    it('send routes data via serverConnection.sendTerminalInput', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      cm.send('hello');
      expect(ws.sendTerminalInput).toHaveBeenCalledWith('a:test', 'hello');
      cm.dispose();
    });

    it('subscribes to terminal output on construction', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      expect(ws.onTerminalOutput).toHaveBeenCalledWith('a:test', expect.any(Function));
      cm.dispose();
    });

    it('transitions to lost after RELAY_MAX_ATTEMPTS and fires onDisconnect exactly once', () => {
      const ws = makeMockWs();
      let stateCb: (status: string) => void = () => {};
      (ws.onConnectionChange as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (status: string) => void) => { stateCb = cb; return () => {}; },
      );
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      const states: string[] = [];
      const onDisconnect = vi.fn();
      cm.onStateChange = (s) => states.push(s);
      cm.onDisconnect = onDisconnect;

      // 15 disconnect signals: attempts 1..10 reconnecting, then latched at lost.
      for (let i = 0; i < 15; i++) { stateCb('disconnected'); }

      expect(states.filter((s) => s === 'reconnecting').length).toBe(10);
      expect(states.filter((s) => s === 'lost').length).toBe(1);
      vi.advanceTimersByTime(3000);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      cm.dispose();
    });

    it('should send terminal.resize message in relay mode via sendTerminalResize', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws,
      });

      cm.sendResize(120, 40);

      expect(ws.sendTerminalResize).toHaveBeenCalledWith('sess-1', 120, 40);
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

      expect(ws.onTerminalResize).toHaveBeenCalledWith('sess-1', expect.any(Function));

      // Simulate server broadcasting terminal.resize for this session
      resizeHandler(120, 40);

      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });
  });
});
