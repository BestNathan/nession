---
title: "Claude Code MCP configuration and Nession onboarding"
description: "Claude Code's own MCP configuration is a client-side owner: Session-scoped inventory, explicit bounded discovery, local/project mutation through the native CLI, and fail-closed Nession registration"
topic: engineering
categories: ["architecture", "integration", "security", "agent", "web", "protocol"]
status: verified
created_at: 2026-11-15T16:51:08Z
updated_at: 2026-11-15T16:51:08Z
sources: ["https://github.com/BestNathan/nession/issues/3600", "https://github.com/BestNathan/nession/pull/3667", "https://github.com/BestNathan/nession/blob/e5284b019fd8d4b0206361dd53d206042a35bcc2/docs/architecture/claude-code-mcp.md", "https://github.com/BestNathan/nession/blob/e5284b019fd8d4b0206361dd53d206042a35bcc2/crates/nession-claude-code/src/mcp/config.rs", "https://github.com/BestNathan/nession/blob/e5284b019fd8d4b0206361dd53d206042a35bcc2/crates/nession-claude-code/src/mcp/connect.rs"]
---

# Claude Code MCP configuration and Nession onboarding

## Decision

The Claude Code MCP view is a **client-side integration**, not a second
Nession MCP server and not a new top-level Workspace. The Nession MCP endpoint
continues to own its Tools and inbound authentication; this integration owns
only Claude Code's own client configuration and the contextual experience of
inspecting and changing it.

- **One context, no picker.** Every operation binds to the current Session's
  Agent, OS user, effective Claude config directory and cwd. `HOME`,
  `CLAUDE_CONFIG_DIR` and cwd come from the Session's own tmux environment, never
  from the Agent daemon's process environment. An unobservable fact yields
  `unavailable`, not a default that may belong to another user.
- **Sources and precedence.** Local state lives in
  `<config>/.claude.json` → `projects[<cwd>].mcpServers`; user state in that
  file's top-level `mcpServers`; project state in `<cwd>/.mcp.json`; managed
  state in the platform's `managed-mcp.json`. `<config>` is the Session's
  `CLAUDE_CONFIG_DIR` when set, and the state file moves with it. Precedence is
  whole-entry: managed (exclusive) > local > project > user > plugin/connectors.
  Entries are never field-merged across scopes.
- **Protocol ownership.** Four Claude units (`mcp-servers`, `mcp-server`,
  `mcp-mutate`, `mcp-connect`) plus the Server's `server.mcp.endpoint` are
  canonical, versioned contracts generated for the Web. The Claude view does not
  hard-code the Nession Tool catalog.
- **Configured is not loaded.** The inventory reads configuration files only.
  Opening the view never runs a health check, starts a stdio server, opens a
  discovery connection or calls a Tool. Discovery is a separate explicit action,
  bounded by time and bytes; stdio additionally requires explicit consent;
  WebSocket discovery, OAuth and `headersHelper` execution are unsupported.
  `load_state` is always `unknown`.
- **Mutation through the native adapter.** Local/project add/update/remove use
  the `claude mcp` CLI as an argument vector, gated on CLI version ≥ `2.0.0`.
  The adapter preserves fields and secret values the caller did not send,
  detects concurrent edits with a non-secret fingerprint, requires project-file
  confirmation, rolls back a failed replace, and re-reads the scope as the
  answer. User scope is read-only here because the non-project AI resource
  manager (#3251) owns its mutation.
- **Connect fails closed.** Nession registration resolves a real hosting mode:
  the Agent's own mounted endpoint, or the Server's reported path combined with
  the origin of the Agent's configured `server_url`. It requires
  `NESSON_MCP_TOKEN` in the Session environment and verifies it with a bounded
  MCP handshake before writing exactly one HTTP entry whose header is
  `Authorization: Bearer ${NESSON_MCP_TOKEN}`. The token value never appears in
  the protocol, a project `.mcp.json`, logs or CLI argv. Missing enablement,
  credential or CLI support is `blocked`; it never enables MCP or mints a token
  as a side effect. A matching entry is idempotent; a different one requires
  explicit conflict confirmation. `reload_required` states that a running
  Claude session does not reload configuration on its own.

## Context and evidence

The capability landed with #3600 (PR #3667, merged to `staging` as `e5284b01`).
`docs/architecture/claude-code-mcp.md` is the current architecture owner for the
context resolution, file layout, precedence, protocol units, redaction,
discovery and credential/endpoint boundary. The Web adds an `MCP` tab inside
the existing Claude Code Workspace using the approved
`ResourceDetail`/`ConfigurationForm`/`OperationSurface` recipes; it adds no
Agent picker, top-level shell or second App Back.

Acceptance evidence: SC-01 through SC-07 passed at the exact PR head; the
`fixture-app` and `fixture-workspace` E2E regressions passed; the staging
release and ArgoCD rollout deployed `*-9b31646`, which contains the merge
commit. The implementation tests cover scope precedence and shadowing, managed
exclusivity, secret redaction, explicit stdio consent, HTTP and stdio discovery
against fixtures, conflict fingerprints, rollback, idempotent Connect, and a
fail-closed preflight with rejected/unreachable credentials.

## Related knowledge

- [Nession MCP access layer semantic tool ownership and protocol versions](nession-mcp-access-layer-semantic-tool-ownership-and-protocol-versions.md)
  owns the endpoint's Tools, hosting modes, protocol eras and inbound auth. The
  Claude view reads and writes Claude's configuration; it does not change that
  service or duplicate its Tool catalog.
- [Endpoint-owned Server and Agent tokens](endpoint-owned-server-and-agent-tokens.md)
  owns the credentials the embedded endpoints verify. Connect references the
  relevant token through the Session environment rather than exporting it.

## Limits and when to revisit

- Plugin-provided and claude.ai connector entries are not discoverable from the
  configuration files; `managedMcpServers` in managed settings is not read.
  They are reported as unsupported sources rather than omitted silently.
- OAuth-protected servers, `headersHelper` execution and WebSocket discovery are
  outside this view's contract; a running Claude session remains the only
  authority for OAuth state and loaded Tools.
- The stdio probe inherits the Agent process environment with the Session's
  `HOME`, `CLAUDE_CONFIG_DIR` and `PATH` plus the entry's env; it is an explicit
  local-process action, not a claim about the environment inside a running
  Claude session.
- Revisit when #3251 lands user-level mutation, when Claude changes its
  configuration file/CLI contract, or when a scoped endpoint credential can
  replace the shared `NESSON_MCP_TOKEN` reference.
