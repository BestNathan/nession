//! The agent-side extension: the erased dispatcher boundary for this provider
//! (`#678`, `#750`).
//!
//! ## Typed at the contract boundary; erased only here
//!
//! `AgentExtension::handle_command(&str, Value) -> Value` stays, because a
//! registry has to dispatch without knowing every provider's types. What
//! changed is what happens immediately after: each operation is an inner
//! function returning its **typed** success value or a [`GitFailure`], so
//! `Value` never travels through the provider as the contract. A missing
//! required field is a decode failure at the boundary rather than a
//! `payload.get("…").ok_or_else` repeated in six handlers, and the six
//! `handle_*` methods are one-line mappers.
//!
//! ## The working directory is resolved here, not sent by the client
//!
//! #750 C2 requires that git only ever runs inside the Session's working
//! directory, and that the client cannot name an arbitrary path. A tmux session
//! is a shell the user can `cd` in at any moment, so the directory is a
//! property of the session *now*, not something the client knows or should be
//! trusted to assert.
//!
//! That resolution needs tmux, and tmux has its own chokepoint in
//! `nession-agent`. Rather than give this crate a dependency on tmux — which
//! would either duplicate the `-S` socket discipline or invert the layering —
//! the agent injects a resolver at construction. This module never learns how
//! the directory is discovered, and the agent never learns how git is invoked.
//!
//! A client-supplied `cwd` is deliberately **ignored** rather than rejected: a
//! payload carrying one is not an error worth failing on, and accepting it
//! would be the vulnerability.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use nession_common::extension::{AgentExtension, ExtensionUnitPolicy};
use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tracing::debug;

use crate::protocol::branches::{BranchesOkV1, BranchesRequestV1};
use crate::protocol::commit::{CommitOkV1, CommitRequestV1};
use crate::protocol::create_commit::v1::{
    CreateCommitOkV1, CreateCommitRequestV1, CreateCommitResponseV1,
};
use crate::protocol::diff::v2::{DiffOkV2, DiffRequestV2};
use crate::protocol::diff::{DiffOkV1, DiffRequestV1};
use crate::protocol::log::{LogOkV1, LogRequestV1};
use crate::protocol::preview::{PreviewOkV1, PreviewRequestV1};
use crate::protocol::root::{RootOkV1, RootRequestV1};
use crate::protocol::stage::v1::{StageOkV1, StageRequestV1, StageResponseV1};
use crate::protocol::status::v2::{StatusOkV2, StatusRequestV2};
use crate::protocol::status::{StatusOkV1, StatusRequestV1};
use crate::protocol::unstage::v1::{UnstageOkV1, UnstageRequestV1, UnstageResponseV1};
use crate::protocol::worktrees::{WorktreesOkV1, WorktreesRequestV1};
use crate::protocol::{self, GitFailure, GitMutationResponseV1, GitResponseV1};
use crate::runtime::branches;
use crate::runtime::cmd::GitCmd;
use crate::runtime::commit;
use crate::runtime::diff;
use crate::runtime::log;
use crate::runtime::mutate;
use crate::runtime::preview as preview_runtime;
use crate::runtime::security::MAX_STATUS_BYTES;
use crate::runtime::snapshot;
use crate::runtime::status;
use crate::runtime::worktrees;

/// Resolves a Session identifier to its current working directory, or `None`
/// when the session is unknown. Injected by the agent.
///
/// Async because the real implementation asks tmux, and the tmux chokepoint is
/// async. Keeping it a trait rather than a closure means this crate states the
/// contract — "given a session, where is its shell?" — without knowing that the
/// answer involves a socket.
#[async_trait]
pub trait WorkdirResolver: Send + Sync {
    async fn resolve(&self, session: &str) -> Option<PathBuf>;
}

