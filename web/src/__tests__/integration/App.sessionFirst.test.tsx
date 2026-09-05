import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '@/App';

const sessionFirst = vi.hoisted(() => ({ on: false }));

vi.mock('@/lib/sessionFirst', () => ({
  isSessionFirst: () => sessionFirst.on,
  setSessionFirst: vi.fn(),
}));
vi.mock('@/session-first/SessionFirstShell', () => ({
  SessionFirstShell: () => <div data-testid="session-first-shell" />,
}));
vi.mock('@/components/Dashboard', () => ({
  Dashboard: () => <div data-testid="legacy-dashboard" />,
}));
vi.mock('@/hooks/useAppConnection', () => ({
  useAppConnection: () => ({
    connectionStatus: 'connected',
    wsService: {},
    authToken: 't',
    setAuthToken: vi.fn(),
    serverUrl: 'ws://x',
    setServerUrl: vi.fn(),
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    isAuthenticated: true,
    isRestoringSession: false,
  }),
}));

describe('App sessionFirst swap', () => {
  it('renders legacy Dashboard when flag is off', () => {
    sessionFirst.on = false;
    render(<App />);
    expect(screen.getByTestId('legacy-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-shell')).not.toBeInTheDocument();
  });

  it('renders SessionFirstShell when flag is on', () => {
    sessionFirst.on = true;
    render(<App />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-dashboard')).not.toBeInTheDocument();
  });
});
