//! The provider implementation — what serves the contracts in [`crate::protocol`].
//!
//! The split this directory makes visible is the one the design turns on:
//! **typed at the contract boundary, erased only at the dispatcher boundary**.
//! [`crate::protocol`] holds the typed requests, responses and descriptors;
//! this holds the code that answers them, plus the two things every answer
//! shares — the single place a `git` process is spawned ([`cmd`]) and the
//! boundary the client's input is checked against ([`security`]).
//!
//! Nothing here declares a contract, and — since the wire shapes moved to
//! [`crate::protocol`] — nothing here *defines* one either. A module that grew
//! a `ProtocolDescriptor`, or a `Serialize` struct a contract carries, would be
//! a contract living in the implementation half and the layout would stop
//! meaning anything.
//!
//! What is left in each module is what it *does*: `status::parse` turns
//! porcelain into a `RepoStatus`, `branches::parse_track` reads git's six
//! tracking shapes, `cmd` spawns the process, `security` refuses input. The
//! types those functions produce and consume are imported from the contract.
//!
//! The `impl` blocks for the contract types stayed here, deliberately. A shape
//! is what the wire carries; `RepoStatus::is_clean()` is a question someone
//! asks *about* one. Splitting them the same way the types are split is the
//! same rule applied one level down.

pub mod branches;
pub mod cmd;
pub mod diff;
pub mod log;
pub mod security;
pub mod status;
pub mod worktrees;
