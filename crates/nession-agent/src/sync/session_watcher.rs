//! Session watcher that polls tmux for session changes and notifies the server.

use crate::connection::ServerClientHandle;
use crate::tmux::manager::{SessionInfo, TmuxManager};
use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error};

/// Handle to request shutdown of a [`SessionWatcher`].
#[derive(Clone)]
pub struct SessionWatcherShutdownHandle {
    tx: mpsc::Sender<()>,
}

impl SessionWatcherShutdownHandle {
    /// Signal the session watcher to stop.
    pub async fn shutdown(&self) -> Result<()> {
        self.tx.send(()).await?;
        Ok(())
    }
}

/// Background task that polls tmux for session changes and sends updates
/// to the central server.
///
/// The watcher:
/// - Polls tmux every `poll_interval_secs` (default 5 seconds)
/// - Detects new sessions, removed sessions, and status changes
/// - Sends `agent.session.update` messages for each change
/// - Tracks attached client counts per session
pub struct SessionWatcher {
    handle: ServerClientHandle,
    tmux: TmuxManager,
    poll_interval: Duration,
    /// Previous session state, keyed by session name.
    prev_sessions: HashMap<String, SessionInfo>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: mpsc::Receiver<()>,
}

impl SessionWatcher {
    /// Create a new session watcher.
    ///
    /// # Arguments
    /// * `handle` - Server client handle for sending session updates
    /// * `tmux` - Tmux manager for querying sessions
    /// * `poll_interval_secs` - Poll interval in seconds (default 5)
    pub fn new(handle: ServerClientHandle, tmux: TmuxManager, poll_interval_secs: u64) -> Self {
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        Self {
            handle,
            tmux,
            poll_interval: Duration::from_secs(poll_interval_secs),
            prev_sessions: HashMap::new(),
            shutdown_tx,
            shutdown_rx,
        }
    }

    /// Get a handle that can be used to shut down this watcher.
    pub fn shutdown_handle(&self) -> SessionWatcherShutdownHandle {
        SessionWatcherShutdownHandle {
            tx: self.shutdown_tx.clone(),
        }
    }

    /// Run the session watcher loop until shutdown is signalled.
    pub async fn run(mut self) -> Result<()> {
        let mut ticker = tokio::time::interval(self.poll_interval);
        // Skip the immediate first tick.
        ticker.tick().await;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(e) = self.poll_and_sync().await {
                        error!("Session watcher poll error: {:#}", e);
                    }
                }
                _ = self.shutdown_rx.recv() => {
                    debug!("Session watcher shutting down");
                    break;
                }
            }
        }

        Ok(())
    }

    /// Poll tmux for the current session list and send updates for any changes.
    async fn poll_and_sync(&mut self) -> Result<()> {
        // If the supervisor reconnected, the server-side session registry was
        // wiped. Reset our previous state so every session is re-synced.
        if self.handle.take_sync_needed() {
            debug!("Full session re-sync triggered after reconnection");
            self.prev_sessions.clear();
        }

        let current_sessions = self.tmux.list_sessions().await.unwrap_or_default();

        // Build a map of current sessions for easy lookup.
        let mut current_map: HashMap<String, SessionInfo> = HashMap::new();
        for session in &current_sessions {
            current_map.insert(session.name.clone(), session.clone());
        }

        // Detect new sessions and changed sessions.
        for (name, current) in &current_map {
            match self.prev_sessions.get(name) {
                None => {
                    // New session detected.
                    debug!("New session detected: {}", name);
                    self.send_update(current).await?;
                }
                Some(prev) => {
                    // Check if anything changed.
                    if session_changed(prev, current) {
                        debug!("Session changed: {}", name);
                        self.send_update(current).await?;
                    }
                }
            }
        }

        // Detect removed sessions.
        for name in self.prev_sessions.keys() {
            if !current_map.contains_key(name) {
                debug!("Session removed: {}", name);
                // Send a "removed" update with status "gone".
                self.handle.send_session_update(name, "gone", 0, 0).await?;
            }
        }

        // Update the previous sessions map.
        self.prev_sessions = current_map;

        Ok(())
    }

    /// Send a session update to the server.
    async fn send_update(&self, session: &SessionInfo) -> Result<()> {
        // Determine status based on attached clients.
        let status = if session.attached_clients > 0 {
            "active"
        } else {
            "detached"
        };

        self.handle
            .send_session_update(
                &session.name,
                status,
                session.window_count,
                session.attached_clients,
            )
            .await?;

        Ok(())
    }

    /// Get a snapshot of the currently tracked sessions (for testing).
    pub fn tracked_sessions(&self) -> &HashMap<String, SessionInfo> {
        &self.prev_sessions
    }
}

/// Check if a session has changed between polls by comparing key fields.
fn session_changed(prev: &SessionInfo, current: &SessionInfo) -> bool {
    prev.window_count != current.window_count
        || prev.attached_clients != current.attached_clients
        || prev.width != current.width
        || prev.height != current.height
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(name: &str, attached: u32, windows: u32) -> SessionInfo {
        SessionInfo {
            name: name.to_string(),
            created_at: 1000,
            window_count: windows,
            attached_clients: attached,
            width: 80,
            height: 24,
        }
    }

    #[test]
    fn test_session_changed_detects_window_count_change() {
        let prev = make_session("test", 0, 1);
        let current = make_session("test", 0, 2);
        assert!(session_changed(&prev, &current));
    }

    #[test]
    fn test_session_changed_detects_attached_clients_change() {
        let prev = make_session("test", 0, 1);
        let current = make_session("test", 1, 1);
        assert!(session_changed(&prev, &current));
    }

    #[test]
    fn test_session_changed_detects_size_change() {
        let prev = make_session("test", 0, 1);
        let mut current = prev.clone();
        current.width = 120;
        current.height = 40;
        assert!(session_changed(&prev, &current));
    }

    #[test]
    fn test_session_changed_no_change() {
        let session = make_session("test", 1, 2);
        assert!(!session_changed(&session, &session));
    }

    #[test]
    fn test_session_changed_created_at_ignored() {
        // created_at differences should not trigger a change.
        let mut prev = make_session("test", 1, 2);
        let current = {
            let mut s = prev.clone();
            s.created_at = 9999;
            s
        };
        // created_at differs but nothing else.
        prev.created_at = 1000;
        assert!(!session_changed(&prev, &current));
    }
}
