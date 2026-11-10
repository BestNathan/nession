//! Preparation, launch verification, owned-resource cleanup and restart
//! reconciliation.
//!
//! `prepare` is the only function that creates host resources, and it creates
//! only resources this execution owns: its cgroup child, its channel socket,
//! its profile file and its record. `PreparedSandbox::verify` releases the
//! launch barrier only after the reported facts agree with the host's own
//! observation. `SandboxExecutionHandle::cleanup` releases exactly those owned
//! resources; reconciliation does the same for records left by a previous
//! Agent process without touching unrelated processes, cgroups or the shared
//! tmux server.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nession_protocol::contracts::sandbox::v1::{SandboxExecutionReport, SandboxPolicy};
use serde::{Deserialize, Serialize};

use crate::capabilities;
use crate::error::{Result, SandboxError};
use crate::policy::{compile, requested_mechanisms, CompiledSandboxPolicy};
use crate::settings::SandboxSettings;
use crate::util::write_atomic;

/// Everything the Agent knows at create time that the sandbox needs.
///
/// Owned so the Agent can move it onto a blocking task: probing spawns
/// bounded processes and must not run on an async worker.
#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub policy: SandboxPolicy,
    pub session_name: String,
    /// The Session's durable instance id (`@nession_instance_id`).
    pub instance_id: String,
    /// The Session's initial working directory. It must exist and be visible.
    pub working_dir: String,
    /// The shell/adapter argv to run inside the sandbox.
    pub inner_command: Vec<String>,
    /// The private tmux socket to hide from the sandbox.
    pub tmux_socket: Option<PathBuf>,
}

/// One live execution record, durable across Agent restarts.
///
/// `pane_id`/`window_id` bind the record to the tmux Pane it actually owns
/// (#3124). A record without them predates per-Pane tracking; reconciliation
/// falls back to Session liveness for those.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecord {
    pub execution_id: String,
    pub session_name: String,
    pub instance_id: String,
    pub backend: String,
    pub policy_digest: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// The Pane's initial working directory, for the observed context.
    #[serde(default)]
    pub working_dir: String,
    /// The Agent-observed normalized policy. A digest cannot reconstruct the
    /// settings after an Agent restart; the snapshot can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_policy: Option<SandboxPolicy>,
    /// The short, Agent-owned directory holding this execution's channel
    /// socket. It is outside `state_dir` because `SUN_LEN` bounds the socket
    /// path; cleanup removes only a direct child of `runtime_root`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_dir: Option<String>,
    /// Host mountpoints of prepared EROFS images owned by this execution.
    /// Reconciliation unmounts only paths beneath `execution_dir`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mounts: Vec<String>,
    /// The verified-mechanism names the execution reported.
    #[serde(default)]
    pub mechanisms: Vec<String>,
    /// Non-fatal backend notes, kept for the inside view after a restart.
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_endpoint: Option<String>,
    /// The Native Pane this execution was entered from, if any. Present only
    /// for an existing-Session Enter; the create-time execution has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cgroup_path: Option<String>,
    pub execution_dir: String,
    pub restricted_network: bool,
    /// The Agent process that created the record; diagnostics only.
    pub agent_pid: u32,
}

impl ExecutionRecord {
    fn record_path(&self, settings: &SandboxSettings) -> PathBuf {
        settings
            .state_dir
            .join(format!("{}.json", self.execution_id))
    }
}

/// Outcomes of startup reconciliation.
#[derive(Debug)]
pub enum ReconcileOutcome {
    /// The tmux Session still exists; the Agent should re-arm its reaper.
    Active(Box<ExecutionRecord>),
    /// Its Session is gone; the owned resources were removed.
    Cleaned(String),
    /// Cleanup failed and the record was kept for a later attempt.
    Failed(String, String),
}

/// What cleanup actually removed and observed.
#[derive(Debug, Default)]
pub struct CleanupReport {
    pub execution_id: String,
    pub evidence: Vec<(String, String)>,
    pub removed: bool,
}

