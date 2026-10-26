//! Explicit tmux process addressing and construction.
//!
//! Every tmux process this crate spawns is built here, so every one of them
//! carries an explicit `-S <socket path>`. The caller supplies the socket; the
//! crate never resolves a default, never reads an ambient configuration and
//! never falls back to the caller's personal tmux server. That is the property
//! the library exists to make structural: a tmux invocation without `-S` does
//! not fail — it succeeds against a different server, where the user's own
//! sessions live.
//!
//! ## Environment is never trusted
//!
//! Each command explicitly removes `TMUX` and `TMUX_TMPDIR` from the child
//! environment. Neither is used for addressing — `-S` decides that — but an
//! inherited `TMUX` describes some *other* server, and leaving it in place lets
//! a tmux client or a shell inside a session act on that one instead.
//!
//! ## A dead server's socket is healed, once
//!
//! A tmux server that dies without unlinking (SIGKILL, a crash, power loss)
//! leaves the socket file behind, and every later call against it fails with
//! `server exited unexpectedly` — a message that names neither the socket nor
//! the fact that nothing listens on it. [`heal_stale_socket`] is the precise
//! check (`ECONNREFUSED` on a file that is a socket), and the constructors in
//! this module retry once after it between a failure and the retry.

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};

/// Environment variables that describe a tmux server we are not addressing.
/// Stripped from every child so behaviour never depends on inheritance.
pub const INHERITED_TMUX_VARS: [&str; 2] = ["TMUX", "TMUX_TMPDIR"];

/// A tmux binary, the socket every command it builds will address, and an
/// optional server configuration file.
///
/// `socket` must be an absolute path; use [`Self::is_absolute`] or
/// [`Self::validate`] before spawning if the value comes from untrusted input.
/// `config_file` is passed as `-f` on every invocation. That is deliberate:
/// tmux reads a server configuration only when it *starts* a server, so the
/// invocation that happens to start it must be the one that installs the
/// caller's defaults. Passing `-f` when a server is already running is ignored
/// by tmux, and a missing file is harmless (measured on tmux 3.6b).
#[derive(Debug, Clone)]
pub struct TmuxCommand {
    bin: String,
    socket: PathBuf,
    config_file: Option<PathBuf>,
}

