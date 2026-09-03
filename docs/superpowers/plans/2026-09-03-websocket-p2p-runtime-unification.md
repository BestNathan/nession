# WebSocket / P2P Runtime Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Server and Agent WebSocket runtime ownership under transport-neutral abstractions, decouple Terminal transport from React/Jotai, and let **session-first** and **legacy Dashboard** architectures share one `SessionRuntime` — without behavior regression on attach, relay fallback, files, or reconnect.

**Architecture:** Extract `SocketClient` + `MessageRouter` from `WebSocketServiceCoreImpl` and `useP2PConnection`. Introduce `SessionRuntimeRegistry` (app singleton) that owns per-session Agent connection, attach state machine, and capabilities (terminal transport, files). React hooks become thin adapters that subscribe to runtime events and mirror state into Jotai. Session-first is the **primary integration path**; legacy `TerminalWorkspace` wraps the same registry via compatibility adapters until Dashboard is retired.

**Base branch:** `origin/staging` (includes session-first shell, `useP2PAttachTransport`, `useSessionFirstTerminalAttach`, capsule fixes from #594).

**Requirement:** [#593](https://github.com/BestNathan/nession/issues/593)

**Tech Stack:** TypeScript 5.3, React 18, Jotai, Vitest, existing `WebSocketServiceCoreImpl`, xterm terminal stack unchanged.

---

## Staging Baseline (read before coding)

### Dual architecture coexistence (`App.tsx`)

| Path | Entry | P2P driver | Attach driver | File ops source |
|------|-------|------------|---------------|-----------------|
| **Session-first** (primary) | `SessionFirstShell` → `SessionFirstTerminal` | `useTerminalOrchestration` → `useP2PAttachTransport` → `useP2PConnection` | `useSessionFirstTerminalAttach` (transport-first: waits for `terminalTransportReadyAtom`) | `useSessionFirstShellState` reads `p2pConnectionAtom` |
| **Legacy** | `Dashboard` → `TerminalWorkspace` | `useP2PAttachTransport` → `useP2PConnection` | `useTerminalStateMachine` (mount-first attach) | `TerminalWorkspace` memo on `p2pConnection` methods |

Both paths already share `useP2PAttachTransport` for address rotation + relay fallback. **Problem:** `useP2PConnection` still owns `WebSocket`; attach logic is duplicated across two React hooks; `p2pConnectionAtom` / `p2pEpochAtom` are UI-level lifecycle primitives; terminal layer imports hook types and reads Jotai.

### Target dependency direction

```text
React (session-first + legacy adapters)
      ↓ subscribe / mirror
SessionRuntimeRegistry
      ↓
SessionRuntime (per sessionId)
  ├── AttachStateMachine (pure TS)
  ├── AgentSocketClient (SocketClient impl)
  ├── Terminal capability (ConnectionManager via factory)
  └── FileCapability (domain API on MessageRouter)
      ↓
SocketClient + MessageRouter
      ↓
WebSocket (browser)
```

**Forbidden after migration:** `terminal/**` → `hooks/useP2PConnection`, `ConnectionManager` → Jotai, `TerminalController` → `getDefaultStore().set`.

---

## File Structure

### Create

| File | Responsibility |
|------|----------------|
| `web/src/services/socket/types.ts` | `SocketMessage`, `ConnectionState`, `SocketClient`, `MessageRouter`, `RequestOptions` |
| `web/src/services/socket/MessageRouter.ts` | Type-keyed subscribe + request/response correlation + binary passthrough |
| `web/src/services/socket/SocketClientBase.ts` | Shared lifecycle: connect/disconnect/reconnect/backoff/generation guard/dispose |
| `web/src/services/socket/AgentSocketClient.ts` | P2P agent connection (extracted from `useP2PConnection`) |
| `web/src/services/socket/ServerSocketClient.ts` | Thin wrapper delegating to `WebSocketServiceCoreImpl` (compat shim) |
| `web/src/services/socket/index.ts` | Public exports |
| `web/src/services/socket/__tests__/unit/MessageRouter.test.ts` | Correlation, timeout, binary, concurrent handlers |
| `web/src/services/socket/__tests__/unit/AgentSocketClient.test.ts` | Reconnect, generation stale-event isolation, waitForConnection |
| `web/src/runtime/types.ts` | `SessionRuntime`, `AttachEvent`, `AttachStatus`, capability interfaces |
| `web/src/runtime/AttachStateMachine.ts` | Pure attach/reconnect state machine (unifies both attach drivers) |
| `web/src/runtime/AddressAttachPolicy.ts` | Address rotation + relay fallback (from `useP2PAttachTransport`) |
| `web/src/runtime/SessionRuntime.ts` | Per-session owner: agent client, attach SM, capabilities |
| `web/src/runtime/SessionRuntimeRegistry.ts` | `Map<sessionId, SessionRuntime>`, acquire/release/dispose |
| `web/src/runtime/FileCapability.ts` | Domain file API on top of `MessageRouter.request` |
| `web/src/runtime/__tests__/unit/AttachStateMachine.test.ts` | All transitions incl. transport-first reattach |
| `web/src/runtime/__tests__/unit/AddressAttachPolicy.test.ts` | Multi-candidate + relay fallback |
| `web/src/runtime/__tests__/unit/SessionRuntimeRegistry.test.ts` | StrictMode double-acquire, session switch, dispose |
| `web/src/hooks/useSessionRuntime.ts` | React adapter: acquire runtime, mirror attach/P2P state to Jotai |
| `web/src/hooks/useAgentConnectionAdapter.ts` | Deprecated-compat wrapper exposing old `P2PConnection` shape from runtime |
| `web/src/terminal/adapters/TerminalRuntimeAdapter.ts` | Maps controller events → Jotai atoms (replaces direct writes) |
| `web/src/terminal/adapters/TransportAttachGate.ts` | Explicit attach-phase callback for ConnectionManager (replaces Jotai read) |

### Modify

| File | Change |
|------|--------|
| `web/src/services/websocket/core.ts` | Delegate routing/correlation internals to shared `MessageRouter` (no public API break) |
| `web/src/hooks/useP2PConnection.ts` | Thin adapter over `SessionRuntime.agentClient` OR `AgentSocketClient` ref-counted instance |
| `web/src/hooks/useP2PAttachTransport.ts` | Delegate to `AddressAttachPolicy` + `SessionRuntimeRegistry` |
| `web/src/services/fileOps.ts` | Accept `MessageRouter` / `FileCapability`; delete `sendRequest` boilerplate |
| `web/src/session-first/terminal/useTerminalOrchestration.ts` | Acquire `SessionRuntime`; drop direct `useP2PAttachTransport` ownership |
| `web/src/session-first/terminal/useSessionFirstTerminalAttach.ts` | Thin adapter: subscribe `AttachStateMachine`, emit `TRANSPORT_READY` |
| `web/src/session-first/useSessionFirstShellState.ts` | `fileOps` from `SessionRuntime.getFileCapability()` not `p2pConnectionAtom` |
| `web/src/terminal/components/TerminalWorkspace.tsx` | Same `useSessionRuntime` + legacy attach adapter |
| `web/src/terminal/hooks/useTerminalStateMachine.ts` | Thin adapter over shared `AttachStateMachine` (legacy transport-first=false) |
| `web/src/terminal/ConnectionManager.ts` | Remove Jotai; accept `isAttached(): boolean` callback |
| `web/src/terminal/controller/TerminalController.ts` | Emit events via `TerminalRuntimeAdapter` |
| `web/src/terminal/transport/TerminalTransport.ts` | Import types from `services/socket/types` |
| `web/src/terminal/types.ts` | Import `AgentConnection` from socket types, not hook |
| `web/src/atoms/connection.ts` | Mark `p2pEpochAtom` deprecated; keep mirrored for compat during migration |
| `docs/design/interaction/web.md` | Document runtime ownership boundary (short section, link #593) |

### Do NOT touch (Non-Goals)

- xterm rendering, Catppuccin theme, capsule UI, PC/Mobile layout
- Rust backend wire protocol
- Dashboard removal (legacy path must keep working)

---

## Worktree Setup

All implementation happens off **`origin/staging`**, not `main`:

```bash
git fetch origin
git worktree add -b feat/websocket-p2p-runtime-unification \
  .claude/worktrees/feat-websocket-p2p-runtime-unification origin/staging
cd .claude/worktrees/feat-websocket-p2p-runtime-unification
```

PR targets **`staging`**. Each phase lands as one or more commits; run `cd web && npm run lint && npm test` after every task.

---

## Phase 1: Transport-Neutral Socket Layer

### Task 1: Socket types

**Files:**
- Create: `web/src/services/socket/types.ts`

- [ ] **Step 1: Add shared types**

```typescript
// web/src/services/socket/types.ts
export interface SocketMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface RequestOptions {
  timeoutMs?: number;
  /** When true, retry once after reconnect (explicit opt-in only). */
  retryOnReconnect?: boolean;
}

export interface MessageRouter {
  send(message: SocketMessage): void;
  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  dispose(): void;
}

export interface SocketClient extends MessageRouter {
  readonly connectionState: ConnectionState;
  connect(): void;
  disconnect(): void;
  close(): void;
  waitForConnection(timeoutMs?: number): Promise<void>;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/services/socket/types.ts web/src/services/socket/index.ts
git commit -m "feat: add transport-neutral socket types (#593)"
```

---

### Task 2: MessageRouter (pure TS)

**Files:**
- Create: `web/src/services/socket/MessageRouter.ts`
- Create: `web/src/services/socket/__tests__/unit/MessageRouter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/services/socket/__tests__/unit/MessageRouter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouterImpl } from '@/services/socket/MessageRouter';

describe('MessageRouterImpl', () => {
  let router: MessageRouterImpl;
  let sendFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendFn = vi.fn();
    router = new MessageRouterImpl({ send: sendFn, generateId: () => 'id-1' });
  });

  afterEach(() => router.dispose());

  it('correlates response by message id', async () => {
    const p = router.request<{ ok: boolean }>('file.list', { path: '/' });
    router.handleIncoming({ msg_type: 'file.list', id: 'id-1', timestamp: 0, payload: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const p = router.request('file.read', {}, { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow('Request timeout');
    vi.useRealTimers();
  });

  it('dispatches typed handlers without consuming correlated responses', async () => {
    const handler = vi.fn();
    router.subscribe('terminal.output', handler);
    router.handleIncoming({ msg_type: 'terminal.output', id: 'x', timestamp: 0, payload: 'data' });
    expect(handler).toHaveBeenCalledWith('data', expect.any(Object));
  });

  it('passes binary without JSON parse', () => {
    const binHandler = vi.fn();
    router.onBinary(binHandler);
    const buf = new ArrayBuffer(4);
    router.handleBinary(buf);
    expect(binHandler).toHaveBeenCalledWith(buf);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd web && npm test -- src/services/socket/__tests__/unit/MessageRouter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MessageRouterImpl**

```typescript
// web/src/services/socket/MessageRouter.ts
import type { MessageRouter, RequestOptions, SocketMessage } from './types';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MessageRouterDeps {
  send: (msg: SocketMessage) => void;
  generateId: () => string;
}

export class MessageRouterImpl implements MessageRouter {
  private readonly handlers = new Map<string, Set<(payload: unknown, raw: SocketMessage) => void>>();
  private readonly pending = new Map<string, Pending>();
  private binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private disposed = false;

  constructor(private readonly deps: MessageRouterDeps) {}

  send(message: SocketMessage): void {
    if (this.disposed) throw new Error('MessageRouter disposed');
    this.deps.send(message);
  }

  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(handler);
    return () => { set!.delete(handler); if (set!.size === 0) this.handlers.delete(type); };
  }

  request<T>(type: string, payload: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
    const id = this.deps.generateId();
    const msg: SocketMessage = { msg_type: type, id, timestamp: Date.now(), payload };
    const timeoutMs = options.timeoutMs ?? 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.deps.send(msg);
    });
  }

  handleIncoming(message: SocketMessage): void {
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.payload);
      return;
    }
    const set = this.handlers.get(message.msg_type);
    if (set) for (const h of set) h(message.payload, message);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  handleBinary(data: ArrayBuffer): void {
    for (const h of this.binaryHandlers) h(data);
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('MessageRouter disposed'));
    }
    this.pending.clear();
    this.handlers.clear();
    this.binaryHandlers.clear();
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd web && npm test -- src/services/socket/__tests__/unit/MessageRouter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add web/src/services/socket/MessageRouter.ts web/src/services/socket/__tests__/unit/MessageRouter.test.ts
git commit -m "feat: add MessageRouter with request correlation (#593)"
```

---

### Task 3: AgentSocketClient (extract P2P runtime)

**Files:**
- Create: `web/src/services/socket/SocketClientBase.ts`
- Create: `web/src/services/socket/AgentSocketClient.ts`
- Create: `web/src/services/socket/__tests__/unit/AgentSocketClient.test.ts`
- Reference: `web/src/hooks/useP2PConnection.ts` (staging: `useAgentWebSocket`, `connectWs`, generation guard)

- [ ] **Step 1: Write failing tests** — reconnect backoff, generation stale-event drop, `waitForConnection` event-driven (port cases from `useP2PConnection.test.ts` without React)

- [ ] **Step 2: Implement `AgentSocketClient`**

Key behaviors to preserve from staging `useP2PConnection`:
- `binaryType = 'arraybuffer'`; binary → `MessageRouter.handleBinary`
- JSON messages → `MessageRouter.handleIncoming`
- Generation counter on `(agentUrl, connectionToken)` change
- Exponential backoff capped at 30s; configurable max attempts
- `waitForConnection` rejects on terminal `disconnected`, resolves on `connected`
- `disconnect()` nulls all ws handlers before close (refs #71 #3)

```typescript
// web/src/services/socket/AgentSocketClient.ts (sketch — full impl ports connectWs)
export class AgentSocketClient implements SocketClient {
  private readonly router: MessageRouterImpl;
  private ws: WebSocket | null = null;
  private generation = 0;
  // ... reconnect timer, state listeners, waiters (same semantics as hook refs)

