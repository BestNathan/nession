---
title: "WebSocket execution budgets and backpressure"
description: "Non-blocking ingress admission with explicit overload and steady-state task reaping, plus classified outbound queues with reserved capacity, exact unclamped accounting, bounded fairness and finite write deadlines"
topic: engineering
categories: ["architecture", "websocket", "runtime", "backpressure", "resource-ownership", "server", "agent"]
status: verified
created_at: 2026-11-24T12:46:00Z
updated_at: 2026-11-24T12:46:00Z
sources: ["https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/lane.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/outbound.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/lifecycle.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-server/src/server/command_broker.rs", "https://github.com/BestNathan/nession/blob/ead4ef4cda05317b068661f439407763b4eafb25/docs/architecture/websocket-runtime.md"]
---

# WebSocket execution budgets and backpressure

## Decision

Every bound is a number the runtime states, observes and enforces at its owner.

**Ingress.** The reader admits without waiting. `try_dispatch` / `try_enqueue`
return an `AdmitError::{Saturated, Closed}`; a refusal reserves nothing — no
permit, no connection slot, no queue entry, no key worker. The adapter answers
the refused request with an explicit `overloaded` outcome; if that answer
cannot be delivered the connection ends rather than leaving the request
unanswered. A reader never parks on a business permit, so heartbeat, control
and stream processing keep moving.

**Bookkeeping.** Every admission reaps finished tasks, so retained records
track live work rather than message count. Panic and cancellation are counted;
a panicking mutation is caught inside its key's worker so the key is released
and the rest of its queue still runs.

**Outbound.** Each physical socket has explicit **Control / Response / Stream**
queues with reserved capacity. Accounting is exact and unclamped: an oversized
frame is refused with its real size, never charged as if it were smaller.
Scheduling is a bounded control burst plus byte-aware fairness between response
and stream; no promise is made to preempt a write already in flight. Every
write, flush and close has a finite deadline, and the lifecycle settles the
connection once with a bounded reason.

**Settlement.** Pending broker requests settle exactly once for response,
timeout, cancellation, delivery failure, replacement or disconnect; an old
generation's late reply cannot settle a new owner's request. Side effects are
never retried automatically.

## Evidence

- Steady-state and explicit-refusal tests at the delivered staging SHA:
  100,000-query and keyed-mutation stress with bounded retained records,
  per-connection/slot and per-key refusals, panic recovery, and the Server and
  Agent integration tests that assert the `overloaded` reply.
- `scripts/check-coverage.sh`/Gates and the runtime tests cover the class
  budgets, in-flight accounting, control reservation, fairness and the finite
  write deadline.
- `docs/architecture/websocket-runtime.md` owns the current-vs-target table and
  the invariants; process-wide byte/worker budgets beyond the per-connection
  and per-key bounds remain approved target work.

## Related knowledge

- [Nession WebSocket runtime architecture and message dispatch](nession-websocket-runtime-architecture-and-message-dispatch.md)
- [WebSocket stream delivery and recovery](websocket-stream-delivery-and-recovery.md)
- [WebSocket runtime observability and reliability](websocket-runtime-observability-and-reliability.md)
- [Session Activity ownership](session-activity-ownership.md)

## Limits / when to revisit

- A bounded per-key queue does not by itself bound global concurrency; the
  connection admission bound and the runtime key budget are separate statements.
- Physical TCP head-of-line blocking is bounded by deadlines, not removed.
- The reported numbers are test/baseline evidence, not a production SLO.
