// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';
import { useAppConnection } from '@/app/useAppConnection';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import * as auth from '@/lib/auth';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/services/socket/types';

vi.mock('@/lib/auth');
vi.mock('@/app/useVisibilityReconnect', () => ({
  useVisibilityReconnect: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
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

  it('StrictMode: a refused auto-connect still lands on the login state', async () => {
    vi.mocked(auth.getToken).mockReturnValue('bad-token');

    const { result } = renderHook(() => useAppConnection(), { wrapper: StrictMode });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.open();
    });
    replyToAuth(socket, 'failed');

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('disconnected');
      expect(result.current.isRestoringSession).toBe(false);
    });
    // The restore flag has to clear in a StrictMode build exactly as it does in
    // a production one: it gates the visibility-reconnect path, so leaving it
    // set would send a doomed handshake on every tab focus.
    expect(vi.mocked(useVisibilityReconnect)).toHaveBeenLastCalledWith(false, result.current.wsService);
  });

  it('manual connect with a failing handshake toasts and drops to disconnected', async () => {
    const { result } = renderHook(() => useAppConnection());

    act(() => {
      result.current.setAuthToken('manual-token');
    });
    act(() => {
      result.current.handleConnect(false);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.open();
    });
    replyToAuth(socket, 'failed');

    // The manual path surfaces the failure: a toast naming the server's
    // rejection plus a return to the disconnected (login) state.
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('disconnected');
      expect(result.current.isAuthenticated).toBe(false);
    });
    expect(toast.error).toHaveBeenCalledWith('Connection failed: invalid token');
    // Clearing stored credentials is auto-connect semantics only.
    expect(vi.mocked(auth.clearToken)).not.toHaveBeenCalled();
    // #692: the refusal is terminal, so nothing is retrying behind the login
    // page — the Connect button is usable again on the next render instead of
    // being disabled for the length of a reconnect budget.
    expect(result.current.wsService?.connectionState).toBe('disconnected');
    expect(result.current.wsService?.reconnectAttempts).toBe(0);
  });

  it('manual connect opens exactly one socket — no auto-connect supersede', async () => {
    // Real storage semantics: the token connectInternal writes is visible to
    // getToken() on the next render. That flip is what armed the auto-connect
    // effect and superseded the manual connection's CONNECTING socket (#688).
    let storedToken: string | null = null;
    vi.mocked(auth.setToken).mockImplementation((token: string) => {
      storedToken = token;
    });
    vi.mocked(auth.getToken).mockImplementation(() => storedToken);

    const { result } = renderHook(() => useAppConnection());
    expect(MockWebSocket.instances).toHaveLength(0);

    act(() => {
      result.current.setAuthToken('manual-token');
    });
    act(() => {
      result.current.handleConnect(false);
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    await completeHandshake(socket);

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    // One click, one transport: the second service would have disposed the
    // first one's socket while it was still CONNECTING.
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('editing the token after a disconnect does not auto-connect', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await completeHandshake(MockWebSocket.instances[0]);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    act(() => {
      result.current.handleDisconnect();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      result.current.setAuthToken('a-different-token');
    });

    // Auto-connect is a load-time action. Editing the form is not a connect
    // trigger — only the manual button (or a wire that already exists) is.
    expect(MockWebSocket.instances).toHaveLength(1);
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

  it('StrictMode double-mount starts exactly one auto-connect transport', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');

    const { result } = renderHook(() => useAppConnection(), { wrapper: StrictMode });

    // Auto-connect is a load-time action, so StrictMode's mount→cleanup→mount
    // must not start a second transport: the second would dispose the first
    // while its socket was still CONNECTING, which the browser reports as a
    // failed connection (the #688 warning string) on every dev page load
    // (#697).
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    expect(socket.close).not.toHaveBeenCalled();

    // The surviving transport must still drive React state. The simulated
    // unmount tears down every effect-owned subscription, so a guard that left
    // the service unreachable would strand the shell at 'connecting' instead.
    await completeHandshake(socket);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.isAuthenticated).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
