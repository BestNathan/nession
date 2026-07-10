import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachDialog } from '../AttachDialog';
import type { Session, AttachInfo } from '../../../types';
import type { WebSocketService } from '../../../services/websocket';

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

// Mock the address test so the dialog resolves deterministically without
// opening real sockets.
vi.mock('../../../services/addressSelection', async (importActual) => {
  const actual = await importActual<typeof import('../../../services/addressSelection')>();
  return {
    ...actual,
    testAddresses: vi.fn(async (addrs: { url: string }[]) =>
      addrs.map((a, i) => ({ url: a.url, latencyMs: (i + 1) * 10 })),
    ),
  };
});

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
      <AttachDialog isOpen onClose={vi.fn()} session={session()} wsService={ws} onConfirm={onConfirm} />,
    );
    // Attach button enables once the (empty) address list resolves.
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
      <AttachDialog isOpen onClose={vi.fn()} session={session()} wsService={ws} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.queryByText('Relay')).not.toBeInTheDocument();
  });

  it('shows browser-tested candidate paths and lets the user pick one', async () => {
    const onConfirm = vi.fn();
    const ws = mockWs(
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} wsService={ws} onConfirm={onConfirm} />,
    );
    // Both candidate labels appear once testing resolves.
    expect(await screen.findByText('LAN')).toBeInTheDocument();
    expect(screen.getByText('VPN')).toBeInTheDocument();
    // Pick the VPN path explicitly (even though server marked it unreachable —
    // the browser is the authority; user override still allowed).
    await user.click(screen.getByText('VPN'));
    const attachBtn = screen.getByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ selectedUrl: 'ws://vpn/ws' }),
    );
  });
});
