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
            session.instance_id.as_deref(),
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
        if let Some(sync_token) = self.handle.sync_needed_token() {
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

            // Successful enumeration is not a completed re-sync. Every frame
            // must be accepted by the outbound owner before the intent is
            // satisfied: a failed enqueue leaves `prev_sessions` untouched, and
            // a later poll re-derives the whole snapshot. An accepted frame is
            // enqueued, not proof of remote receipt (#2976).
            for session in &current_sessions {
                if let Err(e) = self.send_update(session).await {
                    warn!(
                        "Session publication failed during full re-sync; keeping the reconnect \
                         intent and retrying next poll: {:#}",
                        e
                    );
                    return Ok(());
                }
            }

            // Mark sessions that disappeared while we were disconnected. A
            // refused removal must be retried too; otherwise a Session known to
            // be gone could stay visible on the Server while the intent was
            // consumed (#2976).
            let mut gone_failure = None;
            for name in self.prev_sessions.keys() {
                if !current_sessions.iter().any(|s| s.name == *name) {
                    debug!("Reporting stale session as gone: {}", name);
                    if let Err(e) = self.send_gone(name) {
                        gone_failure = Some(e);
                        break;
                    }
                }
            }
            if let Some(e) = gone_failure {
                warn!(
                    "Removal publication failed during full re-sync; keeping the reconnect \
                     intent and retrying next poll: {:#}",
                    e
                );
                return Ok(());
            }

            // Only the exact request observed before enumeration may be
            // satisfied. A reconnect or refused publish that arrived while this
            // snapshot was being published is newer and keeps the intent owed.
            if !self.handle.clear_sync_needed_if(sync_token) {
                debug!(
                    "A newer full re-sync request arrived during this snapshot; keeping it \
                     pending for the next poll"
                );
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
                self.handle
                    .send_session_update(name, "gone", 0, 0, None, None)?;
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
            session.instance_id.as_deref(),
        )?;

        Ok(())
    }

    /// Report a Session that no longer exists in tmux as gone.
    fn send_gone(&self, name: &str) -> Result<()> {
        self.handle
            .send_session_update(name, "gone", 0, 0, None, None)
    }

    /// Get a snapshot of the currently tracked sessions (for testing).
    pub fn tracked_sessions(&self) -> &HashMap<String, SessionInfo> {
        &self.prev_sessions
    }
}

/// Check if a session has changed between polls by comparing key fields.
///
/// The instance identity is part of the comparison (#3399): a same-name tmux
/// Session can be killed and recreated between polls with every visible counter
/// unchanged, and the name then addresses another incarnation. Without the
/// identity, the incremental path never publishes the replacement and the
/// Server keeps serving the previous snapshot until an unrelated field moves or
/// a full reconnect resync happens.
///
/// `created_at` stays out on purpose: tmux can report a different creation
/// timestamp for an observation that is not a lifecycle change, and the
/// durable `instance_id` is the identity the Server binds Project membership
/// to (`#3082`).
fn session_changed(prev: &SessionInfo, current: &SessionInfo) -> bool {
    prev.window_count != current.window_count
        || prev.attached_clients != current.attached_clients
        || prev.width != current.width
        || prev.height != current.height
        || prev.foreground_command != current.foreground_command
        || instance_replaced(prev.instance_id.as_deref(), current.instance_id.as_deref())
}

