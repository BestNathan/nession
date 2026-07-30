# Reactive State Isolation — Design Spec

**Date:** 2026-07-30
**Status:** approved
**Related:** PR #115 (env fix), issue #44

## Problem

Realtime `agents.changed` pushes (every 10s per agent heartbeat) cause:

1. **Form state reset:** `CreateSessionDialog` input cleared while user is typing
2. **Unnecessary re-renders:** Full component tree re-renders even when only `last_heartbeat` timestamp changed
3. **Architectural fragility:** Any new dialog with `useDialogReset` is vulnerable to the same bug

Root cause chain:
```
Server heartbeat (10s) → broadcast_agents_changed (always) 
  → EventPlugin → setAgents(newArray)
  → onlineAgents recomputes → resetState recomputes 
  → useDialogReset callback changes → effect re-runs → form cleared
```

## Design Principles

1. **Data changes must not cascade to interaction state.** List data reference changes may affect display, never form input values.
2. **Server pushes only on meaningful changes.** `last_heartbeat` timestamps are not meaningful; `status`, `session_count`, `active_sessions` are.
3. **Client deduplicates as defense-in-depth.** Even if server pushes unnecessarily, the client compares before re-rendering.

## Changes

### 1. `useDialogReset` — fire only on open transition (architectural fix)

**File:** `web/src/hooks/useDialogReset.ts`

**Before:**
```typescript
useEffect(() => { if (isOpen) callback(); }, [isOpen, callback]);
```
Any `callback` change while `isOpen` is true → effect re-runs → form state reset.

**After:**
```typescript
const wasOpen = useRef(false);
const callbackRef = useRef(callback);
callbackRef.current = callback;

useEffect(() => {
  if (isOpen && !wasOpen.current) {
    callbackRef.current();
  }
  wasOpen.current = isOpen;
}, [isOpen]);
```
`callback` is read from a ref, not from deps. Effect fires only on the `false → true` transition of `isOpen`.

**Impact:** Every dialog using `useDialogReset` (CreateSessionDialog, KillConfirmDialog) is protected by design.

### 2. `CreateSessionDialog` — decouple `resetState` from `onlineAgents`

**File:** `web/src/components/CreateSessionDialog.tsx`

Use a ref for `onlineAgents` inside `resetState`, same pattern as PR #115:
```typescript
const onlineAgentsRef = useRef(onlineAgents);
onlineAgentsRef.current = onlineAgents;

const resetState = useCallback(() => {
  const online = onlineAgentsRef.current;
  setAgentId(preselectedAgentId ?? (online.length > 0 ? online[0].agent_id : ''));
  setSessionName('');
  setLoading(false);
  setError(null);
  setSelectedEnv([]);
}, [preselectedAgentId]); // onlineAgents removed from deps
```

Defense-in-depth: even without the `useDialogReset` fix above, this prevents the bug. With both fixes, the form is protected at two independent layers.

### 3. Server — broadcast only on meaningful change

**File:** `crates/nession-server/src/registry/agent.rs`

`update_heartbeat` returns `true` when a **meaningful** field changed:
- `status` (Online/Offline/Degraded)
- `session_count`
- `active_sessions`

Returns `false` when only `last_heartbeat` timestamp was updated.

**File:** `crates/nession-server/src/server/handler.rs`

```rust
let changed = self.agent_registry
    .update_heartbeat(agent_id, session_count, active_sessions)
    .await;
if changed {
    self.web_client_registry
        .broadcast_agents_changed(Arc::clone(&self.agent_registry))
        .await;
}
```

Also broadcast on: agent register, agent disconnect (offline), display_name rename, metadata update, session create/kill (via existing session update broadcasts).

### 4. Client — shallow-compare before `setAgents`

**File:** `web/src/hooks/useAgentData.ts`

```typescript
const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
  setAgents((prev) => {
    if (agentsEqual(prev, newAgents)) return prev; // React bails out
    trackHeartbeats(newAgents, heartbeatHistory.current);
    return newAgents;
  });
}, []);
```

`agentsEqual` compares by `agent_id` order, then meaningful fields (`status`, `session_count`, `active_sessions`, `display_name`, `addresses`, `metadata`). Does NOT compare `last_heartbeat`.

## Non-changes

The following were audited and found safe:

- `KillConfirmDialog`: `resetState` has `[]` deps, no array dependency
- `useDeepLinkRestore`: has `sessions` in deps but guarded by `confirmedRef`, safe
- `useQuickCommands`: depends on stable `wsService`, safe
- `useAddressProbeCache`: uses ref for `agents`, already follows the pattern
- `AttachDialog`, `EnvPanel`, `EnvEditorDialog`: no array-in-deps pattern found
- `AgentDetailPanel`: empty deps, safe

## Verification

1. Open CreateSessionDialog, start typing a session name
2. Wait 10+ seconds for a heartbeat-driven `agents.changed` push
3. Confirm the session name is NOT cleared
4. Repeat with the dialog open for 30+ seconds

Server-side: monitor WebSocket messages — `agents.changed` should only appear on actual agent state changes (register, disconnect, session count change), not on every heartbeat.
