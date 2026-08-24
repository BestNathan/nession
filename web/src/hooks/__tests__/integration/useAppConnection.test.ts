// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAppConnection } from '@/hooks/useAppConnection';
import * as auth from '@/lib/auth';
import * as websocket from '@/services/websocket';
import type { WebSocketService } from '@/services/websocket';

vi.mock('@/lib/auth');
vi.mock('@/services/websocket');
vi.mock('@/hooks/useVisibilityReconnect', () => ({
  useVisibilityReconnect: vi.fn(),
}));

function createMockService(): WebSocketService {
  return {
    onConnectionChange: vi.fn(() => () => {}),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn(() => false),
  } as unknown as WebSocketService;
}

describe('useAppConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    vi.mocked(auth.getRememberPreference).mockReturnValue(true);
    vi.mocked(websocket.destroyWebSocketService).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats stored credentials as session restore (restoring shell while connecting)', () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');
    const mockService = createMockService();
    vi.mocked(websocket.createWebSocketService).mockReturnValue(mockService);

    const { result } = renderHook(() => useAppConnection());

    expect(result.current.connectionStatus).toBe('connecting');
    expect(result.current.isRestoringSession).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.authToken).toBe('stored-token');
  });

  it('starts disconnected when no stored credentials', () => {
    vi.mocked(auth.getToken).mockReturnValue(null);

    const { result } = renderHook(() => useAppConnection());

    expect(result.current.connectionStatus).toBe('disconnected');
    expect(result.current.isRestoringSession).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('auto-connects when stored token exists', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');
    const mockService = createMockService();
    vi.mocked(websocket.createWebSocketService).mockReturnValue(mockService);

    renderHook(() => useAppConnection());

    await waitFor(() => {
      expect(websocket.createWebSocketService).toHaveBeenCalled();
      expect(mockService.connect).toHaveBeenCalled();
    });
    expect(auth.setToken).toHaveBeenCalledWith('stored-token', true);
  });

  it('clears auth state when auto-connect fails', async () => {
    vi.mocked(auth.getToken).mockReturnValue('bad-token');
    const mockService = createMockService();
    vi.mocked(mockService.connect).mockRejectedValue(new Error('auth failed'));
    vi.mocked(websocket.createWebSocketService).mockReturnValue(mockService);

    const { result } = renderHook(() => useAppConnection());

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('disconnected');
      expect(result.current.isRestoringSession).toBe(false);
      expect(result.current.isAuthenticated).toBe(false);
    });
    expect(auth.clearToken).toHaveBeenCalled();
  });

  it('handleDisconnect clears session restore state', async () => {
    vi.mocked(auth.getToken).mockReturnValue('stored-token');
    const mockService = createMockService();
    vi.mocked(websocket.createWebSocketService).mockReturnValue(mockService);

    const { result } = renderHook(() => useAppConnection());

    await waitFor(() => expect(mockService.connect).toHaveBeenCalled());

    act(() => {
      result.current.handleDisconnect();
    });

    expect(result.current.isRestoringSession).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(websocket.destroyWebSocketService).toHaveBeenCalled();
  });
});
