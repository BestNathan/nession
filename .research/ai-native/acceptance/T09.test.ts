// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVisibilityReconnect } from '@/app/useVisibilityReconnect';
import type { WebSocketService } from '@/platform/socket';

function becomeVisible(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
}

describe('research acceptance T09', () => {
  it('emits structured telemetry exactly when visibility wake requests reconnect', () => {
    const connect = vi.fn(() => Promise.resolve());
    const onReconnectRequested = vi.fn();
    const service = {
      connectionState: 'disconnected',
      isDisposed: false,
      connect,
    } as unknown as WebSocketService;

    renderHook(() => (useVisibilityReconnect as unknown as (
      authed: boolean,
      service: WebSocketService | null,
      opts?: { onReconnectRequested?: (event: { reason: 'visibility-wake' }) => void },
    ) => void)(true, service, { onReconnectRequested }));

    becomeVisible();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReconnectRequested).toHaveBeenCalledTimes(1);
    expect(onReconnectRequested).toHaveBeenCalledWith({ reason: 'visibility-wake' });
  });
});
