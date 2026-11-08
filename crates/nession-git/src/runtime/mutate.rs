//! Local, additive repository mutations: stage, unstage, create-commit (#845).
//!
//! Each mutation is conditional on the snapshot the caller reviewed, runs one
//! narrowly typed Git command, and re-reads the repository afterwards. A
//! failure is never reported as "unchanged": hooks and signing can have
//! side effects before they fail, so the post-attempt state is returned with
//! the failure.

use std::path::Path;

use crate::protocol::create_commit::v1::CommitCreatedV1;
use crate::protocol::status::v1::RepoStatus;
use crate::protocol::{GitMutationResponseV1, MutationStateOkV1};
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{validate_repo_relative_path, MAX_COMMIT_MESSAGE_BYTES};
use crate::runtime::snapshot::{self, SnapshotState};

/// A commit that Git reported as created, with the state read afterwards.
#[derive(Debug)]
pub struct CommitApplied {
    pub commit: CommitCreatedV1,
    pub state: SnapshotState,
}

/// Why a mutation did not produce a successful post-state.
#[derive(Debug)]
pub enum MutationFailure {
    /// The repository no longer matches the token the caller reviewed.
    RepositoryChanged(SnapshotState),
    /// The request was rejected before any mutating command ran.
    Refused(String),
    /// A mutating command ran and failed; `state` is the reconciled repository.
    Failed {
        message: String,
        state: Option<SnapshotState>,
    },
    /// Commit could not determine the author identity.
    MissingIdentity(String),
}

impl MutationFailure {
    /// The wire answer, in the mutation contract's vocabulary.
    pub fn into_response<T>(self) -> GitMutationResponseV1<T> {
        match self {
            Self::RepositoryChanged(state) => GitMutationResponseV1::RepositoryChanged {
                message: "The repository changed after it was reviewed. Nothing was applied; \
                          refresh the change list and try again."
                    .to_string(),
                snapshot: state.snapshot,
                status: state.status,
                truncated: state.truncated,
                truncated_bytes: state.truncated_bytes,
            },
            Self::Refused(message) => GitMutationResponseV1::Refused { message },
            Self::Failed { message, state } => GitMutationResponseV1::Failed {
                message,
                snapshot: state.as_ref().map(|state| state.snapshot.clone()),
                status: state.map(|state| state.status),
            },
            Self::MissingIdentity(message) => GitMutationResponseV1::MissingIdentity { message },
        }
    }
}

impl From<SnapshotState> for MutationStateOkV1 {
    fn from(state: SnapshotState) -> Self {
        Self {
            snapshot: state.snapshot,
            status: state.status,
            truncated: state.truncated,
            truncated_bytes: state.truncated_bytes,
        }
    }
}

/// Read the current state and refuse the mutation unless it is the reviewed one.
///
/// A truncated listing cannot prove anything about the bytes Git did not
/// return, so it is refused rather than trusted as a prefix.
async fn verify(
    cmd: &GitCmd,
    root: &Path,
    expected: &str,
) -> Result<SnapshotState, MutationFailure> {
    let state = snapshot::read(cmd, root)
        .await
        .map_err(|err| MutationFailure::Failed {
            message: format!("could not read the repository state: {err}"),
            state: None,
        })?;
    if state.truncated {
        return Err(MutationFailure::Refused(
            "The repository has more changes than this capability can verify. Narrow the set of \
             changed files before mutating."
                .to_string(),
        ));
    }
    if state.snapshot.token != expected {
        return Err(MutationFailure::RepositoryChanged(state));
    }
    Ok(state)
}

/// Stage one validated repository-relative path.
pub async fn stage(
    cmd: &GitCmd,
    root: &Path,
    path: &str,
    expected_snapshot: &str,
) -> Result<SnapshotState, MutationFailure> {
    let path = validate_repo_relative_path(path)
        .map_err(|err| MutationFailure::Refused(err.to_string()))?;
    let state = verify(cmd, root, expected_snapshot).await?;
    ensure_stageable(&state.status, &path)?;

    if let Err(err) = cmd.stage_path(&path).await {
        return Err(MutationFailure::Failed {
            message: err.to_string(),
            state: reconcile(cmd, root).await,
        });
    }
    reconcile_required(cmd, root, "stage").await
}

fn ensure_stageable(status: &RepoStatus, path: &str) -> Result<(), MutationFailure> {
    if status.unmerged.iter().any(|conflicted| conflicted == path) {
        return Err(MutationFailure::Refused(format!(
            "`{path}` is conflicted. Resolve the conflict before staging it."
        )));
    }
    let untracked = status.untracked.iter().any(|candidate| candidate == path);
    let unstaged = status
        .modified
        .iter()
        .any(|file| file.path == path && file.unstaged);
    if untracked || unstaged {
        Ok(())
    } else {
        Err(MutationFailure::Refused(format!(
            "`{path}` has no unstaged change to stage."
        )))
    }
}

