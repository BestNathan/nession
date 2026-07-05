//! Periodic heartbeat loop that sends agent status to the central server.

use crate::connection::ServerClientHandle;
use crate::tmux::manager::TmuxManager;
use anyhow::Result;
use nession_common::protocol::AgentStatus;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error};

/// Handle to request shutdown of a [`HeartbeatLoop`].
#[derive(Clone)]
pub struct HeartbeatShutdownHandle {
    tx: mpsc::Sender<()>,
}

impl HeartbeatShutdownHandle {
    /// Signal the heartbeat loop to stop.
    pub async fn shutdown(&self) -> Result<()> {
        self.tx.send(()).await?;
        Ok(())
    }
}

/// Background task that sends periodic heartbeats to the central server.
///
/// Each heartbeat includes:
/// - Agent status (online)
/// - Session count and active session count
/// - System uptime (seconds)
/// - Load average (1, 5, 15 minute)
pub struct HeartbeatLoop {
    handle: ServerClientHandle,
    tmux: TmuxManager,
    interval: Duration,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: mpsc::Receiver<()>,
}

impl HeartbeatLoop {
    /// Create a new heartbeat loop.
    ///
    /// # Arguments
    /// * `handle` - Server client handle for sending messages
    /// * `tmux` - Tmux manager for querying session info
    /// * `interval_secs` - Interval between heartbeats in seconds (default 10)
    pub fn new(handle: ServerClientHandle, tmux: TmuxManager, interval_secs: u64) -> Self {
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        Self {
            handle,
            tmux,
            interval: Duration::from_secs(interval_secs),
            shutdown_tx,
            shutdown_rx,
        }
    }

    /// Get a handle that can be used to shut down this loop.
    pub fn shutdown_handle(&self) -> HeartbeatShutdownHandle {
        HeartbeatShutdownHandle {
            tx: self.shutdown_tx.clone(),
        }
    }

    /// Run the heartbeat loop until shutdown is signalled.
    pub async fn run(mut self) -> Result<()> {
        let mut ticker = tokio::time::interval(self.interval);
        // The first tick fires immediately; skip it so we don't send a
        // heartbeat before the first real interval has elapsed.
        ticker.tick().await;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(e) = self.send_heartbeat().await {
                        error!("Failed to send heartbeat: {:#}", e);
                    }
                }
                _ = self.shutdown_rx.recv() => {
                    debug!("Heartbeat loop shutting down");
                    break;
                }
            }
        }

        Ok(())
    }

    /// Collect metrics and send a single heartbeat.
    async fn send_heartbeat(&self) -> Result<()> {
        let sessions = self.tmux.list_sessions().await.unwrap_or_default();
        let session_count = u32::try_from(sessions.len()).unwrap_or(0);
        let active_sessions =
            u32::try_from(sessions.iter().filter(|s| s.attached_clients > 0).count()).unwrap_or(0);

        let uptime_seconds = get_uptime_seconds();
        let load_average = get_load_average();

        debug!(
            "Sending heartbeat: sessions={}, active={}, uptime={}s, load={:?}",
            session_count, active_sessions, uptime_seconds, load_average
        );

        self.handle
            .send_heartbeat(
                AgentStatus::Online,
                session_count,
                active_sessions,
                uptime_seconds,
                load_average,
            )
            .await?;

        Ok(())
    }
}

/// Read system uptime in seconds.
///
/// On Linux, reads from `/proc/uptime`. On other platforms, returns 0.
fn get_uptime_seconds() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/uptime") {
            if let Some(first) = content.split_whitespace().next() {
                if let Ok(val) = first.parse::<f64>() {
                    return (val as i64).max(0) as u64;
                }
            }
        }
    }
    0
}

/// Read system load average (1, 5, 15 minute).
///
/// On Linux, reads from `/proc/loadavg`. On other platforms, returns [0.0; 3].
fn get_load_average() -> [f64; 3] {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/loadavg") {
            let parts: Vec<&str> = content.split_whitespace().collect();
            let load1 = parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let load5 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let load15 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            return [load1, load5, load15];
        }
    }
    [0.0; 3]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_uptime_seconds_returns_non_negative() {
        let _uptime = get_uptime_seconds();
        // Uptime is always non-negative on any platform (may be 0 on non-Linux).
    }

    #[test]
    fn test_get_load_average_returns_three_values() {
        let load = get_load_average();
        assert_eq!(load.len(), 3);
        // Load values should be non-negative.
        for &val in &load {
            assert!(val >= 0.0);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_get_uptime_seconds_linux() {
        let uptime = get_uptime_seconds();
        // On Linux, uptime should be > 0 for any running system.
        assert!(uptime > 0, "expected uptime > 0 on Linux");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_get_load_average_linux() {
        let load = get_load_average();
        // At least one of the values should be readable (may all be 0 on idle system).
        // Just verify we got values without panicking.
        assert!(load[0] >= 0.0);
        assert!(load[1] >= 0.0);
        assert!(load[2] >= 0.0);
    }
}
