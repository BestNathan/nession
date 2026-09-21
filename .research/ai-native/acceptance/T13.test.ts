// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import type { WebSocketService } from '@/platform/socket';

describe('research acceptance T13', () => {
  it('visibility wake can explicitly re-arm a stopped transport after automatic budget exhaustion', () => {
    const connect = vi.fn(() => Promise.resolve());
    const service = {
      connectionState: 'disconnected',
      reconnectAttempts: 10,
      isDisposed: false,
      connect,
    } as unknown as WebSocketService;

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    renderHook(() => useVisibilityReconnect(true, service));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
