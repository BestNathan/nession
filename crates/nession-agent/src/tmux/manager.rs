//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

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

    /// Test seam: override the tmux binary (inject a fake `tmux`), keeping the
    /// socket unchanged.
    ///
    /// The substitution is *total* as of #991 step 6: it rebinds the manager's
    /// own addressing **and** the [`EnvManager`] it holds, whose operations used
    /// to reach the process-wide tmux behind this manager's back. A test that
    /// injects a fake and then drives `env().set_environment(…)` is driving the
    /// fake; before that, it was driving the real binary on the real socket and
    /// could not tell.
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        self.cmd = self.cmd.with_bin(tmux_bin);
        self.env.with_tmux(TmuxDep::injected(self.cmd.clone()));
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

    /// `tmux display-message -p -t <session> -F <format>`.
    ///
    /// One place for the call, so the two accessors above cannot drift in how
    /// they address a session or how they treat a failure.
    async fn display_message(&self, session_name: &str, format: &str) -> Result<String> {
        let mut cmd = self.cmd.tokio();
        cmd.args(["display-message", "-p", "-t", session_name, "-F", format]);
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
        let claude_env = claude_binding_env(name);
        for (key, value) in &claude_env {
            cmd.arg("-e").arg(format!("{key}={value}"));
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
            for (key, value) in &claude_env {
                init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
            }
            if !init_cmd.is_empty() {
                // **Required.** Stage 2 is the path for a tmux without
                // `new-session -e` (before 3.0), and on that path this line is
                // the *only* thing that puts the caller's environment into the
                // shell that exists — stage 3 below reaches windows that do not
                // exist yet, so it cannot stand in for it. A line that was typed
                // but never ran therefore leaves a session whose `TERM`, locale
                // and caller variables are not the requested ones, and the
                // create would answer success for it: `let _ =` here is the
                // exact shape #980 was, one stage further along.
                //
                // The class is what step 5 left open and step 7 decided
                // ("whether a failed stage-2 line is tolerable is #991's step
                // 7"). It is not tolerable: the variable this operation exists
                // to deliver has nowhere else to come from. The session itself
                // is left in place — this reports the failure, it does not add
                // a rollback policy no caller had.
                TmuxOps::new(self.cmd.clone())
                    .send_keys(name, &init_cmd)
                    .await
                    .with_context(|| {
                        format!("failed to inject the environment line into session {name}")
                    })?;

                // **BestEffort.** Cosmetic: it hides the `export …` line the
                // statement above typed from the pane's scrollback. The
                // environment was delivered by that statement, so a scrollback
                // that could not be cleared is still a session that has it —
                // #991's "cosmetic cleanup fails after the primary succeeded is
                // observable but does not rewrite the primary". Observability is
                // the shared helper's `tracing::warn!`.
                crate::tmux::env::clear_history(&self.tmux_dep(), name).await;
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
        //
        // **BestEffort** (#991 open question 4, decided here). What breaks if
        // this fails: the session's *interaction* degrades — there is no
        // mouse-driven copy-mode, no pane selection, and TUI apps stop
        // receiving mouse reports. What does not break: the session itself. The
        // option is not consulted on the input path (keyboard bytes reach the
        // pane through `send-keys`/the attach client regardless of it), it
        // holds no session state, and the web client carries its own scrollback
        // (`DeviceProfile`'s 10k/50k lines), so scrolling history does not
        // depend on tmux following the mouse either. Making it `Required` would
        // let a presentation preference fail a create whose session exists and
        // works.
        //
        // Observable rather than dropped: `let _ = … .stderr(Stdio::null())`
        // discarded the status *and* tmux's reason, which is the invisibility
        // #980 fixed elsewhere (#991's "no silent accidental policy").
        let mut mouse = self.cmd.tokio();
        mouse.args(["set-option", "-t", name, "mouse", "on"]);
        match mouse.output().await {
            Ok(out) if out.status.success() => {}
            Ok(out) => tracing::warn!(
                "best-effort `set-option mouse on` for session {name} failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => tracing::warn!(
                "best-effort `set-option mouse on` for session {name} failed to spawn: {e}"
            ),
        }

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
    /// Bound to the manager's own addressing rather than to the process-wide
    /// [`TmuxOps::global`](super::ops::TmuxOps::global): a manager that had been
    /// given a different socket must not propagate its environment onto the
    /// other one. (Steps 3–4 noted here that this is *not* step 6's work — at
    /// the time only this manager held a `TmuxCmd` and nothing else had become
    /// injectable. Step 6 is what changed that: the addressing is a
    /// [`TmuxDep`] the `EnvManager` below is bound to as well, so the fake the
    /// `legacy_stage_two_tests` module injects is what both halves run.)
    async fn propagate_env_best_effort(&self, session: &str, name: &str, value: &str) {
        let ops = TmuxOps::new(self.cmd.clone());
        if let Err(e) = ops.set_environment(session, name, value).await {
            tracing::warn!(
                "best-effort env propagation to future panes of session {session} failed ({name}): {e:#}"
            );
        }
    }

    /// Kill a session.
    ///
    /// **Required** (#991): `SessionManager::kill_session`'s result is what the
    /// caller reports — `agent.session.kill` answers `success: false` with this
    /// error's text, and the server-side `session.kill` path turns it into the
    /// message a user reads. So the failure carries tmux's own words and exit
    /// status, not just the session name: before #991 step 7 this read
    /// `.stderr(Stdio::null())` and bailed with "Failed to kill session: <name>",
    /// which is the same sentence for "no such session", "the server is gone"
    /// and "you are not allowed to" — the diagnostic was discarded before the
    /// message that reaches the user could hold it.
    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let mut cmd = self.cmd.tokio();
        cmd.args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::piped());
        let output = tmux_output(&mut cmd, self.kill_timeout).await?;

        if !output.status.success() {
            anyhow::bail!(
                "Failed to kill session {name}: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
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
///
/// `output()` rather than `status()` since #991 step 7, for the reason #980
/// measured: a `status()` call has no pipes, so everything tmux says about a
/// failure is gone by the time the caller can report it. The two are not
/// interchangeable at a `Required` call site, and this helper no longer has any
/// other kind. (`.stderr(Stdio::piped())` beside it is declarative rather than
/// load-bearing: `output()` sets both pipes itself — measured, `tokio`'s
/// implementation calls `stdout(Stdio::piped())/stderr(Stdio::piped())` on the
/// inner `std::process::Command` immediately before spawning, which *overrides*
/// anything set earlier. `std::process::Command::output()` does not: there an
/// explicit `Stdio::null()` survives and arrives empty. The distinction decides
/// which sites can keep their `null()` and which cannot.)
async fn tmux_output(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output> {
    match tokio::time::timeout(timeout, cmd.output()).await {
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
        // One timeout test, not two: `tmux_status_times_out` covered a helper
        // that no longer exists. #991 step 7 removed it because its only caller
        // was `kill_session`, and a status-only call there is precisely the
        // shape that discarded tmux's reason for refusing to kill a session.
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = std::time::Instant::now();
        let res = tmux_output(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
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

    /// Prefix of the one-directory-per-call records the shim writes.
    #[cfg(unix)]
    const CALL_FILE_PREFIX: &str = "call.";

    /// Name of the file inside `call.N` that holds the call's argv.
    #[cfg(unix)]
    const CALL_RECORD_NAME: &str = "argv";

    /// Terminator the shim writes after the argv of each recorded call.
    #[cfg(unix)]
    const CALL_SEPARATOR: &str = "==call==";

    /// A fake tmux that records its arguments — one record per call, so a
    /// call's *boundaries* are visible — and fails the first `new-session` so
    /// `create_session` takes its legacy stage-2 path (the one for a tmux
    /// without `-e`, i.e. before 3.0).
    ///
    /// The `-S <socket>` prefix is stripped first, exactly as real tmux
    /// receives it: a script matching on `$1` without that shift would see `-S`
    /// and fall through to its catch-all, "working" while testing nothing.
    #[cfg(unix)]
    fn recording_shim(dir: &std::path::Path) -> (String, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let stage1 = dir.join("stage1-ran");
        let path = dir.join("tmux");
        std::fs::write(
            &path,
            // One file per call, claimed with an O_EXCL create, so two
            // processes recording at once cannot interleave. The mechanism and
            // the measurements are documented on `FakeTmux` in
            // `crate::test_support`; keep this body in step with it.
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 n=0\n\
                 while true; do\n\
                 while [ -e \"{dir}/{prefix}$n\" ]; do n=$((n + 1)); done\n\
                 if mkdir \"{dir}/{prefix}$n\" 2>/dev/null; then break; fi\n\
                 if [ ! -d \"{dir}/{prefix}$n\" ]; then\n\
                 echo \"fake tmux: cannot claim {dir}/{prefix}$n\" >&2\n\
                 exit 1\n\
                 fi\n\
                 n=$((n + 1))\n\
                 done\n\
                 printf '%s\\n' \"$@\" > \"{dir}/{prefix}$n/{record}\"\n\
                 echo \"{sep}\" >> \"{dir}/{prefix}$n/{record}\"\n\
                 case \"$1\" in\n\
                   new-session)\n\
                     if [ -f \"{stage1}\" ]; then exit 0; else : > \"{stage1}\"; exit 1; fi;;\n\
                   *) exit 0;;\n\
                 esac\n",
                dir = dir.display(),
                prefix = CALL_FILE_PREFIX,
                record = CALL_RECORD_NAME,
                sep = CALL_SEPARATOR,
                stage1 = stage1.display(),
            ),
        )
        .expect("write shim");
        let mut perms = std::fs::metadata(&path)
            .expect("shim metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod shim");
        (path.to_string_lossy().into_owned(), dir.to_path_buf())
    }

    /// The recorded calls, each as the list of argv entries tmux received.
    #[cfg(unix)]
    fn recorded_calls(dir: &std::path::Path) -> Vec<Vec<String>> {
        let mut calls = Vec::new();
        for n in 0.. {
            let claimed = dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            // Indices are claimed in order by creating the directory, so the
            // first unclaimed one means there is nothing after it either.
            if !claimed.is_dir() {
                break;
            }
            let text = match std::fs::read_to_string(claimed.join(CALL_RECORD_NAME)) {
                Ok(text) => text,
                // Claimed, but the argv is not on disk yet — and later indices
                // may already be complete, so this is not where the scan ends.
                Err(_) => continue,
            };
            let Some(body) = text.trim_end_matches('\n').strip_suffix(CALL_SEPARATOR) else {
                continue;
            };
            let entries: Vec<String> = body
                .trim_matches('\n')
                .lines()
                .map(str::to_string)
                .collect();
            if !entries.is_empty() {
                calls.push(entries);
            }
        }
        calls
    }

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
        let (shim, record_dir) = recording_shim(dir.path());
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(shim);
        let session = crate::test_support::TestSession::new("stage2-argv");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("against the shim, create takes its legacy stage-2 path");

        let calls = recorded_calls(&record_dir);
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
            typed[3].starts_with("export TERM=xterm-256color;")
                && typed[3].contains("export LANG=C.UTF-8;"),
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());

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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());
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
        let mut mgr = SessionManager::new();
        mgr.with_tmux_bin(fake.bin());

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
