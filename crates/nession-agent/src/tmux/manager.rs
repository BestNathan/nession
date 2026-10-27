//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::Result;
use std::path::PathBuf;
use std::time::Duration;

use super::cmd::{self, TmuxCmd};
use super::env::EnvManager;
use super::ops::{TmuxDep, TmuxOps};

/// The environment that tells a Claude Code integration which Nession session it
/// is in, and where to report what it is doing (`#1005`).
///
/// Injected into every session unconditionally. These two are the *only* things
/// the plugin's hook checks before it acts, and it acts by copying its stdin to
/// the named file — so a session that lacks them is one where Claude runs and
/// reports nothing, which is a binding that never appears rather than an error
/// anyone sees.
///
/// The derivation itself lives in [`crate::claude_binding`], which the reader
/// uses too; see that module for why it is shared rather than written out here.
/// See it also for why nothing is created here: the hook writes with `cat >`,
/// but giving session creation a filesystem side effect would put the
/// developer's real state directory in the path of every test that creates a
/// session. The agent creates it at startup, beside the plugin whose hook needs
/// it — the only time it can matter, because the hook cannot run before it is
/// installed. This function reads no filesystem.
fn claude_binding_env(session_name: &str) -> Vec<(String, String)> {
    crate::claude_binding::env_for(session_name)
}

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
    /// Memory threshold percentage (0-100) for rejecting new sessions.
    /// `None` means use the default (90%). See [`crate::memory::check_memory_pressure`].
    memory_threshold_percent: Option<u8>,
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
            memory_threshold_percent: None,
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

    /// The tmux dependency this manager runs on, for the callers that are
    /// handed tmux addressing rather than reaching for the process-wide one —
    /// the attach backends ([`PtySession`](super::pty::PtySession),
    /// [`ControlModeSession`](super::control::ControlModeSession)).
    ///
    /// One manager's addressing, so a substituted binary reaches them too:
    /// without this the WebSocket layer would open an attach on the
    /// process-wide tmux while creating the session on the injected one.
    pub fn tmux_dep(&self) -> TmuxDep {
        TmuxDep::injected(self.cmd.clone())
    }

    /// The admin operations bound to this manager's addressing and budgets.
    fn sdk_ops(&self) -> TmuxOps {
        TmuxOps::new(self.cmd.as_sdk().clone()).with_timeouts(
            self.list_timeout,
            self.kill_timeout,
            self.create_timeout,
        )
    }

    /// Test seam: replace the whole tmux addressing (binary **and** socket).
    ///
    /// The substitution is *total* as of #991 step 6: it rebinds the manager's
    /// own addressing **and** the [`EnvManager`] it holds, whose operations used
    /// to reach the process-wide tmux behind this manager's back. A test that
    /// injects a fake and then drives `env().set_environment(…)` is driving the
    /// fake; before that, it was driving the real binary on the real socket and
    /// could not tell.
    #[cfg(test)]
    pub(crate) fn with_tmux_cmd(&mut self, cmd: TmuxCmd) -> &mut Self {
        self.cmd = cmd;
        self.env.with_tmux(TmuxDep::injected(self.cmd.clone()));
        self
    }

    /// Test seam: override the tmux binary (inject a fake `tmux`), keeping the
    /// socket unchanged. See [`with_tmux_cmd`](Self::with_tmux_cmd) for why the
    /// rebind must reach the [`EnvManager`] too — and prefer that seam when the
    /// test counts calls against a refusing fake: since #1225 a failed call
    /// heals + retries when the socket is verifiably dead, so the socket the
    /// retry decision reads must be one the test owns.
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        let cmd = self.cmd.with_bin(tmux_bin);
        self.with_tmux_cmd(cmd)
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

    /// Set the memory threshold percentage for rejecting new sessions.
    ///
    /// When container memory usage exceeds this percentage of the cgroup limit,
    /// `create_session` refuses to create a new session and returns an error.
    /// Pass `None` to use the default (90%).
    ///
    /// This is a runtime configuration, not a test seam — it is called by the
    /// agent runtime after loading [`AgentConfig`](crate::config::AgentConfig).
    pub fn with_memory_threshold(&mut self, threshold: Option<u8>) -> &mut Self {
        self.memory_threshold_percent = threshold;
        self
    }

    /// Access the environment manager for set/source/unsource operations.
    pub fn env(&self) -> &EnvManager {
        &self.env
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        Ok(self
            .sdk_ops()
            .list_sessions()
            .await?
            .into_iter()
            .map(|session| SessionInfo {
                name: session.name,
                created_at: session.created_at,
                window_count: session.window_count,
                attached_clients: session.attached_clients,
                width: session.width,
                height: session.height,
                foreground_command: session.foreground_command,
                working_dir: session.working_dir,
            })
            .collect())
    }

    /// Query the current working directory of a tmux session's active pane.
    pub async fn get_session_cwd(&self, session_name: &str) -> Result<String> {
        self.display_message(session_name, "#{pane_current_path}")
            .await
    }

    /// The command running in a tmux session's active pane.
    ///
    /// This is what tells the Claude Code capability whether Claude is running
    /// **now** (#1005 criterion 4). It is the same signal the Web projection
    /// already uses to decide the capability is `active`, which is deliberate:
    /// one source means the terminal's presence and the conversation's
    /// freshness cannot disagree about whether Claude is running.
    pub async fn get_session_command(&self, session_name: &str) -> Result<String> {
        self.display_message(session_name, "#{pane_current_command}")
            .await
    }

    async fn display_message(&self, session_name: &str, format: &str) -> Result<String> {
        self.sdk_ops().display_message(session_name, format).await
    }

    /// Create a new detached tmux session at `width` × `height`.
    ///
    /// `width` is the release-selected fixed column count (#2487): the caller
    /// arrives with the Server's value (relayed create) or this Agent's
    /// configuration (a direct/standalone caller). It is validated rather than
    /// clamped, so a bad caller is told instead of silently given a different
    /// grid. `height` is the initial pane height; the first client to attach
    /// replaces it with its measured rows.
    ///
    /// There is deliberately **no per-client viewport**: the session has one
    /// window and one pane, and a row resize by the controller moves it for
    /// all of them. Width, once chosen here or by the pane that already
    /// exists, is the Session's authority and is enforced on resize.
    ///
    /// `window-size` is left at tmux's default (`latest`) so that clients can
    /// resize the window at all; locking it would freeze the pane at the
    /// create-time size. `window_size_lock_tests` below asserts that it stays
    /// unset.
    /// Validate a client-requested initial cwd before tmux starts.
    pub fn validate_initial_working_dir(path: &str) -> Result<String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            anyhow::bail!("working_dir is empty");
        }
        let p = std::path::Path::new(trimmed);
        if !p.is_absolute() {
            anyhow::bail!("working_dir must be absolute");
        }
        if !p.exists() {
            anyhow::bail!("working_dir does not exist");
        }
        if !p.is_dir() {
            anyhow::bail!("working_dir is not a directory");
        }
        Ok(trimmed.to_string())
    }

    pub async fn create_session(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        // Check memory pressure before creating a new session. This prevents
        // container-level OOM by refusing new sessions when memory usage is too
        // high, rather than letting the entire container die.
        crate::memory::check_memory_pressure(self.memory_threshold_percent)?;

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

    /// The Nession policy half of create: which environment a session
    /// inherits, and the cosmetic cleanup that only the fallback path needs.
    /// The argv and the three-stage delivery are the SDK's
    /// [`TmuxOps::new_session`].
    async fn create_session_impl(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        nession_common::config::validate_terminal_cols(width).map_err(anyhow::Error::msg)?;
        // History depth needs nothing here: it travels as `-f` on every tmux
        // invocation this manager makes (`cmd.rs`), so whichever one starts the
        // server installs it before the window below exists.
        //
        // Pass through the agent process environment (PATH, NODE_PATH, etc.) so
        // tools installed via an init container are available in sessions.
        // `skip_env` withholds TERM/LANG/LC_ALL/TMUX/TMUX_TMPDIR and the
        // caller-supplied keys; TERM and the locale are forced below regardless
        // of what the container has.
        let caller_keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        let has_ps1 = env.iter().any(|(key, _)| key == "PS1");
        let claude_env = claude_binding_env(name);

        // Force TERM and locale first so TUI apps render correctly. Containers
        // default to C/POSIX (no Unicode) and an unset or "dumb" TERM.
        let mut session_env: Vec<(String, String)> = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
        ];
        session_env.extend(std::env::vars().filter(|(key, _)| !skip_env(key, &caller_keys)));
        session_env.extend(env.iter().cloned());
        if !has_ps1 {
            session_env.push(("NESSON_PS1".to_string(), DEFAULT_PS1.to_string()));
            session_env.push((
                "PROMPT_COMMAND".to_string(),
                r#"[ -n "$NESSON_PS1" ] && { PS1="$NESSON_PS1"; unset NESSON_PS1; }"#.to_string(),
            ));
        }
        session_env.extend(claude_env);

        let outcome = self
            .sdk_ops()
            .new_session(&nession_tmux::ops::NewSession {
                name: name.to_string(),
                working_dir: working_dir.to_string(),
                width,
                height,
                env: session_env,
            })
            .await?;

        if !outcome.used_e {
            // BestEffort cosmetic cleanup: hides the `export …` line the
            // fallback typed from the pane's scrollback. The environment was
            // delivered by that statement, so a scrollback that could not be
            // cleared is still a session that has it.
            crate::tmux::env::clear_history(&self.tmux_dep(), name).await;
        }

        // Enable tmux mouse mode so mouse events reach tmux as SGR sequences
        // (copy-mode scroll, pane selection, and forwarding to TUI apps). The
        // web client lets xterm.js use its default behaviour.
        //
        // **BestEffort**: a failure degrades *interaction* (no mouse-driven
        // copy-mode, no pane selection) but not the session. The option is not
        // consulted on the input path, it holds no session state, and the web
        // client carries its own scrollback. Observable rather than dropped:
        // the failure is WARNed with tmux's reason.
        if let Err(e) = self.sdk_ops().set_option(name, "mouse", "on").await {
            tracing::warn!("best-effort `set-option mouse on` for session {name} failed: {e:#}");
        }

        Ok(())
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        self.sdk_ops().kill_session(name).await?;

        // Clean up env source/unsource scripts for this session so they do not
        // linger in the temp dir (sourced_env_files() scans it to report which
        // env files are active — orphaned scripts cause stale "sourced" state
        // after the session is gone).
        self.env.cleanup_session_scripts(name).await;

        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
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
}

