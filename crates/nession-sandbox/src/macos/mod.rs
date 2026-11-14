//! The macOS backend: Seatbelt only for mechanisms that were independently
//! verified on this host.
//!
//! The backend never impersonates Linux: `process.linux_namespaces`,
//! `resource.cgroup_v2`, `syscall.seccomp` and restricted networking are
//! rejected with `UnsupportedPolicy`, and the capability report says what was
//! actually probed. `sandbox-exec` is a version-probed, deprecated dependency;
//! the probe runs a real allow/deny pair before any policy is accepted.

pub mod profile;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::capabilities::{Capabilities, Platform, SeatbeltSupport};
use crate::error::{Result, SandboxError};
use crate::exec::{
    build_report, create_execution_dir, now_seconds, remove_owned_paths, sandbox_environment,
    write_record, ExecutionRecord, LaunchRequest, PreparedSandbox,
};
use crate::policy::CompiledSandboxPolicy;
use crate::settings::SandboxSettings;

/// macOS-owned resources for a prepared launch.
pub struct PreparedMacos {
    pub execution_dir: PathBuf,
}

/// Probe `sandbox-exec` and its actual allow/deny behaviour.
pub fn probe(settings: &SandboxSettings) -> Capabilities {
    let mut detail = Vec::new();
    if !executable(&settings.sandbox_exec_path) {
        return unavailable("sandbox-exec is not available on this host");
    }
    let trivial = run_capture(
        &settings.sandbox_exec_path,
        &["-p", "(version 1)(allow default)", "/usr/bin/true"],
        Duration::from_secs(5),
    );
    if !trivial.is_some_and(|output| output.status.success()) {
        return unavailable("sandbox-exec cannot apply a trivial Seatbelt profile");
    }
    detail.push("sandbox-exec applies Seatbelt profiles".to_string());

    // Path allow-lists are not verified on this platform (see `profile.rs`),
    // so the capability report says so and the validator rejects
    // `filesystem.access` instead of approximating it.
    detail.push(
        "Seatbelt path allow-lists are not verified on this macOS version; filesystem.access is rejected"
            .to_string(),
    );
    let (network_deny, network_detail) = probe_network_deny(settings);
    detail.push(network_detail);

    let seatbelt = SeatbeltSupport {
        filesystem: false,
        network_deny,
        detail: detail.join("; "),
    };
    Capabilities {
        platform: Platform::Macos,
        backend: Some("macos-seatbelt"),
        unavailable: None,
        namespaces: Default::default(),
        cgroup_v2: None,
        seccomp: false,
        filesystem: false,
        erofs: false,
        erofs_overlay: false,
        network_allow: true,
        network_deny,
        network_restricted: false,
        seatbelt: Some(seatbelt),
        bridge: false,
        detail,
    }
}

fn unavailable(reason: &str) -> Capabilities {
    Capabilities {
        platform: Platform::Macos,
        backend: None,
        unavailable: Some(reason.to_string()),
        namespaces: Default::default(),
        cgroup_v2: None,
        seccomp: false,
        filesystem: false,
        erofs: false,
        erofs_overlay: false,
        network_allow: false,
        network_deny: false,
        network_restricted: false,
        seatbelt: None,
        bridge: false,
        detail: vec![reason.to_string()],
    }
}

/// A real network-denial fixture: a local listener sees a control `curl`
/// connection but not one made under `(deny network*)`.
fn probe_network_deny(settings: &SandboxSettings) -> (bool, String) {
    let curl = Path::new("/usr/bin/curl");
    if !curl.exists() {
        return (
            false,
            "Seatbelt network probe skipped: /usr/bin/curl is absent".to_string(),
        );
    }
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) else {
        return (
            false,
            "Seatbelt network probe could not bind a local listener".to_string(),
        );
    };
    let _ = listener.set_nonblocking(true);
    let Ok(address) = listener.local_addr() else {
        return (
            false,
            "Seatbelt network probe has no listener address".to_string(),
        );
    };
    let url = format!("http://{address}/");
    let mut command = Command::new(curl);
    command.args(["-s", "--max-time", "1", "-o", "/dev/null", &url]);
    let connected_in_control = run_and_observe_connection(&mut command, &listener);
    if !connected_in_control {
        return (
            false,
            "Seatbelt network probe control did not connect".to_string(),
        );
    }
    let profile = "(version 1)(allow default)(deny network*)";
    let mut command = Command::new(&settings.sandbox_exec_path);
    command.args(["-p", profile]);
    command.arg(curl);
    command.args(["-s", "--max-time", "1", "-o", "/dev/null", &url]);
    let connected_under_deny = run_and_observe_connection(&mut command, &listener);
    let deny_worked = !connected_under_deny;
    (
        deny_worked,
        format!(
            "Seatbelt network probe: control connected={connected_in_control}, denied-profile connected={connected_under_deny}"
        ),
    )
}