  constructor(private readonly config: AgentSocketConfig) {
    this.router = new MessageRouterImpl({
      send: (msg) => this.sendJson(msg),
      generateId: () => `agent-${Date.now()}-${++this.idCounter}`,
    });
  }

  // MessageRouter delegation
  send = this.router.send.bind(this.router);
  subscribe = this.router.subscribe.bind(this.router);
  request = this.router.request.bind(this.router);
}
```

- [ ] **Step 3: Run tests + commit**

```bash
cd web && npm test -- src/services/socket/__tests__/unit/AgentSocketClient.test.ts
git commit -m "feat: extract AgentSocketClient from P2P hook (#593)"
```

---

### Task 4: Wire ServerSocketClient shim

**Files:**
- Create: `web/src/services/socket/ServerSocketClient.ts`
- Modify: `web/src/services/websocket/core.ts` — optionally internalize `MessageRouterImpl` (keep public `WebSocketServiceCore` API stable)

- [ ] **Step 1: ServerSocketClient wraps existing core**

```typescript
export class ServerSocketClient implements SocketClient {
  constructor(private readonly core: WebSocketServiceCore) {}
  get connectionState(): ConnectionState { /* map ConnectionStatus → ConnectionState */ }
  connect(): void { void this.core.connect(); }
  // delegate send/subscribe/request to core methods
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd web && npm test -- src/services/websocket`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add ServerSocketClient compat shim (#593)"
```

---

## Phase 2: SessionRuntime Ownership (session-first first)

### Task 5: AttachStateMachine (pure TS, dual-mode)

**Files:**
- Create: `web/src/runtime/AttachStateMachine.ts`
- Create: `web/src/runtime/__tests__/unit/AttachStateMachine.test.ts`
- Reference: `useSessionFirstTerminalAttach.ts` + `useTerminalStateMachine.ts` on staging

- [ ] **Step 1: Define events + states**

```typescript
// web/src/runtime/types.ts
export type AttachPhase =
  | 'idle' | 'connecting' | 'connected' | 'attached'
  | 'reconnecting' | 'failed';

export type AttachEvent =
  | { type: 'SESSION_SELECTED' }
  | { type: 'TRANSPORT_CONNECTED' }
  | { type: 'TRANSPORT_READY' }       // session-first: xterm wired
  | { type: 'ATTACH_OK' }
  | { type: 'ATTACH_ERROR'; manualRoute: boolean }
  | { type: 'ATTACH_TIMEOUT'; manualRoute: boolean; attempt: number }
  | { type: 'TRANSPORT_LOST' }
  | { type: 'RELAY_BEGIN_OK' }
  | { type: 'DISCONNECT' };
```

- [ ] **Step 2: Implement reducer** — port logic from both attach hooks:
  - **Session-first mode:** `client.attach` only after `TRANSPORT_READY` (preserve #594 reliability invariant)
  - **Legacy mode:** `transportFirst: false` — attach on `TRANSPORT_CONNECTED` (current `useTerminalStateMachine` behavior)
  - P2P max reconnect → relay fallback (non-manual route)
  - Manual route → `failed` instead of relay fallback

- [ ] **Step 3: Tests for both modes** — include transport tear-down reattach (`needsTransportReattach` from session-first)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add pure AttachStateMachine with dual attach modes (#593)"
```

---

### Task 6: AddressAttachPolicy

**Files:**
- Create: `web/src/runtime/AddressAttachPolicy.ts`
- Create: `web/src/runtime/__tests__/unit/AddressAttachPolicy.test.ts`
- Reference: `web/src/hooks/useP2PAttachTransport.ts`

- [ ] **Step 1: Port address rotation + relay fallback as pure class**

```typescript
export class AddressAttachPolicy {
  constructor(private readonly config: AddressAttachPolicyConfig) {}

  /** Current candidate URL or null if relay forced / not ready */
  get activeUrl(): string | null { /* ... */ }

  /** Called when agent client reports disconnected after attempt started */
  onCandidateDisconnected(): 'next-candidate' | 'force-relay' | ' exhausted' { /* ... */ }

  resetOnPlanChange(urlsKey: string): void { /* ... */ }
}
```

- [ ] **Step 2: Port tests from `useP2PAttachTransport.test.tsx`** (without React mock)

- [ ] **Step 3: Commit**

---

### Task 7: SessionRuntime + Registry

**Files:**
- Create: `web/src/runtime/SessionRuntime.ts`
- Create: `web/src/runtime/SessionRuntimeRegistry.ts`
- Create: `web/src/runtime/FileCapability.ts`
- Create: `web/src/runtime/__tests__/unit/SessionRuntimeRegistry.test.ts`

- [ ] **Step 1: SessionRuntime skeleton**

```typescript
export class SessionRuntime {
  readonly sessionId: string;
  readonly attachState: AttachStateMachine;
  readonly agentClient: AgentSocketClient | null;
  readonly addressPolicy: AddressAttachPolicy;
  private fileCapability: FileCapability | null = null;

  constructor(opts: SessionRuntimeOptions) {
    this.attachState = new AttachStateMachine({ transportFirst: opts.transportFirst });
    // create AgentSocketClient when mode p2p; wire agentClient.onConnectionStateChange → attach SM
  }

  getFileCapability(): FileCapability | null {
    if (!this.agentClient) return null;
    return this.fileCapability ??= new FileCapability(this.agentClient);
  }

  dispose(): void {
    this.agentClient?.disconnect();
    this.agentClient?.dispose();
  }
}
```

- [ ] **Step 2: Registry with ref-counting**

```typescript
export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, { runtime: SessionRuntime; refs: number }>();

  acquire(sessionId: string, opts: SessionRuntimeOptions): SessionRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) { existing.refs++; return existing.runtime; }
    const runtime = new SessionRuntime(opts);
    this.runtimes.set(sessionId, { runtime, refs: 1 });
    return runtime;
  }

