//! Agent-owned Sandbox execution lifecycle (#2681).
//!
//! `nession-sandbox` owns policy compilation, the native backends and the
//! launch barrier. This module owns the Agent's side of the lifecycle: where
//! the host configuration comes from, which executions are currently tracked,
//! cleanup when a Pane disappears, and reconciliation after a restart.
//!
//! The tracker never treats a failed tmux listing as "no Sessions". A query
//! failure skips the pass; only a successful snapshot that lacks a tracked
//! name releases that execution's owned resources.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use nession_sandbox::{
    cleanup_record, prepare, probe, reconcile, Capabilities, CleanupReport, ExecutionRecord,
    LaunchRequest, PreparedSandbox, ReconcileOutcome, SandboxExecutionHandle, SandboxSettings,
};

use crate::tmux::ops::TmuxDep;

const REAPER_INTERVAL: Duration = Duration::from_millis(500);
const REAPER_IDLE_INTERVAL: Duration = Duration::from_secs(2);

/// One tracked execution.
enum TrackedExecution {
    /// A verified execution owned by this Agent process.
    Live(Box<SandboxExecutionHandle>),
    /// A record recovered at startup whose Session still exists. Its owned
    /// resources are released when the Session disappears.
    Recovered(ExecutionRecord),
}

/// The Agent's Sandbox runtime.
pub struct SandboxRuntime {
    settings: SandboxSettings,
    executions: Mutex<HashMap<String, TrackedExecution>>,
    reaper_started: AtomicBool,
    tmux: Mutex<Option<TmuxDep>>,
}

impl SandboxRuntime {
    /// Build the runtime from host-local settings.
    pub fn new(settings: SandboxSettings) -> Arc<Self> {
        Arc::new(Self {
            settings,
            executions: Mutex::new(HashMap::new()),
            reaper_started: AtomicBool::new(false),
            tmux: Mutex::new(None),
        })
    }

    /// Build the host settings from the Agent configuration.
    pub fn from_config(config: &crate::config::AgentConfig) -> Arc<Self> {
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
        if let Some(seconds) = config.sandbox.launch_timeout_secs {
            settings.launch_timeout = Duration::from_secs(seconds);
        }
        if let Some(agent_dir) = agent_dir {
            // Identity, env files and metadata live here. A sandbox must not
            // see them even when no filesystem policy was requested.
            settings.private_directories.push(agent_dir);
        }
        Self::new(settings)
    }

    /// The host settings, for diagnostics and tests.
    pub fn settings(&self) -> &SandboxSettings {
        &self.settings
    }

    /// Probe the host without creating an execution.
    pub fn capabilities(&self) -> Capabilities {
        probe(&self.settings)
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

    /// Track a verified execution.
    pub fn register(self: &Arc<Self>, session_name: &str, handle: SandboxExecutionHandle) {
        if let Ok(mut executions) = self.executions.lock() {
            executions.insert(
                session_name.to_string(),
                TrackedExecution::Live(Box::new(handle)),
            );
        }
        self.spawn_reaper();
    }

    /// Whether this Session has a tracked execution.
    pub fn is_tracked(&self, session_name: &str) -> bool {
        self.executions
            .lock()
            .map(|executions| executions.contains_key(session_name))
            .unwrap_or(false)
    }

    /// Release one Session's owned resources. Returns `None` when the Session
    /// was not tracked.
    pub fn cleanup_session(&self, session_name: &str) -> Result<Option<CleanupReport>> {
        let Some(entry) = self
            .executions
            .lock()
            .ok()
            .and_then(|mut executions| executions.remove(session_name))
        else {
            return Ok(None);
        };
        match entry {
            TrackedExecution::Live(handle) => {
                let record = handle.record().clone();
                match handle.cleanup() {
                    Ok(report) => Ok(Some(report)),
                    Err(error) => {
                        // Keep the record retryable: reconciliation and the
                        // reaper must not forget resources they still own.
                        if let Ok(mut executions) = self.executions.lock() {
                            executions.insert(
                                session_name.to_string(),
                                TrackedExecution::Recovered(record),
                            );
                        }
                        Err(error.into())
                    }
                }
            }
            TrackedExecution::Recovered(record) => {
                let mut report = CleanupReport {
                    execution_id: record.execution_id.clone(),
                    ..CleanupReport::default()
                };
                cleanup_record(&self.settings, &record, &mut report)
                    .map_err(anyhow::Error::from)?;
                Ok(Some(report))
            }
        }
    }

    /// Reconcile records left by a previous Agent process.
    pub fn reconcile(self: &Arc<Self>, live_sessions: &[String]) -> Result<()> {
        let outcomes = reconcile(&self.settings, live_sessions).map_err(anyhow::Error::from)?;
        if let Ok(mut executions) = self.executions.lock() {
            for outcome in outcomes {
                match outcome {
                    ReconcileOutcome::Active(record) => {
                        tracing::info!(
                            session = %record.session_name,
                            execution = %record.execution_id,
                            "recovered Sandbox execution for a live Session"
                        );
                        executions.insert(
                            record.session_name.clone(),
                            TrackedExecution::Recovered(record),
                        );
                    }
                    ReconcileOutcome::Cleaned(execution_id) => {
                        tracing::info!(%execution_id, "removed leftover Sandbox resources");
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
                match ops.list_sessions().await {
                    Ok(sessions) => {
                        let live: HashSet<String> =
                            sessions.into_iter().map(|session| session.name).collect();
                        let vanished: Vec<String> = runtime
                            .executions
                            .lock()
                            .map(|executions| {
                                executions
                                    .keys()
                                    .filter(|name| !live.contains(*name))
                                    .cloned()
                                    .collect()
                            })
                            .unwrap_or_default();
                        for name in vanished {
                            let runtime = Arc::clone(&runtime);
                            let cleanup =
                                tokio::task::spawn_blocking(move || runtime.cleanup_session(&name))
                                    .await;
                            match cleanup {
                                Ok(Ok(Some(report))) => tracing::info!(
                                    execution = %report.execution_id,
                                    "released Sandbox resources after its Session ended"
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
                    // A failed query is not "no Sessions". Skipping the pass
                    // is the only safe reading.
                    Err(error) => tracing::warn!(
                        "Sandbox reaper could not list Sessions; skipping this pass: {error:#}"
                    ),
                }
                tokio::time::sleep(REAPER_INTERVAL).await;
            }
        });
    }
}

/// Prepare, verify and register one sandboxed Session.
///
/// Runs on a blocking task: probes spawn bounded processes and the barrier
/// waits for the in-sandbox init. The tmux Session has already been created;
/// on any failure the caller kills it.
pub fn launch_and_verify(
    runtime: &Arc<SandboxRuntime>,
    prepared: PreparedSandbox,
    pane_pid: u32,
    session_name: &str,
) -> Result<nession_protocol::contracts::sandbox::v1::SandboxExecutionReport> {
    let mut prepared = prepared;
    if let Err(error) = prepared.verify(pane_pid) {
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
    runtime.register(session_name, handle);
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
}