/// Whether two observations prove the name now names another incarnation.
///
/// Only **two nonempty, different** identities do. A missing id is "not
/// stated", never "a different instance": a legacy Session, a provider that has
/// not been asked yet, or a partial enumeration must not be published as a
/// replacement (`#3399`). An id that appears or disappears is a change in what
/// the Agent can state, not proof that the tmux Session was recreated.
fn instance_replaced(prev: Option<&str>, current: Option<&str>) -> bool {
    match (prev, current) {
        (Some(prev), Some(current)) => prev != current,
        _ => false,
    }
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
            instance_id: None,
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
    fn test_session_changed_detects_instance_replacement() {
        // The defect (#3399): every visible counter can match while the name
        // now addresses a different tmux incarnation. The identity is the only
        // field that proves it.
        let mut prev = make_session("test", 1, 2);
        prev.instance_id = Some("instance-a".to_string());
        let current = {
            let mut s = prev.clone();
            s.instance_id = Some("instance-b".to_string());
            s
        };

        assert!(session_changed(&prev, &current));
    }

    #[test]
    fn test_session_changed_ignores_the_same_instance() {
        let mut prev = make_session("test", 1, 2);
        prev.instance_id = Some("instance-a".to_string());
        let current = prev.clone();

        assert!(!session_changed(&prev, &current));
    }

    #[test]
    fn test_session_changed_does_not_manufacture_identity_changes() {
        // A legacy Session has no identity, and an id that appears or
        // disappears is not proof of a replacement. Publishing one would
        // turn "the Agent cannot state it" into a fabricated lifecycle event.
        let legacy = make_session("test", 1, 2);
        let mut with_id = legacy.clone();
        with_id.instance_id = Some("instance-a".to_string());

        assert!(!session_changed(&legacy, &with_id));
        assert!(!session_changed(&with_id, &legacy));
        assert!(!session_changed(&legacy, &legacy));
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

    pub(super) fn watcher_at(dir: &Path) -> (SessionWatcher, ServerClientHandle, OutboxFrames) {
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
    pub(super) fn listing(dir: &Path, sessions: &[&str]) {
        let mut script = String::new();
        for name in sessions {
            script.push_str(&format!(
                "printf '%s\\n' '{name}||1000|1|0|80|24|/tmp|bash'\n"
            ));
        }
        FakeTmux::new(dir, &script);
    }

    /// Install a fake tmux whose successful answer lists one Session with a
    /// nonempty durable instance identity (#3399).
    pub(super) fn listing_with_instance(dir: &Path, name: &str, instance_id: &str) {
        FakeTmux::new(
            dir,
            &format!("printf '%s\\n' '{name}|{instance_id}|1000|1|0|80|24|/tmp|bash'\n"),
        );
    }

    /// Drain every pending frame as `(session_name, status)`.
    pub(super) fn updates(frames: &mut OutboxFrames) -> Vec<(String, String)> {
        updates_with_instance(frames)
            .into_iter()
            .map(|(name, status, _)| (name, status))
            .collect()
    }

    /// Drain every pending frame as `(session_name, status, instance_id)`.
    ///
    /// The identity is read from the same `instance_id` payload field the
    /// Server's `server.agent.session-update` handler consumes, so a watcher
    /// test can assert the Agent→Server seam itself rather than only that
    /// *some* update was published (#3399).
    pub(super) fn updates_with_instance(
        frames: &mut OutboxFrames,
    ) -> Vec<(String, String, Option<String>)> {
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
            let instance_id = payload
                .get("instance_id")
                .and_then(serde_json::Value::as_str)
                .map(std::string::ToString::to_string);
            updates.push((name.to_string(), status.to_string(), instance_id));
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

/// Incarnation-replacement coverage (#3399).
///
/// These drive the real [`SessionWatcher`] over a fake tmux whose enumeration
/// changes only the durable instance identity between polls. The frames are
/// read from the outbox the watcher publishes into, so the assertion is the
/// Agent→Server seam: a replacement must reach the payload field the Server's
/// update handler consumes.
#[cfg(all(test, unix))]
mod incarnation_replacement {
    use super::enumeration_failure::{
        listing, listing_with_instance, updates_with_instance, watcher_at,
    };

    #[tokio::test]
    async fn a_same_name_replacement_with_an_unchanged_shape_is_published() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing_with_instance(dir.path(), "dev", "instance-a");
        let (mut watcher, _handle, mut frames) = watcher_at(dir.path());

        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(
            updates_with_instance(&mut frames),
            vec![(
                "dev".to_string(),
                "detached".to_string(),
                Some("instance-a".to_string())
            )],
            "the first poll states the identity it observed"
        );

        // Same windows, clients, size, working directory and foreground
        // command; only the incarnation changed. Before #3399 the predicate
        // ignored this field and the Server kept serving A indefinitely.
        listing_with_instance(dir.path(), "dev", "instance-b");
        watcher.poll_and_sync().await.expect("replacement poll");
        let replaced = updates_with_instance(&mut frames);
        assert_eq!(
            replaced.len(),
            1,
            "the replacement must be published exactly once: {replaced:?}"
        );
        assert_eq!(replaced[0].0, "dev");
        assert_eq!(replaced[0].1, "detached");
        assert_eq!(
            replaced[0].2.as_deref(),
            Some("instance-b"),
            "the frame must carry the current authoritative identity"
        );

        // B is the new baseline: an unchanged poll is silent.
        watcher.poll_and_sync().await.expect("idle poll");
        assert!(
            updates_with_instance(&mut frames).is_empty(),
            "an unchanged incarnation must not be re-published"
        );
    }

    #[tokio::test]
    async fn a_legacy_missing_instance_is_not_a_replacement() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev"]); // no @nession_instance_id
        let (mut watcher, _handle, mut frames) = watcher_at(dir.path());

        watcher.poll_and_sync().await.expect("initial poll");
        let first = updates_with_instance(&mut frames);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].2, None);

        // Unknown → known is a change in what the Agent can state, not proof
        // that the tmux Session was recreated. It must not be manufactured into
        // an incarnation transition.
        listing_with_instance(dir.path(), "dev", "instance-b");
        watcher.poll_and_sync().await.expect("identity appears");
        assert!(
            updates_with_instance(&mut frames).is_empty(),
            "a legacy missing identity must not be published as a replacement"
        );
    }
}

