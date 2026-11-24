---
title: "Nession WebSocket runtime architecture and message dispatch"
description: "One physical WebSocket carries three runtime dispatch domains — Control, Request and Stream — independent of the Protocol Kernel's Operation/Notification/Control wire categories, with one Reader, one Writer and one owner per resource"
topic: engineering
categories: ["architecture", "websocket", "runtime", "protocol", "server", "agent"]
status: verified
created_at: 2026-11-24T12:45:00Z
updated_at: 2026-11-24T12:45:00Z
sources: ["https://github.com/BestNathan/nession/blob/ead4ef4cda05317b068661f439407763b4eafb25/docs/architecture/websocket-runtime.md", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/lane.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/outbound.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-server/src/server/websocket.rs"]
---

# Nession WebSocket runtime architecture and message dispatch

## Decision

A physical WebSocket has **one reader and one writer**, and the runtime
classifies work into three dispatch domains that are orthogonal to the
Protocol Kernel's wire categories:

| Dispatch domain | What it carries | Admission / ordering |
|---|---|---|
| **Control** | `control.*`, auth/register, RPC completions, mode transitions | bounded reserved capacity; auth/register and transitions fence dependent work; no slow business await in the reader |
| **Request** | operations declared as queries or keyed mutations | bounded concurrent or per-resource FIFO; refusal is explicit; no blind replay |
| **Stream** | terminal input/output, progress, latest-state pushes | reliable input order, sequenced recoverable output, generation-aware coalescence |

`agent.terminal.output` is a **Notification** by protocol category and a
**Stream** by dispatch domain. `server.agent.command-response` is an
Operation-shaped completion and a **Control** frame. The two classifications
answer different questions and are never collapsed into one enum.

The dispatch class, resource key and access scope are **provider-owned
metadata declared beside the route** (`server_routes!`, `core_routes!`,
`p2p_routes!`). A peer cannot choose its scheduling class with a wire prefix or
payload field, and there is no second consumer-visible route registry.

## Evidence

- Canonical architecture: `docs/architecture/websocket-runtime.md` on `main`.
- Route inventory: every served wire and its declared policy is derived from the
  three route declarations and enforced by the `websocket-route-inventory`
  Gate (`scripts/websocket-route-inventory.mjs`); a served wire that is not
  inventoried, a stale inventory row, a policy drift or a duplicate declaration
  fails the Gate.
- Delivered mechanism: the typed lanes (`crates/nession-runtime/src/lane.rs`),
  the classified outbound (`outbound.rs`), the generation-fenced settlement
  (`lifecycle.rs`), and the single Server teardown owner
  (`server::websocket::handle_ws_stream`).
- Approved target vs delivered behavior is recorded section by section in the
  architecture document; the document explicitly does not claim unmerged
  sibling work.

## Related knowledge

- [WebSocket execution budgets and backpressure](websocket-execution-budgets-and-backpressure.md)
- [WebSocket stream delivery and recovery](websocket-stream-delivery-and-recovery.md)
- [WebSocket runtime observability and reliability](websocket-runtime-observability-and-reliability.md)
- [Endpoint-owned Server and Agent tokens](endpoint-owned-server-and-agent-tokens.md)
- [Session Activity ownership](session-activity-ownership.md)
- [Terminal parser progress and exception reconciliation](../terminal/terminal-parser-progress-and-exception-reconciliation.md)

## Limits / when to revisit

- The document is the architecture owner; per-crate route tables and Gates are
  the executable truth. If they disagree, repair the executable owner and the
  document together.
- Stream-domain classification and the final integrated proof were still in
  review when this article was written; the target sections are approved
  design, not a claim that every package was merged.
