# WebUI Architecture Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize WebUI architecture for maintainability, testability, and developer experience.

**Architecture:** Incremental refactoring across 6 phases — hook organization, WebSocketService plugin architecture, Dashboard hook decomposition, type organization, reusable async hooks, and documentation updates. Each phase is independently verifiable.

**Tech Stack:** React 18, TypeScript 5.3, Vite 5, Vitest, ESLint, Tailwind CSS v4

---

## File Structure

### Phase 1: Hook Organization

**Move (no new files):**
- `web/src/components/useDashboardHandlers.ts` → `web/src/hooks/useDashboardHandlers.ts`
- `web/src/components/useAttachFlow.ts` → `web/src/hooks/useAttachFlow.ts`
- `web/src/components/useQuickCommands.ts` → `web/src/hooks/useQuickCommands.ts`
- `web/src/components/useAgentRename.ts` → `web/src/hooks/useAgentRename.ts`

**Modify (import path updates):**
- `web/src/components/Dashboard.tsx` (useDashboardHandlers import)
- `web/src/components/AgentCard.tsx` (useAgentRename import)
- `web/src/components/QuickCommandsPanel.tsx` (useQuickCommands import)
- `web/src/components/TerminalToolbar.tsx` (useQuickCommands import)
- `web/src/components/FileTabs.tsx` (useQuickCommands import)
- Test files (path updates)

### Phase 2: WebSocketService Modularization

**Create:**
- `web/src/services/websocket/types.ts` — Plugin interfaces
- `web/src/services/websocket/core.ts` — WebSocketServiceCoreImpl
- `web/src/services/websocket/plugins/EventPlugin.ts` — Event subscriptions
- `web/src/services/websocket/plugins/RequestPlugin.ts` — Request/response
- `web/src/services/websocket/plugins/TerminalPlugin.ts` — Terminal I/O
- `web/src/services/websocket/WebSocketService.ts` — Facade

**Modify:**
- `web/src/services/websocket.ts` → Delete, replaced by directory structure

**Update imports:**
- `web/src/App.tsx`
- `web/src/hooks/useWebSocket.ts`
- All components importing WebSocketService

### Phase 3: Dashboard Hook Decomposition

**Create:**
- `web/src/hooks/useDashboardData.ts`
- `web/src/hooks/useDashboardFilters.ts`
- `web/src/hooks/useDashboardModals.ts`
- `web/src/hooks/useDashboard.ts` — Composite hook

**Modify:**
- `web/src/components/Dashboard.tsx` — Use new useDashboard hook

**Delete:**
- `web/src/hooks/useDashboardHandlers.ts` (replaced by useDashboard.ts)

### Phase 4: Type Organization

**Create:**
- `web/src/components/env/types.ts` — Env domain types
- `web/src/components/quickCommands/types.ts` — QuickCommand types

**Modify:**
- `web/src/types.ts` — Remove domain types, add re-exports

### Phase 5: Reusable Async Hooks

**Create:**
- `web/src/hooks/useAsyncOperation.ts`
- `web/src/hooks/useDataFetch.ts`

**Modify:**
- `web/src/components/env/useEnvManager.ts` — Refactor to use useAsyncOperation
- `web/src/hooks/useAgentData.ts` — Refactor to use useDataFetch
- `web/src/hooks/useSessionData.ts` — Refactor to use useDataFetch

### Phase 6: Documentation

**Modify:**
- `CLAUDE.md` — Add frontend conventions section

---

## Phase 1: Hook Organization

### Task 1.1: Move useDashboardHandlers

**Files:**
- Move: `web/src/components/useDashboardHandlers.ts` → `web/src/hooks/useDashboardHandlers.ts`
- Modify: `web/src/components/Dashboard.tsx` (import path)

- [ ] **Step 1: Move the file**

Run:
```bash
cd /Users/admin/Documents/learn/nession
mv web/src/components/useDashboardHandlers.ts web/src/hooks/useDashboardHandlers.ts
```

