//! Real Linux runtime proof for on-demand Sandbox executions (#2681).
//!
//! These tests spawn the exact trusted launcher the Agent hands to
//! `tmux new-session`, verify the installed controls through the same launch
//! barrier, run a shell inside the sandbox, print the observed facts and
//! release the owned cgroup/record. They adapt to the host's measured
//! capabilities: an unavailable backend must fail closed, never silently pass.

#![cfg(target_os = "linux")]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nession_protocol::contracts::sandbox::v1::SandboxPolicy;
use nession_sandbox::{prepare, probe, LaunchRequest, PreparedSandbox, SandboxSettings};

const EVIDENCE_PREFIX: &str = "NESSON_SANDBOX_EVIDENCE ";
const CGROUP_MOUNT: &str = "/sys/fs/cgroup";

#[cfg(test)]
mod helpers {
    use super::*;

    pub(super) fn settings(dir: &Path) -> SandboxSettings {
        let mut settings = SandboxSettings::new(
            dir.join("state"),
            PathBuf::from(env!("CARGO_BIN_EXE_nession-sandbox-bridge")),
            PathBuf::from("bwrap"),
            PathBuf::from("/usr/bin/sandbox-exec"),
        );
        settings.launch_timeout = Duration::from_secs(15);
        // A delegated root has no processes of its own; the default
        // `<own cgroup>/nession` does not work when the Agent is itself in a
        // cgroup with processes. The acceptance harness supplies one.
        if let Some(root) = std::env::var_os("SANDBOX_CGROUP_ROOT")
            .or_else(|| std::env::var_os("NESSON_SANDBOX_CGROUP_ROOT"))
        {
            settings.cgroup_root = Some(PathBuf::from(root));
        }
        settings
    }

