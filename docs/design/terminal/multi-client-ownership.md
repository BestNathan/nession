# Multi-client terminal ownership (#1095)

> Requirement: [GitHub #1095](https://github.com/BestNathan/nession/issues/1095).

Session-scoped **ControlLease** (holder client id + monotonic generation). At most one Controller may send input and authoritative resize; Observers receive output and local/replay history only. Agent enforces generation before mutating the tmux backend; Web/App surface Observer / Take Control UX.

Depends on #1096 for single-controller PTY encoding. Does not implement replay storage (#1094).

Protocol direction (names not frozen): `terminal.control.acquire`, `terminal.control.release`, `terminal.control.changed` — Session-scoped, reconnect-safe, identical on P2P and relay.
