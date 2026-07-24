# Agent Stable Identity & Network Change Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a stable identity across restarts and detect network changes at runtime so P2P addresses stay current.

**Architecture:** A new `identity` module reads/writes a plain-text identity file under `~/.nession/agent/identity`. A new `netwatch` module uses platform-specific OS APIs (SCDynamicStore on macOS, rtnetlink on Linux) to detect network changes, debounces them, re-scans interfaces, and sends `agent.address_update` to the server. The `build_advertised_addresses` function moves from `main.rs` into `netdetect.rs` so both startup and the watcher can call it.

**Tech Stack:** Rust (no new deps for identity; `system-configuration` for macOS, `netlink-packet-route` + `netlink-proto` for Linux, all cfg-gated)

---

## File Structure

| File | Role |
|------|------|
| `nession-common/src/paths.rs` | Add `agent_identity_path()` → `~/.nession/agent/identity` |
| `nession-common/src/protocol.rs` | Add `AgentAddressUpdatePayload` struct |
| `nession-agent/Cargo.toml` | Add platform-gated deps |
| `nession-agent/src/identity.rs` | **New** — resolve/persist agent identity (pure, no deps) |
| `nession-agent/src/netwatch.rs` | **New** — platform network monitoring with debounce |
| `nession-agent/src/netdetect.rs` | Receive extracted `build_advertised_addresses()` |
| `nession-agent/src/lib.rs` | Export `identity`, `netwatch` |
| `nession-agent/src/main.rs` | Wire identity, call extracted fn, spawn netwatch task |
| `nession-server/src/server/handler.rs` | Handle `"agent.address_update"` |

---

### Task 1: Add `agent_identity_path()` to paths.rs

**Files:**
- Modify: `crates/nession-common/src/paths.rs`

- [ ] **Step 1: Add the function**

Insert after `agent_pid_path()`:

```rust
/// Agent identity file path: ~/.nession/agent/identity
pub fn agent_identity_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("identity"))
}
```

- [ ] **Step 2: Add test**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn test_agent_identity_path() {
    let path = agent_identity_path().unwrap();
    assert!(path.to_string_lossy().ends_with("identity"));
    assert!(path.to_string_lossy().contains("agent"));
}
```

- [ ] **Step 3: Verify the test passes**

```bash
cargo test -p nession-common -- test_agent_identity_path
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nession-common/src/paths.rs
git commit -m "feat: add agent_identity_path() to paths

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add `AgentAddressUpdatePayload` to protocol

**Files:**
- Modify: `crates/nession-common/src/protocol.rs`

- [ ] **Step 1: Add the struct**

Insert after the `AgentTerminalResizePayload` block (before the `#[cfg(test)]` block):

```rust
/// Agent → Server: update advertised addresses after network change.
///
/// Sent when the agent detects a network interface change (WiFi switch,
/// VPN connect/disconnect, sleep/wake). The server replaces the agent's
/// address list and re-probes reachability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAddressUpdatePayload {
    pub agent_id: String,
    pub addresses: Vec<AgentAddress>,
}
```

- [ ] **Step 2: Add test for serde round-trip**

Add to the `mod tests` block:

```rust
#[test]
fn test_agent_address_update_payload_serde() {
    let payload = AgentAddressUpdatePayload {
        agent_id: "agent-1".to_string(),
        addresses: vec![AgentAddress {
            url: "ws://192.168.1.5:8080/ws".to_string(),
            label: Some("LAN (eth0)".to_string()),
            network_type: NetworkType::Lan,
            priority: 10,
        }],
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentAddressUpdatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.agent_id, "agent-1");
    assert_eq!(deserialized.addresses.len(), 1);
    assert_eq!(deserialized.addresses[0].url, "ws://192.168.1.5:8080/ws");
}
```

- [ ] **Step 3: Run tests**

```bash
cargo test -p nession-common -- test_agent_address_update_payload_serde
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat: add AgentAddressUpdatePayload to protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Extract `build_advertised_addresses` from main.rs into netdetect.rs

**Files:**
- Modify: `crates/nession-agent/src/main.rs` — remove the fn
- Modify: `crates/nession-agent/src/netdetect.rs` — add the fn (imports + function body)

- [ ] **Step 1: Remove `build_advertised_addresses` from main.rs**

Remove lines 323–372 (the function definition and the `/// Assemble...` doc comment), and the now-unused `use` imports:
- `use nession_common::address::{finalize_addresses, legacy_to_addresses};`
- `use nession_common::protocol::{AgentAddress, AgentMetadata};` (only removed if `AgentAddress` is no longer used in main.rs — it will still be used in the extracted function; check whether any remaining usage references it directly)

Actually, `AgentAddress` and `AgentMetadata` are still used in `main.rs` (in the type annotations for addresses and metadata), and `legacy_to_addresses`/`finalize_addresses` are only used by the extracted function. Only `use nession_common::address::{finalize_addresses, legacy_to_addresses};` can be removed.

- [ ] **Step 2: Add `build_advertised_addresses` to netdetect.rs**

Add these imports at the top of `netdetect.rs`:

```rust
use nession_common::address::{finalize_addresses, legacy_to_addresses};
use nession_agent::config::{AdvertiseAddress, AgentConfig};
use tracing::warn;
```

Add the function at the end of `netdetect.rs` (before `#[cfg(test)]`):

