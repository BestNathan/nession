# Session Persistence & Server State Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist session metadata to SQLite so server restarts don't lose session state; add startup recovery, orphan cleanup, and K8s PVC storage.

**Architecture:** Write-through pattern — `SessionRegistry` writes to SQLite on every mutation while keeping the in-memory HashMap as the primary read source. On startup, sessions are loaded from DB with `Recovering` status and transitioned to real statuses when agents reconnect.

**Tech Stack:** Rust (tokio, rusqlite, chrono), SQLite, Kubernetes (kustomize)

**References:**
- Spec: `docs/superpowers/specs/2026-07-03-session-persistence-design.md`
- Issue: [#20](https://github.com/bestnathan/nession/issues/20)

---

### Task 1: Add Recovering/Orphaned statuses and created_at to SessionInfo

**Files:**
- Modify: `crates/nession-server/src/registry/session.rs` (entire file)

- [ ] **Step 1: Add `Recovering` and `Orphaned` variants to `SessionStatus`**

Edit `crates/nession-server/src/registry/session.rs`, change the enum:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Recovering,
    Orphaned,
    Zombie,
}
```

- [ ] **Step 2: Add `created_at` field to `SessionInfo`**

In the same file, add the field to `SessionInfo`:

```rust
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
}
```

- [ ] **Step 3: Verify the file still compiles**

Run: `cargo build -p nession-server 2>&1 | head -30`
Expected: compilation errors in files that construct `SessionInfo` (handler.rs) — we fix those next.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-server/src/registry/session.rs
git commit -m "feat: add Recovering/Orphaned statuses and created_at to SessionInfo

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add SessionRow struct and session CRUD methods to Database

**Files:**
- Modify: `crates/nession-server/src/db/mod.rs`

- [ ] **Step 1: Add `SessionRow` struct**

In `crates/nession-server/src/db/mod.rs`, after the `AgentRow` struct definition (after line 22), add:

```rust
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub created_at: i64,
    pub last_activity: i64,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
    pub metadata: String,
}
```

- [ ] **Step 2: Add `insert_session` method**

After the `list_agents` method (before the closing `}` of `impl Database`), add:

```rust
pub async fn insert_session(
    &self,
    session_id: &str,
    agent_id: &str,
    session_name: &str,
    status: &str,
    window_count: u32,
    attached_clients: u32,
    created_at: i64,
) -> Result<()> {
    let conn = self.conn.lock().await;
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT OR REPLACE INTO sessions (session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')",
        rusqlite::params![session_id, agent_id, session_name, created_at, now, status, window_count, attached_clients],
    )?;

    Ok(())
}
```

- [ ] **Step 3: Add `update_session_status` method**

```rust
pub async fn update_session_status(&self, session_id: &str, status: &str) -> Result<()> {
    let conn = self.conn.lock().await;
    conn.execute(
        "UPDATE sessions SET status = ?1, last_activity = ?2 WHERE session_id = ?3",
        rusqlite::params![status, chrono::Utc::now().timestamp(), session_id],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Add `delete_session` method**

```rust
pub async fn delete_session(&self, session_id: &str) -> Result<()> {
    let conn = self.conn.lock().await;
    conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        rusqlite::params![session_id],
    )?;
    Ok(())
}
```

- [ ] **Step 5: Add `delete_sessions_by_agent` method**

```rust
pub async fn delete_sessions_by_agent(&self, agent_id: &str) -> Result<()> {
    let conn = self.conn.lock().await;
    conn.execute(
        "DELETE FROM sessions WHERE agent_id = ?1",
        rusqlite::params![agent_id],
    )?;
    Ok(())
}
```

- [ ] **Step 6: Add `list_all_sessions` method**

```rust
pub async fn list_all_sessions(&self) -> Result<Vec<SessionRow>> {
    let conn = self.conn.lock().await;
    let mut stmt = conn.prepare(
        "SELECT session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata FROM sessions"
    )?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(SessionRow {
                session_id: row.get(0)?,
                agent_id: row.get(1)?,
                session_name: row.get(2)?,
                created_at: row.get(3)?,
                last_activity: row.get(4)?,
                status: row.get(5)?,
                window_count: row.get(6)?,
                attached_clients: row.get(7)?,
                metadata: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}
```

- [ ] **Step 7: Add `list_sessions_older_than` method**

```rust
pub async fn list_sessions_older_than(&self, duration_secs: i64) -> Result<Vec<SessionRow>> {
    let conn = self.conn.lock().await;
    let cutoff = chrono::Utc::now().timestamp() - duration_secs;
    let mut stmt = conn.prepare(
        "SELECT session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata FROM sessions WHERE last_activity < ?1 AND status = 'recovering'"
    )?;

    let sessions = stmt
        .query_map([cutoff], |row| {
            Ok(SessionRow {
                session_id: row.get(0)?,
                agent_id: row.get(1)?,
                session_name: row.get(2)?,
                created_at: row.get(3)?,
                last_activity: row.get(4)?,
                status: row.get(5)?,
                window_count: row.get(6)?,
                attached_clients: row.get(7)?,
                metadata: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}
```

- [ ] **Step 8: Verify compilation**

Run: `cargo build -p nession-server 2>&1 | head -30`
Expected: errors are only about missing `created_at` in SessionInfo constructors (handler.rs) — not about Database methods.

- [ ] **Step 9: Commit**

```bash
git add crates/nession-server/src/db/mod.rs
git commit -m "feat: add SessionRow and session CRUD methods to Database

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Wire Database into SessionRegistry with write-through persistence

**Files:**
- Modify: `crates/nession-server/src/registry/session.rs`

- [ ] **Step 1: Add Database dependency and update imports**

Replace the top of `crates/nession-server/src/registry/session.rs`:

```rust
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::db::Database;
```

- [ ] **Step 2: Add `db` field and change `new()` signature**

Replace the `SessionRegistry` struct and impl block:

```rust
pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
    db: Arc<Database>,
}

impl SessionRegistry {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            db,
        }
    }

    pub async fn load_from_db(&self) {
        match self.db.list_all_sessions().await {
            Ok(rows) => {
                let mut sessions = self.sessions.write().await;
                for row in rows {
                    let created_at = DateTime::from_timestamp(row.created_at, 0)
                        .unwrap_or_else(|| Utc::now());
                    let last_activity = DateTime::from_timestamp(row.last_activity, 0)
                        .unwrap_or_else(|| Utc::now());
                    let status = match row.status.as_str() {
                        "active" => SessionStatus::Active,
                        "detached" => SessionStatus::Detached,
                        "zombie" => SessionStatus::Zombie,
                        _ => SessionStatus::Recovering,
                    };
                    let info = SessionInfo {
                        session_id: row.session_id.clone(),
                        agent_id: row.agent_id,
                        session_name: row.session_name,
                        status,
                        window_count: row.window_count,
                        attached_clients: row.attached_clients,
                        created_at,
                        last_activity,
                    };
                    tracing::info!(
                        "Loaded session {} (agent: {}, status: {:?})",
                        info.session_id,
                        info.agent_id,
                        info.status
                    );
                    sessions.insert(row.session_id, info);
                }
                tracing::info!(
                    "Loaded {} sessions from database (recovering)",
                    sessions.len()
                );
            }
            Err(e) => {
                tracing::error!("Failed to load sessions from database: {:#}", e);
            }
        }
    }