impl CleanupReport {
    /// The evidence rows as `key=value` text, for an acceptance receipt.
    pub fn evidence_lines(&self) -> Vec<String> {
        self.evidence
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect()
    }
}

/// Kernel-visible controls the Agent observed at release time.
#[derive(Debug, Clone, Default)]
pub struct VerifiedControls {
    /// `/proc/self/ns/*` link targets reported from inside the sandbox.
    pub namespaces: BTreeMap<String, String>,
    /// The execution cgroup entry, when one was requested.
    pub cgroup: Option<String>,
    /// `Seccomp:` mode from `/proc/self/status`.
    pub seccomp: Option<String>,
    /// `NoNewPrivs:` from `/proc/self/status`.
    pub no_new_privs: Option<String>,
    /// How many filesystem probes the bridge confirmed.
    pub filesystem_probes: usize,
}

/// A prepared but not yet verified launch.
pub struct PreparedSandbox {
    pub compiled: CompiledSandboxPolicy,
    pub report: SandboxExecutionReport,
    command: Vec<String>,
    extra_env: Vec<(String, String)>,
    settings: SandboxSettings,
    record: ExecutionRecord,
    verified: Option<VerifiedControls>,
    armed: bool,
    #[cfg(target_os = "linux")]
    linux: Option<crate::linux::PreparedLinux>,
    #[cfg(target_os = "macos")]
    macos: Option<crate::macos::PreparedMacos>,
}

impl PreparedSandbox {
    #[cfg(target_os = "linux")]
    pub(crate) fn new(
        compiled: CompiledSandboxPolicy,
        report: SandboxExecutionReport,
        command: Vec<String>,
        extra_env: Vec<(String, String)>,
        settings: SandboxSettings,
        record: ExecutionRecord,
        linux: Option<crate::linux::PreparedLinux>,
    ) -> Self {
        Self {
            compiled,
            report,
            command,
            extra_env,
            settings,
            record,
            verified: None,
            armed: true,
            linux,
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn new(
        compiled: CompiledSandboxPolicy,
        report: SandboxExecutionReport,
        command: Vec<String>,
        extra_env: Vec<(String, String)>,
        settings: SandboxSettings,
        record: ExecutionRecord,
        macos: Option<crate::macos::PreparedMacos>,
    ) -> Self {
        Self {
            compiled,
            report,
            command,
            extra_env,
            settings,
            record,
            verified: None,
            armed: true,
            macos,
        }
    }

    /// The trusted launcher argv for `tmux new-session`.
    pub fn command(&self) -> &[String] {
        &self.command
    }

    /// Extra Session environment delivered by the create.
    pub fn env(&self) -> &[(String, String)] {
        &self.extra_env
    }

    /// The verified execution report carried by the create response.
    pub fn report(&self) -> &SandboxExecutionReport {
        &self.report
    }

    /// The record, for diagnostics.
    pub fn record(&self) -> &ExecutionRecord {
        &self.record
    }

    /// Bind the execution to the tmux Pane that runs its launcher (#3124).
    ///
    /// Called between `new-window`/`new-session` and [`Self::verify`], so the
    /// durable record written at verification names the Pane it owns.
    pub fn set_pane_identity(&mut self, pane_id: Option<&str>, window_id: Option<&str>) {
        self.record.pane_id = pane_id.map(str::to_string);
        self.record.window_id = window_id.map(str::to_string);
    }

    /// Record the Native Pane this execution was entered from.
    pub fn set_native_pane(&mut self, window_id: &str, pane_id: &str) {
        self.record.native_window_id = Some(window_id.to_string());
        self.record.native_pane_id = Some(pane_id.to_string());
    }

    /// What the launch barrier observed, once verification succeeded.
    pub fn verified_controls(&self) -> Option<&VerifiedControls> {
        self.verified.as_ref()
    }

    /// Verify the installed controls and release the launch barrier.
    ///
    /// On failure the caller must kill the Session and call
    /// [`Self::abort`]; user code has not run because the bridge is still
    /// waiting for `GO`.
    pub fn verify(&mut self, pane_pid: u32) -> Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(linux) = self.linux.as_mut() {
            self.verified = Some(crate::linux::verify_launch(
                linux,
                pane_pid,
                &self.settings,
            )?);
        }
        #[cfg(target_os = "macos")]
        if let Some(macos) = self.macos.as_mut() {
            self.verified = Some(crate::macos::verify_launch(
                macos,
                pane_pid,
                &self.settings,
            )?);
        }
        self.record.pane_pid = Some(pane_pid);
        write_record(&self.settings, &self.record)?;
        Ok(())
    }

    /// Remove every resource prepared for a launch that will not verify.
    pub fn abort(mut self) -> Result<CleanupReport> {
        self.armed = false;
        self.cleanup_in_place()
    }

    /// Convert a verified launch into its lifecycle handle.
    pub fn into_handle(mut self) -> SandboxExecutionHandle {
        self.armed = false;
        SandboxExecutionHandle {
            settings: self.settings.clone(),
            record: self.record.clone(),
            #[cfg(target_os = "linux")]
            linux: self.linux.take(),
            #[cfg(target_os = "macos")]
            macos: self.macos.take(),
        }
    }

    fn cleanup_in_place(&mut self) -> Result<CleanupReport> {
        let mut report = CleanupReport {
            execution_id: self.record.execution_id.clone(),
            ..CleanupReport::default()
        };
        #[cfg(target_os = "linux")]
        if let Some(linux) = self.linux.take() {
            crate::linux::cleanup_prepared(linux, &self.settings, &self.record, &mut report)?;
            return Ok(report);
        }
        #[cfg(target_os = "macos")]
        if let Some(macos) = self.macos.take() {
            crate::macos::cleanup_prepared(macos, &self.settings, &self.record, &mut report)?;
            return Ok(report);
        }
        remove_owned_paths(&self.settings, &self.record, &mut report)?;
        Ok(report)
    }
}

impl Drop for PreparedSandbox {
    /// A prepared launch that was dropped before it became a verified handle
    /// never got user code past the barrier. Releasing its owned resources here
    /// closes the create-deadline window in which the async future can be
    /// dropped after preparation succeeded.
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        if let Err(error) = self.cleanup_in_place() {
            tracing::warn!("could not release a prepared Sandbox that was never verified: {error}");
        }
    }
}