/// `history-limit` is the agent's decision, made at the one moment it works.
///
/// Separate from `window_size_lock_tests` because the assertion is a different
/// kind: window-size is asserted to be *unset*, this to be *set, to an exact
/// value, early enough to matter*.
#[cfg(test)]
mod history_limit_tests {
    use super::*;
    use crate::test_support::TestSession;
    use crate::tmux::HISTORY_LIMIT_LINES;

    /// The **window's own** history-limit — not the server default, and not the
    /// value the option happens to hold right now.
    ///
    /// That distinction is the whole test, and it was measured rather than
    /// assumed (tmux 3.6b): with the global set to 10000, a window created
    /// under it reports `#{history_limit}` 10000; after the global moves to
    /// 5000 a window created then reports 5000 and the first still reports
    /// 10000. So the number tracks the value **at window creation**, which is
    /// exactly the property `set_history_limit_args` exists for.
    ///
    /// `show-option -t <session> -v history-limit` cannot be used: it reports
    /// the *window-local* setting, which is empty for an option that was only
    /// ever set globally — measured, and the reason this reads a format
    /// instead. `#{history_limit}` is the effective value.
    async fn read_window_history_limit(session: &str) -> Result<String> {
        let out = cmd::global()
            .tokio()
            .args(["display-message", "-p", "-t", session, "#{history_limit}"])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_sets_history_limit_before_the_window_exists() {
        // Skip on machines without tmux (CI covers it).
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        // `configure` is what writes the server configuration beside the
        // socket, so this test has to run it — the depth arrives through `-f`
        // on an invocation that starts a server, and a socket directory with
        // no config file is the state every other test runs in (harmlessly:
        // tmux tolerates a `-f` naming nothing).
        //
        // It is idempotent and resolves to the same socket `global()` already
        // uses, so running it here does not disturb the tests sharing this
        // process. Reddens without it, which is the point: it is the step that
        // installs the value.
        crate::tmux::cmd::configure(None).expect("configure the tmux addressing");

        let mgr = SessionManager::new();
        let session = TestSession::new("history-limit");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        let value = read_window_history_limit(name)
            .await
            .expect("show-option history-limit");
        assert_eq!(
            value,
            HISTORY_LIMIT_LINES.to_string(),
            "the window must be created with nession's depth. This reads the \
             value the window was created under, so tmux's own default here \
             means the call moved after `new-session` — where tmux documents it \
             as a no-op (#321)."
        );
        // `session` kills the tmux session on drop, panic or not.
    }
}

/// The fake-tmux tests for `create_session`'s legacy stage 2.
///
/// `#[cfg(test)]` with per-item `#[cfg(unix)]` rather than `cfg(all(test,
/// unix))` on the module: clippy's `allow-expect-in-tests` (clippy.toml)
/// recognizes a `cfg(test)` module, and spelling the predicate as `all(...)`
/// hides that from it — the module's `.expect(…)` calls then read as
/// production code and the lint gate fails. The items are Unix-only because
/// they write and chmod a `#!/bin/sh` script.
#[cfg(test)]
mod legacy_stage_two_tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn stage_two_types_the_env_line_as_the_owners_argv() {
        // Stage 2 is the path for a tmux older than 3.0, so it cannot be reached
        // on this machine's tmux at all — the fake is what makes the migrated
        // call site observable. It is `let _ =` in production, so nothing else
        // would notice if the line were suddenly sent as five separate
        // keystrokes, or without its `Enter`.
        //
        // Reddens on: dropping `Enter` from `send_keys_args` (the call becomes
        // three entries long plus… → `len() == 5` and the last-entry assertion
        // fail), splitting the line into key names (length), or swapping the
        // `-t` order (the prefix assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(dir.path(), "");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("stage2-argv");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("against the fake, create takes its legacy stage-2 path");

