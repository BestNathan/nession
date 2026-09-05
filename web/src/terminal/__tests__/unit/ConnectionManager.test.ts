import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import type { AgentError, TerminalAgentApi } from '@/features/terminal';
import type { ConnectionState } from '@/services/socket/types';
import type { RelayServerTransport } from '@/runtime/relayServerConnection';

const attached = { isAttached: () => true };

interface AgentApiHarness {
  api: TerminalAgentApi;
  outputHandlers: Array<(data: Uint8Array) => void>;
  resizeHandlers: Array<(cols: number, rows: number) => void>;
  errorHandlers: Array<(error: AgentError) => void>;
}

function makeAgentApi(): AgentApiHarness & { unsubs: { output: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  const outputHandlers: Array<(data: Uint8Array) => void> = [];
  const resizeHandlers: Array<(cols: number, rows: number) => void> = [];
  const errorHandlers: Array<(error: AgentError) => void> = [];
  const unsubs = {
    output: vi.fn(() => {}),
    resize: vi.fn(() => {}),
    error: vi.fn(() => {}),
  };
  const api = {
    attach: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    onOutput: vi.fn((cb: (data: Uint8Array) => void) => {
      outputHandlers.push(cb);
      return unsubs.output;
    }),
    onResize: vi.fn((cb: (cols: number, rows: number) => void) => {
      resizeHandlers.push(cb);
      return unsubs.resize;
    }),
    onError: vi.fn((cb: (error: AgentError) => void) => {
      errorHandlers.push(cb);
      return unsubs.error;
    }),
    ping: vi.fn(),
  };
  return {
    api: api as unknown as TerminalAgentApi,
    outputHandlers,
    resizeHandlers,
    errorHandlers,
    unsubs,
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
    it('routes send input through agentApi.sendInput with the session name', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.send('hello');
      expect(api.sendInput).toHaveBeenCalledWith('test', 'hello');
      cm.dispose();
    });

    it('buffers input until attached and flushes on the next send', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      expect(api.sendInput).not.toHaveBeenCalled();

      isAttached = true;
      cm.send('world');
      expect(api.sendInput).toHaveBeenCalledTimes(2);
      expect((api.sendInput as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['test', 'hello']);
      cm.dispose();
    });

    it('send is a no-op after dispose', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      cm.send('hello');
      expect(api.sendInput).not.toHaveBeenCalled();
    });

    it('keepalive pings are sent every 30 seconds', () => {
      const { api } = makeAgentApi();
      new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      vi.advanceTimersByTime(30_000);
      expect(api.ping).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(api.ping).toHaveBeenCalledTimes(2);
    });

    it('keepalive stops after dispose', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      vi.advanceTimersByTime(60_000);
      expect(api.ping).not.toHaveBeenCalled();
    });

    it('routes agent output frames to onOutput', () => {
      const { api, outputHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const onOutput = vi.fn();
      cm.onOutput = onOutput;

      const bytes = new Uint8Array([104, 105]);
      outputHandlers[0]?.(bytes);
      expect(onOutput).toHaveBeenCalledWith(bytes);
      cm.dispose();
    });

    it('routes agent resize frames to onResize', () => {
      const { api, resizeHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      const onResize = vi.fn();
      cm.onResize = onResize;

      resizeHandlers[0]?.(120, 40);
      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });

    it('routes resize outbound through agentApi.sendResize', () => {
      const { api } = makeAgentApi();
      const manager = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      manager.sendResize(120, 40);
      expect(api.sendResize).toHaveBeenCalledWith('test', 120, 40);
      manager.dispose();
    });

    it('buffers sendResize until attached and coalesces to the latest size', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.sendResize(80, 24);
      cm.sendResize(100, 30);
      cm.sendResize(120, 40);
      expect(api.sendResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushPendingResize();
      expect(api.sendResize).toHaveBeenCalledTimes(1);
      expect(api.sendResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    it('flushAllOutbound sends buffered input first, then coalesced resize', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      cm.sendResize(120, 40);
      expect(api.sendInput).not.toHaveBeenCalled();
      expect(api.sendResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushAllOutbound();

      // Input first, then resize — agent expects a live session before
      // accepting terminal.* I/O.
      expect(api.sendInput).toHaveBeenCalledTimes(1);
      expect(api.sendResize).toHaveBeenCalledTimes(1);
      const inputOrder = (api.sendInput as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const resizeOrder = (api.sendResize as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(inputOrder).toBeLessThan(resizeOrder);
      cm.dispose();
    });

    it('suppresses not_attached errors while state !== attached', () => {
      const { api, errorHandlers } = makeAgentApi();
      const onError = vi.fn();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });
      cm.onError = onError;

      errorHandlers[0]?.({ message: 'not attached to session: test', notAttached: true });
      expect(onError).not.toHaveBeenCalled();

      isAttached = true;
      errorHandlers[0]?.({ message: 'not attached to session: test', notAttached: true });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(new Error('not attached to session: test'));
      cm.dispose();
    });

    it('forwards non-not_attached errors even while detached', () => {
      const { api, errorHandlers } = makeAgentApi();
      const onError = vi.fn();
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => false,
      });
      cm.onError = onError;

      errorHandlers[0]?.({ message: 'session terminated', notAttached: false });
      expect(onError).toHaveBeenCalledWith(new Error('session terminated'));
      cm.dispose();
    });

    it('does not forward output, resize, or errors after dispose', () => {
      const { api, outputHandlers, resizeHandlers, errorHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const onOutput = vi.fn();
      const onResize = vi.fn();
      const onError = vi.fn();
      cm.onOutput = onOutput;
      cm.onResize = onResize;
      cm.onError = onError;

      cm.dispose();
      outputHandlers[0]?.(new Uint8Array([1]));
      resizeHandlers[0]?.(80, 24);
      errorHandlers[0]?.({ message: 'boom', notAttached: false });
      expect(onOutput).not.toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('unsubscribes from the agent api on dispose', () => {
      const { api, unsubs } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      expect(unsubs.output).toHaveBeenCalledTimes(1);
      expect(unsubs.resize).toHaveBeenCalledTimes(1);
      expect(unsubs.error).toHaveBeenCalledTimes(1);
    });

    it('a thrown agent send does not escape while the transport is reconnecting', () => {
      const { api } = makeAgentApi();
      (api.sendInput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('WebSocket not connected');
      });
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      expect(() => cm.send('hello')).not.toThrow();
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
