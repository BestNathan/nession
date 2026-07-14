import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../LoginPage';

describe('LoginPage', () => {
  it('renders connection form', () => {
    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Auth Token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('has server URL input with default value', () => {
    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    const urlInput = screen.getByLabelText('Server URL') as HTMLInputElement;
    expect(urlInput.value).toBe('ws://localhost:19090/ws');
  });

  it('calls onConnect when Connect button clicked', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();

    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalled();
  });

  it('disables Connect button while connecting', () => {
    render(
      <LoginPage
        connectionStatus="connecting"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('shows disconnected status text', () => {
    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('disables Disconnect button when already disconnected', () => {
    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });

  it('shows connecting status text', () => {
    render(
      <LoginPage
        connectionStatus="connecting"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('shows authenticated status text', () => {
    render(
      <LoginPage
        connectionStatus="authenticated"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Authenticated')).toBeInTheDocument();
  });

  it('enables Disconnect when authenticated', () => {
    render(
      <LoginPage
        connectionStatus="authenticated"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeDisabled();
  });

  it('disables URL and token inputs when connecting', () => {
    render(
      <LoginPage
        connectionStatus="connecting"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Server URL')).toBeDisabled();
    expect(screen.getByLabelText('Auth Token')).toBeDisabled();
  });

  it('calls onDisconnect when Disconnect clicked', async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();

    render(
      <LoginPage
        connectionStatus="authenticated"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('shows connected helper text', () => {
    render(
      <LoginPage
        connectionStatus="connected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Connected! Authenticating/)).toBeInTheDocument();
  });

  it('renders features list', () => {
    render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl="ws://localhost:19090/ws"
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Real-time dashboard/)).toBeInTheDocument();
    expect(screen.getByText(/P2P and relay terminal/)).toBeInTheDocument();
  });

  it('hides the Features card on mobile (md:block)', () => {
    const { container } = render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl=""
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    const featuresCard = container.querySelector('[data-testid="features-card"]');
    expect(featuresCard).not.toBeNull();
    expect(featuresCard?.className).toContain('hidden');
    expect(featuresCard?.className).toContain('md:block');
  });
});
