//! Agent CLI commands implementation.

use crate::utils::{pid_file, process, secret_handoff, startup};
use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tracing::{error, info};

/// Start the agent process.
pub async fn start(
    config_path: String,
    foreground: bool,
    pid_file: String,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
    auth_token_stdin: bool,
) -> Result<()> {
    // Child half of the background credential handoff (#2269). The parent that
    // re-executed us resolved the effective token and wrote it to our stdin;
    // its value wins over whatever this process parsed for itself, because the
    // parent already applied flag > env > config precedence. Reading it here,
    // first, also means a child that fails for another reason has still taken
    // the credential out of the pipe rather than leaving it there.
    let auth_token_override = if auth_token_stdin {
        if !foreground {
            anyhow::bail!(
                "{} is only valid for the foreground child of a background start",
                secret_handoff::AUTH_TOKEN_STDIN_ARG
            );
        }
        Some(secret_handoff::read_auth_token()?)
    } else {
        auth_token_override
    };

    // Ensure component directories exist before any file operations (PID file)
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Already running, decided by ownership rather than by pid (#1016). A stale
    // file whose pid was reused must not read as "already running" — and must
    // not survive to make the *next* start think so.
    match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => {
            anyhow::bail!("Agent is already running with PID {}", identity.pid);
        }
        // Stale, reused, or no record at all: nothing of ours is running.
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(&pid_file);
        }
    }

    // Load configuration (CLI/env overrides take precedence over file/defaults)
    let config = load_agent_config(&config_path, &server_url_override, &auth_token_override)?;

    if foreground {
        // Run in foreground
        info!("Starting agent in foreground mode");
        println!("Starting nession-agent with config: {config_path}");
        println!("Agent ID: {}", config.agent_id);
        println!("Press Ctrl+C to stop");

        // Record this process's identity (foreground mode).
        //
        // Written before the runtime starts, which is the half #1016 still has
        // open: the file existing is not yet evidence the agent is serving, and
        // a child that dies on its config leaves one behind. The readiness half
        // moves this to the runtime's ready point.
        pid_file::write_identity(&pid_file, pid_file::Component::Agent)?;

        // Run the agent directly (this will block)
        let result = run_agent_foreground(config).await;

        // Clean up PID file on exit
        let _ = fs::remove_file(&pid_file);

        result?;
    } else {
        // Run in background
        info!("Starting agent in background mode");

        // Get current executable path
        let exe = std::env::current_exe()?;

        // The token is not an argument (#2269): see `background_child_command`
        // and `utils::secret_handoff` for the channel it travels over instead.
        let mut cmd = background_child_command(
            &exe,
            &config_path,
            &pid_file,
            server_url_override.as_deref(),
            auth_token_override.as_deref(),
        );

        // On Unix, detach the child process from the parent's session
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    // Create a new session to detach from parent
                    libc::setsid();
                    Ok(())
                });
            }
        }

        // A path only this start knows, so a marker left by an earlier run
        // cannot be mistaken for this child's announcement.
        let marker = startup::ReadyMarker::beside_state_file(&pid_file);
        marker.arm(&mut cmd);

        let mut child = cmd.spawn().context("failed to spawn agent process")?;

        // Hand the credential over after spawn, then close the pipe. The child
        // blocks on this read before it can load its config, so the write must
        // not wait for readiness. A failed write leaves a child that can never
        // start, so it is reaped rather than abandoned.
        if let Some(token) = auth_token_override.as_deref() {
            if let Err(error) = secret_handoff::write_auth_token(&mut child, token) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }

        // Wait for the child to say it is serving — or to die, or for the
        // deadline. This replaces a pair of fixed sleeps followed by "Agent is
        // starting, check logs for status" and an `Ok(())`: that reported a
        // successful start for a child that had already exited on a bad config
        // or a failed bind (#1016).
        match startup::wait_for_ready(&mut child, &marker, startup::STARTUP_TIMEOUT).await {
            startup::Startup::Serving => {
                let pid = startup::announced_pid(&pid_file)?;
                println!("Agent started in background with PID {pid}");
                println!("PID file: {pid_file}");
            }
            startup::Startup::Exited(status) => {
                anyhow::bail!("Agent exited before it was serving ({status}); check the logs");
            }
            startup::Startup::TimedOut => {
                anyhow::bail!(
                    "Agent did not report itself serving within {}s; check the logs",
                    startup::STARTUP_TIMEOUT.as_secs()
                );
            }
        }
        println!("Config: {config_path}");
    }

    Ok(())
}

