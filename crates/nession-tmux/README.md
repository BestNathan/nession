# nession-tmux

A tmux-native Rust library: explicit process addressing and a persistent
Control Mode client.

This crate is **independent of Nession**. It does not depend on any Nession
product crate, wire type or Session definition, and it does not read a Nession
configuration. A consumer supplies the tmux binary, a private socket path and
an optional server configuration.

## What it provides today

| Surface | Status |
|---|---|
| Explicit `TmuxCommand` addressing (`-S`, `-f`, inherited-env scrubbing, stale-socket healing) | present |
| Persistent Control Mode client over `-C` pipe and `-CC` PTY | present |
| Bounded framing/parser for non-UTF-8 pane bytes | present |
| Ordered command/reply matching with FIFO and tombstones | present |
| Typed one-shot administration API (`new_session`, `list_sessions`, `kill_session`, env/capture/resize/options) | present |
| Administration example (`manage_sessions`) | present |

## Quick start

```rust
use nession_tmux::{ControlTransport, TmuxClient, TmuxCommand, TmuxEvent};

# async fn example() -> anyhow::Result<()> {
let command = TmuxCommand::new("tmux", "/tmp/my-app/tmux.sock");
command.validate()?; // absolute socket; no default-socket fallback

let mut client = TmuxClient::connect_with(
    &command,
    "work",
    ControlTransport::Pipe,
)?;

let mut events = client.take_events().expect("first consumer");
while let Some(event) = events.recv().await {
    match event {
        TmuxEvent::Handshaken => { /* the welcome pair was consumed */ }
        TmuxEvent::Output(chunk) => { /* raw pane bytes, in source order */ }
        TmuxEvent::SourceLost { reason } => {
            eprintln!("tmux source lost: {reason}");
            break;
        }
        _ => {}
    }
}
client.close().await;
# Ok(())
# }
```

A failed launch is an error and never falls back to the other transport. The
client never kills the tmux server; `close` detaches and reaps its own control
client.

## Supported tmux

The crate is tmux-native and has no product-level version policy. The
repository's measured contract is **tmux 3.6b** on macOS; Linux CI installs the
distribution tmux on the runner image. Real-tmux integration tests create an
isolated server per test and record the actual `tmux -V` when used as acceptance
evidence.

## Testing

```bash
cargo test -p nession-tmux
```

- the client's wire tests run against an in-memory duplex;
- the transport tests use a self-contained fake tmux process;
- `tests/real_tmux.rs` creates a real isolated tmux server on a private socket.

A missing `tmux` binary is a test failure, not a skip.

## Packaging and publication

The crate is currently internal (`publish = false`) with its own `0.1.0`
version, independent of the Nession product version. Publishing to crates.io,
license selection and registry metadata require a separate owner decision and
are not part of this crate's migration.

## Ownership boundary

Nession Session identity, environment bindings, stream epochs, ControlLease and
subscriber policy live above this crate. See
`docs/architecture/session-tmux-sdk-ownership.md` in the Nession repository.
