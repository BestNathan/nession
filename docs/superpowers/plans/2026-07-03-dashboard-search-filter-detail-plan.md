# Dashboard Search, Filter & Agent Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add search bar, status filter toggle, agent detail panel (Sheet), session list sorting, and empty states to the Nession Dashboard.

**Architecture:** Extend `useDashboardHandlers` hook with search/filter/sort/heartbeat state. Create two new components (`SearchBar`, `AgentDetailPanel`). Modify three existing components (`AgentCard`, `SessionList`, `Dashboard`). Add one shadcn component (`Sheet`).

**Tech Stack:** React 18, TypeScript, shadcn/ui, Tailwind v4, Vitest + Testing Library

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/src/components/ui/sheet.tsx` | Create (CLI) | shadcn Sheet primitive |
| `web/src/components/useDashboardHandlers.ts` | Modify | Search/filter/sort state, heartbeat tracking, computed values |
| `web/src/components/SearchBar.tsx` | Create | Search input + status toggle button group |
| `web/src/components/AgentDetailPanel.tsx` | Create | Sheet with agent metadata, versions, uptime, heartbeat history |
| `web/src/components/AgentCard.tsx` | Modify | Click → `setSelectedAgent` instead of filter toggle |
| `web/src/components/SessionList.tsx` | Modify | Sortable table headers, search-empty state |
| `web/src/components/Dashboard.tsx` | Modify | Integrate SearchBar + AgentDetailPanel; use new hook API |
| `web/src/hooks/__tests__/useDashboardHandlers.test.ts` | Create | Hook unit tests (search/filter/sort/heartbeat) |
| `web/src/components/__tests__/SearchBar.test.tsx` | Create | Component tests |
| `web/src/components/__tests__/AgentDetailPanel.test.tsx` | Create | Component tests |
| `web/src/components/__tests__/AgentCard.test.tsx` | Modify | Update click behavior tests |
| `web/src/components/__tests__/SessionList.test.tsx` | Modify | Sort + empty state tests |
| `vite.config.ts` | Modify | Remove `useDashboardHandlers.ts` from coverage exclude |

---

### Task 1: Add shadcn Sheet component

**Files:**
- Create: `web/src/components/ui/sheet.tsx`

- [ ] **Step 1: Add Sheet via shadcn CLI**

```bash
cd /Users/admin/Documents/learn/nession/web && npx shadcn@latest add sheet --yes
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ui/sheet.tsx
git commit -m "chore: add shadcn Sheet component for agent detail panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Extend useDashboardHandlers with search/filter/sort/heartbeat

**Files:**
- Modify: `web/src/components/useDashboardHandlers.ts`
- Create: `web/src/hooks/__tests__/useDashboardHandlers.test.ts`
- Modify: `web/vite.config.ts`

**Note:** The hook currently depends on `WebSocketService`. For unit tests, we mock `wsService` with `vi.fn()` and test the computed/state logic in isolation.

- [ ] **Step 1: Write the failing test for useDashboardHandlers**