- [ ] **Step 2: Update import in Dashboard.tsx**

Open `web/src/components/Dashboard.tsx`, change:
```typescript
import { useDashboardHandlers } from './useDashboardHandlers';
```
To:
```typescript
import { useDashboardHandlers } from '../hooks/useDashboardHandlers';
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: Build succeeds

- [ ] **Step 4: Run tests**

Run:
```bash
cd web && npm test
```
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move useDashboardHandlers to hooks/"
```

### Task 1.2: Move useAttachFlow

**Files:**
- Move: `web/src/components/useAttachFlow.ts` → `web/src/hooks/useAttachFlow.ts`
- Modify: `web/src/components/Dashboard.tsx` (import path)

- [ ] **Step 1: Move the file**

Run:
```bash
mv web/src/components/useAttachFlow.ts web/src/hooks/useAttachFlow.ts
```

- [ ] **Step 2: Update import in Dashboard.tsx**

Open `web/src/components/Dashboard.tsx`, change:
```typescript
import { useAttachFlow } from './useAttachFlow';
```
To:
```typescript
import { useAttachFlow } from '../hooks/useAttachFlow';
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move useAttachFlow to hooks/"
```

### Task 1.3: Move useQuickCommands

**Files:**
- Move: `web/src/components/useQuickCommands.ts` → `web/src/hooks/useQuickCommands.ts`
- Modify: `web/src/components/QuickCommandsPanel.tsx`, `web/src/components/TerminalToolbar.tsx`, `web/src/components/FileTabs.tsx`

- [ ] **Step 1: Move the file**

Run:
```bash
mv web/src/components/useQuickCommands.ts web/src/hooks/useQuickCommands.ts
```

- [ ] **Step 2: Update imports in consuming components**

In `web/src/components/QuickCommandsPanel.tsx`, change:
```typescript
import { useQuickCommands } from './useQuickCommands';
```
To:
```typescript
import { useQuickCommands } from '../hooks/useQuickCommands';
```

In `web/src/components/TerminalToolbar.tsx`, change:
```typescript
import { useQuickCommands } from './useQuickCommands';
```
To:
```typescript
import { useQuickCommands } from '../hooks/useQuickCommands';
```

In `web/src/components/FileTabs.tsx`, change:
```typescript
import { useQuickCommands } from './useQuickCommands';
```
To:
```typescript
import { useQuickCommands } from '../hooks/useQuickCommands';
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move useQuickCommands to hooks/"
```

### Task 1.4: Move useAgentRename

**Files:**
- Move: `web/src/components/useAgentRename.ts` → `web/src/hooks/useAgentRename.ts`
- Modify: `web/src/components/AgentCard.tsx`

- [ ] **Step 1: Move the file**

Run:
```bash
mv web/src/components/useAgentRename.ts web/src/hooks/useAgentRename.ts
```

- [ ] **Step 2: Update import in AgentCard.tsx**

Open `web/src/components/AgentCard.tsx`, change:
```typescript
import { useAgentRename } from './useAgentRename';
```
To:
```typescript
import { useAgentRename } from '../hooks/useAgentRename';
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move useAgentRename to hooks/"
```

### Task 1.5: Final Phase 1 Verification

- [ ] **Step 1: Run full quality checks**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

Expected:
- Build succeeds
- ESLint passes with 0 warnings
- All tests pass
- Coverage ≥ 80%

