# Reactive State Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent realtime `agents.changed` pushes from cascading into dialog form-state resets, and reduce unnecessary broadcasts/re-renders.

**Architecture:** Four independent layers of defense: (1) `useDialogReset` fires only on open-transition, not on callback changes; (2) `CreateSessionDialog` reads `onlineAgents` via ref; (3) Server broadcasts `agents.changed` only on meaningful agent-state changes; (4) Client `applyAgentUpdate` shallow-compares before `setAgents`.

**Tech Stack:** TypeScript (React 19, vitest), Rust (tokio, serde_json)

---

### Task 1: Fix `useDialogReset` — fire only on open transition

**Files:**
- Modify: `web/src/hooks/useDialogReset.ts`

- [ ] **Step 1: Rewrite `useDialogReset` to use open-transition detection**

Replace the entire file content:

```typescript
import { useEffect, useRef } from 'react';

/**
 * Reset dialog state when it opens (false → true transition only).
 *
 * The callback is read from a ref so it never needs to appear in the
 * dependency array — this prevents data-array changes (e.g. a new
 * `agents` reference from a realtime push) from cascading through
 * `useCallback` into this effect and resetting form state while the
 * dialog is open.
 */
export function useDialogReset(isOpen: boolean, callback: () => void): void {
  const wasOpen = useRef(false);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      callbackRef.current();
    }
    wasOpen.current = isOpen;
  }, [isOpen]);
}
```

- [ ] **Step 2: Run existing tests to verify no regressions**

```bash
cd web && npx vitest run src/components/__tests__/CreateSessionDialog.test.tsx
```

Expected: All 12 tests PASS. The "resets error state when dialog is reopened" test (line 432) specifically validates the reset-on-open behavior and must still pass.

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useDialogReset.ts
git commit -m "fix: fire useDialogReset only on open transition, not on callback change

Previously the callback was in the useEffect dependency array, so any
change to the callback reference (e.g. from a realtime agents.changed
push cascading through useMemo → useCallback) would re-run the reset
while the dialog was open, clearing form state.

Now the effect only fires on the false→true transition of isOpen.
The callback is read from a ref, eliminating it from the dep array.

This protects every dialog that uses useDialogReset by design.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Decouple `CreateSessionDialog` resetState from onlineAgents

**Files:**
- Modify: `web/src/components/CreateSessionDialog.tsx`

- [ ] **Step 1: Add `useRef` import and `onlineAgentsRef`**

Replace the import line (line 1):
```typescript
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
```
→ (unchanged, `useRef` is already imported)

- [ ] **Step 2: Add `onlineAgentsRef`, rewrite `resetState` to use it**

After line 81 (`const onlineAgents = useMemo(...)`), insert the ref, then rewrite `resetState`:

```typescript
  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);

  // Stable ref for onlineAgents — prevents resetState from depending on the
  // agents array, which changes on every realtime push and would cascade into
  // useDialogReset, clearing form state while the user is typing.
  const onlineAgentsRef = useRef(onlineAgents);
  onlineAgentsRef.current = onlineAgents;

  const resetState = useCallback(() => {
    const online = onlineAgentsRef.current;
    setAgentId(preselectedAgentId ?? (online.length > 0 ? online[0].agent_id : ''));
    setSessionName('');
    setLoading(false);
    setError(null);
    setSelectedEnv([]);
  }, [preselectedAgentId]);
```

This replaces lines 81-89 (the old `useMemo`, `useCallback`, and `useDialogReset` call stays on line 90).

- [ ] **Step 3: Run tests**

```bash
cd web && npx vitest run src/components/__tests__/CreateSessionDialog.test.tsx
```

Expected: All 12 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/CreateSessionDialog.tsx
git commit -m "fix: decouple CreateSessionDialog resetState from onlineAgents