    pub(super) fn policy(workspace: &Path, with_cgroup: bool, network: &str) -> SandboxPolicy {
        let mut value = serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": {
                    "read": ["/usr", "/etc"],
                    "write": [workspace.to_string_lossy()]
                }
            },
            "network": network_policy(network),
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required"
        });
        if with_cgroup {
            value["resource"] = serde_json::json!({ "cgroup_v2": { "pids.max": "64" } });
        }
        serde_json::from_value(value).expect("policy fixture")
    }

    pub(super) fn minimal_policy(network: &str) -> SandboxPolicy {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "network": network_policy(network),
            "enforcement": "required"
        }))
        .expect("minimal policy fixture")
    }

    fn network_policy(mode: &str) -> serde_json::Value {
        if mode == "restricted" {
            serde_json::json!({
                "mode": "restricted",
                "egress": { "allow": ["example.com:443"], "deny": [] }
            })
        } else {
            serde_json::json!({ "mode": mode })
        }
    }

    pub(super) struct Running {
        pub(super) prepared: PreparedSandbox,
        pub(super) child: Child,
        pub(super) pane_pid: u32,
    }

    pub(super) fn launch(settings: &SandboxSettings, request: LaunchRequest) -> Running {
        let prepared = prepare(&request, settings).expect("prepare an execution");
        let program = prepared
            .command()
            .first()
            .expect("the launcher has a program");
        let mut command = Command::new(program); // not-tmux: spawns the sandbox trusted launcher
        command.args(prepared.command().get(1..).unwrap_or_default());
        for (key, value) in prepared.env() {
            command.env(key, value);
        }
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the trusted launcher");
        let pane_pid = child.id();
        Running {
            prepared,
            child,
            pane_pid,
        }
    }

    pub(super) fn launch_fs(
        settings: &SandboxSettings,
        workspace: &Path,
        with_cgroup: bool,
        network: &str,
        inner: &[&str],
    ) -> Running {
        launch(
            settings,
            LaunchRequest {
                policy: policy(workspace, with_cgroup, network),
                session_name: format!("sandbox-{}", std::process::id()),
                instance_id: "instance-runtime".to_string(),
                working_dir: workspace.to_string_lossy().into_owned(),
                inner_command: inner.iter().map(|part| (*part).to_string()).collect(),
                tmux_socket: None,
            },
        )
    }

    pub(super) fn wait_for_exit(
        running: &mut Running,
    ) -> (std::process::ExitStatus, String, String) {
        let mut stderr = running.child.stderr.take().expect("stderr");
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = running.child.try_wait().expect("wait for the sandbox") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = running.child.kill();
                let _ = running.child.wait();
                panic!("the sandboxed shell did not exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut stdout = String::new();
        running
            .child
            .stdout
            .take()
            .expect("stdout")
            .read_to_string(&mut stdout)
            .expect("read sandbox stdout");
        let stderr = stderr_reader.join().unwrap_or_default();
        (status, stdout, stderr)
    }

    /// Verify, and on failure include the launcher's own output.
    pub(super) fn verify_or_report(running: &mut Running, context: &str) {
        if let Err(error) = running.prepared.verify(running.pane_pid) {
            let _ = running.child.kill();
            let mut stderr = String::new();
            if let Some(mut pipe) = running.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            let mut stdout = String::new();
            if let Some(mut pipe) = running.child.stdout.take() {
                let _ = pipe.read_to_string(&mut stdout);
            }
            panic!("{context}: {error}; stdout: {stdout}; stderr: {stderr}");
        }
    }

    pub(super) fn print_evidence(value: &serde_json::Value) {
        println!("{EVIDENCE_PREFIX}{value}");
    }

    pub(super) fn controls_json(prepared: &PreparedSandbox) -> serde_json::Value {
        let Some(controls) = prepared.verified_controls() else {
            return serde_json::Value::Null;
        };
        serde_json::json!({
            "namespaces": controls.namespaces,
            "seccomp": controls.seccomp,
            "no_new_privs": controls.no_new_privs,
            "filesystem_probes": controls.filesystem_probes,
            "cgroup": controls.cgroup,
        })
    }

    pub(super) fn cgroup_mount(relative: &str) -> PathBuf {
        Path::new(CGROUP_MOUNT).join(relative.trim_start_matches('/'))
    }

    pub(super) fn read_cgroup_limits(relative: &str) -> serde_json::Value {
        let mut limits = serde_json::Map::new();
        for file in ["pids.max", "memory.max", "cpu.max", "memory.oom.group"] {
            if let Ok(value) = std::fs::read_to_string(cgroup_mount(relative).join(file)) {
                limits.insert(
                    file.to_string(),
                    serde_json::Value::String(value.trim().to_string()),
                );
            }
        }
        serde_json::Value::Object(limits)
    }

    pub(super) fn pane_in_cgroup(pane_pid: u32, relative: &str) -> bool {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pane_pid}/cgroup")) else {
            return false;
        };
        text.lines()
            .any(|line| line.trim() == format!("0::{relative}"))
    }

    pub(super) fn assert_cleaned(
        settings: &SandboxSettings,
        record: &nession_sandbox::ExecutionRecord,
    ) {
        assert!(
            !settings
                .state_dir
                .join(format!("{}.json", record.execution_id))
                .exists(),
            "the execution record must be removed"
        );
        assert!(
            !Path::new(&record.execution_dir).exists(),
            "the execution directory must be removed"
        );
        if let Some(cgroup_path) = &record.cgroup_path {
            assert!(
                !cgroup_mount(cgroup_path).exists(),
                "the execution cgroup must be removed: {cgroup_path}"
            );
        }
    }

    pub(super) fn with_cgroup(capabilities: &nession_sandbox::Capabilities) -> bool {
        capabilities
            .cgroup_v2
            .as_ref()
            .is_some_and(|support| support.controllers.contains("pids"))
    }
}

use helpers::*;

