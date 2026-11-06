// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAppConnection } from '@/app/useAppConnection';
import { setToken, getToken } from '@/app/auth';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/platform/socket/types';

/**
 * #354 regression, with the real auth-storage owner (not the mocked module):
 * a manual Disconnect keeps the credentials, and a reload in a fresh browser
 * session auto-connects with the remembered token. #2822's transition fix must
 * not turn Disconnect into a logout.
 */
const OriginalWebSocket = globalThis.WebSocket;

function authFrameOf(socket: MockWebSocket): SocketMessage {
  return JSON.parse(socket.send.mock.calls[0]?.[0] as string) as SocketMessage;
}

function replySuccess(socket: MockWebSocket): void {
  const request = authFrameOf(socket);
  act(() => {
    socket.message(JSON.stringify({
      msg_type: 'server.auth',
      id: request.id,
      timestamp: Date.now(),
      payload: { status: 'success', message: '' },
    }));
  });
}

async function authenticate(socket: MockWebSocket): Promise<void> {
  await act(async () => {
    socket.open();
  });
  replySuccess(socket);
}

describe('useAppConnection auth persistence (#354)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('manual Disconnect retains the remembered credentials and a reload auto-connects', async () => {
    setToken('remembered-a', true);
    localStorage.setItem('remember', 'true');

    const first = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = MockWebSocket.instances[0];
    await authenticate(firstSocket);
    await waitFor(() => expect(first.result.current.isAuthenticated).toBe(true));

    act(() => {
      first.result.current.handleDisconnect();
    });

    // Disconnect is not a logout: both copies survive for the next visit.
    expect(first.result.current.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem('token')).toBe('remembered-a');
    expect(localStorage.getItem('token')).toBe('remembered-a');
    expect(getToken()).toBe('remembered-a');

    first.unmount();

    // Reload in a fresh browser session: sessionStorage is gone, the durable
    // copy remains, so the transport is brought up automatically.
    sessionStorage.clear();
    MockWebSocket.instances = [];
    const second = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(second.result.current.connectionStatus).toBe('connecting');
    const secondSocket = MockWebSocket.instances[0];
    await act(async () => {
      secondSocket.open();
    });
    expect((authFrameOf(secondSocket).payload as { auth_token: string }).auth_token)
      .toBe('remembered-a');

    replySuccess(secondSocket);
    await waitFor(() => expect(second.result.current.isAuthenticated).toBe(true));
  });
});