/// Restore one path's index entry without touching its worktree bytes.
pub async fn unstage(
    cmd: &GitCmd,
    root: &Path,
    path: &str,
    expected_snapshot: &str,
) -> Result<SnapshotState, MutationFailure> {
    let path = validate_repo_relative_path(path)
        .map_err(|err| MutationFailure::Refused(err.to_string()))?;
    let state = verify(cmd, root, expected_snapshot).await?;
    let original = ensure_unstageable(&state.status, &path)?;
    let has_head = state.snapshot.head.is_some();

    let mut paths = vec![path.as_str()];
    if let Some(original) = original.as_deref() {
        paths.push(original);
    }

    if let Err(err) = cmd.unstage_paths(&paths, has_head).await {
        return Err(MutationFailure::Failed {
            message: err.to_string(),
            state: reconcile(cmd, root).await,
        });
    }
    reconcile_required(cmd, root, "unstage").await
}

/// The original path of a staged rename, whose other half must be unstaged too.
fn ensure_unstageable(status: &RepoStatus, path: &str) -> Result<Option<String>, MutationFailure> {
    if status.unmerged.iter().any(|conflicted| conflicted == path) {
        return Err(MutationFailure::Refused(format!(
            "`{path}` is conflicted. Resolve the conflict instead of unstaging it."
        )));
    }
    match status
        .modified
        .iter()
        .find(|file| file.path == path && file.staged)
    {
        Some(file) => Ok(file.original_path.clone()),
        None => Err(MutationFailure::Refused(format!(
            "`{path}` has no staged change to unstage."
        ))),
    }
}

/// Create one normal local commit from the current index.
pub async fn create_commit(
    cmd: &GitCmd,
    root: &Path,
    message: &str,
    expected_snapshot: &str,
) -> Result<CommitApplied, MutationFailure> {
    if message.trim().is_empty() {
        return Err(MutationFailure::Refused(
            "A commit needs a message.".to_string(),
        ));
    }
    if message.contains('\0') {
        return Err(MutationFailure::Refused(
            "A commit message must not contain a NUL byte.".to_string(),
        ));
    }
    if message.len() > MAX_COMMIT_MESSAGE_BYTES {
        return Err(MutationFailure::Refused(format!(
            "The commit message is longer than the {MAX_COMMIT_MESSAGE_BYTES}-byte limit."
        )));
    }

    let state = verify(cmd, root, expected_snapshot).await?;
    if !state.status.unmerged.is_empty() {
        return Err(MutationFailure::Refused(
            "The index has unresolved conflicts. Resolve them before committing.".to_string(),
        ));
    }
    if !state.status.modified.iter().any(|file| file.staged) {
        return Err(MutationFailure::Refused(
            "There are no staged changes to commit.".to_string(),
        ));
    }

    // Ask Git for the identity it would use, rather than guessing from config.
    let author = cmd.author_identity().await.map_err(|err| {
        MutationFailure::MissingIdentity(format!(
            "Git could not determine the Agent host's author identity: {err}. Set user.name and \
             user.email for this repository or host, then try again."
        ))
    })?;

    if let Err(err) = cmd.commit_staged(message).await {
        // A hook may have changed the index before failing; report what is
        // actually there instead of claiming nothing happened.
        return Err(MutationFailure::Failed {
            message: err.to_string(),
            state: reconcile(cmd, root).await,
        });
    }

    let new_state = reconcile_required(cmd, root, "commit").await?;
    let Some(oid) = new_state.snapshot.head.clone() else {
        return Err(MutationFailure::Failed {
            message: "Git reported a successful commit but HEAD could not be read. The repository \
                      needs inspection."
                .to_string(),
            state: Some(new_state),
        });
    };
    if Some(oid.as_str()) == state.snapshot.head.as_deref() {
        return Err(MutationFailure::Failed {
            message: "Git reported a successful commit but HEAD did not move. The repository \
                      needs inspection."
                .to_string(),
            state: Some(new_state),
        });
    }

    Ok(CommitApplied {
        commit: CommitCreatedV1 { oid, author },
        state: new_state,
    })
}

/// Read the post-state; a mutation that cannot be reconciled is not a success.
async fn reconcile_required(
    cmd: &GitCmd,
    root: &Path,
    operation: &str,
) -> Result<SnapshotState, MutationFailure> {
    snapshot::read(cmd, root)
        .await
        .map_err(|err| MutationFailure::Failed {
            message: format!(
                "The {operation} command completed but the new repository state could not be \
                 read: {err}"
            ),
            state: None,
        })
}

