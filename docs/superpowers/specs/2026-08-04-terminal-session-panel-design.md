# Terminal Session Panel — Design Spec

**Issue:** [#154](https://github.com/BestNathan/nession/issues/154)
**Date:** 2026-08-04
**Status:** Approved

## 1. Problem

The terminal page (`/terminal/:sessionId`) shows only the attached session in fullscreen. To switch sessions, users must navigate back to Dashboard, find the target session, and re-initiate attach — a 5+ click round-trip.

## 2. Solution

Add a toggleable session list panel to the terminal page, enabling one-click session switching without leaving the terminal.

## 3. Architecture

```
TerminalView.tsx
├── useTerminalSessions(wsService)  ← NEW: fetches + subscribes to realtime
│   └── { sessions, loading, error }
├── SessionPanel                    ← NEW
│   ├── SearchBar (inline)
│   ├── SessionRow[] (extracted from SessionList.tsx pattern)
│   ├── AttachDialog (reused)
│   └── KillConfirmDialog (reused)
├── header: [+ Sessions button]     ← MODIFIED
├── TerminalLayout (existing)
│   └── Terminal (existing)
```

### Data Flow

1. `TerminalView` calls `useTerminalSessions(wsService)` — independent of Dashboard
2. Hook fetches via `wsService.listSessions()` on mount + subscribes to `sessions.list` push events
3. `SessionPanel` receives sessions, renders filtered/searchable rows
4. On row click → open existing `AttachDialog` → confirm → navigate to new `/terminal/:sessionId`
5. New `sessionId` triggers `TerminalView` remount (clean lifecycle, no new state machines)

## 4. Components

### 4.1 `useTerminalSessions` hook (NEW)

```typescript
// hooks/useTerminalSessions.ts
function useTerminalSessions(wsService: WebSocketService | null): {
  sessions: Session[];
  loading: boolean;
  error: string | null;
}
```

- On mount: calls `wsService.listSessions()` (no agent filter — returns all sessions)
- Subscribes to `sessions.list` push events for real-time updates (same event as dashboard)
- Cleanup on unmount: unsubscribe

### 4.2 `SessionPanel` component (NEW)

```typescript
// components/SessionPanel.tsx
interface SessionPanelProps {
  sessions: Session[];
  loading: boolean;
  currentSessionId: string;
  wsService: WebSocketService;
  onAttach: (session: Session) => void;         // → opens AttachDialog
  onKill: (session: Session) => void;            // → opens KillConfirmDialog
  probeCache: ReturnType<typeof useAddressProbeCache>;  // for AttachDialog
}
```

**Internal state:**
- `searchQuery` — local text filter
- `attachDialogSession` — which session's AttachDialog is open
- `sessionToKill` — which session's KillConfirm is open
- `error` — kill/attach errors

**Wraps:** `SidePanel` (existing resizable/collapsible component)

**Panel contents (top → bottom):**
1. Title bar: "Sessions" + close button
2. Search input (inline text field, filters by session name / agent ID)
3. Session rows (scrollable):
   - Status dot (green/emerald/gray)
   - Session name (truncated + tooltip)
   - Agent ID + window count + client count
   - Attach button (hidden for current session)
   - Kill button (destructive)
4. Current session: highlighted row + "Current" badge

### 4.3 `TerminalView` header (MODIFIED)

Add a Sessions toggle button before the Back button:

```
[☰ Sessions] [← Back] Session: name [P2P] [AddressSelector]
```

The toggle button uses a hamburger/menu icon. When panel is open, button shows active state.

### 4.4 Reused components (ZERO changes)

| Component | Source | Usage |
|-----------|--------|-------|
| `SidePanel` | `components/SidePanel.tsx` | Panel container (resizable, collapsible, responsive push/overlay) |
| `AttachDialog` | `components/env/AttachDialog.tsx` | Mode/renderer selection on session switch |
| `KillConfirmDialog` | `components/KillConfirmDialog.tsx` | Kill confirmation + cleanup |
| `useAddressProbeCache` | `hooks/useAddressProbeCache.ts` | P2P address probing for AttachDialog |
| `ScrollArea` | `components/ui/scroll-area.tsx` | Scrollable session list |
| `Skeleton` | `components/ui/skeleton.tsx` | Loading state rows |
| `Input` | `components/ui/input.tsx` | Search field |

## 5. Layout

### Desktop (≥ 768px)

```
┌──────────────┬──────────────────────────────────────────┐
│ SessionPanel │ Header: [☰] [← Back] Session: name [P2P]│
│ (300px)      ├──────────────────────────────────────────┤
│ ┌──────────┐ │                                          │
│ │ Search   │ │           Terminal (xterm.js)            │
│ ├──────────┤ │                                          │
│ │ ● sesh-1 │ │                                          │
│ │ ● sesh-2*│ │  * = current session (highlighted)      │
│ │ ● sesh-3 │ │                                          │
│ └──────────┘ │                                          │
├──────────────┤                                          │
│ ← resize →   │                                          │
└──────────────┴──────────────────────────────────────────┘
```

- Panel pushes terminal right (no overlay)
- Resizable via existing `SidePanel` drag handle (180-480px, default 300px)
- Toggle button on the left edge when closed

### Mobile (< 768px)

```
┌─────────────────────┐
│ Header: [☰] [←Back] │
├─────────────────────┤
│                     │
│ Terminal (full)     │
│                     │
└─────────────────────┘
        ↓ toggle
┌─────────────────────┐
│ SessionPanel        │
│ (full overlay)      │
│ ┌─────────────────┐ │
│ │ Sessions    [✕] │ │
│ │ Search          │ │
│ │ ● sesh-1 Attach │ │
│ │ ● sesh-2* Cur.  │ │
│ └─────────────────┘ │
└─────────────────────┘
```

- Panel overlays terminal (not push)
- Backdrop behind panel, click to dismiss
- Auto-closes after session switch

## 6. Session Switching Flow

1. User clicks a session row (or its Attach button)
2. `AttachDialog` opens (same component used by dashboard)
3. Dialog probes P2P addresses, user picks mode/renderer
4. On confirm:
   - If currently in relay mode: call `wsService.endRelay(currentSessionId)` before detach
   - Navigate to `/terminal/:newSessionId`
   - `TerminalView` remounts with new session identity (clean lifecycle)
5. On error: error toast, stay on current session, panel stays open

### Kill from panel

1. User clicks Kill button → `KillConfirmDialog` opens
2. Confirm → `wsService.killSession(sessionId)` → panel refreshes
3. If killed session was the current one → banner, panel stays open, user clicks another session or Back

## 7. States

| State | Panel content |
|-------|--------------|
| **Loading** (initial fetch) | 3-4 skeleton rows |
| **Empty** (no sessions) | "No active sessions" + link to dashboard |
| **Error** (fetch/subscribe failed) | Inline error banner + retry button |
| **Normal** | Filtered session rows |

### Session row variants

| Condition | Visual |
|-----------|--------|
| Current session | Accent bg + "Current" badge, Attach button hidden |
| Active | Green dot, clickable Attach |
| Detached | Emerald dot (60% opacity), clickable Attach |
| Zombie | Gray dot, Attach disabled, Kill enabled |
| Search no match | "No sessions match your search" |

## 8. Real-time Updates

- Subscribe to `sessions.list` push events (same WebSocket event dashboard uses)
- Session status changes (active ↔ detached ↔ zombie) reflected immediately
- New sessions appear at top of list
- Killed sessions removed from list
- If current session is killed externally → banner "Session terminated"

## 9. File Changes

| File | Change |
|------|--------|
| `web/src/hooks/useTerminalSessions.ts` | **NEW** — lightweight session fetch + realtime |
| `web/src/components/SessionPanel.tsx` | **NEW** — panel component with search + rows |
| `web/src/components/TerminalView.tsx` | **MODIFIED** — add Sessions toggle, wire panel |
| `web/src/components/__tests__/SessionPanel.test.tsx` | **NEW** — panel unit tests |
| `web/src/hooks/__tests__/useTerminalSessions.test.ts` | **NEW** — hook unit tests |
| `web/src/components/__tests__/TerminalView.test.tsx` | **MODIFIED** — update for new panel |

## 10. Out of Scope

- Session creation from terminal page (link to dashboard)
- Multi-tab / multi-pane terminal
- Persisting panel open/closed state across reloads
- Clipboard paste (text or image) — extracted to separate issue
