//! Agent CLI commands implementation.

use crate::utils::{pid_file, process};
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

    // Check if agent is already running
    if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
        if pid_file::is_process_running(pid) {
            anyhow::bail!("Agent is already running with PID {pid}");
        } else {
            // Process not running but PID file exists, clean it up
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

        // Write PID file for the current process (foreground mode)
        let pid = std::process::id();
        pid_file::write_pid_file(&pid_file, pid)?;

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

        let _child = cmd.spawn().context("failed to spawn agent process")?;

        // Give the child a moment to write its PID file
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Read the PID from the file written by the child
        match pid_file::read_pid_file(&pid_file) {
            Ok(pid) => {
                println!("Agent started in background with PID {pid}");
                println!("PID file: {pid_file}");
            }
            Err(_) => {
                println!("Agent started in background (waiting for PID file...)");
                // Wait a bit more and try again
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
                    println!("Agent started in background with PID {pid}");
                } else {
                    println!("Agent is starting, check logs for status");
                }
            }
        }
        println!("Config: {config_path}");
    }

    Ok(())
}

/// Stop the agent process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Read PID file
    let pid = match pid_file::read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Agent is not running (no PID file found)");
            return Ok(());
        }
    };

    // Check if process is running
    if !pid_file::is_process_running(pid) {
        println!("Agent process {pid} is not running");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

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
    // Read PID file
    let pid = match pid_file::read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Status: stopped (no PID file)");
            return Ok(());
        }
    };

    // Check if process is running
    if !pid_file::is_process_running(pid) {
        println!("Status: stopped (process not running)");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

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
    nession_agent::runtime::run(config).await
}
