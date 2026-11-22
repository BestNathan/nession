//! Agent-owned Sandbox execution lifecycle (#2681, #3124).
//!
//! `nession-sandbox` owns policy compilation, the native backends and the
//! launch barrier. This module owns the Agent's side of the lifecycle: where
//! the host configuration comes from, which executions are currently tracked,
//! cleanup when a Pane disappears, and reconciliation after a restart.
//!
//! Executions are keyed by the tmux **Pane** they own, not only by Session
//! name: one Session may hold a Native Pane and one or more Sandbox Panes, and
//! a removed Window must not be mistaken for a live execution just because its
//! Session still exists.
//!
//! The tracker never treats a failed tmux listing as "no Panes". A query
//! failure skips the pass; only a successful snapshot that lacks a tracked
//! Pane releases that execution's owned resources.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use nession_protocol::contracts::sandbox::v1::{
    SandboxActionErrorKind, SandboxActionResult, SandboxCapabilityCatalog,
};
use nession_sandbox::{
    catalog, cleanup_record, prepare, probe, reconcile, Capabilities, CleanupReport,
    ExecutionRecord, LaunchRequest, LivePane, PreparedSandbox, ReconcileOutcome,
    SandboxExecutionHandle, SandboxSettings,
};

use crate::tmux::ops::TmuxDep;
use crate::workspace_manager::WorkspaceLease;

const REAPER_INTERVAL: Duration = Duration::from_millis(500);
const REAPER_IDLE_INTERVAL: Duration = Duration::from_secs(2);
/// A failed cleanup is retried on a bounded exponential backoff so a resource
/// that cannot be released yet does not spin the reaper.
const CLEANUP_RETRY_BASE: Duration = Duration::from_millis(500);
const CLEANUP_RETRY_MAX: Duration = Duration::from_secs(30);
/// The host catalog is a measured fact; probing it on every context refresh
/// would spawn Bubblewrap fixtures repeatedly. The capability changes rarely,
/// and Enter re-probes through `prepare` regardless.
const CATALOG_TTL: Duration = Duration::from_secs(15);
/// How many completed Enter attempts are remembered for idempotent retries.
const RECENT_ENTER_LIMIT: usize = 32;

/// One tracked execution.
enum TrackedExecution {
    /// A verified execution owned by this Agent process.
    Live(Box<SandboxExecutionHandle>),
    /// A record recovered at startup whose Pane still exists. Its owned
    /// resources are released when the Pane disappears.
    Recovered(Box<ExecutionRecord>),
    /// A record whose last cleanup attempt failed. The identity is retained so
    /// the reaper retries exactly the resources the Agent still owns; the
    /// bounded backoff keeps a persistently failing resource from spinning.
    CleanupPending {
        record: Box<ExecutionRecord>,
        attempts: u32,
        next_attempt: Instant,
    },
}

impl TrackedExecution {
    fn record(&self) -> &ExecutionRecord {
        match self {
            Self::Live(handle) => handle.record(),
            Self::Recovered(record) => record,
            Self::CleanupPending { record, .. } => record,
        }
    }

    /// Whether the reaper may retry this entry now. Explicit caller-driven
    /// cleanup ignores the backoff.
    fn retry_due(&self, now: Instant) -> bool {
        match self {
            Self::CleanupPending { next_attempt, .. } => *next_attempt <= now,
            Self::Live(_) | Self::Recovered(_) => true,
        }
    }
}

/// Bounded exponential retry delay for failed cleanups.
fn cleanup_retry_delay(attempts: u32) -> Duration {
    let exponent = attempts.saturating_sub(1).min(6);
    (CLEANUP_RETRY_BASE * (1u32 << exponent)).min(CLEANUP_RETRY_MAX)
}

/// The Pane a prepared execution was launched into, as tmux reported it.
#[derive(Debug, Clone)]
pub struct PaneLaunchTarget {
    pub pane_pid: u32,
    pub pane_id: Option<String>,
    pub window_id: Option<String>,
}

/// The Agent's Sandbox runtime.
pub struct SandboxRuntime {
    settings: SandboxSettings,
    executions: Mutex<HashMap<String, TrackedExecution>>,
    recent_enters: Mutex<VecDeque<(String, SandboxActionResult)>>,
    catalog_cache: Mutex<Option<(Instant, SandboxCapabilityCatalog)>>,
    reaper_started: AtomicBool,
    tmux: Mutex<Option<TmuxDep>>,
    /// The Agent's durable EROFS cache (#3062). Managed creation downloads
    /// its pinned images here; a runtime without one refuses Managed creates.
    erofs_cache: Mutex<Option<Arc<crate::erofs_cache::ErofsCache>>>,
    /// RW attachments to managed Workspaces, keyed by execution id. Released
    /// when that execution is cleaned up; a restart clears them (the durable
    /// execution record is the attachment authority for the follow-up).
    workspace_leases: Mutex<HashMap<String, WorkspaceLease>>,
}

impl SandboxRuntime {
    /// Build the runtime from host-local settings.
    pub fn new(settings: SandboxSettings) -> Arc<Self> {
        Arc::new(Self {
            settings,
            executions: Mutex::new(HashMap::new()),
            recent_enters: Mutex::new(VecDeque::new()),
            catalog_cache: Mutex::new(None),
            reaper_started: AtomicBool::new(false),
            tmux: Mutex::new(None),
            erofs_cache: Mutex::new(None),
            workspace_leases: Mutex::new(HashMap::new()),
        })
    }