/// The one place a `Value` becomes a contract.
///
/// A decode failure is a value to answer with, not a propagated error: a
/// malformed payload from a peer is something to reply to, and replying keeps
/// the caller's correlation id alive instead of leaving it waiting for a
/// response that will never come — which the UI reads as a hang, not an error.
fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, GitFailure> {
    serde_json::from_value(payload).map_err(|e| GitFailure::Error {
        message: format!("malformed request: {e}"),
    })
}

/// The contract generation a request names.
///
/// Absent means v1 — the rule the protocol model states for a message that
/// predates versions. The registry has already refused a named version this
/// unit does not offer, so this only has to choose between served generations.
fn named_version(payload: &Value) -> u64 {
    payload
        .get("contract_version")
        .and_then(Value::as_u64)
        .unwrap_or(1)
}

/// Wrap an operation's typed outcome into the erased boundary's shape.
///
/// The single mapper every `handle_*` goes through, so the six operations
/// cannot come to disagree about what a failure looks like on the wire. `T` is
/// pinned by the `Ok` arm, which is why the failure arm needs no annotation.
fn respond_with<T: Serialize>(outcome: Result<T, GitFailure>) -> anyhow::Result<Value> {
    let response = match outcome {
        Ok(data) => GitResponseV1::Ok { data },
        Err(failure) => failure.into_response(),
    };
    Ok(serde_json::to_value(response)?)
}

pub struct GitAgentExtension {
    bin: String,
    resolve_workdir: Arc<dyn WorkdirResolver>,
    /// One async mutex per resolved repository root.
    ///
    /// The keyed execution lane serializes mutations of one Session; the same
    /// repository can be reachable from two Sessions, and Git's index lock is a
    /// process-global failure waiting to happen rather than an ordering policy.
    /// This is the provider-owned part of #845's concurrency rule; the lane is
    /// the runtime-owned part.
    repo_locks: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
    /// Bounded replay of commit outcomes by `(repository, request id)`.
    ///
    /// A response lost after a successful commit must not turn a transport
    /// retry into a second commit (#845 SC-09). The snapshot check alone makes
    /// a retry fail rather than duplicate; replaying the original answer makes
    /// it truthful as well.
    commit_results: Mutex<CommitResults>,
}

/// How long a commit outcome is remembered, by request id.
const MAX_REMEMBERED_COMMITS: usize = 128;

#[derive(Default)]
struct CommitResults {
    entries: HashMap<(String, String), Value>,
    order: VecDeque<(String, String)>,
}

