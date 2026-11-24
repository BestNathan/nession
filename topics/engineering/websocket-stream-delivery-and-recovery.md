---
title: "WebSocket stream delivery and recovery"
description: "Stream-domain classification independent of protocol category: reliable ordered input, recoverable sequenced output, latest-state coalescence, per-stream windows, and session resource fences that reject stale input"
topic: engineering
categories: ["architecture", "websocket", "streaming", "terminal", "runtime", "recovery"]
status: candidate
created_at: 2026-11-24T12:47:00Z
updated_at: 2026-11-24T12:47:00Z
sources: ["https://github.com/BestNathan/nession/issues/4435", "https://github.com/BestNathan/nession/blob/ead4ef4cda05317b068661f439407763b4eafb25/docs/architecture/websocket-runtime.md", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-agent/src/session/registry.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-agent/src/session/terminal/state.rs"]
---

# WebSocket stream delivery and recovery

## Decision

Real-time data is classified by its **delivery contract**, independently of the
Protocol Kernel category:

| Stream class | Contract |
|---|---|
| reliable ordered input | loss-intolerant, ordered, never silently dropped, never blindly replayed (terminal keystrokes, resize) |
| recoverable sequenced output | gaps are detected and recovered through the provider's existing sequence/checkpoint and replay path (terminal bytes, logs) |
| latest-state | the newest value for one compatible incarnation/key replaces older pending values; a value from a different incarnation resyncs instead of merging |

Per-stream admission has its own finite frame/byte window and per-runtime
budget, separate from general request permits. A slow subscriber is isolated;
overflow is an explicit refusal or connection recovery using the existing
sequence/ACK semantics, not a silent truncation. Stream bookkeeping such as the
terminal input ACK is flow control for its exchange and shares the reply's
ordering, so a client reading in order never sees the previous cursor.

The **Session owner** (the Agent's `SessionRegistry`) remains the only writable
Session owner. Kill/create, control-lease transfer, sandbox/pane transition and
resize ordering are resource fences: stale epoch/generation/lease input is
refused at admission and re-checked around the backend write, and a replacement
Session never inherits the old stream's input.

The Relay is a forwarding adapter: it does not synthesize the Agent's
subscriber generation, stream epoch, control generation or frontier. Input
batching and order are preserved; output and progress are forwarded unchanged;
a forged Server receipt from the Agent is dropped.

## Evidence

- Approved design and Success Criteria: [Issue #4435](https://github.com/BestNathan/nession/issues/4435).
- Prior stream contract remains authoritative for epoch/sequence/ACK/replay and
  the terminal parser progress path; see
  [Terminal parser progress and exception reconciliation](../terminal/terminal-parser-progress-and-exception-reconciliation.md).
- Current delivered code (before this classification package merged): Agent
  terminal state/replay in `session/terminal/state.rs`, lease/epoch admission
  in `session/registry.rs`, and the browser `StreamReconciler` cursor.

## Related knowledge

- [Nession WebSocket runtime architecture and message dispatch](nession-websocket-runtime-architecture-and-message-dispatch.md)
- [WebSocket execution budgets and backpressure](websocket-execution-budgets-and-backpressure.md)
- [WebSocket runtime observability and reliability](websocket-runtime-observability-and-reliability.md)
- [Terminal parser progress and exception reconciliation](../terminal/terminal-parser-progress-and-exception-reconciliation.md)
- [Session Activity ownership](session-activity-ownership.md)

## Limits / when to revisit

- This article records the **approved target** for stream classification; the
  implementation package was still in review when it was written. Treat the
  current code and its tests as the delivered behavior until the target lands.
- There is no universal replay database and no blanket lossy queue. A provider
  that cannot replay must not be described as recoverable output.