    /// Build the host settings from the Agent configuration.
    ///
    /// `identity` is this Agent's stable identity. The verified EROFS cache is
    /// namespaced per identity (#3180), so the sandbox mounts only the images
    /// this Agent owns; another identity's blobs are not reachable through the
    /// composition root.
    pub fn from_config(
        config: &crate::config::AgentConfig,
        identity: &str,
        erofs_cache: Option<Arc<crate::erofs_cache::ErofsCache>>,
    ) -> Arc<Self> {
        let agent_dir = nession_common::paths::agent_dir().ok();
        let state_dir = config
            .sandbox
            .state_dir
            .clone()
            .or_else(|| agent_dir.as_ref().map(|dir| dir.join("sandbox")))
            .unwrap_or_else(|| PathBuf::from(".nession/agent/sandbox"));
        let bridge_executable = config
            .sandbox
            .bridge_executable
            .clone()
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("nession-agent"));
        let settings = SandboxSettings::new(
            state_dir,
            bridge_executable,
            config
                .sandbox
                .bubblewrap_path
                .clone()
                .unwrap_or_else(|| PathBuf::from("bwrap")),
            config
                .sandbox
                .sandbox_exec_path
                .clone()
                .unwrap_or_else(|| PathBuf::from("/usr/bin/sandbox-exec")),
        );
        let mut settings = settings;
        settings.enabled = config.sandbox.enabled;
        settings.cgroup_root = config.sandbox.cgroup_root.clone();
        // The verified EROFS cache is the only root a composition may mount
        // files from (#3023). Resolution failure leaves it unset, so a
        // composition request fails closed instead of trusting an arbitrary path.
        // The root is this identity's namespace, never the shared volume root
        // (#3180): another Agent's mutable cache must not be mountable.
        if let Ok(resolved) = config.effective_erofs_storage_dir() {
            if let Ok(namespace) = crate::erofs_cache::identity_root(&resolved.path, identity) {
                settings.erofs_image_root = Some(namespace);
            }
        }
        if let Some(seconds) = config.sandbox.launch_timeout_secs {
            settings.launch_timeout = Duration::from_secs(seconds);
        }
        if let Some(agent_dir) = &agent_dir {
            // Identity, env files and metadata live here. A sandbox must not
            // see them even when no filesystem policy was requested.
            settings.private_directories.push(agent_dir.clone());
            // The durable Agent Workspace registry is the second authorized
            // writable root (#3407). Its child directories may be bound as the
            // composition `/workspace`; nothing else under the Agent data
            // directory becomes an Agent-owned workspace.
            settings.agent_workspaces_root = Some(agent_dir.join("workspaces"));
        }
        // One shared EROFS mount manager per Agent identity/mount namespace
        // (#3449). Its authorized root is exactly the verified image root; a
        // missing root leaves the manager absent, so composition fails closed.
        #[cfg(target_os = "linux")]
        let mount_manager = settings.erofs_image_root.as_ref().and_then(|image_root| {
            let config = nession_erofs::mount_manager::MountManagerConfig {
                root: settings.state_dir.join("erofs-mounts"),
                settings: nession_erofs::mount::MountSettings::new(
                    settings.erofsfuse_path.clone(),
                    settings.fusermount_path.clone(),
                ),
                authorized_roots: vec![image_root.clone()],
                pinner: erofs_cache.clone().map(|cache| {
                    Arc::new(crate::erofs_cache::CachePinner::new(cache))
                        as Arc<dyn nession_erofs::mount_manager::BlobPinner>
                }),
            };
            match nession_erofs::mount_manager::MountManager::open(config) {
                Ok(manager) => Some(manager),
                Err(error) => {
                    tracing::warn!(
                        "could not open the shared EROFS mount manager; compositions fail closed: {error:#}"
                    );
                    None
                }
            }
        });
        #[cfg(target_os = "linux")]
        {
            settings.mount_manager = mount_manager;
        }
        // One shared writable Overlay owner per Agent identity/mount namespace
        // (#3582). Its authorized roots are the Agent-owned writable workspace
        // roots: managed Workspaces, the Enter scratch root and the Managed
        // Session root. A composition whose writable directory is outside them
        // fails closed.
        #[cfg(target_os = "linux")]
        let overlay_manager = settings.mount_manager.as_ref().and_then(|lower| {
            let mut workspace_roots = Vec::new();
            if let Some(root) = &settings.agent_workspaces_root {
                workspace_roots.push(root.clone());
            }
            workspace_roots.push(settings.state_dir.join("sandbox-workspaces"));
            workspace_roots.push(settings.state_dir.join("managed"));
            for root in &workspace_roots {
                if let Err(error) = std::fs::create_dir_all(root) {
                    tracing::warn!(
                        "could not create the authorized Overlay workspace root {}: {error}",
                        root.display()
                    );
                    return None;
                }
            }
            let lower_provider: Arc<dyn nession_sandbox::mount::overlay::LowerProvider> =
                lower.clone();
            match nession_sandbox::mount::overlay::OverlayMountManager::open(
                nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                    root: settings.state_dir.join("erofs-overlays"),
                    workspace_roots,
                    settings: nession_sandbox::mount::overlay::OverlaySettings::new(
                        settings.fuse_overlayfs_path.clone(),
                        settings.fusermount_path.clone(),
                    ),
                    lower: lower_provider,
                    identity: identity.to_string(),
                },
            ) {
                Ok(manager) => Some(manager),
                Err(error) => {
                    tracing::warn!(
                        "could not open the shared Workspace Overlay manager; compositions with a \
                         Project lower fail closed: {error:#}"
                    );
                    None
                }
            }
        });
        #[cfg(target_os = "linux")]
        {
            settings.overlay_manager = overlay_manager;
        }
        let runtime = Self::new(settings);
        // `new` returns an `Arc`, so expose the cache through a one-shot
        // setter rather than rebuilding the runtime.
        runtime.set_erofs_cache(erofs_cache);
        runtime
    }

    fn set_erofs_cache(&self, cache: Option<Arc<crate::erofs_cache::ErofsCache>>) {
        if let Ok(mut slot) = self.erofs_cache.lock() {
            *slot = cache;
        }
    }

    /// The Agent's durable EROFS cache, when configured.
    pub fn erofs_cache(&self) -> Option<Arc<crate::erofs_cache::ErofsCache>> {
        self.erofs_cache.lock().ok().and_then(|slot| slot.clone())
    }

    /// The host settings, for diagnostics and tests.
    pub fn settings(&self) -> &SandboxSettings {
        &self.settings
    }

    /// Observed use of one managed Workspace (#3582, #3797).
    ///
    /// This is the Agent Workspace Manager's deletion and detail probe: it
    /// reports an in-memory attachment, a mounted/leased physical Overlay, a
    /// live durable owner lock, or a failed/orphaned state. Only a complete,
    /// unmounted and unowned durable state reports no reason.
    ///
    /// Consumers are Session names only. The observation never exposes a host
    /// path, grant, execution directory or another consumer's runtime identity.
    pub fn observe_workspace(
        &self,
        workspace_id: &str,
        workspace_directory: &std::path::Path,
    ) -> crate::workspace_manager::WorkspaceObservation {
        let mut consumers = std::collections::BTreeSet::new();
        let mut in_use = None;
        let mut leased_executions = Vec::new();
        if let Ok(leases) = self.workspace_leases.lock() {
            for (execution_id, lease) in leases.iter() {
                if lease.workspace_id() == workspace_id {
                    in_use.get_or_insert_with(|| {
                        "an execution holds an attachment lease".to_string()
                    });
                    leased_executions.push(execution_id.clone());
                }
            }
        }
        // A surviving execution record is authoritative attachment evidence:
        // even when its physical Overlay could not be adopted, the Workspace
        // it was bound to must not be deleted underneath it.
        if let Ok(executions) = self.executions.lock() {
            for entry in executions.values() {
                let record = entry.record();
                let bound = record_uses_workspace(record, workspace_directory);
                if bound
                    || leased_executions
                        .iter()
                        .any(|execution_id| execution_id == &record.execution_id)
                {
                    if bound {
                        in_use.get_or_insert_with(|| {
                            "a live Sandbox execution is bound to this Workspace".to_string()
                        });
                    }
                    consumers.insert(record.session_name.clone());
                }
            }
        }
        let (mounted, overlay_in_use) = self.observe_overlay(workspace_directory);
        if let Some(reason) = overlay_in_use {
            in_use.get_or_insert(reason);
        }
        crate::workspace_manager::WorkspaceObservation {
            in_use,
            consumers: consumers.into_iter().collect(),
            mounted,
        }
    }

    /// The Overlay manager's observed mount/owner state, when this Agent has
    /// a Sandbox runtime. A host without one observes nothing.
    #[cfg(target_os = "linux")]
    fn observe_overlay(&self, workspace_directory: &std::path::Path) -> (bool, Option<String>) {
        let Some(manager) = &self.settings.overlay_manager else {
            return (false, None);
        };
        let Ok(workspace) = manager.resolve_workspace(workspace_directory) else {
            return (false, None);
        };
        let mut mounted = false;
        let mut in_use = None;
        if let Some(status) = manager.lookup(&workspace) {
            mounted = status.mounted;
            if status.mounted
                || status.consumers > 0
                || status.state != nession_sandbox::mount::overlay::OverlayState::Idle
            {
                in_use = Some(format!(
                    "the Workspace has observed Overlay state ({:?})",
                    status.state
                ));
            }
        }
        if manager.probe_owner_held(&workspace) {
            in_use = Some("a live process owns the durable Overlay".to_string());
        }
        (mounted, in_use)
    }

    #[cfg(not(target_os = "linux"))]
    fn observe_overlay(&self, _workspace_directory: &std::path::Path) -> (bool, Option<String>) {
        (false, None)
    }

    /// Probe the host without creating an execution.
    pub fn capabilities(&self) -> Capabilities {
        probe(&self.settings)
    }

    /// The measured host catalog, cached briefly (see [`CATALOG_TTL`]).
    pub fn catalog(&self) -> SandboxCapabilityCatalog {
        let now = Instant::now();
        if let Ok(cache) = self.catalog_cache.lock() {
            if let Some((measured_at, catalog)) = cache.as_ref() {
                if now.duration_since(*measured_at) < CATALOG_TTL {
                    return catalog.clone();
                }
            }
        }
        let catalog = catalog(&self.capabilities());
        if let Ok(mut cache) = self.catalog_cache.lock() {
            *cache = Some((now, catalog.clone()));
        }
        catalog
    }

    /// Discard the cached catalog (after a launch changed host resources).
    pub fn forget_catalog(&self) {
        if let Ok(mut cache) = self.catalog_cache.lock() {
            *cache = None;
        }
    }

    /// Compile and prepare a launch. Blocking; callers use
    /// `spawn_blocking`.
    pub fn prepare(&self, request: &LaunchRequest) -> Result<PreparedSandbox> {
        prepare(request, &self.settings).map_err(anyhow::Error::from)
    }

    /// Arm the reaper with this Agent's tmux addressing.
    pub fn arm_reaper(self: &Arc<Self>, tmux: TmuxDep) {
        if let Ok(mut slot) = self.tmux.lock() {
            *slot = Some(tmux);
        }
        self.spawn_reaper();
    }

    /// Track a verified execution under the Pane it owns, together with any
    /// managed Workspace lease the execution keeps alive.
    pub fn register(
        self: &Arc<Self>,
        handle: SandboxExecutionHandle,
        workspace_lease: Option<WorkspaceLease>,
    ) {
        let key = execution_key(handle.record());
        let execution_id = handle.record().execution_id.clone();
        if let Ok(mut executions) = self.executions.lock() {
            executions.insert(key, TrackedExecution::Live(Box::new(handle)));
        }
        if let Some(lease) = workspace_lease {
            if let Ok(mut leases) = self.workspace_leases.lock() {
                leases.insert(execution_id, lease);
            }
        }
        self.spawn_reaper();
    }

    fn release_workspace_lease(&self, execution_id: &str) {
        if let Ok(mut leases) = self.workspace_leases.lock() {
            leases.remove(execution_id);
        }
    }

    /// Whether any execution of this Session is tracked.
    pub fn is_tracked(&self, session_name: &str) -> bool {
        self.executions
            .lock()
            .map(|executions| {
                executions
                    .values()
                    .any(|entry| entry.record().session_name == session_name)
            })
            .unwrap_or(false)
    }

    /// The execution that owns one exact Pane, if this Agent tracks it.
    pub fn execution_for_pane(&self, session_name: &str, pane_id: &str) -> Option<ExecutionRecord> {
        self.executions.lock().ok().and_then(|executions| {
            executions
                .values()
                .map(TrackedExecution::record)
                .find(|record| {
                    record.session_name == session_name
                        && record.pane_id.as_deref() == Some(pane_id)
                })
                .cloned()
        })
    }

    /// The legacy (pre-per-Pane) execution whose Pane is the one with this
    /// root PID. A record created before #3124 named no Pane id.
    pub fn legacy_execution_for_pane(
        &self,
        session_name: &str,
        pane_pid: Option<u32>,
    ) -> Option<ExecutionRecord> {
        let pane_pid = pane_pid?;
        self.executions.lock().ok().and_then(|executions| {
            executions
                .values()
                .map(TrackedExecution::record)
                .find(|record| {
                    record.session_name == session_name
                        && record.pane_id.is_none()
                        && record.pane_pid == Some(pane_pid)
                })
                .cloned()
        })
    }

    /// Every tracked execution with a Pane identity in this Session.
    pub fn sandbox_panes(&self, session_name: &str) -> Vec<ExecutionRecord> {
        self.executions
            .lock()
            .map(|executions| {
                executions
                    .values()
                    .map(TrackedExecution::record)
                    .filter(|record| {
                        record.session_name == session_name && record.pane_id.is_some()
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Release every execution owned by one Session (a Session kill).
    pub fn cleanup_session(&self, session_name: &str) -> Result<usize> {
        let keys: Vec<String> = self
            .executions
            .lock()
            .map(|executions| {
                executions
                    .iter()
                    .filter(|(_, entry)| entry.record().session_name == session_name)
                    .map(|(key, _)| key.clone())
                    .collect()
            })
            .unwrap_or_default();
        let mut cleaned = 0;
        for key in keys {
            if self.cleanup_entry(&key)?.is_some() {
                cleaned += 1;
            }
        }
        Ok(cleaned)
    }

    /// Release one exact Pane's execution, if tracked.
    pub fn cleanup_pane(&self, session_name: &str, pane_id: &str) -> Result<Option<CleanupReport>> {
        let key = self.executions.lock().ok().and_then(|executions| {
            executions
                .iter()
                .find(|(_, entry)| {
                    let record = entry.record();
                    record.session_name == session_name
                        && record.pane_id.as_deref() == Some(pane_id)
                })
                .map(|(key, _)| key.clone())
        });
        match key {
            Some(key) => self.cleanup_entry(&key),
            None => Ok(None),
        }
    }

    /// Release one tracked key. Returns `None` when it was not tracked.
    ///
    /// A failed attempt never drops the tracked identity: the same record is
    /// kept as [`TrackedExecution::CleanupPending`] so the reaper retries the
    /// resources the Agent still owns. Explicit calls retry immediately.
    pub fn cleanup_entry(&self, key: &str) -> Result<Option<CleanupReport>> {
        let Some(entry) = self
            .executions
            .lock()
            .ok()
            .and_then(|mut executions| executions.remove(key))
        else {
            return Ok(None);
        };
        let (record, prior_attempts) = match entry {
            TrackedExecution::Live(handle) => {
                let record = handle.record().clone();
                match handle.cleanup() {
                    Ok(report) => {
                        self.release_workspace_lease(&record.execution_id);
                        return Ok(Some(report));
                    }
                    Err(error) => return Err(self.retain_for_retry(key, record, 0, error.into())),
                }
            }
            TrackedExecution::Recovered(record) => (*record, 0),
            TrackedExecution::CleanupPending {
                record, attempts, ..
            } => (*record, attempts),
        };
        let mut report = CleanupReport {
            execution_id: record.execution_id.clone(),
            ..CleanupReport::default()
        };
        match cleanup_record(&self.settings, &record, &mut report) {
            Ok(()) => {
                self.release_workspace_lease(&record.execution_id);
                Ok(Some(report))
            }
            Err(error) => Err(self.retain_for_retry(key, record, prior_attempts, error.into())),
        }
    }

    /// Keep a failed cleanup tracked with the next bounded retry time.
    fn retain_for_retry(
        &self,
        key: &str,
        record: ExecutionRecord,
        prior_attempts: u32,
        error: anyhow::Error,
    ) -> anyhow::Error {
        let attempts = prior_attempts.saturating_add(1);
        if let Ok(mut executions) = self.executions.lock() {
            executions.insert(
                key.to_string(),
                TrackedExecution::CleanupPending {
                    record: Box::new(record),
                    attempts,
                    next_attempt: Instant::now() + cleanup_retry_delay(attempts),
                },
            );
        }
        error
    }

    /// Remember one completed Enter attempt for an idempotent retry.
    pub fn remember_enter(&self, enter_id: &str, result: SandboxActionResult) {
        if let Ok(mut recent) = self.recent_enters.lock() {
            recent.push_back((enter_id.to_string(), result));
            while recent.len() > RECENT_ENTER_LIMIT {
                recent.pop_front();
            }
        }
    }

    /// The outcome of an Enter attempt with this client id, if still recent.
    pub fn recent_enter(&self, enter_id: &str) -> Option<SandboxActionResult> {
        self.recent_enters.lock().ok().and_then(|recent| {
            recent
                .iter()
                .find(|(id, _)| id == enter_id)
                .map(|(_, result)| result.clone())
        })
    }

    /// Reconcile records left by a previous Agent process against the live
    /// tmux Pane set.
    pub fn reconcile(self: &Arc<Self>, live_panes: &[LivePane]) -> Result<()> {
        let outcomes = reconcile(&self.settings, live_panes).map_err(anyhow::Error::from)?;
        if let Ok(mut executions) = self.executions.lock() {
            for outcome in outcomes {
                match outcome {
                    ReconcileOutcome::Active(record) => {
                        tracing::info!(
                            session = %record.session_name,
                            pane = %record.pane_id.as_deref().unwrap_or("<legacy>"),
                            execution = %record.execution_id,
                            "recovered Sandbox execution for a live Pane"
                        );
                        let key = execution_key(&record);
                        executions.insert(key, TrackedExecution::Recovered(Box::new(*record)));
                    }
                    ReconcileOutcome::Cleaned(execution_id) => {
                        tracing::info!(%execution_id, "removed leftover Sandbox resources");
                    }
                    ReconcileOutcome::CleanupFailed(record, error) => {
                        tracing::warn!(
                            execution = %record.execution_id,
                            "could not clean a recovered Sandbox execution; tracking it for a \
                             bounded retry: {error}"
                        );
                        let key = execution_key(&record);
                        executions.insert(
                            key,
                            TrackedExecution::CleanupPending {
                                record,
                                attempts: 1,
                                next_attempt: Instant::now() + cleanup_retry_delay(1),
                            },
                        );
                    }
                    ReconcileOutcome::Failed(execution_id, error) => {
                        tracing::warn!(
                            %execution_id,
                            "could not reconcile Sandbox execution: {error}"
                        );
                    }
                }
            }
        }
        self.spawn_reaper();
        Ok(())
    }

    fn spawn_reaper(self: &Arc<Self>) {
        if self.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let tmux = self.tmux.lock().ok().and_then(|slot| slot.clone());
        let Some(tmux) = tmux else {
            self.reaper_started.store(false, Ordering::SeqCst);
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.reaper_started.store(false, Ordering::SeqCst);
            return;
        };
        let runtime = Arc::clone(self);
        handle.spawn(async move {
            let ops = tmux.ops();
            loop {
                let has_executions = runtime
                    .executions
                    .lock()
                    .map(|executions| !executions.is_empty())
                    .unwrap_or(false);
                if !has_executions {
                    tokio::time::sleep(REAPER_IDLE_INTERVAL).await;
                    continue;
                }
                match ops.list_panes().await {
                    Ok(panes) => {
                        let live_panes: HashSet<String> =
                            panes.iter().map(|pane| pane.pane_id.clone()).collect();
                        let live_sessions: HashSet<String> =
                            panes.iter().map(|pane| pane.session_name.clone()).collect();
                        let now = Instant::now();
                        let vanished: Vec<String> = runtime
                            .executions
                            .lock()
                            .map(|executions| {
                                executions
                                    .iter()
                                    .filter(|(_, entry)| {
                                        if !entry.retry_due(now) {
                                            return false;
                                        }
                                        let record = entry.record();
                                        match &record.pane_id {
                                            Some(pane_id) => !live_panes.contains(pane_id),
                                            // A pre-#3124 record has no Pane id;
                                            // its Session is the only evidence
                                            // the record can be checked against.
                                            None => !live_sessions.contains(&record.session_name),
                                        }
                                    })
                                    .map(|(key, _)| key.clone())
                                    .collect()
                            })
                            .unwrap_or_default();
                        for key in vanished {
                            let runtime = Arc::clone(&runtime);
                            let cleanup =
                                tokio::task::spawn_blocking(move || runtime.cleanup_entry(&key))
                                    .await;
                            match cleanup {
                                Ok(Ok(Some(report))) => tracing::info!(
                                    execution = %report.execution_id,
                                    "released Sandbox resources after its Pane ended"
                                ),
                                Ok(Ok(None)) => {}
                                Ok(Err(error)) => tracing::warn!(
                                    "Sandbox cleanup failed; the record stays for retry: {error:#}"
                                ),
                                Err(error) => {
                                    tracing::warn!("Sandbox cleanup task failed: {error}")
                                }
                            }
                        }
                    }
                    // A failed query is not "no Panes". Skipping the pass is
                    // the only safe reading.
                    Err(error) => tracing::warn!(
                        "Sandbox reaper could not list Panes; skipping this pass: {error:#}"
                    ),
                }
                tokio::time::sleep(REAPER_INTERVAL).await;
            }
        });
    }
}

/// The tracker key for one execution: its owned Pane, or the Session for a
/// record created before per-Pane tracking.
pub fn execution_key(record: &ExecutionRecord) -> String {
    match &record.pane_id {
        Some(pane_id) => format!("pane:{pane_id}"),
        None => format!("session:{}", record.session_name),
    }
}

/// Whether a durable execution record was bound to one Workspace directory.
fn record_uses_workspace(record: &ExecutionRecord, directory: &std::path::Path) -> bool {
    let Some(write) = record
        .effective_policy
        .as_ref()
        .and_then(|policy| policy.filesystem.as_ref())
        .and_then(|filesystem| filesystem.composition.as_ref())
        .and_then(|composition| composition.workspace.as_ref())
        .map(|workspace| std::path::Path::new(&workspace.write))
    else {
        return false;
    };
    let directory = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let write = std::fs::canonicalize(write).unwrap_or_else(|_| write.to_path_buf());
    write == directory
}

/// The Agent Workspace Manager's observed-use probe (#3582).
pub struct SandboxWorkspaceUse {
    runtime: Arc<SandboxRuntime>,
}

impl SandboxWorkspaceUse {
    pub fn new(runtime: Arc<SandboxRuntime>) -> Arc<Self> {
        Arc::new(Self { runtime })
    }
}

impl crate::workspace_manager::WorkspaceUseGuard for SandboxWorkspaceUse {
    fn observe_workspace(
        &self,
        workspace_id: &str,
        directory: &std::path::Path,
    ) -> crate::workspace_manager::WorkspaceObservation {
        self.runtime.observe_workspace(workspace_id, directory)
    }
}

/// The actionable outcome for an error kind, with no context attached. The
/// caller adds the observed context when it has one.
pub fn action_failure(
    kind: SandboxActionErrorKind,
    error: impl Into<String>,
) -> SandboxActionResult {
    SandboxActionResult {
        success: false,
        error_kind: Some(kind),
        error: Some(error.into()),
        field_errors: None,
        context: None,
    }
}

/// Prepare, verify and register one sandboxed Pane.
///
/// Runs on a blocking task: probes spawn bounded processes and the barrier
/// waits for the in-sandbox init. `launch_and_verify` deliberately refuses to
/// kill the Pane itself — the caller owns the tmux resource it created and
/// knows whether removal is safe.
pub fn launch_and_verify(
    runtime: &Arc<SandboxRuntime>,
    mut prepared: PreparedSandbox,
    pane: PaneLaunchTarget,
    session_name: &str,
    workspace_lease: Option<WorkspaceLease>,
) -> Result<nession_protocol::contracts::sandbox::v1::SandboxExecutionReport> {
    prepared.set_pane_identity(pane.pane_id.as_deref(), pane.window_id.as_deref());
    if let Err(error) = prepared.verify(pane.pane_pid) {
        let abort = prepared.abort();
        return Err(anyhow::anyhow!(
            "sandbox launch verification failed: {error}{}",
            abort
                .err()
                .map(|abort| format!("; cleanup also failed: {abort}"))
                .unwrap_or_default()
        ));
    }
    let report = prepared.report().clone();
    let handle = prepared.into_handle();
    runtime.register(handle, workspace_lease);
    runtime.forget_catalog();
    let _ = session_name;
    Ok(report)
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;
    use nession_protocol::contracts::sandbox::v1::SandboxPolicy;
    use std::path::PathBuf;

    fn policy(value: serde_json::Value) -> SandboxPolicy {
        serde_json::from_value(value).expect("policy fixture")
    }

    fn request(policy: SandboxPolicy) -> LaunchRequest {
        LaunchRequest {
            policy,
            session_name: "sandbox-test".to_string(),
            instance_id: "instance-test".to_string(),
            working_dir: "/private/tmp".to_string(),
            inner_command: vec!["/bin/sh".to_string()],
            tmux_socket: None,
        }
    }

    fn settings(dir: &std::path::Path) -> SandboxSettings {
        SandboxSettings::new(
            dir.join("state"),
            PathBuf::from("/usr/bin/true"),
            PathBuf::from("bwrap"),
            PathBuf::from("/usr/bin/sandbox-exec"),
        )
    }

    #[test]
    fn the_catalog_is_cached_and_forget_recomputes_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let first = runtime.catalog();
        assert_eq!(first.catalog_version, 2);
        assert_eq!(first.implementations.len(), 6);
        let cached = runtime.catalog();
        assert_eq!(cached.probe_generation, first.probe_generation);
        assert_eq!(cached.implementations, first.implementations);
        runtime.forget_catalog();
        let recomputed = runtime.catalog();
        assert_eq!(recomputed.probe_generation, first.probe_generation);
        assert_eq!(recomputed.implementations, first.implementations);
    }

    /// On macOS the verified mechanism is network denial. A policy that asks
    /// for it prepares a Seatbelt launch and reports exactly that.
    #[test]
    fn a_verified_network_deny_prepares_a_seatbelt_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let prepared = runtime
            .prepare(&request(policy(serde_json::json!({
                "enabled": true,
                "network": { "mode": "deny" }
            }))))
            .expect("a verified mechanism must prepare");
        assert_eq!(prepared.report().backend, "macos-seatbelt");
        assert_eq!(
            prepared.command().first().map(String::as_str),
            Some("/usr/bin/sandbox-exec")
        );
        assert!(
            prepared
                .command()
                .iter()
                .any(|argument| argument.contains("deny network*")),
            "the profile must be on the launcher argv: {:?}",
            prepared.command()
        );
        let cleanup = prepared.abort().expect("cleanup");
        assert!(cleanup.removed);
    }

    /// A filesystem allow-list is not verified on this platform; the backend
    /// refuses it instead of approximating it.
    #[test]
    fn an_unverified_filesystem_policy_fails_closed_on_macos() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let error = match runtime.prepare(&request(policy(serde_json::json!({
            "enabled": true,
            "filesystem": { "access": { "read": ["/usr"], "write": [] } }
        })))) {
            Ok(_) => panic!("macOS must refuse filesystem.access it cannot verify"),
            Err(error) => error,
        };
        assert!(
            format!("{error:#}").contains("filesystem.access"),
            "the refusal must name the mechanism: {error:#}"
        );
    }

    /// A recorded cleanup that fails must keep its tracked identity: dropping
    /// it would make the reaper forget resources the Agent still owns. The
    /// Linux transient-rootfs release is the deterministic failing boundary.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_failed_recovered_cleanup_keeps_the_record_tracked_for_retry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).expect("state dir");
        let state = std::fs::canonicalize(&state).expect("canonical state");
        let execution_dir = state.join("execution-failing");
        let overlay = execution_dir.join("rootfs-overlay");
        std::fs::create_dir_all(overlay.join("upper")).expect("upper");
        std::fs::create_dir_all(overlay.join("work")).expect("work");
        // A symlinked owned path fails closed. Point it at a path that is
        // still inside the execution directory so the symlink rule, not the
        // authorization rule, is the failing boundary.
        std::fs::remove_dir(overlay.join("upper")).expect("remove upper");
        std::os::unix::fs::symlink(overlay.join("work"), overlay.join("upper"))
            .expect("symlink upper");
        let record: ExecutionRecord = serde_json::from_value(serde_json::json!({
            "execution_id": "execution-failing",
            "session_name": "sandbox-test",
            "instance_id": "instance-test",
            "backend": "test",
            "policy_digest": "digest",
            "created_at": 0,
            "transient_rootfs": {
                "mountpoint": overlay.join("merged"),
                "upper": overlay.join("upper"),
                "work": overlay.join("work"),
            },
            "execution_dir": execution_dir,
            "restricted_network": false,
            "agent_pid": std::process::id(),
        }))
        .expect("record fixture");
        runtime.executions.lock().expect("executions").insert(
            "pane-failing".to_string(),
            TrackedExecution::Recovered(Box::new(record)),
        );

        let error = match runtime.cleanup_entry("pane-failing") {
            Ok(_) => panic!("a symlinked owned path must fail the cleanup"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("symlinked"), "{error:#}");
        assert!(
            runtime
                .executions
                .lock()
                .expect("executions")
                .contains_key("pane-failing"),
            "a failed cleanup must keep the tracked identity for retry"
        );

        // A second explicit attempt fails again: every failure keeps the
        // identity rather than dropping it after the first error.
        let error = match runtime.cleanup_entry("pane-failing") {
            Ok(_) => panic!("the second cleanup must fail"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("symlinked"), "{error:#}");
        assert!(
            runtime
                .executions
                .lock()
                .expect("executions")
                .contains_key("pane-failing"),
            "the second failure must keep the tracked identity too"
        );

        // Explicit retries bypass the backoff; once the owned path is a real
        // directory the cleanup succeeds and the identity is released.
        std::fs::remove_file(overlay.join("upper")).expect("remove symlink");
        std::fs::create_dir_all(overlay.join("upper")).expect("restore upper");
        let report = match runtime.cleanup_entry("pane-failing") {
            Ok(report) => report.expect("the record was still tracked"),
            Err(error) => panic!("the retry must succeed: {error:#}"),
        };
        assert_eq!(report.execution_id, "execution-failing");
        assert!(
            !runtime
                .executions
                .lock()
                .expect("executions")
                .contains_key("pane-failing"),
            "a successful cleanup releases the tracked identity"
        );
    }

    /// A failed cleanup keeps a CleanupPending identity and schedules its next
    /// reaper attempt on a bounded exponential backoff.
    #[test]
    fn a_failed_cleanup_keeps_a_pending_identity_with_bounded_backoff() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let fixture = || -> ExecutionRecord {
            serde_json::from_value(serde_json::json!({
                "execution_id": "execution-backoff",
                "session_name": "sandbox-test",
                "instance_id": "instance-test",
                "backend": "test",
                "policy_digest": "digest",
                "created_at": 0,
                "execution_dir": dir.path().join("state").join("execution-backoff"),
                "restricted_network": false,
                "agent_pid": std::process::id(),
            }))
            .expect("record fixture")
        };

        let first = runtime.retain_for_retry(
            "pane-backoff",
            fixture(),
            0,
            anyhow::anyhow!("first cleanup failure"),
        );
        assert!(format!("{first:#}").contains("first cleanup failure"));
        let now = Instant::now();
        {
            let executions = runtime.executions.lock().expect("executions");
            let entry = executions.get("pane-backoff").expect("still tracked");
            assert!(
                !entry.retry_due(now),
                "the reaper must wait for the bounded backoff"
            );
            assert!(
                entry.retry_due(now + CLEANUP_RETRY_MAX),
                "the retry delay is bounded"
            );
            match entry {
                TrackedExecution::CleanupPending { attempts, .. } => {
                    assert_eq!(*attempts, 1, "the first failure records one attempt")
                }
                _ => panic!("a failed cleanup must keep a CleanupPending identity"),
            }
        }

        let _ = runtime.retain_for_retry(
            "pane-backoff",
            fixture(),
            1,
            anyhow::anyhow!("second cleanup failure"),
        );
        match runtime
            .executions
            .lock()
            .expect("executions")
            .get("pane-backoff")
        {
            Some(TrackedExecution::CleanupPending { attempts, .. }) => {
                assert_eq!(*attempts, 2, "each failed attempt increments the count")
            }
            other => panic!(
                "the identity must stay tracked as CleanupPending: present={}",
                other.is_some()
            ),
        }
        assert_eq!(cleanup_retry_delay(1), CLEANUP_RETRY_BASE);
        assert_eq!(
            cleanup_retry_delay(2),
            CLEANUP_RETRY_BASE * 2,
            "the delay grows exponentially"
        );
        assert_eq!(
            cleanup_retry_delay(100),
            CLEANUP_RETRY_MAX,
            "the delay is capped"
        );
    }

    /// A startup cleanup failure hands the record to the reaper instead of
    /// logging it without a retry owner.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_failed_startup_reconciliation_is_tracked_for_retry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = SandboxRuntime::new(settings(dir.path()));
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).expect("state dir");
        let state = std::fs::canonicalize(&state).expect("canonical state");
        let execution_dir = state.join("execution-reconcile");
        let overlay = execution_dir.join("rootfs-overlay");
        std::fs::create_dir_all(overlay.join("work")).expect("work");
        std::os::unix::fs::symlink(overlay.join("work"), overlay.join("upper"))
            .expect("symlink upper");
        let record: ExecutionRecord = serde_json::from_value(serde_json::json!({
            "execution_id": "execution-reconcile",
            "session_name": "sandbox-gone",
            "instance_id": "instance-test",
            "backend": "test",
            "policy_digest": "digest",
            "created_at": 0,
            "transient_rootfs": {
                "mountpoint": overlay.join("merged"),
                "upper": overlay.join("upper"),
                "work": overlay.join("work"),
            },
            "execution_dir": execution_dir,
            "restricted_network": false,
            "agent_pid": std::process::id(),
        }))
        .expect("record fixture");
        std::fs::write(
            state.join("execution-reconcile.json"),
            serde_json::to_vec(&record).expect("record bytes"),
        )
        .expect("persist the record");

        runtime.reconcile(&[]).expect("reconcile");

        {
            let executions = runtime.executions.lock().expect("executions");
            match executions.values().next() {
                Some(TrackedExecution::CleanupPending {
                    record, attempts, ..
                }) => {
                    assert_eq!(record.execution_id, "execution-reconcile");
                    assert_eq!(*attempts, 1, "the first startup failure is tracked");
                }
                _ => panic!("a failed startup cleanup must be tracked for retry"),
            }
        }

        // The recorded failure is retried through the same tracked identity.
        std::fs::remove_file(overlay.join("upper")).expect("remove symlink");
        std::fs::create_dir_all(overlay.join("upper")).expect("restore upper");
        let key = runtime
            .executions
            .lock()
            .expect("executions")
            .keys()
            .next()
            .cloned()
            .expect("a tracked key");
        let report = match runtime.cleanup_entry(&key) {
            Ok(report) => report.expect("the record was tracked"),
            Err(error) => panic!("the retry must succeed: {error:#}"),
        };
        assert_eq!(report.execution_id, "execution-reconcile");
        assert!(runtime.executions.lock().expect("executions").is_empty());
    }
}