  release(sessionId: string): void {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.runtime.dispose();
      this.runtimes.delete(sessionId);
    }
  }
}

export const sessionRuntimeRegistry = new SessionRuntimeRegistry();
```

**StrictMode rule:** `acquire`/`release` called from adapter; double-mount increments refs to 2 — cleanup on first unmount must NOT dispose while second mount holds ref.

- [ ] **Step 3: FileCapability using router.request**

```typescript
export class FileCapability {
  constructor(private readonly client: MessageRouter) {}

  listDir(path: string) {
    return this.client.request<FileListResponse>('file.list', { path });
  }
  // readFile, writeFile, renameFile, deleteFile, getCwd — port from fileOps.ts
}
```

- [ ] **Step 4: Tests + commit**

---

## Phase 3: React Adapters — Session-First Integration

### Task 8: useSessionRuntime hook

**Files:**
- Create: `web/src/hooks/useSessionRuntime.ts`
- Create: `web/src/hooks/__tests__/integration/useSessionRuntime.test.tsx`

- [ ] **Step 1: Adapter acquires registry entry from attach atoms**

```typescript
export function useSessionRuntime(options: { transportFirst: boolean }) {
  const sessionId = useAtomValue(sessionIdAtom);
  const attachInfo = useAtomValue(attachInfoAtom);
  // ... sessionName, orderedUrls, manualOverride, effectiveMode

  const runtimeRef = useRef<SessionRuntime | null>(null);

  useEffect(() => {
    if (!sessionId || !attachInfo) return;
    const rt = sessionRuntimeRegistry.acquire(sessionId, {
      transportFirst: options.transportFirst,
      attachInfo, sessionName, orderedUrls, manualOverride, effectiveMode,
    });
    runtimeRef.current = rt;
    return () => sessionRuntimeRegistry.release(sessionId);
  }, [sessionId, attachInfo, /* identity key for route */]);

  // Mirror attachState + agent connectionState → Jotai (p2pStateAtom, terminalSessionStateAtom)
  // Mirror agent client → p2pConnectionAtom via useAgentConnectionAdapter for interim compat

  return runtimeRef.current;
}
```

- [ ] **Step 2: Tests** — StrictMode double mount, session switch disposes old runtime, workspace hidden keeps runtime alive

- [ ] **Step 3: Commit**

---

### Task 9: Migrate session-first terminal path

**Files:**
- Modify: `web/src/session-first/terminal/useTerminalOrchestration.ts`
- Modify: `web/src/session-first/terminal/useSessionFirstTerminalAttach.ts`
- Modify: `web/src/session-first/useSessionFirstShellState.ts`
- Test: `web/src/session-first/__tests__/integration/SessionFirstTerminal.test.tsx`

- [ ] **Step 1: useTerminalOrchestration — replace useP2PAttachTransport**

```typescript
// Before
const { p2pConnection } = useP2PAttachTransport({ attachInfo, sessionName, orderedUrls, manualOverride });

