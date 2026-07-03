# Session Persistence & Server State Recovery — Design Spec

**Issue:** [#20](https://github.com/bestnathan/nession/issues/20)
**Date:** 2026-07-03
**Status:** Approved

## Overview

Nession Server currently stores session state entirely in memory. Server restart destroys all session data. This design adds SQLite-backed persistence for session metadata, startup recovery, and orphaned-session cleanup. K8s deployment switches from `emptyDir` to PVC for durable storage.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session ID format | `{agent_id}:{session_name}` (unchanged) | Avoids breaking frontend, CLI, attach flow |
| Session statuses | Add `Recovering` + `Orphaned` | Observability into recovery state; explicit orphan tracking |
| Config toggle | None — always persist | Reliability feature, fewer code branches |
| Architecture | In-memory primary + write-through to SQLite | Fast reads (dashboard), mutations are low-frequency |
| Orphan sweep interval | 1 hour | Not latency-sensitive; avoids constant queries |

## Architecture

```
SessionRegistry (in-memory HashMap)
       │
       │ write-through (every mutation)
       ▼
   Database (SQLite, sessions table)
       │
       │ load_from_db() at startup
       ▼
SessionRegistry (HashMap seeded with Recovering sessions)
```

### Data flow on server restart:
1. Server starts → `SessionRegistry::load_from_db()`
2. All sessions loaded with status `Recovering`
3. Dashboard immediately shows sessions (recovering state)
4. Agent reconnects → `sync_needed` flag triggers full session report
5. Agent's sessions transition `Recovering` → `Active`/`Detached`
6. Sessions the agent no longer reports → deleted from memory + DB

## Changes by Component

### 1. Session Status Enum (`registry/session.rs`)

Add two variants:
- `Recovering` — loaded from DB at startup, waiting for agent confirmation
- `Orphaned` — agent unreachable > 24h, eligible for cleanup

Existing `Active`, `Detached`, `Zombie` unchanged.

### 2. SessionInfo (`registry/session.rs`)

Add field: `created_at: DateTime<Utc>`

### 3. Database DAO (`db/mod.rs`)

New `SessionRow` struct and methods:
- `insert_session(&self, session: &SessionInfo)` — INSERT OR REPLACE
- `update_session_status(&self, session_id, status)` — targeted status update
- `delete_session(&self, session_id)` — single session removal
- `delete_sessions_by_agent(&self, agent_id)` — bulk removal
- `list_all_sessions(&self)` — startup recovery
- `list_sessions_older_than(&self, duration_secs)` — orphan sweep

All methods use the existing `Arc<Mutex<Connection>>`.

### 4. SessionRegistry (`registry/session.rs`)

Constructor takes `Arc<Database>`:
- `new(db: Arc<Database>)` — stores DB handle
- `load_from_db()` — reads all rows, seeds HashMap with `Recovering` status

Write-through on every mutation:
- `update_session()` → `db.insert_session()` then HashMap insert
- `remove()` → `db.delete_session()` then HashMap remove
- `remove_by_agent()` → `db.delete_sessions_by_agent()` then HashMap retain

Read methods (`get`, `list`, `list_by_agent`) unchanged — pure in-memory.

### 5. WebSocketServer (`server/websocket.rs`)

- Accept `Arc<Database>` in `new()`, pass to `SessionRegistry::new()`
- Call `session_registry.load_from_db().await` after construction
- Add 24h orphan sweep background task (runs every hour):
  - Queries `list_sessions_older_than(24h)` filtered to `Recovering` status only
  - For each: if agent still offline/unregistered → delete from memory + DB

### 6. main.rs

Pass `Arc<Database>` to `WebSocketServer::new()` instead of dropping it.

### 7. ConnectionHandler (`server/handler.rs`)

No changes. The session update flow (`agent.session.update`) already calls `session_registry.update_session()`, which will now persist to SQLite automatically.

### 8. K8s (`k8s/deployment-server.yaml`, `k8s/pvc.yaml`)

- **deployment-server.yaml**: Change volume from `emptyDir: {}` to `persistentVolumeClaim: { claimName: nession-data-pvc }`
- **pvc.yaml**: Restore PVC manifest with commented-out `storageClassName` for cluster admin to fill in

### 9. Agent

**No changes required.** The existing mechanisms suffice:
- `sync_needed` flag triggers full session re-sync on reconnect
- `SessionWatcher` clears prev_sessions and reports all tmux sessions
- `HeartbeatLoop` reports session counts

## Session Lifecycle State Machine

```
                    ┌──────────┐
                    │  (start) │
                    └────┬─────┘
                         │
                    ┌────▼──────┐
             ┌──────│ Recovering │──────┐
             │      └───────────┘      │
             │ agent        agent      │ agent unreachable
             │ confirms     reports    │ > 24h
             │ attached     detached   │
        ┌────▼───┐    ┌────▼────┐  ┌──▼──────┐
        │ Active │    │Detached │  │ Orphaned│──► deleted
        └───┬────┘    └───┬─────┘  └─────────┘
            │             │
            │ client      │ agent
            │ detaches    │ reports gone
            │             │
        ┌───▼──┐    ┌────▼────┐
        │Detached   │  deleted │
        └──────┘    └─────────┘
```

## Testing Strategy

### Unit Tests
- `SessionRegistry` write-through: mutations persist to DB
- `SessionRegistry::load_from_db()`: recovery produces correct HashMap
- `SessionRow` ↔ `SessionInfo` conversion round-trips
- DB CRUD operations with empty DB (first-start scenario)

### Integration Tests
- Server restart: sessions survive and show `recovering` status
- Agent reconnect: sessions transition `recovering` → `active`/`detached`
- Agent offline > 30s: sessions cleaned from memory + DB
- Agent never returns: sessions cleaned after 24h by orphan sweep

### K8s Verification
- Delete server Pod → recreate → Dashboard shows prior sessions

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| DB empty on first start | `load_from_db()` returns empty — no crash |
| DB contains session for agent that never reconnects | Session stays `Recovering` for 24h, then sweep marks `Orphaned` and deletes |
| Agent reconnects but tmux session was manually deleted | Agent doesn't report it → server deletes from memory + DB |
| DB file corrupted | Startup detects via SQLite integrity check (future enhancement tracked in issue #20 open questions) |
| Session ID collision | `INSERT OR REPLACE` handles it; compound key makes collisions near-impossible |
| Agent re-registers with different IP | Normal flow — session ownership follows `agent_id`, not IP |