/// Run `command` and report whether the listener accepted a connection while
/// it ran.
fn run_and_observe_connection(command: &mut Command, listener: &std::net::TcpListener) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Drain any connection left by the previous run.
    while listener.accept().is_ok() {}
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut connected = false;
    while Instant::now() < deadline {
        if listener.accept().is_ok() {
            connected = true;
            break;
        }
        if child.try_wait().ok().flatten().is_some() {
            // Give the kernel a moment to enqueue a connection the child made
            // just before exiting.
            std::thread::sleep(Duration::from_millis(50));
            connected |= listener.accept().is_ok();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    connected
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Prepare a Seatbelt launch.
pub fn prepare(
    request: &LaunchRequest,
    compiled: &CompiledSandboxPolicy,
    settings: &SandboxSettings,
    working_dir: &Path,
) -> Result<PreparedSandbox> {
    let capabilities = probe(settings);
    let field_errors = crate::capabilities::unsupported_requests(&request.policy, &capabilities);
    if !field_errors.is_empty() {
        return Err(crate::error::SandboxError::UnsupportedRequests(
            field_errors,
        ));
    }
    crate::capabilities::validate(compiled, &capabilities)?;
    let _ = working_dir;
    let _ = request.inner_command;

    let execution_id = uuid::Uuid::new_v4().to_string();
    let execution_dir = create_execution_dir(settings, &execution_id)?;
    let profile = profile::build_profile(compiled.network.as_ref());

    let mut command = vec![
        settings.sandbox_exec_path.to_string_lossy().into_owned(),
        "-p".to_string(),
        profile,
    ];
    command.extend(request.inner_command.iter().cloned());

    let mut warnings = vec![
        "macOS Seatbelt is probed for filesystem/network denial; per-process kernel-state inspection is not available on macOS"
            .to_string(),
        "backend baseline: Seatbelt profile application replaces the Linux namespace baseline"
            .to_string(),
    ];
    warnings.extend(capabilities.detail.iter().cloned());

    let report = build_report(
        compiled,
        &execution_id,
        "macos-seatbelt",
        None,
        None,
        warnings,
    );
    let record = ExecutionRecord {
        execution_id,
        session_name: request.session_name.clone(),
        instance_id: request.instance_id.clone(),
        backend: "macos-seatbelt".to_string(),
        policy_digest: compiled.digest.clone(),
        created_at: now_seconds(),
        pane_pid: None,
        pane_id: None,
        window_id: None,
        working_dir: working_dir.display().to_string(),
        effective_policy: Some(compiled.normalized.clone()),
        mounts: Vec::new(),
        shared_mounts: Vec::new(),
        channel_dir: None,
        mechanisms: report.mechanisms.clone(),
        warnings: report.warnings.clone(),
        proxy_endpoint: report.proxy_endpoint.clone(),
        native_window_id: None,
        native_pane_id: None,
        cgroup_path: None,
        execution_dir: execution_dir.display().to_string(),
        restricted_network: false,
        agent_pid: std::process::id(),
    };
    write_record(settings, &record)?;
    let extra_env = sandbox_environment(&record, "macos-seatbelt", &compiled.digest);
    Ok(PreparedSandbox::new(
        compiled.clone(),
        report,
        command,
        extra_env,
        settings.clone(),
        record,
        Some(PreparedMacos { execution_dir }),
    ))
}

/// On macOS there is no `/proc` to inspect. The capability probe is the
/// enforcement evidence; this check refuses a launch whose shell died
/// immediately.
pub fn verify_launch(
    prepared: &mut PreparedMacos,
    pane_pid: u32,
    _settings: &SandboxSettings,
) -> Result<crate::exec::VerifiedControls> {
    let grace = Instant::now() + Duration::from_millis(500);
    while Instant::now() < grace {
        if !process_alive(pane_pid) {
            return Err(SandboxError::Verify(format!(
                "the Pane process {pane_pid} exited immediately after launch"
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = &prepared.execution_dir;
    // macOS exposes no equivalent of `/proc/<pid>/status`; the capability
    // probe is the enforcement evidence and this check only refuses a shell
    // that died immediately.
    Ok(crate::exec::VerifiedControls::default())
}

fn process_alive(pid: u32) -> bool {
    let pid = match libc::pid_t::try_from(pid) {
        Ok(pid) => pid,
        Err(_) => return false,
    };
    // SAFETY: signal 0 only performs existence and permission checks.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0
}

pub fn cleanup_prepared(
    prepared: PreparedMacos,
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
    let _ = prepared;
    remove_owned_paths(settings, record, report)
}

pub fn cleanup_verified(
    prepared: PreparedMacos,
    settings: &SandboxSettings,
    record: &ExecutionRecord,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
    let _ = prepared;
    remove_owned_paths(settings, record, report)
}

struct BoundedOutput {
    status: std::process::ExitStatus,
}

fn run_capture(program: &Path, args: &[&str], timeout: Duration) -> Option<BoundedOutput> {
    let mut command = Command::new(program);
    command.args(args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(BoundedOutput { status }),
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &Path) -> SandboxSettings {
        SandboxSettings::new(
            dir.join("state"),
            PathBuf::from("/usr/bin/true"),
            PathBuf::from("bwrap"),
            PathBuf::from("/usr/bin/sandbox-exec"),
        )
    }

    #[test]
    fn the_seatbelt_probe_observes_real_allow_and_deny() {
        let dir = tempfile::tempdir().expect("tempdir");
        let capabilities = probe(&settings(dir.path()));
        assert_eq!(capabilities.backend, Some("macos-seatbelt"));
        let seatbelt = capabilities.seatbelt.clone().expect("seatbelt report");
        assert!(!seatbelt.filesystem, "{}", seatbelt.detail);
        assert!(seatbelt.network_deny, "{}", seatbelt.detail);

        let policy: nession_protocol::contracts::sandbox::v1::SandboxPolicy =
            serde_json::from_value(serde_json::json!({
                "enabled": true,
                "filesystem": { "access": { "read": ["/usr"], "write": [] } }
            }))
            .expect("policy fixture");
        let compiled = crate::policy::compile(&policy).expect("compiled");
        let error = crate::capabilities::validate(&compiled, &capabilities)
            .expect_err("macOS must reject filesystem.access it cannot verify");
        assert!(matches!(
            error,
            crate::error::SandboxError::UnsupportedPolicy(_)
        ));
    }
}
