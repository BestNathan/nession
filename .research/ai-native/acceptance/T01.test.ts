// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import type { WebSocketService } from '@/platform/socket';

describe('research acceptance T01', () => {
  it('visibility wake never reconnects a disposed transport', () => {
    const service = {
      connectionState: 'disconnected',
      isDisposed: true,
      connect: vi.fn(() => Promise.resolve()),
    } as unknown as WebSocketService;

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    renderHook(() => useVisibilityReconnect(true, service));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(service.connect).not.toHaveBeenCalled();
  });
});
