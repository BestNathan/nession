//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::Result;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

use super::cmd::{self, TmuxCmd};
use super::env::EnvManager;
use super::ops::TmuxOps;

/// Width a session is created at, **before any client has attached**.
///
/// A starting size, not a lock. tmux's `window-size` defaults to `latest` and
/// `create_session` deliberately leaves it unset (see `window_size_lock_tests`
/// at the bottom of this file), so the first client to attach resizes the
/// window to its own viewport and every later resize moves it again. There is
/// one window and one pane, shared by every attached client — a client that
/// does not fit scrolls, it does not get a viewport of its own.
///
/// That is the model decided in
/// `2026-08-15-viewport-fit-terminal-migration-design.md` §2
/// ("accept last-writer-wins … No arbitration"), which superseded the
/// fixed-size design this constant was originally sized for.
pub const SESSION_WIDTH: u16 = 200;

/// Default shell prompt injected into every tmux session so the K8s pod
/// hostname (e.g. `nession-agent-staging-84d4d8666f-zs5xj`) doesn't
/// clutter the terminal.  `\u` = user, `\w` = working dir, `\$` = # or $.
pub const DEFAULT_PS1: &str = r"\[\e[32m\]\u\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ ";

/// Height a session is created at, before any client has attached.
/// See [`SESSION_WIDTH`] — a starting size, not a lock.
pub const SESSION_HEIGHT: u16 = 60;

/// Timeout for quick tmux queries (`list-sessions`, `display-message`).
/// Must stay below the server's 3s force-refresh window so a slow list still
/// answers before the server marks the agent stale.
const TMUX_LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// Timeout for `kill-session`.
const TMUX_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for the multi-stage `create_session` (new-session + env setup).
const TMUX_CREATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Variables never forwarded from the agent process into a tmux session.
///
/// `TERM`/`LANG`/`LC_ALL` are forced explicitly below, whatever the host has.
///
/// `TMUX`/`TMUX_TMPDIR` describe whichever tmux server happened to start the
/// agent (they are set for every process inside a tmux pane). Forwarding them
/// makes every shell in a nession session believe it belongs to *that* server,
/// so a bare `tmux kill-server` typed inside a nession session would reach the
/// user's real sessions. nession addresses tmux by `-S` alone and passes none of
/// this on.
const NEVER_FORWARDED_ENV: [&str; 5] = ["TERM", "LANG", "LC_ALL", "TMUX", "TMUX_TMPDIR"];

/// Whether an inherited env var is withheld from a new session — either
/// forced/stripped by policy, or superseded by a caller-supplied value.
fn skip_env(key: &str, caller_keys: &[&str]) -> bool {
    NEVER_FORWARDED_ENV.contains(&key) || caller_keys.contains(&key)
}

// Re-exported from the Protocol Kernel (#678).
//
// This was declared here, and it is serialised straight onto the wire by
// `session.list` — so the agent's tmux model *was* the wire contract, and the
// kernel could not see it. It lives in `contracts/session/v1.rs` now, unchanged
// field for field; a second struct with the same fields would have been two
// definitions of one contract kept in step by nothing.
pub use nession_protocol::contracts::session::v1::SessionInfo;

/// Parse one `list-sessions -F` row.
///
/// `foreground_command` is last and the split is capped, so a `|` inside the
/// command stays part of it instead of shifting the row into the unparseable
/// branch. Session names are the first field and still positional.
fn parse_session_line(line: &str) -> Option<SessionInfo> {
    let parts: Vec<&str> = line.splitn(7, '|').collect();
    if parts.len() != 7 {
        return None;
    }

    let foreground = parts.get(6).copied().unwrap_or_default();
    Some(SessionInfo {
        name: parts
            .first()
            .map(std::string::ToString::to_string)
            .unwrap_or_default(),
        created_at: parts.get(1).and_then(|s| s.parse().ok())?,
        window_count: parts.get(2).and_then(|s| s.parse().ok())?,
        attached_clients: parts.get(3).and_then(|s| s.parse().ok())?,
        width: parts.get(4).and_then(|s| s.parse().ok())?,
        height: parts.get(5).and_then(|s| s.parse().ok())?,
        foreground_command: (!foreground.is_empty()).then(|| foreground.to_string()),
    })
}