#[test]
fn an_execution_verifies_its_controls_and_releases_owned_resources() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);

    let Some(_backend) = capabilities.backend else {
        // Fail closed: the same policy must refuse rather than fall back.
        let request = LaunchRequest {
            policy: policy(&workspace, false, "allow"),
            session_name: "sandbox-unavailable".to_string(),
            instance_id: "instance".to_string(),
            working_dir: workspace.to_string_lossy().into_owned(),
            inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), "true".to_string()],
            tmux_socket: None,
        };
        let error = match prepare(&request, &settings) {
            Ok(_) => panic!("an unavailable backend must not prepare a launch"),
            Err(error) => error,
        };
        assert!(
            matches!(
                error,
                nession_sandbox::SandboxError::BackendUnavailable(_)
                    | nession_sandbox::SandboxError::UnsupportedPolicy(_)
            ),
            "the refusal must name unavailability or an unsupported guarantee: {error}"
        );
        eprintln!("sandbox backend unavailable on this host; fail-closed path verified");
        return;
    };

    let cgroup_available = with_cgroup(&capabilities);
    let mut running = launch_fs(
        &settings,
        &workspace,
        cgroup_available,
        "allow",
        &[
            "/bin/sh",
            "-c",
            "printf 'sandbox-alive'; unshare -U true 2>/dev/null; \
             printf ' unshare=%s' $?; (true) & wait; printf ' fork=%s' $?; sleep 1",
        ],
    );
    verify_or_report(&mut running, "the launch barrier must verify");
    let report = running.prepared.report().clone();
    let controls = controls_json(&running.prepared);
    let record = running.prepared.record().clone();
    // Read the membership while the launcher is still alive; the shell sleeps
    // for a second after printing so this observation is not a race.
    let (membership, limits) = match record.cgroup_path.as_deref() {
        Some(relative) => {
            let membership = pane_in_cgroup(running.pane_pid, relative);
            assert!(membership, "the Pane must be a member of {relative}");
            let limits = read_cgroup_limits(relative);
            assert_eq!(limits["pids.max"], "64");
            (membership, limits)
        }
        None => (false, serde_json::Value::Null),
    };
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(
        status.success(),
        "the sandboxed shell failed: {status}; stdout: {stdout}; stderr: {stderr}"
    );
    let fields: Vec<&str> = stdout.split_whitespace().collect();
    assert!(fields.contains(&"sandbox-alive"), "stdout: {stdout}");
    let unshare_status = fields
        .iter()
        .find_map(|field| field.strip_prefix("unshare="))
        .and_then(|value| value.parse::<i32>().ok())
        .expect("the shell reported the unshare result");
    let fork_status = fields
        .iter()
        .find_map(|field| field.strip_prefix("fork="))
        .and_then(|value| value.parse::<i32>().ok())
        .expect("the shell reported the fork result");
    assert_eq!(
        unshare_status, 1,
        "unshare must be denied with EPERM: {stdout}"
    );
    assert_eq!(
        fork_status, 0,
        "ordinary shell fork must still work: {stdout}"
    );

    let handle = running.prepared.into_handle();
    let cleanup = handle.cleanup().expect("cleanup owned resources");
    assert!(cleanup.removed);
    assert_cleaned(&settings, &record);

    let namespaces = &controls["namespaces"];
    assert!(
        namespaces["pid"].is_string(),
        "the PID namespace was not reported"
    );
    assert!(
        namespaces["user"].is_string(),
        "the User namespace was not reported"
    );
    assert!(
        namespaces["ipc"].is_string(),
        "the IPC namespace was not reported"
    );
    assert_eq!(controls["seccomp"], "2");
    assert_eq!(controls["no_new_privs"], "1");
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "backend": report.backend,
        "mechanisms": report.mechanisms,
        "namespaces": namespaces,
        "seccomp": controls["seccomp"],
        "no_new_privs": controls["no_new_privs"],
        "filesystem_probes": controls["filesystem_probes"],
        "cgroup_path": record.cgroup_path,
        "cgroup_effective_limits": limits,
        "cgroup_membership_verified": membership,
        "cgroup_limits_verified": record.cgroup_path.is_some(),
        "cgroup_removed": record.cgroup_path.is_some(),
        "record_removed": true,
        "execution_dir_removed": true,
        "shell_output": stdout.trim(),
        "unshare_denied": unshare_status == 1,
        "fork_ok": fork_status == 0,
    }));
}

