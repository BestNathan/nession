# Multi-client terminal ownership (#1095, #2286)

> Requirements: [GitHub #1095](https://github.com/BestNathan/nession/issues/1095) (lease), [#2286](https://github.com/BestNathan/nession/issues/2286) (active-device handoff), [#2283](https://github.com/BestNathan/nession/issues/2283) (content fidelity), [#2487](https://github.com/BestNathan/nession/issues/2487) (fixed columns).

Session-scoped **ControlLease** (holder subscription + monotonic generation). At most one Controller may send input and authoritative resize; Observers receive output and local/replay history only. The Agent enforces the lease and generation before mutating the tmux backend; Web/App surface the Observer / Take Control affordances.

Depends on #1096 for single-controller PTY encoding. Does not implement replay storage (#1094).

## Fixed columns (#2487)

The active-device handoff below is unchanged, but **what a takeover may change
is narrower than it was in #2286**. #2286 let the active device resize the
shared window in both dimensions. Since #2487 the Session's **columns are
fixed** by the release/Session policy and only **rows** follow the active
device's usable height:

- A resize request still requires the current ControlLease generation and is
  still recorded in the ordered resize timeline. The Agent applies the
  Session's authoritative columns (the pane's width at first attach, or the
  creation width) and the requested rows, and fans out the size it actually
  applied.
- A takeover states the active device's rows. It does not state a new width;
  a client that sends one is clamped, not honoured.
- An observer that adopts the lease measures its own height and takes rows. Its
  font fit makes the same fixed columns legible in its own content box; it
  never gains columns by having a wider screen.
- The existing protections — generation fencing, refusal by name
  (`not_controller`, `observer_resize`), a delayed resize from a previous
  controller not reverting the current grid — remain the contract. The sizing
  decision itself is owned by [terminal-sizing.md](terminal-sizing.md).

## Subscription identity (#2469 slice 4)

The browser's stable `client_id` lives in localStorage and is **shared by every same-origin tab**. It is not, by itself, a subscription:

- A **subscription** is one page's attach, identified by `subscription_id` (minted per page instance, kept across that page's reconnects). Two tabs are two subscriptions and both receive the same broadcast. A reconnect of one tab replaces only its own subscription.
- A client that states no subscription keeps the v1 rule: `client_id` *is* the subscription identity, and a newer attach of that client replaces the older one.
- The ControlLease is held by a subscription. `controller_client_id` names the browser for display; `controller_subscription_id` is what each tab compares against its own id to decide whether the change names it. Role and authorization use the subscription; comparing browser ids alone would make every tab of one browser a Controller.
- Acquisitions from any subscription are explicit and move the generation. A passive reconnect (attach without acquire) does not take the lease, and re-acquiring as the same subscription is idempotent.

## Active-device handoff (#2286)

Nession is one interactive Session used **sequentially** across devices (PC → phone → PC). The lease belongs to the most recently **activated** terminal, not to the last resize packet:

- A meaningful foreground activation — opening/attaching the Session's terminal, returning to its surface, focusing the window on it, or touching the grid — acquires the lease automatically, even while another device remains attached.
- Passive events do **not** take the lease: a background container/`ResizeObserver` reflow, history scroll, capsule inset, unrelated overlay, or a transport reconnect alone.
- Acquisition is **idempotent for the holder** (`acquire` returns the current generation). Restating the lease never invalidates the client's own in-flight input or resize; only a *different subscription* advances the generation.
- On takeover the client forgets its last stated size, measures its viewport **now**, and states that size to the PTY after the lease/generation is acknowledged. Local xterm and the shared tmux window converge on the active device's **rows**; the columns stay the Session's fixed value (#2487).
- The retained manual **Take control** is the fallback for a deliberately displaced observer, not the ordinary flow.

## Generation fencing

- Input and resize requests carry the generation the sender believes it holds; the Agent refuses a frame whose lease has moved past it, by name (`not_controller`, or `observer_resize` for a client that no longer holds the lease).
- A **recorded** resize carries the generation that authorized it into the ordered stream and into replay. A client holding a newer generation skips applying it while still accounting for its sequence number, so a delayed resize from a previous controller cannot revert the current Controller's xterm grid.
- Stream ordering is unchanged: resize events consume a sequence number and stay in the same per-subscriber FIFO as output. The **handoff** resize is discrete and is applied through the parser writer, so it cannot cross an unfinished `terminal.write`; the continuous drag path's immediate local fit and the reported content-fidelity defect remain owned by #2283. tmux/PTY remains the source of actual geometry.

Protocol direction (names not frozen): `terminal.control.acquire`, `terminal.control.release`, `terminal.control.changed` — Session-scoped, reconnect-safe, identical on P2P and relay.

## Clipboard authority (#2598)

Clipboard effects follow the **Controller role**, not attach:

- An Observer never performs an OSC 52/5522 clipboard effect and never sends a protocol reply to the pane. Its xterm still parses the output; the clipboard protocol refuses the effect before it reaches `navigator.clipboard`.
- Only a foreground, visible, authorized Controller performs effects. A hidden tab or a detached viewport cannot complete a Clipboard API operation, so it must not claim one happened.
- A TUI read is served only from a **one-time offer** created by that Controller's own user paste, and only when the request echoes the unguessable password minted with the announcement. A spontaneous read has no path and receives `EPERM`.
- The effect gate is evaluated when the effect is requested (per frame), not at attach time, so a role handoff takes effect immediately in both directions.
