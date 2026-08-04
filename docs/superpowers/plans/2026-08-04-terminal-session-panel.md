# Terminal Session Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable session list panel to the terminal page, enabling one-click session switching without returning to dashboard.

**Architecture:** New `useTerminalSessions` hook fetches sessions independently via `wsService.listSessions()` and subscribes to `sessions.list` push events. New `SessionPanel` component wraps the existing `SidePanel` and renders session rows with search, attach, and kill. `TerminalView` header gains a toggle button.

**Tech Stack:** React 18, TypeScript, xterm.js 5.5, shadcn/ui, Sonner toast, Lucide icons

---

### Files

| Action | File |
|--------|------|
| Create | `web/src/hooks/useTerminalSessions.ts` |
| Create | `web/src/hooks/__tests__/useTerminalSessions.test.ts` |
| Create | `web/src/components/SessionPanel.tsx` |
| Create | `web/src/components/__tests__/SessionPanel.test.tsx` |
| Modify | `web/src/components/TerminalView.tsx` |
| Modify | `web/src/components/RenderTerminal.tsx` |
| Modify | `web/src/components/Dashboard.tsx` |
| Modify | `web/src/components/__tests__/TerminalView.test.tsx` |

---

### Task 1: `useTerminalSessions` hook

**Files:**
- Create: `web/src/hooks/useTerminalSessions.ts`
- Create: `web/src/hooks/__tests__/useTerminalSessions.test.ts`

- [ ] **Step 1: Write the hook implementation**

```typescript
// web/src/hooks/useTerminalSessions.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

export function useTerminalSessions(wsService: WebSocketService | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef(wsService);
  wsRef.current = wsService;

  const fetchSessions = useCallback(async () => {
    if (!wsService) { return; }
    setLoading(true);
    setError(null);
    try {
      const list = await wsService.listSessions();
      setSessions(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [wsService]);

  useEffect(() => {
    if (!wsService) { return; }
    fetchSessions();
    const unsub = wsService.onSessionsChanged(setSessions);
    return () => { unsub(); };
  }, [wsService, fetchSessions]);

  return { sessions, loading, error, refetch: fetchSessions };
}
```

- [ ] **Step 2: Write the tests**

```typescript
// web/src/hooks/__tests__/useTerminalSessions.test.ts
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalSessions } from '../useTerminalSessions';
import type { WebSocketService } from '../../services/websocket';
import type { Session } from '../../types';

function mockWsService(sessions: Session[] = []) {
  const listeners = new Set<(s: Session[]) => void>();
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
    onSessionsChanged: vi.fn((cb: (s: Session[]) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    _push: (s: Session[]) => listeners.forEach((cb) => cb(s)),
  } as unknown as WebSocketService & { _push: (s: Session[]) => void };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent1:test',
    agent_id: 'agent1',
    session_name: 'test',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading=true initially, then sessions after fetch', async () => {
    const sessions = [makeSession()];
    const ws = mockWsService(sessions);

    const { result } = renderHook(() => useTerminalSessions(ws));

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual(sessions);
    expect(result.current.error).toBeNull();
  });

  it('handles fetch error', async () => {
    const ws = mockWsService();
    ws.listSessions = vi.fn().mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('network error');
    expect(result.current.sessions).toEqual([]);
  });

  it('updates sessions on push event', async () => {
    const initial = [makeSession({ session_name: 'old' })];
    const ws = mockWsService(initial);

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'new' })];
    act(() => {
      ws._push(updated);
    });

    expect(result.current.sessions).toEqual(updated);
  });

  it('does nothing when wsService is null', () => {
    const { result } = renderHook(() => useTerminalSessions(null));

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('refetch calls listSessions again', async () => {
    const ws = mockWsService([]);
    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'refetched' })];
    ws.listSessions = vi.fn().mockResolvedValue(updated);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.sessions).toEqual(updated);
  });
});
```

- [ ] **Step 3: Run tests**

```
cd web && npm test -- --reporter=verbose src/hooks/__tests__/useTerminalSessions.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useTerminalSessions.ts web/src/hooks/__tests__/useTerminalSessions.test.ts
git commit -m "feat: add useTerminalSessions hook (#154)"
```