        let calls = fake.calls();
        let typed = calls
            .iter()
            .find(|args| args.first().map(String::as_str) == Some("send-keys"))
            .unwrap_or_else(|| panic!("stage 2 must type the environment line: {calls:?}"));

        assert_eq!(
            typed.len(),
            5,
            "send-keys takes the whole line as ONE argument and the trailing \
             Enter is part of the operation: {typed:?}"
        );
        assert_eq!(
            typed[..3].iter().map(String::as_str).collect::<Vec<&str>>(),
            ["send-keys", "-t", session.name()],
            "the session is the target, in the owner's order: {typed:?}"
        );
        assert_eq!(
            typed.last().map(String::as_str),
            Some("Enter"),
            "a line that is typed but never submitted sets nothing: {typed:?}"
        );
        assert!(
            typed[3].starts_with("export TERM='xterm-256color';")
                && typed[3].contains("export LANG='C.UTF-8';"),
            "the line is the export chain stage 2 builds, unchanged: {typed:?}"
        );
    }

    /// The stage-2 fake for the two `Required`/`BestEffort` tests below: it
    /// fails the *first* `new-session` so `create_session` takes its legacy
    /// stage-2 path, then fails whichever subcommands `failures` names, and
    /// succeeds at everything else.
    ///
    /// The first-`new-session` failure is what makes the path observable at all:
    /// on this machine's tmux (3.6b) stage 1 always succeeds, so every
    /// assertion about stage 2 would otherwise be about a path that never ran.
    #[cfg(unix)]
    fn stage_two_fake(dir: &std::path::Path, failures: &str) -> crate::test_support::FakeTmux {
        let stage1 = dir.join("stage1-ran");
        crate::test_support::FakeTmux::new(
            dir,
            &format!(
                "case \"$1\" in\n\
                 new-session)\n\
                   if [ -f \"{s1}\" ]; then exit 0; else : > \"{s1}\"; exit 1; fi;;\n\
                 {failures}\
                 *) exit 0;;\n\
                 esac",
                s1 = stage1.display(),
            ),
        )
    }