/// Publication-failure coverage (#2976).
///
/// These drive the real [`SessionWatcher`] against a manager whose injected tmux
/// the test owns, publish into the real bounded outbox, and arm only the publish
/// outcome through the handle's test-only fault seam. The frames are read back
/// in publication order, so the assertions are about what the Server would
/// actually receive — an accepted enqueue, not a claimed remote receipt.
#[cfg(all(test, unix))]
mod publication_failure {
    use super::enumeration_failure::{listing, updates, watcher_at};

    #[tokio::test]
    async fn an_enqueue_failure_after_enumeration_keeps_resync_pending_and_republishes_after_recovery(
    ) {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev"]);
        let (mut watcher, handle, mut frames) = watcher_at(dir.path());
        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "detached".to_string())]
        );

        // Reconnect marks the intent; enumeration succeeds, the enqueue fails.
        handle.mark_sync_needed();
        handle.inject_session_update_fault(Some("dev"), true, false);
        watcher.poll_and_sync().await.expect("failed resync poll");
        assert!(
            updates(&mut frames).is_empty(),
            "a failed enqueue publishes no snapshot"
        );
        assert!(
            handle.is_sync_needed(),
            "the reconnect intent survives an enqueue failure"
        );
        assert!(
            watcher.tracked_sessions().contains_key("dev"),
            "the previous snapshot survives an enqueue failure"
        );

        // The outbound owner recovers; no new reconnect event is delivered.
        watcher.poll_and_sync().await.expect("recovery poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "detached".to_string())],
            "the later poll republishes the still-live Session"
        );
        assert!(
            !handle.is_sync_needed(),
            "the accepted snapshot satisfies the observed intent"
        );
        assert!(
            watcher.tracked_sessions().contains_key("dev"),
            "the recovered snapshot remains tracked"
        );
    }

    #[tokio::test]
    async fn a_failed_gone_enqueue_during_resync_retries_and_removes_only_the_absent_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev", "api"]);
        let (mut watcher, handle, mut frames) = watcher_at(dir.path());
        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(updates(&mut frames).len(), 2);

        // `dev` disappears while disconnected. The surviving `api` is
        // re-reported first; publishing the removal of `dev` is refused.
        handle.mark_sync_needed();
        listing(dir.path(), &["api"]);
        handle.inject_session_update_fault(Some("dev"), true, false);
        watcher.poll_and_sync().await.expect("failed resync poll");
        let failed = updates(&mut frames);
        assert_eq!(
            failed,
            vec![("api".to_string(), "detached".to_string())],
            "no removal was accepted: {failed:?}"
        );
        assert!(handle.is_sync_needed());
        assert!(
            watcher.tracked_sessions().contains_key("dev"),
            "an absent Session is forgotten only after its removal is accepted"
        );
        assert!(watcher.tracked_sessions().contains_key("api"));

        // Recovery retries the full snapshot and the pending removal.
        watcher.poll_and_sync().await.expect("recovery poll");
        let recovered = updates(&mut frames);
        assert!(
            recovered.contains(&("api".to_string(), "detached".to_string())),
            "the surviving Session is preserved: {recovered:?}"
        );
        assert!(
            recovered.contains(&("dev".to_string(), "gone".to_string())),
            "the truly absent Session is removed on retry: {recovered:?}"
        );
        assert!(
            !recovered
                .iter()
                .any(|(name, status)| name == "api" && status == "gone"),
            "the live Session is never reported gone: {recovered:?}"
        );
        assert!(!handle.is_sync_needed());
        assert!(!watcher.tracked_sessions().contains_key("dev"));
        assert!(watcher.tracked_sessions().contains_key("api"));

        // An all-success snapshot clears the intent; the next poll is
        // incremental and publishes no redundant full snapshot.
        watcher.poll_and_sync().await.expect("idle poll");
        assert!(updates(&mut frames).is_empty());
    }

    #[tokio::test]
    async fn a_reconnect_request_during_resync_is_not_cleared_by_the_older_attempt() {
        let dir = tempfile::tempdir().expect("tempdir");
        listing(dir.path(), &["dev"]);
        let (mut watcher, handle, mut frames) = watcher_at(dir.path());
        watcher.poll_and_sync().await.expect("initial poll");
        assert_eq!(updates(&mut frames).len(), 1);

        // The snapshot publish succeeds, but a new reconnect request arrives
        // while it is being published.
        handle.mark_sync_needed();
        handle.inject_session_update_fault(Some("dev"), false, true);
        watcher
            .poll_and_sync()
            .await
            .expect("overlapping resync poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "detached".to_string())]
        );
        assert!(
            handle.is_sync_needed(),
            "the newer reconnect request survives the older attempt's success"
        );

        // The next poll serves the latest request and then settles.
        watcher.poll_and_sync().await.expect("latest request poll");
        assert_eq!(
            updates(&mut frames),
            vec![("dev".to_string(), "detached".to_string())]
        );
        assert!(!handle.is_sync_needed());

        watcher.poll_and_sync().await.expect("idle poll");
        assert!(updates(&mut frames).is_empty());
    }
}
