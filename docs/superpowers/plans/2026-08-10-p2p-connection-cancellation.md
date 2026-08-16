# P2P Connection Cancellation & Switching Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `activeRef` with a generation counter so stale WebSocket events can't overwrite new connection state, and add a visual overlay during address switching.

**Architecture:** Increment a `generationRef` each time `agentUrl` changes; every WebSocket callback checks `generationRef.current !== ctx.generation` before updating state. Add an absolutely-positioned overlay with spinner to `TerminalView` when `isSwitching` is true.

**Tech Stack:** React, TypeScript, shadcn/ui (Loader2 icon)

---

## File Structure

```
useP2PConnection.ts          ← Refactor: generation counter replaces activeRef
TerminalView.tsx             ← Add: switching overlay over terminal area
useP2PConnection.test.ts     ← Existing tests — verify no regression
```

### Responsibilities

- **useP2PConnection.ts** — All WebSocket lifecycle callbacks use generation gating. `activeRef` removed from `ConnectWsContext` and all callback guards. Cleanup simplified.
- **TerminalView.tsx** — Renders `<SwitchingOverlay>` when `isSwitching` is true. Parent container gains `relative` positioning.

---

### Task 1: Refactor useP2PConnection to use generation counter

**Files:**
- Modify: `web/src/hooks/useP2PConnection.ts`

- [ ] **Step 1: Remove `activeRef` from `ConnectWsContext` interface and all usages**

Read the file. The `ConnectWsContext` interface is at the top of `useP2PConnection.ts`. Remove the `activeRef` field:

```ts
interface ConnectWsContext {
  agentUrl: string;
  connectionToken: string | undefined;
  generation: number;              // ← NEW: replaces activeRef
  reconnectAttemptRef: React.MutableRefObject<number>;
  setConnectionState: (s: ConnectionState) => void;
  setReconnectAttempt: (n: number) => void;
  handlersRef: React.MutableRefObject<Set<MessageHandler>>;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  onError: ((error: Error) => void) | undefined;
  reconnectTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  connectSelf: () => void;
}
```

- [ ] **Step 2: Replace all callback guards from `activeRef` to generation check**

In `connectWs()`, replace every `ctx.activeRef.current` check with `generationRef.current !== ctx.generation`:

`ws.onopen` (line 77-78):
```ts
// OLD:
if (!ctx.activeRef.current) { ws.close(); return; }
// NEW:
if (generationRef.current !== ctx.generation) { ws.close(); return; }
```

`ws.onmessage` (line 86):
```ts
// OLD:
if (!ctx.activeRef.current) {return;}
// NEW:
if (generationRef.current !== ctx.generation) {return;}
```

`ws.onerror` (line 100):
```ts
// OLD:
if (ctx.activeRef.current && ctx.reconnectAttemptRef.current === 0) {
// NEW:
if (generationRef.current === ctx.generation && ctx.reconnectAttemptRef.current === 0) {
```

`ws.onclose` (line 107):
```ts
// OLD:
if (!ctx.activeRef.current) {return;}
// NEW:
if (generationRef.current !== ctx.generation) {return;}
```

Reconnect timer callback (line 123):
```ts
// OLD:
if (ctx.activeRef.current) {ctx.connectSelf();}
// NEW:
if (generationRef.current === ctx.generation) {ctx.connectSelf();}
```

- [ ] **Step 3: Add `generationRef` and wire it into the effect**

Add at the top of the hook body, near the other refs:

```ts
// Generation counter — incremented each time agentUrl changes so stale
// WebSocket events from cancelled connections can't update state.
const generationRef = useRef(0);
```

In the main `useEffect` (around line 207), replace the `activeRef.current = true` / `activeRef.current = false` pattern:

