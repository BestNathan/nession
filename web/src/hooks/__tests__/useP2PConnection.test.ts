import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useP2PConnection } from '../useP2PConnection';

// ---------------------------------------------------------------------------
// Mock WebSocket — build mock directly on `this` so handlers are shared
// ---------------------------------------------------------------------------

const OriginalWebSocket = globalThis.WebSocket;
const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

interface MockWs {
  _readyState: number;
  binaryType: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let instances: MockWs[] = [];
let _autoOpenCount = 0;

/** @param autoOpenInstances - number of WebSocket instances to auto-open (default 1) */
function setupMock(autoOpenInstances = 1) {
  instances = [];
  _autoOpenCount = autoOpenInstances;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function MockCtor(this: MockWs, _url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    self._readyState = WS.CONNECTING;
    self.binaryType = 'arraybuffer';
    self.onopen = null;
    self.onmessage = null;
    self.onerror = null;
    self.onclose = null;
    self.send = vi.fn();
    self.close = vi.fn(function (this: MockWs) {
      (self as unknown as { readyState: number }).readyState = WS.CLOSED;
      self.onclose?.(new CloseEvent('close'));
    });
    Object.defineProperty(self, 'readyState', {
      get() { return self._readyState; },
      set(v: number) { self._readyState = v; },
      configurable: true,
    });
    instances.push(self);

    if (_autoOpenCount > 0) {
      _autoOpenCount--;
      setTimeout(() => {
        self._readyState = WS.OPEN;
        self.onopen?.(new Event('open'));
      }, 0);
    }
  }
  (MockCtor as unknown as { CONNECTING: number }).CONNECTING = WS.CONNECTING;
  (MockCtor as unknown as { OPEN: number }).OPEN = WS.OPEN;
  (MockCtor as unknown as { CLOSING: number }).CLOSING = WS.CLOSING;
  (MockCtor as unknown as { CLOSED: number }).CLOSED = WS.CLOSED;
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

function last(): MockWs { return instances[instances.length - 1]; }

function flushTimers() {
  return act(() => vi.advanceTimersByTimeAsync(50));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useP2PConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('returns null when options is null', () => {
    const { result } = renderHook(() => useP2PConnection(null));
    expect(result.current).toBeNull();
  });

  it('starts with connecting state (effect fires immediately)', () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 2,
        reconnectBaseDelay: 100,
      }),
    );
    // The useEffect fires synchronously in tests, transitioning from
    // the initial 'disconnected' to 'connecting' immediately.
    expect(result.current!.connectionState).toBe('connecting');
  });

  it('transitions to connecting then connected', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 2,
      }),
    );

    expect(result.current!.connectionState).toBe('connecting');
    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');
  });

  it('waitForConnection resolves once connected', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 2,
      }),
    );

    // Still connecting — the promise should not have resolved yet.
    let resolved = false;
    const waitPromise = result.current!.waitForConnection(5_000).then(() => { resolved = true; });
    expect(resolved).toBe(false);

    await flushTimers(); // socket opens → 'connected'
    await act(async () => { await waitPromise; });
    expect(resolved).toBe(true);
  });

  it('waitForConnection resolves immediately when already connected', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );
    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');

    // Fast path: no timers needed.
    await act(async () => { await result.current!.waitForConnection(); });
  });

  it('reconnects after unexpected close', async () => {
    setupMock(2); // auto-open first AND second (reconnect) WebSockets
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 100,
      }),
    );

    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');

    act(() => { last().onclose!(new CloseEvent('close')); });
    expect(result.current!.connectionState).toBe('reconnecting');
    expect(result.current!.reconnectAttempt).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(200));
    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');
    expect(result.current!.reconnectAttempt).toBe(0);
  });

  it('gives up after max reconnect attempts', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 1,
        reconnectBaseDelay: 50,
      }),
    );

    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');

    // Close first connection → triggers reconnect (attempt 1)
    act(() => { last().onclose!(new CloseEvent('close')); });
    expect(result.current!.connectionState).toBe('reconnecting');

    // Advance past backoff — new WebSocket created. It won't auto-open
    // (only first instance does), so its onopen never fires to reset the counter.
    await act(() => vi.advanceTimersByTimeAsync(100));

    // Close the second WebSocket — attempt counter is at 1, which >= max of 1
    act(() => { last().onclose!(new CloseEvent('close')); });

    expect(result.current!.connectionState).toBe('disconnected');
  });

  it('sendMessage sends JSON when connected', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    await flushTimers();
    expect(result.current!.connectionState).toBe('connected');

    act(() => { result.current!.sendMessage({ msg_type: 'test', payload: {} }); });
    expect(last().send).toHaveBeenCalledTimes(1);
  });

  it('sendMessage is silent when not connected', () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    // Don't wait for auto-open — send while still CONNECTING
    act(() => { result.current!.sendMessage({ msg_type: 'test', payload: {} }); });
    expect(last().send).not.toHaveBeenCalled();
  });

  it('close prevents reconnection', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({
        agentUrl: 'ws://agent:9090/ws',
        sessionName: 'test',
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 100,
      }),
    );

    await flushTimers();
    act(() => { result.current!.close(); });
    expect(result.current!.connectionState).toBe('disconnected');

    const countBefore = instances.length;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(instances.length).toBe(countBefore);
  });

  it('onMessage subscribes and unsubscribes', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    const handler = vi.fn();
    let unsub: () => void;
    act(() => { unsub = result.current!.onMessage(handler); });
    await flushTimers();

    act(() => {
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'test', id: '1', timestamp: 1, payload: {} }),
      }));
    });
    expect(handler).toHaveBeenCalledTimes(1);

    act(() => { unsub!(); });
    act(() => {
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'test', id: '2', timestamp: 2, payload: {} }),
      }));
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles binary messages as synthetic __binary__ type', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    const handler = vi.fn();
    act(() => { result.current!.onMessage(handler); });
    await flushTimers();

    act(() => { last().onmessage!(new MessageEvent('message', { data: new ArrayBuffer(4) })); });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].msg_type).toBe('__binary__');
  });

  it('keeps a stable object identity across state transitions', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    const first = result.current!;
    expect(first.connectionState).toBe('connecting');

    await flushTimers(); // connecting → connected (a state change → re-render)
    // Identity MUST NOT change: Terminal.tsx rebuilds its xterm view when the
    // p2pConnection prop identity changes, so a fresh object per render made
    // unrelated re-renders (e.g. bottom-bar tab toggles) tear down the terminal.
    expect(result.current).toBe(first);
  });

  it('exposes live state through getters despite stable identity', async () => {
    setupMock();
    const { result } = renderHook(() =>
      useP2PConnection({ agentUrl: 'ws://agent:9090/ws', sessionName: 'test' }),
    );

    const conn = result.current!;
    expect(conn.connectionState).toBe('connecting');
    await flushTimers();
    // Same object, but the getter reflects the new state.
    expect(conn.connectionState).toBe('connected');
    expect(conn.reconnectAttempt).toBe(0);
  });
});
