//! Read-only GitHub hosting context for the Git capability (#1290).
//!
//! Repository identity comes from the live Agent Session's Git remotes (read
//! through `nession-git`'s single `GitCmd` chokepoint). The typed client makes
//! fixed GET requests only; it never accepts a host, owner, path or query from
//! the Web. This crate is not a second product capability: the Web presents it
//! under the existing Git capability.

pub mod agent;
pub mod protocol;
pub mod runtime;

pub use agent::GithubAgentExtension;
pub use nession_git::WorkdirResolver;
pub use runtime::client::{GithubClient, GithubError};
pub use runtime::repository_context::read_repository_context;