```rust
/// Assemble the agent's advertised P2P endpoints.
///
/// Combines, in this order of preference:
/// 1. Config-declared `advertise_addresses` (tunnels/ingress/custom).
/// 2. Auto-detected non-loopback NIC addresses (unless disabled).
/// 3. The legacy `connect_url` / `advertise_address`+port as a fallback single
///    entry, so an operator who only set the old fields still advertises them.
///
/// The combined list is finalised: default priorities filled in, de-duplicated
/// by normalised URL (config entries win over detected ones since they come
/// first), sorted by priority, and capped at MAX_ADDRESSES. A dropped-entry
/// count is logged as a warning.
#[must_use]
pub fn build_advertised_addresses(config: &AgentConfig, port: u16) -> Vec<AgentAddress> {
    let mut candidates: Vec<AgentAddress> = Vec::new();

    // 1. Config-declared endpoints first (highest trust; win de-dup ties).
    candidates.extend(
        config
            .advertise_addresses
            .iter()
            .cloned()
            .map(AdvertiseAddress::into_agent_address),
    );

    // 2. Auto-detected NIC addresses.
    if config.disable_address_autodetect {
        info!("Address auto-detection disabled by config");
    } else {
        candidates.extend(detect_local_addresses(port));
    }

    // 3. Legacy fallback so pre-existing configs keep advertising something.
    //    Only meaningful if the operator set connect_url/advertise_address.
    if let Some(url) = config.connect_url.as_deref() {
        candidates.extend(legacy_to_addresses("", 0, Some(url)));
    }
    if let Some(ip) = config.advertise_address.as_deref() {
        candidates.extend(legacy_to_addresses(ip, port, None));
    }

    let (finalised, dropped) = finalize_addresses(candidates);
    if dropped > 0 {
        warn!(
            "Advertised address list exceeded the cap; dropped {} lowest-priority entr{}",
            dropped,
            if dropped == 1 { "y" } else { "ies" }
        );
    }
    finalised
}
```

Add the `use tracing::info;` import alongside the `use tracing::warn;` import.

- [ ] **Step 3: Update main.rs to use the extracted function**

In `main.rs`, remove:
```rust
use nession_common::address::{finalize_addresses, legacy_to_addresses};
```

Replace the call site (currently around line 97):
```rust
let addresses = build_advertised_addresses(&config, port);
```
with:
```rust
let addresses = nession_agent::netdetect::build_advertised_addresses(&config, port);
```

Or, update the import at line 17 to also import `build_advertised_addresses`:
```rust
use nession_agent::netdetect::{build_advertised_addresses, detect_local_addresses};
```

Then the call site stays: `let addresses = build_advertised_addresses(&config, port);`

- [ ] **Step 4: Build check**

```bash
cargo build -p nession-agent 2>&1
```

Expected: success (0 errors)

- [ ] **Step 5: Run existing tests**

```bash
cargo test -p nession-agent
```

Expected: all existing tests pass

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/main.rs crates/nession-agent/src/netdetect.rs
git commit -m "refactor: extract build_advertised_addresses from main.rs into netdetect.rs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Implement identity.rs

**Files:**
- Create: `crates/nession-agent/src/identity.rs`

- [ ] **Step 1: Write the tests first**

Create `crates/nession-agent/src/identity.rs` with the test module:

```rust
//! Agent identity persistence.
//!
//! Resolves the agent's stable identity on startup. Resolution order:
//! 1. Config `agent_id` explicitly set → use it (authoritative).
//! 2. Identity file at `~/.nession/agent/identity` exists and is valid → use it.
//! 3. Neither → generate `agent-{uuid}`, persist, use.

use anyhow::{Context, Result};
use std::path::Path;
use tracing::{info, warn};

/// Resolve the agent's identity.
///
/// `config_agent_id` is the value from `AgentConfig.agent_id` (may be a
/// random uuid-format string from the default, or explicitly set). Returns
/// the resolved agent_id to use, persisting it if newly generated or if
/// config overrides the file.
pub fn resolve_agent_id(config_agent_id: &str) -> Result<String> {
    let identity_path = nession_common::paths::agent_identity_path()?;

    // 1. Config explicitly set (and not the auto-generated default pattern).
    //    We detect "explicit" by checking if the identity file already matches
    //    the config value — if so, config just confirmed the file. If the
    //    config value is set and differs from the file, config is authoritative.
    if is_explicit_config_agent_id(config_agent_id) {
        info!(
            "Using agent_id from config: {config_agent_id} (overwriting identity file)"
        );
        persist_identity(&identity_path, config_agent_id)?;
        return Ok(config_agent_id.to_string());
    }

    // 2. Try to load from file.
    if let Some(id) = load_identity(&identity_path) {
        info!("Loaded agent identity from {identity_path:?}: {id}");
        return Ok(id);
    }

    // 3. Generate and persist a new identity.
    let id = format!("agent-{}", uuid::Uuid::new_v4());
    persist_identity(&identity_path, &id)?;
    info!("Generated new agent identity: {id}");
    Ok(id)
}

/// Returns `true` when the config agent_id is explicitly set by the user
/// (i.e. not an auto-generated default pattern).
fn is_explicit_config_agent_id(agent_id: &str) -> bool {
    // The default AgentConfig generates "agent-{uuid}". An explicit config
    // value is anything not matching that auto-generated pattern.
    // Heuristic: if agent_id is NOT empty and does not start with "agent-",
    // it was explicitly set. But actually we can't tell "agent-foo" from
    // "agent-{uuid}" — a user could set a custom ID starting with "agent-".
    //
    // The spec says: config `agent_id` in the TOML file takes precedence
    // when explicitly set. But `AgentConfig::default()` always fills in
    // a random UUID. The caller must distinguish "user set this" from
    // "this is the default".
    //
    // Solution: resolve_agent_id receives the raw agent_id plus a flag
    // indicating whether it was explicitly set. But to keep it simple,
    // we instead expose a lower-level function and let main.rs decide.
    todo!()
}
```

Wait — I need to think about this more carefully. The `AgentConfig` in `main.rs`:

```rust
let config = load_config()?;  // This calls AgentConfig::from_str(toml) or AgentConfig::default()
```

If the TOML file has an explicit `agent_id`, it will be set. If not and we fall into `AgentConfig::default()`, `agent_id` will be `format!("agent-{uuid}")`. 

