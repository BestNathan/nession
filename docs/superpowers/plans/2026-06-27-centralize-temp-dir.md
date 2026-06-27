# Centralize Temp Files Under ~/.nession/ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all nession runtime files (server DB, PID files) from scattered locations (cwd, /tmp) into `~/.nession/{server,agent}/`.

**Architecture:** Add a `paths` module to `nession-common` as single source of truth for all file paths. Update config defaults, CLI arg defaults, and server startup code to use it. Auto-create component dirs on startup. Tests are unchanged (keep using tempdir).

**Tech Stack:** Rust, `dirs` crate v5, `nession-common` / `nession-cli` / `nession-server` crates

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `crates/nession-common/src/paths.rs` | Path resolution for all nession runtime files |
| Modify | `crates/nession-common/src/lib.rs` | Register `paths` module |
| Modify | `crates/nession-common/Cargo.toml` | Add `dirs = "5"` dependency |
| Create | `crates/nession-common/tests/paths_test.rs` | Unit tests for paths module |
| Modify | `crates/nession-common/src/config.rs:19-21` | `default_db_path()` uses `paths::server_db_path()` |
| Modify | `crates/nession-common/tests/config_test.rs:31` | Update default assertion to new path |
| Modify | `crates/nession-cli/src/main.rs:72,78,84,102,108,114` | `--pid-file` defaults use `paths::server_pid_path()` / `paths::agent_pid_path()` |
| Modify | `crates/nession-cli/src/commands/server.rs:228,252` | Remove inline fallback, call `ensure_component_dirs()` |
| Modify | `crates/nession-server/src/main.rs:27,60` | Remove inline fallback, call `ensure_component_dirs()` |

---

### Task 1: Create `paths` module with tests

**Files:**
- Create: `crates/nession-common/src/paths.rs`
- Modify: `crates/nession-common/src/lib.rs`
- Modify: `crates/nession-common/Cargo.toml`
- Create: `crates/nession-common/tests/paths_test.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/nession-common/tests/paths_test.rs`:

```rust
use nession_common::paths;
use std::path::PathBuf;

fn expected_home() -> PathBuf {
    dirs::home_dir().unwrap().join(".nession")
}

#[test]
fn test_nession_home() {
    assert_eq!(paths::nession_home(), expected_home());
}

#[test]
fn test_server_dir() {
    assert_eq!(paths::server_dir(), expected_home().join("server"));
}

#[test]
fn test_agent_dir() {
    assert_eq!(paths::agent_dir(), expected_home().join("agent"));
}

#[test]
fn test_server_db_path() {
    assert_eq!(paths::server_db_path(), expected_home().join("server").join("server.db"));
}

#[test]
fn test_server_pid_path() {
    assert_eq!(paths::server_pid_path(), expected_home().join("server").join("server.pid"));
}

#[test]
fn test_agent_pid_path() {
    assert_eq!(paths::agent_pid_path(), expected_home().join("agent").join("agent.pid"));
}

#[test]
fn test_ensure_component_dirs_creates_directories() {
    // Just verify it doesn't error (dirs already exist or get created)
    paths::ensure_component_dirs().expect("ensure_component_dirs should succeed");
    assert!(paths::server_dir().exists());
    assert!(paths::agent_dir().exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-common --test paths_test 2>&1 | tail -5`
Expected: FAIL — `paths` module does not exist, compilation error

- [ ] **Step 3: Add `dirs` dependency**

Edit `crates/nession-common/Cargo.toml` — add `dirs` to `[dependencies]`:

```toml
[dependencies]
serde.workspace = true
serde_json.workspace = true
chrono.workspace = true
uuid.workspace = true
thiserror.workspace = true
toml = "0.8"
dirs = "5"
```

- [ ] **Step 4: Create the paths module**

Create `crates/nession-common/src/paths.rs`:

```rust
use std::io;
use std::path::PathBuf;

/// Root directory for all nession runtime files: ~/.nession
pub fn nession_home() -> PathBuf {
    dirs::home_dir()
        .expect("could not determine home directory")
        .join(".nession")
}

/// Server component directory: ~/.nession/server
pub fn server_dir() -> PathBuf {
    nession_home().join("server")
}

/// Agent component directory: ~/.nession/agent
pub fn agent_dir() -> PathBuf {
    nession_home().join("agent")
}

/// Server database path: ~/.nession/server/server.db
pub fn server_db_path() -> PathBuf {
    server_dir().join("server.db")
}

/// Server PID file path: ~/.nession/server/server.pid
pub fn server_pid_path() -> PathBuf {
    server_dir().join("server.pid")
}

/// Agent PID file path: ~/.nession/agent/agent.pid
pub fn agent_pid_path() -> PathBuf {
    agent_dir().join("agent.pid")
}

/// Create server and agent component directories if they don't exist.
pub fn ensure_component_dirs() -> io::Result<()> {
    std::fs::create_dir_all(server_dir())?;
    std::fs::create_dir_all(agent_dir())?;
    Ok(())
}
```

