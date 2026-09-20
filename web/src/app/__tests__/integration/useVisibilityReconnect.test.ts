// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import type { WebSocketService } from '@/platform/socket';

function makeService(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    connectionState: 'disconnected',
    isDisposed: false,
    connect: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as WebSocketService;
}

function becomeVisible(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useVisibilityReconnect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects a live disconnected transport after an authenticated session wakes', () => {
    const service = makeService();
    renderHook(() => useVisibilityReconnect(true, service));

    becomeVisible();

    expect(service.connect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect a disposed transport', () => {
    const service = makeService({ isDisposed: true });
    renderHook(() => useVisibilityReconnect(true, service));

    becomeVisible();

    expect(service.connect).not.toHaveBeenCalled();
  });

  it('keeps existing guards for unauthenticated or non-disconnected transports', () => {
    const unauthenticated = makeService();
    const { unmount } = renderHook(() => useVisibilityReconnect(false, unauthenticated));
    becomeVisible();
    expect(unauthenticated.connect).not.toHaveBeenCalled();
    unmount();

    const connected = makeService({ connectionState: 'connected' });
    renderHook(() => useVisibilityReconnect(true, connected));
    becomeVisible();
    expect(connected.connect).not.toHaveBeenCalled();
  });
});