Create `web/src/hooks/__tests__/useDashboardHandlers.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardHandlers } from '../../components/useDashboardHandlers';
import type { WebSocketService } from '../../services/websocket';
import type { Agent, Session } from '../../types';

function makeMockWsService() {
  return {
    listAgents: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    onAgentsChanged: vi.fn().mockReturnValue(() => {}),
    onSessionsChanged: vi.fn().mockReturnValue(() => {}),
    requestAttach: vi.fn(),
    createSession: vi.fn(),
    killSession: vi.fn(),
  } as unknown as WebSocketService;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-prod-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 3,
    last_heartbeat: new Date().toISOString(),
    metadata: {
      tmux_version: '3.4',
      os_version: 'Ubuntu 24.04',
      nession_version: '0.3.3',
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:dev',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 2,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
    ...overrides,
  };
}

describe('useDashboardHandlers — search & filter', () => {
  it('filteredAgents: returns all agents when searchQuery is empty and statusFilter is all', async () => {
    const ws = makeMockWsService();
    // Set up agents callback to return test data on first render
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.listAgents).mockResolvedValue([makeAgent({ hostname: 'a' }), makeAgent({ agent_id: 'agent-2', hostname: 'b' })]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    await act(async () => { /* wait for fetch effects */ });
    // Push agents via callback
    act(() => { agentsCb([makeAgent({ hostname: 'a' }), makeAgent({ agent_id: 'agent-2', hostname: 'b' })]); });

    expect(result.current.filteredAgents).toHaveLength(2);
    expect(result.current.filteredSessions).toHaveLength(0);
  });

  it('filteredAgents: filters by statusFilter=online', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.listAgents).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { agentsCb([makeAgent({ hostname: 'a', status: 'online' }), makeAgent({ agent_id: 'agent-2', hostname: 'b', status: 'offline' })]); });
    act(() => { result.current.setStatusFilter('online'); });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].hostname).toBe('a');
  });

  it('filteredAgents: filters by statusFilter=offline', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.listAgents).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { agentsCb([makeAgent({ hostname: 'a', status: 'online' }), makeAgent({ agent_id: 'agent-2', hostname: 'b', status: 'offline' })]); });
    act(() => { result.current.setStatusFilter('offline'); });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].hostname).toBe('b');
  });

  it('filteredAgents: searchQuery matches hostname', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.listAgents).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { agentsCb([makeAgent({ hostname: 'production-01' }), makeAgent({ agent_id: 'agent-2', hostname: 'staging-01' })]); });
    act(() => { result.current.setSearchQuery('prod'); });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].hostname).toBe('production-01');
  });

  it('filteredAgents: searchQuery matches agent_id', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.listAgents).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { agentsCb([makeAgent({ agent_id: 'us-east-1' }), makeAgent({ agent_id: 'eu-west-2' })]); });
    act(() => { result.current.setSearchQuery('east'); });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].agent_id).toBe('us-east-1');
  });

  it('filteredSessions: filters by searchQuery matching session_name', () => {
    const ws = makeMockWsService();
    let sessionsCb: (s: Session[]) => void = () => {};
    vi.mocked(ws.onSessionsChanged).mockImplementation((cb) => { sessionsCb = cb as (s: Session[]) => void; return () => {}; });
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { sessionsCb([makeSession({ session_name: 'prod-api' }), makeSession({ session_id: 'agent-1:dev', session_name: 'dev-tools' })]); });
    act(() => { result.current.setSearchQuery('prod'); });

    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].session_name).toBe('prod-api');
  });

  it('isSearchActive: true when searchQuery is not empty', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { result.current.setSearchQuery('test'); });
    expect(result.current.isSearchActive).toBe(true);

    act(() => { result.current.setSearchQuery(''); });
    expect(result.current.isSearchActive).toBe(false);
  });

  it('isSearchActive: true when statusFilter is not all', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { result.current.setStatusFilter('offline'); });
    expect(result.current.isSearchActive).toBe(true);

    act(() => { result.current.setStatusFilter('all'); });
    expect(result.current.isSearchActive).toBe(false);
  });
});

describe('useDashboardHandlers — sorting', () => {
  it('toggleSort: cycles through asc → desc → asc for the same field', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    expect(result.current.sortField).toBe('name');
    expect(result.current.sortDirection).toBe('asc');

    act(() => { result.current.toggleSort('name'); });
    expect(result.current.sortField).toBe('name');
    expect(result.current.sortDirection).toBe('desc');

    act(() => { result.current.toggleSort('name'); });
    expect(result.current.sortDirection).toBe('asc');
  });

  it('toggleSort: switches field and resets direction to asc', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => { result.current.toggleSort('name'); }); // desc
    act(() => { result.current.toggleSort('activity'); }); // switch field
    expect(result.current.sortField).toBe('activity');
    expect(result.current.sortDirection).toBe('asc');
  });

  it('sorted sessions: sorts by name ascending', () => {
    const ws = makeMockWsService();
    let sessionsCb: (s: Session[]) => void = () => {};
    vi.mocked(ws.onSessionsChanged).mockImplementation((cb) => { sessionsCb = cb as (s: Session[]) => void; return () => {}; });
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => {
      sessionsCb([
        makeSession({ session_name: 'zulu', session_id: 'a:zulu' }),
        makeSession({ session_name: 'alpha', session_id: 'a:alpha' }),
      ]);
    });

    expect(result.current.filteredSessions).toHaveLength(2);
    expect(result.current.filteredSessions[0].session_name).toBe('alpha');
    expect(result.current.filteredSessions[1].session_name).toBe('zulu');
  });

  it('sorted sessions: respects desc direction', () => {
    const ws = makeMockWsService();
    let sessionsCb: (s: Session[]) => void = () => {};
    vi.mocked(ws.onSessionsChanged).mockImplementation((cb) => { sessionsCb = cb as (s: Session[]) => void; return () => {}; });
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    act(() => {
      sessionsCb([
        makeSession({ session_name: 'alpha', session_id: 'a:alpha' }),
        makeSession({ session_name: 'zulu', session_id: 'a:zulu' }),
      ]);
    });
    act(() => { result.current.toggleSort('name'); }); // desc

    expect(result.current.filteredSessions[0].session_name).toBe('zulu');
    expect(result.current.filteredSessions[1].session_name).toBe('alpha');
  });
});

describe('useDashboardHandlers — heartbeat tracking', () => {
  it('getHeartbeatHistory: accumulates heartbeats from agents.changed events', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    const t1 = new Date(Date.now() - 10000).toISOString();
    const t2 = new Date(Date.now() - 5000).toISOString();

    act(() => { agentsCb([makeAgent({ agent_id: 'agent-1', last_heartbeat: t1 })]); });
    act(() => { agentsCb([makeAgent({ agent_id: 'agent-1', last_heartbeat: t2 })]); });

    const history = result.current.getHeartbeatHistory('agent-1');
    expect(history).toHaveLength(2);
    expect(history[0]).toBe(t1);
    expect(history[1]).toBe(t2);
  });

  it('getHeartbeatHistory: caps at 10 entries', () => {
    const ws = makeMockWsService();
    let agentsCb: (a: Agent[]) => void = () => {};
    vi.mocked(ws.onAgentsChanged).mockImplementation((cb) => { agentsCb = cb as (a: Agent[]) => void; return () => {}; });
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    for (let i = 0; i < 15; i++) {
      const ts = new Date(Date.now() - (15 - i) * 1000).toISOString();
      act(() => { agentsCb([makeAgent({ agent_id: 'agent-1', last_heartbeat: ts })]); });
    }

    const history = result.current.getHeartbeatHistory('agent-1');
    expect(history).toHaveLength(10);
  });

  it('getHeartbeatHistory: returns empty array for unknown agent', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    expect(result.current.getHeartbeatHistory('unknown')).toEqual([]);
  });
});

describe('useDashboardHandlers — selectedAgent', () => {
  it('setSelectedAgent: sets and clears the selected agent for detail panel', () => {
    const ws = makeMockWsService();
    vi.mocked(ws.onAgentsChanged).mockReturnValue(() => {});
    vi.mocked(ws.onSessionsChanged).mockReturnValue(() => {});
    vi.mocked(ws.listAgents).mockResolvedValue([]);
    vi.mocked(ws.listSessions).mockResolvedValue([]);

    const { result } = renderHook(() => useDashboardHandlers(ws));

    const agent = makeAgent();
    act(() => { result.current.setSelectedAgent(agent); });
    expect(result.current.selectedAgent).toEqual(agent);

    act(() => { result.current.setSelectedAgent(null); });
    expect(result.current.selectedAgent).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/hooks/__tests__/useDashboardHandlers.test.ts
```

