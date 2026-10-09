# Nession Agent Runtime Instructions

This scope owns work under `crates/nession-agent/`.

The agent owns node-local execution and tmux-backed Sessions. Non-trivial lifecycle/concurrency changes should use the `nession-code-review` workflow.

## tmux ownership

Nession never relies on the user's default tmux server.

- Every tmux process spawn uses the canonical helper in `src/tmux/cmd.rs`.
- Every invocation carries an explicit private `-S <absolute-socket>`.
- Do not use `TMUX_TMPDIR` as isolation.
- Do not introduce direct tmux process spawns outside the canonical owner.
- Cleanup targets Nession-owned resources and proves socket ownership before broad server cleanup.

The deterministic enforcement owner is `scripts/check-tmux-socket.sh`:

```bash
./gates/run tmux-socket-isolation
```

Historical tmux specs/plans under `docs/superpowers/` are provenance, not a competing current runtime contract.

## Runtime / concurrency

- Preserve explicit ownership of connections, Sessions, pending work, and mutation ordering.
- Avoid broad lock-across-await designs when state transition and asynchronous work can be separated.
- Bounded per-key queues do not prove bounded global concurrency; preserve queue/task/resource bounds.
- Reconnect and re-registration must reason about stale authority/generation and pending operations.
- Terminal input/order is loss-intolerant unless an explicit contract proves otherwise.

## Protocol

Use versioned contracts from `nession-protocol`. Do not add private wire conventions that bypass the Protocol Kernel.

Run the relevant protocol Gates for routing/wire changes.
