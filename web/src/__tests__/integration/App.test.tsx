import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '@/App';

const auth = vi.hoisted(() => ({ on: true }));

vi.mock('@/app/useAppConnection', () => ({
  useAppConnection: () => ({
    connectionStatus: 'connected',
    wsService: {},
    authToken: 't',
    setAuthToken: vi.fn(),
    serverUrl: 'ws://x',
    setServerUrl: vi.fn(),
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    isAuthenticated: auth.on,
    isRestoringSession: false,
  }),
}));
vi.mock('@/app/SessionFirstShell', () => ({
  SessionFirstShell: () => <div data-testid="session-first-shell" />,
}));
vi.mock('@/app/LoginPage', () => ({
  LoginPage: () => <div data-testid="login-page" />,
}));

describe('App shell routing', () => {
  it('renders the session-first shell when authenticated', () => {
    auth.on = true;
    render(<App />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('renders LoginPage when unauthenticated', () => {
    auth.on = false;
    render(<App />);
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-shell')).not.toBeInTheDocument();
  });
});