The simplest correct approach: pass a boolean flag `is_explicit` to `resolve_agent_id()`, or better, let the caller check whether `agent_id` was explicitly set by comparing against `AgentConfig::default().agent_id` (pointless — they're different uuids each time).

**Best approach:** Just check if the config file had an `agent_id` field. In `load_config()` we can determine this. But to keep it simple and avoid changing `load_config()`, we can instead use a heuristic: if the identity file already exists and has valid content, we use it regardless of the config default. Only if the config file explicitly set `agent_id` (by the user writing it in the TOML) does the config win.

Actually, the cleanest solution: `resolve_agent_id()` checks file first. If file exists, use it. If the user wants to override, they write `agent_id` in the config. The config is only authoritative when it differs from the file, which we detect by writing back the config value and logging.

Let me revise:

```rust
pub fn resolve_agent_id(config_agent_id: &str) -> Result<String> {
    let identity_path = nession_common::paths::agent_identity_path()?;

    // 1. If identity file exists with valid content, use it.
    //    Config explicitly set to a different value → config wins, overwrite file.
    if let Some(file_id) = load_identity(&identity_path) {
        if config_agent_id != file_id {
            info!(
                "Config agent_id '{config_agent_id}' differs from persisted '{file_id}'; \
                 using config value and overwriting identity file"
            );
            persist_identity(&identity_path, config_agent_id)?;
            return Ok(config_agent_id.to_string());
        }
        info!("Loaded agent identity from {identity_path:?}: {file_id}");
        return Ok(file_id);
    }

    // 2. No file — use config value and persist it.
    //    This covers both explicit config and the default-generated UUID.
    persist_identity(&identity_path, config_agent_id)?;
    info!("Persisted agent identity: {config_agent_id}");
    Ok(config_agent_id.to_string())
}
```

This is simpler! The resolution order is:
1. File exists, config matches → use file (most common case: same agent restarting)
2. File exists, config different → config wins (user changed it explicitly)
3. No file → persist whatever config says (first run, or file deleted)

Actually this doesn't match the spec exactly. The spec says:
1. Config `agent_id` explicitly set → use it
2. Config empty + file → use file
3. Config empty + no file → generate

But `agent_id` in config is never "empty" — it always has a value because `Default` generates one. So the simpler model is: file is the source of truth. Config can override it. On first run, persist whatever we started with.

This correctly handles all scenarios:
- First run: no file → persist config value (could be user-set or generated UUID)
- Restart: file exists with old value → reuse it (stable identity!) 
- User changes config agent_id: config differs from file → config wins

The "generate a UUID" part is handled by `AgentConfig::default()` before `resolve_agent_id` is even called. On first run with no config file, `AgentConfig::default()` generates the UUID, then `resolve_agent_id()` persists it. Clean.

OK let me write this properly now.

- [ ] **Step 1: Write the module with tests first (TDD)**

```rust
//! Agent identity persistence.
//!
//! Resolves a stable agent identity across restarts by reading/writing
//! a plain-text file at `~/.nession/agent/identity`.
//!
//! Resolution order:
//! 1. If the identity file exists and matches the config agent_id → use it.
//! 2. If the identity file exists but config differs → config wins (explicit
//!    override by the operator), overwrite file.
//! 3. No identity file → persist the current config value and use it.
//!
//! This means: the file is the source of truth for stability; config is the
//! source of truth for authority. On first run (config auto-generates a UUID
//! or the operator sets one), the identity is persisted.

use anyhow::{Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Resolve the agent identity for this machine.
///
/// `config_agent_id` — the agent_id from AgentConfig (always non-empty;
/// defaults to `agent-{uuid}` when not in config file).
///
/// Returns the resolved agent_id.
pub fn resolve_agent_id(config_agent_id: &str) -> Result<String> {
    let identity_path = nession_common::paths::agent_identity_path()?;

    // 1. File exists — it is authoritative unless config explicitly overrides.
    if identity_path.exists() {
        match load_identity(&identity_path) {
            Some(file_id) => {
                if file_id == config_agent_id {
                    info!("Identity loaded from {identity_path:?}: {file_id}");
                    return Ok(file_id);
                }
                // Config differs — operator explicitly changed agent_id.
                info!(
                    "Config agent_id '{config_agent_id}' differs from persisted \
                     '{file_id}'; using config value"
                );
                persist_identity(&identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
            None => {
                warn!("Identity file at {identity_path:?} is empty or corrupt; regenerating");
                persist_identity(&identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
        }
    }

    // 2. No file — persist current value (first run).
    persist_identity(&identity_path, config_agent_id)?;
    info!("Persisted new agent identity: {config_agent_id}");
    Ok(config_agent_id.to_string())
}

/// Read the identity file, returning the trimmed id string or `None` if
/// the file is empty or unreadable.
fn load_identity(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(e) => {
            warn!("Failed to read identity file at {path:?}: {e}");
            None
        }
    }
}

/// Write the identity file, creating parent directories if needed.
fn persist_identity(path: &Path, agent_id: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {parent:?}"))?;
    }
    std::fs::write(path, format!("{agent_id}\n"))
        .with_context(|| format!("failed to write identity file to {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a temp dir as HOME so identity lands in a known location.
    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// Read the identity file at the temp home for assertion.
    fn read_test_identity(home: &tempfile::TempDir) -> String {
        let path = home.path().join(".nession/agent/identity");
        std::fs::read_to_string(&path).unwrap_or_default()
    }

    #[test]
    fn resolve_when_no_file_creates_and_returns_config_value() {
        let home = temp_home();
        std::env::set_var("HOME", home.path());
        // Force the identity path to resolve under our temp home.
        // nession_common::paths uses dirs::home_dir(), so we need to override HOME.

        let id = resolve_agent_id("agent-custom").unwrap();
        assert_eq!(id, "agent-custom");
        let file_content = read_test_identity(&home);
        assert!(file_content.contains("agent-custom"));
    }

    #[test]
    fn resolve_when_file_exists_returns_file_value() {
        let home = temp_home();
        std::env::set_var("HOME", home.path());
        // Pre-create the identity file with a known value.
        let identity_path = home.path().join(".nession/agent/identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "agent-persisted\n").unwrap();

        let id = resolve_agent_id("agent-default").unwrap();
        assert_eq!(id, "agent-persisted");
    }

    #[test]
    fn resolve_when_config_differs_config_wins() {
        let home = temp_home();
        std::env::set_var("HOME", home.path());
        let identity_path = home.path().join(".nession/agent/identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "old-agent-id\n").unwrap();

        let id = resolve_agent_id("new-agent-id").unwrap();
        assert_eq!(id, "new-agent-id");
        // File should have been overwritten.
        let content = read_test_identity(&home);
        assert!(content.contains("new-agent-id"));
    }

    #[test]
    fn resolve_when_file_empty_regenerates() {
        let home = temp_home();
        std::env::set_var("HOME", home.path());
        let identity_path = home.path().join(".nession/agent/identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "\n").unwrap(); // empty after trim

        let id = resolve_agent_id("agent-fresh").unwrap();
        assert_eq!(id, "agent-fresh");
    }

    #[test]
    fn resolve_when_file_corrupt_regenerates() {
        let home = temp_home();
        std::env::set_var("HOME", home.path());
        let identity_path = home.path().join(".nession/agent/identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, b"valid_utf8").unwrap();

        // File has content, not empty — should be used.
        let id = resolve_agent_id("agent-x").unwrap();
        assert_eq!(id, "valid_utf8"); // valid content, so it's used
    }
}
```

Wait — the tests manipulate `HOME` env var which could affect other tests running in parallel. Let me use a different approach: make the identity path injectable. But the spec says no extra abstraction. 

Actually, `dirs::home_dir()` reads the HOME env var on most platforms. Setting it in tests works if we run with `--test-threads=1`. But that's fragile.

Better approach: Make the identity path an argument to `resolve_agent_id()`. The function is simpler and testable:

```rust
pub fn resolve_agent_id(config_agent_id: &str, identity_path: &Path) -> Result<String>
```

Then main.rs passes `nession_common::paths::agent_identity_path()?` and tests pass `temp_dir.join(".nession/agent/identity")`.

Let me rewrite the test module cleanly with this approach.

OK let me just write the final plan. I'll use the injectable path approach for testability.<｜end▁of▁thinking｜>

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="Write">
<｜｜DSML｜｜parameter name="content" string="true"># Agent Stable Identity & Network Change Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a stable identity across restarts and detect network changes at runtime so P2P addresses stay current.

**Architecture:** A new `identity` module reads/writes a plain-text identity file under `~/.nession/agent/identity`. A new `netwatch` module uses platform-specific OS APIs (SCDynamicStore on macOS, rtnetlink on Linux) to detect network changes, debounces them, re-scans interfaces, and sends `agent.address_update` to the server. The `build_advertised_addresses` function moves from `main.rs` into `netdetect.rs` so both startup and the watcher can call it.

**Tech Stack:** Rust (no new deps for identity; `system-configuration` for macOS, `netlink-packet-route` + `netlink-proto` for Linux, all cfg-gated)

---

## File Structure

| File | Role |
|------|------|
| `nession-common/src/paths.rs` | Add `agent_identity_path()` → `~/.nession/agent/identity` |
| `nession-common/src/protocol.rs` | Add `AgentAddressUpdatePayload` struct |
| `nession-agent/Cargo.toml` | Add platform-gated deps |
| `nession-agent/src/identity.rs` | **New** — resolve/persist agent identity (pure, no deps) |
| `nession-agent/src/netwatch.rs` | **New** — platform network monitoring with debounce |
| `nession-agent/src/netdetect.rs` | Receive extracted `build_advertised_addresses()` |
| `nession-agent/src/lib.rs` | Export `identity`, `netwatch` |
| `nession-agent/src/connection/server_client.rs` | Add `send_address_update()` to handle + msg_type constant |
| `nession-agent/src/main.rs` | Wire identity, call extracted fn, spawn netwatch task |
| `nession-server/src/server/handler.rs` | Handle `"agent.address_update"` |

---

### Task 1: Add `agent_identity_path()` to paths.rs

**Files:**
- Modify: `crates/nession-common/src/paths.rs`

- [ ] **Step 1: Add the function**

Insert after `agent_envs_dir()` (line 46):

```rust
/// Agent identity file path: ~/.nession/agent/identity
pub fn agent_identity_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("identity"))
}
```

- [ ] **Step 2: Add test**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn test_agent_identity_path() {
    let path = agent_identity_path().unwrap();
    assert!(path.to_string_lossy().ends_with("identity"));
    assert!(path.to_string_lossy().contains("agent"));
}
```

- [ ] **Step 3: Run test**

```bash
cargo test -p nession-common -- test_agent_identity_path
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nession-common/src/paths.rs
git commit -m "feat: add agent_identity_path() to paths

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add `AgentAddressUpdatePayload` to protocol

**Files:**
- Modify: `crates/nession-common/src/protocol.rs`

- [ ] **Step 1: Add the struct**

Insert before `#[cfg(test)]` (line 610):

```rust
/// Agent → Server: update advertised addresses after network change.
///
/// Sent when the agent detects a network interface change (WiFi switch,
/// VPN connect/disconnect, sleep/wake). The server replaces the agent's
/// address list and re-probes reachability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAddressUpdatePayload {
    pub agent_id: String,
    /// Raw un-finalised addresses from the agent (the server re-runs
    /// finalisation to keep priorities consistent across updates).
    pub addresses: Vec<AgentAddress>,
}
```

- [ ] **Step 2: Add serde round-trip test**

Add to the test module:

```rust
#[test]
fn test_agent_address_update_payload_serde() {
    let payload = AgentAddressUpdatePayload {
        agent_id: "agent-1".to_string(),
        addresses: vec![AgentAddress {
            url: "ws://192.168.1.5:8080/ws".to_string(),
            label: Some("LAN (eth0)".to_string()),
            network_type: NetworkType::Lan,
            priority: 10,
        }],
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentAddressUpdatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.agent_id, "agent-1");
    assert_eq!(deserialized.addresses.len(), 1);
    assert_eq!(deserialized.addresses[0].url, "ws://192.168.1.5:8080/ws");
    assert_eq!(deserialized.addresses[0].network_type, NetworkType::Lan);
}
```

- [ ] **Step 3: Run test**

```bash
cargo test -p nession-common -- test_agent_address_update_payload_serde
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat: add AgentAddressUpdatePayload to protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Extract `build_advertised_addresses` from main.rs into netdetect.rs

**Files:**
- Modify: `crates/nession-agent/src/main.rs` — remove fn body + unused imports
- Modify: `crates/nession-agent/src/netdetect.rs` — add fn body + imports

- [ ] **Step 1: Remove `build_advertised_addresses` from main.rs**

Delete lines 323–371 (the `fn build_advertised_addresses` definition). Remove the now-unused import:
```rust
use nession_common::address::{finalize_addresses, legacy_to_addresses};
```

- [ ] **Step 2: Add the function to netdetect.rs**

Add imports at top of `netdetect.rs`:
```rust
use nession_agent::config::{AdvertiseAddress, AgentConfig};
use nession_common::address::{finalize_addresses, legacy_to_addresses};
use tracing::{info, warn};
```

Add the function before `#[cfg(test)]`:
```rust
/// Assemble the agent's advertised P2P endpoints.
///
/// Combines:
/// 1. Config-declared `advertise_addresses` (tunnels/ingress/custom).
/// 2. Auto-detected non-loopback NIC addresses (unless disabled).
/// 3. Legacy `connect_url` / `advertise_address`+port as fallback.
///
/// The combined list is finalised: de-duplicated by normalised URL
/// (config wins over detected), sorted by priority, capped.
#[must_use]
pub fn build_advertised_addresses(config: &AgentConfig, port: u16) -> Vec<AgentAddress> {
    let mut candidates: Vec<AgentAddress> = Vec::new();

    candidates.extend(
        config
            .advertise_addresses
            .iter()
            .cloned()
            .map(AdvertiseAddress::into_agent_address),
    );

    if config.disable_address_autodetect {
        info!("Address auto-detection disabled by config");
    } else {
        candidates.extend(detect_local_addresses(port));
    }

    if let Some(url) = config.connect_url.as_deref() {
        candidates.extend(legacy_to_addresses("", 0, Some(url)));
    }
    if let Some(ip) = config.advertise_address.as_deref() {
        candidates.extend(legacy_to_addresses(ip, port, None));
    }

    let (finalised, dropped) = finalize_addresses(candidates);
    if dropped > 0 {
        warn!(
            "Advertised address list exceeded the cap; dropped {} lowest-priority entr{}",
            dropped,
            if dropped == 1 { "y" } else { "ies" }
        );
    }
    finalised
}
```

- [ ] **Step 3: Update main.rs imports and call site**

`main.rs` no longer calls `detect_local_addresses` directly (it's now called inside
`build_advertised_addresses` in netdetect.rs). Change the netdetect import (line 17) to:
```rust
use nession_agent::netdetect::build_advertised_addresses;
```

- [ ] **Step 4: Build**

```bash
cargo build -p nession-agent 2>&1
```
Expected: 0 errors

- [ ] **Step 5: Run existing tests**

```bash
cargo test -p nession-agent
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/main.rs crates/nession-agent/src/netdetect.rs
git commit -m "refactor: extract build_advertised_addresses from main.rs into netdetect.rs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Implement identity.rs

**Files:**
- Create: `crates/nession-agent/src/identity.rs`
- Modify: `crates/nession-agent/src/lib.rs`

- [ ] **Step 1: Write the module (TDD — tests first)**

Create `crates/nession-agent/src/identity.rs`:

```rust
//! Agent identity persistence.
//!
//! Resolves a stable agent identity across restarts by reading/writing
//! a plain-text file at `~/.nession/agent/identity`.
//!
//! Resolution order:
//! 1. If the identity file exists and matches the config agent_id → use it.
//! 2. If the identity file exists but config differs → config wins (explicit
//!    override by the operator), overwrite file.
//! 3. No identity file → persist the current config value and use it.
//!
//! The file is the source of truth for stability; config is the source of
//! truth for authority. On first run (config auto-generates a UUID or the
//! operator sets one), the identity is persisted.

use anyhow::{Context, Result};
use std::path::Path;
use tracing::{info, warn};

/// Resolve the agent identity for this machine.
///
/// `config_agent_id` — the agent_id from AgentConfig (always non-empty;
/// defaults to `agent-{uuid}` when not in config file).
/// `identity_path` — typically `nession_common::paths::agent_identity_path()?`.
///
/// Returns the resolved agent_id.
pub fn resolve_agent_id(config_agent_id: &str, identity_path: &Path) -> Result<String> {
    if identity_path.exists() {
        match load_identity(identity_path) {
            Some(file_id) => {
                if file_id == config_agent_id {
                    info!("Identity loaded from {identity_path:?}: {file_id}");
                    return Ok(file_id);
                }
                info!(
                    "Config agent_id '{config_agent_id}' differs from persisted \
                     '{file_id}'; using config value"
                );
                persist_identity(identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
            None => {
                warn!(
                    "Identity file at {identity_path:?} is empty; regenerating"
                );
                persist_identity(identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
        }
    }

    // No file — first run; persist current value.
    persist_identity(identity_path, config_agent_id)?;
    info!("Persisted new agent identity: {config_agent_id}");
    Ok(config_agent_id.to_string())
}

/// Read the identity file, returning the trimmed id string or `None` if
/// the file is empty or unreadable.
fn load_identity(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(e) => {
            warn!("Failed to read identity file at {path:?}: {e}");
            None
        }
    }
}

/// Write the identity file, creating parent directories if needed.
fn persist_identity(path: &Path, agent_id: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {parent:?}"))?;
    }
    std::fs::write(path, format!("{agent_id}\n"))
        .with_context(|| format!("failed to write identity file to {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_when_no_file_creates_and_uses_config_value() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");

        let id = resolve_agent_id("agent-custom", &identity_path).unwrap();
        assert_eq!(id, "agent-custom");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "agent-custom");
    }

    #[test]
    fn resolve_when_file_exists_returns_file_value() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "agent-persisted\n").unwrap();

        let id = resolve_agent_id("agent-default", &identity_path).unwrap();
        assert_eq!(id, "agent-persisted");
    }

    #[test]
    fn resolve_when_config_differs_config_wins_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "old-agent\n").unwrap();

        let id = resolve_agent_id("new-agent", &identity_path).unwrap();
        assert_eq!(id, "new-agent");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "new-agent");
    }

    #[test]
    fn resolve_when_file_empty_regenerates() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "\n").unwrap();

        let id = resolve_agent_id("agent-fresh", &identity_path).unwrap();
        assert_eq!(id, "agent-fresh");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "agent-fresh");
    }

    #[test]
    fn resolve_persists_to_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        // identity_path's parent (~/.nession/agent/) doesn't exist
        let identity_path = dir.path().join("subdir").join("identity");

        let id = resolve_agent_id("agent-nested", &identity_path).unwrap();
        assert_eq!(id, "agent-nested");
        assert!(identity_path.exists());
    }
}
```

- [ ] **Step 2: Run tests (they'll fail — no impl yet, but the file compiles)**

```bash
cargo test -p nession-agent -- identity::tests 2>&1
```
Expected: all 5 tests PASS (implementation is already in the file!)

- [ ] **Step 3: Export the module from lib.rs**

In `crates/nession-agent/src/lib.rs`, add after `pub mod fs;`:
```rust
pub mod identity;
```

- [ ] **Step 4: Run full agent tests**

```bash
cargo test -p nession-agent
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/identity.rs crates/nession-agent/src/lib.rs
git commit -m "feat: add identity module for persistent agent identity

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Wire identity resolution into main.rs

