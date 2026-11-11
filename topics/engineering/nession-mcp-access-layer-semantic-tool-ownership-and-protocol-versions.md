---
title: "Nession MCP access layer semantic tool ownership and protocol versions"
description: "Four business-owned MCP Tools behind a flat startup registry, Agent-owned Session routing through the Server, and dual-era MCP 2026-07-28 / 2025-03-26 hosting"
topic: engineering
categories: ["architecture", "protocol", "agent", "integration", "ownership"]
status: verified
created_at: 2026-11-11T13:15:17Z
updated_at: 2026-11-11T13:15:17Z
sources: ["https://github.com/BestNathan/nession/issues/3264", "https://github.com/BestNathan/nession/pull/3289", "https://github.com/BestNathan/nession/blob/a571cbc810e9ed6f9c3633ce4f0c0c02c70cefa6/docs/architecture/mcp.md", "https://github.com/BestNathan/nession/blob/a571cbc810e9ed6f9c3633ce4f0c0c02c70cefa6/crates/nession-mcp/src/tools/mod.rs"]
---

# Nession MCP access layer semantic tool ownership and protocol versions

## Decision

MCP is an **application access layer** that exposes business capabilities to
AI, not a 1:1 projection of Nession Protocol endpoints. The semantic owner of a
Tool is the owner of the authoritative state or action, independent of where
the endpoint runs or how a request routes.

- **Catalog:** exactly four Tools. `nession_server_list_agents` is Server-owned
  registry discovery; `nession_agent_list_sessions`,
  `nession_agent_create_session` and `nession_agent_kill_session` are
  Agent-owned Session operations that always require an explicit, non-empty
  `agent_id`. The eight #565 Protocol-mirror projections were removed from MCP;
  their Protocol routes and Web/CLI behavior remain.
- **Structure:** one `crates/nession-mcp/src/tools/<tool_name>.rs` per Tool,
  flat with no nested owner directories. Each module owns its name,
  description, typed `serde` arguments, emitted JSON Schema (generated from the
  same type, including `additionalProperties: false`) and focused tests.
  `tools/mod.rs` only declares modules and registers handlers with one
  `ToolRegistry` built once at service startup; duplicates fail startup and
  there is no central `match name` dispatch.
- **Routing:** the Agent owns Session lifecycle and live state even when the
  caller arrives through the Server. The Server owns Agent discovery,
  authorization and routing through its command broker. Standalone hosts route
  Agent Tools through the Server's canonical route by default; an explicit
  direct-Agent mode may be configured, with a target check and no implicit
  fallback. Agent-embedded hosts use their local SessionManager and refuse any
  other Agent id.
- **Protocol:** the endpoint is dual-era and claims exactly two revisions.
  `2026-07-28` is stateless: `server/discover`, per-request `_meta` version and
  client identity, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`
  consistency (mismatch is `400`/`-32020`), unsupported versions as `-32022`
  with the supported list, no `initialize` and no `Mcp-Session-Id`.
  `2025-03-26` keeps the legacy `initialize` handshake, session lifecycle, GET
  SSE stream and `DELETE` termination. The wire grammar is owned by the
  official Rust `rmcp` SDK, driven through hyper on a host's already-accepted
  connection; Nession keeps its own ToolHandler/ToolRegistry.
- **Security and limits:** inbound bearer auth is fail-closed. A request
  presenting a browser `Origin` is refused unless it matches
  `[mcp] allowed_origins` (empty by default). The Host allowlist derives from
  the listener bind and is disabled for an unspecified bind, where bearer auth
  and the Origin policy remain the boundary. Request bodies (4 MiB), header
  read time, tool deadlines and concurrent executions are bounded. No MCP Tool
  mints or returns a P2P credential.

## Context and evidence

The contract landed with #3264 (PR #3289, merged to main as `a571cbc`; staging
`00fd6c62`). `docs/architecture/mcp.md` owns the current architecture and the
removed-Tool migration table. Acceptance evidence: SC-01/SC-08 were recorded by
the trusted Agent acceptance at the exact PR head; SC-02 through SC-07 are
source-aligned Cases at the exact merged staging SHA, including an official
`rmcp` client in both protocol eras, real Server/Agent/Standalone routing,
Origin/auth/timeout negatives and SIGTERM shutdown.

The Session authority used by the Agent-owned Tools is described by
[Session metadata and display identity ownership](session-metadata-and-display-identity-ownership.md):
both the Server and MCP route Session work to the owning Agent rather than
creating a second authority.

## Limits and when to revisit

- The service does not advertise or implement Nession Resources, Prompts,
  Tasks, MRTR, subscriptions, terminal PTY streaming, preview or attach flows.
  Only the base semantics of the two claimed versions are supported.
- The `Mcp-Param-{Name}` header mechanism (from `x-mcp-header` schema
  annotations) is implemented and tested, but no baseline Tool annotates a
  parameter today; adding one is a Tool-local schema change plus header tests.
- Legacy `2025-03-26` sessions use the SDK's in-memory session manager; there
  is no cross-instance session store. Modern requests are stateless.
- Revisit if a future revision adds required discovery/header semantics, if a
  Server-owned cluster-index Tool is approved as a separate need, or if the
  Host allowlist policy changes for non-loopback deployments.