```ts
useEffect(() => {
    if (!agentUrl) {return;}

    generationRef.current += 1;
    const myGeneration = generationRef.current;

    const ctx: ConnectWsContext = {
      agentUrl, connectionToken,
      generation: myGeneration,  // ← pass generation, not activeRef
      reconnectAttemptRef,
      setConnectionState, setReconnectAttempt, handlersRef,
      maxReconnectAttempts, reconnectBaseDelay, onError,
      reconnectTimerRef, wsRef,
      connectSelf: () => connectWs(ctx),
    };
    connectWs(ctx);

    return () => {
      // Generation is already bumped — stale callbacks will see
      // generationRef.current !== ctx.generation and self-discard.
      // Only need to clean up timers and sockets.
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
      handlersRef.current.clear();
    };
}, [agentUrl, connectionToken, onError, maxReconnectAttempts, reconnectBaseDelay]);
```

- [ ] **Step 4: Remove the `activeRef` declaration and all remaining references**

Remove the `const activeRef = useRef(true);` line near the top of the hook. Remove the `activeRef` field from any remaining references (the `waitForConnection` waiters comment about StrictMode references `activeRef` — update the comment to reference generation instead).

- [ ] **Step 5: Update the render-phase URL-change detection comment**

The comment block starting around line 158 describes the `activeRef` pattern. Update it to describe the generation counter instead:

```ts
  // The useState initializer above only runs on the hook's FIRST render. ...
  // generation counter, so children's effects that read stale state will
  // wait correctly. An effect would be too late (child effects run first).
  // The prev-url guard ensures a genuine terminal 'disconnected' (max
  // reconnects hit, same url) is NOT flipped back — agentUrl hasn't
  // changed, so the guard won't match.
```

- [ ] **Step 6: Run existing tests to verify no regression**

```bash
cd web && npx vitest run src/hooks/__tests__/useP2PConnection.test.ts src/hooks/__tests__/useP2PConnection.ordering.test.tsx src/components/__tests__/Terminal.p2pGate.test.tsx src/hooks/__tests__/useP2PWithFallback.test.ts
```

Expected: All pass.

- [ ] **Step 7: Run TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/hooks/useP2PConnection.ts
git commit -m "refactor: replace activeRef with generation counter in useP2PConnection

Generation counter ensures stale WebSocket events from cancelled
connections can never update state — even if they fire between a
timer callback and React's effect cleanup.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add switching overlay to TerminalView

**Files:**
- Modify: `web/src/components/TerminalView.tsx`

- [ ] **Step 1: Add relative positioning to the terminal area container**

Find the `div` that wraps `TerminalLayout` (around line 229):

```tsx
// OLD:
<div className="flex-1 min-h-0 flex flex-col">
  <TerminalLayout ... />
</div>

// NEW:
<div className="flex-1 min-h-0 flex flex-col relative">
  {isSwitching && (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-auto">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  )}
  <TerminalLayout ... />
</div>
```

- [ ] **Step 2: Add `Loader2` import**

Add `Loader2` to the existing lucide-react import at the top of the file:

```tsx
// OLD:
import { ArrowLeft } from 'lucide-react';
// NEW:
import { ArrowLeft, Loader2 } from 'lucide-react';
```

- [ ] **Step 3: Destructure `isSwitching` from useP2PWithFallback**

Verify `isSwitching` is already destructured from the `useP2PWithFallback` call (it was added in a previous task). If not, add it.

- [ ] **Step 4: Run tests**

```bash
cd web && npx vitest run src/components/__tests__/Terminal.p2pGate.test.tsx
```

Expected: Pass.

- [ ] **Step 5: Run TypeScript and lint**

```bash
cd web && npx tsc --noEmit && npx eslint src/components/TerminalView.tsx --max-warnings 0
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TerminalView.tsx
git commit -m "feat: add switching overlay with spinner during P2P address switch

Renders a semi-transparent mask over the terminal area when
isSwitching is true, blocking interaction until the new
connection is established.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Manual verification

**Files:**
- No code changes — verification only.

- [ ] **Step 1: Start local stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

- [ ] **Step 2: Verify with Playwright**

1. Navigate to http://localhost:13000, log in
2. Create/attach a P2P session with multiple addresses
3. Select address A → verify overlay appears with spinner
4. While connecting, select address B → verify overlay continues, old connection cancelled
5. Rapidly switch A→B→C→Auto → verify no stale state flashes, overlay updates correctly
6. Verify overlay disappears when final connection is established