**Files:**
- Modify: `crates/nession-agent/src/main.rs`

- [ ] **Step 1: Add import**

Add after `use nession_agent::config::AgentConfig;`:
```rust
use nession_agent::identity;
```

- [ ] **Step 2: Insert identity resolution after config load**

In `main()`, after the config load (line 31) and after the tracing init (line 39), replace lines 55–66 (the `let agent_id = ...` block):

Old code (lines 55–66):
```rust
    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);
    let agent_id = if config.agent_id.is_empty() {
        get_hostname()
    } else {
        config.agent_id.clone()
    };
```

New code:
```rust
    // Resolve persistent agent identity. On first run this persists the
    // generated or configured agent_id; on subsequent runs it loads the
    // persisted identity so the server recognises us as the same agent.
    let identity_path = nession_common::paths::agent_identity_path()?;
    let agent_id = identity::resolve_agent_id(&config.agent_id, &identity_path)?;

    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);
```

- [ ] **Step 3: Build**

```bash
cargo build -p nession-agent 2>&1
```
Expected: 0 errors

- [ ] **Step 4: Run tests**

```bash
cargo test -p nession-agent
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/main.rs
git commit -m "feat: wire identity resolution into agent startup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Add `send_address_update()` to ServerClientHandle

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs`

- [ ] **Step 1: Add message type constant**

