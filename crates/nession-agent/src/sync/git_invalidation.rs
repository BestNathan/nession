//! Polls tmux sessions and watches each one's git checkout for changes (#1008).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nession_git::invalidation::{RepositoryWatch, DEFAULT_DEBOUNCE};
use tokio::sync::mpsc;
use tracing::{debug, error, warn};

use crate::connection::ServerClientHandle;
use crate::tmux::manager::SessionManager;
use nession_git::WorkdirResolver;

/// Handle to shut down [`GitInvalidationWatcher`].
#[derive(Clone)]
pub struct GitInvalidationShutdownHandle {
    tx: mpsc::Sender<()>,
}

impl GitInvalidationShutdownHandle {
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.tx.send(()).await?;
        Ok(())
    }
}

struct SessionWatch {
    workdir: PathBuf,
    _watch: RepositoryWatch,
}

pub struct GitInvalidationWatcher {
    handle: ServerClientHandle,
    tmux: SessionManager,
    resolve_workdir: Arc<dyn WorkdirResolver>,
    poll_interval: Duration,
    sessions: HashMap<String, SessionWatch>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: mpsc::Receiver<()>,
}

impl GitInvalidationWatcher {
    pub fn new(
        handle: ServerClientHandle,
        tmux: SessionManager,
        resolve_workdir: Arc<dyn WorkdirResolver>,
        poll_interval_secs: u64,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        Self {
            handle,
            tmux,
            resolve_workdir,
            poll_interval: Duration::from_secs(poll_interval_secs),
            sessions: HashMap::new(),
            shutdown_tx,
            shutdown_rx,
        }
    }

    pub fn shutdown_handle(&self) -> GitInvalidationShutdownHandle {
        GitInvalidationShutdownHandle {
            tx: self.shutdown_tx.clone(),
        }
    }

    pub async fn run(mut self) -> anyhow::Result<()> {
        let mut ticker = tokio::time::interval(self.poll_interval);
        ticker.tick().await;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(e) = self.sync_watches().await {
                        error!("Git invalidation sync error: {:#}", e);
                    }
                }
                _ = self.shutdown_rx.recv() => {
                    debug!("Git invalidation watcher shutting down");
                    break;
                }
            }
        }
        Ok(())
    }

    async fn sync_watches(&mut self) -> anyhow::Result<()> {
        let live = self.tmux.list_sessions().await?;
        let live_names: std::collections::HashSet<String> =
            live.iter().map(|s| s.name.clone()).collect();

        self.sessions.retain(|name, _| live_names.contains(name));

        for session in live {
            let Some(workdir) = self.resolve_workdir.resolve(&session.name).await else {
                self.sessions.remove(&session.name);
                continue;
            };
            if !workdir.join(".git").exists() {
                self.sessions.remove(&session.name);
                continue;
            }

            let needs_restart = self
                .sessions
                .get(&session.name)
                .is_none_or(|w| w.workdir != workdir);

            if !needs_restart {
                continue;
            }

            let handle = self.handle.clone();
            let session_name = session.name.clone();
            let epoch = Arc::new(AtomicU64::new(0));
            let epoch_cb = Arc::clone(&epoch);
            let on_invalidate = Arc::new(move || {
                if !handle.is_connected() {
                    return;
                }
                let next = epoch_cb.fetch_add(1, Ordering::SeqCst) + 1;
                if let Err(e) = handle.send_git_invalidated(&session_name, next, None) {
                    warn!(
                        "failed to queue git invalidation for {}: {:#}",
                        session_name, e
                    );
                }
            });

            match RepositoryWatch::start(workdir.clone(), DEFAULT_DEBOUNCE, on_invalidate) {
                Ok(watch) => {
                    self.sessions.insert(
                        session.name.clone(),
                        SessionWatch {
                            workdir,
                            _watch: watch,
                        },
                    );
                }
                Err(e) => {
                    warn!(
                        session = %session.name,
                        "git invalidation watch failed ({e}); sending conservative invalidation"
                    );
                    let _ = self.handle.send_git_invalidated(
                        &session.name,
                        1,
                        Some("watch_error".to_string()),
                    );
                }
            }
        }
        Ok(())
    }
}