---

### Task 2: `SessionPanel` component

**Files:**
- Create: `web/src/components/SessionPanel.tsx`
- Create: `web/src/components/__tests__/SessionPanel.test.tsx`

- [ ] **Step 1: Write the component**

```typescript
// web/src/components/SessionPanel.tsx
import { useState, useCallback, useMemo } from 'react';
import { X, SearchX } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { SidePanel } from './SidePanel';
import { AttachDialog } from './env/AttachDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import type { AttachChoice } from './env/AttachDialog';

interface SessionPanelProps {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  currentSessionId: string;
  wsService: WebSocketService;
  onSwitchSession: (session: Session, choice: AttachChoice) => void;
  probeCache: ReturnType<typeof useAddressProbeCache>;
}

export function SessionPanel({
  sessions,
  loading,
  error,
  onRetry,
  currentSessionId,
  wsService,
  onSwitchSession,
  probeCache,
}: SessionPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [attachTarget, setAttachTarget] = useState<Session | null>(null);
  const [killTarget, setKillTarget] = useState<Session | null>(null);

  const filtered = useMemo(() => {
    if (!searchQuery) { return sessions; }
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) => s.session_name.toLowerCase().includes(q) || s.agent_id.toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  const handleAttach = useCallback((session: Session) => {
    if (session.session_id === currentSessionId) { return; }
    setAttachTarget(session);
  }, [currentSessionId]);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachTarget(null);
    onSwitchSession(session, choice);
  }, [onSwitchSession]);

  const handleKill = useCallback((session: Session) => {
    setKillTarget(session);
  }, []);

  const confirmKill = useCallback(async () => {
    if (!killTarget) { return; }
    try {
      const res = await wsService.killSession(killTarget.session_id);
      if (!res.success) {
        toast.error(res.error ?? 'Failed to kill session');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to kill session');
    } finally {
      setKillTarget(null);
    }
  }, [killTarget, wsService]);

  const panelContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b">
        <span className="font-semibold text-sm">Sessions</span>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <Input
          placeholder="Filter sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {error ? (
          <div className="flex flex-col items-center gap-2 py-8 px-3">
            <p className="text-xs text-destructive text-center">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2 px-3 py-2">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-muted-foreground">
            <SearchX size={28} className="mb-2" />
            <p className="text-xs">
              {searchQuery ? 'No sessions match your search' : 'No active sessions'}
            </p>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <div className="divide-y divide-border">
              {filtered.map((session) => {
                const isCurrent = session.session_id === currentSessionId;
                return (
                  <div
                    key={session.session_id}
                    className={cn(
                      'flex flex-col gap-1.5 py-2.5 px-3 hover:bg-accent/50 transition-colors',
                      isCurrent && 'bg-accent/30',
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          session.status === 'active' ? 'bg-green-500' :
                          session.status === 'detached' ? 'bg-emerald-500/60' :
                          'bg-gray-400',
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-xs truncate">{session.session_name}</p>
                          {isCurrent && (
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                              Current
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {session.agent_id} · {session.window_count} win · {session.attached_clients} client
                          {session.attached_clients !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {!isCurrent && (
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs flex-1"
                          onClick={() => handleAttach(session)}
                          disabled={session.status === 'zombie'}
                        >
                          Attach
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs flex-1 text-destructive border-destructive hover:bg-destructive/10"
                        onClick={() => handleKill(session)}
                      >
                        Kill
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Dialogs */}
      <AttachDialog
        isOpen={attachTarget !== null}
        onClose={() => setAttachTarget(null)}
        session={attachTarget}
        onConfirm={confirmAttach}
        probeCache={probeCache}
      />
      <KillConfirmDialog
        isOpen={killTarget !== null}
        onClose={() => setKillTarget(null)}
        session={killTarget}
        onKilled={() => setKillTarget(null)}
      />
    </div>
  );

  return <SidePanel defaultOpen={false}>{panelContent}</SidePanel>;
}
```

- [ ] **Step 2: Write the tests**