Expected: multiple FAILs — new properties (`searchQuery`, `statusFilter`, `filteredAgents`, etc.) not defined.

- [ ] **Step 3: Implement extended useDashboardHandlers**

Modify `web/src/components/useDashboardHandlers.ts`. Replace the entire file:

```ts
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import type { Agent, Session, AttachInfo } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { AttachedSession } from './TerminalView';

export type StatusFilter = 'all' | 'online' | 'offline';
export type SortField = 'name' | 'activity';
export type SortDirection = 'asc' | 'desc';

export interface DashboardState {
  agents: Agent[];
  sessions: Session[];
  loadingAgents: boolean;
  loadingSessions: boolean;
  error: string | null;
  selectedAgent: Agent | null;
  filteredAgents: Agent[];
  filteredSessions: Session[];
  attachingInProgress: boolean;
  showCreateModal: boolean;
  sessionToKill: Session | null;
  // Search & filter
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  isSearchActive: boolean;
  // Sort
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  // Actions
  setShowCreateModal: (show: boolean) => void;
  setSessionToKill: (s: Session | null) => void;
  setSelectedAgent: (a: Agent | null) => void;
  handleAttach: (session: Session) => void;
  handleSessionKilled: () => void;
  handleSessionCreated: () => void;
  fetchSessions: (agentId?: string) => Promise<void>;
  // Heartbeat
  getHeartbeatHistory: (agentId: string) => string[];
}

export function useDashboardHandlers(wsService: WebSocketService): DashboardState {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachingInProgress, setAttachingInProgress] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  // New state: search, filter, sort, detail panel
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // Heartbeat history: client-side tracking, capped at 10 per agent
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try { setAgents(await wsService.listAgents()); }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to fetch agents'; setError(msg); toast.error(msg); }
    finally { setLoadingAgents(false); }
  }, [wsService]);

  const fetchSessions = useCallback(async (agentId?: string) => {
    setLoadingSessions(true);
    setError(null);
    try { setSessions(await wsService.listSessions(agentId)); }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to fetch sessions'; setError(msg); toast.error(msg); }
    finally { setLoadingSessions(false); }
  }, [wsService]);

  // Subscribe to WebSocket events and track heartbeat history
  useEffect(() => {
    const u1 = wsService.onAgentsChanged((newAgents) => {
      setAgents(newAgents);
      // Track heartbeat history
      for (const a of newAgents) {
        const history = heartbeatHistory.current.get(a.agent_id) || [];
        history.push(a.last_heartbeat);
        if (history.length > 10) history.shift();
        heartbeatHistory.current.set(a.agent_id, history);
      }
    });
    const u2 = wsService.onSessionsChanged(setSessions);
    return () => { u1(); u2(); };
  }, [wsService]);

  useEffect(() => { fetchAgents(); fetchSessions(); }, [fetchAgents, fetchSessions]);

  // ---- Computed: filtered agents ----
  const filteredAgents = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return agents
      .filter((a) => statusFilter === 'all' || a.status === statusFilter)
      .filter((a) => !q ||
        a.hostname.toLowerCase().includes(q) ||
        a.agent_id.toLowerCase().includes(q));
  }, [agents, searchQuery, statusFilter]);

  // ---- Computed: filtered sessions ----
  const filteredSessions = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return sessions
      .filter((s) => {
        if (statusFilter === 'all') return true;
        const agent = agents.find((a) => a.agent_id === s.agent_id);
        return agent ? agent.status === statusFilter : true;
      })
      .filter((s) => !q ||
        s.session_name.toLowerCase().includes(q) ||
        s.agent_id.toLowerCase().includes(q))
      .sort((a, b) => {
        const cmp = sortField === 'name'
          ? a.session_name.localeCompare(b.session_name)
          : new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime();
        return sortDirection === 'asc' ? cmp : -cmp;
      });
  }, [sessions, agents, searchQuery, statusFilter, sortField, sortDirection]);

  // ---- Computed: is search active ----
  const isSearchActive = searchQuery.trim() !== '' || statusFilter !== 'all';

  // ---- Toggle sort ----
  const toggleSort = useCallback((field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  // ---- Get heartbeat history ----
  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) || [];
  }, []);

  const handleAttach = useCallback(async (session: Session) => {
    setAttachingInProgress(true);
    setError(null);
    try {
      let attachInfo: AttachInfo;
      try { attachInfo = await wsService.requestAttach(session.session_id, 'p2p'); }
      catch { attachInfo = await wsService.requestAttach(session.session_id, 'relay'); }
      (handleAttach as unknown as { _attached?: AttachedSession })._attached = {
        sessionId: session.session_id, sessionName: session.session_name, attachInfo,
      };
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to attach to session';
      setError(msg); toast.error(msg);
    }
    finally { setAttachingInProgress(false); }
  }, [wsService]);

  const handleSessionKilled = useCallback(() => {
    setSessionToKill(null);
    fetchSessions();
  }, [fetchSessions]);

  const handleSessionCreated = useCallback(() => {
    setShowCreateModal(false);
    fetchSessions();
  }, [fetchSessions]);

  return {
    agents, sessions, loadingAgents, loadingSessions, error,
    selectedAgent, filteredAgents, filteredSessions, attachingInProgress,
    showCreateModal, sessionToKill,
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    isSearchActive,
    sortField, sortDirection, toggleSort,
    setShowCreateModal, setSessionToKill, setSelectedAgent,
    handleAttach, handleSessionKilled, handleSessionCreated,
    fetchSessions,
    getHeartbeatHistory,
  };
}
```