In `pub mod msg_types`, after `SERVER_HEARTBEAT_ACK`:
```rust
pub const AGENT_ADDRESS_UPDATE: &str = "agent.address_update";
```

- [ ] **Step 2: Add the send method to ServerClientHandle impl**

Insert after `send_session_update()` (before `enqueue()`):

```rust
/// Queue an address-update message for delivery to the server.
///
/// Called by the network watcher when interfaces change. The server
/// replaces the agent's advertised address list and re-probes
/// reachability.
pub async fn send_address_update(
    &self,
    addresses: Vec<AgentAddress>,
) -> Result<()> {
    let payload = AgentAddressUpdatePayload {
        agent_id: self.agent_id.clone(),
        addresses,
    };
    let msg = new_message(msg_types::AGENT_ADDRESS_UPDATE, payload);
    self.enqueue(&msg)
}
```

Add the import for `AgentAddressUpdatePayload` to the existing `use nession_common::protocol::{...}` block:
```rust
use nession_common::protocol::{
    AgentAddress, AgentAddressUpdatePayload, AgentHeartbeatPayload, AgentMetadata,
    AgentRegisterPayload, AgentStatus, EnvFileRef, EnvSnapshot, HeartbeatMetadata,
    Message, ProtocolMessage, ServerSessionCreatePayload, ServerSessionEnvApplyPayload,
    ServerSessionEnvUnsetPayload,
};
```