```typescript
// web/src/components/__tests__/SessionPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionPanel } from '../SessionPanel';
import type { Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent1:test',
    agent_id: 'agent1',
    session_name: 'test',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockProbeCache = {
  get: vi.fn().mockReturnValue(null),
  put: vi.fn(),
  clear: vi.fn(),
};

describe('SessionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPanel(props: Partial<{
    sessions: Session[];
    loading: boolean;
    error: string | null;
    currentSessionId: string;
  }> = {}) {
    const wsService = {
      killSession: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as WebSocketService;

    return render(
      <SessionPanel
        sessions={props.sessions ?? []}
        loading={props.loading ?? false}
        error={props.error ?? null}
        onRetry={vi.fn()}
        currentSessionId={props.currentSessionId ?? 'agent1:current'}
        wsService={wsService}
        onSwitchSession={vi.fn()}
        probeCache={mockProbeCache as ReturnType<typeof import('../../hooks/useAddressProbeCache').useAddressProbeCache>}
      />,
    );
  }

  it('shows loading skeletons when loading=true', () => {
    renderPanel({ loading: true });
    // Skeletons are present
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows empty state when no sessions', () => {
    renderPanel({ sessions: [], loading: false });
    expect(screen.getByText('No active sessions')).toBeDefined();
  });

  it('shows error banner with retry button', () => {
    const onRetry = vi.fn();
    const wsService = {
      killSession: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as WebSocketService;

    render(
      <SessionPanel
        sessions={[]}
        loading={false}
        error="fetch failed"
        onRetry={onRetry}
        currentSessionId="agent1:current"
        wsService={wsService}
        onSwitchSession={vi.fn()}
        probeCache={mockProbeCache as ReturnType<typeof import('../../hooks/useAddressProbeCache').useAddressProbeCache>}
      />,
    );

    expect(screen.getByText('fetch failed')).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('renders session rows', () => {
    renderPanel({
      sessions: [makeSession({ session_name: 'mysession', status: 'active' })],
      loading: false,
      currentSessionId: 'agent1:other',
    });

    expect(screen.getByText('mysession')).toBeDefined();
    expect(screen.getByText('Attach')).toBeDefined();
    expect(screen.getByText('Kill')).toBeDefined();
  });

  it('highlights current session with badge and hides Attach button', () => {
    renderPanel({
      sessions: [makeSession({ session_id: 'agent1:current', session_name: 'current' })],
      loading: false,
      currentSessionId: 'agent1:current',
    });

    expect(screen.getByText('Current')).toBeDefined();
    // No Attach button for current session
    const attachButtons = screen.queryAllByText('Attach');
    expect(attachButtons.length).toBe(0);
  });

  it('filters sessions by search query', async () => {
    renderPanel({
      sessions: [
        makeSession({ session_id: 'a:a', session_name: 'alpha' }),
        makeSession({ session_id: 'b:b', session_name: 'beta' }),
      ],
      loading: false,
    });

    const input = screen.getByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'alpha');

    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('shows no-match message when search filters everything', async () => {
    renderPanel({
      sessions: [makeSession({ session_name: 'alpha' })],
      loading: false,
    });

    const input = screen.getByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'xyz');

    expect(screen.getByText('No sessions match your search')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run tests**

```
cd web && npm test -- --reporter=verbose src/components/__tests__/SessionPanel.test.tsx
```

Expected: 6 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SessionPanel.tsx web/src/components/__tests__/SessionPanel.test.tsx
git commit -m "feat: add SessionPanel component (#154)"
```

---

### Task 3: Wire into `TerminalView` + `Dashboard` + `RenderTerminal`

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/RenderTerminal.tsx`
- Modify: `web/src/components/Dashboard.tsx`
- Modify: `web/src/components/__tests__/TerminalView.test.tsx`

- [ ] **Step 1: Update `TerminalView.tsx` — add props + hooks + panel**

Add `onSwitchSession` prop, `useTerminalSessions` + `useAddressProbeCache` hooks, and render `SessionPanel`:

```typescript
// ── New imports (add alongside existing imports) ──
import { Menu } from 'lucide-react';
import { useTerminalSessions } from '../hooks/useTerminalSessions';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { SessionPanel } from './SessionPanel';
import type { AttachChoice } from './env/AttachDialog';
import type { Session } from '../types';

