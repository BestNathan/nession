# Design: Agent Stable Identity & Network Change Detection

Issue: [#91](https://github.com/bestnathan/nession/issues/91)

## Overview

Nession agents currently have two reliability gaps in real-world network environments:

1. **Agent identity is not persistent across restarts.** `AgentConfig::default()` generates a random `agent-{uuid}` on every instantiation. When the agent restarts, it registers as a brand-new agent, orphaning previously owned sessions whose server-side 30s grace period hasn't yet expired.

2. **Network addresses are only detected at startup.** `build_advertised_addresses()` runs once during initialization. When the host changes networks (WiFi switch, VPN connect/disconnect, sleep/wake), the server holds stale addresses, making P2P connections unreachable.

**Solution:** File-based persistent identity + event-driven network change detection.

## Design

### 1. Persistent Agent Identity

**File:** `~/.nession/agent/identity` — plain text, single line containing the agent_id string.

**Resolution order:**
1. Config `agent_id` explicitly set → use it, **overwrite** identity file (config is authoritative)
2. Config `agent_id` empty + identity file exists with valid content → use persisted ID
3. Config `agent_id` empty + no/malformed/empty identity file → generate `agent-{uuid}`, persist, use it

**Edge cases:**

| Scenario | Behavior |
|----------|----------|
| First ever run (no config `agent_id`, no file) | Generate, persist, use |
| Config has `agent_id`, file also exists | Config wins; file overwritten |
| Identity file exists but empty/corrupt | Log warning, regenerate, persist |
| `~/.nession/agent/` directory doesn't exist | Create it before writing |
| Agent restarts rapidly (crash loop) | Each restart loads same identity → stable |
| Identity file deleted while agent is running | No effect (already in memory); next restart regenerates |

**New module:** `crates/nession-agent/src/identity.rs`

**New path helper:** `nession_common::paths::agent_identity_path()` → `~/.nession/agent/identity`

**No new dependencies** — uses `std::fs` only.

#### Kubernetes Compatibility

File-based identity also suits k8s deployment patterns:

- **StatefulSet + PVC:** Identity file persists across pod restarts; same `agent_id`, sessions survive.
- **ConfigMap/Secret mount:** Pre-provision an identity file at `~/.nession/agent/identity` so a Deployment pod gets a known, stable identity without needing PVC.
- **Config `agent_id`:** Inject via environment variable in the TOML template — no file needed, k8s-native.

No extra abstraction — file persistence and explicit config are the same mechanism from different inputs.

### 2. Network Change Detection

**New module:** `crates/nession-agent/src/netwatch.rs`

#### Platform-Specific Backends

| Platform | Mechanism | Crate |
|----------|-----------|-------|
| macOS | `SCDynamicStore` reachability + network state notifications | `system-configuration` |
| Linux | `rtnetlink` socket — `RTNLGRP_IPV4_IFADDR`, `RTNLGRP_IPV6_IFADDR`, `RTNLGRP_LINK` | `netlink-packet-route` + `netlink-proto` |

Both gated behind `#[cfg(target_os)]`. Neither compiles on the other platform.

#### Debounce

Network changes often arrive in bursts (WiFi association triggers multiple events). A 2-second debounce window coalesces rapid-fire events:

```
event → reset timer → event → reset timer → 2s silence → re-scan
```

#### Re-scan Flow

```
network change detected
  → debounce (2s)
  → call detect_local_addresses(port)
  → call build_advertised_addresses(config, port)
  → send agent.address_update to server
```

**Error handling:** If enumeration fails, keep old addresses — don't send an empty update that would strand clients. Only send when detection succeeds.

#### Extract `build_advertised_addresses`

Currently an inline function in `main.rs`. Extract into `nession-agent/src/netdetect.rs` as a public function so both startup and network watcher can call it without code duplication.

### 3. Server-Side `agent.address_update`

**New protocol message:**

```rust
// nession-common/src/protocol.rs
pub struct AgentAddressUpdatePayload {
    pub agent_id: String,
    pub addresses: Vec<AgentAddress>,
}
```

Message type: `"agent.address_update"`

**Handler behavior (server):**
1. Parse payload
2. Look up agent by `agent_id` in registry
3. If not found → ignore (old servers or race condition; graceful degradation)
4. Re-run `build_probed_addresses()` with new addresses
5. Update in-memory registry entry
6. Persist to SQLite (reuse `encode_addresses` + `insert_agent`)

**Backward compatibility:** Old servers see unknown message type and reply `None` — the agent treats no response as a best-effort fire-and-forget. No protocol version bump.

### 4. Server-Side Reconnect Reclamation

No changes needed. The existing server behavior already handles reconnection correctly:

- `agent_registry.register()` uses `HashMap::insert` which replaces the old entry by `agent_id`
- SQLite uses `INSERT OR REPLACE`
- Sessions remain keyed by `agent_id:session_name` — they survive re-registration
- Grace-period cleanup (30s) checks `agent.status == AgentStatus::Offline` before removing sessions — re-registration flips status to `Online`, so the cleanup becomes a no-op

The only missing piece was persistent agent identity — with feature 1, the agent returns with the same `agent_id` and everything works.

### 5. Wiring Into main.rs

**Startup sequence (modified):**

```
1. Load config
2. Resolve identity (new)  ← identity::resolve_agent_id()
3. Build addresses          ← netdetect::build_advertised_addresses() (extracted)
4. Connect to server        ← uses resolved identity + addresses
5. Spawn network watcher    ← netwatch::spawn(handle, config, port)
6. Start heartbeat loop
7. Start session watcher
```

**Network watcher task:**
- Receives events from platform-specific watcher
- Debounces → re-scans → sends `agent.address_update` via `ServerClientHandle`
- Runs for lifetime of agent; no shutdown coordination needed beyond process exit

### 6. Dependencies

**New crates (agent):**

| Crate | Platform | Purpose |
|-------|----------|---------|
| `system-configuration` | macOS only | `SCDynamicStore` bindings for network change notifications |
| `netlink-packet-route` | Linux only | rtnetlink message types for address/link events |
| `netlink-proto` | Linux only | rtnetlink protocol implementation |

All gated via `[target.'cfg(target_os = "macos")'.dependencies]` and `[target.'cfg(target_os = "linux")'.dependencies]` in `Cargo.toml`.

## Files Changed

| File | Change |
|------|--------|
| `nession-common/src/paths.rs` | Add `agent_identity_path()` |
| `nession-common/src/protocol.rs` | Add `AgentAddressUpdatePayload` |
| `nession-agent/Cargo.toml` | Add platform-gated deps |
| `nession-agent/src/identity.rs` | **New** — resolve/persist agent identity |
| `nession-agent/src/netwatch.rs` | **New** — platform network monitoring + debounce |
| `nession-agent/src/netdetect.rs` | Extract `build_advertised_addresses()` from main.rs |
| `nession-agent/src/lib.rs` | Export `identity`, `netwatch` modules |
| `nession-agent/src/main.rs` | Wire identity, call extracted fn, spawn netwatch |
| `nession-server/src/server/handler.rs` | Handle `"agent.address_update"` message type |

## Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| SC1 | Agent restart → same agent_id in server | Restart agent, check `client.agents.list` — same ID |
| SC2 | Restart within 30s → sessions survive | Restart agent within grace period, sessions remain attached |
| SC3 | First run creates identity file | Check `~/.nession/agent/identity` exists with valid content |
| SC4 | WiFi change → addresses update within 5s | Switch networks, server reflects new addresses |
| SC5 | VPN connect/disconnect → addresses update | Connect VPN, addresses include VPN interface IPs |
| SC6 | Config `agent_id` takes priority | Set `agent_id` in config, verity it overrides identity file |
| SC7 | Missing/corrupt identity file → regenerate | Delete file, restart agent, new identity created |
| SC8 | Old server ignores `agent.address_update` | Agent connects to server without handler; no error, continues normally |

## Non-Goals

- Multi-agent cluster or failover — one agent per machine, one identity per machine
- Changing server-side session cleanup policy (30s grace period is adequate)
- Agent authentication changes beyond existing `auth_token` mechanism
- Real-time network quality metrics (latency, bandwidth) — just address availability
- Windows network detection
- Hardware-bound identity (TPM, machine ID)
- Identity migration/merge between machines