#[test]
fn a_policy_without_filesystem_access_still_masks_control_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);
    if capabilities.backend.is_none() {
        eprintln!("sandbox backend unavailable on this host; skipping");
        return;
    }
    // No filesystem dimension: the backend binds the host read-only and masks
    // the control paths. The probe must use a masked child, not the masked
    // directory itself (which still exists).
    let mut running = launch(
        &settings,
        LaunchRequest {
            policy: minimal_policy("deny"),
            session_name: format!("sandbox-minimal-{}", std::process::id()),
            instance_id: "instance-minimal".to_string(),
            working_dir: "/tmp".to_string(),
            inner_command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "printf no-filesystem-ok".to_string(),
            ],
            tmux_socket: None,
        },
    );
    verify_or_report(
        &mut running,
        "a policy without a filesystem dimension must still verify its masks",
    );
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(status.success(), "status: {status}; stderr: {stderr}");
    assert_eq!(stdout.trim(), "no-filesystem-ok");
    let record = running.prepared.record().clone();
    let controls = controls_json(&running.prepared);
    let handle = running.prepared.into_handle();
    handle.cleanup().expect("cleanup");
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "filesystem_probes": controls["filesystem_probes"],
        "masked_control_paths_verified": true,
        "shell_output": stdout.trim(),
    }));
}

#[test]
fn a_restricted_network_denies_direct_and_private_egress() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);
    if !capabilities.network_restricted {
        eprintln!("restricted networking is unavailable on this host; skipping");
        return;
    }

    let cgroup_available = with_cgroup(&capabilities);
    let mut running = launch_fs(
        &settings,
        &workspace,
        cgroup_available,
        "restricted",
        &[
            "/bin/sh",
            "-c",
            "printf 'proxy-env=%s ' \"$ALL_PROXY\"; \
             curl -sS --max-time 3 -o /dev/null http://example.com/ >/dev/null 2>&1; \
             printf 'direct=%s ' $?; \
             curl -sS --max-time 3 -o /dev/null --socks5-hostname 127.0.0.1:3128 http://127.0.0.1:9/ >/dev/null 2>&1; \
             printf 'private=%s ' $?; \
             curl -sS --max-time 10 -o /dev/null -w 'allowed=%{http_code}' --socks5-hostname 127.0.0.1:3128 https://example.com/",
        ],
    );
    verify_or_report(&mut running, "the restricted launch barrier must verify");
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(
        status.success(),
        "the restricted shell failed: {status}; stdout: {stdout}; stderr: {stderr}"
    );
    let field = |name: &str| {
        stdout
            .split_whitespace()
            .find_map(|entry| entry.strip_prefix(name))
            .map(str::to_string)
    };
    let direct = field("direct=")
        .and_then(|value| value.parse::<i32>().ok())
        .expect("curl reported the direct result");
    let private = field("private=")
        .and_then(|value| value.parse::<i32>().ok())
        .expect("curl reported the private result");
    let allowed = field("allowed=")
        .and_then(|value| value.parse::<u16>().ok())
        .expect("curl reported the allowed HTTP status");
    assert_ne!(
        direct, 0,
        "direct egress must fail without a route: {stdout}"
    );
    assert_ne!(
        private, 0,
        "the proxy must refuse a private destination: {stdout}"
    );
    assert!(
        (200..400).contains(&allowed),
        "an allowed destination must succeed through the proxy, got {allowed}: {stdout}"
    );

    // A non-bridge peer cannot use the proxy socket.
    let record = running.prepared.record().clone();
    let channel = Path::new(&record.execution_dir).join("channel.sock");
    use std::io::Write as _;
    let mut proxy_peer = std::os::unix::net::UnixStream::connect(&channel)
        .expect("connect to the channel socket as a non-bridge peer");
    proxy_peer
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    proxy_peer
        .write_all(&[0x05, 0x01, 0x00])
        .expect("send a SOCKS greeting");
    let mut reply = [0u8; 2];
    let proxy_read = proxy_peer.read(&mut reply).unwrap_or(0);
    assert_eq!(
        proxy_read, 0,
        "a non-bridge peer must not receive a proxy reply"
    );

    // After GO, a forged control hello cannot be retained in the Agent queue.
    let mut forged =
        std::os::unix::net::UnixStream::connect(&channel).expect("connect a forged control peer");
    forged
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    forged
        .write_all(b"NESSON-SANDBOX-1 forged\n\n")
        .expect("send a forged hello");
    let mut control_reply = [0u8; 1];
    let control_read = forged.read(&mut control_reply).unwrap_or(0);
    assert_eq!(
        control_read, 0,
        "a post-release control connection must be closed, not queued"
    );

    let report = running.prepared.report().clone();
    let handle = running.prepared.into_handle();
    handle.cleanup().expect("cleanup owned resources");
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "proxy_endpoint": report.proxy_endpoint,
        "proxy_env": field("proxy-env="),
        "direct_denied": direct != 0,
        "proxy_private_denied": private != 0,
        "allowed_status": allowed,
        "allowed_succeeded": (200..400).contains(&allowed),
        "channel_identity_denied": proxy_read == 0,
        "control_after_release_denied": control_read == 0,
        "proxy_response": format!("curl exit {private} for a private destination"),
        "record_removed": true,
    }));
}

