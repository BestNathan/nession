import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Agent, Session } from '@/types';

const agentsApi = vi.hoisted(() => ({
  listAgents: vi.fn(),
  onAgentsChanged: vi.fn(() => () => {}),
}));
const sessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  onSessionsChanged: vi.fn(() => () => {}),
}));

vi.mock('@/product/agent', () => ({ agentsApi }));
vi.mock('@/product/session', () => ({ sessionsApi }));

import { useDashboard } from '@/app/useDashboard';
import { useMobileNav } from '@/app/useMobileNav';

const service = {
  connectionState: 'connected',
  physicalGeneration: 1,
  onConnectionStateChange: () => () => {},
} as never;

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox', ip_address: '10.0.0.1', port: 1,
  status: 'online', session_count: 1, last_heartbeat: '2026-01-01T00:00:00Z',
};
const session: Session = {
  session_id: 'a1:s1', agent_id: 'a1', session_name: 's1', status: 'active',
  window_count: 1, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z',
};

function stubMedia(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/**
 * The shell's list-activity signal (#4602). `showList` is the *mobile pane*
 * flag and is false on wide screens even though the sidebar column is visible;
 * gating the pull controllers on it alone left desktop lists unread and the
 * create action disabled (real-stack session-lifecycle regression).
 */
describe('shell list activity signal (#4602)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsApi.listAgents.mockResolvedValue([agent]);
    sessionsApi.fetchSessions.mockResolvedValue({ sessions: [session], stale_agents: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the lists on a wide desktop where showList is false', async () => {
    stubMedia(true);
    const { result } = renderHook(() => {
      const nav = useMobileNav(null);
      const data = useDashboard(service, nav.isWide || nav.showList);
      return { nav, data };
    });
    expect(result.current.nav.showList).toBe(false);
    await waitFor(() => expect(result.current.data.agents).toHaveLength(1));
    expect(agentsApi.listAgents).toHaveBeenCalled();
    expect(sessionsApi.fetchSessions).toHaveBeenCalled();
  });

  it('reads the lists on the narrow list pane', async () => {
    stubMedia(false);
    const { result } = renderHook(() => {
      const nav = useMobileNav(null);
      const data = useDashboard(service, nav.isWide || nav.showList);
      return { nav, data };
    });
    expect(result.current.nav.showList).toBe(true);
    await waitFor(() => expect(result.current.data.sessions).toHaveLength(1));
  });

  it('keeps reading while the narrow detail pane hides the list pane', async () => {
    // The Terminal header / Project chip derive from these lists even when the
    // list pane is hidden, so the shell keeps them active (#4602).
    stubMedia(false);
    const { result } = renderHook(() => {
      const nav = useMobileNav('a1:s1');
      const data = useDashboard(service, true);
      return { nav, data };
    });
    await act(async () => {
      result.current.nav.openDetail();
    });
    expect(result.current.nav.showList).toBe(false);
    await waitFor(() => expect(result.current.data.sessions).toHaveLength(1));
    expect(agentsApi.listAgents).toHaveBeenCalled();
  });

  it('pauses a hidden surface passed active=false', async () => {
    stubMedia(false);
    renderHook(() => useDashboard(service, false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(agentsApi.listAgents).not.toHaveBeenCalled();
    expect(sessionsApi.fetchSessions).not.toHaveBeenCalled();
  });
});