/// The command a background start re-executes itself with.
///
/// Extracted from [`start`] so the invariant #2269 fixes — the resolved
/// credential is not in the child's argument vector — is asserted against the
/// same vector the parent actually spawns, rather than a parallel copy built
/// for a test.
///
/// The credential selects the *channel*, never the value: a start with an
/// override points the child at stdin with a non-secret argument, and [`start`]
/// writes the framed token over that pipe after spawning. Nothing derived from
/// the token itself is spelled into argv or the environment.
pub(crate) fn background_child_command(
    exe: &Path,
    config_path: &str,
    pid_file: &str,
    server_url_override: Option<&str>,
    auth_token_override: Option<&str>,
) -> Command {
    let mut cmd = Command::new(exe);
    let mut child_args: Vec<String> = vec![
        "agent".to_string(),
        "start".to_string(),
        "--config".to_string(),
        config_path.to_string(),
        "--foreground".to_string(),
        // Forwarded, so the child records its identity where this parent —
        // and every later `stop`/`status` — looks for it. It was resolved
        // by the parent and dropped on the way to the child, which then
        // wrote the *default* path: a background start with a custom
        // `--pid-file` reported a pid no later command could act on (#1016).
        "--pid-file".to_string(),
        pid_file.to_string(),
    ];
    // Forward CLI/env overrides to the child process so it uses the same values
    if let Some(url) = server_url_override {
        child_args.push("--server-url".to_string());
        child_args.push(url.to_string());
    }
    let hands_off_token = auth_token_override.is_some();
    if hands_off_token {
        child_args.push(secret_handoff::AUTH_TOKEN_STDIN_ARG.to_string());
    }
    cmd.args(&child_args)
        .stdin(if hands_off_token {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

/// Stop the agent process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Ownership, not liveness (#1016). "A process with this number exists" and
    // "the agent this file was written for is running" are different claims —
    // pids are reused — and a `stop` acting on the weaker one can signal an
    // unrelated process. Only `Alive` is signalled; anything else cleans up and
    // says why.
    let pid = match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => identity.pid,
        Ok(pid_file::Ownership::Reused(identity)) => {
            println!(
                "Recorded pid {} is running but is not this agent — not signalling it.",
                identity.pid
            );
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Ok(pid_file::Ownership::Stale(identity)) => {
            println!("Agent process {} is not running", identity.pid);
            // Clean up stale state
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Agent is not running (no state file found)");
            return Ok(());
        }
    };

    println!("Stopping agent (PID {pid})...");

    // Send SIGTERM
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let nix_pid = Pid::from_raw(pid as i32);
        kill(nix_pid, Signal::SIGTERM).context("failed to send SIGTERM")?;
    }

    // Wait for graceful shutdown (5 seconds)
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if !pid_file::is_process_running(pid) {
            println!("Agent stopped successfully");
            // Clean up PID file
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Process didn't stop gracefully, try SIGKILL
    println!("Agent didn't stop gracefully, sending SIGKILL...");

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let nix_pid = Pid::from_raw(pid as i32);
        kill(nix_pid, Signal::SIGKILL).context("failed to send SIGKILL")?;
    }

    // Wait a bit more for SIGKILL
    tokio::time::sleep(Duration::from_millis(500)).await;

    if pid_file::is_process_running(pid) {
        error!("Failed to stop agent process {}", pid);
        anyhow::bail!("Failed to stop agent process");
    }

    println!("Agent stopped (force killed)");
    // Clean up PID file
    let _ = fs::remove_file(&pid_file);

    Ok(())
}

/// Restart the agent process (stop then start).
pub async fn restart(
    config_path: String,
    foreground: bool,
    pid_file: String,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
) -> Result<()> {
    println!("Restarting agent...");
    stop(pid_file.clone()).await?;
    start(
        config_path,
        foreground,
        pid_file,
        server_url_override,
        auth_token_override,
        // `restart` is never the child of a handoff: a background restart
        // re-executes `agent start`, which is the path that reads the pipe.
        false,
    )
    .await
}

/// Show agent status.
pub async fn status(pid_file: String) -> Result<()> {
    // Ownership, like `stop` (#1016). Reporting "running" for a reused pid would
    // send an operator to look at a process that is not theirs, and reporting
    // "stopped" while the agent serves — which is what reading a bare pid out of
    // the identity file would do — is worse. Anything not proven ours is not
    // reported as ours.
    let pid = match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => identity.pid,
        Ok(pid_file::Ownership::Reused(identity)) => {
            println!(
                "Status: stopped (pid {} is running but is not this agent)",
                identity.pid
            );
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Ok(pid_file::Ownership::Stale(_)) => {
            println!("Status: stopped (process not running)");
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Status: stopped (no state file)");
            return Ok(());
        }
    };

    // Get process start time for uptime calculation
    let uptime = process::get_process_uptime(pid).map(pid_file::format_duration);

    println!("Status: running");
    println!("PID: {pid}");
    if let Some(uptime_str) = uptime {
        println!("Uptime: {uptime_str}");
    }

    // Try to load config to show additional info
    let default_config_path = nession_common::paths::agent_config_path()
        .unwrap_or_else(|_| std::path::PathBuf::from("agent-config.toml"));
    let default_config_path = default_config_path.to_string_lossy();
    if let Ok(config) = load_agent_config(&default_config_path, &None, &None) {
        println!("Agent ID: {}", config.agent_id);
        println!("Server URL: {}", config.server_url);
        println!("Listen address: {}", config.listen_address);
    }

    Ok(())
}

/// Load agent configuration from file or use defaults.
/// CLI flags and env vars (passed as overrides) take precedence over config file values.
fn load_agent_config(
    path: &str,
    server_url_override: &Option<String>,
    auth_token_override: &Option<String>,
) -> Result<AgentConfig> {
    let mut config = if Path::new(path).exists() {
        let config_str = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file: {path}"))?;
        toml::from_str::<AgentConfig>(&config_str)
            .with_context(|| format!("failed to parse config file: {path}"))?
    } else {
        info!("No config file found at '{}', using defaults", path);
        AgentConfig::default()
    };

    // Apply CLI/env overrides (they take precedence over config file)
    if let Some(url) = server_url_override {
        config.server_url = url.clone();
    }
    if let Some(token) = auth_token_override {
        config.auth_token = token.clone();
    }

    finalize_agent_identity(&mut config)?;

    Ok(config)
}

/// Resolve stable agent identity (config + persisted `~/.nession/agent/identity`),
/// matching `nession-agent` binary startup.
fn finalize_agent_identity(config: &mut AgentConfig) -> Result<()> {
    if config.agent_id.is_empty() {
        config.agent_id = nession_common::system::get_hostname();
    }
    let identity_path = nession_common::paths::agent_identity_path()?;
    config.agent_id = nession_agent::identity::resolve_agent_id(&config.agent_id, &identity_path)?;
    Ok(())
}

/// Run the agent in foreground mode (blocks until shutdown).
async fn run_agent_foreground(config: AgentConfig) -> Result<()> {
    // The composition is deliberately not here anymore.
    //
    // `nession_agent::runtime` owns it, and this function used to be a
    // second copy that had already drifted: it passed an empty provider
    // registry and no `connect_url`/`display_name`, so this entrypoint
    // started a different Agent product from the `nession-agent` binary
    // (#1014). Anything added to one path and not the other was invisible
    // until something depended on it.
    // A background start re-execs this same path with the readiness variable
    // set, so this one call serves both a foreground start a user typed (no
    // variable, nobody watching) and the child of a daemon parent waiting to be
    // told the agent is serving (#1016).
    nession_agent::runtime::run(config, nession_common::readiness::Readiness::from_env()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The credential these tests use. Distinctive enough that a substring
    /// search over the child's vector cannot pass by accident.
    const SECRET: &str = "fake-auth-token-for-2269";

    fn background_command(auth_token_override: Option<&str>) -> Command {
        background_child_command(
            Path::new("/bin/true"),
            "agent-config.toml",
            "agent.pid",
            None,
            auth_token_override,
        )
    }

    fn argv(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// #2269 at the vector both flag- and env-sourced credentials feed: the
    /// credential selects the *channel*, and the value itself never appears in
    /// the re-executed child's argument vector or environment.
    #[test]
    fn a_resolved_credential_is_carried_by_the_channel_not_the_argv() {
        let command = background_command(Some(SECRET));
        let argv = argv(&command);

        assert!(
            !argv.iter().any(|arg| arg.contains(SECRET)),
            "the re-exec child's argv must not carry the credential: {argv:?}"
        );
        assert!(
            argv.iter()
                .any(|arg| arg == secret_handoff::AUTH_TOKEN_STDIN_ARG),
            "the child must be pointed at the handoff channel instead: {argv:?}"
        );
        let env: Vec<_> = command.get_envs().collect();
        assert!(
            !env.iter()
                .any(|(_, value)| value
                    .is_some_and(|value| value.to_string_lossy().contains(SECRET))),
            "the re-exec child's environment must not carry the credential: {env:?}"
        );
    }

    /// Without an override there is no credential to hand off, so the child
    /// keeps the detached (null) stdin it had before #2269.
    #[test]
    fn a_start_without_an_override_has_no_handoff_channel() {
        let command = background_command(None);

        let argv = argv(&command);
        assert!(
            !argv
                .iter()
                .any(|arg| arg == secret_handoff::AUTH_TOKEN_STDIN_ARG),
            "no credential, no channel: {argv:?}"
        );
    }
}
