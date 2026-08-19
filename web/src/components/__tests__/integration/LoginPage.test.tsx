import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/components/LoginPage';

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
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

  it('renders the Remember me checkbox (unchecked by default)', () => {
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

    const checkbox = screen.getByRole('checkbox', { name: /remember me/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('toggles Remember me checkbox when clicked', async () => {
    const user = userEvent.setup();
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

    const checkbox = screen.getByRole('checkbox', { name: /remember me/i });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it('passes remember=true to onConnect when checkbox is checked', async () => {
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

    await user.click(screen.getByRole('checkbox', { name: /remember me/i }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(true);
  });

  it('passes remember=false to onConnect when checkbox is unchecked', async () => {
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
    expect(onConnect).toHaveBeenCalledWith(false);
  });

  it('restores remember preference from localStorage', () => {
    localStorage.setItem('remember', 'true');

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

    const checkbox = screen.getByRole('checkbox', { name: /remember me/i });
    expect(checkbox).toBeChecked();
  });
});
