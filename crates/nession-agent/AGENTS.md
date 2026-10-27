# Nession Agent Runtime Instructions

This scope owns work under `crates/nession-agent/`.

The agent owns node-local execution and tmux-backed Sessions. Non-trivial lifecycle/concurrency changes should use the `nession-code-review` workflow.

## tmux ownership

Nession never relies on the user's default tmux server.

- Every tmux process spawn goes through the `nession-tmux` crate
  (`crates/nession-tmux/src/process.rs`). The Agent's `src/tmux/cmd.rs` supplies
  Nession's socket and server configuration and must not spawn a process itself.
- Every invocation carries an explicit private `-S <absolute-socket>`.
- Do not use `TMUX_TMPDIR` as isolation.
- Do not introduce direct tmux process spawns outside the canonical owner.
- Cleanup targets Nession-owned resources and proves socket ownership before broad server cleanup.
- Control Mode transport, selection and tradeoffs:
  [docs/architecture/agent-tmux-control-transport.md](../../docs/architecture/agent-tmux-control-transport.md).
- Test-run isolation and shared-server Session-width semantics:
  [docs/architecture/agent-tmux-test-isolation.md](../../docs/architecture/agent-tmux-test-isolation.md).
- Session/tmux SDK ownership boundary, delivered on staging by #2469:
  [docs/architecture/session-tmux-sdk-ownership.md](../../docs/architecture/session-tmux-sdk-ownership.md).
  `main` receives it with the release promotion; until then the `cmd.rs`
  chokepoint above remains its authoritative executable rule.

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
