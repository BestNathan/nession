//! Agent CLI commands implementation.

use crate::utils::{pid_file, process, startup};
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
) -> Result<()> {
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

        // Spawn the agent process with proper daemonization on Unix
        // not-tmux: re-executes this CLI binary (`nession agent start
        // --foreground`); the tmux socket is bound by that child at startup.
        let mut cmd = Command::new(&exe);
        let mut child_args: Vec<String> = vec![
            "agent".to_string(),
            "start".to_string(),
            "--config".to_string(),
            config_path.clone(),
            "--foreground".to_string(),
            // Forwarded, so the child records its identity where this parent —
            // and every later `stop`/`status` — looks for it. It was resolved
            // by the parent and dropped on the way to the child, which then
            // wrote the *default* path: a background start with a custom
            // `--pid-file` reported a pid no later command could act on (#1016).
            "--pid-file".to_string(),
            pid_file.clone(),
        ];
        // Forward CLI/env overrides to the child process so it uses the same values
        if let Some(ref url) = server_url_override {
            child_args.push("--server-url".to_string());
            child_args.push(url.clone());
        }
        if let Some(ref token) = auth_token_override {
            child_args.push("--auth-token".to_string());
            child_args.push(token.clone());
        }
        cmd.args(&child_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

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