```

- [ ] **Step 3: Remove `Default` impl (no longer valid with DB dependency)**

Delete the `impl Default for SessionRegistry` block (lines 28-32 in the original).

- [ ] **Step 4: Add write-through to `update_session`**

Replace the `update_session` method:

```rust
pub async fn update_session(&self, session: SessionInfo) {
    let status_str = match session.status {
        SessionStatus::Active => "active",
        SessionStatus::Detached => "detached",
        SessionStatus::Recovering => "recovering",
        SessionStatus::Orphaned => "orphaned",
        SessionStatus::Zombie => "zombie",
    };
    let created_at_ts = session.created_at.timestamp();

    // Write through to SQLite first, then update in-memory.
    // DB write failure is logged but does not block the in-memory update.
    if let Err(e) = self.db.insert_session(
        &session.session_id,
        &session.agent_id,
        &session.session_name,
        status_str,
        session.window_count,
        session.attached_clients,
        created_at_ts,
    ).await {
        tracing::error!("Failed to persist session {}: {:#}", session.session_id, e);
    }

    let mut sessions = self.sessions.write().await;
    sessions.insert(session.session_id.clone(), session);
}
```

- [ ] **Step 5: Add write-through to `remove`**

Replace the `remove` method:

```rust
pub async fn remove(&self, session_id: &str) {
    if let Err(e) = self.db.delete_session(session_id).await {
        tracing::error!("Failed to delete session {} from DB: {:#}", session_id, e);
    }
    let mut sessions = self.sessions.write().await;
    sessions.remove(session_id);
}
```

- [ ] **Step 6: Add write-through to `remove_by_agent`**

Replace the `remove_by_agent` method:

```rust
pub async fn remove_by_agent(&self, agent_id: &str) {
    if let Err(e) = self.db.delete_sessions_by_agent(agent_id).await {
        tracing::error!("Failed to delete sessions for agent {} from DB: {:#}", agent_id, e);
    }
    let mut sessions = self.sessions.write().await;
    sessions.retain(|_, s| s.agent_id != agent_id);
}
```

- [ ] **Step 7: Keep `get`, `list`, `list_by_agent` unchanged**

These methods remain pure in-memory reads. Verify they compile as-is.

- [ ] **Step 8: Verify compilation**

Run: `cargo build -p nession-server 2>&1 | head -40`
Expected: errors are only about `SessionRegistry::new()` call site (websocket.rs) and `SessionInfo` constructors missing `created_at` (handler.rs) — we fix those in the next tasks.

- [ ] **Step 9: Commit**

```bash
git add crates/nession-server/src/registry/session.rs
git commit -m "feat: wire Database into SessionRegistry with write-through persistence

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update handler.rs for new statuses and created_at field

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs`

- [ ] **Step 1: Add Recovering and Orphaned to the session list serialization**

In `handle_client_sessions_list`, replace the status match (lines 393-397):

```rust
"status": match s.status {
    SessionStatus::Active => "active",
    SessionStatus::Detached => "detached",
    SessionStatus::Recovering => "recovering",
    SessionStatus::Orphaned => "orphaned",
    SessionStatus::Zombie => "zombie",
},
```

- [ ] **Step 2: Add `created_at` to SessionInfo construction in `handle_agent_session_update`**

At line 234, add `created_at` to the struct literal:

```rust
let session_info = crate::registry::session::SessionInfo {
    session_id: session_id.clone(),
    agent_id: agent_id.to_string(),
    session_name: session_name.to_string(),
    status,
    window_count,
    attached_clients,
    created_at: chrono::Utc::now(),
    last_activity: chrono::Utc::now(),
};
```

Note: using `chrono::Utc::now()` for `created_at` on agent-reported sessions because the server is seeing this session for the first time (it wasn't created by the server). The actual creation time from tmux is available in the agent's `SessionInfo` but not sent in the session update message. This is acceptable — the timestamp records when the server first learned of the session.

- [ ] **Step 3: Add `created_at` to SessionInfo construction in `handle_client_session_create`**

At line 664, add `created_at` to the struct literal:

```rust
let session_info = crate::registry::session::SessionInfo {
    session_id: sid.clone(),
    agent_id: agent_id.to_string(),
    session_name: name.to_string(),
    status: crate::registry::session::SessionStatus::Detached,
    window_count: 1,
    attached_clients: 0,
    created_at: chrono::Utc::now(),
    last_activity: chrono::Utc::now(),
};
```

- [ ] **Step 4: Add `Recovering`/`Orphaned` deserialization to `handle_agent_session_update`**

In `handle_agent_session_update`, add the new statuses to the match at line 221 (so agents can report recovering/orphaned sessions — forward-compatible):

```rust
let status = match status_str {
    "active" => crate::registry::session::SessionStatus::Active,
    "detached" => crate::registry::session::SessionStatus::Detached,
    "recovering" => crate::registry::session::SessionStatus::Recovering,
    "orphaned" => crate::registry::session::SessionStatus::Orphaned,
    "zombie" => crate::registry::session::SessionStatus::Zombie,
    _ => {
        warn!("Unknown session status '{}' for {}", status_str, session_id);
        return Ok(HandlerAction::Reply(None));
    }
};
```

- [ ] **Step 5: Verify compilation**

Run: `cargo build -p nession-server 2>&1 | head -40`
Expected: errors only about `SessionRegistry::new()` call in websocket.rs (no longer works without DB arg). That's the next task.

- [ ] **Step 6: Commit**

```bash
git add crates/nession-server/src/server/handler.rs
git commit -m "feat: add Recovering/Orphaned serialization and created_at in handler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Wire Database into WebSocketServer with orphan sweep

