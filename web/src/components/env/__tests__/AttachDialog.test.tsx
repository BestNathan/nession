import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachDialog } from '../AttachDialog';
import type { Session, AttachInfo } from '../../../types';
import type { WebSocketService } from '../../../services/websocket';
import { WebSocketContext } from '../../../hooks/useWebSocket';
import type { AddressProbeCache } from '../../../hooks/useAddressProbeCache';

function session(): Session {
  return {
    session_id: 'agent-1:dev',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
  };
}

function attachInfo(addresses: AttachInfo['addresses'] = []): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent-1:dev',
    session_name: 'dev',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses,
  };
}

function mockWs(info: AttachInfo): WebSocketService {
  return {
    requestAttach: vi.fn(async () => info),
  } as unknown as WebSocketService;
}

/** A no-op probe cache; override getProbe/refreshAgent per test as needed. */
function mockProbeCache(overrides: Partial<AddressProbeCache> = {}): AddressProbeCache {
  return {
    getProbe: vi.fn().mockReturnValue(undefined),
    refreshAgent: vi.fn(),
    ...overrides,
  };
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('AttachDialog', () => {
  it('requests attach and confirms with a resolved choice (Auto)', async () => {
    const onConfirm = vi.fn();
    const ws = mockWs(attachInfo());
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={onConfirm}
          probeCache={mockProbeCache()}
        />
      </WebSocketContext.Provider>,
    );
    // Attach button enables once attach info resolves.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(ws.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'p2p');
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      expect.objectContaining({ mode: 'auto', selectedUrl: null }),
    );
  });

  it('does not offer a forced Relay mode', () => {
    const ws = mockWs(attachInfo());
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
          probeCache={mockProbeCache()}
        />
      </WebSocketContext.Provider>,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.queryByText('Relay')).not.toBeInTheDocument();
  });

  it('shows candidate paths and lets the user pick one', async () => {
    const onConfirm = vi.fn();
    const ws = mockWs(
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const probeCache = mockProbeCache({
      getProbe: vi.fn().mockReturnValue({
        latencies: [
          { url: 'ws://lan/ws', latencyMs: 10 },
          { url: 'ws://vpn/ws', latencyMs: 20 },
        ],
        orderedUrls: ['ws://lan/ws', 'ws://vpn/ws'],
        probedAt: Date.now(),
      }),
    });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={onConfirm}
          probeCache={probeCache}
        />
      </WebSocketContext.Provider>,
    );
    // Both candidate labels appear once attach info resolves.
    expect(await screen.findByText('LAN')).toBeInTheDocument();
    expect(screen.getByText('VPN')).toBeInTheDocument();
    // Pick the VPN path explicitly (server marked it unreachable — user override
    // still allowed).
    await user.click(screen.getByText('VPN'));
    const attachBtn = screen.getByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        selectedUrl: 'ws://vpn/ws',
        // Latencies come from the app-level probe cache, handed to the terminal.
        latencies: expect.arrayContaining([
          expect.objectContaining({ url: 'ws://lan/ws', latencyMs: 10 }),
          expect.objectContaining({ url: 'ws://vpn/ws', latencyMs: 20 }),
        ]),
      }),
    );
  });

  it('shows cached latency without live probing', async () => {
    const ws = mockWs(
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const probeCache = mockProbeCache({
      getProbe: vi.fn().mockReturnValue({
        latencies: [{ url: 'ws://lan/ws', latencyMs: 12 }],
        orderedUrls: ['ws://lan/ws'],
        probedAt: Date.now(),
      }),
    });
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
          probeCache={probeCache}
        />
      </WebSocketContext.Provider>,
    );
    expect(await screen.findByText('12ms')).toBeInTheDocument();
    expect(screen.queryByText(/Testing…/)).not.toBeInTheDocument();
  });

  it('re-test button calls refreshAgent with the agent id', async () => {
    const refreshAgent = vi.fn();
    const ws = mockWs(
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const probeCache = mockProbeCache({ refreshAgent });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
          probeCache={probeCache}
        />
      </WebSocketContext.Provider>,
    );
    const retest = await screen.findByRole('button', { name: /Re-test/ });
    await user.click(retest);
    expect(refreshAgent).toHaveBeenCalledWith('agent-1');
  });

  it('renders a Renderer row with WebGL and Canvas options', () => {
    const ws = mockWs(attachInfo());
    render(
      <WebSocketContext.Provider value={ws}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
          probeCache={mockProbeCache()}
        />
      </WebSocketContext.Provider>,
    );
    expect(screen.getByText('Renderer')).toBeInTheDocument();
    expect(screen.getByText('WebGL')).toBeInTheDocument();
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });
});