- [ ] **Step 2: Verify no hooks remain in components/**

Run:
```bash
ls web/src/components/use*.ts web/src/components/use*.tsx 2>/dev/null | grep -v node_modules
```

Expected: No output (all hooks moved)

---

## Phase 2: WebSocketService Modularization

### Task 2.1: Create WebSocket Plugin Types

**Files:**
- Create: `web/src/services/websocket/types.ts`

- [ ] **Step 1: Create types.ts**

Create `web/src/services/websocket/types.ts`:
```typescript
import type { WebSocketMessage, ConnectionStatus } from '../../types';

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

- [ ] **Step 2: Commit**

```bash
git add web/src/services/websocket/types.ts
git commit -m "feat: add WebSocket plugin type definitions"
```

### Task 2.2: Create WebSocketServiceCoreImpl

**Files:**
- Create: `web/src/services/websocket/core.ts`

- [ ] **Step 1: Create core.ts**

Create `web/src/services/websocket/core.ts` with the core WebSocket connection management logic extracted from the current `services/websocket.ts`. This includes:
- WebSocket connection lifecycle (connect, disconnect, reconnect)
- Authentication handshake
- Message routing (dispatching to plugins via `onMessage` handlers)
- Request/response correlation (pending request map, timeout)
- Connection state management

The implementation should match the current WebSocketService logic but expose the `WebSocketServiceCore` interface instead of the full WebSocketService API.

[Note: This is a large file. Extract the connection management, authentication, message handling, and request correlation logic from the current `services/websocket.ts` into this file. The core should NOT include event subscription methods (agents/sessions/commands changed) or terminal I/O methods — those go into plugins.]

- [ ] **Step 2: Verify TypeScript compilation**

Run:
```bash
cd web && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/src/services/websocket/core.ts
git commit -m "feat: extract WebSocketServiceCoreImpl"
```

### Task 2.3: Create EventPlugin

**Files:**
- Create: `web/src/services/websocket/plugins/EventPlugin.ts`

- [ ] **Step 1: Create EventPlugin.ts**

Create `web/src/services/websocket/plugins/EventPlugin.ts`:
```typescript
import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type { Agent, Session } from '../../types';

type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type CommandsChangeCallback = () => void;
type TerminalOutputCallback = (data: string) => void;
type TerminalResizeCallback = (cols: number, rows: number) => void;

export class EventPlugin implements WebSocketPlugin {
  name = 'events';

  private agentsChangeCallbacks: AgentsChangeCallback[] = [];
  private sessionsChangeCallbacks: SessionsChangeCallback[] = [];
  private commandsChangeCallbacks: CommandsChangeCallback[] = [];
  private terminalOutputCallbacks = new Map<string, TerminalOutputCallback[]>();
  private terminalResizeCallbacks = new Map<string, TerminalResizeCallback[]>();
  private core!: WebSocketServiceCore;

  install(core: WebSocketServiceCore) {
    this.core = core;

    core.onMessage('client.agents.list.response', (payload) => {
      if (payload.agents) {
        this.notifyAgentsChange(payload.agents as Agent[]);
      }
    });

    core.onMessage('client.sessions.list.response', (payload) => {
      if (payload.sessions) {
        this.notifySessionsChange(payload.sessions as Session[]);
      }
    });

    core.onMessage('terminal.output', (payload) => {
      this.handleTerminalOutput(payload);
    });

    core.onMessage('terminal.resize', (payload) => {
      this.handleTerminalResize(payload);
    });

    core.onMessage('agents.changed', (payload) => {
      if (payload.agents) {
        this.notifyAgentsChange(payload.agents as Agent[]);
      }
    });

    core.onMessage('sessions.changed', (payload) => {
      if (payload.sessions) {
        this.notifySessionsChange(payload.sessions as Session[]);
      }
    });

    core.onMessage('server.commands.changed', () => {
      this.notifyCommandsChange();
    });
  }

  onAgentsChanged(callback: AgentsChangeCallback): () => void {
    this.agentsChangeCallbacks.push(callback);
    return () => {
      const index = this.agentsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.agentsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onSessionsChanged(callback: SessionsChangeCallback): () => void {
    this.sessionsChangeCallbacks.push(callback);
    return () => {
      const index = this.sessionsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.sessionsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onCommandsChanged(callback: CommandsChangeCallback): () => void {
    this.commandsChangeCallbacks.push(callback);
    return () => {
      const index = this.commandsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.commandsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onTerminalOutput(sessionId: string, callback: TerminalOutputCallback): () => void {
    if (!this.terminalOutputCallbacks.has(sessionId)) {
      this.terminalOutputCallbacks.set(sessionId, []);
    }
    this.terminalOutputCallbacks.get(sessionId)!.push(callback);

    return () => {
      const callbacks = this.terminalOutputCallbacks.get(sessionId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          this.terminalOutputCallbacks.delete(sessionId);
        }
      }
    };
  }

  onTerminalResize(sessionId: string, callback: TerminalResizeCallback): () => void {
    if (!this.terminalResizeCallbacks.has(sessionId)) {
      this.terminalResizeCallbacks.set(sessionId, []);
    }
    this.terminalResizeCallbacks.get(sessionId)!.push(callback);

    return () => {
      const callbacks = this.terminalResizeCallbacks.get(sessionId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          this.terminalResizeCallbacks.delete(sessionId);
        }
      }
    };
  }

  private notifyAgentsChange(agents: Agent[]): void {
    this.agentsChangeCallbacks.forEach((callback) => callback(agents));
  }

  private notifySessionsChange(sessions: Session[]): void {
    this.sessionsChangeCallbacks.forEach((callback) => callback(sessions));
  }

  private notifyCommandsChange(): void {
    this.commandsChangeCallbacks.forEach((callback) => callback());
  }

  private handleTerminalOutput(payload: Record<string, unknown>): void {
    const sessionId = (payload.session_name ?? payload.session_id) as string;
    const rawData = (payload.data ?? '') as string;

    const isRelay = typeof payload.session_name === 'string' && typeof payload.session_id !== 'string';
    let data: string;
    if (isRelay && rawData) {
      try {
        const binary = atob(rawData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
        data = new TextDecoder().decode(bytes);
      } catch {
        data = rawData;
      }
    } else {
      data = rawData;
    }

    const callbacks = this.terminalOutputCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  private handleTerminalResize(payload: Record<string, unknown>): void {
    const sessionId = (payload.session_name ?? payload.session_id) as string;
    const cols = payload.cols as number;
    const rows = payload.rows as number;

    const callbacks = this.terminalResizeCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(cols, rows));
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/services/websocket/plugins/EventPlugin.ts
git commit -m "feat: add EventPlugin for WebSocket event subscriptions"
```

### Task 2.4: Create RequestPlugin

**Files:**
- Create: `web/src/services/websocket/plugins/RequestPlugin.ts`

- [ ] **Step 1: Create RequestPlugin.ts**

Create `web/src/services/websocket/plugins/RequestPlugin.ts` with all the request/response methods extracted from the current WebSocketService:
- `authenticate()`
- `listAgents()`
- `serverInfo()`
- `listSessions()`
- `requestAttach()`
- `createSession()`
- `killSession()`
- `renameAgent()`
- All env CRUD methods
- All quick command methods

Each method should call `this.core.request<T>(type, payload)` with the appropriate message type and payload.

[Note: This is a large file. Extract all request/response methods from the current `services/websocket.ts` into this file. The plugin should hold a reference to `WebSocketServiceCore` and delegate request sending to it.]

- [ ] **Step 2: Commit**

```bash
git add web/src/services/websocket/plugins/RequestPlugin.ts
git commit -m "feat: add RequestPlugin for WebSocket request/response"
```

### Task 2.5: Create TerminalPlugin

**Files:**
- Create: `web/src/services/websocket/plugins/TerminalPlugin.ts`

- [ ] **Step 1: Create TerminalPlugin.ts**

Create `web/src/services/websocket/plugins/TerminalPlugin.ts`:
```typescript
import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type { WebSocketMessage, AttachInfo } from '../../types';

export class TerminalPlugin implements WebSocketPlugin {
  name = 'terminal';

  private core!: WebSocketServiceCore;
  private messageId = 0;

  install(core: WebSocketServiceCore) {
    this.core = core;
  }

  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void {
    const payload: Record<string, unknown> = { session_id: sessionId };
    if (relayUrl) { payload.relay_url = relayUrl; }
    if (cols !== undefined) { payload.cols = cols; }
    if (rows !== undefined) { payload.rows = rows; }

    this.sendRaw('client.session.relay.begin', payload);
  }

  endRelay(sessionId: string): void {
    this.sendRaw('client.session.relay.end', { session_id: sessionId });
  }

  sendTerminalInput(sessionId: string, data: string): void {
    this.sendRaw('terminal.input', { session_id: sessionId, data });
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.sendRaw('terminal.resize', { session_id: sessionId, cols, rows });
  }

  sendRelayInput(sessionName: string, data: string): void {
    const encoded = this.encodeBase64(data);
    this.sendRaw('terminal.input', { session_name: sessionName, data: encoded });
  }

  sendRelayResize(sessionName: string, cols: number, rows: number): void {
    this.sendRaw('terminal.resize', { session_name: sessionName, cols, rows });
  }

  private sendRaw(type: string, payload: Record<string, unknown>): void {
    const message: WebSocketMessage = {
      msg_type: type,
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload,
    };
    this.core.send(message);
  }

  private encodeBase64(data: string): string {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private generateMessageId(): string {
    this.messageId++;
    const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `msg_${this.messageId}_${rnd}`;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/services/websocket/plugins/TerminalPlugin.ts
git commit -m "feat: add TerminalPlugin for WebSocket terminal I/O"
```

### Task 2.6: Create WebSocketService Facade

**Files:**
- Create: `web/src/services/websocket/WebSocketService.ts`

- [ ] **Step 1: Create WebSocketService.ts**

Create `web/src/services/websocket/WebSocketService.ts` as the facade that:
1. Creates `WebSocketServiceCoreImpl` in constructor
2. Installs `EventPlugin`, `RequestPlugin`, `TerminalPlugin`
3. Exposes all public methods by delegating to plugins
4. Maintains backward compatibility with the current `services/websocket.ts` API

The facade should have all the same public methods as the current WebSocketService:
- Connection: `connect()`, `disconnect()`, `isConnected()`, `isauthenticated()`, `getConnectionStatus()`, `onConnectionChange()`
- Events: `onAgentsChanged()`, `onSessionsChanged()`, `onCommandsChanged()`, `onTerminalOutput()`, `onTerminalResize()`
- Requests: All methods from RequestPlugin
- Terminal: All methods from TerminalPlugin

[Note: This is the integration point. The facade should be ~300-400 lines, delegating to plugins while maintaining the exact same API as the current WebSocketService.]

- [ ] **Step 2: Create index.ts for websocket module**

Create `web/src/services/websocket/index.ts`:
```typescript
export { WebSocketService } from './WebSocketService';
export type { WebSocketPlugin, WebSocketServiceCore } from './types';
```

- [ ] **Step 3: Update imports in App.tsx**

Open `web/src/App.tsx`, change:
```typescript
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
```
To:
```typescript
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
```

(The import path stays the same because we'll create a barrel export in the next step.)

- [ ] **Step 4: Create barrel export**

Create `web/src/services/websocket.ts`:
```typescript
// Re-export from websocket module for backward compatibility
export { WebSocketService } from './websocket/WebSocketService';
export type { WebSocketPlugin, WebSocketServiceCore } from './websocket/types';

// Singleton management
import { WebSocketService } from './websocket/WebSocketService';

let wsServiceInstance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService | null {
  return wsServiceInstance;
}

export function createWebSocketService(url: string, authToken: string): WebSocketService {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
  }

  wsServiceInstance = new WebSocketService(url, authToken);
  return wsServiceInstance;
}

export function destroyWebSocketService(): void {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
    wsServiceInstance = null;
  }
}
```

- [ ] **Step 5: Verify build**

Run:
```bash
cd web && npm run build
```

Expected: Build succeeds

- [ ] **Step 6: Run tests**

Run:
```bash
cd web && npm test
```

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: modularize WebSocketService with plugin architecture"
```

### Task 2.7: Final Phase 2 Verification

- [ ] **Step 1: Run full quality checks**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

- [ ] **Step 2: Verify WebSocketService size**

Run:
```bash
wc -l web/src/services/websocket/WebSocketService.ts
```

Expected: ≤ 500 lines

- [ ] **Step 3: Verify public API unchanged**

Check that all existing methods are still present on WebSocketService:
- `connect()`, `disconnect()`, `isConnected()`, `isauthenticated()`, `getConnectionStatus()`
- `onConnectionChange()`, `onAgentsChanged()`, `onSessionsChanged()`, `onCommandsChanged()`
- `onTerminalOutput()`, `onTerminalResize()`
- `authenticate()`, `listAgents()`, `serverInfo()`, `listSessions()`, `requestAttach()`
- `createSession()`, `killSession()`, `renameAgent()`
- `sendTerminalInput()`, `sendTerminalResize()`, `sendRelayInput()`, `sendRelayResize()`
- `beginRelay()`, `endRelay()`

---

## Phase 3: Dashboard Hook Decomposition

### Task 3.1: Create useDashboardData

**Files:**
- Create: `web/src/hooks/useDashboardData.ts`

- [ ] **Step 1: Create useDashboardData.ts**

Create `web/src/hooks/useDashboardData.ts` with:
- `agents`, `sessions` state
- `loadingAgents`, `loadingSessions` state
- `error` state
- `fetchAgents()`, `fetchSessions()` functions
- `updateAgent()`, `getHeartbeatHistory()` functions
- `heartbeatHistory` ref

This extracts the data management logic from the current `useDashboardHandlers.ts`.

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useDashboardData.ts
git commit -m "feat: add useDashboardData hook"
```

### Task 3.2: Create useDashboardFilters

**Files:**
- Create: `web/src/hooks/useDashboardFilters.ts`

- [ ] **Step 1: Create useDashboardFilters.ts**

Create `web/src/hooks/useDashboardFilters.ts` with:
- `searchQuery`, `setSearchQuery`
- `statusFilter`, `setStatusFilter`
- `sortField`, `sortDirection`, `toggleSort`
- `isSearchActive` derived state

This extracts the filter/sort logic from the current `useDashboardHandlers.ts`.

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useDashboardFilters.ts
git commit -m "feat: add useDashboardFilters hook"
```

### Task 3.3: Create useDashboardModals

**Files:**
- Create: `web/src/hooks/useDashboardModals.ts`

- [ ] **Step 1: Create useDashboardModals.ts**

Create `web/src/hooks/useDashboardModals.ts` with:
- `selectedAgent`, `setSelectedAgent`
- `showCreateModal`, `setShowCreateModal`
- `sessionToKill`, `setSessionToKill`

This extracts the modal state from the current `useDashboardHandlers.ts`.

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useDashboardModals.ts
git commit -m "feat: add useDashboardModals hook"
```

### Task 3.4: Create useDashboard Composite Hook

**Files:**
- Create: `web/src/hooks/useDashboard.ts`
- Delete: `web/src/hooks/useDashboardHandlers.ts`

- [ ] **Step 1: Create useDashboard.ts**

Create `web/src/hooks/useDashboard.ts` that:
1. Calls `useDashboardData`, `useDashboardFilters`, `useDashboardModals`
2. Calls `useRealtimeUpdates`
3. Computes `filteredAgents`, `filteredSessions` with `useMemo`
4. Creates `handleSessionKilled`, `handleSessionCreated` callbacks
5. Returns the same `DashboardState` shape as the current `useDashboardHandlers`

- [ ] **Step 2: Update Dashboard.tsx**

Open `web/src/components/Dashboard.tsx`, change:
```typescript
import { useDashboardHandlers } from '../hooks/useDashboardHandlers';
```
To:
```typescript
import { useDashboard } from '../hooks/useDashboard';
```

And change:
```typescript
const state = useDashboardHandlers();
```
To:
```typescript
const state = useDashboard();
```

- [ ] **Step 3: Delete old hook**

Run:
```bash
rm web/src/hooks/useDashboardHandlers.ts
```

- [ ] **Step 4: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 5: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: decompose useDashboardHandlers into useDashboard composite hook"
```

### Task 3.5: Final Phase 3 Verification

- [ ] **Step 1: Run full quality checks**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

- [ ] **Step 2: Verify each sub-hook is ≤ 80 lines**

Run:
```bash
wc -l web/src/hooks/useDashboardData.ts web/src/hooks/useDashboardFilters.ts web/src/hooks/useDashboardModals.ts
```

Expected: Each ≤ 80 lines

---

## Phase 4: Type Organization

### Task 4.1: Create Env Types

**Files:**
- Create: `web/src/components/env/types.ts`

- [ ] **Step 1: Create env/types.ts**

Create `web/src/components/env/types.ts` with all Env-related types moved from `types.ts`:
```typescript
export type EnvSource = 'server' | 'agent';

export interface EnvFileInfo {
  name: string;
  source: EnvSource;
  agent_id?: string;
  size: number;
  modified: number;
  var_count: number;
}

export interface EnvFileRef {
  name: string;
  source: EnvSource;
  agent_id?: string;
}

export interface EnvListResponse {
  files: EnvFileInfo[];
  error?: string;
}

export interface EnvGetResponse {
  success: boolean;
  content?: string;
  in_use_by?: string[];
  error?: string;
}

export interface EnvWriteResponse {
  success: boolean;
  exists?: boolean;
  error?: string;
  warnings?: string[];
}

export interface EnvDeleteResponse {
  success: boolean;
  error?: string;
}

export interface ActiveEnvFile {
  name: string;
  source: EnvSource;
  agent_id?: string;
  phase: string;
}

export interface SessionEnvActiveResponse {
  active: ActiveEnvFile[];
}

export interface SessionEnvResponse {
  success: boolean;
  error?: string;
  warnings?: string[];
}

export interface SessionEnvQueryResponse {
  sourced_files: EnvFileRef[];
  error?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/env/types.ts
git commit -m "feat: extract Env types to env/types.ts"
```

### Task 4.2: Create QuickCommand Types

**Files:**
- Create: `web/src/components/quickCommands/types.ts`

- [ ] **Step 1: Create quickCommands/types.ts**

Create `web/src/components/quickCommands/types.ts`:
```typescript
export interface QuickCommandItem {
  id: string;
  label: string;
  command: string;
  raw?: boolean;
  sort_order?: number;
  created_at?: number;
}

export interface CommandsListResponse {
  commands: QuickCommandItem[];
}

export interface CommandsAddResponse {
  success: boolean;
  id?: string;
  error?: string;
}

export interface CommandsRemoveResponse {
  success: boolean;
  error?: string;
}

export interface CommandsUpdateResponse {
  success: boolean;
  error?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/quickCommands/types.ts
git commit -m "feat: extract QuickCommand types to quickCommands/types.ts"
```

### Task 4.3: Update types.ts with Re-exports

**Files:**
- Modify: `web/src/types.ts`

- [ ] **Step 1: Remove domain types from types.ts**

Open `web/src/types.ts` and remove:
- All Env-related types (lines ~118-180)
- All QuickCommand types (lines ~182-210)

- [ ] **Step 2: Add re-exports to types.ts**

Add to the end of `web/src/types.ts`:
```typescript
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

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```

Expected: Build succeeds (all existing imports still work via re-exports)

- [ ] **Step 4: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: organize types by domain with re-exports"
```

### Task 4.4: Final Phase 4 Verification

- [ ] **Step 1: Run full quality checks**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

- [ ] **Step 2: Verify types.ts size**

Run:
```bash
wc -l web/src/types.ts
```

Expected: ≤ 150 lines

---

## Phase 5: Reusable Async Hooks

### Task 5.1: Create useAsyncOperation

**Files:**
- Create: `web/src/hooks/useAsyncOperation.ts`

- [ ] **Step 1: Create useAsyncOperation.ts**

Create `web/src/hooks/useAsyncOperation.ts` with the generic async operation hook as defined in the design spec.

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useAsyncOperation.ts
git commit -m "feat: add useAsyncOperation generic hook"
```

### Task 5.2: Create useDataFetch

**Files:**
- Create: `web/src/hooks/useDataFetch.ts`

- [ ] **Step 1: Create useDataFetch.ts**

Create `web/src/hooks/useDataFetch.ts` with the generic data fetching hook as defined in the design spec.

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useDataFetch.ts
git commit -m "feat: add useDataFetch generic hook"
```

### Task 5.3: Refactor useEnvManager

**Files:**
- Modify: `web/src/components/env/useEnvManager.ts`

- [ ] **Step 1: Refactor useEnvManager to use useAsyncOperation**

Refactor `useEnvManager` to use `useAsyncOperation` for delete and upload operations, and `useDataFetch` for the list operation, as shown in the design spec.

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: useEnvManager uses useAsyncOperation"
```

### Task 5.4: Refactor useAgentData

**Files:**
- Modify: `web/src/hooks/useAgentData.ts`

- [ ] **Step 1: Refactor useAgentData to use useDataFetch**

Refactor `useAgentData` to use `useDataFetch` for the fetchAgents operation.

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: useAgentData uses useDataFetch"
```

### Task 5.5: Refactor useSessionData

**Files:**
- Modify: `web/src/hooks/useSessionData.ts`

- [ ] **Step 1: Refactor useSessionData to use useDataFetch**

Refactor `useSessionData` to use `useDataFetch` for the fetchSessions operation.

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd web && npm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: useSessionData uses useDataFetch"
```

### Task 5.6: Final Phase 5 Verification

- [ ] **Step 1: Run full quality checks**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

- [ ] **Step 2: Verify code duplication reduced**

Check that the refactored hooks are shorter and use the generic hooks.

---

## Phase 6: Documentation

### Task 6.1: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Frontend Conventions section to CLAUDE.md**

Add to the "1. Project Structure" section, after the architecture flow:

```markdown
### Frontend Conventions

- **hooks/**: All custom hooks. Never place hooks in `components/`.
- **components/**: UI components only. If a file starts with `use`, it belongs in `hooks/`.
- **services/websocket/plugins/**: WebSocket functionality is plugin-based. New capabilities go in a plugin, not in the core.
- **Type organization**: Core types in `types.ts`, domain types in `{domain}/types.ts`. Re-export domain types from `types.ts` for backward compatibility.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add frontend conventions to CLAUDE.md"
```

### Task 6.2: Final Review

- [ ] **Step 1: Run all quality gates**

Run:
```bash
cd web
npm run build && npm run lint && npm test && npm run coverage
```

- [ ] **Step 2: Verify all phases completed**

Check that:
- All hooks are in `hooks/`
- WebSocketService is modularized
- Dashboard uses composite hook
- Types are organized by domain
- Generic async hooks are created
- CLAUDE.md is updated

- [ ] **Step 3: Create PR**

```bash
git push origin feat/webui-architecture-optimization
gh pr create --title "feat: WebUI architecture optimization" --body "..."
```

---

## Summary

This plan covers 6 phases across ~40 tasks. Each phase is independently verifiable and can be rolled back without affecting others. The total estimated effort is 7-11 days (1-2 weeks).

After completing all phases, the WebUI will have:
- Clear directory structure (all hooks in `hooks/`)
- Modular WebSocketService (plugin-based, ~500 lines)
- Decomposed Dashboard hooks (3 focused hooks + composite)
- Organized types (domain-based with re-exports)
- Reusable async hooks (useAsyncOperation, useDataFetch)
- Updated documentation (CLAUDE.md conventions)