Key changes from old version:
- Removed `selectedAgentId`, `handleAgentClick` (agent click now opens detail panel via `setSelectedAgent`)
- Added `searchQuery`, `statusFilter`, `sortField`, `sortDirection`, `selectedAgent` state
- Added `heartbeatHistory` useRef
- Added `useMemo` for computed `filteredAgents` + `filteredSessions` (was `filteredSessions` only)
- Added `toggleSort`, `getHeartbeatHistory`, `isSearchActive`
- `handleSessionKilled` and `handleSessionCreated` no longer depend on `selectedAgentId`

- [ ] **Step 4: Update vite.config.ts to remove useDashboardHandlers from coverage exclude**

Modify `web/vite.config.ts` — in the `coverage.exclude` array, remove this line:
```
'src/components/useDashboardHandlers.ts',
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/hooks/__tests__/useDashboardHandlers.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/useDashboardHandlers.ts web/src/hooks/__tests__/useDashboardHandlers.test.ts web/vite.config.ts
git commit -m "feat: extend useDashboardHandlers with search, filter, sort, and heartbeat tracking

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Create SearchBar component

**Files:**
- Create: `web/src/components/SearchBar.tsx`
- Create: `web/src/components/__tests__/SearchBar.test.tsx`

- [ ] **Step 1: Write the failing test for SearchBar**

Create `web/src/components/__tests__/SearchBar.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBar } from '../SearchBar';
import type { StatusFilter } from '../useDashboardHandlers';