#[test]
fn an_aborted_launch_releases_only_its_owned_resources() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);
    if capabilities.backend.is_none() {
        eprintln!("sandbox backend unavailable on this host; skipping");
        return;
    }
    let cgroup_available = with_cgroup(&capabilities);
    let request = LaunchRequest {
        policy: policy(&workspace, cgroup_available, "allow"),
        session_name: "sandbox-aborted".to_string(),
        instance_id: "instance-aborted".to_string(),
        working_dir: workspace.to_string_lossy().into_owned(),
        inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), "true".to_string()],
        tmux_socket: None,
    };
    let prepared = prepare(&request, &settings).expect("prepare");
    let record = prepared.record().clone();
    let cleanup = prepared.abort().expect("abort a launch that never ran");
    assert!(cleanup.removed);
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "record_removed": true,
        "execution_dir_removed": true,
    }));
}

#[test]
fn a_recorded_cgroup_is_recoverable_after_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);
    if !with_cgroup(&capabilities) {
        eprintln!(
            "no delegated cgroup v2 on this host; skipping (configured root {:?}, {:?})",
            settings.cgroup_root, capabilities.detail
        );
        return;
    }
    let request = LaunchRequest {
        policy: policy(&workspace, true, "allow"),
        session_name: "sandbox-restart".to_string(),
        instance_id: "instance-restart".to_string(),
        working_dir: workspace.to_string_lossy().into_owned(),
        inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), "true".to_string()],
        tmux_socket: None,
    };
    let prepared = prepare(&request, &settings).expect("prepare");
    let record = prepared.record().clone();
    let relative = record.cgroup_path.clone().expect("recorded cgroup");
    assert!(cgroup_mount(&relative).exists());
    // Simulate an Agent crash: the in-memory handle never runs its cleanup.
    std::mem::forget(prepared);
    let mut report = nession_sandbox::CleanupReport::default();
    nession_sandbox::cleanup_record(&settings, &record, &mut report)
        .expect("a durable record must be recoverable");
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "recorded_cgroup": relative,
        "record_removed": true,
        "execution_dir_removed": true,
    }));
}

#[test]
fn an_execution_survives_losing_its_client_stream() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let settings = settings(dir.path());
    let capabilities = probe(&settings);
    if capabilities.backend.is_none() {
        eprintln!("sandbox backend unavailable on this host; skipping");
        return;
    }
    let mut running = launch_fs(
        &settings,
        &workspace,
        false,
        "allow",
        &["/bin/sh", "-c", "sleep 2; printf survived"],
    );
    verify_or_report(&mut running, "the launch barrier must verify");
    // The client stops reading: close the only output consumers while the
    // Pane keeps running. This is the process-level half of detach; tmux's
    // client layer is owned by the terminal attach suite.
    drop(running.child.stdout.take());
    drop(running.child.stderr.take());
    std::thread::sleep(Duration::from_millis(700));
    let alive = Path::new(&format!("/proc/{}", running.pane_pid)).exists();
    assert!(alive, "the Pane must survive losing its client stream");

    let record = running.prepared.record().clone();
    let _ = running.child.kill();
    let _ = running.child.wait();
    let handle = running.prepared.into_handle();
    handle.cleanup().expect("cleanup");
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "survived_client_loss": alive,
        "record_removed": true,
    }));
}