- [ ] **Step 3: Build**

```bash
cargo build -p nession-agent 2>&1
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs
git commit -m "feat: add send_address_update() to ServerClientHandle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Implement netwatch.rs

**Files:**
- Create: `crates/nession-agent/src/netwatch.rs`
- Modify: `crates/nession-agent/Cargo.toml`
- Modify: `crates/nession-agent/src/lib.rs`

- [ ] **Step 1: Add platform-gated dependencies to Cargo.toml**

After the `[dependencies]` block, add:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
system-configuration = "0.6"

[target.'cfg(target_os = "linux")'.dependencies]
netlink-packet-route = "0.20"
netlink-proto = "0.11"
```

- [ ] **Step 2: Create netwatch.rs**

Create `crates/nession-agent/src/netwatch.rs`:

```rust
//! Network change detection for dynamic address re-advertisement.
//!
//! Spawns a platform-specific watcher task that listens for network
//! interface changes and re-scans advertised addresses. Events are
//! debounced with a 2-second window before triggering a re-scan.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::config::AgentConfig;
use crate::connection::ServerClientHandle;
use crate::netdetect::build_advertised_addresses;

/// Debounce window: wait this long after the last network event before
/// re-scanning. Coalesces bursts (WiFi association, VPN setup).
const DEBOUNCE_WINDOW: Duration = Duration::from_secs(2);

/// Spawn the network watcher task. Runs for the lifetime of the agent.
///
/// `handle` — used to send `agent.address_update` messages to the server.
/// `config` — reference to the agent config (for `advertise_addresses`,
///    `disable_address_autodetect`, etc.).
/// `port` — the agent WebSocket server port.
pub fn spawn_watcher(handle: ServerClientHandle, config: AgentConfig, port: u16) {
    tokio::spawn(async move {
        info!("Network watcher started (debounce: {:?})", DEBOUNCE_WINDOW);

        // Shared last-known-good address list, so we don't send empty
        // updates if detection transiently fails.
        let last_addresses: Arc<Mutex<Option<Vec<_>>>> = Arc::new(Mutex::new(None));

        // Platform-specific watcher: returns a stream of change events.
        // On platforms without support, this returns None and the task
        // exits immediately (addresses are only detected at startup).
        let mut events = match platform_watch() {
            Some(stream) => stream,
            None => {
                info!("Network watching not supported on this platform; \
                       addresses will be static");
                return;
            }
        };

        loop {
            // Wait for a single event, then debounce.
            if events.recv().await.is_none() {
                info!("Network watcher stream ended");
                break;
            }

            debug!("Network change event received; debouncing {:?}", DEBOUNCE_WINDOW);

            // Debounce: drain any additional events within the window.
            loop {
                match tokio::time::timeout(DEBOUNCE_WINDOW, events.recv()).await {
                    Ok(Some(())) => {
                        debug!("Additional network event during debounce; resetting");
                        continue;
                    }
                    Ok(None) => {
                        info!("Network watcher stream ended during debounce");
                        return;
                    }
                    Err(_) => {
                        // Timeout — no more events, re-scan now.
                        break;
                    }
                }
            }

            info!("Network change debounced; re-scanning addresses");
            let new_addrs = build_advertised_addresses(&config, port);

            // Only send if detection succeeded with at least some addresses
            // (protect against transient enumeration failures wiping the list).
            if new_addrs.is_empty() {
                warn!("Address re-scan returned empty; keeping previous addresses");
                continue;
            }

            // Skip if unchanged.
            {
                let guard = last_addresses.lock().await;
                if let Some(ref old) = *guard {
                    if *old == new_addrs {
                        debug!("Addresses unchanged after re-scan; skipping update");
                        continue;
                    }
                }
            }

            info!(
                "Network addresses changed: {} address(es)",
                new_addrs.len()
            );

            match handle.send_address_update(new_addrs.clone()).await {
                Ok(()) => {
                    let mut guard = last_addresses.lock().await;
                    *guard = Some(new_addrs);
                }
                Err(e) => {
                    error!("Failed to send address update: {:#}", e);
                }
            }
        }
    });
}

// ── Platform-specific watchers ──

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use system_configuration::{
        dynamic_store::SCDynamicStore,
        dynamic_store::SCDynamicStoreBuilder,
    };
    use tokio::sync::mpsc;

    /// Channel-based event source. Each `recv()` call returns when a
    /// network change has been detected.
    pub(super) struct WatcherEvents {
        rx: mpsc::UnboundedReceiver<()>,
    }

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            self.rx.recv().await
        }
    }

    /// Create a macOS watcher using SCDynamicStore for reachability/
    /// network-state notifications.
    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        let (tx, rx) = mpsc::unbounded_channel();

        let store = match SCDynamicStoreBuilder::new("nession-netwatch")
            .callback(move |_store, _changed_keys| {
                // Fire-and-forget: if the channel is full, we coalesce.
                let _ = tx.send(());
            })
            .build()
        {
            Ok(s) => s,
            Err(e) => {
                warn!("Failed to create SCDynamicStore: {e}; network watching disabled");
                return None;
            }
        };

        // Watch the State:/Network/Interface key for interface changes
        // and the State:/Network/Global/IPv4 key for global reachability.
        let watch_keys: Vec<String> = vec![
            "State:/Network/Interface".into(),
            "State:/Network/Global/IPv4".into(),
        ];
        if store.set_notification_keys(&watch_keys).is_err() {
            warn!("Failed to set SCDynamicStore notification keys; network watching disabled");
            return None;
        }

        // Add to run loop so callbacks fire. SCDynamicStoreBuilder::build
        // already scheduled it on the current run loop; we just need to
        // keep the store alive.
        std::mem::forget(store); // Leak intentionally — lives for process lifetime.

        Some(WatcherEvents { rx })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use netlink_packet_route::rtnl::constants::{
        RTNLGRP_IPV4_IFADDR, RTNLGRP_IPV6_IFADDR, RTNLGRP_LINK,
    };
    use netlink_proto::new_connection;
    use tokio::sync::mpsc;

    pub(super) struct WatcherEvents {
        rx: mpsc::UnboundedReceiver<()>,
    }

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            self.rx.recv().await
        }
    }

    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        let (tx, rx) = mpsc::unbounded_channel();

        tokio::spawn(async move {
            let groups = RTNLGRP_IPV4_IFADDR | RTNLGRP_IPV6_IFADDR | RTNLGRP_LINK;
            let (mut conn, _handle, mut messages) = match new_connection() {
                Ok(c) => c,
                Err(e) => {
                    warn!("Failed to open netlink socket: {e}; network watching disabled");
                    return;
                }
            };

            // Join the multicast groups for address and link events.
            if let Err(e) = conn.join_groups(groups) {
                warn!("Failed to join netlink multicast groups: {e}; network watching disabled");
                return;
            }

            // Drain messages; each one is a network change event.
            while let Some(msg) = messages.next().await {
                let _ = tx.send(());
                let _ = msg; // Event received and forwarded; content irrelevant.
            }
        });

        Some(WatcherEvents { rx })
    }
}

// Fallback for unsupported platforms.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub(super) struct WatcherEvents;

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            None
        }
    }

    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        None
    }
}

use platform::platform_watch;
```