describe('SearchBar', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders search input and status toggle buttons', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={3}
        offlineCount={1}
      />,
    );

    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /all/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 online/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 offline/i })).toBeInTheDocument();
  });

  it('calls setSearchQuery after 200ms debounce', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const setSearchQuery = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText(/search/i);
    await user.type(input, 'prod');

    // Should NOT fire immediately
    expect(setSearchQuery).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(200);

    // Should fire once with final value
    expect(setSearchQuery).toHaveBeenCalledTimes(1);
    expect(setSearchQuery).toHaveBeenCalledWith('prod');
  });

  it('calls setStatusFilter when toggle button is clicked', async () => {
    const user = userEvent.setup();
    const setStatusFilter = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={setStatusFilter}
        onlineCount={5}
        offlineCount={2}
      />,
    );

    await user.click(screen.getByRole('button', { name: /5 online/i }));
    expect(setStatusFilter).toHaveBeenCalledWith('online');
  });

  it('highlights active status filter button', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="offline"
        setStatusFilter={vi.fn()}
        onlineCount={2}
        offlineCount={3}
      />,
    );

    const offlineBtn = screen.getByRole('button', { name: /3 offline/i });
    // Active button should have default variant (not outline)
    expect(offlineBtn.className).not.toContain('outline');
  });

  it('renders search icon', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    // Search icon should be present (lucide Search)
    const input = screen.getByPlaceholderText(/search/i);
    expect(input).toBeInTheDocument();
  });

  it('does not debounce on first render with initial value', () => {
    render(
      <SearchBar
        searchQuery="prod"
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    expect(input.value).toBe('prod');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/SearchBar.test.tsx
```

Expected: FAIL — SearchBar module not found.

- [ ] **Step 3: Implement SearchBar component**

Create `web/src/components/SearchBar.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Search } from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import type { StatusFilter } from './useDashboardHandlers';

interface SearchBarProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
}

export function SearchBar({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
}: SearchBarProps) {
  const [localValue, setLocalValue] = useState(searchQuery);
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Sync external value changes
  useEffect(() => {
    setLocalValue(searchQuery);
  }, [searchQuery]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setLocalValue(val);
      if (debounceTimer) clearTimeout(debounceTimer);
      const timer = setTimeout(() => setSearchQuery(val), 200);
      setDebounceTimer(timer);
    },
    [setSearchQuery, debounceTimer],
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (debounceTimer) clearTimeout(debounceTimer); };
  }, [debounceTimer]);

  const filters: { label: string; value: StatusFilter; count: number }[] = [
    { label: 'All', value: 'all', count: onlineCount + offlineCount },
    { label: 'Online', value: 'online', count: onlineCount },
    { label: 'Offline', value: 'offline', count: offlineCount },
  ];

  return (
    <div className="px-6 py-2 border-b flex items-center gap-4">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search agents and sessions..."
          value={localValue}
          onChange={handleChange}
        />
      </div>
      <div className="flex items-center gap-1">
        {filters.map(({ label, value, count }) => (
          <Button
            key={value}
            size="sm"
            variant={statusFilter === value ? 'default' : 'outline'}
            onClick={() => setStatusFilter(value)}
            className="text-xs"
          >
            {label === 'All' ? 'All' : `${count} ${label}`}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/SearchBar.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SearchBar.tsx web/src/components/__tests__/SearchBar.test.tsx
git commit -m "feat: add SearchBar with debounced search and status filter toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Modify AgentCard click behavior

**Files:**
- Modify: `web/src/components/AgentCard.tsx`
- Modify: `web/src/components/__tests__/AgentCard.test.tsx`

- [ ] **Step 1: Update AgentCard test for new behavior**

Modify `web/src/components/__tests__/AgentCard.test.tsx` — the existing "fires onClick when clicked" test already works. Add two tests:

Add after the existing "applies selected ring style" test (around line 72):

```ts
  it('no longer shows selected ring for detail-panel selection (ring only for keyboard focus)', () => {
    // AgentCard no longer has a "selected" concept from filtering
    // The selected prop is removed — cards are always neutral
    const { container } = render(
      <AgentCard agent={makeAgent()} onClick={vi.fn()} />,
    );
    const card = container.firstElementChild;
    // Card should not have ring styles
    expect(card?.className).not.toContain('ring-2');
  });
```

Also update the test file to remove the `selected` prop from all render calls. The `AgentCardProps` interface changes:

Remove `selected` prop, change interface:

```ts
// Old interface:
// interface AgentCardProps {
//   agent: Agent;
//   selected: boolean;
//   onClick: () => void;
// }

// New interface:
// interface AgentCardProps {
//   agent: Agent;
//   onClick: () => void;
// }
```

Update all test render calls to remove `selected={true|false}`. The "applies selected ring style" test should be replaced by the new test above.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/AgentCard.test.tsx
```

Expected: FAIL — `selected` prop no longer exists on AgentCard.

- [ ] **Step 3: Simplify AgentCard — remove selected prop**

Modify `web/src/components/AgentCard.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import type { Agent } from '../types';

interface AgentCardProps {
  agent: Agent;
  onClick: () => void;
}

function getStatusVariant(status: Agent['status']): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'online':   return 'default';
    case 'degraded': return 'secondary';
    case 'offline':  return 'outline';
  }
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {return 'just now';}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m ago`;}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h ago`;}
  return `${Math.floor(hours / 24)}d ago`;
}

export function AgentCard({ agent, onClick }: AgentCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:border-primary/50',
        agent.status === 'online' && 'border-green-500/30',
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant={getStatusVariant(agent.status)} className="capitalize">
            {agent.status}
          </Badge>
        </div>
        <h3 className="font-semibold truncate text-foreground">{agent.hostname}</h3>
        <p className="text-sm text-muted-foreground">
          {agent.session_count} session{agent.session_count !== 1 ? 's' : ''} &middot; {formatRelativeTime(agent.last_heartbeat)}
        </p>
      </CardContent>
    </Card>
  );
}
```

Changes: removed `selected` from props, removed `selected && 'ring-2 ring-primary'` from className.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/AgentCard.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AgentCard.tsx web/src/components/__tests__/AgentCard.test.tsx
git commit -m "feat: simplify AgentCard — remove selected prop, click opens detail panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Create AgentDetailPanel component

**Files:**
- Create: `web/src/components/AgentDetailPanel.tsx`
- Create: `web/src/components/__tests__/AgentDetailPanel.test.tsx`

- [ ] **Step 1: Write the failing test for AgentDetailPanel**

Create `web/src/components/__tests__/AgentDetailPanel.test.tsx`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentDetailPanel } from '../AgentDetailPanel';
import type { Agent } from '../../types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-prod-01',
    ip_address: '10.0.1.42',
    port: 19090,
    status: 'online',
    session_count: 5,
    last_heartbeat: new Date().toISOString(),
    metadata: {
      tmux_version: '3.4',
      os_version: 'Ubuntu 24.04 LTS',
      nession_version: '0.3.3',
    },
    ...overrides,
  };
}

describe('AgentDetailPanel', () => {
  it('renders agent hostname and status', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('server-prod-01')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('renders connection section', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('10.0.1.42')).toBeInTheDocument();
    expect(screen.getByText('19090')).toBeInTheDocument();
  });

  it('renders versions section', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('0.3.3')).toBeInTheDocument();
    expect(screen.getByText('3.4')).toBeInTheDocument();
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument();
  });

  it('shows Unknown for missing metadata', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent({ metadata: undefined })}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    const unknowns = screen.getAllByText('Unknown');
    expect(unknowns.length).toBeGreaterThanOrEqual(3); // nession, tmux, OS
  });

  it('shows session count', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent({ session_count: 7 })}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/7/)).toBeInTheDocument();
  });

  it('shows "No heartbeat data yet" for empty history', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/no heartbeat data/i)).toBeInTheDocument();
  });

  it('shows heartbeat timeline when history exists', () => {
    const history = [
      new Date(Date.now() - 10000).toISOString(),
      new Date(Date.now() - 5000).toISOString(),
    ];

    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={history}
        onClose={vi.fn()}
      />,
    );

    // Should show relative time indicators
    expect(screen.getByText(/heartbeat history/i)).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={onClose}
      />,
    );

    // Sheet has a close button — find by role
    const closeBtn = screen.getByRole('button', { name: /close/i });
    closeBtn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders uptime from heartbeat history', () => {
    const firstHeartbeat = new Date(Date.now() - 3 * 3600 * 1000 - 42 * 60 * 1000).toISOString();
    const history = [firstHeartbeat];

    render(
      <AgentDetailPanel
        agent={makeAgent({ last_heartbeat: new Date().toISOString() })}
        heartbeatHistory={history}
        onClose={vi.fn()}
      />,
    );

    // Should show uptime around 3h 42m
    expect(screen.getByText(/3h/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/AgentDetailPanel.test.tsx
```

