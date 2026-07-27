import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardHandlers } from '../useDashboardHandlers';
import type { Agent, Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'host-1',
    ip_address: '192.168.1.1',
    port: 19090,
    status: 'online',
    session_count: 2,
    last_heartbeat: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:session-1',
    agent_id: 'agent-1',
    session_name: 'session-1',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    last_activity: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock WebSocketService
// ---------------------------------------------------------------------------

interface MockWsService {
  listAgents: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  onAgentsChanged: ReturnType<typeof vi.fn>;
  onSessionsChanged: ReturnType<typeof vi.fn>;
}

function createMockWsService(): MockWsService {
  return {
    listAgents: vi.fn(() => new Promise<Agent[]>(() => {})),
    listSessions: vi.fn(() => new Promise<Session[]>(() => {})),
    onAgentsChanged: vi.fn().mockReturnValue(() => {}),
    onSessionsChanged: vi.fn().mockReturnValue(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDashboardHandlers', () => {
  let agentsCallback: ((agents: Agent[]) => void) | null;
  let sessionsCallback: ((sessions: Session[]) => void) | null;
  let mockWsService: MockWsService;

  beforeEach(() => {
    agentsCallback = null;
    sessionsCallback = null;
    mockWsService = createMockWsService();
    mockWsService.onAgentsChanged = vi.fn((cb: (agents: Agent[]) => void) => {
      agentsCallback = cb;
      return () => {};
    });
    mockWsService.onSessionsChanged = vi.fn((cb: (sessions: Session[]) => void) => {
      sessionsCallback = cb;
      return () => {};
    });
  });

  // ── searchQuery filtering ──────────────────────────────────────────────

  describe('searchQuery', () => {
    it('filters agents by hostname (case-insensitive)', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', hostname: 'Alpha-Server' }),
          makeAgent({ agent_id: 'a2', hostname: 'Beta-Server' }),
        ]);
      });

      expect(result.current.filteredAgents).toHaveLength(2);

      act(() => { result.current.setSearchQuery('alpha'); });
      expect(result.current.filteredAgents).toHaveLength(1);
      expect(result.current.filteredAgents[0].hostname).toBe('Alpha-Server');

      act(() => { result.current.setSearchQuery('ALPHA'); });
      expect(result.current.filteredAgents).toHaveLength(1);

      act(() => { result.current.setSearchQuery('server'); });
      expect(result.current.filteredAgents).toHaveLength(2);

      act(() => { result.current.setSearchQuery(''); });
      expect(result.current.filteredAgents).toHaveLength(2);
    });

    it('filters agents by agent_id', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'node-alpha' }),
          makeAgent({ agent_id: 'node-beta' }),
        ]);
      });

      act(() => { result.current.setSearchQuery('alpha'); });
      expect(result.current.filteredAgents).toHaveLength(1);
      expect(result.current.filteredAgents[0].agent_id).toBe('node-alpha');
    });
  });

  // ── statusFilter filtering ─────────────────────────────────────────────

  describe('statusFilter', () => {
    it('filters agents by online status', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', status: 'online' }),
          makeAgent({ agent_id: 'a2', status: 'offline' }),
          makeAgent({ agent_id: 'a3', status: 'degraded' }),
        ]);
      });

      act(() => { result.current.setStatusFilter('online'); });
      expect(result.current.filteredAgents).toHaveLength(1);
      expect(result.current.filteredAgents[0].agent_id).toBe('a1');
    });

    it('filters agents by offline status', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', status: 'online' }),
          makeAgent({ agent_id: 'a2', status: 'offline' }),
        ]);
      });

      act(() => { result.current.setStatusFilter('offline'); });
      expect(result.current.filteredAgents).toHaveLength(1);
      expect(result.current.filteredAgents[0].agent_id).toBe('a2');
    });

    it('returns all agents when statusFilter is "all"', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', status: 'online' }),
          makeAgent({ agent_id: 'a2', status: 'offline' }),
        ]);
      });

      // Default is 'all'
      expect(result.current.filteredAgents).toHaveLength(2);

      act(() => { result.current.setStatusFilter('all'); });
      expect(result.current.filteredAgents).toHaveLength(2);
    });
  });

  // ── combined filtering ─────────────────────────────────────────────────

  describe('combined filtering', () => {
    it('applies both searchQuery and statusFilter', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', hostname: 'web-server', status: 'online' }),
          makeAgent({ agent_id: 'a2', hostname: 'db-server', status: 'online' }),
          makeAgent({ agent_id: 'a3', hostname: 'web-server-old', status: 'offline' }),
        ]);
      });

      act(() => { result.current.setSearchQuery('web'); });
      act(() => { result.current.setStatusFilter('online'); });
      expect(result.current.filteredAgents).toHaveLength(1);
      expect(result.current.filteredAgents[0].agent_id).toBe('a1');
    });

    it('returns empty when no agents match both filters', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', hostname: 'web', status: 'online' }),
        ]);
      });

      act(() => { result.current.setSearchQuery('database'); });
      act(() => { result.current.setStatusFilter('online'); });
      expect(result.current.filteredAgents).toHaveLength(0);
    });

    it('applies statusFilter, searchQuery, and sort to filteredSessions', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', hostname: 'web', status: 'online' }),
          makeAgent({ agent_id: 'a2', hostname: 'db', status: 'offline' }),
        ]);
        sessionsCallback!([
          makeSession({ session_id: 'a1:prod-web', session_name: 'prod-web', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:staging-web', session_name: 'staging-web', agent_id: 'a1' }),
          makeSession({ session_id: 'a2:prod-db', session_name: 'prod-db', agent_id: 'a2' }),
        ]);
      });

      // Filter online only + search "prod" → only a1's prod-web
      act(() => { result.current.setSearchQuery('prod'); });
      act(() => { result.current.setStatusFilter('online'); });
      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0].session_name).toBe('prod-web');

      // Verify the offline agent's session is excluded
      const names = result.current.filteredSessions.map((s) => s.session_name);
      expect(names).not.toContain('prod-db');
      expect(names).not.toContain('staging-web');
    });
  });

  // ── sorting ────────────────────────────────────────────────────────────

  describe('sorting', () => {
    it('sorts sessions by name ascending (default)', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([makeAgent({ agent_id: 'a1' })]);
        sessionsCallback!([
          makeSession({ session_id: 'a1:zeta', session_name: 'zeta', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:alpha', session_name: 'alpha', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:beta', session_name: 'beta', agent_id: 'a1' }),
        ]);
      });

      expect(result.current.filteredSessions.map((s) => s.session_name)).toEqual(['alpha', 'beta', 'zeta']);
    });

    it('toggles sort direction on same field', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([makeAgent({ agent_id: 'a1' })]);
        sessionsCallback!([
          makeSession({ session_id: 'a1:a', session_name: 'a', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:c', session_name: 'c', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:b', session_name: 'b', agent_id: 'a1' }),
        ]);
      });

      // Toggle to descending
      act(() => { result.current.toggleSort('name'); });
      expect(result.current.sortField).toBe('name');
      expect(result.current.sortDirection).toBe('desc');
      expect(result.current.filteredSessions.map((s) => s.session_name)).toEqual(['c', 'b', 'a']);

      // Toggle back to ascending
      act(() => { result.current.toggleSort('name'); });
      expect(result.current.sortDirection).toBe('asc');
      expect(result.current.filteredSessions.map((s) => s.session_name)).toEqual(['a', 'b', 'c']);
    });

    it('switches sort field and resets to asc', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([makeAgent({ agent_id: 'a1' })]);
        sessionsCallback!([
          makeSession({ session_id: 'a1:a', session_name: 'b', agent_id: 'a1', last_activity: '2025-01-03T00:00:00Z' }),
          makeSession({ session_id: 'a1:b', session_name: 'a', agent_id: 'a1', last_activity: '2025-01-01T00:00:00Z' }),
          makeSession({ session_id: 'a1:c', session_name: 'c', agent_id: 'a1', last_activity: '2025-01-02T00:00:00Z' }),
        ]);
      });

      // First toggle name to desc
      act(() => { result.current.toggleSort('name'); });
      expect(result.current.filteredSessions.map((s) => s.session_name)).toEqual(['c', 'b', 'a']);

      // Switch to activity sort — should reset to asc
      act(() => { result.current.toggleSort('activity'); });
      expect(result.current.sortField).toBe('activity');
      expect(result.current.sortDirection).toBe('asc');
      expect(result.current.filteredSessions.map((s) => s.session_name)).toEqual(['a', 'c', 'b']);
    });
  });

  // ── heartbeat tracking ─────────────────────────────────────────────────

  describe('heartbeat history', () => {
    it('accumulates heartbeats across agent updates', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', last_heartbeat: '2025-01-01T00:00:00Z' }),
        ]);
      });
      expect(result.current.getHeartbeatHistory('a1')).toEqual(['2025-01-01T00:00:00Z']);

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'a1', last_heartbeat: '2025-01-02T00:00:00Z' }),
        ]);
      });
      expect(result.current.getHeartbeatHistory('a1')).toEqual([
        '2025-01-01T00:00:00Z',
        '2025-01-02T00:00:00Z',
      ]);
    });

    it('caps heartbeat history at 5 entries', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      for (let i = 1; i <= 7; i++) {
        act(() => {
          agentsCallback!([
            makeAgent({ agent_id: 'a1', last_heartbeat: `2025-01-${String(i).padStart(2, '0')}T00:00:00Z` }),
          ]);
        });
      }

      const history = result.current.getHeartbeatHistory('a1');
      expect(history).toHaveLength(5);
      // Should keep the most recent 5 (t3 through t7)
      expect(history[0]).toBe('2025-01-03T00:00:00Z');
      expect(history[4]).toBe('2025-01-07T00:00:00Z');
    });

    it('returns empty array for unknown agents', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      expect(result.current.getHeartbeatHistory('unknown')).toEqual([]);
    });
  });

  // ── selectedAgent ──────────────────────────────────────────────────────

  describe('selectedAgent', () => {
    it('starts as null', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      expect(result.current.selectedAgent).toBeNull();
    });

    it('can be set to an agent and cleared', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      const agent = makeAgent({ agent_id: 'a1' });
      act(() => { result.current.setSelectedAgent(agent); });
      expect(result.current.selectedAgent).toEqual(agent);

      act(() => { result.current.setSelectedAgent(null); });
      expect(result.current.selectedAgent).toBeNull();
    });
  });

  // ── isSearchActive ─────────────────────────────────────────────────────

  describe('isSearchActive', () => {
    it('is false when searchQuery is empty and statusFilter is "all"', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      expect(result.current.isSearchActive).toBe(false);
    });

    it('is true when searchQuery is non-empty', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => { result.current.setSearchQuery('web'); });
      expect(result.current.isSearchActive).toBe(true);
    });

    it('is true when statusFilter is not "all"', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => { result.current.setStatusFilter('online'); });
      expect(result.current.isSearchActive).toBe(true);
    });
  });

  // ── fetch agents error handling ────────────────────────────────────

  describe('fetch errors', () => {
    it('sets error when fetchAgents fails', async () => {
      const mock = createMockWsService();
      mock.listAgents = vi.fn().mockRejectedValue(new Error('Fetch agents failed'));
      // Keep onAgentsChanged / onSessionsChanged registered
      mock.onAgentsChanged = vi.fn().mockReturnValue(() => {});
      mock.onSessionsChanged = vi.fn().mockReturnValue(() => {});
      mock.listSessions = vi.fn().mockResolvedValue([]);

      const { result } = renderHook(() => useDashboardHandlers(mock as unknown as WebSocketService));

      // Wait for the initial fetch to settle
      await vi.waitFor(() => {
        expect(result.current.error).toContain('Fetch agents failed');
      });
    });
  });

  // ── handleSessionCreated / handleSessionKilled ─────────────────────

  describe('session lifecycle callbacks', () => {
    it('handleSessionCreated closes modal and refreshes sessions', async () => {
      const fetchSessions = vi.fn().mockResolvedValue([]);
      const mock = createMockWsService();
      mock.listAgents = vi.fn().mockResolvedValue([makeAgent()]);
      mock.listSessions = fetchSessions;
      mock.onAgentsChanged = vi.fn().mockReturnValue(() => {});
      mock.onSessionsChanged = vi.fn().mockReturnValue(() => {});

      const { result } = renderHook(() => useDashboardHandlers(mock as unknown as WebSocketService));

      await vi.waitFor(() => {
        expect(result.current.loadingAgents).toBe(false);
      });

      act(() => { result.current.handleSessionCreated(); });

      expect(result.current.showCreateModal).toBe(false);
      // fetchSessions is called — it may have been called once initially too
      expect(fetchSessions).toHaveBeenCalled();
    });

    it('handleSessionKilled clears kill target and refreshes', async () => {
      const fetchSessions = vi.fn().mockResolvedValue([]);
      const mock = createMockWsService();
      mock.listAgents = vi.fn().mockResolvedValue([makeAgent()]);
      mock.listSessions = fetchSessions;
      mock.onAgentsChanged = vi.fn().mockReturnValue(() => {});
      mock.onSessionsChanged = vi.fn().mockReturnValue(() => {});

      const { result } = renderHook(() => useDashboardHandlers(mock as unknown as WebSocketService));

      await vi.waitFor(() => {
        expect(result.current.loadingAgents).toBe(false);
      });

      act(() => { result.current.handleSessionKilled(); });

      expect(result.current.sessionToKill).toBeNull();
      expect(fetchSessions).toHaveBeenCalled();
    });
  });

  // ── session filtering by searchQuery ───────────────────────────────

  describe('session search filtering', () => {
    it('filters sessions by session_name', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([makeAgent({ agent_id: 'a1' })]);
        sessionsCallback!([
          makeSession({ session_id: 'a1:prod', session_name: 'prod-app', agent_id: 'a1' }),
          makeSession({ session_id: 'a1:staging', session_name: 'staging-app', agent_id: 'a1' }),
        ]);
      });

      act(() => { result.current.setSearchQuery('prod'); });
      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0].session_name).toBe('prod-app');
    });

    it('filters sessions by agent_id', () => {
      const { result } = renderHook(() => useDashboardHandlers(mockWsService as unknown as WebSocketService));

      act(() => {
        agentsCallback!([
          makeAgent({ agent_id: 'node-a' }),
          makeAgent({ agent_id: 'node-b' }),
        ]);
        sessionsCallback!([
          makeSession({ session_id: 'node-a:app', session_name: 'app', agent_id: 'node-a' }),
          makeSession({ session_id: 'node-b:db', session_name: 'db', agent_id: 'node-b' }),
        ]);
      });

      act(() => { result.current.setSearchQuery('node-a'); });
      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0].agent_id).toBe('node-a');
    });
  });
});