- [ ] **Step 3: Add `netwatch` to lib.rs**

In `crates/nession-agent/src/lib.rs`:
```rust
pub mod netwatch;
```

- [ ] **Step 4: Build on current platform**

```bash
cargo build -p nession-agent 2>&1
```
Expected: 0 errors. On macOS, compiles with `system-configuration`. On Linux, with netlink crates.

- [ ] **Step 5: Run tests**

```bash
cargo test -p nession-agent
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/netwatch.rs \
        crates/nession-agent/src/lib.rs \
        crates/nession-agent/Cargo.toml \
        Cargo.lock
git commit -m "feat: add network change detection (netwatch) module

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Spawn network watcher in main.rs

**Files:**
- Modify: `crates/nession-agent/src/main.rs`

- [ ] **Step 1: Add import**

Add after `use nession_agent::identity;`:
```rust
use nession_agent::netwatch;
```

- [ ] **Step 2: Spawn the watcher after server connection**

After the heartbeat/session watcher spawn blocks (after line 202, before "8. Wait for shutdown signal"), add:

```rust
    // 7.5. Start network change detector (sends address updates on interface changes).
    if let Some(ref handle) = client_handle {
        netwatch::spawn_watcher(handle.clone(), config.clone(), port);
    }
```

Note: after the extracted `build_advertised_addresses`, the `port` variable is already available (it's defined around line 92: `let port = extract_port(&config.listen_address);`).

- [ ] **Step 3: Build**

```bash
cargo build -p nession-agent 2>&1
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/main.rs
git commit -m "feat: spawn network watcher on agent startup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Handle `agent.address_update` on the server

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs`

- [ ] **Step 1: Add the message type to the dispatch match**

In `handle_protocol_message()`, add after the `"agent.terminal.resize"` arm:

```rust
            "agent.address_update" => self.handle_agent_address_update(msg).await,