Expected: FAIL — AgentDetailPanel module not found.

- [ ] **Step 3: Implement AgentDetailPanel component**

Create `web/src/components/AgentDetailPanel.tsx`:

```tsx
import { Clock, Monitor, Server, HardDrive, Activity, Terminal } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { cn } from '@/lib/utils';
import type { Agent } from '../types';

interface AgentDetailPanelProps {
  agent: Agent;
  heartbeatHistory: string[];
  onClose: () => void;
}

function getStatusVariant(status: Agent['status']): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'online':   return 'default';
    case 'degraded': return 'secondary';
    case 'offline':  return 'outline';
  }
}

function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function computeUptime(heartbeatHistory: string[]): string | null {
  if (heartbeatHistory.length < 1) return null;
  const first = new Date(heartbeatHistory[0]).getTime();
  const now = Date.now();
  const diff = now - first;
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getHeartbeatColor(timestamp: string): string {
  const diff = (Date.now() - new Date(timestamp).getTime()) / 1000;
  if (diff < 60) return 'bg-green-500';
  if (diff < 180) return 'bg-amber-500';
  return 'bg-muted-foreground/40';
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SectionHeader({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function AgentDetailPanel({ agent, heartbeatHistory, onClose }: AgentDetailPanelProps) {
  const uptime = computeUptime(heartbeatHistory);
  const firstHeartbeatAbsolute = heartbeatHistory.length > 0
    ? formatAbsoluteTime(heartbeatHistory[0])
    : null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Badge variant={getStatusVariant(agent.status)} className="capitalize">
              {agent.status}
            </Badge>
            <span className="truncate">{agent.hostname}</span>
          </SheetTitle>
        </SheetHeader>

        {/* Connection */}
        <SectionHeader icon={Server} title="Connection" />
        <InfoRow label="Hostname" value={agent.hostname} />
        <InfoRow label="IP Address" value={agent.ip_address} />
        <InfoRow label="Port" value={agent.port} />

        {/* Versions */}
        <SectionHeader icon={Terminal} title="Versions" />
        <InfoRow label="Nession" value={agent.metadata?.nession_version ?? 'Unknown'} />
        <InfoRow label="tmux" value={agent.metadata?.tmux_version ?? 'Unknown'} />
        <InfoRow label="OS" value={agent.metadata?.os_version ?? 'Unknown'} />

        {/* Uptime */}
        <SectionHeader icon={Clock} title="Uptime" />
        {uptime ? (
          <div className="text-sm">
            <p className="font-medium">{uptime}</p>
            {firstHeartbeatAbsolute && (
              <p className="text-xs text-muted-foreground">since {firstHeartbeatAbsolute}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Just connected</p>
        )}

        {/* Heartbeat History */}
        <SectionHeader icon={Activity} title="Heartbeat History" />
        {heartbeatHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No heartbeat data yet</p>
        ) : (
          <div className="space-y-1.5">
            {heartbeatHistory.slice().reverse().slice(0, 10).map((ts, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', getHeartbeatColor(ts))} />
                <span className="text-muted-foreground">{formatRelativeTime(ts)}</span>
                <span className="text-xs text-muted-foreground/60">{formatAbsoluteTime(ts)}</span>
              </div>
            ))}
          </div>
        )}

        <Separator className="mt-4" />

        {/* Sessions */}
        <SectionHeader icon={Monitor} title="Sessions" />
        <p className="text-sm">
          {agent.session_count} active session{agent.session_count !== 1 ? 's' : ''} on this agent
        </p>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/AgentDetailPanel.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AgentDetailPanel.tsx web/src/components/__tests__/AgentDetailPanel.test.tsx
git commit -m "feat: add AgentDetailPanel Sheet with metadata, uptime, heartbeat history

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Modify SessionList — sortable headers + empty state

**Files:**
- Modify: `web/src/components/SessionList.tsx`
- Modify: `web/src/components/__tests__/SessionList.test.tsx`

- [ ] **Step 1: Update SessionList test for sortable headers and empty state**

Modify `web/src/components/__tests__/SessionList.test.tsx`. Replace the entire file:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '../SessionList';
import type { Session } from '../../types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:sess-1',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 3,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionList', () => {
  it('renders session rows', () => {
    const sessions: Session[] = [
      makeSession({ session_name: 'dev', status: 'active' }),
      makeSession({ session_id: 'agent-1:sess-2', session_name: 'staging', status: 'detached' }),
    ];

    render(
      <SessionList
        sessions={sessions}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
  });

  it('has Attach and Kill buttons for each session', () => {
    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument();
  });

  it('calls onAttach when Attach button is clicked', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const session = makeSession();

    render(
      <SessionList
        sessions={[session]}
        loading={false}
        onAttach={onAttach}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Attach' }));
    expect(onAttach).toHaveBeenCalledWith(session);
  });

  it('calls onKill when Kill button is clicked', async () => {
    const user = userEvent.setup();
    const onKill = vi.fn();
    const session = makeSession();

    render(
      <SessionList
        sessions={[session]}
        loading={false}
        onAttach={vi.fn()}
        onKill={onKill}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Kill' }));
    expect(onKill).toHaveBeenCalledWith(session);
  });

  it('shows no sessions message when empty and not searching', () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByText(/No sessions for this agent/)).toBeInTheDocument();
  });

  it('shows search-empty state when empty and isSearchActive', () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={true}
      />,
    );

    expect(screen.getByText(/No agents or sessions match/)).toBeInTheDocument();
  });

  it('shows skeleton when loading', () => {
    render(
      <SessionList
        sessions={[]}
        loading={true}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('disables Attach buttons when attachingInProgress', () => {
    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={true}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });

  it('calls toggleSort when Name header is clicked', async () => {
    const user = userEvent.setup();
    const toggleSort = vi.fn();

    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={toggleSort}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByText('Name'));
    expect(toggleSort).toHaveBeenCalledWith('name');
  });

  it('calls toggleSort when Activity header is clicked', async () => {
    const user = userEvent.setup();
    const toggleSort = vi.fn();

    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={toggleSort}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByText('Activity'));
    expect(toggleSort).toHaveBeenCalledWith('activity');
  });

  it('shows sort direction indicator on active column', () => {
    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    // The Name header should contain an arrow indicator when it's the active sort field
    const nameHeader = screen.getByText('Name');
    expect(nameHeader).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/SessionList.test.tsx
```

