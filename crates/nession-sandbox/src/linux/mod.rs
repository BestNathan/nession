//! The Linux backend: Bubblewrap mounts/namespaces, delegated cgroup v2 and a
//! pinned seccomp profile, tied together by the trusted channel.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub mod bwrap;
pub mod cgroup;
pub mod channel;
pub mod seccomp;
pub mod verify;

use nession_protocol::contracts::sandbox::v1::SandboxNetworkMode;

use crate::capabilities::{Capabilities, CgroupSupport, NamespaceSupport, Platform};
use crate::error::{Result, SandboxError};
use crate::exec::{
    build_report, create_execution_dir, now_seconds, remove_owned_paths, sandbox_environment,
    write_record, ExecutionRecord, LaunchRequest, PreparedSandbox,
};
use crate::policy::CompiledSandboxPolicy;
use crate::settings::SandboxSettings;

/// Linux-owned resources for a prepared launch.
pub struct PreparedLinux {
    pub channel: Option<channel::Channel>,
    pub cgroup: Option<cgroup::ExecutionCgroup>,
    pub execution_dir: PathBuf,
    execution_id: String,
    visible_probes: Vec<PathBuf>,
    hidden_probes: Vec<PathBuf>,
    require_network_isolation: bool,
    require_cgroup_namespace: bool,
}

