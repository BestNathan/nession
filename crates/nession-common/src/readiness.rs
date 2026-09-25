//! How a daemon child tells the parent that started it that it is serving.
//!
//! `nession agent start` and `nession server start` run in the background by
//! re-executing themselves with `--foreground` and returning. The parent used to
//! sleep a fixed interval and then report success — so a child that had already
//! died on a bad config, a taken port or an unreadable TLS certificate was
//! reported as a *successful start*, and the operator was told to check the logs
//! (#1016).
//!
//! Readiness is what replaces that: the parent names a path in
//! [`NESSION_READY_FILE_ENV`], and the child writes a marker there at the point
//! it is actually serving — not merely running. The parent waits for that marker
//! with a deadline and watches the child at the same time, so a child that exits
//! reports its own status instead of timing out.
//!
//! ## Why this is not in either runtime
//!
//! Both runtimes need it and they must agree on the variable name and the marker
//! body, because the two sides of the handshake are in different crates: the
//! child writes it from `nession-agent`/`nession-server`, the parent reads it
//! from `nession-cli`. Two copies of a wire name drift silently in exactly the
//! way #1014 was about — here the failure would be a parent that waits out its
//! whole deadline because the child wrote a marker nobody was watching for.
//!
//! ## Where "serving" is, and why it is late
//!
//! The marker must be written after the last step that can fail, not merely
//! after the socket is up. The Server binds its listener in `WebSocketServer::new`
//! but builds its TLS acceptor in `run`, so announcing at the bind would call a
//! server with a missing certificate a successful start — the exact defect this
//! module exists to remove.

/// Environment variable a daemon parent uses to name the readiness marker.
///
/// Set by the parent when it spawns the background child; absent when a user
/// starts a process in the foreground and nobody is waiting.
pub const NESSION_READY_FILE_ENV: &str = "NESSION_READY_FILE";

/// How a daemon parent is told the runtime reached its ready point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    /// Nobody is waiting — the binary was started directly.
    Unwatched,
    /// Write a marker at this path once the runtime is serving.
    Announced(std::path::PathBuf),
}

impl Readiness {
    /// The announcement this process was asked for, if any.
    pub fn from_env() -> Self {
        match std::env::var(NESSION_READY_FILE_ENV) {
            Ok(path) if !path.trim().is_empty() => Self::Announced(path.into()),
            _ => Self::Unwatched,
        }
    }

    /// Announce, if someone asked to be told.
    ///
    /// Call this at the point the process is *serving*, and after the last step
    /// that can fail. Calling it early does not make a broken start look healthy
    /// to the operator by accident — it makes this module's whole purpose a lie,
    /// which is why every call site carries a comment saying why it is where it
    /// is.
    pub fn announce(&self) {
        let Self::Announced(path) = self else {
            return;
        };
        // Staged and renamed, so a parent that sees the file sees a whole one.
        // The parent only tests for existence, so a partially written file
        // would still read as ready — this is what keeps the file's *content*
        // meaningful for anyone reading it after the fact.
        let staged = path.with_extension("tmp");
        let body = format!("ready pid={}\n", std::process::id());
        if let Err(error) =
            std::fs::write(&staged, body).and_then(|()| std::fs::rename(&staged, path))
        {
            // Not fatal to *this* process — it is serving either way — but a
            // waiting parent is now waiting on something that will not arrive,
            // so say so where the logs are.
            tracing::warn!(
                path = %path.display(),
                %error,
                "could not announce readiness; a waiting parent will time out"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn an_announcement_names_this_process() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("ready");

        Readiness::Announced(marker.clone()).announce();

        let body = std::fs::read_to_string(&marker).expect("the marker must exist");
        assert!(
            body.contains(&format!("pid={}", std::process::id())),
            "the marker must name the process that wrote it: {body:?}"
        );
    }

    /// The staging path must not survive: what a parent can see is a whole file.
    #[test]
    fn the_staged_write_leaves_no_debris() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("ready");

        Readiness::Announced(marker).announce();

        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "ready")
            .collect();
        assert!(
            leftover.is_empty(),
            "staging debris left behind: {leftover:?}"
        );
    }
}