Expected: FAIL — new required props (`sortField`, `sortDirection`, `toggleSort`, `isSearchActive`) not provided.

- [ ] **Step 3: Update SessionList component**

Modify `web/src/components/SessionList.tsx`:

```tsx
import { ArrowUp, ArrowDown, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import type { Session } from '../types';
import type { SortField, SortDirection } from './useDashboardHandlers';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
  attachingInProgress: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
}

function SortIcon({ field, activeField, direction }: {
  field: SortField;
  activeField: SortField;
  direction: SortDirection;
}) {
  if (field !== activeField) return null;
  return direction === 'asc'
    ? <ArrowUp className="h-3 w-3" />
    : <ArrowDown className="h-3 w-3" />;
}

export function SessionList({
  sessions,
  loading,
  onAttach,
  onKill,
  attachingInProgress,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
}: SessionListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    );
  }

  if (sessions.length === 0) {
    if (isSearchActive) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">No agents or sessions match your search</p>
        </div>
      );
    }
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No sessions for this agent
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-64 rounded-md border">
      <div className="divide-y divide-border">
        {/* Sortable header */}
        <div className="flex items-center gap-3 py-2 px-3 bg-muted/50 text-xs font-medium text-muted-foreground">
          <span className="w-2 flex-shrink-0" />
          <button
            className="flex-1 flex items-center gap-1 hover:text-foreground transition-colors min-w-0"
            onClick={() => toggleSort('name')}
          >
            Name
            <SortIcon field="name" activeField={sortField} direction={sortDirection} />
          </button>
          <button
            className="w-16 flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => toggleSort('activity')}
          >
            Activity
            <SortIcon field="activity" activeField={sortField} direction={sortDirection} />
          </button>
          <span className="w-[124px] flex-shrink-0" />
        </div>

        {/* Session rows */}
        {sessions.map((session) => (
          <div
            key={session.session_id}
            className="flex items-center gap-3 py-2.5 px-3 hover:bg-accent/50 transition-colors"
          >
            <span
              className={cn(
                'w-2 h-2 rounded-full flex-shrink-0',
                session.status === 'active' ? 'bg-green-500' :
                session.status === 'detached' ? 'bg-emerald-500/60' :
                'bg-gray-400',
              )}
            />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">{session.session_name}</p>
              <p className="text-xs text-muted-foreground">
                {session.agent_id} · {session.window_count} win · {session.attached_clients} client
                {session.attached_clients !== 1 ? 's' : ''}
                {session.status === 'detached' && ' · detached'}
                {session.status === 'zombie' && ' · zombie'}
              </p>
            </div>
            <div className="flex gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                onClick={() => onAttach(session)}
                disabled={attachingInProgress}
              >
                Attach
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onKill(session)}
                className="text-destructive border-destructive hover:bg-destructive/10"
              >
                Kill
              </Button>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
```

Changes: added `sortField`, `sortDirection`, `toggleSort`, `isSearchActive` props; added `SortIcon` helper; added sortable header row with Name/Activity buttons; added `SearchX` empty state for search with no results.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run src/components/__tests__/SessionList.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SessionList.tsx web/src/components/__tests__/SessionList.test.tsx
git commit -m "feat: add sortable headers and search-empty state to SessionList

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Modify Dashboard to integrate all new components

**Files:**
- Modify: `web/src/components/Dashboard.tsx`

- [ ] **Step 1: Update Dashboard.tsx**

Replace `web/src/components/Dashboard.tsx`:

