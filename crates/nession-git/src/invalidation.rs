//! Git repository invalidation — narrow filesystem watching with debouncing (#1008).
//!
//! Watches git metadata (`.git/HEAD`, index, refs) and the worktree root
//! recursively so terminal edits and git commands both surface as one logical
//! invalidation epoch per burst.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tracing::warn;

/// Wire the agent sends to the central server.
pub const WIRE_TO_SERVER: &str = "server.agent.git-invalidated";

/// Wire the server pushes to web clients.
pub const WIRE_TO_CLIENT: &str = "agent.git.invalidated";

/// Default debounce for coalescing bursts (implementation detail; not correctness).
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(250);

/// A debounced watch on one repository checkout. Dropped when the session moves on.
pub struct RepositoryWatch {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl RepositoryWatch {
    /// Start watching `workdir` and invoke `on_invalidate` after debounced changes.
    ///
    /// Watcher overflow or setup failure returns `Err`; the caller should treat
    /// that as "invalidate everything" for that session.
    pub fn start(
        workdir: PathBuf,
        debounce: Duration,
        on_invalidate: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let mut debouncer =
            new_debouncer(debounce, move |result: DebounceEventResult| match result {
                Ok(events) if !events.is_empty() => on_invalidate(),
                Ok(_) => {}
                Err(errors) => {
                    warn!("git invalidation watcher error: {errors:?}");
                    on_invalidate();
                }
            })
            .map_err(|e| format!("debouncer: {e}"))?;

        watch_git_paths(&workdir, debouncer.watcher())?;
        watch_worktree(&workdir, debouncer.watcher())?;

        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

fn watch_git_paths(workdir: &Path, watcher: &mut dyn Watcher) -> Result<(), String> {
    let git_dir = workdir.join(".git");
    if !git_dir.exists() {
        return Ok(());
    }
    let head = git_dir.join("HEAD");
    let index = git_dir.join("index");
    watch_file(watcher, &head)?;
    watch_file(watcher, &index)?;
    watch_dir(watcher, &git_dir.join("refs"))?;
    Ok(())
}

fn watch_worktree(workdir: &Path, watcher: &mut dyn Watcher) -> Result<(), String> {
    watcher
        .watch(workdir, RecursiveMode::Recursive)
        .map_err(|e| format!("worktree watch {}: {e}", workdir.display()))
}

fn watch_file(watcher: &mut dyn Watcher, path: &Path) -> Result<(), String> {
    if path.exists() {
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch {}: {e}", path.display()))?;
    }
    Ok(())
}

fn watch_dir(watcher: &mut dyn Watcher, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {e}", path.display()))?;
    }
    Ok(())
}