**Files:**
- Modify: `crates/nession-server/src/server/websocket.rs`

- [ ] **Step 1: Add Database import**

At the top of `crates/nession-server/src/server/websocket.rs`, add the import (after line 3 `use tracing::{error, info};`):

```rust
use crate::db::Database;
```

- [ ] **Step 2: Add `db` field to `WebSocketServer` struct**

Modify the struct definition (lines 12-18):

```rust
pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    db: Arc<Database>,
    listener: Option<TcpListener>,
}
```

- [ ] **Step 3: Change `WebSocketServer::new` to accept `Arc<Database>`**

Replace the `new` method signature and body (lines 21-34). Store `db` on `self` and clone it for `SessionRegistry`:

```rust
pub async fn new(config: ServerConfig, db: Arc<Database>) -> anyhow::Result<Self> {
    let listener = TcpListener::bind(&config.listen_address).await?;
    let agent_registry = Arc::new(AgentRegistry::new(config.heartbeat_timeout_secs));
    let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));

    // Load persisted sessions from the database. They will be shown as
    // "recovering" until their agent reconnects and confirms them.
    session_registry.load_from_db().await;

    let command_broker = Arc::new(CommandBroker::new());

    Ok(Self {
        config,
        agent_registry,
        session_registry,
        command_broker,
        db,
        listener: Some(listener),
    })
}
```