/// Lifecycle owner for one verified execution.
///
/// Dropping the handle does **not** clean resources: a Pane must survive
/// browser detach, WebSocket reconnect and an Agent restart. Cleanup happens
/// when the tmux Session disappears or reconciliation proves it is gone.
pub struct SandboxExecutionHandle {
    settings: SandboxSettings,
    record: ExecutionRecord,
    #[cfg(target_os = "linux")]
    linux: Option<crate::linux::PreparedLinux>,
    #[cfg(target_os = "macos")]
    macos: Option<crate::macos::PreparedMacos>,
}

impl SandboxExecutionHandle {
    pub fn execution_id(&self) -> &str {
        &self.record.execution_id
    }

    pub fn session_name(&self) -> &str {
        &self.record.session_name
    }

    pub fn record(&self) -> &ExecutionRecord {
        &self.record
    }

    /// Release the resources this execution owns.
    pub fn cleanup(mut self) -> Result<CleanupReport> {
        let mut report = CleanupReport {
            execution_id: self.record.execution_id.clone(),
            ..CleanupReport::default()
        };
        #[cfg(target_os = "linux")]
        if let Some(mut linux) = self.linux.take() {
            crate::linux::cleanup_verified(&mut linux, &self.settings, &self.record, &mut report)?;
            return Ok(report);
        }
        #[cfg(target_os = "macos")]
        if let Some(macos) = self.macos.take() {
            crate::macos::cleanup_verified(macos, &self.settings, &self.record, &mut report)?;
            return Ok(report);
        }
        remove_owned_paths(&self.settings, &self.record, &mut report)?;
        Ok(report)
    }
}

