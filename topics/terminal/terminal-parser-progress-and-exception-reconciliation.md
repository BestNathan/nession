---
title: "Terminal parser progress and exception reconciliation"
description: "Negotiated one-way parser-applied progress, the Agent's per-subscriber issued frontier, and the exception-only reconcile-required recovery contract for terminal streams"
topic: terminal
categories: ["architecture","protocol","recovery","terminal","web"]
status: candidate
created_at: 2026-11-07T09:26:00Z
updated_at: 2026-11-07T09:26:00Z
sources: ["https://github.com/BestNathan/nession/issues/2877","https://github.com/BestNathan/nession/pull/2901","https://github.com/BestNathan/nession/issues/2867","https://github.com/BestNathan/nession/issues/1645","https://github.com/BestNathan/nession/blob/357b5aa17554cbdeb426c1bb94ca710f82caf8cf/docs/architecture/protocol.md","https://github.com/BestNathan/nession/blob/6ae6dbb2a65c5fae3d3d1bf5417ed5cff37f9d76/docs/design/terminal/ahp-inspired-terminal-consistency.md"]
---

# Terminal parser progress and exception reconciliation

## Decision

A negotiated Web/Agent connection reports xterm parser progress as a **one-way
notification**, not a request/reply operation. The Web sends its cumulative,
contiguous, parser-completed frontier on `client.terminal.output.progress`;
nothing answers it. The Agent's only outbound reaction is the exception-only
`agent.terminal.reconcile-required` notification, addressed to the exact
authenticated subscription.

The v1 `agent.terminal.output.applied` operation is not converted. It remains
the compatibility path for any combination that did not negotiate the
capability, and its request/reply shape is untouched.

- **Negotiation:** `agent.attach` states `terminal_capabilities`. A client that
  finds `terminal-progress-notifications-v1` switches to the response-less
  wire and listens for reconcile notices; its absence keeps the v1 operation.
  A Relay forwards the list verbatim and never adds, removes or validates an
  entry.
- **Agent verdict:** authenticate the socket peer, session,
  subscriber generation, stream epoch and pinned renderer. The claim's bound is
  **that subscriber's actually issued frontier**, floor = the stream cut the
  subscription joined, upper bound = the last ordinal its forwarder issued —
  never the session-global head. Ordinary `applied_through < head` lag is
  normal and silent. Accepted and duplicate reports update bookkeeping only; a
  stale subscriber generation is ignored rather than challenged.
- **Exception notice:** only a proven, actionable inconsistency about the
  current binding earns a notice: a claim beyond the subscriber's issued
  frontier, an incompatible epoch/renderer requiring a fresh binding, or known
  replay/retention loss. The payload names the exact subscription, stream
  epoch, authoritative head, optional retained floor, reason and action. It is
  coalesced to at most one active episode per subscription and has no ACK.
- **Web recovery:** `SessionRuntime` owns it. A current notice atomically
  starts one single-flight reconcile and suppresses progress submission while
  the proof is outstanding. Recovery reuses `agent.terminal.stream.resume`
  from the last trusted parser-applied prefix; only a complete contiguous
  same-epoch run resumes reporting. Incomplete/unavailable replay takes the
  proven checkpoint/reattach path and stays explicitly degraded — never
  synchronized. Stale, foreign, malformed or replaced-subscription notices
  start nothing. Web-observed gaps retain independent authority to start the
  same recovery.
- **Relay is transport, not stream authority:** it forwards progress and the
  notice unchanged to/from the exact relay. It does not synthesize heads,
  validate progress, credit bytes or mint a subscriber generation.

## Context and evidence

- Requirement: [#2877](https://github.com/BestNathan/nession/issues/2877);
  implementation PR [#2901](https://github.com/BestNathan/nession/pull/2901).
  Bounded cumulative ACK scheduling that preceded it:
  [#2867](https://github.com/BestNathan/nession/issues/2867). Continuity and
  fidelity boundaries remain owned by
  [#1645](https://github.com/BestNathan/nession/issues/1645) and
  `docs/design/terminal/ahp-inspired-terminal-consistency.md`.
- Canonical protocol model: notifications are declared beside the code that
  carries them, have no manifest entry and no generated operation binding; an
  operation reply is where a notification-only capability is negotiated
  (`docs/architecture/protocol.md`).
- The Agent's subscriber ledger keeps the attach cut as a conservative floor so
  a renderer preserved across a reattach is not misread as "ahead of what was
  issued"; only events actually handed to the subscriber's forwarder raise the
  frontier.
- Proof is source-aligned and exact-SHA at `6ae6dbb2a65c` (staging-based
  implementation): Agent/Server integration tests send real progress
  notifications, assert no reply, assert one notice per episode and exercise
  Relay forwarding; Web tests assert negotiation, per-subscriber identity
  fencing, single-flight resume, route replacement and the checkpoint/reattach
  fallback. The design record is the same commit's
  `docs/design/terminal/ahp-inspired-terminal-consistency.md`.

## Related knowledge

- [Web terminal emulator engine and component ownership](web-terminal-emulator-engine-and-component-ownership.md) — the Xterm Engine boundary that produces the parser-applied facts this contract transports.
- [App mobile spatial navigation and Terminal touch ownership](../app/app-mobile-spatial-navigation-and-terminal-touch-ownership.md) — the App shell's touch ownership around the Terminal.

## Limits / when to revisit

- **Not yet measured:** a controlled baseline/candidate comparison of
  control-frame counts and per-subscriber issued-credit peaks under burst,
  quiet-tail, slow-browser and high-output fixtures (the Requirement's SC-06).
  Do not claim the frequency/credit improvement from fake-timer tests alone.
- No **pre-close** reconcile notice is sent when a subscriber's credit
  capacity is exhausted; the Agent closes that subscriber's connection and the
  Web's connection-loss/reattach path performs the authoritative continuity
  check. Adding a notice later must preserve the same exact-subscription
  identity.
- A progress claim is not proof of screen fidelity, and a reconcile notice is
  not proof of a missing region. Full-VT/alt-screen fidelity, atomic checkpoint
  cuts and the degraded-live presentation stay with the terminal consistency
  RFC.
- Revisit if a second notification consumer needs its own capability string;
  keep one owner per wire and do not route a notification through a manifest
  entry or a generated operation binding.