/// Manages the lifecycle of tmux sessions (create / list / kill).
///
/// Holds an [`EnvManager`] so that killing a session can clean up any env
/// scripts it left behind. Environment operations themselves are exposed
/// through [`SessionManager::env`].
pub struct SessionManager {
    env: EnvManager,
    /// tmux binary and socket. Every command this manager spawns is built here,
    /// so all of them address nession's own tmux server — see [`crate::tmux::cmd`].
    cmd: TmuxCmd,
    list_timeout: Duration,
    kill_timeout: Duration,
    create_timeout: Duration,
}

impl SessionManager {
    /// Create a `SessionManager` whose env scripts live in the system temp
    /// directory (`std::env::temp_dir()`).
    pub fn new() -> Self {
        Self {
            env: EnvManager::new(std::env::temp_dir()),
            cmd: cmd::global().clone(),
            list_timeout: TMUX_LIST_TIMEOUT,
            kill_timeout: TMUX_KILL_TIMEOUT,
            create_timeout: TMUX_CREATE_TIMEOUT,
        }
    }

    /// Create a `SessionManager` with a custom base directory for env scripts.
    /// Useful for tests and containerized environments with a non-`/tmp`
    /// temporary directory policy.
    pub fn with_script_dir(script_dir: PathBuf) -> Self {
        Self {
            env: EnvManager::new(script_dir),
            ..Self::new()
        }
    }

    /// The tmux socket every command from this manager addresses.
    pub fn socket_path(&self) -> &std::path::Path {
        self.cmd.socket_path()
    }

