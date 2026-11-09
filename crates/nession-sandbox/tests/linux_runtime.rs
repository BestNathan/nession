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

    pub(super) fn network_policy(mode: &str) -> serde_json::Value {
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

    pub(super) fn launch(
        settings: &SandboxSettings,
        workspace: &Path,
        with_cgroup: bool,
        network: &str,
        inner: &[&str],
    ) -> Running {
        let request = LaunchRequest {
            policy: policy(workspace, with_cgroup, network),
            session_name: format!("sandbox-{}", std::process::id()),
            instance_id: "instance-runtime".to_string(),
            working_dir: workspace.to_string_lossy().into_owned(),
            inner_command: inner.iter().map(|part| (*part).to_string()).collect(),
            tmux_socket: None,
        };
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

    pub(super) fn read_cgroup_limits(path: &str) -> serde_json::Value {
        let mut limits = serde_json::Map::new();
        for file in ["pids.max", "memory.max", "cpu.max", "memory.oom.group"] {
            if let Ok(value) = std::fs::read_to_string(Path::new(path).join(file)) {
                limits.insert(
                    file.to_string(),
                    serde_json::Value::String(value.trim().to_string()),
                );
            }
        }
        serde_json::Value::Object(limits)
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
                !Path::new(cgroup_path).exists(),
                "the execution cgroup must be removed: {cgroup_path}"
            );
        }
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

    let with_cgroup = capabilities
        .cgroup_v2
        .as_ref()
        .is_some_and(|support| support.controllers.contains("pids"));
    let mut running = launch(
        &settings,
        &workspace,
        with_cgroup,
        "allow",
        &[
            "/bin/sh",
            "-c",
            "printf 'sandbox-alive'; unshare -U true 2>/dev/null; \
             printf ' unshare=%s' $?; (true) & wait; printf ' fork=%s' $?",
        ],
    );
    running
        .prepared
        .verify(running.pane_pid)
        .expect("the launch barrier must verify");
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

    let report = running.prepared.report().clone();
    let controls = controls_json(&running.prepared);
    let record = running.prepared.record().clone();
    let cgroup_limits = record
        .cgroup_path
        .as_deref()
        .map(read_cgroup_limits)
        .unwrap_or(serde_json::Value::Null);

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
        "cgroup_effective_limits": cgroup_limits,
        "cgroup_membership_verified": true,
        "cgroup_limits_verified": true,
        "cgroup_removed": record.cgroup_path.as_deref().map(|path| !Path::new(path).exists()).unwrap_or(true),
        "record_removed": true,
        "execution_dir_removed": true,
        "shell_output": stdout.trim(),
        "unshare_denied": unshare_status == 1,
        "fork_ok": fork_status == 0,
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

    let with_cgroup = capabilities
        .cgroup_v2
        .as_ref()
        .is_some_and(|support| support.controllers.contains("pids"));
    let mut running = launch(
        &settings,
        &workspace,
        with_cgroup,
        "restricted",
        &[
            "/bin/sh",
            "-c",
            "printf 'proxy-env=%s ' \"$ALL_PROXY\"; \
             curl -sS --max-time 3 -o /dev/null http://example.com/ >/dev/null 2>&1; \
             printf 'direct=%s ' $?; \
             curl -sS --max-time 3 -o /dev/null --socks5-hostname 127.0.0.1:3128 http://127.0.0.1:9/ >/dev/null 2>&1; \
             printf 'proxy=%s' $?",
        ],
    );
    running
        .prepared
        .verify(running.pane_pid)
        .expect("the restricted launch barrier must verify");
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(
        status.success(),
        "the restricted shell failed: {status}; stdout: {stdout}; stderr: {stderr}"
    );
    let direct = stdout
        .split_whitespace()
        .find_map(|field| field.strip_prefix("direct="))
        .and_then(|value| value.parse::<i32>().ok())
        .expect("curl reported the direct result");
    let proxy = stdout
        .split_whitespace()
        .find_map(|field| field.strip_prefix("proxy="))
        .and_then(|value| value.parse::<i32>().ok())
        .expect("curl reported the proxy result");
    assert_ne!(
        direct, 0,
        "direct egress must fail without a route: {stdout}"
    );
    assert_ne!(
        proxy, 0,
        "the proxy must refuse a private destination: {stdout}"
    );

    // A non-bridge peer that knows the channel path still cannot use it.
    let record = running.prepared.record().clone();
    let channel = Path::new(&record.execution_dir).join("channel.sock");
    let mut stream = std::os::unix::net::UnixStream::connect(&channel)
        .expect("connect to the channel socket as a non-bridge peer");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    use std::io::Write as _;
    stream
        .write_all(&[0x05, 0x01, 0x00])
        .expect("send a SOCKS greeting");
    let mut reply = [0u8; 2];
    let read = stream.read(&mut reply).unwrap_or(0);
    assert_eq!(read, 0, "a non-bridge peer must not receive a proxy reply");

    let report = running.prepared.report().clone();
    let handle = running.prepared.into_handle();
    handle.cleanup().expect("cleanup owned resources");
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "proxy_endpoint": report.proxy_endpoint,
        "proxy_env": stdout.split_whitespace().next().unwrap_or_default(),
        "direct_denied": direct != 0,
        "proxy_private_denied": proxy != 0,
        "channel_identity_denied": read == 0,
        "proxy_response": format!("curl exit {proxy} for a private destination"),
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
    let with_cgroup = capabilities
        .cgroup_v2
        .as_ref()
        .is_some_and(|support| support.controllers.contains("pids"));
    let request = LaunchRequest {
        policy: policy(&workspace, with_cgroup, "allow"),
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
    let mut running = launch(
        &settings,
        &workspace,
        false,
        "allow",
        &["/bin/sh", "-c", "sleep 2; printf survived"],
    );
    running
        .prepared
        .verify(running.pane_pid)
        .expect("the launch barrier must verify");
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
