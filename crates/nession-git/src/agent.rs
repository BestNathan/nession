//! The agent-side extension: `extension.git.status` and `extension.git.diff`.
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
use serde_json::{json, Value};
use tracing::debug;

use crate::cmd::GitCmd;
use crate::diff;
use crate::security::MAX_STATUS_BYTES;
use crate::status;

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
    /// The `Err` case is a ready-made response body: every caller needs the
    /// same "we cannot address a repository" answer, and it differs by reason.
    async fn cmd_for(&self, payload: &Value) -> Result<GitCmd, Value> {
        let session = payload.get("session").and_then(Value::as_str).ok_or_else(
            || json!({ "state": "error", "message": "missing `session` in the request" }),
        )?;

        let workdir = self.resolve_workdir.resolve(session).await.ok_or_else(|| {
            json!({
                "state": "unavailable",
                "reason": "session_workdir_unknown",
                "message": "Could not resolve this Session's working directory.",
            })
        })?;

        Ok(GitCmd::new(self.bin.clone(), workdir))
    }

    /// The checks every command needs before it can answer: is git here at all,
    /// and is this directory a repository? #750 requires these be reported
    /// separately — "no git installed" and "not a repository" are different
    /// problems with different fixes.
    ///
    /// `Ok` carries the work tree root, because every caller needs it and the
    /// probe that answers "is this a repository" already knows it.
    async fn ready(&self, cmd: &GitCmd) -> Result<PathBuf, Value> {
        if !cmd.available().await {
            return Err(json!({
                "state": "unavailable",
                "reason": "git_not_installed",
                "message": "git is not available on this host.",
            }));
        }
        match cmd.resolve_root().await {
            Ok(Some(root)) => Ok(root),
            Ok(None) => Err(json!({
                "state": "not_a_repository",
                "message": "This Session's working directory is not a git repository.",
            })),
            Err(err) => Err(json!({
                "state": "error",
                "message": err.to_string(),
            })),
        }
    }

    async fn handle_status(&self, payload: Value) -> anyhow::Result<Value> {
        let cmd = match self.cmd_for(&payload).await {
            Ok(cmd) => cmd,
            Err(body) => return Ok(body),
        };
        let root = match self.ready(&cmd).await {
            Ok(root) => root,
            Err(body) => return Ok(body),
        };

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

        Ok(json!({
            "state": "ok",
            "status": parsed,
            // The work tree this status describes. Terminal Signal identity
            // needs it (`capability-emergence.md` names the worktree), and the
            // Workspace header shows it, so it rides along rather than costing
            // a second request.
            "root": root.to_string_lossy(),
            // Present so a partial listing is never presented as a whole one.
            "truncated": out.truncated(),
            "truncatedBytes": out.truncated_bytes,
        }))
    }

    async fn handle_diff(&self, payload: Value) -> anyhow::Result<Value> {
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing `path` in the request"))?
            .to_string();

        let cmd = match self.cmd_for(&payload).await {
            Ok(cmd) => cmd,
            Err(body) => return Ok(body),
        };
        if let Err(body) = self.ready(&cmd).await {
            return Ok(body);
        }

        let result = diff::file_diff(&cmd, &path).await?;
        Ok(json!({ "state": "ok", "diff": result }))
    }

    /// The work tree root on its own, for a caller that wants the address and
    /// not the listing (#826: entering the Workspace from a Peek preserves
    /// repo/worktree context without re-fetching the status).
    async fn handle_root(&self, payload: Value) -> anyhow::Result<Value> {
        let cmd = match self.cmd_for(&payload).await {
            Ok(cmd) => cmd,
            Err(body) => return Ok(body),
        };
        match self.ready(&cmd).await {
            Ok(root) => Ok(json!({ "state": "ok", "root": root.to_string_lossy() })),
            Err(body) => Ok(body),
        }
    }
}

#[async_trait]
impl AgentExtension for GitAgentExtension {
    fn name(&self) -> &'static str {
        "git"
    }

    fn message_types(&self) -> &'static [&'static str] {
        &[
            "extension.git.status",
            "extension.git.diff",
            "extension.git.root",
        ]
    }

    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        match command {
            "git.status" => self.handle_status(payload).await,
            "git.diff" => self.handle_diff(payload).await,
            "git.root" => self.handle_root(payload).await,
            other => anyhow::bail!("unknown git command: {other}"),
        }
    }
}