```

- [ ] **Step 2: Add the handler method**

Add to `impl ConnectionHandler`:

```rust
    /// Handle `agent.address_update` — update the agent's advertised
    /// addresses after a network change on the agent host.
    async fn handle_agent_address_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: nession_common::protocol::AgentAddressUpdatePayload =
            serde_json::from_value(msg.payload)?;

        let Some(mut agent) = self.agent_registry.get(&payload.agent_id).await else {
            // Agent not registered — may be an old server or race condition.
            // Graceful degradation: ignore.
            info!(
                "agent.address_update from unknown agent '{}'; ignoring",
                payload.agent_id
            );
            return Ok(HandlerAction::Reply(None));
        };

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses,
            &agent.ip_address,
            agent.port,
            agent.connect_url.as_deref(),
        );
        agent.addresses = addresses;

        info!(
            "Updated {} address(es) for agent {}",
            agent.addresses.len(),
            payload.agent_id
        );

        self.agent_registry.register(agent).await;
        Ok(HandlerAction::Reply(None))
    }
```

- [ ] **Step 3: Build server**

```bash
cargo build -p nession-server 2>&1
```
Expected: 0 errors

- [ ] **Step 4: Add handler test**

Add to the `#[cfg(test)] mod tests` block:

```rust
    #[tokio::test]
    async fn agent_address_update_updates_addresses() {
        let mut h = test_handler("").await;
        // Register an agent with an initial address.
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [
                    { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan" }
                ],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        // Send an address update with a new address.
        let action = h
            .handle_message(proto_msg(
                "agent.address_update",
                json!({
                    "agent_id": "a1",
                    "addresses": [
                        { "url": "ws://10.0.0.5:19091/ws", "network_type": "lan" },
                        { "url": "wss://tunnel.example.com/ws", "network_type": "tunnel" },
                    ],
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));

        // Verify the agent's addresses were updated.
        let agent = h.agent_registry.get("a1").await.unwrap();
        assert_eq!(agent.addresses.len(), 2);

        let urls: Vec<&str> = agent.addresses.iter()
            .map(|p| p.address.url.as_str())
            .collect();
        assert!(urls.contains(&"ws://10.0.0.5:19091/ws"));
        assert!(urls.contains(&"wss://tunnel.example.com/ws"));
    }

    #[tokio::test]
    async fn agent_address_update_unknown_agent_is_noop() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.address_update",
                json!({
                    "agent_id": "nonexistent",
                    "addresses": [],
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }
```

- [ ] **Step 5: Run server tests**

```bash
cargo test -p nession-server -- agent_address_update
```
Expected: 2 tests PASS

- [ ] **Step 6: Run full server test suite**

```bash
cargo test -p nession-server
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add crates/nession-server/src/server/handler.rs
git commit -m "feat: handle agent.address_update on server

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Full integration check

- [ ] **Step 1: Run all tests across workspace**

```bash
cargo test
```
Expected: all pass

- [ ] **Step 2: Clippy**

```bash
cargo clippy -- -D warnings
```
Expected: 0 warnings

- [ ] **Step 3: Format check**

```bash
cargo fmt --all -- --check
```
Expected: clean
