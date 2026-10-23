# Multi-client terminal ownership (#1095, #2286)

> Requirements: [GitHub #1095](https://github.com/BestNathan/nession/issues/1095) (lease), [#2286](https://github.com/BestNathan/nession/issues/2286) (active-device handoff), [#2283](https://github.com/BestNathan/nession/issues/2283) (content fidelity).

Session-scoped **ControlLease** (holder client id + monotonic generation). At most one Controller may send input and authoritative resize; Observers receive output and local/replay history only. The Agent enforces the lease and generation before mutating the tmux backend; Web/App surface the Observer / Take Control affordances.

Depends on #1096 for single-controller PTY encoding. Does not implement replay storage (#1094).

## Active-device handoff (#2286)

Nession is one interactive Session used **sequentially** across devices (PC → phone → PC). The lease belongs to the most recently **activated** terminal, not to the last resize packet:

- A meaningful foreground activation — opening/attaching the Session's terminal, returning to its surface, focusing the window on it, or touching the grid — acquires the lease automatically, even while another device remains attached.
- Passive events do **not** take the lease: a background container/`ResizeObserver` reflow, history scroll, capsule inset, unrelated overlay, or a transport reconnect alone.
- Acquisition is **idempotent for the holder** (`acquire` returns the current generation). Restating the lease never invalidates the client's own in-flight input or resize; only a *different* client advances the generation.
- On takeover the client forgets its last stated size, measures its viewport **now**, and states that size to the PTY after the lease/generation is acknowledged. Local xterm and the shared tmux window converge on the active device's viewport.
- The retained manual **Take control** is the fallback for a deliberately displaced observer, not the ordinary flow.

## Generation fencing

- Input and resize requests carry the generation the sender believes it holds; the Agent refuses a frame whose lease has moved past it, by name (`not_controller`, or `observer_resize` for a client that no longer holds the lease).
- A **recorded** resize carries the generation that authorized it into the ordered stream and into replay. A client holding a newer generation skips applying it while still accounting for its sequence number, so a delayed resize from a previous controller cannot revert the current Controller's xterm grid.
- Stream ordering is unchanged: resize events consume a sequence number and stay in the same per-subscriber FIFO as output. The **handoff** resize is discrete and is applied through the parser writer, so it cannot cross an unfinished `terminal.write`; the continuous drag path's immediate local fit and the reported content-fidelity defect remain owned by #2283. tmux/PTY remains the source of actual geometry.

Protocol direction (names not frozen): `terminal.control.acquire`, `terminal.control.release`, `terminal.control.changed` — Session-scoped, reconnect-safe, identical on P2P and relay.