/// Best-effort post-attempt state for a failure answer.
async fn reconcile(cmd: &GitCmd, root: &Path) -> Option<SnapshotState> {
    snapshot::read(cmd, root).await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use crate::runtime::snapshot::SnapshotState;

    fn git(root: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command.arg("-C").arg(root).args(args);
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CEILING_DIRECTORIES",
        ] {
            command.env_remove(var);
        }
        let output = command.output().expect("git must be installed");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Run git where a non-zero exit is expected — and inherited repository
    /// variables must not redirect the command into the caller's checkout. A
    /// pre-push hook exports `GIT_DIR`, so a fixture that did not scrub it made
    /// `git merge` run against the pushing repository (#845).
    fn git_try(root: &Path, args: &[&str]) -> std::process::Output {
        let mut command = Command::new("git");
        command.arg("-C").arg(root).args(args);
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CEILING_DIRECTORIES",
        ] {
            command.env_remove(var);
        }
        command.output().expect("git must be installed")
    }

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn unborn() -> Self {
            let dir = tempfile::tempdir().unwrap();
            git(dir.path(), &["init", "-q"]);
            Self { dir }
        }

        fn committed() -> Self {
            let fixture = Self::unborn();
            git(fixture.dir.path(), &["config", "user.name", "Nession Test"]);
            git(
                fixture.dir.path(),
                &["config", "user.email", "test@example.com"],
            );
            fs::write(fixture.dir.path().join("a.txt"), "one\n").unwrap();
            git(fixture.dir.path(), &["add", "a.txt"]);
            git(fixture.dir.path(), &["commit", "-qm", "initial"]);
            fixture
        }

        fn cmd(&self) -> GitCmd {
            GitCmd::new("git", self.dir.path())
        }

        async fn state(&self) -> SnapshotState {
            snapshot::read(&self.cmd(), self.dir.path()).await.unwrap()
        }
    }

    #[tokio::test]
    async fn stage_records_the_change_and_returns_authoritative_state() {
        let fixture = Fixture::committed();
        fs::write(fixture.dir.path().join("a.txt"), "two\n").unwrap();
        let reviewed = fixture.state().await;

        let after = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();

        let file = after
            .status
            .modified
            .iter()
            .find(|file| file.path == "a.txt")
            .expect("the file is still listed");
        assert!(file.staged, "the index now carries the change");
        assert!(!file.unstaged, "the worktree matches the index");
        assert_ne!(after.snapshot.token, reviewed.snapshot.token);
    }

    #[tokio::test]
    async fn a_stale_snapshot_is_refused_without_touching_the_index() {
        let fixture = Fixture::committed();
        fs::write(fixture.dir.path().join("a.txt"), "two\n").unwrap();
        let reviewed = fixture.state().await;
        // A terminal-side edit after review — the race #845 SC-03 is about.
        fs::write(fixture.dir.path().join("a.txt"), "three\n").unwrap();

        match stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::RepositoryChanged(state)) => {
                assert!(!state.status.modified.iter().any(|file| file.staged));
            }
            other => panic!("expected a stale-snapshot refusal, got {other:?}"),
        }

        let status = fixture.state().await.status;
        assert!(
            !status.modified.iter().any(|file| file.staged),
            "the index must be untouched"
        );
    }

    #[tokio::test]
    async fn stage_refuses_a_conflicted_path_explicitly() {
        let fixture = Fixture::committed();
        git(fixture.dir.path(), &["checkout", "-qb", "other"]);
        fs::write(fixture.dir.path().join("a.txt"), "other\n").unwrap();
        git(fixture.dir.path(), &["commit", "-qam", "other"]);
        git(fixture.dir.path(), &["checkout", "-q", "main"]);
        fs::write(fixture.dir.path().join("a.txt"), "main\n").unwrap();
        git(fixture.dir.path(), &["commit", "-qam", "main"]);
        let merge = git_try(fixture.dir.path(), &["merge", "other"]);
        assert!(!merge.status.success(), "the fixture must conflict");

        let reviewed = fixture.state().await;
        assert_eq!(reviewed.status.unmerged, vec!["a.txt".to_string()]);

        match stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::Refused(message)) => {
                assert!(message.contains("conflicted"), "got {message}");
            }
            other => panic!("expected an explicit conflict refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unstage_restores_the_index_and_keeps_worktree_bytes() {
        let fixture = Fixture::committed();
        fs::write(fixture.dir.path().join("a.txt"), "changed\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();

        let after = unstage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &staged.snapshot.token,
        )
        .await
        .unwrap();

        assert_eq!(
            fs::read_to_string(fixture.dir.path().join("a.txt")).unwrap(),
            "changed\n",
            "unstage must never discard worktree content"
        );
        let file = after
            .status
            .modified
            .iter()
            .find(|file| file.path == "a.txt")
            .expect("the file is still modified");
        assert!(!file.staged);
        assert!(file.unstaged);
    }

    #[tokio::test]
    async fn unstage_works_on_an_unborn_repository() {
        let fixture = Fixture::unborn();
        fs::write(fixture.dir.path().join("new.txt"), "hello\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "new.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();
        assert_eq!(staged.snapshot.head, None);

        let after = unstage(
            &fixture.cmd(),
            fixture.dir.path(),
            "new.txt",
            &staged.snapshot.token,
        )
        .await
        .unwrap();

        assert!(!after.status.untracked.is_empty());
        assert!(
            !after.status.modified.iter().any(|file| file.staged),
            "the index entry is gone"
        );
        assert_eq!(
            fs::read_to_string(fixture.dir.path().join("new.txt")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn commit_runs_with_the_configured_author_and_moves_head() {
        let fixture = Fixture::committed();
        fs::write(fixture.dir.path().join("a.txt"), "committed\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();

        let applied = create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "feat: change a",
            &staged.snapshot.token,
        )
        .await
        .unwrap();

        assert_eq!(applied.commit.author, "Nession Test <test@example.com>");
        assert_eq!(
            applied.state.snapshot.head.as_deref(),
            Some(applied.commit.oid.as_str())
        );
        assert!(applied.state.status.is_clean());
    }

    #[tokio::test]
    async fn commit_refuses_a_stale_snapshot() {
        let fixture = Fixture::committed();
        fs::write(fixture.dir.path().join("a.txt"), "staged\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();
        // The user stages something else in the Terminal before confirming.
        fs::write(fixture.dir.path().join("b.txt"), "new\n").unwrap();
        git(fixture.dir.path(), &["add", "b.txt"]);

        match create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "feat: change a",
            &staged.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::RepositoryChanged(state)) => {
                assert!(state
                    .status
                    .modified
                    .iter()
                    .any(|file| file.path == "b.txt"));
            }
            other => panic!("expected a stale-snapshot refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn commit_reports_a_missing_identity_specifically() {
        let fixture = Fixture::unborn();
        // An explicitly empty name is a deterministic "no identity" state; it
        // overrides any host-wide configuration rather than depending on the
        // test machine not having one.
        git(fixture.dir.path(), &["config", "user.name", ""]);
        git(
            fixture.dir.path(),
            &["config", "user.email", "nobody@example.com"],
        );
        fs::write(fixture.dir.path().join("a.txt"), "one\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();

        match create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "feat: change",
            &staged.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::MissingIdentity(message)) => {
                assert!(
                    message.contains("user.name") && message.contains("user.email"),
                    "the failure must say what to configure, got {message}"
                );
            }
            other => panic!("expected a missing-identity failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_failing_hook_reports_the_post_attempt_state() {
        let fixture = Fixture::committed();
        let hooks = fixture.dir.path().join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        // The hook also mutates the index before failing: the answer must show
        // what actually happened, not "the commit failed, nothing changed".
        fs::write(
            &hook,
            "#!/bin/sh\necho side > side.txt && git add side.txt\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
        }

        fs::write(fixture.dir.path().join("a.txt"), "hooked\n").unwrap();
        let reviewed = fixture.state().await;
        let staged = stage(
            &fixture.cmd(),
            fixture.dir.path(),
            "a.txt",
            &reviewed.snapshot.token,
        )
        .await
        .unwrap();

        match create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "feat: hook",
            &staged.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::Failed {
                state: Some(state), ..
            }) => {
                assert!(
                    state
                        .status
                        .modified
                        .iter()
                        .any(|file| file.path == "side.txt" && file.staged),
                    "the hook's index side effect must be visible, got {:?}",
                    state.status
                );
            }
            other => panic!("expected a failed commit with state, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn commit_refuses_a_conflicted_index() {
        let fixture = Fixture::committed();
        git(fixture.dir.path(), &["checkout", "-qb", "other"]);
        fs::write(fixture.dir.path().join("a.txt"), "other\n").unwrap();
        git(fixture.dir.path(), &["commit", "-qam", "other"]);
        git(fixture.dir.path(), &["checkout", "-q", "main"]);
        fs::write(fixture.dir.path().join("a.txt"), "main\n").unwrap();
        git(fixture.dir.path(), &["commit", "-qam", "main"]);
        let merge = git_try(fixture.dir.path(), &["merge", "other"]);
        assert!(!merge.status.success());

        let reviewed = fixture.state().await;
        match create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "merge",
            &reviewed.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::Refused(message)) => {
                assert!(message.contains("conflict"), "got {message}");
            }
            other => panic!("expected a conflict refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_empty_commit_is_refused_without_running_git() {
        let fixture = Fixture::committed();
        let reviewed = fixture.state().await;
        match create_commit(
            &fixture.cmd(),
            fixture.dir.path(),
            "   ",
            &reviewed.snapshot.token,
        )
        .await
        {
            Err(MutationFailure::Refused(message)) => assert!(message.contains("message")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}
