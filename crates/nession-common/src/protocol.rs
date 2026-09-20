//! Transition shim (`#678`, Phase 1).
//!
//! The core wire contracts moved into `nession-protocol`'s `contracts/` — the
//! crate that owns the kernel and nothing else, rather than this one, which
//! also owns config, logging, paths and tmux. This module re-exports them so
//! the import sites across the workspace keep resolving while the migration
//! runs.
//!
//! It is a transition, not an interface. New code names the contract it means:
//!
//! ```text
//! nession_protocol::contracts::session::v1::ClientSessionAttachPayload
//! ```
//!
//! A flat `nession_common::protocol::ClientSessionAttachPayload` cannot say
//! which contract *version* the caller resolved, which is the question this
//! whole issue exists to make answerable.
//!
//! The direction is one-way: `nession-protocol` has no path back to this
//! crate, so nothing here can become load-bearing by accident.

pub use nession_protocol::contracts::agent::v1::*;
pub use nession_protocol::contracts::commands::v1::*;
pub use nession_protocol::contracts::env::v1::*;
pub use nession_protocol::contracts::server::v1::*;
pub use nession_protocol::contracts::session::v1::*;

/// The kernel's envelope, re-exported for the same transition.
pub use nession_protocol::{Message, ProtocolMessage};