/// Probe Bubblewrap, namespace creation, delegated cgroups and seccomp.
pub fn probe(settings: &SandboxSettings) -> Capabilities {
    let mut detail = Vec::new();
    let bwrap_version = version_of(&settings.bubblewrap_path);
    let Some(bwrap_version) = bwrap_version else {
        return unavailable("bubblewrap is not executable on this host");
    };
    detail.push(format!("bubblewrap {bwrap_version}"));

    let Some(true_path) = ["/bin/true", "/usr/bin/true"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
    else {
        return unavailable("no /bin/true to probe the sandbox with");
    };

    let base_flags = [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
    ];
    if !bwrap_runs(settings, &base_flags, &true_path) {
        return unavailable("bubblewrap cannot create the baseline user/pid/ipc/uts namespaces");
    }
    detail.push("baseline namespaces: user,pid,ipc,uts,mount".to_string());

    let mut net_flags = base_flags.to_vec();
    net_flags.push("--unshare-net");
    let net = bwrap_runs(settings, &net_flags, &true_path);
    if net {
        detail.push("network namespace".to_string());
    }

    let mut cgroup_flags = base_flags.to_vec();
    cgroup_flags.push("--unshare-cgroup");
    let cgroup_ns = bwrap_runs(settings, &cgroup_flags, &true_path);
    if cgroup_ns {
        detail.push("cgroup namespace".to_string());
    }

    let seccomp = seccomp_probe(settings, &base_flags, &true_path);
    if seccomp {
        detail.push("seccomp filter loading".to_string());
    }

    let cgroup_v2 = settings
        .resolved_cgroup_root()
        .and_then(cgroup::CgroupManager::probe);
    if let Some(support) = &cgroup_v2 {
        detail.push(support.detail.clone());
    }

    let bridge = executable(&settings.bridge_executable);
    if bridge {
        detail.push("in-sandbox bridge executable".to_string());
    }

    Capabilities {
        platform: Platform::Linux,
        backend: Some("linux-bwrap"),
        unavailable: None,
        namespaces: NamespaceSupport {
            user: true,
            pid: true,
            ipc: true,
            uts: true,
            cgroup: cgroup_ns,
            net,
        },
        cgroup_v2,
        seccomp,
        // The baseline probe above proved the mount view used by
        // `filesystem.access`.
        filesystem: true,
        network_allow: true,
        network_deny: net,
        network_restricted: net && bridge,
        seatbelt: None,
        bridge,
        detail,
    }
}

fn unavailable(reason: &str) -> Capabilities {
    Capabilities {
        platform: Platform::Linux,
        backend: None,
        unavailable: Some(reason.to_string()),
        namespaces: NamespaceSupport::default(),
        cgroup_v2: None,
        seccomp: false,
        filesystem: false,
        network_allow: false,
        network_deny: false,
        network_restricted: false,
        seatbelt: None,
        bridge: false,
        detail: vec![reason.to_string()],
    }
}

struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

fn version_of(path: &Path) -> Option<String> {
    let mut command = Command::new(path); // not-tmux: probes the configured bubblewrap binary
    command.arg("--version");
    let output = run_bounded(command, Duration::from_secs(5), true)?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn bwrap_runs(settings: &SandboxSettings, flags: &[&str], command: &Path) -> bool {
    let mut process = Command::new(&settings.bubblewrap_path); // not-tmux: sandbox backend binary
    process.args(flags).arg("--").arg(command);
    run_bounded(process, Duration::from_secs(10), false)
        .is_some_and(|output| output.status.success())
}

fn seccomp_probe(settings: &SandboxSettings, base_flags: &[&str], command: &Path) -> bool {
    let profile =
        std::env::temp_dir().join(format!("nession-seccomp-probe-{}", uuid::Uuid::new_v4()));
    if std::fs::write(&profile, seccomp::probe_profile()).is_err() {
        return false;
    }
    let mut process = Command::new(&settings.launcher_shell); // not-tmux: trusted sandbox launcher shell
    process.args([
        "-c",
        "exec 3<\"$1\"; shift; exec \"$@\"",
        "nession-seccomp-probe",
    ]);
    process.arg(&profile);
    process.arg(&settings.bubblewrap_path);
    process.args(base_flags);
    process.arg("--seccomp").arg("3");
    process.arg("--").arg(command);
    let result = run_bounded(process, Duration::from_secs(10), false)
        .is_some_and(|output| output.status.success());
    let _ = std::fs::remove_file(&profile);
    result
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Removes a partially created cgroup unless it is taken out on success.
struct CgroupGuard(Option<cgroup::ExecutionCgroup>);

impl CgroupGuard {
    fn take(&mut self) -> Option<cgroup::ExecutionCgroup> {
        self.0.take()
    }
}

impl Drop for CgroupGuard {
    fn drop(&mut self) {
        if let Some(group) = self.0.take() {
            let _ = group.remove();
        }
    }
}

/// Prepare Linux-owned resources.
pub fn prepare(
    request: &LaunchRequest<'_>,
    compiled: &CompiledSandboxPolicy,
    settings: &SandboxSettings,
    working_dir: &Path,
) -> Result<PreparedSandbox> {
    let capabilities = probe(settings);
    crate::capabilities::validate(compiled, &capabilities)?;

    if let Some(filesystem) = &compiled.filesystem {
        crate::exec::validate_host_paths(filesystem)?;
    }

    let execution_id = uuid::Uuid::new_v4().to_string();
    let execution_dir = create_execution_dir(settings, &execution_id)?;
    let result = prepare_inner(
        request,
        compiled,
        settings,
        working_dir,
        &capabilities,
        &execution_id,
        &execution_dir,
    );
    match result {
        Ok(prepared) => Ok(prepared),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&execution_dir);
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_inner(
    request: &LaunchRequest<'_>,
    compiled: &CompiledSandboxPolicy,
    settings: &SandboxSettings,
    working_dir: &Path,
    capabilities: &Capabilities,
    execution_id: &str,
    execution_dir: &Path,
) -> Result<PreparedSandbox> {
    let cgroup_support: Option<&CgroupSupport> = capabilities.cgroup_v2.as_ref();
    let mut cgroup_guard = CgroupGuard(match (&compiled.cgroup, cgroup_support) {
        (Some(limits), Some(support)) => {
            Some(cgroup::CgroupManager::new(support).create_execution(execution_id, limits)?)
        }
        _ => None,
    });

    let seccomp_profile = execution_dir.join("seccomp.bpf");
    std::fs::write(&seccomp_profile, seccomp::interactive_profile_v1()?).map_err(|error| {
        SandboxError::Prepare(format!(
            "write seccomp profile {}: {error}",
            seccomp_profile.display()
        ))
    })?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&seccomp_profile, std::fs::Permissions::from_mode(0o600));
    }

    let restricted = compiled
        .network
        .as_ref()
        .is_some_and(|network| network.mode == SandboxNetworkMode::Restricted);
    let proxy_rules = if restricted {
        compiled
            .network
            .as_ref()
            .map(|network| Arc::new(network.rules.clone()))
    } else {
        None
    };
    let channel = channel::Channel::start(execution_id, execution_dir, proxy_rules)?;

    let mut forbidden = bwrap::ForbiddenPaths {
        files: request
            .tmux_socket
            .map(Path::to_path_buf)
            .into_iter()
            .collect(),
        directories: vec![settings.state_dir.clone(), PathBuf::from("/sys/fs/cgroup")],
    };
    forbidden
        .directories
        .extend(settings.private_directories.iter().cloned());
    forbidden.directories.retain(|path| path.exists());

    let proxy_listen = restricted.then(|| {
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, bwrap::SANDBOX_PROXY_PORT))
    });
    let bridge = bwrap::BridgePlacement {
        host_bridge: settings.bridge_executable.clone(),
        host_channel: channel.host_socket().to_path_buf(),
        execution_id: execution_id.to_string(),
        proxy_listen,
        bridge_subcommand: settings.bridge_subcommand.clone(),
    };

    // Filesystem probes: the cwd must be visible, and the Agent state (or the
    // policy-hidden control paths) must not be. A probe path that does not
    // exist on the host cannot prove anything and is not used.
    let mut visible_probes = vec![working_dir.to_path_buf()];
    if let Some(filesystem) = &compiled.filesystem {
        if let Some(path) = filesystem.visible().find(|path| path.is_dir()) {
            visible_probes.push(path.to_path_buf());
        }
    }
    visible_probes.retain(|path| path.exists());
    visible_probes.sort();
    visible_probes.dedup();
    let mut hidden_probes: Vec<PathBuf> = forbidden
        .files
        .iter()
        .chain(forbidden.directories.iter())
        .filter(|path| path.exists())
        .cloned()
        .collect();
    hidden_probes.sort();
    hidden_probes.dedup();

    let cgroup = cgroup_guard.take();
    let plan = bwrap::build(
        compiled,
        working_dir,
        &forbidden,
        &bridge,
        &visible_probes,
        &hidden_probes,
        &seccomp_profile,
        cgroup
            .as_ref()
            .map(cgroup::ExecutionCgroup::procs_file)
            .as_deref(),
        request.inner_command,
        settings,
    )?;

    let require_network_isolation = compiled
        .network
        .as_ref()
        .is_some_and(crate::policy::CompiledNetwork::blocks_host_network);

    let mut warnings = plan.warnings;
    warnings.push(
        "backend baseline: user,pid,ipc,uts and mount namespaces are always created".to_string(),
    );
    if let Some(support) = cgroup_support {
        warnings.push(format!("cgroup v2: {}", support.detail));
    }

    let report = build_report(
        compiled,
        execution_id,
        "linux-bwrap",
        cgroup.as_ref().map(cgroup::ExecutionCgroup::path),
        restricted.then(|| format!("socks5h://127.0.0.1:{}", bwrap::SANDBOX_PROXY_PORT)),
        warnings,
    );
    let record = ExecutionRecord {
        execution_id: execution_id.to_string(),
        session_name: request.session_name.to_string(),
        instance_id: request.instance_id.to_string(),
        backend: "linux-bwrap".to_string(),
        policy_digest: compiled.digest.clone(),
        created_at: now_seconds(),
        pane_pid: None,
        cgroup_path: cgroup
            .as_ref()
            .map(|group| group.path().display().to_string()),
        execution_dir: execution_dir.display().to_string(),
        restricted_network: restricted,
        agent_pid: std::process::id(),
    };
    write_record(settings, &record)?;

    let extra_env = sandbox_environment(&record, "linux-bwrap", &compiled.digest);
    Ok(PreparedSandbox::new(
        compiled.clone(),
        report,
        plan.argv,
        extra_env,
        settings.clone(),
        record,
        Some(PreparedLinux {
            channel: Some(channel),
            cgroup,
            execution_dir: execution_dir.to_path_buf(),
            execution_id: execution_id.to_string(),
            visible_probes,
            hidden_probes,
            require_network_isolation,
            require_cgroup_namespace: compiled.namespaces.cgroup,
        }),
    ))
}

