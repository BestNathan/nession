//! Git invalidation watcher smoke tests (#1008).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nession_git::invalidation::RepositoryWatch;
use tempfile::tempdir;

#[test]
fn repository_watch_fires_after_worktree_change() {
    let dir = tempdir().expect("tempdir");
    let repo = dir.path();
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(repo)
        .output()
        .expect("git init");
    std::fs::write(repo.join("README.md"), "hello").expect("write");

    let hits = Arc::new(AtomicUsize::new(0));
    let hits_cb = Arc::clone(&hits);
    let _watch = RepositoryWatch::start(
        repo.to_path_buf(),
        Duration::from_millis(50),
        Arc::new(move || {
            hits_cb.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .expect("watch");

    std::fs::write(repo.join("README.md"), "hello again").expect("write");
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        hits.load(Ordering::SeqCst) >= 1,
        "expected at least one invalidation"
    );
}
