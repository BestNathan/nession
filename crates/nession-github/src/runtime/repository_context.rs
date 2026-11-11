//! The Git-side repository context, through the existing `GitCmd` chokepoint.

use anyhow::Result;
use nession_git::{GitCmd, RepositoryContext};

/// Read the live repository context for one Session's working directory.
///
/// `Ok(None)` is "not a repository"; a `GitCmd` failure is a failed read. The
/// GitHub provider never spawns git itself.
pub async fn read_repository_context(cmd: &GitCmd) -> Result<Option<RepositoryContext>> {
    nession_git::context::read(cmd).await
}
