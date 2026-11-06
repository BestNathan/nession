//! `nession agent stop` — stop the Agent daemon by owned PID identity.

use crate::lifecycle::pid_file;
use anyhow::{Context, Result};
use std::fs;
use std::time::Duration;
use tracing::error;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Agent);

    // Ownership, not liveness (#1016). "A process with this number exists" and
    // "the agent this file was written for is running" are different claims —
    // pids are reused — and a `stop` acting on the weaker one can signal an
    // unrelated process. Only `Alive` is signalled; anything else cleans up
    // and says why.
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
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Agent is not running (no state file found)");
            return Ok(());
        }
    };

    println!("Stopping agent (PID {pid})...");

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        kill(Pid::from_raw(pid as i32), Signal::SIGTERM).context("failed to send SIGTERM")?;
    }

    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if !pid_file::is_process_running(pid) {
            println!("Agent stopped successfully");
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    println!("Agent didn't stop gracefully, sending SIGKILL...");

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        kill(Pid::from_raw(pid as i32), Signal::SIGKILL).context("failed to send SIGKILL")?;
    }

    tokio::time::sleep(Duration::from_millis(500)).await;

    if pid_file::is_process_running(pid) {
        error!("Failed to stop agent process {}", pid);
        anyhow::bail!("Failed to stop agent process");
    }

    println!("Agent stopped (force killed)");
    let _ = fs::remove_file(&pid_file);

    Ok(())
}
