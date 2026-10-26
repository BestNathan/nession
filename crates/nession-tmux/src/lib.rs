//! A tmux-native Rust library: explicit process addressing, typed one-shot
//! operations, and a persistent Control Mode client.
//!
//! The crate is deliberately independent of Nession. It has no dependency on
//! any Nession product crate, wire type or Session definition; a consumer
//! supplies its own binary, private socket and optional server configuration.
//!
//! ```text
//! TmuxCommand  -> explicit `-S <socket>` process construction
//!     |
//!     +-- client::TmuxClient  -> persistent `-C`/`-CC` attachment
//!     |      - byte framing, ordered command/reply matching, tombstones
//!     |      - one ordered source-event stream, bounded ingress
//!     |
//!     +-- (one-shot operations arrive in the next migration slice)
//! ```
//!
//! What lives above this crate — Nession Session identity, environment
//! bindings, stream epochs and subscriber policy — is not represented here on
//! purpose. See the repository document
//! `docs/architecture/session-tmux-sdk-ownership.md` for that boundary.

pub mod client;
pub mod ops;
pub mod parser;
pub mod process;

#[cfg(test)]
pub(crate) mod testing;

pub use client::{
    ClientChild, ClientIo, ControlCommand, ControlTransport, EventIngressLimits, TmuxClient,
    TmuxClientError, TmuxEvent,
};
pub use ops::{PaneModeFlags, TmuxOps};
pub use parser::{parse_control_line, parse_control_line_bytes, ControlMessage};
pub use process::{heal_stale_socket, TmuxCommand};
