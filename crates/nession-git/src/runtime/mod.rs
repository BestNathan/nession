//! The provider implementation — what serves the contracts in [`crate::protocol`].
//!
//! The split this directory makes visible is the one the design turns on:
//! **typed at the contract boundary, erased only at the dispatcher boundary**.
//! [`crate::protocol`] holds the typed requests, responses and descriptors;
//! this holds the code that answers them, plus the two things every answer
//! shares — the single place a `git` process is spawned ([`cmd`]) and the
//! boundary the client's input is checked against ([`security`]).
//!
//! Nothing here declares a contract. A module that grew a `ProtocolDescriptor`
//! would be a contract living in the implementation half, and the layout would
//! stop meaning anything.

pub mod branches;
pub mod cmd;
pub mod diff;
pub mod log;
pub mod security;
pub mod status;
pub mod worktrees;