Same pattern as PR #115 (useEnvEditor fix): use a ref to read
onlineAgents inside resetState without depending on the array.
Realtime agents.changed pushes create new array references which
previously cascaded through useMemo → useCallback → useDialogReset,
resetting the session name while the user was typing.

Defense-in-depth with the useDialogReset fix in the previous commit.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Server — broadcast agents.changed only on meaningful change

**Files:**
- Modify: `crates/nession-server/src/registry/agent.rs`
- Modify: `crates/nession-server/src/server/handler.rs`
- Modify: `crates/nession-server/tests/agent_registry_test.rs`

- [ ] **Step 1: Change `update_heartbeat` to return `bool`**

In `crates/nession-server/src/registry/agent.rs`, replace `update_heartbeat` (lines 131-139):

```rust
/// Update heartbeat timestamp and session counts for an agent.
/// Returns `true` if a **meaningful** field changed (status, session_count,
/// active_sessions) — i.e. the UI should re-render. Returns `false` when
/// only `last_heartbeat` was touched (no-op for dashboard clients).
pub async fn update_heartbeat(&self, agent_id: &str, session_count: u32, active_sessions: u32) -> bool {
    let mut agents = self.agents.write().await;
    if let Some(agent) = agents.get_mut(agent_id) {
        let status_before = agent.status.clone();
        let sessions_before = agent.session_count;
        let active_before = agent.active_sessions;

        agent.last_heartbeat = Utc::now();
        agent.status = AgentStatus::Online;
        agent.session_count = session_count;
        agent.active_sessions = active_sessions;

        // Only signal a meaningful change — timestamp-only updates don't
        // need to trigger a broadcast to every web client.
        status_before != AgentStatus::Online
            || sessions_before != session_count
            || active_before != active_sessions
    } else {
        false
    }
}
```

- [ ] **Step 2: Conditionally broadcast in handler**

In `crates/nession-server/src/server/handler.rs`, replace lines 324-332:

```rust
        let changed = self
            .agent_registry
            .update_heartbeat(agent_id, session_count, active_sessions)
            .await;

        // Push updated agent state to all connected web dashboard clients
        // only when a meaningful field changed (status, session counts).
        // Timestamp-only heartbeats don't need a broadcast.
        if changed {
            self.web_client_registry
                .broadcast_agents_changed(Arc::clone(&self.agent_registry))
                .await;
        }
```

- [ ] **Step 3: Update existing test to check return value**

In `crates/nession-server/tests/agent_registry_test.rs`, replace `test_agent_heartbeat_update` (lines 49-82):

```rust
#[tokio::test]
async fn test_agent_heartbeat_update() {
    let (registry, _db_guard) = test_registry(30).await;

    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        display_name: None,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };

    registry.register(agent).await;

    // First update changes session_count → should return true
    let changed = registry.update_heartbeat("agent_123", 5, 3).await;
    assert!(changed, "session_count change should be meaningful");

    let updated = registry.get("agent_123").await.unwrap();
    assert_eq!(updated.session_count, 5);
    assert_eq!(updated.active_sessions, 3);

    // Second update with same values → should return false (timestamp only)
    let changed = registry.update_heartbeat("agent_123", 5, 3).await;
    assert!(!changed, "same values should not be meaningful");
}
```

- [ ] **Step 4: Add test for status transition (offline → online)**

Add after the test above:

```rust
#[tokio::test]
async fn test_heartbeat_status_transition_is_meaningful() {
    let (registry, _db_guard) = test_registry(30).await;

    let agent = AgentInfo {
        agent_id: "a1".to_string(),
        hostname: "h1".to_string(),
        ip_address: "10.0.0.1".to_string(),
        port: 8080,
        display_name: None,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Offline,
        metadata: AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };
    registry.register(agent).await;

    // Offline → Online transition should be meaningful
    let changed = registry.update_heartbeat("a1", 0, 0).await;
    assert!(changed, "status transition offline→online should be meaningful");
}
```