impl CommitResults {
    fn get(&self, key: &(String, String)) -> Option<Value> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: (String, String), value: Value) {
        while self.order.len() >= MAX_REMEMBERED_COMMITS {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

impl GitAgentExtension {
    pub fn new(bin: impl Into<String>, resolve_workdir: Arc<dyn WorkdirResolver>) -> Self {
        Self {
            bin: bin.into(),
            resolve_workdir,
            repo_locks: Mutex::new(HashMap::new()),
            commit_results: Mutex::new(CommitResults::default()),
        }
    }

    /// The per-repository lock, created on first use and forgotten once no
    /// mutation holds it.
    fn repository_lock(&self, root: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .repo_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = locks.get(root).and_then(Weak::upgrade) {
            return existing;
        }
        if locks.len() >= 64 {
            locks.retain(|_, weak| weak.strong_count() > 0);
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
        lock
    }

    fn remembered_commit(&self, key: &(String, String)) -> Option<Value> {
        self.commit_results
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(key)
    }

    fn remember_commit(&self, key: (String, String), value: Value) {
        self.commit_results
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, value);
    }

    /// Resolve the session's directory and bind a git command to it.
    ///
    /// The `Err` case is a failure every operation maps in one line: they all
    /// need the same "we cannot address a repository" answer, and it differs by
    /// reason.
    async fn cmd_for(&self, session: &str) -> Result<GitCmd, GitFailure> {
        let workdir =
            self.resolve_workdir
                .resolve(session)
                .await
                .ok_or_else(|| GitFailure::Unavailable {
                    reason: "session_workdir_unknown".to_string(),
                    message: "Could not resolve this Session's working directory.".to_string(),
                })?;

        Ok(GitCmd::new(self.bin.clone(), workdir))
    }

    /// The checks every command needs before it can answer: is git here at all,
    /// and is this directory a repository? #750 requires these be reported
    /// separately — "no git installed" and "not a repository" are different
    /// problems with different fixes, which is why they are two variants of
    /// [`GitFailure`] rather than one message with different text.
    ///
    /// `Ok` carries the work tree root, because every caller needs it and the
    /// probe that answers "is this a repository" already knows it.
    async fn ready(&self, cmd: &GitCmd) -> Result<PathBuf, GitFailure> {
        if !cmd.available().await {
            return Err(GitFailure::Unavailable {
                reason: "git_not_installed".to_string(),
                message: "git is not available on this host.".to_string(),
            });
        }
        match cmd.resolve_root().await {
            Ok(Some(root)) => Ok(root),
            Ok(None) => Err(GitFailure::NotARepository {
                message: "This Session's working directory is not a git repository.".to_string(),
            }),
            Err(err) => Err(GitFailure::Error {
                message: err.to_string(),
            }),
        }
    }

    // ── The operations ───────────────────────────────────────────────────
    //
    // Each returns its typed success value or a typed failure, so `?` reads as
    // what it is and the erased mapping happens once, in the `handle_*` line
    // beneath each one.

    async fn status(&self, payload: Value) -> Result<StatusOkV1, GitFailure> {
        let request: StatusRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        let out = cmd
            .run(
                &["status", "--porcelain=v2", "--branch", "-z"],
                MAX_STATUS_BYTES,
            )
            .await?;
        let parsed = status::parse(&out.stdout)?;

        debug!(
            branch = parsed.branch.as_deref().unwrap_or("(detached)"),
            changed = parsed.changed_count(),
            "git status"
        );

        Ok(StatusOkV1 {
            status: parsed,
            // The work tree this status describes. Terminal Signal identity
            // needs it (`capability-emergence.md` names the worktree), and the
            // Workspace header shows it, so it rides along rather than costing a
            // second request.
            root: root.to_string_lossy().to_string(),
            // So a partial listing is never presented as a whole one.
            truncated: out.truncated(),
            truncated_bytes: out.truncated_bytes,
        })
    }

    async fn file_diff(&self, payload: Value) -> Result<DiffOkV1, GitFailure> {
        let request: DiffRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        self.ready(&cmd).await?;

        Ok(DiffOkV1 {
            diff: diff::file_diff(&cmd, &request.path, request.commit.as_deref()).await?,
        })
    }

    /// v2: the patch plus the state it was read from, from a typed source.
    ///
    /// The snapshot is read **before** the patch, so the token can only be
    /// older than the bytes the client sees. The reverse order would let a
    /// token describe a state newer than the reviewed patch.
    async fn file_diff_v2(&self, payload: Value) -> Result<DiffOkV2, GitFailure> {
        let request: DiffRequestV2 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        let state = snapshot::read(&cmd, &root).await?;
        Ok(DiffOkV2 {
            diff: diff::file_diff_scoped(&cmd, &request.path, &request.source).await?,
            snapshot: state.snapshot,
        })
    }

    /// v2: the listing plus the snapshot it describes.
    async fn status_v2(&self, payload: Value) -> Result<StatusOkV2, GitFailure> {
        let request: StatusRequestV2 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        let state = snapshot::read(&cmd, &root).await?;
        Ok(StatusOkV2 {
            status: state.status,
            root: root.to_string_lossy().to_string(),
            snapshot: state.snapshot,
            truncated: state.truncated,
            truncated_bytes: state.truncated_bytes,
        })
    }

    // ── Mutations (#845) ─────────────────────────────────────────────────

    /// The checks and the repository lock every mutation shares.
    async fn mutation_ready(
        &self,
        session: &str,
    ) -> Result<(GitCmd, PathBuf, tokio::sync::OwnedMutexGuard<()>), GitFailure> {
        let cmd = self.cmd_for(session).await?;
        let root = self.ready(&cmd).await?;
        let lock = self.repository_lock(&root);
        let guard = lock.lock_owned().await;
        Ok((cmd, root, guard))
    }

    async fn stage_operation(&self, request: StageRequestV1) -> StageResponseV1 {
        let (cmd, root, _guard) = match self.mutation_ready(&request.target.session).await {
            Ok(ready) => ready,
            Err(failure) => return GitMutationResponseV1::from_failure(failure),
        };
        match mutate::stage(&cmd, &root, &request.path, &request.expected_snapshot).await {
            Ok(state) => GitMutationResponseV1::Ok { data: state.into() },
            Err(failure) => failure.into_response(),
        }
    }

    async fn unstage_operation(&self, request: UnstageRequestV1) -> UnstageResponseV1 {
        let (cmd, root, _guard) = match self.mutation_ready(&request.target.session).await {
            Ok(ready) => ready,
            Err(failure) => return GitMutationResponseV1::from_failure(failure),
        };
        match mutate::unstage(&cmd, &root, &request.path, &request.expected_snapshot).await {
            Ok(state) => GitMutationResponseV1::Ok { data: state.into() },
            Err(failure) => failure.into_response(),
        }
    }

    /// Create a commit, replaying a repeated `requestId` instead of repeating
    /// the commit.
    async fn create_commit_operation(&self, request: CreateCommitRequestV1) -> Value {
        let cmd = match self.cmd_for(&request.target.session).await {
            Ok(cmd) => cmd,
            Err(failure) => {
                return serde_json::to_value(
                    GitMutationResponseV1::<CreateCommitOkV1>::from_failure(failure),
                )
                .unwrap_or_default()
            }
        };
        let root = match self.ready(&cmd).await {
            Ok(root) => root,
            Err(failure) => {
                return serde_json::to_value(
                    GitMutationResponseV1::<CreateCommitOkV1>::from_failure(failure),
                )
                .unwrap_or_default()
            }
        };

        let key = (
            root.to_string_lossy().to_string(),
            request.request_id.clone(),
        );
        if let Some(previous) = self.remembered_commit(&key) {
            return previous;
        }

        let lock = self.repository_lock(&root);
        let _guard = lock.lock_owned().await;

        // The first attempt may have finished between the lookup above and this
        // lock; replaying it here closes that window.
        if let Some(previous) = self.remembered_commit(&key) {
            return previous;
        }

        let response: CreateCommitResponseV1 =
            match mutate::create_commit(&cmd, &root, &request.message, &request.expected_snapshot)
                .await
            {
                Ok(applied) => GitMutationResponseV1::Ok {
                    data: CreateCommitOkV1 {
                        commit: applied.commit,
                        state: applied.state.into(),
                    },
                },
                Err(failure) => failure.into_response(),
            };

        // A refusal before Git ran is not an outcome to replay: the caller may
        // legitimately fix its state and retry with the same id. An attempt that
        // reached Git is, because a lost response must not repeat it.
        let value = match serde_json::to_value(&response) {
            Ok(value) => value,
            Err(err) => {
                return serde_json::json!({ "state": "failed", "message": err.to_string() });
            }
        };
        match &response {
            GitMutationResponseV1::Ok { .. }
            | GitMutationResponseV1::Failed { .. }
            | GitMutationResponseV1::MissingIdentity { .. } => {
                self.remember_commit(key, value.clone());
            }
            GitMutationResponseV1::RepositoryChanged { .. }
            | GitMutationResponseV1::Refused { .. }
            | GitMutationResponseV1::Unavailable { .. }
            | GitMutationResponseV1::NotARepository { .. } => {}
        }
        value
    }

    /// Current worktree bytes for an untracked or unmerged row (#2838).
    ///
    /// This is not a diff and not a filesystem browser: the path is checked
    /// against the selected status kind before and after the read, and the
    /// runtime opens it component-by-component without following links.
    async fn worktree_preview(&self, payload: Value) -> Result<PreviewOkV1, GitFailure> {
        let request: PreviewRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        Ok(PreviewOkV1 {
            preview: preview_runtime::file_preview(&cmd, &root, &request.path, request.expected)
                .await?,
        })
    }

    /// Recent commits on the current branch (#826 §4: History).
    ///
    /// `try_from` rather than `as`: the client picks this number, and a cast
    /// would wrap a value that does not fit — turning "give me everything" into
    /// "give me four". An unusable number is treated as absent, which falls back
    /// to the default.
    async fn history(&self, payload: Value) -> Result<LogOkV1, GitFailure> {
        let request: LogRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        self.ready(&cmd).await?;

        let limit = request.limit.and_then(|n| usize::try_from(n).ok());
        Ok(LogOkV1 {
            history: log::history(&cmd, limit, request.before.as_deref()).await?,
        })
    }

    async fn commit_detail(&self, payload: Value) -> Result<CommitOkV1, GitFailure> {
        let request: CommitRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        self.ready(&cmd).await?;

        Ok(CommitOkV1 {
            commit: commit::commit_detail(&cmd, &request.oid).await?,
        })
    }

    /// Local branches and their tracking state (#846).
    async fn local_branches(&self, payload: Value) -> Result<BranchesOkV1, GitFailure> {
        let request: BranchesRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        self.ready(&cmd).await?;

        let limit = request.limit.and_then(|n| usize::try_from(n).ok());
        Ok(BranchesOkV1 {
            branches: branches::branches(&cmd, limit).await?,
        })
    }

    /// The repository's worktrees, with the Session's own marked (#846).
    async fn repository_worktrees(&self, payload: Value) -> Result<WorktreesOkV1, GitFailure> {
        let request: WorktreesRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        Ok(WorktreesOkV1 {
            worktrees: worktrees::worktrees(&cmd, &root).await?,
        })
    }

    /// The work tree root on its own, for a caller that wants the address and
    /// not the listing (#826: entering the Workspace from a Peek preserves
    /// repo/worktree context without re-fetching the status).
    async fn repository_root(&self, payload: Value) -> Result<RootOkV1, GitFailure> {
        let request: RootRequestV1 = decode(payload)?;
        let cmd = self.cmd_for(&request.target.session).await?;
        let root = self.ready(&cmd).await?;

        Ok(RootOkV1 {
            root: root.to_string_lossy().to_string(),
        })
    }

    // ── The erased boundary ──────────────────────────────────────────────

    async fn handle_status(&self, payload: Value) -> anyhow::Result<Value> {
        if named_version(&payload) >= 2 {
            respond_with(self.status_v2(payload).await)
        } else {
            respond_with(self.status(payload).await)
        }
    }

    async fn handle_diff(&self, payload: Value) -> anyhow::Result<Value> {
        if named_version(&payload) >= 2 {
            respond_with(self.file_diff_v2(payload).await)
        } else {
            respond_with(self.file_diff(payload).await)
        }
    }

    async fn handle_stage(&self, payload: Value) -> anyhow::Result<Value> {
        let request: StageRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => {
                return Ok(serde_json::to_value(
                    GitMutationResponseV1::<StageOkV1>::from_failure(failure),
                )?)
            }
        };
        Ok(serde_json::to_value(self.stage_operation(request).await)?)
    }

    async fn handle_unstage(&self, payload: Value) -> anyhow::Result<Value> {
        let request: UnstageRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => {
                return Ok(serde_json::to_value(
                    GitMutationResponseV1::<UnstageOkV1>::from_failure(failure),
                )?)
            }
        };
        Ok(serde_json::to_value(self.unstage_operation(request).await)?)
    }

    async fn handle_create_commit(&self, payload: Value) -> anyhow::Result<Value> {
        let request: CreateCommitRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => {
                return Ok(serde_json::to_value(GitMutationResponseV1::<
                    CreateCommitOkV1,
                >::from_failure(
                    failure
                ))?)
            }
        };
        Ok(self.create_commit_operation(request).await)
    }

    async fn handle_preview(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.worktree_preview(payload).await)
    }

    async fn handle_log(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.history(payload).await)
    }

    async fn handle_commit(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.commit_detail(payload).await)
    }

    async fn handle_branches(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.local_branches(payload).await)
    }

    async fn handle_worktrees(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.repository_worktrees(payload).await)
    }

    async fn handle_root(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.repository_root(payload).await)
    }
}