- [ ] **Step 4: Add 24h orphan sweep background task**

After the existing heartbeat sweeper spawn in `run()` (after the closing `});` of the offline-agent sweeper around line 97), add:

```rust
        // Background sweep: periodically clean up orphaned sessions whose
        // agent has been unreachable for more than 24 hours.
        {
            let session_registry = Arc::clone(&self.session_registry);
            let db = Arc::clone(&self.db);
            // Run every hour — orphan cleanup is not latency-sensitive.
            let sweep_period = std::time::Duration::from_secs(3600);
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(sweep_period);
                ticker.tick().await; // consume the immediate first tick
                loop {
                    ticker.tick().await;
                    // 24 hours in seconds
                    let cutoff = 24 * 3600i64;
                    match db.list_sessions_older_than(cutoff).await {
                        Ok(rows) => {
                            if rows.is_empty() {
                                continue;
                            }
                            for row in &rows {
                                info!(
                                    "Cleaning orphaned session {} (agent: {}, last activity: {})",
                                    row.session_id, row.agent_id, row.last_activity
                                );
                                session_registry.remove(&row.session_id).await;
                            }
                            tracing::info!("Cleaned {} orphaned sessions", rows.len());
                        }
                        Err(e) => {
                            error!("Orphan session sweep failed: {:#}", e);
                        }
                    }
                }
            });
        }
```

- [ ] **Step 5: Verify compilation**

Run: `cargo build -p nession-server 2>&1 | head -40`
Expected: errors only about main.rs not passing Database. That's the next task.

- [ ] **Step 6: Commit**

```bash
git add crates/nession-server/src/server/websocket.rs
git commit -m "feat: wire Database into WebSocketServer with orphan sweep

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Update main.rs to pass Database

**Files:**
- Modify: `crates/nession-server/src/main.rs`

- [ ] **Step 1: Pass Database to WebSocketServer**

In `crates/nession-server/src/main.rs`, change line 41 from:

```rust
let mut server = WebSocketServer::new(config).await?;
```

to:

```rust
let mut server = WebSocketServer::new(config, std::sync::Arc::new(database)).await?;
```

And remove the `_` prefix from `database` on line 37 (no longer unused):

```rust
let database = Database::new(&config.db_path).await?;
```

- [ ] **Step 2: Build the entire project**

Run: `cargo build 2>&1`
Expected: clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-server/src/main.rs
git commit -m "feat: pass Database to WebSocketServer in main

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: K8s manifest changes — emptyDir to PVC

**Files:**
- Modify: `k8s/deployment-server.yaml`
- Modify: `k8s/pvc.yaml`

- [ ] **Step 1: Change volume from emptyDir to PVC**

In `k8s/deployment-server.yaml`, replace lines 72-74:

```yaml
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: nession-data-pvc
```

- [ ] **Step 2: Restore PVC manifest**

Replace the entire content of `k8s/pvc.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nession-data-pvc
  namespace: nession
  labels:
    app: nession
    component: data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  # Uncomment and set your cluster's default StorageClass:
  # storageClassName: standard
```

- [ ] **Step 3: Commit**

```bash
git add k8s/deployment-server.yaml k8s/pvc.yaml
git commit -m "feat: switch server from emptyDir to PVC for persistent sessions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run `cargo build`**

```bash
cargo build 2>&1
```
Expected: clean build, zero errors.

- [ ] **Step 2: Run `cargo clippy`**

```bash
cargo clippy -- -D warnings 2>&1
```
Expected: zero warnings.

- [ ] **Step 3: Run `cargo test`**

```bash
cargo test 2>&1
```
Expected: all tests pass.

- [ ] **Step 4: Run `cargo fmt` check**

```bash
cargo fmt --all -- --check
```
Expected: no formatting issues.

- [ ] **Step 5: Verify web build is unaffected**

```bash
cd web && npm run build 2>&1
```
Expected: build succeeds (no changes to web code).

- [ ] **Step 6: Commit any remaining changes**

```bash
git status
# If nothing to commit, done.
git commit -m "chore: final verification — all tests and lints pass

Co-Authored-By: Claude <noreply@anthropic.com>"
```