// ── Updated interface ──
interface TerminalViewProps {
  session: AttachedSession;
  onBack: () => void;
  onSwitchSession: (session: Session, choice: AttachChoice) => void;  // NEW
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

// ── Destructure new prop ──
export function TerminalView({ session, onBack, onSwitchSession, onDisconnect, onError }: TerminalViewProps) {

// ── New state + hooks (add after existing useState declarations) ──
  const [panelOpen, setPanelOpen] = useState(false);

// ── Add after `const wsService = useWebSocket();` ──
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useTerminalSessions(wsService);
  const probeCache = useAddressProbeCache([]);

// ── Add switch handler after `handleBack` ──
  const handleSwitchSession = useCallback((s: Session, choice: AttachChoice) => {
    // End relay before switching so the server's relay loop exits cleanly.
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    // Delegate to Dashboard's useAttachFlow.confirmAttach (passed as prop).
    // This sets attachedSession + navigates, triggering TerminalView remount
    // with the new session identity — same lifecycle as dashboard-initiated attach.
    onSwitchSession(s, choice);
  }, [effectiveMode, wsService, sessionId, onSwitchSession]);
```

Then in the return block, modify the layout:

```typescript
// ── Updated header — add Sessions toggle button before Back ──
<header className="border-b px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4 flex-shrink-0 flex-wrap">
  <Button
    variant={panelOpen ? 'secondary' : 'ghost'}
    size="sm"
    onClick={() => setPanelOpen((p) => !p)}
    title="Toggle session list"
  >
    <Menu className="w-4 h-4 mr-1" /> Sessions
  </Button>
  <Button variant="ghost" size="sm" onClick={handleBack}>
    <ArrowLeft className="w-4 h-4 mr-1" /> Back
  </Button>
  <span className="text-sm text-muted-foreground">
    Session: <strong className="text-foreground">{sessionName}</strong>
  </span>
  {/* <Badge ...>, <AddressSelector ...> — unchanged */}
</header>

// ── Updated body — wrap terminal content with SessionPanel ──
// Replace:
//   <div className="flex-1 min-h-0 flex flex-col">
//     <TerminalLayout ... />
//   </div>
// With:
<div className="flex-1 min-h-0 flex">
  <SessionPanel
    sessions={sessions}
    loading={sessionsLoading}
    error={sessionsError}
    onRetry={refetchSessions}
    currentSessionId={sessionId}
    wsService={wsService!}
    onSwitchSession={handleSwitchSession}
    probeCache={probeCache}
  />
  <div className="flex-1 min-w-0 min-h-0 flex flex-col">
    <TerminalLayout
      terminalElement={terminalElement}
      bottomTab={bottomTab}
      onBottomTabChange={setBottomTab}
      sheetOpen={sheetOpen}
      onSheetToggle={setSheetOpen}
      sessionId={sessionId}
      sessionName={sessionName}
      sendText={(text) => terminalHandle?.sendText(text)}
      toolbarDisabled={toolbarDisabled}
      fileOps={fileOps}
      onTerminalReveal={() => terminalHandle?.refit()}
      fontSizeManager={terminalHandle?.fontSizeManager ?? null}
      focusTerminal={() => terminalHandle?.focusTerminal()}
    />
  </div>
</div>
```

- [ ] **Step 2: Update `RenderTerminal.tsx` — thread new prop**

```typescript
// web/src/components/RenderTerminal.tsx
import { TerminalView, type AttachedSession } from './TerminalView';
import type { Session } from '../types';
import type { AttachChoice } from './env/AttachDialog';

export function RenderTerminal({
  attachedSession, handleBackToDashboard, handleSwitchSession, handleTerminalDisconnect, handleTerminalError,
}: {
  attachedSession: AttachedSession;
  handleBackToDashboard: () => void;
  handleSwitchSession: (session: Session, choice: AttachChoice) => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  return (
    <TerminalView session={attachedSession}
      onBack={handleBackToDashboard}
      onSwitchSession={handleSwitchSession}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError} />
  );
}
```

- [ ] **Step 3: Update `Dashboard.tsx` — pass `confirmAttach` as switch handler**

In `Dashboard.tsx`, find the `terminalMatch && attachedSession` block and update it:

```typescript
// web/src/components/Dashboard.tsx — change the terminal render block:
if (terminalMatch && attachedSession) {
  return (<RenderTerminal attachedSession={attachedSession}
    handleBackToDashboard={backToDashboard}
    handleSwitchSession={confirmAttach}
    handleTerminalDisconnect={handleTerminalDisconnect}
    handleTerminalError={handleTerminalError} />);
}
```

`confirmAttach` from `useAttachFlow` already has the exact signature `(session: Session, choice: AttachChoice) => void` — it sets `attachedSession` and navigates to `/terminal/:newSessionId`, causing `TerminalView` to remount cleanly. Same lifecycle as dashboard-initiated attach.

- [ ] **Step 4: Update existing tests**

The existing `TerminalView.test.tsx` tests need minor adjustments:
1. Mock the new hooks
2. Add the new `onSwitchSession` prop to render calls

Add mocks at the top of the test file (before describe blocks):

```typescript
// Add to web/src/components/__tests__/TerminalView.test.tsx before describe blocks:
vi.mock('../../hooks/useTerminalSessions', () => ({
  useTerminalSessions: () => ({
    sessions: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAddressProbeCache', () => ({
  useAddressProbeCache: () => ({
    get: vi.fn().mockReturnValue(null),
    put: vi.fn(),
    clear: vi.fn(),
  }),
}));
```

And in every `<TerminalView ...>` render call, add:
```typescript
onSwitchSession={vi.fn()}
```

- [ ] **Step 5: Run all tests**

```
cd web && npm test -- --reporter=verbose
```

Expected: All existing tests PASS + new tests PASS.

- [ ] **Step 6: Run TypeScript check**

```
cd web && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Run ESLint**

```
cd web && npm run lint
```

Expected: 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/components/__tests__/TerminalView.test.tsx
git commit -m "feat: wire SessionPanel into TerminalView (#154)"
```

---

### Task 4: Playwright verification

Start the full local stack, navigate to the terminal page, and verify the session panel works correctly.

- [ ] **Step 1: Start local stack**

```bash
# Terminal 1 — server
HOME=/tmp/nession-demo cargo run -p nession-server &
# Terminal 2 — agent
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
# Terminal 3 — web
cd web && npm run dev &
```

- [ ] **Step 2: Navigate and verify panel toggle**

Use Playwright MCP:
1. `mcp__playwright__browser_navigate` to `http://localhost:13000`
2. Clear localStorage: `mcp__playwright__browser_evaluate` with `() => { localStorage.clear(); }`
3. Reload, log in
4. Create a session from dashboard
5. Attach to the session (opens terminal page)
6. Verify the Sessions button is visible in the header
7. Click the Sessions button → verify panel opens with session list
8. Verify current session has "Current" badge
9. Click Back → verify return to dashboard

- [ ] **Step 3: Take screenshots**

1. Terminal page with panel closed
2. Terminal page with panel open showing sessions
3. Current session highlighted in panel

Save to `.playwright-mcp/screenshots/`.

- [ ] **Step 4: Commit screenshots (if any config changes only)**

```bash
# Only if files changed
git add -A && git commit -m "chore: add Playwright verification screenshots (#154)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full build check**

```
cd web && npm run build
```

Expected: Build succeeds, no warnings.

- [ ] **Step 2: Coverage check**

```
cd web && npm run coverage
```

Expected: ≥ 80% line coverage.

- [ ] **Step 3: Push and create PR**

```bash
git push -u origin feat/terminal-session-panel
gh pr create --title "feat: add session list panel to terminal page (#154)" \
  --body "## 变更内容
- 新增加 \`useTerminalSessions\` hook — 独立获取 sessions 并订阅实时更新
- 新增加 \`SessionPanel\` 组件 — 终端页内可切换 session 列表面板
- 修改 \`TerminalView\` — 添加 Sessions 切换按钮,接入面板

Closes #154

## 测试报告
<!-- Fill after running -->

## 核心功能截图
<!-- Playwright MCP screenshots -->
"
```
