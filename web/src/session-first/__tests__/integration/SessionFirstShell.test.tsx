import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { SessionFirstShell } from '@/session-first/SessionFirstShell';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
  ip_address: '10.0.0.1', port: 1, status: 'offline', session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};
const sess: Session = {
  session_id: 'a1:fix', agent_id: 'a1', session_name: 'Fix terminal reconnect',
  status: 'active', window_count: 1, attached_clients: 0,
  last_activity: new Date().toISOString(),
};

const dashboard = vi.hoisted(() => ({
  current: {
    agents: [] as Agent[],
    sessions: [] as Session[],
    staleAgents: [] as string[],
    loadingSessions: false,
    sessionsLoaded: true,
    error: null,
    fetchSessions: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('@/hooks/useDashboard', () => ({
  useDashboard: () => dashboard.current,
}));
vi.mock('@/hooks/useProbePolling', () => ({
  useProbePolling: () => {},
}));
vi.mock('@/session-first/SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="session-first-terminal" />,
}));
vi.mock('@/session-first/patterns/FileWorkspace', () => ({
  FileWorkspace: () => <div data-testid="file-workspace" />,
}));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ requestAttach: vi.fn() }),
}));
vi.mock('@/services/deepLinkAttach', () => ({
  resolveDeepLinkAttachChoice: vi.fn().mockResolvedValue({
    mode: 'auto',
    attachInfo: { mode: 'relay' },
    orderedUrls: [],
    latencies: [],
    selectedUrl: null,
    relayUrl: null,
    renderer: 'canvas',
    envRefs: [],
  }),
}));

function renderShell() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <SessionFirstShell onLegacy={vi.fn()} />
      </MemoryRouter>
    </Provider>,
  );
}

describe('SessionFirstShell', () => {
  beforeEach(() => {
    dashboard.current = {
      ...dashboard.current,
      agents: [agent],
      sessions: [sess],
      staleAgents: [],
    };
  });

  it('lists sessions without an Agent card grid', () => {
    renderShell();
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
  });

  it('selects a session, defaults to Terminal, then Workspace Files and Agent', async () => {
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByRole('heading', { name: 'Fix terminal reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByTestId('agent-detail')).toBeInTheDocument();
  });

  it('shows empty copy when there are no sessions', () => {
    dashboard.current = { ...dashboard.current, agents: [], sessions: [] };
    renderShell();
    expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
  });
});