    /// Test seam: override the tmux binary (inject a fake `tmux`), keeping the
    /// socket unchanged.
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        self.cmd = self.cmd.with_bin(tmux_bin);
        self
    }

    /// Test seam: override per-command timeouts for fast, deterministic tests.
    #[cfg(test)]
    pub(crate) fn with_timeouts(
        &mut self,
        list: Duration,
        kill: Duration,
        create: Duration,
    ) -> &mut Self {
        self.list_timeout = list;
        self.kill_timeout = kill;
        self.create_timeout = create;
        self
    }

    /// Access the environment manager for set/source/unsource operations.
    pub fn env(&self) -> &EnvManager {
        &self.env
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let mut cmd = self.cmd.tokio();
        cmd.args([
            "list-sessions",
            "-F",
            // Use | (pipe) as delimiter. Tmux converts tab characters (0x09)
            // in -F format strings to underscores (0x5F), so \t is unusable.
            // pane_current_command is last so a | inside it cannot shift the row.
            "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}|#{pane_current_command}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            if is_no_sessions_stderr(stderr) {
                tracing::debug!("tmux list-sessions: {} (no tmux server running)", stderr);
            } else {
                tracing::warn!(
                    "tmux list-sessions exited with {}: {}",
                    output.status,
                    stderr
                );
            }
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let sessions: Vec<SessionInfo> = stdout.lines().filter_map(parse_session_line).collect();

        tracing::info!("tmux list-sessions: {} session(s) found", sessions.len());
        Ok(sessions)
    }

    /// Query the current working directory of a tmux session's active pane.
    pub async fn get_session_cwd(&self, session_name: &str) -> Result<String> {
        let mut cmd = self.cmd.tokio();
        cmd.args([
            "display-message",
            "-p",
            "-t",
            session_name,
            "-F",
            "#{pane_current_path}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "tmux display-message failed for session {}: {}",
                session_name,
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
    }

    /// Create a new detached tmux session at [`SESSION_WIDTH`] × [`SESSION_HEIGHT`].
    ///
    /// The `_width` and `_height` parameters are ignored — every session starts
    /// at the same size, and the first client to attach resizes it from there.
    ///
    /// There is deliberately **no per-client viewport**: the session has one
    /// window and one pane, and a resize by any attached client moves it for
    /// all of them. A second client attaching to a session already at 120×40
    /// does not get its own 80×24 — it watches that client's resizes and
    /// resizes it in turn. Last write wins; there is no arbitration
    /// (`2026-08-15-viewport-fit-terminal-migration-design.md` §2).
    ///
    /// `window-size` is left at tmux's default (`latest`) so that clients can
    /// resize the window at all; locking it would freeze the pane at the
    /// create-time size. `window_size_lock_tests` below asserts that it stays
    /// unset.
    pub async fn create_session(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        match tokio::time::timeout(
            self.create_timeout,
            self.create_session_impl(name, width, height, working_dir, env),
        )
        .await
        {
            Err(_) => Err(anyhow::anyhow!(
                "tmux create-session timed out after {:?}",
                self.create_timeout
            )),
            Ok(inner) => inner,
        }
    }

    async fn create_session_impl(
        &self,
        name: &str,
        _width: u16,
        _height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        // Stage 1: try with `-e` (tmux ≥ 3.0).  This injects env vars directly
        // into the shell process so they take effect before bashrc runs — the
        // only reliable way to set PS1 on Debian (bashrc unconditionally
        // overwrites it).
        let mut cmd = self.cmd.tokio();
        cmd.args([
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            &SESSION_WIDTH.to_string(),
            "-y",
            &SESSION_HEIGHT.to_string(),
            "-c",
            working_dir,
        ])
        .stderr(std::process::Stdio::piped());

        // Pass through the agent process environment (PATH, NODE_PATH, etc.)
        // so tools installed via init container are available in tmux sessions.
        // Skip TERM — we force xterm-256color below regardless of what the
        // container has (typically unset or "dumb").
        // Skip the caller-supplied env keys — those are handled below.
        // Collect first — std::env::vars() iterator is not Send.
        let caller_keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        let process_env: Vec<(String, String)> = std::env::vars().collect();
        for (key, value) in process_env.iter() {
            if skip_env(key, &caller_keys) {
                continue;
            }
            cmd.arg("-e").arg(format!("{key}={value}"));
        }
        // Force TERM and locale so TUI apps render correctly.
        // Containers default to C/POSIX locale (no Unicode) → box-drawing
        // characters become underscores; TERM is typically unset or "dumb".
        cmd.arg("-e").arg("TERM=xterm-256color");
        cmd.arg("-e").arg("LANG=C.UTF-8");

        let mut has_ps1 = false;
        for (key, value) in env {
            if key == "PS1" {
                has_ps1 = true;
            }
            cmd.arg("-e").arg(format!("{key}={value}"));
        }
        if !has_ps1 {
            cmd.arg("-e").arg(format!("NESSON_PS1={DEFAULT_PS1}"));
            cmd.arg("-e").arg(
                "PROMPT_COMMAND=[ -n \"$NESSON_PS1\" ] && { PS1=\"$NESSON_PS1\"; unset NESSON_PS1; }",
            );
        }

        let output = cmd.output().await?;
        let use_e = output.status.success();

        if !use_e {
            // Stage 2 (fallback): `-e` not supported (tmux < 3.0).
            // Retry without it, then inject via set-environment for future
            // windows and send-keys for the already-running initial shell.
            let mut cmd2 = self.cmd.tokio();
            cmd2.args([
                "new-session",
                "-d",
                "-s",
                name,
                "-x",
                &SESSION_WIDTH.to_string(),
                "-y",
                &SESSION_HEIGHT.to_string(),
                "-c",
                working_dir,
            ])
            .stderr(std::process::Stdio::piped());

            let output2 = cmd2.output().await?;
            if !output2.status.success() {
                // Surface tmux's actual stderr so the failure is debuggable —
                // previously we swallowed it and emitted only a generic
                // "Failed to create session" bail, which made every root cause
                // look identical.
                let stage1_err = String::from_utf8_lossy(&output.stderr);
                let stage2_err = String::from_utf8_lossy(&output2.stderr);
                anyhow::bail!(
                    "Failed to create session {name}: stage1 stderr: {}; stage2 stderr: {}",
                    stage1_err.trim(),
                    stage2_err.trim()
                );
            }

            // Inject env vars into the live shell via send-keys.
            let mut init_cmd = String::from("export TERM=xterm-256color;export LANG=C.UTF-8;");
            for (key, value) in &process_env {
                if skip_env(key, &caller_keys) {
                    continue;
                }
                init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
            }
            for (key, value) in env {
                init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
            }
            if !has_ps1 {
                init_cmd.push_str(&format!(
                    "export NESSON_PS1='{}';",
                    DEFAULT_PS1.replace('\'', "'\\''")
                ));
                init_cmd.push_str(
                    r#"export PROMPT_COMMAND='[ -n "$NESSON_PS1" ] && { PS1="$NESSON_PS1"; unset NESSON_PS1; }';"#,
                );
            }
            if !init_cmd.is_empty() {
                let _ = self
                    .cmd
                    .tokio()
                    .args(["send-keys", "-t", name, &init_cmd, "Enter"])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
                let _ = self
                    .cmd
                    .tokio()
                    .args(["clear-history", "-t", name])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
        }

        // Stage 3: set-environment for future windows/panes (both paths).
        self.propagate_env_best_effort(name, "TERM", "xterm-256color")
            .await;
        self.propagate_env_best_effort(name, "LANG", "C.UTF-8")
            .await;
        for (key, value) in &process_env {
            if skip_env(key, &caller_keys) {
                continue;
            }
            self.propagate_env_best_effort(name, key, value).await;
        }
        for (key, value) in env {
            self.propagate_env_best_effort(name, key, value).await;
        }
        if !has_ps1 {
            self.propagate_env_best_effort(name, "NESSON_PS1", DEFAULT_PS1)
                .await;
            self.propagate_env_best_effort(
                name,
                "PROMPT_COMMAND",
                "[ -n \"$NESSON_PS1\" ] && { PS1=\"$NESSON_PS1\"; unset NESSON_PS1; }",
            )
            .await;
        }

        // Enable tmux mouse mode so mouse events reach tmux as SGR sequences
        // (copy-mode scroll, pane selection, and forwarding to TUI apps).
        // The web client lets xterm.js use its default behaviour — mouse
        // clicks pass through to the PTY; hold Shift for local selection.
        let _ = self
            .cmd
            .tokio()
            .args(["set-option", "-t", name, "mouse", "on"])
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        Ok(())
    }

    /// Propagate one environment variable to a session's **future** windows and
    /// panes — `tmux set-environment -t <session> <name> <value>`.
    ///
    /// **BestEffort, by decision rather than by omission.** Every call site is
    /// stage 3 of `create_session_impl`, which the code there labels
    /// "set-environment for future windows/panes (both paths)". The environment
    /// the *session's own shell* runs with was established by an earlier stage
    /// whose failure is the create's failure — stage 1's `new-session -e …`, or
    /// stage 2's `send-keys export …`. Stage 3 therefore carries an environment
    /// the initial shell already has to windows that do not exist yet, so its
    /// failure degrades a *later* operation rather than this one: #991's
    /// definition of `Required` is "failure changes the operation result", and
    /// this one does not.
    ///
    /// Three separate classes meet here — the forced pair (`TERM`/`LANG`), the
    /// agent-process passthrough, and the caller's own variables — and they are
    /// the same class for that same reason: in all three, stage 1 or stage 2
    /// already delivered the value to the shell that exists.
    ///
    /// It is **not** `Required`, and making it so would be actively harmful for
    /// the passthrough group: `std::env::vars()` is ambient, and tmux refuses a
    /// variable name beginning with `-` (`unknown flag`, measured on 3.6b), so
    /// one odd name in the agent's environment would fail every session
    /// creation. (A *user-requested* mutation is the opposite case and is
    /// `Required` — that is `EnvManager::set_environment`, whose callers must
    /// report the failure; #980 is what fixed it and this must not undo it.)
    ///
    /// The failure is WARNed rather than dropped, which is the whole difference
    /// from the `let _ = … .stderr(Stdio::null())` calls this replaced: those
    /// discarded both the status and tmux's reason, so a failure here was
    /// unobservable even in logs (#980's invisibility half).
    ///
    /// Bound to `self.cmd` rather than to the process-wide
    /// [`TmuxOps::global`](super::ops::TmuxOps::global): a manager that had been
    /// given a different socket must not propagate its environment onto the
    /// other one. This is *not* #991 step 6 — `SessionManager` already holds
    /// this `TmuxCmd`, and nothing new became injectable.
    async fn propagate_env_best_effort(&self, session: &str, name: &str, value: &str) {
        let ops = TmuxOps::new(self.cmd.clone());
        if let Err(e) = ops.set_environment(session, name, value).await {
            tracing::warn!(
                "best-effort env propagation to future panes of session {session} failed ({name}): {e:#}"
            );
        }
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let mut cmd = self.cmd.tokio();
        cmd.args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::null());
        let status = tmux_status(&mut cmd, self.kill_timeout).await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {name}");
        }

        // Clean up env source/unsource scripts for this session so they
        // don't linger in the temp dir (sourced_env_files() scans it to
        // report which env files are active — orphaned scripts cause stale
        // "sourced" state after the session is gone).
        self.env.cleanup_session_scripts(name).await;

        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a failed `list-sessions` just means "there are no sessions".
///
/// tmux words this two different ways depending on whether the socket file
/// exists yet, and both are the normal state for an idle agent:
///
/// - `no server running on <path>` — the socket file is there, its server is not
/// - `error connecting to <path> (No such file or directory)` — nothing has
///   created the socket yet
///
/// The second case only started appearing once nession moved to its own socket
/// (#575): on tmux's default socket some other server had usually already made
/// the file. Treating it as a failure logged a warning on every poll — every 5s
/// for a freshly started agent with no sessions, which reads as a fault.
fn is_no_sessions_stderr(stderr: &str) -> bool {
    stderr.contains("no server running")
        || (stderr.contains("error connecting to") && stderr.contains("No such file or directory"))
}

/// Run a tmux command, failing with a timeout error if it exceeds `timeout`.
async fn tmux_output(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output> {
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
    }
}

/// Run a tmux command that only needs its exit status, with a timeout.
async fn tmux_status(cmd: &mut Command, timeout: Duration) -> Result<std::process::ExitStatus> {
    match tokio::time::timeout(timeout, cmd.status()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
    }
}

#[cfg(test)]
mod window_size_lock_tests {
    use super::*;
    use crate::test_support::TestSession;

    async fn read_window_size_option(session: &str) -> Result<String> {
        let out = cmd::global()
            .tokio()
            .args(["show-option", "-t", session, "-v", "window-size"])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_does_not_lock_window_size() {
        // Skip on machines without tmux (CI covers it).
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let session = TestSession::new("no-lock");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        // window-size should NOT be explicitly set, leaving it at tmux default
        // so that clients can resize the window.
        let val = read_window_size_option(name).await.expect("show-option");
        assert!(
            val.is_empty(),
            "expected window-size to be unset, got {val:?}"
        );
        // `session` kills the tmux session on drop, panic or not.
    }

    #[tokio::test]
    async fn get_session_cwd_returns_path() {
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let session = TestSession::new("cwd");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        let result = mgr.get_session_cwd(name).await.expect("get_session_cwd");
        // Canonicalize both paths: macOS /var is a symlink to /private/var,
        // and tmux may resolve symlinks differently from std::env::temp_dir().
        let expected = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
        let actual = std::fs::canonicalize(&result).unwrap_or_else(|_| PathBuf::from(&result));
        assert_eq!(
            actual, expected,
            "CWD should match the session's working directory"
        );
        // `session` kills the tmux session on drop, panic or not.
    }

    #[tokio::test]
    async fn tmux_output_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = std::time::Instant::now();
        let res = tmux_output(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn tmux_status_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let res = tmux_status(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
    }

    #[test]
    fn missing_socket_file_counts_as_no_sessions() {
        // The exact wording tmux 3.6b emits for a socket path that does not
        // exist yet — the normal state of an agent that has created no session.
        assert!(is_no_sessions_stderr(
            "error connecting to /tmp/nession-501/tmux.sock (No such file or directory)"
        ));
    }

    #[test]
    fn every_manager_addresses_the_process_socket() {
        // ~60 call sites build a SessionManager with ::new(), and nothing tells
        // them which socket they got. If one stopped inheriting the process-wide
        // one, its sessions would land on a second tmux server: create would
        // succeed, list would not see it, and nothing would report an error.
        assert_eq!(
            SessionManager::new().socket_path(),
            cmd::global().socket_path()
        );
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            SessionManager::with_script_dir(dir.path().to_path_buf()).socket_path(),
            cmd::global().socket_path(),
            "with_script_dir must change only the env-script dir, not the socket"
        );
    }

    #[test]
    fn injecting_a_fake_tmux_keeps_the_socket() {
        // The test seam swaps the binary; a seam that also reset the socket
        // would make fake-tmux tests pass while proving nothing about -S.
        let mut mgr = SessionManager::new();
        let expected = mgr.socket_path().to_path_buf();
        mgr.with_tmux_bin("/nonexistent/fake-tmux");
        assert_eq!(mgr.socket_path(), expected);
    }

    #[test]
    fn stopped_server_counts_as_no_sessions() {
        assert!(is_no_sessions_stderr(
            "no server running on /tmp/nession-501/tmux.sock"
        ));
    }

    #[test]
    fn real_failures_are_not_treated_as_no_sessions() {
        // A permission problem or an over-long path must still warn — silencing
        // those would hide the failures this socket work is meant to surface.
        assert!(!is_no_sessions_stderr(
            "error connecting to /tmp/nession-501/tmux.sock (Permission denied)"
        ));
        assert!(!is_no_sessions_stderr(
            "error connecting to /tmp/x/tmux.sock (File name too long)"
        ));
        assert!(!is_no_sessions_stderr("lost server"));
    }
}

#[cfg(test)]
mod session_line_tests {
    use super::*;

    #[test]
    fn parses_the_session_row_including_foreground_command() {
        let info = parse_session_line("work|1700000000|2|1|120|40|claude").expect("row parses");
        assert_eq!(info.name, "work");
        assert_eq!(info.created_at, 1_700_000_000);
        assert_eq!(info.window_count, 2);
        assert_eq!(info.attached_clients, 1);
        assert_eq!(info.width, 120);
        assert_eq!(info.height, 40);
        assert_eq!(info.foreground_command.as_deref(), Some("claude"));
    }

    #[test]
    fn keeps_a_pipe_inside_the_foreground_command() {
        // The command is the last field, so a delimiter inside it must survive
        // instead of shifting every row into the "unparseable" branch.
        let info = parse_session_line("work|1700000000|1|0|80|24|we|ird").expect("row parses");
        assert_eq!(info.foreground_command.as_deref(), Some("we|ird"));
    }

    #[test]
    fn reports_an_absent_foreground_command_as_none() {
        let info = parse_session_line("work|1700000000|1|0|80|24|").expect("row parses");
        assert_eq!(info.foreground_command, None);
    }

    #[test]
    fn rejects_rows_with_too_few_fields() {
        assert!(parse_session_line("work|1700000000|1|0|80|24").is_none());
    }

    #[test]
    fn rejects_rows_with_unparseable_numbers() {
        assert!(parse_session_line("work|not-a-number|1|0|80|24|claude").is_none());
    }
}
