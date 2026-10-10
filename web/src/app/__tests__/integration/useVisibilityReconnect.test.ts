// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import { WebSocketService } from '@/platform/socket/WebSocketService';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/platform/socket/types';

const OriginalWebSocket = globalThis.WebSocket;
let visibility: 'visible' | 'hidden' = 'visible';

async function connectedService() {
  const service = new WebSocketService('ws://example.test');
  const opened = service.connect();
  const socket = MockWebSocket.instances.at(-1)!;
  socket.open();
  await opened;
  return { service, socket };
}

function backgroundAndForeground() {
  act(() => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('mobile foreground resume (#1213)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    visibility = 'visible';
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('probes a connected transport, reuses it after a reply, and coalesces duplicate visibility', async () => {
    const { service, socket } = await connectedService();
    const runtimeResume = vi.spyOn(sessionRuntimeRegistry, 'resumeForeground');
    const { unmount } = renderHook(() => useVisibilityReconnect(true, service));

    backgroundAndForeground();
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(runtimeResume).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    const request = JSON.parse(socket.send.mock.calls[0][0] as string) as SocketMessage;
    expect(request.msg_type).toBe('server.info');

    await act(async () => {
      socket.message(JSON.stringify({
        msg_type: 'server.info',
        id: request.id,
        timestamp: Date.now(),
        payload: { version: 'test' },
      }));
    });
    expect(service.connectionState).toBe('connected');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    unmount();
    service.dispose();
  });

  it('replaces a stale OPEN socket on bounded probe timeout; late old close is inert', async () => {
    vi.useFakeTimers();
    const { service, socket } = await connectedService();
    const { unmount } = renderHook(() => useVisibilityReconnect(true, service));

    backgroundAndForeground();
    expect(socket.send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_501);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = MockWebSocket.instances[1];
    replacement.open();
    await act(async () => { await Promise.resolve(); });
    expect(service.connectionState).toBe('connected');

    socket.serverClose();
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(service.connectionState).toBe('connected');
    expect(MockWebSocket.instances).toHaveLength(2);
    unmount();
    service.dispose();
  });

  it('accelerates a reconnect timer frozen in background, with one new socket', async () => {
    vi.useFakeTimers();
    const { service, socket } = await connectedService();
    const { unmount } = renderHook(() => useVisibilityReconnect(true, service));
    socket.serverClose();
    expect(service.connectionState).toBe('reconnecting');

    backgroundAndForeground();
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    unmount();
    service.dispose();
  });
});