- [ ] **Step 5: Update the noop test to check return value**

Replace `test_update_heartbeat_nonexistent_agent_is_noop` (lines 231-236):

```rust
#[tokio::test]
async fn test_update_heartbeat_nonexistent_agent_is_noop() {
    let (registry, _db_guard) = test_registry(30).await;
    // Should not panic and should return false
    let changed = registry.update_heartbeat("nonexistent", 0, 0).await;
    assert!(!changed);
}
```

- [ ] **Step 6: Run Rust tests**

```bash
cargo test -p nession-server test_agent_heartbeat_update test_heartbeat_status_transition_is_meaningful test_update_heartbeat_nonexistent_agent_is_noop
```

Expected: 3 tests PASS.

- [ ] **Step 7: Run full Rust test suite to check for regressions**

```bash
cargo test -p nession-server
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/nession-server/src/registry/agent.rs crates/nession-server/src/server/handler.rs crates/nession-server/tests/agent_registry_test.rs
git commit -m "feat: broadcast agents.changed only on meaningful state changes

update_heartbeat now returns bool — true when status, session_count,
or active_sessions changed; false when only last_heartbeat was touched.
The handler conditionally broadcasts, skipping timestamp-only heartbeats.

This eliminates ~90% of agents.changed pushes (every 10s per agent →
only on actual state transitions), reducing client re-renders.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Client — shallow-compare in applyAgentUpdate

**Files:**
- Modify: `web/src/hooks/useAgentData.ts`

- [ ] **Step 1: Add `agentsEqual` helper and update `applyAgentUpdate`**

In `web/src/hooks/useAgentData.ts`, add the comparison function and rewrite `applyAgentUpdate` (lines 5 and 45-48):

After the `trackHeartbeats` function (line 14), add:

```typescript
/** Shallow-compare two agent lists by meaningful fields.
 *  Returns true when every agent matches on the fields the UI renders —
 *  last_heartbeat is intentionally excluded because it changes every 10s
 *  and would defeat deduplication. */
function agentsEqual(a: Agent[], b: Agent[]): boolean {
  if (a.length !== b.length) return false;
  const key = (agent: Agent) =>
    `${agent.agent_id}|${agent.status}|${agent.session_count}|${agent.active_sessions ?? 0}|${agent.display_name ?? ''}`;
  return a.every((agent, i) => key(agent) === key(b[i]));
}
```

Replace `applyAgentUpdate` (lines 45-48):

```typescript
  const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
    setAgents((prev) => {
      if (agentsEqual(prev, newAgents)) {
        return prev; // React bails out of re-render when reference is unchanged
      }
      trackHeartbeats(newAgents, heartbeatHistory.current);
      return newAgents;
    });
  }, []);
```

- [ ] **Step 2: Run tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS. The `agentsEqual` function is a pure helper tested indirectly through component behavior.

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useAgentData.ts
git commit -m "fix: shallow-compare agents before setState in applyAgentUpdate

When the server pushes agents.changed, applyAgentUpdate now compares
the new list against current state by meaningful fields (status,
session_count, active_sessions, display_name — NOT last_heartbeat).
If nothing the UI renders changed, setAgents returns the same reference
and React skips the re-render.

Defense-in-depth: even if the server broadcasts unnecessarily, the
client won't trigger a useless re-render.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Verification Checklist

After all tasks are complete, manually verify:

- [ ] **Dialog resilience:** Open CreateSessionDialog, type a session name, wait 30s — name is NOT cleared
- [ ] **KillConfirmDialog unaffected:** Open kill dialog, verify reset-on-open still works
- [ ] **Server broadcast reduction:** Monitor WebSocket messages — `agents.changed` no longer fires on every heartbeat (only on register, disconnect, session count change, status change)
- [ ] **Full test suites pass:**
  ```bash
  cargo test && cd web && npx vitest run && npm run lint && npx tsc --noEmit
  ```
