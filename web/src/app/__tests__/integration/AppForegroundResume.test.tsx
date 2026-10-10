// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';

const state = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'reconnecting' | 'disconnected',
  authenticated: true,
  restoring: false,
  service: {} as object | null,
  mounts: 0,
  unmounts: 0,
}));

vi.mock('@/app/useAppConnection', () => ({
  useAppConnection: () => ({
    connectionStatus: state.status,
    wsService: state.service,
    authToken: '',
    setAuthToken: vi.fn(),
    serverUrl: 'ws://example.test',
    setServerUrl: vi.fn(),
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    handleRetry: vi.fn(),
    isAuthenticated: state.authenticated,
    isRestoringSession: state.restoring,
  }),
}));
vi.mock('@/app/Shell', () => ({
  Shell: () => {
    useEffect(() => {
      state.mounts += 1;
      return () => { state.unmounts += 1; };
    }, []);
    return <div data-testid="durable-shell">Terminal stays here</div>;
  },
}));
vi.mock('@/app/LoginPage', () => ({
  LoginPage: () => <div data-testid="login-page">Login</div>,
}));

describe('App foreground continuity (#1213)', () => {
  afterEach(() => {
    cleanup();
    window.location.hash = '#/';
    state.status = 'connected';
    state.authenticated = true;
    state.restoring = false;
    state.service = {};
    state.mounts = 0;
    state.unmounts = 0;
  });

  it('keeps the same Shell mounted through reconnecting and exhausted; explicit disconnect exits', () => {
    window.location.hash = '#/';
    const { rerender } = render(<App />);
    expect(screen.getByTestId('durable-shell')).toBeTruthy();
    expect(state.mounts).toBe(1);

    act(() => {
      state.status = 'reconnecting';
      state.authenticated = false;
      state.restoring = true;
      rerender(<App />);
    });
    expect(screen.getByTestId('durable-shell')).toBeTruthy();
    expect(state.mounts).toBe(1);
    expect(state.unmounts).toBe(0);

    act(() => {
      state.status = 'disconnected';
      state.restoring = false;
      rerender(<App />);
    });
    expect(screen.getByTestId('durable-shell')).toBeTruthy();
    expect(state.unmounts).toBe(0);

    act(() => {
      state.service = null;
      rerender(<App />);
    });
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(state.unmounts).toBe(1);
  });
});
