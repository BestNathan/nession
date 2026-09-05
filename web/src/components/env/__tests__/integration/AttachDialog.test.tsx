import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { AttachDialog } from '@/components/env/AttachDialog';
import { envApi } from '@/features/env';
import { sessionsApi } from '@/features/sessions';
import type { Session, AttachInfo } from '@/types';
import { probeResultsAtom, probeRefreshRequestAtom, type AgentProbe } from '@/atoms/probe';
import { attachInfoAtom } from '@/atoms/session';

vi.mock('@/features/env', () => ({
  envApi: { listEnvFiles: vi.fn() },
}));

vi.mock('@/features/sessions', () => ({
  sessionsApi: { requestAttach: vi.fn() },
}));

const mockedEnvApi = vi.mocked(envApi);
const mockedSessionsApi = vi.mocked(sessionsApi);

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [] });
  mockedSessionsApi.requestAttach.mockImplementation(async () => attachInfo());
});

describe('AttachDialog', () => {
  it('requests attach and confirms with a resolved choice (Auto)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    // Attach button enables once attach info resolves.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'p2p', undefined);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      expect.objectContaining({ mode: 'auto', selectedUrl: null }),
    );
  });

  it('offers Auto, P2P, and Relay modes', () => {
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.getByText('Relay')).toBeInTheDocument();
  });

  it('shows candidate paths and lets the user pick one', async () => {
    const onConfirm = vi.fn();
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const store = createStore();
    store.set(probeResultsAtom, new Map<string, AgentProbe>([[
      'agent-1',
      {
        latencies: [
          { url: 'ws://lan/ws', latencyMs: 10 },
          { url: 'ws://vpn/ws', latencyMs: 20 },
        ],
        orderedUrls: ['ws://lan/ws', 'ws://vpn/ws'],
        probedAt: Date.now(),
      },
    ]]));
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={onConfirm}
        />
      </Provider>,
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
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const store = createStore();
    store.set(probeResultsAtom, new Map<string, AgentProbe>([[
      'agent-1',
      {
        latencies: [{ url: 'ws://lan/ws', latencyMs: 12 }],
        orderedUrls: ['ws://lan/ws'],
        probedAt: Date.now(),
      },
    ]]));
    render(
      <Provider store={store}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
        />
      </Provider>,
    );
    expect(await screen.findByText('12ms')).toBeInTheDocument();
    expect(screen.queryByText(/Testing…/)).not.toBeInTheDocument();
  });

  it('re-test button requests a fresh probe via probeRefreshRequestAtom', async () => {
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
        />
      </Provider>,
    );
    const retest = await screen.findByRole('button', { name: /Re-test/ });
    await user.click(retest);
    expect(store.get(probeRefreshRequestAtom)?.agentId).toBe('agent-1');
  });

  it('renders a Renderer row with WebGL and Canvas options', () => {
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Renderer')).toBeInTheDocument();
    expect(screen.getByText('WebGL')).toBeInTheDocument();
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });

  it('selects env files and passes them as envRefs on confirm', async () => {
    const onConfirm = vi.fn();
    mockedEnvApi.listEnvFiles.mockResolvedValue({
      files: [{ name: 'prod.env', source: 'server', size: 10, modified: 0, var_count: 3 }],
    });
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    // The env section starts collapsed; expand it to reveal the file list.
    await user.click(screen.getByText('Environment Files'));
    await user.click(await screen.findByText('prod.env'));
    const attachBtn = screen.getByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envRefs: [{ name: 'prod.env', source: 'server' }] }),
    );
  });

  it('does not clear the active session attachInfoAtom when opened for preview', async () => {
    const store = createStore();
    // The currently-attached session's descriptor — a DIFFERENT session than
    // the one being previewed in the dialog. Opening the preview dialog must
    // not clobber this shared atom (it drives the live terminal).
    const activeInfo: AttachInfo = {
      mode: 'p2p',
      session_id: 'agent-2:prod',
      session_name: 'prod',
      agent_address: 'ws://other/ws',
      connection_token: 'active-token',
      addresses: [],
    };
    store.set(attachInfoAtom, activeInfo);

    render(
      <Provider store={store}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
        />
      </Provider>,
    );

    // Let the dialog's own attach-info fetch fully settle.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());

    // The live session's descriptor must be untouched.
    expect(store.get(attachInfoAtom)).toEqual(activeInfo);
  });
});