impl TmuxCommand {
    /// Bind a tmux binary to a socket path. Does not touch the filesystem.
    pub fn new(bin: impl Into<String>, socket: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            socket: socket.into(),
            config_file: None,
        }
    }

    /// Pass `-f <path>` on every invocation.
    pub fn with_config_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_file = Some(path.into());
        self
    }

    /// The socket this instance addresses.
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// The tmux binary name or path.
    pub fn bin(&self) -> &str {
        &self.bin
    }

    /// The server configuration passed as `-f`, when one is configured.
    pub fn config_file(&self) -> Option<&Path> {
        self.config_file.as_deref()
    }

    /// Whether the configured socket is an absolute path.
    pub fn is_absolute(&self) -> bool {
        self.socket.is_absolute()
    }

    /// Reject a relative socket before anything is spawned.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.socket.as_os_str().is_empty() {
            anyhow::bail!("tmux socket path is empty");
        }
        if !self.socket.is_absolute() {
            anyhow::bail!(
                "tmux socket path must be absolute, got {}",
                self.socket.display()
            );
        }
        Ok(())
    }

    /// Same socket, different binary — the seam for injecting a fake tmux.
    pub fn with_bin(&self, bin: impl Into<String>) -> Self {
        Self {
            bin: bin.into(),
            socket: self.socket.clone(),
            config_file: self.config_file.clone(),
        }
    }

    /// A `tokio::process::Command` for `tmux -S <socket> [-f <config>]`.
    pub fn tokio(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// A `std::process::Command` for `tmux -S <socket> [-f <config>]`, for the
    /// synchronous call sites that cannot await.
    pub fn std(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// The global flags every invocation carries, in order.
    fn apply_addressing(&self, mut arg: impl FnMut(&std::ffi::OsStr)) {
        arg(std::ffi::OsStr::new("-S"));
        arg(self.socket.as_os_str());
        if let Some(config) = &self.config_file {
            arg(std::ffi::OsStr::new("-f"));
            arg(config.as_os_str());
        }
    }

    /// Run `tmux <args>` to completion, capturing stdout and stderr, with one
    /// self-heal: when the command fails because a dead server left its socket
    /// behind, remove the stale socket and run the command once more.
    pub async fn output(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        self.output_with(|cmd| {
            cmd.args(args);
        })
        .await
    }

    /// [`output`](Self::output) for a command built incrementally.
    ///
    /// The closure runs against a fresh command per attempt, so a retried call
    /// gets exactly the argv the first attempt had.
    pub async fn output_with(
        &self,
        build: impl Fn(&mut tokio::process::Command),
    ) -> std::io::Result<std::process::Output> {
        let mut first = self.tokio();
        build(&mut first);
        let out = first.output().await?;
        if out.status.success() || !heal_stale_socket(&self.socket) {
            return Ok(out);
        }
        let mut retry = self.tokio();
        build(&mut retry);
        retry.output().await
    }

    /// The blocking form of [`output`](Self::output), for callers that cannot
    /// await. Same self-heal.
    pub fn output_blocking(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        let out = self.std().args(args).output()?;
        if out.status.success() || !heal_stale_socket(&self.socket) {
            return Ok(out);
        }
        self.std().args(args).output()
    }

    /// A `portable_pty::CommandBuilder` for `tmux -S <socket> [-f <config>]`.
    ///
    /// portable-pty has its own command type, so this cannot reuse
    /// [`Self::std`]. A PTY attach child inherits the caller's environment,
    /// which may carry no usable `TERM`; tmux then fails with "terminal does
    /// not support clear" and the client sees a dead session. The terminal is
    /// pinned so attach renders regardless of what the parent inherited.
    pub fn pty(&self) -> portable_pty::CommandBuilder {
        let mut cmd = portable_pty::CommandBuilder::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd.env("TERM", "xterm-256color");
        cmd
    }
}

/// One self-heal for a socket a dead server left behind: remove it, but only
/// when it provably has no listener.
///
/// The criterion is `ECONNREFUSED`, not "connect failed". Permission errors and
/// timeouts also fail a connect, and in those cases the server may be serving —
/// deleting its socket would take a live server off addressing. Refused is the
/// kernel's own "nothing is listening", identical on Linux and macOS, and the
/// only condition under which the file is removed. A path that is not a socket
/// is never touched either: it is not ours to delete.
///
/// The accepted race: a server in the microseconds between `bind` and `listen`
/// also answers `ECONNREFUSED`. It is accepted because the alternative is
/// permanent unavailability of that socket, and because a caller normally owns
/// one server per socket.
///
/// Returns `true` when a stale socket was found and removed.
#[cfg(unix)]
pub fn heal_stale_socket(socket: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(socket) else {
        return false; // nothing there — nothing to heal
    };
    if !meta.file_type().is_socket() {
        return false;
    }
    let Err(err) = std::os::unix::net::UnixStream::connect(socket) else {
        return false; // someone is listening — the socket is alive
    };
    if err.kind() != std::io::ErrorKind::ConnectionRefused {
        return false; // only "no listener" is ours to repair
    }
    match std::fs::remove_file(socket) {
        Ok(()) => {
            tracing::warn!(
                "removed stale tmux socket {} — nothing was listening on it \
                 (ECONNREFUSED); the previous server died without unlinking",
                socket.display()
            );
            true
        }
        Err(err) => {
            tracing::warn!(
                "tmux socket {} has no listener but could not be removed: {err}",
                socket.display()
            );
            false
        }
    }
}

/// tmux is unix-only; elsewhere there is no unix socket to heal.
#[cfg(not(unix))]
pub fn heal_stale_socket(_socket: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_socket_is_refused() {
        let cmd = TmuxCommand::new("tmux", "relative/tmux.sock");
        assert!(!cmd.is_absolute());
        assert!(cmd.validate().is_err());
    }

    #[test]
    fn an_absolute_socket_is_accepted() {
        let cmd = TmuxCommand::new("tmux", "/tmp/nession-tmux-test/tmux.sock");
        assert!(cmd.validate().is_ok());
    }

    #[test]
    fn the_config_file_is_optional_and_passed_only_when_set() {
        let without = TmuxCommand::new("tmux", "/tmp/x/tmux.sock");
        let args: Vec<_> = without
            .std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["-S", "/tmp/x/tmux.sock"]);

        let with = without.with_config_file("/tmp/x/tmux.conf");
        let args: Vec<_> = with
            .std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["-S", "/tmp/x/tmux.sock", "-f", "/tmp/x/tmux.conf"]
        );
    }

    #[test]
    fn inherited_tmux_addressing_is_removed_from_the_child() {
        let cmd = TmuxCommand::new("tmux", "/tmp/x/tmux.sock");
        let removed: Vec<_> = cmd
            .std()
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains(&"TMUX".to_string()));
        assert!(removed.contains(&"TMUX_TMPDIR".to_string()));
    }
}
