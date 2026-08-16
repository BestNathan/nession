# P2P Connection Cancellation & Switching Overlay — Design Spec

**Date:** 2026-08-10
**Branch:** feat/address-selector-mobile

## Overview

Fix a race condition in `useP2PConnection` where stale WebSocket events from a cancelled connection attempt can overwrite the state of a new connection. Add a visual overlay/mask during address switching so the user can see that a switch is in progress and cannot interact with the terminal until the new connection is established.

## Goals

1. **Proper cancellation:** When switching addresses A→B→C, each previous connection is fully cancelled — no stale events from A or B can affect C's state
2. **Switching overlay:** When `isSwitching` is true, render a semi-transparent mask over the terminal area with a spinner, blocking interaction

## Root Cause

`useP2PConnection` uses a single shared `activeRef` to guard all WebSocket callbacks:

```ts
ws.onopen = () => {
    if (!ctx.activeRef.current) { ws.close(); return; }
    ctx.setConnectionState('connected'); // ← can fire for a CANCELLED connection
};
```

**Race scenario:**

```
1. Connection B times out → onclose → reconnect timer fires → connectSelf()
2. connectSelf() creates new WebSocket to B
3. User clicks address C → React queues re-render
4. BETWEEN step 2 and React's commit phase: B's new WS fires onopen
   → ctx.activeRef.current === TRUE (cleanup not yet run)
   → setConnectionState('connected') for STALE address B ❌
5. React commit: cleanup closes B's WS, opens WS to C
6. State was briefly 'connected' for B — now correcting to 'connecting' for C
```

The one-render flash of stale 'connected' state causes the banner to briefly clear, `isSwitching` to briefly become `false`, and the overlay to flicker. In the worst case, if the stale `onopen` and the new connection's events interleave, the UI can get stuck showing incorrect state.

## Architecture

### Generation Counter (useP2PConnection)

Replace `activeRef`-based gating with a **generation counter**:

```
agentUrl changes → generation += 1
connectWs captures current generation
ALL callbacks: if (generationRef.current !== myGeneration) return;
```

This guarantees that only the LATEST connection can update state. Old connections' events are silently discarded regardless of timing.

**Interface changes to `ConnectWsContext`:** Replace `activeRef` with a `generation: number` field. All `ctx.activeRef.current` checks become `generationRef.current !== ctx.generation`.

**Cleanup:** No longer needs to set `activeRef = false` — generation is bumped by the next effect's init. Keep the `clearTimeout` + `ws.close()` for resource cleanup.

### Switching Overlay (TerminalView)

A new overlay component renders when `isSwitching` is true:

```
┌─────────────────────────────┐
│      Terminal Header        │
├─────────────────────────────┤
│ ╔═════════════════════════╗ │
│ ║    ◌ Switching...      ║ │  ← absolute-positioned overlay
│ ╚═════════════════════════╝ │    bg-background/60 backdrop-blur-sm
│     (terminal underneath)    │    pointer-events-auto (blocks clicks)
├─────────────────────────────┤
│      Input Bar (mobile)     │
└─────────────────────────────┘
```

The overlay is positioned absolutely over the terminal container. It does NOT cover the header or input bar — only the terminal area.

### Files Changed

| File | Action | Detail |
|------|--------|--------|
| `useP2PConnection.ts` | Refactor | Replace `activeRef` with generation counter; remove `activeRef` from `ConnectWsContext` and all callbacks |
| `TerminalView.tsx` | Add | Render overlay when `isSwitching` is true; wrap terminal area in `relative` container for absolute positioning |
| `useP2PConnection.test.ts` | Update | Update tests for generation counter (no functional test changes needed — mock covers it) |

## Generation Counter Details

### Before (activeRef)

```ts
const activeRef = useRef(true);

// In effect:
activeRef.current = true;

// Cleanup:
activeRef.current = false;

// In connectWs — every callback:
if (!ctx.activeRef.current) { /* discard */ }
```

### After (generation counter)

```ts
const generationRef = useRef(0);

// In effect:
generationRef.current += 1;
const myGeneration = generationRef.current;

// Cleanup: no generation change needed — the new effect will bump it

// In connectWs — every callback:
if (generationRef.current !== ctx.generation) { /* discard */ }
```

### Callback Changes

Every callback that currently checks `ctx.activeRef.current`:

- `ws.onopen`: `if (!ctx.activeRef.current)` → `if (generationRef.current !== ctx.generation)`
- `ws.onmessage`: `if (!ctx.activeRef.current)` → `if (generationRef.current !== ctx.generation)`
- `ws.onerror`: `if (ctx.activeRef.current && ...)` → `if (generationRef.current === ctx.generation && ...)`
- `ws.onclose`: `if (!ctx.activeRef.current)` → `if (generationRef.current !== ctx.generation)`
- reconnect timer: `if (ctx.activeRef.current)` → `if (generationRef.current === ctx.generation)`

### Reconnect Timer in onclose

The reconnect timer also captures `ctx`. With the generation check, if the timer fires but a newer connection has been started, `generationRef.current !== ctx.generation` and the timer callback is a no-op.

## Switching Overlay Details

### Component

A simple overlay rendered inside `TerminalView.tsx`, conditionally when `isSwitching` is true:

```tsx
{isSwitching && (
  <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-auto">
    <Loader2 className="size-8 animate-spin text-muted-foreground" />
  </div>
)}
```

Positioned over the terminal area (the `flex-1 min-h-0` container that holds `TerminalLayout`). The parent container needs `relative` positioning.

### Behavior

- `isSwitching` = true → overlay appears, terminal interaction blocked
- `isSwitching` = false → overlay removed, terminal is interactive
- Smooth CSS transition via `opacity` on the overlay container (not required but nice to have)
- Header and input bar remain interactive (user can still navigate back or use quick commands)

## Testing

### Unit Tests (useP2PConnection)

- Verify that after `agentUrl` changes, events from the old connection's WebSocket do NOT update state (simulated via direct callback invocation)
- Verify that events from the new connection's WebSocket DO update state

### Component Tests (TerminalView)

- When `isSwitching` is true, the overlay element is present with `animate-spin`
- When `isSwitching` is false, the overlay element is absent

### Manual Verification

1. Start local stack
2. Attach to a P2P session with multiple addresses
3. Select address A → confirm spinner/overlay appears
4. While connecting, select address B → confirm overlay continues, new connection starts
5. Rapidly switch A→B→C→Auto → confirm no stale state flashes
6. Confirm overlay disappears when final connection is established
