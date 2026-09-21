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

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tracing::debug;

use crate::protocol::branches::{BranchesOkV1, BranchesRequestV1};
use crate::protocol::diff::{DiffOkV1, DiffRequestV1};
use crate::protocol::log::{LogOkV1, LogRequestV1};
use crate::protocol::root::{RootOkV1, RootRequestV1};
use crate::protocol::status::{StatusOkV1, StatusRequestV1};
use crate::protocol::worktrees::{WorktreesOkV1, WorktreesRequestV1};
use crate::protocol::{self, GitFailure, GitResponseV1};
use crate::runtime::branches;
use crate::runtime::cmd::GitCmd;
use crate::runtime::diff;
use crate::runtime::log;
use crate::runtime::security::MAX_STATUS_BYTES;
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
}

impl GitAgentExtension {
    pub fn new(bin: impl Into<String>, resolve_workdir: Arc<dyn WorkdirResolver>) -> Self {
        Self {
            bin: bin.into(),
            resolve_workdir,
        }
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
            diff: diff::file_diff(&cmd, &request.path).await?,
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
            history: log::history(&cmd, limit).await?,
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
        respond_with(self.status(payload).await)
    }

    async fn handle_diff(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.file_diff(payload).await)
    }

    async fn handle_log(&self, payload: Value) -> anyhow::Result<Value> {
        respond_with(self.history(payload).await)
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

    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        // Matching on the contracts' ids rather than re-spelled strings: the
        // registry strips `extension.` and the remainder *is* the ProtocolId,
        // which is the relation asserted by the test module below.
        match command {
            protocol::status::ID => self.handle_status(payload).await,
            protocol::diff::ID => self.handle_diff(payload).await,
            protocol::root::ID => self.handle_root(payload).await,
            protocol::log::ID => self.handle_log(payload).await,
            protocol::branches::ID => self.handle_branches(payload).await,
            protocol::worktrees::ID => self.handle_worktrees(payload).await,
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
            (crate::protocol::root::v1::WIRE, protocol::root::ID),
            (crate::protocol::log::v1::WIRE, protocol::log::ID),
            (crate::protocol::branches::v1::WIRE, protocol::branches::ID),
            (
                crate::protocol::worktrees::v1::WIRE,
                protocol::worktrees::ID,
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
        // "advertised" and "routed" are one set. This asserts the set is the
        // one the contracts name — a contract missing from `descriptors()` is
        // one nobody can reach.
        let advertised: Vec<String> = extension()
            .descriptors()
            .unwrap()
            .into_iter()
            .flat_map(|d| d.contracts.into_iter().flat_map(|c| c.wire))
            .collect();
        let expected: Vec<String> = contracts()
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
            let command = wire.strip_prefix("extension.").unwrap_or(wire);
            assert!(
                is_known_command(command),
                "`{wire}` is advertised but no match arm handles `{command}`"
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
            protocol::root::ID,
            protocol::log::ID,
            protocol::branches::ID,
            protocol::worktrees::ID,
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