// After
const runtime = useSessionRuntime({ transportFirst: true });
const p2pConnection = useAgentConnectionAdapter(runtime?.agentClient ?? null);
```

- [ ] **Step 2: useSessionFirstTerminalAttach — emit SM events only**

```typescript
// On transportReady atom true → runtime.attachState.dispatch({ type: 'TRANSPORT_READY' })
// On attach ok message → dispatch({ type: 'ATTACH_OK' })
// Subscribe SM phase → setTerminalState (mirror only, no protocol logic in hook)
```

- [ ] **Step 3: useSessionFirstShellState — fileOps from runtime**

```typescript
const runtime = useSessionRuntime({ transportFirst: true });
const fileOps = useMemo(
  () => runtime?.getFileCapability()?.toFileOps() ?? null,
  [runtime],
);
```

- [ ] **Step 4: Run session-first integration tests**

Run: `cd web && npm test -- src/session-first`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: session-first uses SessionRuntime for P2P and files (#593)"
```

---

## Phase 4: Legacy Dashboard Integration (shared runtime)

### Task 10: Migrate TerminalWorkspace

**Files:**
- Modify: `web/src/terminal/components/TerminalWorkspace.tsx`
- Modify: `web/src/terminal/hooks/useTerminalStateMachine.ts`
- Test: existing terminal + P2P integration tests