/// Compile the policy and prepare platform-owned resources.
///
/// A disabled policy is refused here: the Agent treats an absent or disabled
/// policy as Native and never calls `prepare` for it, so receiving one here is
/// a caller error rather than a silent fallback.
pub fn prepare(request: &LaunchRequest, settings: &SandboxSettings) -> Result<PreparedSandbox> {
    let compiled = compile(&request.policy)?;
    if !request.policy.enabled {
        return Err(SandboxError::InvalidPolicy(
            "a disabled Sandbox policy must not be prepared for a Session".to_string(),
        ));
    }
    if !settings.state_dir.is_absolute() {
        return Err(SandboxError::Prepare(
            "the sandbox state directory must be absolute".to_string(),
        ));
    }

    let working_dir = validate_working_dir(&request.working_dir, compiled.filesystem.as_ref())?;

    #[cfg(target_os = "linux")]
    {
        crate::linux::prepare(request, &compiled, settings, &working_dir)
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::prepare(request, &compiled, settings, &working_dir)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (request, &compiled, settings, &working_dir);
        Err(SandboxError::UnsupportedPolicy(
            "no Sandbox backend exists for this platform".to_string(),
        ))
    }
}

/// What a no-side-effect preflight measured.
#[derive(Debug, Clone)]
pub struct PreflightReport {
    pub compiled: CompiledSandboxPolicy,
    pub capabilities: capabilities::Capabilities,
    pub warnings: Vec<String>,
}

/// Validate a would-be launch without creating any host resource (#3124).
///
/// This is `prepare`'s validation prefix — compile, working-directory and
/// host-path checks, host capability validation — with every resource-creating
/// step removed. Preflight is a hint to the caller, not a reservation: Enter
/// re-runs the whole `prepare` path and fails closed on its own.
pub fn preflight(request: &LaunchRequest, settings: &SandboxSettings) -> Result<PreflightReport> {
    let compiled = compile(&request.policy)?;
    if !request.policy.enabled {
        return Err(SandboxError::InvalidPolicy(
            "a disabled Sandbox policy must not be preflighted for an Enter".to_string(),
        ));
    }
    if !settings.state_dir.is_absolute() {
        return Err(SandboxError::Prepare(
            "the sandbox state directory must be absolute".to_string(),
        ));
    }
    let working_dir = validate_working_dir(&request.working_dir, compiled.filesystem.as_ref())?;
    let capabilities = probe(settings);
    let field_errors = crate::capabilities::unsupported_requests(&request.policy, &capabilities);
    if !field_errors.is_empty() {
        return Err(SandboxError::UnsupportedRequests(field_errors));
    }
    crate::capabilities::validate(&compiled, &capabilities)?;
    let mut warnings = capabilities.detail.clone();
    if let Some(filesystem) = &compiled.filesystem {
        warnings.extend(validate_host_paths(filesystem, settings)?);
    }
    let _ = working_dir;
    Ok(PreflightReport {
        compiled,
        capabilities,
        warnings,
    })
}

/// Resolve and validate the initial cwd. It must exist, be a directory and be
/// visible under an explicit filesystem policy.
pub(crate) fn validate_working_dir(
    working_dir: &str,
    filesystem: Option<&crate::policy::CompiledFilesystem>,
) -> Result<PathBuf> {
    let path = Path::new(working_dir);
    if !path.is_absolute() {
        return Err(SandboxError::InvalidPolicy(
            "the Session working directory must be absolute".to_string(),
        ));
    }
    if filesystem.is_some_and(|filesystem| filesystem.composition.is_some()) {
        // The composed root does not exist on the host; `/workspace` is the
        // only writable working tree and Bubblewrap creates/chdirs into it.
        let workspace = Path::new("/workspace");
        if path != workspace && !path.starts_with(workspace) {
            return Err(SandboxError::InvalidPolicy(format!(
                "the composition working directory {} must be /workspace or below",
                path.display()
            )));
        }
        return Ok(path.to_path_buf());
    }
    let metadata = std::fs::metadata(path).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "the Session working directory {} does not exist: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(SandboxError::InvalidPolicy(format!(
            "the Session working directory {} is not a directory",
            path.display()
        )));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "the Session working directory {} cannot be resolved: {error}",
            path.display()
        ))
    })?;
    if let Some(filesystem) = filesystem {
        if !filesystem.is_visible(&canonical) {
            return Err(SandboxError::InvalidPolicy(format!(
                "working directory {} is not visible under filesystem.access",
                canonical.display()
            )));
        }
    }
    Ok(canonical)
}

