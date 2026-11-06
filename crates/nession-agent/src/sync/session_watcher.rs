//! Session watcher that polls tmux for session changes and notifies the server.

use crate::connection::ServerClientHandle;
use crate::tmux::manager::{SessionInfo, SessionManager};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

/// Status string sent with [`ServerClientHandle::send_session_update`].
fn session_status(session: &SessionInfo) -> &'static str {
    if session.attached_clients > 0 {
        "active"
    } else {
        "detached"
    }
}

/// Push one session's tmux snapshot to the server immediately.
///
/// After `server.session.create` the registry is seeded without a workload hint;
/// the periodic [`SessionWatcher`] may not run for several seconds. This closes
/// that gap and retries briefly while tmux populates `#{pane_current_command}`.
pub async fn publish_session_snapshot(
    handle: &ServerClientHandle,
    tmux: &SessionManager,
    session_name: &str,
) -> Result<()> {
    const ATTEMPTS: u32 = 15;
    const RETRY_DELAY: Duration = Duration::from_millis(200);

    let mut last: Option<SessionInfo> = None;
    for attempt in 0..ATTEMPTS {
        let sessions = tmux.list_sessions().await?;
        let Some(session) = sessions.into_iter().find(|s| s.name == session_name) else {
            if attempt + 1 < ATTEMPTS {
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
            anyhow::bail!("session {session_name} not found in tmux after create");
        };

        let has_command = session
            .foreground_command
            .as_ref()
            .is_some_and(|command| !command.is_empty());
        last = Some(session.clone());
        handle.send_session_update(
            &session.name,
            session_status(&session),
            session.window_count,
            session.attached_clients,
            session.foreground_command.as_deref(),
        )?;

        if has_command {
            return Ok(());
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }

    if last.is_some() {
        warn!(
            session = session_name,
            "foreground command still empty after create retries; server got last snapshot"
        );
        Ok(())
    } else {
        anyhow::bail!("session {session_name} not found in tmux after create")
    }
}
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
    tmux: Arc<SessionManager>,
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
    pub fn new(
        handle: ServerClientHandle,
        tmux: Arc<SessionManager>,
        poll_interval_secs: u64,
    ) -> Self {
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
        // wiped.  Instead of the previous "gone-all + rebuild" approach (which
        // could leave the registry empty when a second disconnection happened
        // mid-sync), we send a full idempotent snapshot:
        //   1. Re-report every session that currently exists (server does an
        //      upsert, so duplicate updates are harmless).
        //   2. Mark any previously-known sessions that no longer exist as gone.
        // This guarantees eventual consistency even across rapid reconnect cycles.
        if self.handle.is_sync_needed() {
            debug!("Full session re-sync triggered after reconnection");

            // A failed enumeration is not an observed empty Session list. The
            // reconnect intent stays set and `prev_sessions` is untouched, so
            // the next poll retries the full re-sync instead of telling the
            // Server that every live Session disappeared (#2804).
            let current_sessions = match self.tmux.list_sessions().await {
                Ok(sessions) => sessions,
                Err(e) => {
                    warn!(
                        "Session enumeration failed during full re-sync; keeping the previous \
                         snapshot and retrying next poll: {:#}",
                        e
                    );
                    return Ok(());
                }
            };

            // Only a successful query satisfies the intent. The snapshot below
            // is a full re-derivation of the Server's view, so a reconnect that
            // re-marks the flag after this point simply schedules another one.
            self.handle.take_sync_needed();

            // Re-report all *current* sessions first (idempotent upsert).
            for session in &current_sessions {
                self.send_update(session).await?;
            }

            // Mark sessions that disappeared while we were disconnected.
            for name in self.prev_sessions.keys() {
                if !current_sessions.iter().any(|s| s.name == *name) {
                    debug!("Reporting stale session as gone: {}", name);
                    let _ = self.handle.send_session_update(name, "gone", 0, 0, None);
                }
            }

            // Rebuild the local cache from the current tmux state.
            self.prev_sessions.clear();
            for session in &current_sessions {
                self.prev_sessions
                    .insert(session.name.clone(), session.clone());
            }
            return Ok(());
        }

        // Normal incremental poll: skip when not connected so we don't
        // accumulate stale messages in the outbox.  The full re-sync above
        // runs on the first poll after reconnection.
        if !self.handle.is_connected() {
            debug!("Skipping session poll — not connected to server");
            return Ok(());
        }

        // Same distinction as the full re-sync: `Err` says tmux could not be
        // asked, not that it answered with no Sessions. Retain the previous
        // snapshot and send nothing; a later successful poll converges.
        let current_sessions = match self.tmux.list_sessions().await {
            Ok(sessions) => sessions,
            Err(e) => {
                warn!(
                    "Session enumeration failed; keeping the previous snapshot: {:#}",
                    e
                );
                return Ok(());
            }
        };

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
                self.handle.send_session_update(name, "gone", 0, 0, None)?;
            }
        }

        // Update the previous sessions map.
        self.prev_sessions = current_map;

        Ok(())
    }

    /// Send a session update to the server.
    async fn send_update(&self, session: &SessionInfo) -> Result<()> {
        self.handle.send_session_update(
            &session.name,
            session_status(session),
            session.window_count,
            session.attached_clients,
            session.foreground_command.as_deref(),
        )?;

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
        || prev.foreground_command != current.foreground_command
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
            foreground_command: None,
            working_dir: None,
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
    fn test_session_changed_detects_foreground_command_change() {
        // A foreground command change is the whole point of carrying the field:
        // without it here, starting or leaving Claude Code never reaches the UI.
        let prev = make_session("test", 0, 1);
        let mut current = prev.clone();
        current.foreground_command = Some("claude".to_string());
        assert!(session_changed(&prev, &current));

        let mut back_to_shell = current.clone();
        back_to_shell.foreground_command = Some("bash".to_string());
        assert!(session_changed(&current, &back_to_shell));
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

/// Enumeration-failure coverage (#2804).
///
/// These drive the real [`SessionWatcher`] against a manager whose injected
/// tmux binary the test owns, and read the ordered frames back from the
/// outbox the watcher publishes into — no mocked watcher and no mocked
/// `gone` semantics.
#[cfg(all(test, unix))]
mod enumeration_failure {
    use super::*;
    use crate::connection::outbox::OutboxFrames;
    use crate::test_support::{FakeTmux, FAKE_TIMEOUT};
    use crate::tmux::cmd::TmuxCmd;
    use std::path::Path;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// Point a manager at a binary that does not exist yet.
    ///
    /// The failure this models is an *error* from `list_sessions`, which is the
    /// only half a watcher can distinguish: a non-zero exit from tmux is
    /// already normalized by `TmuxOps::list_sessions` into an observed empty
    /// list (the idle-server policy), and that is the successful half. A
    /// missing binary makes the spawn itself fail, which the manager
    /// propagates as `Err`.
    fn manager_at(dir: &Path) -> SessionManager {
        let mut manager = SessionManager::new();
        manager.with_tmux_cmd(TmuxCmd::new(
            dir.join("tmux").to_string_lossy().into_owned(),
            dir.join("tmux.sock"),
        ));
        manager.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, FAKE_TIMEOUT);
        manager
    }

    fn watcher_at(dir: &Path) -> (SessionWatcher, ServerClientHandle, OutboxFrames) {
        let (handle, frames) = ServerClientHandle::test_handle(true);
        let watcher = SessionWatcher::new(handle.clone(), Arc::new(manager_at(dir)), 5);
        (watcher, handle, frames)
    }

    /// Make the next query fail (`Err`), the state a transient tmux failure
    /// reaches the watcher as.
    fn fail_listing(dir: &Path) {
        let bin = dir.join("tmux");
        if bin.exists() {
            if let Err(e) = std::fs::remove_file(&bin) {
                panic!("remove the injected tmux binary: {e}");
            }
        }
    }

    /// Install a fake tmux whose successful answer lists exactly `sessions`.
    fn listing(dir: &Path, sessions: &[&str]) {
        let mut script = String::new();
        for name in sessions {
            script.push_str(&format!(
                "printf '%s\\n' '{name}||1000|1|0|80|24|/tmp|bash'\n"
            ));
        }
        FakeTmux::new(dir, &script);
    }

    /// Drain every pending frame as `(session_name, status)`.
    fn updates(frames: &mut OutboxFrames) -> Vec<(String, String)> {
        let mut updates = Vec::new();
        while let Some(frame) = frames.try_next() {
            let WsMessage::Text(text) = frame else {
                panic!("expected a text frame, got {frame:?}");
            };
            let parsed: serde_json::Value = match serde_json::from_str(&text) {
                Ok(parsed) => parsed,
                Err(e) => panic!("a session update is JSON: {e}"),
            };
            let Some(payload) = parsed.get("payload") else {
                panic!("a session update carries a payload: {parsed}");
            };
            let Some(name) = payload
                .get("session_name")
                .and_then(serde_json::Value::as_str)
            else {
                panic!("a session update names its session: {parsed}");
            };
            let Some(status) = payload.get("status").and_then(serde_json::Value::as_str) else {
                panic!("a session update states its status: {parsed}");
            };
            updates.push((name.to_string(), status.to_string()));
        }
        updates
    }

    #[tokio::test]
    async fn a_failed_enumeration_in_an_incremental_poll_sends_no_gone_and_keeps_tracking() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev"]);
        let (mut watcher, _handle, mut frames) = watcher_at(dir.path());

        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "detached".to_string())],
            "the first successful poll reports the known session"
        );
        assert!(watcher.tracked_sessions().contains_key("dev"));

        fail_listing(dir.path());
        watcher
            .poll_and_sync()
            .await
            .expect("a failed enumeration is not a watcher failure");
        assert!(
            updates(&mut frames).is_empty(),
            "a failed enumeration must not be published as a deletion"
        );
        assert!(
            watcher.tracked_sessions().contains_key("dev"),
            "the previous snapshot survives a failed query"
        );

        listing(dir.path(), &[]);
        watcher.poll_and_sync().await.expect("recovery poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "gone".to_string())],
            "an observed empty list still converges to deletion"
        );
        assert!(watcher.tracked_sessions().is_empty());
    }

    #[tokio::test]
    async fn a_failed_reconnect_resync_stays_pending_and_converges_after_recovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev"]);
        let (mut watcher, handle, mut frames) = watcher_at(dir.path());
        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(updates(&mut frames).len(), 1);

        handle.mark_sync_needed();
        fail_listing(dir.path());
        watcher.poll_and_sync().await.expect("failed resync poll");
        assert!(
            updates(&mut frames).is_empty(),
            "a failed resync publishes neither a snapshot nor a deletion"
        );
        assert!(
            handle.is_sync_needed(),
            "the reconnect intent must survive a failed query"
        );
        assert!(watcher.tracked_sessions().contains_key("dev"));

        listing(dir.path(), &["dev", "api"]);
        watcher
            .poll_and_sync()
            .await
            .expect("recovered resync poll");
        assert!(
            !handle.is_sync_needed(),
            "a successful query satisfies the reconnect intent"
        );
        let recovered = updates(&mut frames);
        assert_eq!(
            recovered.len(),
            2,
            "the recovered full snapshot reports every live session: {recovered:?}"
        );
        assert!(recovered.contains(&("dev".to_string(), "detached".to_string())));
        assert!(recovered.contains(&("api".to_string(), "detached".to_string())));
        assert!(watcher.tracked_sessions().contains_key("dev"));
        assert!(watcher.tracked_sessions().contains_key("api"));

        // A genuine deletion still converges while a resync is pending: the
        // recovered snapshot is authoritative once it was actually observed.
        handle.mark_sync_needed();
        listing(dir.path(), &["api"]);
        watcher.poll_and_sync().await.expect("deletion poll");
        assert!(!handle.is_sync_needed());
        let after_deletion = updates(&mut frames);
        assert_eq!(
            after_deletion.len(),
            2,
            "one upsert for the survivor and one deletion: {after_deletion:?}"
        );
        assert!(after_deletion.contains(&("api".to_string(), "detached".to_string())));
        assert!(after_deletion.contains(&("dev".to_string(), "gone".to_string())));
        assert!(!watcher.tracked_sessions().contains_key("dev"));
        assert!(watcher.tracked_sessions().contains_key("api"));
    }

    #[tokio::test]
    async fn a_failed_enumeration_does_not_hide_selective_session_removal() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev", "api"]);
        let (mut watcher, _handle, mut frames) = watcher_at(dir.path());
        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(updates(&mut frames).len(), 2);
        assert!(watcher.tracked_sessions().contains_key("dev"));
        assert!(watcher.tracked_sessions().contains_key("api"));

        fail_listing(dir.path());
        watcher.poll_and_sync().await.expect("failed poll");
        assert!(updates(&mut frames).is_empty());
        assert!(watcher.tracked_sessions().contains_key("dev"));
        assert!(watcher.tracked_sessions().contains_key("api"));

        listing(dir.path(), &["api"]);
        watcher.poll_and_sync().await.expect("removal poll");
        let frames = updates(&mut frames);
        let gone: Vec<(String, String)> = frames
            .iter()
            .filter(|(_, status)| status == "gone")
            .cloned()
            .collect();
        assert_eq!(
            gone,
            vec![("dev".to_string(), "gone".to_string())],
            "only the Session that really disappeared is deleted: {frames:?}"
        );
        assert!(
            !frames.iter().any(|(name, _)| name == "api"),
            "the surviving session was not re-reported because nothing changed: {frames:?}"
        );
        assert!(!watcher.tracked_sessions().contains_key("dev"));
        assert!(
            watcher.tracked_sessions().contains_key("api"),
            "the unaffected Session stays tracked and visible"
        );
    }
}