#[async_trait]
impl AgentExtension for GitAgentExtension {
    fn name(&self) -> &'static str {
        "git"
    }

    /// The contracts this provider offers, from the module that owns them.
    ///
    /// The registry derives its routing table from these, so there is no second
    /// list to drift: the advertised set and the routed set are the same set.
    fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError> {
        crate::protocol::descriptors()
    }

    /// Scheduling is provider-owned and separate from the manifest (#974).
    ///
    /// The three mutations are serialized per Session by the runtime's keyed
    /// lane; the extension adds a per-repository lock because two Sessions can
    /// address one repository. Every read unit keeps the default query policy,
    /// so their existing concurrency is unchanged.
    fn execution_policies(&self) -> Vec<(&'static str, ExtensionUnitPolicy)> {
        vec![
            (
                protocol::stage::v1::WIRE,
                ExtensionUnitPolicy::SessionMutation,
            ),
            (
                protocol::unstage::v1::WIRE,
                ExtensionUnitPolicy::SessionMutation,
            ),
            (
                protocol::create_commit::v1::WIRE,
                ExtensionUnitPolicy::SessionMutation,
            ),
        ]
    }

    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        // Matching on the contracts' ids rather than re-spelled strings: the
        // registry hands the wire over verbatim and the wire *is* the
        // ProtocolId, which is the relation asserted by the test module below.
        match command {
            protocol::status::ID => self.handle_status(payload).await,
            protocol::diff::ID => self.handle_diff(payload).await,
            protocol::preview::ID => self.handle_preview(payload).await,
            protocol::root::ID => self.handle_root(payload).await,
            protocol::log::ID => self.handle_log(payload).await,
            protocol::commit::ID => self.handle_commit(payload).await,
            protocol::branches::ID => self.handle_branches(payload).await,
            protocol::worktrees::ID => self.handle_worktrees(payload).await,
            protocol::stage::ID => self.handle_stage(payload).await,
            protocol::unstage::ID => self.handle_unstage(payload).await,
            protocol::create_commit::ID => self.handle_create_commit(payload).await,
            other => anyhow::bail!("unknown git command: {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every contract's wire type, with the id it is supposed to strip to.
    fn contracts() -> Vec<(&'static str, &'static str)> {
        vec![
            (crate::protocol::status::v1::WIRE, protocol::status::ID),
            (crate::protocol::diff::v1::WIRE, protocol::diff::ID),
            (crate::protocol::preview::v1::WIRE, protocol::preview::ID),
            (crate::protocol::root::v1::WIRE, protocol::root::ID),
            (crate::protocol::log::v1::WIRE, protocol::log::ID),
            (crate::protocol::commit::v1::WIRE, protocol::commit::ID),
            (crate::protocol::branches::v1::WIRE, protocol::branches::ID),
            (
                crate::protocol::worktrees::v1::WIRE,
                protocol::worktrees::ID,
            ),
            (crate::protocol::stage::v1::WIRE, protocol::stage::ID),
            (crate::protocol::unstage::v1::WIRE, protocol::unstage::ID),
            (
                crate::protocol::create_commit::v1::WIRE,
                protocol::create_commit::ID,
            ),
        ]
    }

    fn extension() -> GitAgentExtension {
        GitAgentExtension::new("git", Arc::new(NoResolver))
    }

    #[test]
    fn the_wire_is_the_id_that_handle_command_matches_on() {
        // This asserted that the wire stripped to the id — the registry used to
        // do `strip_prefix("extension.")` and hand the remainder to
        // `handle_command`, which matches on the ids above.
        //
        // There is no strip now. The wire *is* the id, and `handle_command`
        // receives exactly what the contract declared, so this asserts the
        // equality the strip used to produce rather than the strip.
        for (wire, id) in contracts() {
            assert_eq!(
                wire, id,
                "`handle_command` matches on `{id}`, so the wire must be it"
            );
        }
    }

    #[test]
    fn the_advertised_wire_types_are_the_contracts_own() {
        // The registry routes on these and the manifest is built from them, so
        // "advertised" and "routed" are one set. A unit that answers several
        // versions advertises its one wire once per version; the test compares
        // the wire names as a set, because that is what the registry indexes.
        let advertised: std::collections::BTreeSet<String> = extension()
            .descriptors()
            .unwrap()
            .into_iter()
            .flat_map(|d| d.contracts.into_iter().flat_map(|c| c.wire))
            .collect();
        let expected: std::collections::BTreeSet<String> = contracts()
            .into_iter()
            .map(|(wire, _)| wire.to_string())
            .collect();
        assert_eq!(advertised, expected);
    }

    #[test]
    fn every_advertised_type_dispatches_to_something() {
        // The other half: a wire type advertised but not matched falls through
        // to `unknown git command`, which the registry would only discover when
        // someone called it.
        let extension = extension();
        for (wire, _) in contracts() {
            // No strip here: the wire *is* the command `handle_command` matches
            // on, so `is_known_command` is asked about the advertised name
            // itself rather than about a namespace-stripped copy of it.
            assert!(
                is_known_command(wire),
                "`{wire}` is advertised but no match arm handles it"
            );
        }
        assert!(!is_known_command("git.nonexistent"));
        assert!(extension.name() == "git");
    }

    /// The set `handle_command` matches, spelled once for the test above.
    ///
    /// A `match` cannot be introspected, so the arms are mirrored here — the
    /// test fails if the two lists drift, which is the failure it exists for.
    fn is_known_command(command: &str) -> bool {
        [
            protocol::status::ID,
            protocol::diff::ID,
            protocol::preview::ID,
            protocol::root::ID,
            protocol::log::ID,
            protocol::commit::ID,
            protocol::branches::ID,
            protocol::worktrees::ID,
            protocol::stage::ID,
            protocol::unstage::ID,
            protocol::create_commit::ID,
        ]
        .contains(&command)
    }

    #[test]
    fn a_decode_failure_answers_rather_than_propagating() {
        // A malformed payload from a peer is something to answer: propagating
        // would leave the caller's correlation id waiting for a reply that never
        // comes, which reads to the UI as a hang rather than an error.
        let failure = decode::<StatusRequestV1>(serde_json::json!({})).unwrap_err();
        let value = respond_with::<StatusOkV1>(Err(failure)).unwrap();
        assert_eq!(value["state"], "error");
        assert!(
            value["message"].as_str().unwrap_or("").contains("session"),
            "the message should name the missing field, got {value}"
        );
    }

    #[test]
    fn a_client_supplied_working_directory_is_still_ignored() {
        // #750 C2, restated at the boundary: the typed request has nowhere to
        // put a `cwd`, so accepting one is no longer expressible.
        let request: StatusRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "cwd": "/etc"})).unwrap();
        assert_eq!(request.target.session, "s");
    }

    /// A resolver that knows no session, so the tests above can build the
    /// extension without tmux.
    struct NoResolver;

    #[async_trait]
    impl WorkdirResolver for NoResolver {
        async fn resolve(&self, _session: &str) -> Option<PathBuf> {
            None
        }
    }
}