- [ ] **Step 5: Register the module in lib.rs**

Edit `crates/nession-common/src/lib.rs` — add `pub mod paths;`:

```rust
pub mod protocol;
pub mod config;
pub mod error;
pub mod paths;

pub use error::{NessionError, Result};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p nession-common --test paths_test 2>&1 | tail -15`
Expected: All 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add crates/nession-common/Cargo.toml crates/nession-common/src/paths.rs crates/nession-common/src/lib.rs crates/nession-common/tests/paths_test.rs
git commit -m "feat(common): add paths module for centralized ~/.nession/ file locations"
```

---

### Task 2: Update config default_db_path to use paths module

**Files:**
- Modify: `crates/nession-common/src/config.rs:19-21`
- Modify: `crates/nession-common/tests/config_test.rs:31`

- [ ] **Step 1: Update the failing test**

Edit `crates/nession-common/tests/config_test.rs` line 31 — change the expected default:

```rust
    assert_eq!(config.db_path, nession_common::paths::server_db_path().to_string_lossy().as_ref()); // default
```

Full updated test for reference:

```rust
#[test]
fn test_server_config_defaults() {
    let toml_str = r#"
        listen_address = "0.0.0.0:8443"
        tls_cert_path = "/path/to/cert.pem"
        tls_key_path = "/path/to/key.pem"
        auth_token = "secret_token_123"
    "#;

    let config: ServerConfig = toml::from_str(toml_str).unwrap();
    assert_eq!(config.heartbeat_timeout_secs, 30); // default
    assert_eq!(config.db_path, nession_common::paths::server_db_path().to_string_lossy().as_ref()); // default
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-common --test config_test test_server_config_defaults 2>&1 | tail -10`
Expected: FAIL — `db_path` is `"./nession-server.db"` but test expects the new path

- [ ] **Step 3: Update default_db_path in config.rs**

Edit `crates/nession-common/src/config.rs` — change `default_db_path()`:

```rust
fn default_db_path() -> String {
    crate::paths::server_db_path().to_string_lossy().into_owned()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-common --test config_test 2>&1 | tail -10`
Expected: Both config tests PASS

- [ ] **Step 5: Commit**

```bash
git add crates/nession-common/src/config.rs crates/nession-common/tests/config_test.rs
git commit -m "feat(common): config default_db_path uses ~/.nession/server/server.db"
```

---

### Task 3: Update CLI --pid-file defaults to use paths module

**Files:**
- Modify: `crates/nession-cli/src/main.rs:72,78,84,102,108,114`

Note: `clap`'s `#[arg(default_value = ...)]` requires a `&str`, but `paths::*_pid_path()` returns a `PathBuf` computed at runtime. We need to switch to `default_value_t` or use a `String` default computed in a helper. The cleanest approach: use `default_value_t` with the `PathBuf` and let clap display it, OR compute defaults via lazy_static/const. Since `dirs::home_dir()` isn't const, we'll use `default_value_t` with a custom type, or simpler — keep the pid_file as `Option<String>` and resolve the default at the call site.

**Chosen approach:** Change `pid_file: String` to `pid_file: Option<String>`, resolve default when passing to command functions. This is the simplest change that avoids fighting clap's const-only `default_value`.

- [ ] **Step 1: Update AgentAction pid_file fields to Option<String>**

Edit `crates/nession-cli/src/main.rs` — change all `pid_file` fields in `AgentAction` from `String` with `default_value` to `Option<String>` without default:

Replace lines 59-87 (the entire `AgentAction` enum) with:

```rust
#[derive(Subcommand)]
enum AgentAction {
    /// Start the agent
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "agent-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the agent
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show agent status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}
```

- [ ] **Step 2: Update ServerAction pid_file fields to Option<String>**

Replace the `ServerAction` enum (lines 89-117) with:

```rust
#[derive(Subcommand)]
enum ServerAction {
    /// Start the server
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "server-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the server
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show server status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}
```

- [ ] **Step 3: Update the match arms to resolve defaults**

In the `main()` function, update the `Commands::Agent` and `Commands::Server` match arms. Replace lines 188-205 with:

```rust
        Commands::Agent { action } => match action {
            AgentAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path().to_string_lossy().into_owned()
                });
                commands::agent::start(config, foreground, pid_file).await?
            }
            AgentAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path().to_string_lossy().into_owned()
                });
                commands::agent::stop(pid_file).await?
            }
            AgentAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path().to_string_lossy().into_owned()
                });
                commands::agent::status(pid_file).await?
            }
        },
        Commands::Server { action } => match action {
            ServerAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path().to_string_lossy().into_owned()
                });
                commands::server::start(config, foreground, pid_file).await?
            }
            ServerAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path().to_string_lossy().into_owned()
                });
                commands::server::stop(pid_file).await?
            }
            ServerAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path().to_string_lossy().into_owned()
                });
                commands::server::status(pid_file).await?
            }
        },
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check -p nession-cli 2>&1 | tail -10`
Expected: Compiles without errors

- [ ] **Step 5: Commit**

```bash
git add crates/nession-cli/src/main.rs
git commit -m "feat(cli): --pid-file defaults use ~/.nession/{agent,server}/ paths"
```

---

### Task 4: Add ensure_component_dirs() at server startup, remove inline fallbacks

**Files:**
- Modify: `crates/nession-cli/src/commands/server.rs:228,247-253`
- Modify: `crates/nession-server/src/main.rs:27,54-61`

- [ ] **Step 1: Update commands/server.rs — remove inline fallback and add ensure_component_dirs()**

Edit `crates/nession-cli/src/commands/server.rs`.

First, in `load_server_config()` (line 228), replace the inline `db_path` fallback:

```rust
            db_path: nession_common::paths::server_db_path().to_string_lossy().into_owned(),
```

Second, in `run_server_foreground()` (around line 247-253), add `ensure_component_dirs()` call before DB init. The section should become:

```rust
    info!("nession-server {} starting", env!("CARGO_PKG_VERSION"));
    info!("Listen address: {}", config.listen_address);
    info!("Database: {}", config.db_path);

    // Ensure component directories exist
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Import and run the server components
    use nession_server::db::Database;
    use nession_server::server::WebSocketServer;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let _database = Database::new(&config.db_path).await?;
```

- [ ] **Step 2: Update nession-server/src/main.rs — remove inline fallback and add ensure_component_dirs()**

Edit `crates/nession-server/src/main.rs`.

First, in `load_config()` (line 60), replace the inline `db_path` fallback:

```rust
            db_path: nession_common::paths::server_db_path().to_string_lossy().into_owned(),
```

Second, in `main()` (around line 26-28), add `ensure_component_dirs()` call before DB init:

```rust
    // Ensure component directories exist
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let _database = Database::new(&config.db_path).await?;
```

Note: need to add `use anyhow::Context;` import at the top of `main.rs` (already present in `commands/server.rs`). Add to the imports:

```rust
use anyhow::Context;
```

Then in `main()`, add before DB init:

```rust
    // Ensure component directories exist
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let _database = Database::new(&config.db_path).await?;
```

- [ ] **Step 3: Verify full workspace compiles**

Run: `cargo check --workspace 2>&1 | tail -10`
Expected: Compiles without errors

- [ ] **Step 4: Run all tests**

Run: `cargo test --workspace 2>&1 | tail -20`
Expected: All tests pass (test db files still use tempdir/cwd, unaffected)

- [ ] **Step 5: Commit**

```bash
git add crates/nession-cli/src/commands/server.rs crates/nession-server/src/main.rs
git commit -m "feat: auto-create ~/.nession component dirs on server startup, remove inline db fallbacks"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Clean up any stale files from prior runs**

```bash
rm -f ./nession-server.db
```

- [ ] **Step 2: Build release binary**

Run: `cargo build --release 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Verify server creates files under ~/.nession/**

```bash
rm -rf ~/.nession
./target/release/nession server start --foreground &
sleep 2
ls -la ~/.nession/server/
# Expected: server.db exists
kill %1 2>/dev/null; wait 2>/dev/null
```

- [ ] **Step 4: Verify directory structure**

Run: `find ~/.nession -type f -o -type d | sort`
Expected:
```
~/.nession
~/.nession/agent
~/.nession/server
~/.nession/server/server.db
```

- [ ] **Step 5: Clean up**

```bash
rm -rf ~/.nession
```
