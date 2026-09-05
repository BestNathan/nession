// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAppConnection } from '@/hooks/useAppConnection';
import * as auth from '@/lib/auth';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/services/socket/types';

vi.mock('@/lib/auth');
vi.mock('@/hooks/useVisibilityReconnect', () => ({
  useVisibilityReconnect: vi.fn(),
}));

const OriginalWebSocket = globalThis.WebSocket;

/** The first frame a socket sent — the client.auth handshake request. */
function authRequestOf(socket: MockWebSocket): SocketMessage {
  const raw = socket.send.mock.calls[0]?.[0] as string | undefined;
  return JSON.parse(raw ?? '') as SocketMessage;
}

/** Reply to the socket's client.auth request, inside an act(). */
function replyToAuth(socket: MockWebSocket, status: 'success' | 'failed'): void {
  const request = authRequestOf(socket);
  act(() => {
    socket.message(
      JSON.stringify({
        msg_type: 'client.auth.response',
        id: request.id,
        timestamp: Date.now(),
        payload:
          status === 'success'
            ? { status: 'success', message: '' }
            : { status: 'failed', message: 'invalid token' },
      }),
    );
  });
}

/** Drive the server side of a connection attempt to full authentication. */
async function completeHandshake(socket: MockWebSocket): Promise<void> {
  await act(async () => {
    socket.open();
  });
  replyToAuth(socket, 'success');
}

describe('useAppConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    MockWebSocket.instances = [];
    // The shared double implements only the members the transport touches;
    // cast through unknown like every other socket test in the repo.
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    vi.mocked(auth.getRememberPreference).mockReturnValue(true);
    vi.mocked(auth.getToken).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('treats stored credentials as session restore (restoring shell while connecting)', () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection());

    expect(result.current.connectionStatus).toBe('connecting');
    expect(result.current.isRestoringSession).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.authToken).toBe('stored-token');
    // The transport is already being brought up — never idle while restoring.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('starts disconnected when no stored credentials', () => {
    const { result } = renderHook(() => useAppConnection());

    expect(result.current.connectionStatus).toBe('disconnected');
    expect(result.current.isRestoringSession).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('auto-connects with the stored token and reaches connected after the handshake', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];

    await completeHandshake(socket);

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isRestoringSession).toBe(false);

    // Wire frame: client.auth carrying the token + a persisted client id.
    const frame = authRequestOf(socket);
    expect(frame.msg_type).toBe('client.auth');
    expect((frame.payload as { auth_token: string }).auth_token).toBe('stored-token');
    const clientId = (frame.payload as { client_id: string }).client_id;
    expect(clientId).toBeTruthy();
    expect(localStorage.getItem('nessioclientid')).toBe(clientId);
    expect(vi.mocked(auth.setToken)).toHaveBeenCalledWith('stored-token', true);
  });

  it('surfaces reconnecting when a connected transport drops', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result, unmount } = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    await completeHandshake(socket);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    act(() => {
      socket.serverClose();
    });

    // The old facade collapsed this onto 'connecting'; the new transport
    // surfaces 'reconnecting' while a reconnect is scheduled.
    expect(result.current.connectionStatus).toBe('reconnecting');
    expect(result.current.isAuthenticated).toBe(false);

    // Unmounting must tear down the transport, cancelling the pending timer.
    act(() => {
      unmount();
    });
    expect(socket.close).toHaveBeenCalled();
  });

  it('clears auth state when the auto-connect handshake fails', async () => {
    vi.mocked(auth.getToken).mockReturnValue('bad-token');

    const { result } = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.open();
    });
    replyToAuth(socket, 'failed');

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('disconnected');
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.isRestoringSession).toBe(false);
    });
    expect(vi.mocked(auth.clearToken)).toHaveBeenCalled();
  });

  it('handleDisconnect disposes the live transport and exits restore state', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    await completeHandshake(socket);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    act(() => {
      result.current.handleDisconnect();
    });

    expect(result.current.connectionStatus).toBe('disconnected');
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isRestoringSession).toBe(false);
    expect(socket.close).toHaveBeenCalled();
  });

  it('StrictMode double-mount keeps exactly one live transport', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection(), { wrapper: StrictMode });

    // Both effect passes constructed a service; the first was disposed.
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const [first, second] = MockWebSocket.instances;
    expect(first.close).toHaveBeenCalled();

    // Only the surviving transport completes the handshake.
    await completeHandshake(second);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.isAuthenticated).toBe(true);
    expect(second.close).not.toHaveBeenCalled();
  });
});
