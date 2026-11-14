---
title: "Endpoint-owned Server and Agent tokens"
description: "One durable Server Token for the control plane and one durable Agent Token per Agent for inbound P2P, Relay and MCP; registration-generation caching, handoff only to the resolved Agent, operator rotation, and the trusted-endpoint boundary that replaces per-attach grants"
topic: engineering
categories: ["architecture", "protocol", "security", "agent", "server", "web"]
status: verified
created_at: 2026-11-14T10:05:23Z
updated_at: 2026-11-14T10:05:23Z
sources: ["https://github.com/BestNathan/nession/blob/2909dcbb0ad65c9e9bff4c874a36f2a8de29918f/docs/architecture/protocol.md", "https://github.com/BestNathan/nession/blob/2909dcbb0ad65c9e9bff4c874a36f2a8de29918f/crates/nession-protocol/src/secret.rs", "https://github.com/BestNathan/nession/blob/2909dcbb0ad65c9e9bff4c874a36f2a8de29918f/crates/nession-agent/src/token.rs"]
---

# Endpoint-owned Server and Agent tokens

## Decision

Authorization is a property of the **endpoint**, not of an attach. Two kinds of
durable secret exist:

| Secret | Owner | Authenticates |
|---|---|---|
| Server Token | the Server | `server.auth` from Web/CLI, Server-hosted MCP, image blob HTTP |
| Agent Token | one Agent | that Agent's inbound `client.auth`, its Relay dial, its MCP HTTP surface |

An Agent Token is generated once beside its config (mode 0600), reused across
restarts, overridable by the operator, and fails closed when malformed. The
Server never mints a per-attach P2P credential: there is no `agent.p2p.grant`,
no TTL, no renewal, no grant acknowledgement, and no stable token in a
WebSocket URL.

## How the token reaches each peer

1. The Agent registers over its Server Token and includes its Agent Token in
   `server.agent.register`. The Server caches the value on the Agent's entry
   under the **registration generation**; a superseded registration cannot
   overwrite the current one, and the token is evicted when the owning control
   connection releases so a later attach refuses clearly instead of handing out
   a value the Server can no longer vouch for.
2. An authenticated `server.session.attach` returns the token of the resolved
   Agent only (never another Agent's), together with its addresses. Relay mode
   gets no token because the Server dials the Agent itself with the cached
   value.
3. The Browser keeps the value in memory for that runtime. An ordinary
   reconnect reuses it; an explicit rejection clears it and one authenticated
   attach refetches the current value when the Server is authenticated again.
   It is never placed in a URL, storage or telemetry.
4. The Agent verifies `client.auth` **before any business frame**, refuses a
   second authentication, closes an unauthenticated socket at a 10s deadline,
   and never lets a refusal change the connection's identity.

## Rotation and outage behaviour

- Rotation is an Agent restart with a new token. The Server adopts it with the
  new registration generation; the old value is refused from then on.
- A cached Agent Token lets a direct P2P connection reattach while the Server
  is down, preserving the Session stream cursor and controller lease.
- After a rejection, one authenticated attach is the only refetch. If the
  Server has not yet observed the Agent's re-registration, the fresh value can
  still be the previous one; in that window the Session recovers through the
  Server Relay rather than stranding the browser.

## Security boundary

This is a **trusted-endpoint model**: holding the Server Token authorizes the
control plane and every blob read (the Server authenticates the blob route
before it resolves a digest, so an unknown digest is `404` only after a valid
bearer). Holding an Agent Token authorizes that Agent's whole inbound surface.
It is not per-user or per-Session authorization, and it should not be described
as such.

- Bearer secrets never appear in URLs, logs, the public Agent list, telemetry
  or browser storage; `RedactedToken`/`SecretString` redact `Debug` output.
- A leaked Agent Token is Agent-wide exposure and its remedy is rotation.
- A leaked Server Token is control-plane-wide exposure.
- Future user identity (JWT/multi-user permission) belongs on top of this
  boundary, not inside the same literal; adding a user identity must not
  recreate per-attach credential orchestration.

## Related knowledge

- [Nession MCP access layer semantic tool ownership and protocol versions](nession-mcp-access-layer-semantic-tool-ownership-and-protocol-versions.md):
  each MCP host verifies its own endpoint token.
- [Global EROFS Image Manager](global-erofs-image-manager.md): blob reads are
  authorized by the Server Token; a managed-image grant carries only its path.

## Limits and when to revisit

- Rotation requires an Agent restart; an in-place token reload is not defined.
- The model trades per-resource authorization for one predictable key per
  endpoint. Revisit when multi-user or per-Project authorization becomes a
  requirement.
- The Browser's refetch is one round trip per rejection episode; a Server that
  has not yet observed the rotation degrades that episode to Relay instead of
  retrying indefinitely.