/// Validate an explicit filesystem policy against the host.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn validate_host_paths(
    filesystem: &crate::policy::CompiledFilesystem,
    settings: &SandboxSettings,
) -> Result<Vec<String>> {
    if let Some(composition) = &filesystem.composition {
        return validate_composition_paths(composition, settings);
    }
    let mut warnings = Vec::new();
    for path in filesystem.visible() {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            SandboxError::InvalidPolicy(format!(
                "filesystem path {} does not exist: {error}",
                path.display()
            ))
        })?;
        if metadata.file_type().is_symlink() {
            let canonical = std::fs::canonicalize(path).map_err(|error| {
                SandboxError::InvalidPolicy(format!(
                    "filesystem path {} cannot be resolved: {error}",
                    path.display()
                ))
            })?;
            if canonical != path {
                return Err(SandboxError::InvalidPolicy(format!(
                    "filesystem path {} is a symlink to {}; name the canonical path",
                    path.display(),
                    canonical.display()
                )));
            }
            warnings.push(format!(
                "{} is a symlink to itself after resolution",
                path.display()
            ));
        }
    }
    Ok(warnings)
}

/// Validate composition host paths without mounting or hashing the images.
fn validate_composition_paths(
    composition: &crate::policy::CompiledComposition,
    settings: &SandboxSettings,
) -> Result<Vec<String>> {
    let root = settings.erofs_image_root.as_ref().ok_or_else(|| {
        SandboxError::UnsupportedPolicy(
            "filesystem.composition requires an Agent-authorized EROFS image root".to_string(),
        )
    })?;
    if !root.is_absolute() || !root.is_dir() {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image root {} is not an absolute directory",
            root.display()
        )));
    }
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut images = vec![&composition.base];
    if let Some(workspace) = &composition.workspace {
        if let Some(image) = &workspace.image {
            images.push(image);
        }
    }
    images.extend(composition.toolchains.iter());
    for image in images {
        let metadata = std::fs::symlink_metadata(&image.source).map_err(|error| {
            SandboxError::InvalidPolicy(format!(
                "EROFS image {} does not exist: {error}",
                image.source.display()
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SandboxError::InvalidPolicy(format!(
                "EROFS image {} must be a regular file, not a symlink",
                image.source.display()
            )));
        }
        let canonical =
            std::fs::canonicalize(&image.source).unwrap_or_else(|_| image.source.clone());
        if !canonical.starts_with(&canonical_root) {
            return Err(SandboxError::InvalidPolicy(format!(
                "EROFS image {} is outside the Agent-authorized image root {}",
                canonical.display(),
                canonical_root.display()
            )));
        }
    }
    if let Some(workspace) = &composition.workspace {
        let metadata = std::fs::symlink_metadata(&workspace.write).map_err(|error| {
            SandboxError::InvalidPolicy(format!(
                "workspace write directory {} does not exist: {error}",
                workspace.write.display()
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(SandboxError::InvalidPolicy(format!(
                "workspace write directory {} must be a real directory",
                workspace.write.display()
            )));
        }
        let canonical_write =
            std::fs::canonicalize(&workspace.write).unwrap_or_else(|_| workspace.write.clone());
        let canonical_state = std::fs::canonicalize(&settings.state_dir)
            .unwrap_or_else(|_| settings.state_dir.clone());
        if !canonical_write.starts_with(&canonical_state) {
            return Err(SandboxError::InvalidPolicy(format!(
                "workspace write directory {} is outside the Agent sandbox state directory",
                canonical_write.display()
            )));
        }
    }
    Ok(Vec::new())
}

/// Build the report shared by both backends.
pub(crate) fn build_report(
    compiled: &CompiledSandboxPolicy,
    execution_id: &str,
    backend: &str,
    cgroup_path: Option<&Path>,
    proxy_endpoint: Option<String>,
    warnings: Vec<String>,
) -> SandboxExecutionReport {
    let mut mechanisms = requested_mechanisms(compiled);
    if backend == "linux-bwrap" {
        // The Linux backend always creates the baseline namespaces; macOS
        // Seatbelt does not, so the report must not claim them there.
        mechanisms.push("backend.baseline_namespaces".to_string());
    }
    SandboxExecutionReport {
        execution_id: execution_id.to_string(),
        backend: backend.to_string(),
        policy_digest: compiled.digest.clone(),
        mechanisms,
        cgroup_path: cgroup_path.map(|path| path.display().to_string()),
        proxy_endpoint,
        warnings,
    }
}

/// Build the extra environment the Session create delivers.
pub(crate) fn sandbox_environment(
    record: &ExecutionRecord,
    backend: &str,
    digest: &str,
) -> Vec<(String, String)> {
    vec![
        (
            "NESSON_SANDBOX_EXECUTION_ID".to_string(),
            record.execution_id.clone(),
        ),
        ("NESSON_SANDBOX_BACKEND".to_string(), backend.to_string()),
        (
            "NESSON_SANDBOX_POLICY_DIGEST".to_string(),
            digest.to_string(),
        ),
    ]
}

/// Create the execution directory with owner-only permissions.
pub(crate) fn create_execution_dir(
    settings: &SandboxSettings,
    execution_id: &str,
) -> Result<PathBuf> {
    let dir = settings.state_dir.join(execution_id);
    std::fs::create_dir_all(&dir)
        .map_err(|error| SandboxError::Prepare(format!("create {}: {error}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Persist a record atomically with owner-only permissions.
pub(crate) fn write_record(settings: &SandboxSettings, record: &ExecutionRecord) -> Result<()> {
    std::fs::create_dir_all(&settings.state_dir).map_err(|error| {
        SandboxError::Prepare(format!(
            "create sandbox state directory {}: {error}",
            settings.state_dir.display()
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ =
            std::fs::set_permissions(&settings.state_dir, std::fs::Permissions::from_mode(0o700));
    }
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| SandboxError::Prepare(format!("serialize execution record: {error}")))?;
    write_atomic(&record.record_path(settings), &bytes).map_err(|error| {
        SandboxError::Prepare(format!(
            "write execution record {}: {error}",
            record.record_path(settings).display()
        ))
    })
}

/// Remove the record and the execution directory.
pub(crate) fn remove_owned_paths(
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut CleanupReport,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    crate::linux::erofs::unmount_recorded(
        &record.mounts,
        Path::new(&record.execution_dir),
        &settings.fusermount_path,
        report,
    );
    let execution_dir = Path::new(&record.execution_dir);
    let state_dir =
        std::fs::canonicalize(&settings.state_dir).unwrap_or_else(|_| settings.state_dir.clone());
    let safe_dir = std::fs::canonicalize(execution_dir)
        .map(|dir| dir.starts_with(&state_dir))
        .unwrap_or_else(|_| execution_dir.starts_with(&settings.state_dir));
    if safe_dir {
        let _ = std::fs::remove_dir_all(execution_dir);
    }
    // The channel directory lives under the short runtime root, not the state
    // dir. Remove only the directory whose name is this execution's id and
    // whose parent is the configured root; an unknown path is left untouched.
    if let Some(channel_dir) = record.channel_dir.as_deref() {
        let channel_dir = Path::new(channel_dir);
        let root = std::fs::canonicalize(&settings.runtime_root)
            .unwrap_or_else(|_| settings.runtime_root.clone());
        let canonical =
            std::fs::canonicalize(channel_dir).unwrap_or_else(|_| channel_dir.to_path_buf());
        let owned_name = channel_dir
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == record.execution_id)
            .unwrap_or(false);
        if owned_name && canonical.parent() == Some(root.as_path()) {
            let _ = std::fs::remove_dir_all(channel_dir);
        }
    }
    let record_path = record.record_path(settings);
    let _ = std::fs::remove_file(&record_path);
    report.removed = true;
    Ok(())
}

/// The current wall-clock second, for the record.
pub(crate) fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// One live Pane, as a successful tmux listing reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivePane {
    pub session_name: String,
    pub pane_id: String,
}

/// Read records and reconcile them against the live tmux Pane set.
///
/// The caller must pass a **successfully listed** Pane set. Treating a failed
/// tmux query as "no Panes" would clean live executions, so the caller owns
/// that proof; this function never queries tmux.
///
/// A record with a Pane identity is alive only while *that Pane* exists: a
/// removed Window with the same Session name is not a live execution (#3124).
/// A legacy record (no Pane identity) falls back to Session liveness.
pub fn reconcile(
    settings: &SandboxSettings,
    live_panes: &[LivePane],
) -> Result<Vec<ReconcileOutcome>> {
    let entries = match std::fs::read_dir(&settings.state_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(SandboxError::Prepare(format!(
                "read sandbox state directory {}: {error}",
                settings.state_dir.display()
            )));
        }
    };

    let mut outcomes = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                outcomes.push(ReconcileOutcome::Failed(
                    "<unreadable-entry>".to_string(),
                    error.to_string(),
                ));
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let record: ExecutionRecord = match std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(record) => record,
            None => {
                // An unreadable record is left in place: deleting it would
                // discard the only pointer to resources we may own.
                outcomes.push(ReconcileOutcome::Failed(
                    path.file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("<unknown>")
                        .to_string(),
                    format!("unreadable execution record {}", path.display()),
                ));
                continue;
            }
        };
        let alive = match &record.pane_id {
            Some(pane_id) => live_panes
                .iter()
                .any(|pane| pane.session_name == record.session_name && &pane.pane_id == pane_id),
            None => live_panes
                .iter()
                .any(|pane| pane.session_name == record.session_name),
        };
        if alive {
            outcomes.push(ReconcileOutcome::Active(Box::new(record)));
            continue;
        }
        let mut report = CleanupReport {
            execution_id: record.execution_id.clone(),
            ..CleanupReport::default()
        };
        match cleanup_record(settings, &record, &mut report) {
            Ok(()) => outcomes.push(ReconcileOutcome::Cleaned(record.execution_id)),
            Err(error) => outcomes.push(ReconcileOutcome::Failed(
                record.execution_id,
                error.to_string(),
            )),
        }
    }
    Ok(outcomes)
}

/// Remove the owned resources described by a durable record.
pub fn cleanup_record(
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut CleanupReport,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    if let Some(cgroup_path) = &record.cgroup_path {
        let root = settings
            .resolved_cgroup_root()
            .ok_or_else(|| SandboxError::Cleanup("no cgroup root on this host".to_string()))?;
        crate::linux::cgroup::remove_execution(&root, Path::new(cgroup_path))?;
    }
    remove_owned_paths(settings, record, report)
}

/// Probe the host without preparing an execution.
pub fn probe(settings: &SandboxSettings) -> capabilities::Capabilities {
    capabilities::probe(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &Path) -> SandboxSettings {
        let mut settings = SandboxSettings::new(
            dir.join("state"),
            dir.join("bridge"),
            PathBuf::from("bwrap"),
            PathBuf::from("/usr/bin/sandbox-exec"),
        );
        settings.runtime_root = dir.join("runtime");
        settings
    }

    fn record(dir: &Path, id: &str, session: &str) -> ExecutionRecord {
        ExecutionRecord {
            execution_id: id.to_string(),
            session_name: session.to_string(),
            instance_id: "instance".to_string(),
            backend: "test".to_string(),
            policy_digest: "digest".to_string(),
            created_at: 0,
            pane_pid: None,
            pane_id: None,
            window_id: None,
            working_dir: String::new(),
            effective_policy: None,
            mounts: Vec::new(),
            channel_dir: None,
            mechanisms: Vec::new(),
            warnings: Vec::new(),
            proxy_endpoint: None,
            native_window_id: None,
            native_pane_id: None,
            cgroup_path: None,
            execution_dir: dir.join("state").join(id).display().to_string(),
            restricted_network: false,
            agent_pid: std::process::id(),
        }
    }

    #[test]
    fn reconciliation_keeps_live_sessions_and_cleans_dead_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = settings(dir.path());
        let live = record(dir.path(), "live", "session-live");
        let dead = record(dir.path(), "dead", "session-dead");
        for record in [&live, &dead] {
            std::fs::create_dir_all(&record.execution_dir).expect("execution dir");
            write_record(&settings, record).expect("record");
        }
        let outcomes = reconcile(
            &settings,
            &[LivePane {
                session_name: "session-live".to_string(),
                pane_id: "%1".to_string(),
            }],
        )
        .expect("reconcile");
        assert!(outcomes.iter().any(|outcome| matches!(outcome, ReconcileOutcome::Active(record) if record.execution_id == "live")));
        assert!(outcomes
            .iter()
            .any(|outcome| matches!(outcome, ReconcileOutcome::Cleaned(id) if id == "dead")));
        assert!(std::path::Path::new(&live.execution_dir).exists());
        assert!(!std::path::Path::new(&dead.execution_dir).exists());
        assert!(!dead.record_path(&settings).exists());
    }

    #[test]
    fn a_record_whose_pane_is_gone_is_cleaned_even_when_the_session_lives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = settings(dir.path());
        let mut record = record(dir.path(), "pane-gone", "session");
        record.pane_id = Some("%9".to_string());
        record.window_id = Some("@9".to_string());
        std::fs::create_dir_all(&record.execution_dir).expect("execution dir");
        write_record(&settings, &record).expect("record");
        let outcomes = reconcile(
            &settings,
            &[LivePane {
                session_name: "session".to_string(),
                // Same Session name, different Pane: the removed Window's
                // execution must not be claimed as live.
                pane_id: "%1".to_string(),
            }],
        )
        .expect("reconcile");
        assert!(outcomes
            .iter()
            .any(|outcome| matches!(outcome, ReconcileOutcome::Cleaned(id) if id == "pane-gone")));
        assert!(!record.record_path(&settings).exists());
    }

    #[test]
    fn a_channel_directory_under_the_runtime_root_is_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = settings(dir.path());
        let mut record = record(dir.path(), "channel", "session");
        let channel_dir = settings.runtime_root.join("channel");
        std::fs::create_dir_all(&channel_dir).expect("channel dir");
        std::fs::write(channel_dir.join("channel.sock"), b"").expect("socket file");
        record.channel_dir = Some(channel_dir.display().to_string());
        std::fs::create_dir_all(&record.execution_dir).expect("execution dir");
        write_record(&settings, &record).expect("record");
        let mut report = CleanupReport::default();
        cleanup_record(&settings, &record, &mut report).expect("cleanup");
        assert!(
            !channel_dir.exists(),
            "the owned channel directory is removed"
        );
        assert!(!record.record_path(&settings).exists());
    }

    #[test]
    fn a_channel_directory_outside_the_runtime_root_is_not_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = settings(dir.path());
        let mut record = record(dir.path(), "channel", "session");
        let foreign = dir.path().join("foreign");
        std::fs::create_dir_all(&foreign).expect("foreign dir");
        record.channel_dir = Some(foreign.display().to_string());
        std::fs::create_dir_all(&record.execution_dir).expect("execution dir");
        write_record(&settings, &record).expect("record");
        let mut report = CleanupReport::default();
        cleanup_record(&settings, &record, &mut report).expect("cleanup");
        assert!(
            foreign.exists(),
            "a path outside the runtime root is untouched"
        );
        assert!(!record.record_path(&settings).exists());
    }

    #[test]
    fn a_record_outside_the_state_directory_is_not_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = settings(dir.path());
        let mut evil = record(dir.path(), "evil", "gone");
        evil.execution_dir = "/tmp/not-owned".to_string();
        std::fs::create_dir_all(settings.state_dir.clone()).expect("state dir");
        write_record(&settings, &evil).expect("record");
        let mut report = CleanupReport::default();
        cleanup_record(&settings, &evil, &mut report).expect("cleanup");
        // The record is removed, but the unowned directory is not.
        assert!(!evil.record_path(&settings).exists());
    }
}