```tsx
import { useState, useCallback } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Session, ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { TerminalView, type AttachedSession } from './TerminalView';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AgentCard } from './AgentCard';
import { SessionList } from './SessionList';
import { SearchBar } from './SearchBar';
import { AgentDetailPanel } from './AgentDetailPanel';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import { useDashboardHandlers } from './useDashboardHandlers';

interface DashboardProps {
  wsService: WebSocketService;
  connectionStatus: ConnectionStatus;
}

type View = 'dashboard' | 'terminal';

export function Dashboard({ wsService, connectionStatus }: DashboardProps) {
  const [view, setView] = useState<View>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);

  const {
    agents, loadingAgents, loadingSessions, error,
    filteredAgents, filteredSessions, attachingInProgress,
    showCreateModal, sessionToKill,
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    isSearchActive,
    sortField, sortDirection, toggleSort,
    selectedAgent, setSelectedAgent,
    getHeartbeatHistory,
    setShowCreateModal, setSessionToKill,
    handleAttach, handleSessionKilled, handleSessionCreated,
    fetchSessions,
  } = useDashboardHandlers(wsService);

  const onAttach = useCallback(async (session: Session) => {
    await handleAttach(session);
    const attached = (handleAttach as unknown as { _attached?: AttachedSession })._attached;
    if (attached) { setAttachedSession(attached); setView('terminal'); }
  }, [handleAttach]);

  const handleBackToDashboard = useCallback(() => {
    setAttachedSession(null);
    setView('dashboard');
    fetchSessions();
  }, [fetchSessions]);

  const handleTerminalDisconnect = useCallback(() => {
    toast.error('Terminal connection lost');
    handleBackToDashboard();
  }, [handleBackToDashboard]);

  const handleTerminalError = useCallback(
    (err: Error) => { toast.error(`Terminal error: ${err.message}`); },
    [],
  );

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const offlineCount = agents.filter((a) => a.status === 'offline').length;

  // ── Terminal View ───────────────────────────────────────────────────
  if (view === 'terminal' && attachedSession) {
    return (
      <TerminalView
        session={attachedSession}
        wsService={wsService}
        onBack={handleBackToDashboard}
        onDisconnect={handleTerminalDisconnect}
        onError={handleTerminalError}
      />
    );
  }

  // ── Dashboard View ──────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <h1 className="text-lg font-bold">Nession</h1>
        <Badge variant="outline" className="gap-1.5 py-1.5">
          <span className={cn('w-2 h-2 rounded-full',
            connectionStatus === 'authenticated' ? 'bg-green-500' : 'bg-red-500',
            connectionStatus === 'connecting' && 'animate-pulse bg-amber-500',
          )} />
          {connectionStatus}
        </Badge>
        <div className="flex-1" />
        <Button size="sm" onClick={() => fetchSessions()} disabled={loadingAgents}>
          <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
        </Button>
      </header>

      <SearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
      />

      {error && (
        <div className="px-6 py-2 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <span>{error}</span>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {}}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col p-6 gap-6">
        {/* Agent Cards */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
          </div>
          {loadingAgents ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
            </div>
          ) : agents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No agents connected</p>
          ) : filteredAgents.length === 0 && isSearchActive ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No agents match your search</p>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {filteredAgents.map((a) => (
                <AgentCard key={a.agent_id} agent={a} onClick={() => setSelectedAgent(a)} />
              ))}
            </div>
          )}
        </section>

        {/* Sessions */}
        <section className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions
            </h2>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setShowCreateModal(true)} disabled={agents.every((a) => a.status !== 'online')}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => fetchSessions()} disabled={loadingSessions}>
                <RefreshCw className={cn('w-3.5 h-3.5', loadingSessions && 'animate-spin')} />
              </Button>
            </div>
          </div>
          <SessionList
            sessions={filteredSessions}
            loading={loadingSessions}
            onAttach={onAttach}
            onKill={setSessionToKill}
            attachingInProgress={attachingInProgress}
            sortField={sortField}
            sortDirection={sortDirection}
            toggleSort={toggleSort}
            isSearchActive={isSearchActive}
          />
        </section>
      </div>

      {/* Agent Detail Panel */}
      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          heartbeatHistory={getHeartbeatHistory(selectedAgent.agent_id)}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        wsService={wsService}
        agents={agents}
        preselectedAgentId={null}
        onCreated={handleSessionCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        wsService={wsService}
        session={sessionToKill}
        onKilled={handleSessionKilled}
      />
    </div>
  );
}
```

Key changes:
- Import `SearchBar`, `AgentDetailPanel` instead of old filtering logic
- Use `filteredAgents` (computed) instead of `agents`
- Use `filteredSessions` (computed + sorted) instead of `filteredSessions` from old hook
- `preselectedAgentId` set to `null` (no more agent-filter-by-click)
- Remove `selectedAgentId` and `(filtered)` label logic
- AgentCard onClick: `setSelectedAgent(a)` instead of old `handleAgentClick`
- Pass `sortField`, `sortDirection`, `toggleSort`, `isSearchActive` to SessionList
- Conditionally render AgentDetailPanel when `selectedAgent` is set

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/admin/Documents/learn/nession/web && npx vitest run
```

Expected: all tests PASS, including existing tests for AgentCard, SessionList, and new tests.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Dashboard.tsx
git commit -m "feat: integrate SearchBar, AgentDetailPanel, and new hook API into Dashboard

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Full verification — build, lint, coverage

**Files:** (none — verification only)

- [ ] **Step 1: TypeScript check**

```bash
cd /Users/admin/Documents/learn/nession/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: ESLint**

```bash
cd /Users/admin/Documents/learn/nession/web && npm run lint
```

Expected: pass with `--max-warnings 0`. If any lint violations, fix them (no `eslint-disable`).

- [ ] **Step 3: Build check**

```bash
cd /Users/admin/Documents/learn/nession/web && npm run build
```

Expected: `tsc && vite build` succeeds.

- [ ] **Step 4: Full test coverage**

```bash
cd /Users/admin/Documents/learn/nession/web && npm run coverage
```

Expected: coverage ≥ 80%. `useDashboardHandlers.ts` now included (removed from exclude list).

- [ ] **Step 5: Commit any fixes**

If any fixes were needed during verification:

```bash
git add -A
git commit -m "fix: resolve lint/tsc issues from dashboard feature integration

Co-Authored-By: Claude <noreply@anthropic.com>"
```