fn pane_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Wait for the bridge, verify the installed controls, then release the
/// launch barrier.
pub fn verify_launch(
    prepared: &mut PreparedLinux,
    pane_pid: u32,
    settings: &SandboxSettings,
) -> Result<()> {
    let Some(channel) = prepared.channel.as_ref() else {
        return Err(SandboxError::Verify(
            "the sandbox channel is already closed".to_string(),
        ));
    };
    let deadline = Instant::now() + settings.launch_timeout;
    let peer = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SandboxError::Verify(format!(
                "the sandbox init did not connect within {:?}",
                settings.launch_timeout
            )));
        }
        match channel.wait_for_control(remaining.min(Duration::from_millis(250))) {
            Ok(peer) => break peer,
            Err(error) => {
                if !pane_alive(pane_pid) {
                    return Err(SandboxError::Verify(format!(
                        "the Pane process {pane_pid} exited before the sandbox init connected: {error}"
                    )));
                }
            }
        }
    };

    let request = verify::VerifyRequest {
        peer: &peer,
        pane_pid,
        expected_execution_id: &prepared.execution_id,
        expected_cgroup: prepared.cgroup.as_ref().map(cgroup::ExecutionCgroup::path),
        require_network_isolation: prepared.require_network_isolation,
        require_cgroup_namespace: prepared.require_cgroup_namespace,
        visible_probes: &prepared.visible_probes,
        hidden_probes: &prepared.hidden_probes,
    };
    if let Err(error) = verify::verify(&request) {
        if let Some(channel) = prepared.channel.as_ref() {
            channel.deny(peer);
        }
        return Err(error);
    }
    let Some(channel) = prepared.channel.as_mut() else {
        return Err(SandboxError::Verify(
            "the sandbox channel is already closed".to_string(),
        ));
    };
    channel.release(peer)?;

    // The bridge now execs the user's shell. A shell that cannot start must
    // fail the create rather than leave an empty Session.
    let grace = Instant::now() + Duration::from_secs(2);
    while Instant::now() < grace {
        if !pane_alive(pane_pid) {
            return Err(SandboxError::Verify(format!(
                "the Pane process {pane_pid} exited immediately after the launch barrier"
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// Release resources for a prepared launch that never verified.
pub fn cleanup_prepared(
    mut prepared: PreparedLinux,
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
    cleanup_linux(&mut prepared, settings, record, report)
}

/// Release resources for a verified execution whose Session is gone.
pub fn cleanup_verified(
    prepared: &mut PreparedLinux,
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
    cleanup_linux(prepared, settings, record, report)
}

fn cleanup_linux(
    prepared: &mut PreparedLinux,
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
    if let Some(group) = prepared.cgroup.take() {
        report.evidence.extend(group.evidence());
        if let Err(error) = group.remove() {
            // Keep the record: reconciliation retries the owned cgroup rather
            // than forgetting it.
            return Err(error);
        }
    }
    // Dropping the channel stops the listener and unlinks its socket. A live
    // restricted proxy cannot be reconstructed after an Agent restart; the
    // record keeps `restricted_network` so the limitation is observable.
    drop(prepared.channel.take());
    remove_owned_paths(settings, record, report)
}

/// Run a command with a hard deadline. Output is captured only when asked.
fn run_bounded(mut command: Command, timeout: Duration, capture: bool) -> Option<BoundedOutput> {
    command.stdin(Stdio::null());
    if capture {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(Stdio::null());
    }
    command.stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = if capture { child.stdout.take() } else { None };
    let reader = stdout.map(|mut stdout| {
        std::thread::spawn(move || {
            use std::io::Read as _;
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            bytes
        })
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    Some(BoundedOutput { status, stdout })
}
