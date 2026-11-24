---
title: "WebSocket runtime observability and reliability"
description: "Bounded, owner-emitted WS telemetry: closed label enums, unit-carrying counters/gauges/histograms, an optional non-blocking bounded exporter, versioned diagnostic dashboards and a reproducible controlled-load baseline"
topic: engineering
categories: ["architecture", "websocket", "observability", "telemetry", "runtime", "reliability"]
status: candidate
created_at: 2026-11-24T12:48:00Z
updated_at: 2026-11-24T12:48:00Z
sources: ["https://github.com/BestNathan/nession/issues/4437", "https://github.com/BestNathan/nession/blob/ead4ef4cda05317b068661f439407763b4eafb25/docs/architecture/websocket-runtime.md", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/lane.rs", "https://github.com/BestNathan/nession/blob/6ee47ebac993847172ea1918f9daf125330dc4bf/crates/nession-runtime/src/outbound.rs"]
---

# WebSocket runtime observability and reliability

## Decision

Telemetry is an **optional, bounded** contract owned by the runtime, not a
second SDK or an on-path dependency.

- **Labels are closed enums** for runtime, peer, transport, domain, direction,
  result and reason. There is no API that accepts a session, agent, request,
  connection, wire, path or command string, so a high-cardinality label cannot
  be written by accident. Units are carried by the metric definition.
- **Owners emit**: lanes emit admission accepted/refused/waited, task
  active/retained/reaped/panicked and request duration; the classified
  outbound emits accepted/refused/too-large/queued and finite write timeouts;
  the lifecycle emits settlement by bounded reason; ingress emits connection
  attempts/active; the Agent outbox emits latest-state coalescence.
- **Collection is bounded**: the default sink is a no-op; an exporter is a
  bounded channel whose `record` is a non-blocking `try_send` that drops and
  counts. A missing or stalled collector can never delay message handling.
- **Dashboards are versioned** for Overview, Request, Stream and Lifecycle and
  are validated against the metric catalog, so a panel cannot name an unemitted
  metric, a mismatched kind or an unbounded label.
- **Baseline before SLO**: a reproducible controlled-load run records the exact
  SHA, runner class, workload, fixed budgets, sample count, p50/p95/p99,
  memory, task/queue high-water and quiescent values. Candidate latency targets
  are not a production SLO.

## Evidence

- Approved design and Success Criteria: [Issue #4437](https://github.com/BestNathan/nession/issues/4437).
- The architecture document delegates the metric contract to the telemetry
  package and requires the exporter to stay off the message path.
- Existing typed snapshots at the owners (`LaneSnapshot`, `KeySnapshot`,
  `QueueSnapshot`, outbox/class snapshots) are the source values the contract
  formalizes; no new parallel measurement pipeline is introduced.

## Related knowledge

- [Nession WebSocket runtime architecture and message dispatch](nession-websocket-runtime-architecture-and-message-dispatch.md)
- [WebSocket execution budgets and backpressure](websocket-execution-budgets-and-backpressure.md)
- [WebSocket stream delivery and recovery](websocket-stream-delivery-and-recovery.md)
- [Session Activity ownership](session-activity-ownership.md)

## Limits / when to revisit

- This article records the approved target; the instrumentation package was in
  review when it was written. The current snapshots/log lines remain the
  delivered observability until it lands.
- A metric absent from the collector is not zero; dashboards and the baseline
  must distinguish missing data from a zero value.
- No production probe and no production SLO are claimed.