    /// The calls the fake recorded for one subcommand, as argv vectors.
    #[cfg(unix)]
    fn calls_of(fake: &crate::test_support::FakeTmux, subcommand: &str) -> Vec<Vec<String>> {
        fake.calls()
            .into_iter()
            .filter(|args| args.first().map(String::as_str) == Some(subcommand))
            .collect()
    }

    #[tokio::test]
    async fn the_binding_environment_reaches_the_session_on_the_fallback_path() {
        // Stage 2 is the tmux < 3.0 path: `new-session -e` is refused and the
        // live shell is given its environment by a `send-keys` line instead.
        // That line is built separately, so nothing about stage 1 covers it —
        // and a session on this path without the variables is one where the
        // hook silently reports nothing, which is the failure this whole stage
        // exists to prevent.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(dir.path(), "");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("claude-binding-stage2");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a refused -e falls back rather than failing");

        let sent = calls_of(&fake, "send-keys")
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let id_var = nession_claude_code::binding::SESSION_ID_ENV;
        let file_var = nession_claude_code::binding::BINDING_FILE_ENV;

        assert!(
            sent.contains(&format!("{id_var}='{}'", session.name())),
            "the fallback path must export the session id too: {sent}"
        );
        assert!(
            sent.contains(&format!("{file_var}='")),
            "the fallback path must name the binding file too: {sent}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_stage_two_line_fails_the_create() {
        // #991 step 7's one *classification change* on this file's create path:
        // stage 2's `send-keys` was `let _ =` (step 5 left the class open and
        // said so), and it is `Required` now. On the stage-2 path that line is
        // the only thing that gives the live shell the requested environment —
        // stage 3 only reaches windows that do not exist yet — so a create that
        // answered `Ok` after it failed is #980 one stage along.
        //
        // Reddens on: restoring `let _ =` (the `expect_err` below then fails —
        // this is the mutation that pins the class), dropping the
        // `with_context` (the session-naming assertion), and `TmuxOps::send_keys`
        // discarding tmux's stderr (the marker assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(
            dir.path(),
            "send-keys) echo 'injected tmux refuses send-keys' >&2; exit 1;;\n",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step7-required-stage2");

        let err = mgr
            .create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect_err("a stage-2 line that never ran must fail the create");

        let message = format!("{err:#}");
        assert!(
            message.contains("injected tmux refuses send-keys"),
            "a Required failure carries what tmux said, end to end: {message}"
        );
        assert!(
            message.contains("failed to inject the environment line into session")
                && message.contains(session.name()),
            "and it says which create it was: {message}"
        );
        assert_eq!(
            calls_of(&fake, "new-session").len(),
            2,
            "the create really took the stage-2 path: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_cosmetic_stage_two_call_still_creates_the_session() {
        // The other half of the same path, and the contrast the criterion needs:
        // `clear-history` (cosmetic — it hides the `export …` line the
        // statement above typed) and `set-option mouse on` (presentation — see
        // the class comment at that call site) are `BestEffort`, and the fake
        // refuses both.
        //
        // Reddens on: making either one `Required` (the `expect` below then
        // fails), and on removing either call (the recorded-call assertions
        // fail) — which is what says this test is about those two calls and not
        // about the create.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(
            dir.path(),
            "clear-history) echo 'injected tmux refuses clear-history' >&2; exit 1;;\n\
             set-option) echo 'injected tmux refuses set-option' >&2; exit 1;;\n",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step7-best-effort-stage2");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a cosmetic failure after a successful primary must not take the create down");

        assert_eq!(
            calls_of(&fake, "clear-history"),
            vec![vec!["clear-history", "-t", session.name()]],
            "the scrollback is still cleared — through the one implementation of \
             that operation, on this manager's own tmux: {:#?}",
            fake.calls()
        );
        assert_eq!(
            calls_of(&fake, "set-option"),
            vec![vec!["set-option", "-t", session.name(), "mouse", "on"]],
            "mouse mode is still requested, targeted at the session: {:#?}",
            fake.calls()
        );
    }
}

/// What `with_tmux_bin` substitutes, now that it substitutes more than the
/// manager's own addressing (#991 step 6).
///
/// `#[cfg(test)]` with per-item `#[cfg(unix)]` for the same reason as
/// `legacy_stage_two_tests` above: the fake is a `#!/bin/sh` script, and a
/// `all(test, unix)` predicate on the module would hide the `cfg(test)` from
/// clippy's `allow-expect-in-tests`.
#[cfg(test)]
mod injected_tmux_tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn with_tmux_bin_reaches_the_env_manager_beside_the_manager() {
        // The whole point of step 6, asserted at the seam every existing test
        // already uses. `mgr.env()` reaches an `EnvManager` that resolved
        // `TmuxOps::global()` at each call before this step, so a fake injected
        // here covered `create_session` and stopped: the env operations ran
        // against the real binary on the process socket, and the test could not
        // see it.
        //
        // The assertion is on the fake's own record, not on the error the
        // caller got: an error alone would be produced just as well by real
        // tmux refusing a session that does not exist.
        //
        // The fake's stderr is a marker real tmux never prints, for the same
        // reason: TMUX's own wording for a missing session would satisfy the
        // message assertion whether or not the injection took, so a message
        // that cannot be real tmux's is what makes that assertion mean "the
        // injected binary's words travelled".
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in set-environment) echo 'injected tmux refuses nession-fake' >&2; \
             exit 1;; *) exit 0;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);

        let err = mgr
            .env()
            .set_environment(
                "nession-fake",
                &[("NESSON_WIRED".to_string(), "1".to_string())],
            )
            .await
            .expect_err("the injected binary refuses every set-environment");
        assert!(
            err.to_string()
                .contains("injected tmux refuses nession-fake"),
            "the failure must be the injected binary's: {err}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec![
                "set-environment",
                "-t",
                "nession-fake",
                "NESSON_WIRED",
                "1"
            ]],
            "the env operation must have run on the injected binary"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_claude_binding_environment_reaches_the_session() {
        // #1005. The plugin's hook acts only when both are present, so a session
        // created without them is one where Claude runs and reports nothing —
        // a binding that never appears, and no error anyone can see.
        //
        // The assertion is on the *names* being present with usable values
        // rather than on an exact path: the path comes from the agent's state
        // directory, which a test must not pin to whatever the machine running
        // it happens to have.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("claude-binding-env");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("create");

        let calls = fake.calls();
        let create = calls
            .iter()
            .find(|args| args.first().map(String::as_str) == Some("new-session"))
            .expect("the create ran");
        let argv = create.join("\n");

        let id_var = nession_claude_code::binding::SESSION_ID_ENV;
        let file_var = nession_claude_code::binding::BINDING_FILE_ENV;
        // The name tmux was actually given, which `TestSession` makes unique —
        // asserting the literal passed to it would pass on a machine where no
        // other test had run, and fail everywhere else.
        let name = session.name();

        assert!(
            argv.contains(&format!("{id_var}={name}")),
            "the session id must be the name tmux was given, or the hook binds \
             the wrong session: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=")),
            "the binding file must be named, or the hook has nowhere to write: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=/")),
            "the binding file must be an absolute path — the hook runs from \
             whatever cwd Claude was started in: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=/")),
            "the binding file must be an absolute path: {argv}"
        );
        let binding_line = argv
            .lines()
            .find(|line| line.starts_with(&format!("{file_var}=")))
            .expect("the binding file is named");
        assert!(
            binding_line.ends_with(&format!("{name}.json")),
            "the binding file must be this session's, not a shared one: {binding_line}"
        );
    }

    #[tokio::test]
    async fn best_effort_propagation_reports_a_failure_and_still_creates_the_session() {
        // Stage 3's arm: `propagate_env_best_effort`'s
        // `if let Err(e) = … { tracing::warn!(…) }`. Steps 3–4 classified this
        // `BestEffort` *by experiment* (stage 1 already delivered the value to
        // the shell that exists, so turning this off left the callers' tests
        // green). The fake is what makes the failure observable instead of
        // argued: every `set-environment` it is handed fails, so the only arm
        // the call can take is the warn — and the session is created anyway.
        //
        // Reddens on: making the propagation `Required` (the `expect` below
        // then fails), and on dropping the calls entirely (`propagated` is 0 —
        // which is the mutation that says this test is about the propagation
        // and not about the create).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in set-environment) echo 'unknown flag -e' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step6-best-effort");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a best-effort env failure must not take the session create down");

        let calls = fake.calls();
        let propagated = calls
            .iter()
            .filter(|args| args.first().map(String::as_str) == Some("set-environment"))
            .count();
        assert!(
            propagated >= 2,
            "TERM and LANG alone are propagated to future panes, and every one \
             of them failed here: {calls:?}"
        );

        // The control the test needs to mean anything: the *same* binary
        // refuses a required mutation through the *same* manager, so "the
        // create succeeded" above is the BestEffort class and not a tmux that
        // quietly accepted everything. Without this, a fake that never failed
        // would satisfy the assertions above.
        let required = mgr
            .env()
            .set_environment(
                session.name(),
                &[("NESSON_REQUIRED".to_string(), "1".to_string())],
            )
            .await;
        assert!(
            required.is_err(),
            "this fake refuses every set-environment, so the manager's required \
             path must fail on it too: {required:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_kill_carries_tmux_own_words_and_status() {
        // #991's third error criterion, at the one `Required` operation whose
        // failure is a *user-visible sentence*: `agent.session.kill` answers
        // `success: false` with this error's text, and the server's
        // `session.kill` path hands it on. Before step 7 it read
        // `.stderr(Stdio::null())` and bailed with "Failed to kill session:
        // <name>" — the same sentence for a session that does not exist, a
        // server that is gone, and a permission problem.
        //
        // Reddens on: restoring the status-only shape (the marker assertion
        // fails — there is no pipe for tmux to answer on), and on dropping the
        // status from the message (the `exit status` assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in kill-session) echo 'no such session: nession-fake-sess' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);

        let err = mgr
            .kill_session("nession-fake-sess")
            .await
            .expect_err("the injected binary refuses every kill-session");
        let message = format!("{err:#}");
        assert!(
            message.contains("no such session: nession-fake-sess"),
            "the failure must carry tmux's own words — they are what the user \
             ends up reading: {message}"
        );
        assert!(
            message.contains("exit status"),
            "and the exit status beside them: {message}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec!["kill-session", "-t", "nession-fake-sess"]],
            "on the manager's own addressing, one call, tmux's own grammar"
        );
    }
}
