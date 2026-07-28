# WebUI Architecture Optimization Design

## Overview

This document describes the architectural optimization design for the Nession WebUI (`web/src/`). The design is based on the requirements defined in [GitHub Issue #104](https://github.com/BestNathan/nession/issues/104).

**Core principles:**
1. **Incremental refactoring** — Each phase is independently verifiable and rollbackable
2. **Backward compatibility** — All existing APIs remain unchanged
3. **Plugin-based extension** — WebSocketService extends functionality through plugins, not hardcoding

## Architecture Overview

```
web/src/
├── components/          # UI components (presentation only)
│   └── env/             # Env domain (with types.ts)
├── hooks/               # Custom hooks (state management)
│   ├── useDashboard.ts  # Composite hook (unified API)
│   ├── useDashboardData.ts
│   ├── useDashboardFilters.ts
│   ├── useDashboardModals.ts
│   ├── useAsyncOperation.ts   # Generic async hook
│   └── useDataFetch.ts       # Generic data fetching hook
├── services/            # Business logic
│   └── websocket/
│       ├── WebSocketService.ts  # Facade
│       ├── core.ts              # WebSocketServiceCoreImpl
│       ├── types.ts             # Plugin interface
│       └── plugins/
│           ├── EventPlugin.ts      # Event subscription
│           ├── RequestPlugin.ts    # Request/response
│           └── TerminalPlugin.ts   # Terminal I/O
├── terminal/            # Terminal module
│   ├── protocol.ts      # Protocol encoding/decoding
│   └── types.ts         # Terminal types (already exists)
└── types.ts             # Core types (re-exports domain types)
```

## Part 1: Hook Organization

### Current State

4 hooks live in `components/` mixed with UI components:
- `components/useDashboardHandlers.ts`
- `components/useAttachFlow.ts`
- `components/useQuickCommands.ts`
- `components/useAgentRename.ts`

### Target State

All hooks move to `hooks/` directory. `components/` contains only UI components.

### Migration

| Source | Destination | Affected Files |
|--------|-------------|----------------|
| `components/useDashboardHandlers.ts` | `hooks/useDashboardHandlers.ts` | ~2 (Dashboard.tsx, test) |
| `components/useAttachFlow.ts` | `hooks/useAttachFlow.ts` | ~2 (Dashboard.tsx, test) |
| `components/useQuickCommands.ts` | `hooks/useQuickCommands.ts` | ~3 (QuickCommandsPanel, TerminalToolbar, tests) |
| `components/useAgentRename.ts` | `hooks/useAgentRename.ts` | ~2 (AgentCard, test) |

### Convention

Going forward, all hooks must be in `hooks/`. This will be documented in CLAUDE.md.

## Part 2: WebSocketService Plugin Architecture

### Current State

`services/websocket.ts` is 939 lines, handling connection management, authentication, request/response correlation, event subscriptions, and terminal I/O all in one class.

### Target State

WebSocketService becomes a facade (~500 lines) that delegates to plugins:

```typescript
export class WebSocketService {
  private core: WebSocketServiceCore;
  private plugins = new Map<string, WebSocketPlugin>();

  constructor(url: string, authToken: string) {
    this.core = new WebSocketServiceCoreImpl(url, authToken);
    this.use(new EventPlugin());
    this.use(new RequestPlugin());
    this.use(new TerminalPlugin());
  }

  use(plugin: WebSocketPlugin) {
    plugin.install(this.core);
    this.plugins.set(plugin.name, plugin);
  }

  // Delegate to plugins (API unchanged)
  onAgentsChanged(cb: (agents: Agent[]) => void): () => void {
    return this.getPlugin<EventPlugin>('events').onAgentsChanged(cb);
  }

  async listAgents(): Promise<Agent[]> {
    return this.getPlugin<RequestPlugin>('requests').listAgents();
  }
}
```

### Plugin Interface

```typescript
// services/websocket/types.ts

export interface WebSocketPlugin {
  name: string;
  install(service: WebSocketServiceCore): void;
  uninstall?(): void;
}

export interface WebSocketServiceCore {
  send(message: WebSocketMessage): void;
  onMessage(type: string, handler: (payload: any) => void): () => void;
  request<T>(type: string, payload: any): Promise<T>;
  getConnectionStatus(): ConnectionStatus;
  onConnectionChange(callback: (status: ConnectionStatus) => void): () => void;
}
```

### Plugin Responsibilities

| Plugin | Responsibility | Extracted From |
|--------|---------------|----------------|
| `EventPlugin` | Event subscriptions (agents/sessions/commands changed) | `onAgentsChanged`, `onSessionsChanged`, `onCommandsChanged`, `onTerminalOutput`, `onTerminalResize` |
| `RequestPlugin` | Request/response (listAgents, createSession, killSession, env CRUD, quick commands) | `request<T>`, `listAgents`, `listSessions`, `createSession`, `killSession`, all env/quick-command methods |
| `TerminalPlugin` | Terminal I/O (send input, handle output/resize) | `sendTerminalInput`, `sendTerminalResize`, `sendRelayInput`, `sendRelayResize`, `beginRelay`, `endRelay` |

### WebSocketServiceCoreImpl

The core implementation handles:
- WebSocket connection lifecycle (connect, disconnect, reconnect)
- Authentication handshake
- Message routing (dispatching to plugins via `onMessage` handlers)
- Request/response correlation (pending request map, timeout)
- Connection state management

### File Structure

```
services/websocket/
├── WebSocketService.ts   # Facade (~500 lines)
├── core.ts               # WebSocketServiceCoreImpl (~300 lines)
├── types.ts              # Plugin interfaces (~50 lines)
└── plugins/
    ├── EventPlugin.ts    # Event subscriptions (~150 lines)
    ├── RequestPlugin.ts  # Request/response (~200 lines)
    └── TerminalPlugin.ts # Terminal I/O (~100 lines)
```

## Part 3: Dashboard Hook Decomposition

### Current State

`useDashboardHandlers` returns 25+ properties, combining data management, filter state, modal state, and realtime subscriptions into one monolithic hook.

### Target State

Split into 3 focused hooks + 1 composite hook:

```typescript
// hooks/useDashboardData.ts
// Manages agents/sessions data, loading states, fetch functions
export function useDashboardData(wsService: WebSocketService) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());

  const fetchAgents = useCallback(async () => { /* ... */ }, [wsService]);
  const fetchSessions = useCallback(async () => { /* ... */ }, [wsService]);
  const updateAgent = useCallback((updated: Agent) => { /* ... */ }, []);
  const getHeartbeatHistory = useCallback((agentId: string) => { /* ... */ }, []);

  return {
    agents, sessions, loadingAgents, loadingSessions, error,
    fetchAgents, fetchSessions, updateAgent, getHeartbeatHistory,
    setError, setAgents, setSessions,
  };
}
```

```typescript
// hooks/useDashboardFilters.ts
// Manages search, filter, sort state
export function useDashboardFilters() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const isSearchActive = searchQuery !== '' || statusFilter !== 'all';

  const toggleSort = useCallback((field: SortField) => {
    if (field === sortField) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  return {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort,
    isSearchActive,
  };
}
```

```typescript
// hooks/useDashboardModals.ts
// Manages modal state
export function useDashboardModals() {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  return {
    selectedAgent, setSelectedAgent,
    showCreateModal, setShowCreateModal,
    sessionToKill, setSessionToKill,
  };
}
```

```typescript
// hooks/useDashboard.ts
// Composite layer: unified API (replaces useDashboardHandlers)
export function useDashboard(): DashboardState {
  const wsService = useWebSocket();
  const data = useDashboardData(wsService);
  const filters = useDashboardFilters();
  const modals = useDashboardModals();

  useRealtimeUpdates(wsService, data);

  const filteredAgents = useMemo(
    () => filterAgents(data.agents, filters.statusFilter, filters.searchQuery),
    [data.agents, filters.statusFilter, filters.searchQuery],
  );
  const filteredSessions = useMemo(
    () => filterSessions(data.sessions, data.agents, {
      statusFilter: filters.statusFilter,
      searchQuery: filters.searchQuery,
      sortField: filters.sortField,
      sortDirection: filters.sortDirection,
    }),
    [data.sessions, data.agents, filters.statusFilter, filters.searchQuery,
     filters.sortField, filters.sortDirection],
  );

  const handleSessionKilled = useCallback(() => {
    modals.setSessionToKill(null);
    data.fetchSessions();
  }, [data.fetchSessions, modals.setSessionToKill]);

  const handleSessionCreated = useCallback(() => {
    modals.setShowCreateModal(false);
    data.fetchSessions();
    data.fetchAgents();
  }, [data.fetchSessions, data.fetchAgents, modals.setShowCreateModal]);

  return {
    agents: data.agents,
    sessions: data.sessions,
    loadingAgents: data.loadingAgents,
    loadingSessions: data.loadingSessions,
    error: data.error,
    selectedAgent: modals.selectedAgent,
    filteredAgents,
    filteredSessions,
    showCreateModal: modals.showCreateModal,
    sessionToKill: modals.sessionToKill,
    searchQuery: filters.searchQuery,
    statusFilter: filters.statusFilter,
    sortField: filters.sortField,
    sortDirection: filters.sortDirection,
    isSearchActive: filters.isSearchActive,
    setSearchQuery: filters.setSearchQuery,
    setStatusFilter: filters.setStatusFilter,
    setSelectedAgent: modals.setSelectedAgent,
    toggleSort: filters.toggleSort,
    setShowCreateModal: modals.setShowCreateModal,
    setSessionToKill: modals.setSessionToKill,
    handleSessionKilled,
    handleSessionCreated,
    fetchSessions: data.fetchSessions,
    getHeartbeatHistory: data.getHeartbeatHistory,
    updateAgent: data.updateAgent,
    clearError: () => data.setError(null),
  };
}
```

### Dashboard.tsx Change

Replace `useDashboardHandlers` import with `useDashboard`. The return type `DashboardState` remains the same, so no other changes needed in Dashboard.tsx.

```typescript
// Before
import { useDashboardHandlers } from './useDashboardHandlers';
const state = useDashboardHandlers();

// After
import { useDashboard } from '../hooks/useDashboard';
const state = useDashboard();
```

## Part 4: Generic Async Hooks

### useAsyncOperation

Manages loading/error/data state for async operations, with optional toast notifications.

```typescript
// hooks/useAsyncOperation.ts

interface UseAsyncOperationOptions<T> {
  /** Toast message on success (omit to skip toast) */
  successMessage?: string | ((data: T) => string);
  /** Show toast on error, default true */
  showToastOnError?: boolean;
  /** Custom error message (overrides the error's message) */
  errorMessage?: string | ((err: Error) => string);
}

interface UseAsyncOperationResult<TArgs extends any[], TResult> {
  execute: (...args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: string | null;
  data: TResult | null;
  reset: () => void;
}

export function useAsyncOperation<TArgs extends any[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncOperationOptions<TResult> = {},
): UseAsyncOperationResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TResult | null>(null);
  const operationRef = useRef(operation);
  operationRef.current = operation;

  const execute = useCallback(async (...args: TArgs) => {
    setLoading(true);
    setError(null);
    try {
      const result = await operationRef.current(...args);
      setData(result);
      const msg = options.successMessage;
      if (msg) {
        toast.success(typeof msg === 'function' ? msg(result) : msg);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed';
      const displayMessage = options.errorMessage
        ? (typeof options.errorMessage === 'function'
            ? options.errorMessage(err as Error)
            : options.errorMessage)
        : message;
      setError(displayMessage);
      if (options.showToastOnError !== false) {
        toast.error(displayMessage);
      }
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [options]);

  const reset = useCallback(() => {
    setError(null);
    setData(null);
  }, []);

  return { execute, loading, error, data, reset };
}
```

### useDataFetch

Wraps async data fetching with loading/error state and auto-fetch on mount.

```typescript
// hooks/useDataFetch.ts

interface UseDataFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useDataFetch<T>(
  fetcher: () => Promise<T>,
  deps: any[] = [],
): UseDataFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      setData(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fetch failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
```

### Refactoring Existing Hooks

**useEnvManager** (before):
```typescript
export function useEnvManager() {
  const wsService = useWebSocket();
  const [files, setFiles] = useState<EnvFileInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await wsService.listEnvFiles();
      setFiles(resp.files);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to list env files');
    } finally {
      setLoading(false);
    }
  }, [wsService]);

  useEffect(() => { void refresh(); }, [refresh]);
  // ... deleteFile, uploadFile with similar patterns
}
```

**useEnvManager** (after):
```typescript
export function useEnvManager() {
  const wsService = useWebSocket();

  const listOp = useDataFetch(
    () => wsService.listEnvFiles().then(r => r.files),
    [wsService],
  );

  const deleteOp = useAsyncOperation(
    (file: EnvFileInfo) => wsService.deleteEnvFile(toRef(file)),
    {
      successMessage: () => 'File deleted',
    },
  );

  const uploadOp = useAsyncOperation(
    async (file: File) => {
      const content = await file.text();
      const name = file.name.endsWith('.env') ? file.name : `${file.name}.env`;
      let resp = await wsService.writeEnvFile({ name, source: 'server' }, content, false);
      if (!resp.success && resp.exists) {
        if (!window.confirm('File already exists. Overwrite?')) return;
        resp = await wsService.writeEnvFile({ name, source: 'server' }, content, true);
      }
      return resp;
    },
    {
      successMessage: () => 'File uploaded',
    },
  );

  return {
    files: listOp.data ?? [],
    loading: listOp.loading,
    refresh: listOp.refetch,
    deleteFile: deleteOp.execute,
    uploadFile: uploadOp.execute,
  };
}
```

## Part 5: Type Organization

### Current State

All 221 lines of type definitions live in a single `types.ts`.

### Target State

Core types stay in `types.ts`, domain types move to their modules:

```
types.ts                                    # Core types (~100 lines)
components/env/types.ts                     # Env domain types (~60 lines)
components/quickCommands/types.ts           # QuickCommand types (~30 lines)
terminal/types.ts                           # Terminal types (already exists)
```

### Type Migration

**Move to `components/env/types.ts`:**
- `EnvSource`
- `EnvFileInfo`
- `EnvFileRef`
- `EnvListResponse`
- `EnvGetResponse`
- `EnvWriteResponse`
- `EnvDeleteResponse`
- `ActiveEnvFile`
- `SessionEnvActiveResponse`
- `SessionEnvResponse`
- `SessionEnvQueryResponse`

**Move to `components/quickCommands/types.ts`:**
- `QuickCommandItem`
- `CommandsListResponse`
- `CommandsAddResponse`
- `CommandsRemoveResponse`
- `CommandsUpdateResponse`

**Keep in `types.ts`:**
- `Agent`, `Session`
- `NetworkType`, `AddressStatus`, `ProbedAddress`, `AddressLatency`
- `AttachInfo`, `AttachMode`
- `WebSocketMessage`, `ConnectionStatus`
- `AuthResponse`, `AgentsListResponse`, `SessionsListResponse`
- `CreateSessionResponse`, `KillSessionResponse`
- `ServerInfo`

### Backward Compatibility

`types.ts` re-exports all domain types:

```typescript
// types.ts

// Core types defined here
export interface Agent { /* ... */ }
// ...

// Re-export domain types for backward compatibility
export type {
  EnvSource, EnvFileInfo, EnvFileRef,
  EnvListResponse, EnvGetResponse, EnvWriteResponse, EnvDeleteResponse,
  ActiveEnvFile, SessionEnvActiveResponse, SessionEnvResponse, SessionEnvQueryResponse,
} from './components/env/types';

export type {
  QuickCommandItem,
  CommandsListResponse, CommandsAddResponse,
  CommandsRemoveResponse, CommandsUpdateResponse,
} from './components/quickCommands/types';
```

## Part 6: CLAUDE.md Updates

Add these conventions to the CLAUDE.md directory structure section:

```markdown
### Frontend Conventions

- **hooks/**: All custom hooks. Never place hooks in `components/`.
- **components/**: UI components only. If a file starts with `use`, it belongs in `hooks/`.
- **services/websocket/plugins/**: WebSocket functionality is plugin-based. New capabilities go in a plugin, not in the core.
- **Type organization**: Core types in `types.ts`, domain types in `{domain}/types.ts`. Re-export domain types from `types.ts` for backward compatibility.
```

## Implementation Order

1. **Phase 1: Hook Organization** (1-2 days) — pure file moves, lowest risk
2. **Phase 2: WebSocketService Modularization** (2-3 days) — largest change, facade + plugins
3. **Phase 3: Dashboard Hook Decomposition** (1-2 days) — split into 3 hooks + composite
4. **Phase 4: Type Organization** (1 day) — pure reorganization, re-exports
5. **Phase 5: Reusable Async Hooks** (1-2 days) — new hooks + refactor existing
6. **Phase 6: Final Review** (1 day) — docs, lint, tests, PR

## Verification

Each phase must pass:
- `npm run build` — TypeScript compilation
- `npm run lint` — ESLint with `--max-warnings 0`
- `npm test` — all existing tests pass
- `npm run coverage` — ≥ 80% coverage maintained
- No new `eslint-disable` comments

## Risk Mitigation

| Phase | Risk | Mitigation |
|-------|------|------------|
| 1 | Import paths broken | `tsc --noEmit` catches all; run after every move |
| 2 | API compatibility broken | Facade pattern preserves all public methods; existing tests verify |
| 3 | Re-render regression | Profile with React DevTools; sub-hooks use `useMemo`/`useCallback` |
| 4 | Import errors | Re-exports in `types.ts` maintain backward compatibility |
| 5 | Abstraction doesn't fit | Generic hooks provide callbacks for customization |