- [ ] **Step 1: TerminalWorkspace uses same `useSessionRuntime({ transportFirst: false })`**

Legacy attach driver becomes thin wrapper (same as Task 9 Step 2 but `transportFirst: false`).

- [ ] **Step 2: Remove duplicate `useP2PAttachTransport` call from TerminalWorkspace** — policy lives in runtime

- [ ] **Step 3: Verify legacy Dashboard flow manually + tests**

Run: `cd web && npm test -- src/terminal src/hooks/__tests__/integration/useP2P`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: legacy TerminalWorkspace shares SessionRuntime (#593)"
```

---

### Task 11: Thin useP2PConnection + useP2PAttachTransport compat

**Files:**
- Modify: `web/src/hooks/useP2PConnection.ts`
- Modify: `web/src/hooks/useP2PAttachTransport.ts`

- [ ] **Step 1: useP2PConnection becomes re-export adapter**

Deprecate direct use in new code; internally delegates to `SessionRuntime.agentClient` when registry entry exists, otherwise falls back to standalone `AgentSocketClient` for isolated tests.

- [ ] **Step 2: useP2PAttachTransport delegates to runtime policy** (no duplicate address-index state)

- [ ] **Step 3: All existing hook tests pass unchanged**

- [ ] **Step 4: Commit**

---

### Task 12: fileOps.ts slim-down

**Files:**
- Modify: `web/src/services/fileOps.ts`
- Modify: `web/src/services/__tests__/integration/fileOps.test.ts`

- [ ] **Step 1: Delete `sendRequest`, `generateId`, MIN_RESPONSE_TIMEOUT duplication**

```typescript
export function createFileOps(capability: FileCapability): FileOps {
  return {
    listDir: (path) => capability.listDir(path),
    // ...
  };
}
```

- [ ] **Step 2: Update FileBrowser/FileTabs/FileViewer hooks** — accept `FileOps | null` unchanged (interface stable)

- [ ] **Step 3: Commit**

---

## Phase 5: Terminal Transport Decoupling

### Task 13: ConnectionManager — remove Jotai

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts`
- Modify: `web/src/terminal/__tests__/unit/ConnectionManager.test.ts`
- Create: `web/src/terminal/adapters/TransportAttachGate.ts`

- [ ] **Step 1: Add attach gate callback to constructor**

```typescript
interface ConnectionManagerOptions {
  // ...existing
  isAttached: () => boolean;
  onPhaseChange?: (phase: AttachPhase) => void;
}
```

- [ ] **Step 2: Replace `getDefaultStore().get(terminalSessionStateAtom)` with `this.isAttached()`**

- [ ] **Step 3: Update tests** — pass `isAttached: () => true/false` instead of seeding Jotai

- [ ] **Step 4: Wire from SessionRuntime in both orchestrators**

- [ ] **Step 5: Commit**

---

### Task 14: TerminalController — event adapter

**Files:**
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Modify: `web/src/terminal/controller/ResizeController.ts`
- Create: `web/src/terminal/adapters/TerminalRuntimeAdapter.ts`

- [ ] **Step 1: Define controller event interface**

```typescript
export interface TerminalControllerEvents {
  onInputModeChange(sessionId: string, mode: InputMode): void;
  onResize(sessionId: string, cols: number, rows: number): void;
  onTitleChange(sessionId: string, title: string): void;
}
```

- [ ] **Step 2: Replace `getDefaultStore().set` with `this.events.on*`**

- [ ] **Step 3: TerminalRuntimeAdapter subscribes and writes Jotai atoms**

Used by both `useTerminal` (legacy) and session-first pane.

- [ ] **Step 4: Commit**

---

### Task 15: Fix type dependency inversion

**Files:**
- Modify: `web/src/terminal/types.ts`
- Modify: `web/src/terminal/transport/TerminalTransport.ts`

- [ ] **Step 1: Move `AgentConnection` interface to `services/socket/types.ts`**

```typescript
/** Subset of SocketClient for terminal + file consumers */
export interface AgentConnection extends Pick<SocketClient, 'send' | 'subscribe' | 'connectionState' | 'waitForConnection'> {}
```

- [ ] **Step 2: Update imports across terminal/** — zero imports from `hooks/useP2PConnection`

Run: `cd web && rg "hooks/useP2PConnection" web/src/terminal && test $? -eq 1`

- [ ] **Step 3: Commit**

---

## Phase 6: Cleanup, Docs, Verification

### Task 16: Deprecate p2pEpoch workaround

**Files:**
- Modify: `web/src/atoms/connection.ts`
- Modify: `web/src/atoms/session.ts` (switchAddressAtom)

- [ ] **Step 1: Route switch triggers `SessionRuntime.resetAgentEndpoint()`** with explicit identity key `(sessionId, routeIntent, token)` — not object identity bump

- [ ] **Step 2: Keep `p2pEpochAtom` mirrored for one release** — comment `@deprecated remove after legacy Dashboard removed`

- [ ] **Step 3: Tests for address switch with same resolved URL (issue edge case #3)**

- [ ] **Step 4: Commit**

---

### Task 17: Architecture docs

**Files:**
- Modify: `docs/design/interaction/web.md` (short §: Runtime ownership, adapter boundary, SessionRuntime lifecycle)

- [ ] **Step 1: Add section linking #593 success criteria**

- [ ] **Step 2: Commit** — `docs:` prefix, PR can target staging

---

### Task 18: Full verification gate

- [ ] **Step 1: Lint + typecheck**

```bash
cd web && npm run lint && npx tsc --noEmit
```

- [ ] **Step 2: Full test suite**

```bash
cd web && npm test && npm run coverage
```

- [ ] **Step 3: Manual smoke — session-first path**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev
# localStorage: session-first ON → attach → terminal + files + route switch + workspace tab switch
```

- [ ] **Step 4: Manual smoke — legacy Dashboard path**

Toggle session-first OFF → repeat attach/files/route switch.

- [ ] **Step 5: Playwright screenshots** — session-first terminal attached, file workspace, legacy terminal (PR comment, not body)

---

## Dual-Architecture Sharing Checklist

After Phase 4+, verify both paths hit the **same code**:

| Concern | Shared implementation | Session-first adapter | Legacy adapter |
|---------|----------------------|----------------------|----------------|
| Agent WebSocket lifecycle | `AgentSocketClient` | `useSessionRuntime` | `useSessionRuntime` |
| Address rotation / relay fallback | `AddressAttachPolicy` | in `SessionRuntime` | in `SessionRuntime` |
| Attach protocol | `AttachStateMachine` | `transportFirst: true` | `transportFirst: false` |
| File RPC | `FileCapability` | `SessionFirstShell` | `TerminalWorkspace` |
| Terminal I/O gating | `ConnectionManager.isAttached()` | from SM mirror | from SM mirror |
| Jotai mirror | `useSessionRuntime` + adapters | same | same |

**Anti-pattern to avoid:** two `AgentSocketClient` instances for the same session (one in session-first terminal, one in shell for files). Single `SessionRuntimeRegistry` entry per `sessionId`; shell and terminal both `acquire()` (ref-count 2 when both mounted).

---

## Edge Cases (mapped to tasks)

| Edge case (#593) | Task |
|------------------|------|
| StrictMode remount | Task 7 registry ref-count; Task 8 tests |
| Session switch same agent URL | Task 7 generation on `(sessionId, token)` |
| Address switch same URL | Task 16 routeIntent identity |
| P2P reconnect viewport hidden | Task 7 runtime survives viewport unmount |
| Concurrent terminal + file traffic | Task 2 router dispatch by type/id |
| Binary terminal output | Task 2 `handleBinary` path |
| Pending request on reconnect | Task 2 fail-fast default; no silent write retry |
| Runtime dispose | Task 7 `dispose()` clears timers/handlers/pending |

---

## Spec Coverage Self-Review

| #593 Success Criterion | Plan task |
|------------------------|-----------|
| 1. useP2PConnection doesn't own WebSocket | Task 3, 11 |
| 2. Shared routing/correlation | Task 2, 4 |
| 3. fileOps no custom correlation | Task 7, 12 |
| 4. terminal/** no hook import | Task 15 |
| 5. ConnectionManager no Jotai | Task 13 |
| 6. Controller no direct Jotai | Task 14 |
| 7. Attach SM unit-testable | Task 5 |
| 8. No p2pEpoch as core mechanism | Task 16 |
| 9. Runtime survives viewport unmount | Task 7, 8 |
| 10. No behavior regression | Task 18 |
| 11. New capability uses router.request | Task 7 FileCapability pattern |
| 12. Architecture docs | Task 17 |

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-03-websocket-p2p-runtime-unification.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
