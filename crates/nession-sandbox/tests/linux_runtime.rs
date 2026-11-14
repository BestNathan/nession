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

    /// Attach the Agent-owned shared EROFS mount manager (#3449).
    pub(super) fn attach_mount_manager(settings: &mut SandboxSettings, dir: &Path) {
        let image_root = settings
            .erofs_image_root
            .clone()
            .expect("the composition fixture authorizes an image root");
        let manager = nession_erofs::mount_manager::MountManager::open(
            nession_erofs::mount_manager::MountManagerConfig {
                root: dir.join("erofs-mounts"),
                settings: nession_erofs::mount::MountSettings::new(
                    settings.erofsfuse_path.clone(),
                    settings.fusermount_path.clone(),
                ),
                authorized_roots: vec![image_root],
                pinner: None,
            },
        )
        .expect("open the shared EROFS mount manager");
        settings.mount_manager = Some(manager);
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
        for file in [
            "pids.max",
            "memory.max",
            "memory.high",
            "cpu.max",
            "cpu.weight",
            "memory.oom.group",
        ] {
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

    /// Build an EROFS image with the product's fixed packaging argv.
    pub(super) fn mkfs_erofs(source: &Path, image: &Path) {
        let status = Command::new("mkfs.erofs") // not-tmux: test fixture builds an EROFS image
            .args([
                "-T",
                "0",
                "-U",
                "11111111-1111-4111-8111-111111111111",
                "-b",
                "4096",
            ])
            .arg(image)
            .arg(source)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run mkfs.erofs");
        assert!(
            status.success(),
            "mkfs.erofs failed for {}",
            image.display()
        );
    }

    fn copy_file_preserving_path(root: &Path, file: &Path) {
        let relative = file
            .strip_prefix("/")
            .unwrap_or_else(|_| panic!("not absolute: {}", file.display()));
        let destination = root.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).expect("copy parent");
        }
        std::fs::copy(file, &destination).expect("copy file");
    }

    fn copy_libs(root: &Path, binary: &Path) {
        let output = Command::new("ldd") // not-tmux: test fixture resolves shared libraries
            .arg(binary)
            .output()
            .expect("run ldd");
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(path) = line.split_whitespace().find(|token| token.starts_with('/')) {
                copy_file_preserving_path(root, Path::new(path));
            }
        }
    }

    /// A minimal glibc Base Runtime: shell, git, the bridge's loader/libs and
    /// the mountpoint directories Bubblewrap needs on a read-only root.
    pub(super) fn build_base_runtime(root: &Path, bridge: &Path) {
        for binary in [
            Path::new("/bin/sh"),
            Path::new("/usr/bin/git"),
            Path::new("/usr/bin/sleep"),
            Path::new("/bin/sleep"),
        ] {
            if !binary.exists() {
                continue;
            }
            copy_file_preserving_path(root, binary);
            copy_libs(root, binary);
        }
        copy_libs(root, bridge);
        for file in ["/etc/passwd", "/etc/group"] {
            if Path::new(file).exists() {
                copy_file_preserving_path(root, Path::new(file));
            }
        }
        for directory in [
            "workspace",
            "opt/node",
            "opt/rust",
            "home",
            "tmp",
            "dev",
            "proc",
            "run/nession",
        ] {
            std::fs::create_dir_all(root.join(directory)).expect("base runtime directory");
        }
    }

    pub(super) fn require_composition_tools() {
        for (tool, args) in [
            ("bwrap", vec!["--version"]),
            ("mkfs.erofs", vec!["-V"]),
            ("erofsfuse", vec!["-V"]),
            ("fusermount3", vec!["-V"]),
            ("fuse-overlayfs", vec!["--version"]),
        ] {
            let output = Command::new(tool) // not-tmux: composition helper version probe
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            assert!(
                output.is_ok(),
                "the composition proof requires `{tool}` on this runner"
            );
        }
        assert!(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/fuse")
                .is_ok(),
            "the composition proof requires a usable /dev/fuse"
        );
    }

    pub(super) struct CompositionImages {
        pub(super) base: PathBuf,
        pub(super) project: PathBuf,
        pub(super) toolchain: PathBuf,
        pub(super) base_digest: String,
        pub(super) project_digest: String,
        pub(super) toolchain_digest: String,
    }

    pub(super) fn build_composition_images(dir: &Path) -> CompositionImages {
        let images = dir.join("images");
        let base_source = dir.join("base-source");
        let project_source = dir.join("project-source");
        let toolchain_source = dir.join("toolchain-source");
        for path in [&images, &base_source, &project_source, &toolchain_source] {
            std::fs::create_dir_all(path).expect("fixture directory");
        }
        build_base_runtime(
            &base_source,
            Path::new(env!("CARGO_BIN_EXE_nession-sandbox-bridge")),
        );
        std::fs::write(project_source.join("project.txt"), "project\n").expect("project file");
        std::fs::write(toolchain_source.join("marker"), "toolchain\n").expect("tool file");
        let base = images.join("base.erofs");
        let project = images.join("project.erofs");
        let toolchain = images.join("toolchain.erofs");
        mkfs_erofs(&base_source, &base);
        mkfs_erofs(&project_source, &project);
        mkfs_erofs(&toolchain_source, &toolchain);
        CompositionImages {
            base_digest: sha256_file(&base),
            project_digest: sha256_file(&project),
            toolchain_digest: sha256_file(&toolchain),
            base,
            project,
            toolchain,
        }
    }

    /// Canonical digest spelling for the shared mount manager API.
    pub(super) fn sha256_digest(hex: &str) -> String {
        format!("sha256:{hex}")
    }

    pub(super) fn sha256_file(file: &Path) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        let mut handle = std::fs::File::open(file).expect("open image");
        let mut buffer = [0u8; 64 * 1024];
        loop {
            use std::io::Read as _;
            let read = handle.read(&mut buffer).expect("read image");
            if read == 0 {
                break;
            }
            hasher.update(buffer.get(..read).expect("read chunk"));
        }
        let digest = hasher.finalize();
        let mut text = String::with_capacity(64);
        for byte in digest {
            text.push_str(&format!("{byte:02x}"));
        }
        text
    }

    pub(super) fn composition_policy(
        base_image: &Path,
        base_digest: &str,
        workspace_image: &Path,
        workspace_digest: &str,
        workspace_write: &Path,
        toolchain_image: &Path,
        toolchain_digest: &str,
    ) -> SandboxPolicy {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "composition": {
                    "base": {
                        "digest": format!("sha256:{base_digest}"),
                        "source": base_image.to_string_lossy()
                    },
                    "workspace": {
                        "image": {
                            "digest": format!("sha256:{workspace_digest}"),
                            "source": workspace_image.to_string_lossy()
                        },
                        "write": workspace_write.to_string_lossy()
                    },
                    "toolchains": [
                        {
                            "digest": format!("sha256:{toolchain_digest}"),
                            "source": toolchain_image.to_string_lossy(),
                            "target": "/opt/node"
                        }
                    ]
                }
            },
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required"
        }))
        .expect("composition policy fixture")
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
fn native_beyond_v1_controls_apply_readback_and_fail_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let base_settings = settings(dir.path());
    let capabilities = probe(&base_settings);
    if capabilities.backend.is_none() {
        eprintln!("sandbox backend unavailable on this host; native cgroup proof skipped");
        return;
    }
    let Some(parent_support) = capabilities.cgroup_v2.as_ref() else {
        eprintln!("no delegated cgroup v2 root on this host; native cgroup proof skipped");
        return;
    };
    if !parent_support.controllers.contains("cpu") || !parent_support.controllers.contains("memory")
    {
        eprintln!("cpu/memory controllers are not delegated; native cgroup proof skipped");
        return;
    }

    // A private subtree keeps this proof isolated from any concurrent cgroup
    // test and lets the test assert its own cleanup exactly.
    let relative = parent_support
        .relative_root
        .join(format!("native-cgroup-proof-{}", std::process::id()));
    let root_mount = cgroup_mount(relative.to_str().expect("utf-8 cgroup path"));
    let mut settings = settings(dir.path());
    settings.cgroup_root = Some(relative.clone());
    let private = probe(&settings);
    assert!(
        private.cgroup_v2.is_some(),
        "the private delegated subtree must be measurable"
    );

    let request = LaunchRequest {
        policy: serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "resource": { "cgroup_v2": {
                "cpu.weight": "100",
                "memory.high": "max",
                "pids.max": "64"
            } },
            "enforcement": "required"
        }))
        .expect("native policy fixture"),
        session_name: "native-cgroup-proof".to_string(),
        instance_id: "instance".to_string(),
        working_dir: workspace.to_string_lossy().into_owned(),
        inner_command: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 1".to_string(),
        ],
        tmux_socket: None,
    };
    let prepared = prepare(&request, &settings).expect("prepare native beyond-V1 writes");
    let record = prepared.record().clone();
    let cgroup_path = record.cgroup_path.clone().expect("execution cgroup");
    let child = cgroup_mount(&cgroup_path);
    let read = |file: &str| {
        std::fs::read_to_string(child.join(file))
            .expect("read effective control file")
            .trim()
            .to_string()
    };
    let cpu_weight = read("cpu.weight");
    let memory_high = read("memory.high");
    assert_eq!(cpu_weight, "100");
    assert_eq!(memory_high, "max");
    let effective = record
        .effective_policy
        .as_ref()
        .and_then(|policy| policy.resource.as_ref())
        .expect("resource policy");
    assert_eq!(
        effective.cgroup_v2.0.get("cpu.weight").map(String::as_str),
        Some(cpu_weight.as_str()),
        "inside reports the kernel readback, not the draft"
    );

    let handle = prepared.into_handle();
    let cleanup = handle.cleanup().expect("cleanup owned resources");
    assert!(cleanup.removed);
    assert!(
        child_names(&root_mount).is_empty(),
        "a successful execution leaves no child cgroup"
    );

    // The kernel is authoritative for values: an invalid cpu.max must fail
    // after the write attempt with the OS error, remove the owned child, and
    // never fall back to Native.
    let mut bad = request.clone();
    bad.policy = serde_json::from_value(serde_json::json!({
        "version": 1,
        "enabled": true,
        "resource": { "cgroup_v2": { "cpu.max": "not-a-native-value" } },
        "enforcement": "required"
    }))
    .expect("invalid native policy fixture");
    let error = prepare(&bad, &settings)
        .err()
        .expect("the kernel must reject the value");
    let text = error.to_string();
    assert!(text.contains("cpu.max"), "{text}");
    assert!(
        text.contains("os error 22") || text.contains("Invalid argument"),
        "the exact kernel error must be reported: {text}"
    );
    let remaining = child_names(&root_mount);
    assert!(
        remaining.is_empty(),
        "a failed prepare removed its owned child: {remaining:?}"
    );

    // Discovery is the measured file list: a key the child never exposed must
    // fail closed rather than being written on faith.
    let mut absent = request;
    absent.policy = serde_json::from_value(serde_json::json!({
        "version": 1,
        "enabled": true,
        "resource": { "cgroup_v2": { "futuristic.max": "1" } },
        "enforcement": "required"
    }))
    .expect("absent controller fixture");
    let error = prepare(&absent, &settings)
        .err()
        .expect("undiscovered keys must fail closed");
    assert!(
        error.to_string().contains("futuristic.max"),
        "the refusal names the key: {error}"
    );
    assert!(child_names(&root_mount).is_empty());

    let _ = std::fs::remove_dir(&root_mount);
    print_evidence(&serde_json::json!({
        "cgroup_root": relative.display().to_string(),
        "cpu_weight_readback": cpu_weight,
        "memory_high_readback": memory_high,
        "effective_policy_matches_readback": true,
        "invalid_value_error": text,
        "failed_child_removed": remaining,
        "absent_key_refused": true,
        "cgroup_removed": true,
    }));
}

fn child_names(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
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

#[test]
fn an_erofs_composition_runs_a_shell_with_a_writable_overlay_workspace() {
    require_composition_tools();

    let dir = tempfile::tempdir().expect("tempdir");
    let images = dir.path().join("images");
    let base_source = dir.path().join("base-source");
    let project_source = dir.path().join("project-source");
    let toolchain_source = dir.path().join("toolchain-source");
    for path in [&images, &base_source, &project_source, &toolchain_source] {
        std::fs::create_dir_all(path).expect("fixture directory");
    }
    build_base_runtime(
        &base_source,
        Path::new(env!("CARGO_BIN_EXE_nession-sandbox-bridge")),
    );
    std::fs::write(project_source.join("project.txt"), "project\n").expect("project file");
    std::fs::write(toolchain_source.join("marker"), "toolchain\n").expect("tool file");

    let base_image = images.join("base.erofs");
    let project_image = images.join("project.erofs");
    let toolchain_image = images.join("toolchain.erofs");
    mkfs_erofs(&base_source, &base_image);
    mkfs_erofs(&project_source, &project_image);
    mkfs_erofs(&toolchain_source, &toolchain_image);
    let base_digest = sha256_file(&base_image);
    let project_digest = sha256_file(&project_image);
    let toolchain_digest = sha256_file(&toolchain_image);

    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let workspace_write = settings.state_dir.join("workspaces").join("composition");
    std::fs::create_dir_all(&workspace_write).expect("workspace write");

    let policy = composition_policy(
        &base_image,
        &base_digest,
        &project_image,
        &project_digest,
        &workspace_write,
        &toolchain_image,
        &toolchain_digest,
    );
    let script = "\
set -eu
echo SHELL-OK
printf 'sandbox\n' > /workspace/from-sandbox
read line < /workspace/project.txt
[ \"$line\" = project ] && echo LOWER-OK
git init -q /workspace/repo
cd /workspace/repo
git status --porcelain > /tmp/status
[ -f .git/HEAD ] && echo GIT-OK
[ -f /opt/node/marker ] && echo TOOL-OK
erofs=no; overlay=no
while IFS= read -r mount; do
  case \"$mount\" in
    *fuse.erofsfuse*) erofs=yes ;;
    *fuse.fuse-overlayfs*) overlay=yes ;;
  esac
done < /proc/self/mountinfo
[ \"$erofs\" = yes ] && echo EROFS-OK
[ \"$overlay\" = yes ] && echo OVERLAY-OK
[ ! -e /etc/shadow ] && echo HIDDEN-OK
";
    let mut running = launch(
        &settings,
        LaunchRequest {
            policy,
            session_name: format!("composition-{}", std::process::id()),
            instance_id: "instance-composition".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
            tmux_socket: None,
        },
    );
    verify_or_report(&mut running, "the composition launch barrier must verify");
    let record = running.prepared.record().clone();
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(
        status.success(),
        "the composed shell failed: status={status:?} stdout={stdout} stderr={stderr}"
    );
    for marker in [
        "SHELL-OK",
        "LOWER-OK",
        "GIT-OK",
        "TOOL-OK",
        "EROFS-OK",
        "OVERLAY-OK",
        "HIDDEN-OK",
    ] {
        assert!(
            stdout.contains(marker),
            "the composed shell did not prove {marker}: stdout={stdout} stderr={stderr}"
        );
    }
    assert!(
        workspace_write.join("upper").join("from-sandbox").exists(),
        "a sandbox write must land in the bounded overlay upper"
    );

    let mountpoints = record.mounts.clone();
    let shared = record.shared_mounts.clone();
    let report = running
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the composition");
    for mountpoint in &mountpoints {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(mountpoint)),
            "cleanup must unmount the execution-owned {mountpoint}"
        );
    }
    for consumer in &shared {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "the last consumer must release the shared mount {}",
            consumer.mountpoint
        );
    }
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "execution_id": record.execution_id,
        "shell": "ok",
        "git": "ok",
        "toolchain": "ok",
        "erofs_mount": true,
        "overlay_mount": true,
        "host_etc_shadow_hidden": true,
        "mounts_unmounted": mountpoints.len() + shared.len(),
        "shared_mounts": shared.len(),
        "cleanup_evidence": report.evidence_lines(),
    }));
}

#[test]
fn two_compositions_share_images_and_release_only_their_own_mounts() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let first_write = settings.state_dir.join("workspaces").join("first");
    let second_write = settings.state_dir.join("workspaces").join("second");
    std::fs::create_dir_all(&first_write).expect("first workspace");
    std::fs::create_dir_all(&second_write).expect("second workspace");

    let launch_one = |write: &Path, name: &str| {
        launch(
            &settings,
            LaunchRequest {
                policy: composition_policy(
                    &images.base,
                    &images.base_digest,
                    &images.project,
                    &images.project_digest,
                    write,
                    &images.toolchain,
                    &images.toolchain_digest,
                ),
                session_name: name.to_string(),
                instance_id: format!("instance-{name}"),
                working_dir: "/workspace".to_string(),
                inner_command: vec![
                    "/bin/sh".to_string(),
                    "-c".to_string(),
                    "echo READY; sleep 5".to_string(),
                ],
                tmux_socket: None,
            },
        )
    };
    let mut first = launch_one(&first_write, "composition-first");
    let mut second = launch_one(&second_write, "composition-second");
    verify_or_report(&mut first, "the first composition barrier must verify");
    verify_or_report(&mut second, "the second composition barrier must verify");
    let first_record = first.prepared.record().clone();
    let second_record = second.prepared.record().clone();
    // One verified digest maps to exactly one physical read-only mount, and
    // both executions consume it through distinct leases (#3449).
    assert_eq!(
        first_record.shared_mounts.len(),
        second_record.shared_mounts.len()
    );
    let mut first_shared: Vec<&str> = first_record
        .shared_mounts
        .iter()
        .map(|shared| shared.mountpoint.as_str())
        .collect();
    let mut second_shared: Vec<&str> = second_record
        .shared_mounts
        .iter()
        .map(|shared| shared.mountpoint.as_str())
        .collect();
    first_shared.sort_unstable();
    second_shared.sort_unstable();
    assert_eq!(
        first_shared, second_shared,
        "the two executions must share the same physical EROFS mountpoints"
    );
    for consumer in &first_record.shared_mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "the shared mount {} must be live",
            consumer.mountpoint
        );
        let status = settings
            .mount_manager
            .as_ref()
            .expect("mount manager")
            .lookup(&consumer.digest)
            .expect("a known shared digest");
        assert_eq!(status.consumers, 2, "both executions hold a lease");
    }
    for mountpoint in &first_record.mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(mountpoint)),
            "the first execution-owned mount {mountpoint} must be live"
        );
    }
    for mountpoint in &second_record.mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(mountpoint)),
            "the second execution-owned mount {mountpoint} must be live"
        );
    }

    // Client detach must not release the execution or its mounts.
    drop(first.child.stdout.take());
    drop(first.child.stderr.take());
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        Path::new(&format!("/proc/{}", first.pane_pid)).exists(),
        "the detached composition Pane must stay alive"
    );
    for consumer in &first_record.shared_mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "a detached composition must keep {} mounted",
            consumer.mountpoint
        );
    }

    let _ = first.child.kill();
    let _ = first.child.wait();
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the first composition");
    for mountpoint in &first_record.mounts {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(mountpoint)),
            "the first execution-owned {mountpoint} must be unmounted"
        );
    }
    for consumer in &first_record.shared_mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "releasing one consumer must keep the shared mount {} live",
            consumer.mountpoint
        );
        let status = settings
            .mount_manager
            .as_ref()
            .expect("mount manager")
            .lookup(&consumer.digest)
            .expect("a known shared digest");
        assert_eq!(
            status.consumers, 1,
            "the surviving execution keeps its lease"
        );
    }
    assert_cleaned(&settings, &first_record);
    assert!(
        Path::new(&format!("/proc/{}", second.pane_pid)).exists(),
        "the second composition must stay alive when only its peer is cleaned"
    );

    let _ = second.child.kill();
    let _ = second.child.wait();
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the second composition");
    for mountpoint in second_record.mounts.iter() {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(mountpoint)),
            "the second execution-owned {mountpoint} must be unmounted"
        );
    }
    for consumer in &second_record.shared_mounts {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "the last consumer must unmount {}",
            consumer.mountpoint
        );
        let status = settings
            .mount_manager
            .as_ref()
            .expect("mount manager")
            .lookup(&consumer.digest)
            .expect("a known shared digest");
        assert_eq!(status.consumers, 0);
        assert!(!status.mounted, "the physical mount is gone");
    }
    assert_cleaned(&settings, &second_record);
    print_evidence(&serde_json::json!({
        "first_execution": first_record.execution_id,
        "second_execution": second_record.execution_id,
        "detached_pane_survived": true,
        "shared_images_remained_mounted": true,
        "one_physical_mount_per_digest": true,
        "first_mounts_released": first_record.mounts.len() + first_record.shared_mounts.len(),
        "second_mounts_released": second_record.mounts.len() + second_record.shared_mounts.len(),
        "shared_mounts": first_record.shared_mounts.len(),
    }));
}

// ---------------------------------------------------------------------------
// #3449 shared, recoverable EROFS mount manager
// ---------------------------------------------------------------------------

fn standalone_manager(
    root: &Path,
    images: &Path,
    erofsfuse: &Path,
    fusermount: &Path,
) -> std::sync::Arc<nession_erofs::mount_manager::MountManager> {
    match nession_erofs::mount_manager::MountManager::open(
        nession_erofs::mount_manager::MountManagerConfig {
            root: root.to_path_buf(),
            settings: nession_erofs::mount::MountSettings::new(erofsfuse, fusermount),
            authorized_roots: vec![images.to_path_buf()],
            pinner: None,
        },
    ) {
        Ok(manager) => manager,
        Err(error) => panic!("open a shared EROFS mount manager: {error:#}"),
    }
}

fn default_helpers(dir: &Path) -> (PathBuf, PathBuf) {
    let erofsfuse = dir.join("real-erofsfuse");
    let fusermount = dir.join("real-fusermount");
    // Resolve the real helpers through PATH so the test proves the native
    // path, not a fixture.
    let Some(erofsfuse_source) = which("erofsfuse") else {
        panic!("erofsfuse is available");
    };
    let Some(fusermount_source) = which("fusermount3") else {
        panic!("fusermount3 is available");
    };
    if let Err(error) = std::os::unix::fs::symlink(&erofsfuse_source, &erofsfuse) {
        panic!("link erofsfuse: {error}");
    }
    if let Err(error) = std::os::unix::fs::symlink(&fusermount_source, &fusermount) {
        panic!("link fusermount3: {error}");
    }
    (erofsfuse, fusermount)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[test]
fn a_restarted_manager_adopts_a_verified_mount_and_never_serves_a_disappeared_one() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let image_root = dir.path().join("images");
    let (erofsfuse, fusermount) = default_helpers(dir.path());
    let root = dir.path().join("standalone-mounts");
    let digest = sha256_digest(&images.base_digest);

    let manager_a = standalone_manager(&root, &image_root, &erofsfuse, &fusermount);
    let verified = nession_erofs::mount_manager::VerifiedImage::new(digest.clone(), images.base)
        .expect("verified image");
    let lease = manager_a.acquire(&verified, "exec-live").expect("acquire");
    let generation = lease.generation().to_string();
    let mountpoint = lease.mountpoint().to_path_buf();
    assert!(
        mountpoint.join("bin/sh").exists(),
        "the shared image is readable"
    );
    // Simulate an Agent process that exits without dropping its lease.
    std::mem::forget(lease);
    std::mem::forget(manager_a);

    let manager_b = standalone_manager(&root, &image_root, &erofsfuse, &fusermount);
    let report = manager_b.adopt_consumers(&[nession_erofs::mount_manager::ConsumerRef {
        digest: digest.clone(),
        execution_id: "exec-live".to_string(),
        generation: generation.clone(),
    }]);
    assert_eq!(report.adopted.len(), 1, "{report:?}");
    assert!(report.unavailable.is_empty(), "{report:?}");
    let status = manager_b.lookup(&digest).expect("adopted status");
    assert_eq!(status.consumers, 1);
    assert!(status.mounted);
    assert_eq!(status.generation.as_deref(), Some(generation.as_str()));
    assert!(
        mountpoint.join("bin/sh").exists(),
        "the adopted mount is readable"
    );

    manager_b
        .release_consumers(&digest, "exec-live", Some(&generation))
        .expect("release the adopted consumer");
    assert!(
        !nession_sandbox::linux::erofs::is_mounted(&mountpoint),
        "the last adopted consumer releases the physical mount"
    );

    // Disappeared mount: a live record must not be silently served.
    let lease = manager_b.acquire(&verified, "exec-gone").expect("acquire");
    let generation = lease.generation().to_string();
    let mountpoint = lease.mountpoint().to_path_buf();
    std::mem::forget(lease);
    let status = Command::new("fusermount3") // not-tmux: test forces mount loss
        .arg("-u")
        .arg(&mountpoint)
        .status()
        .expect("run fusermount3");
    assert!(status.success());
    let manager_c = standalone_manager(&root, &image_root, &erofsfuse, &fusermount);
    let report = manager_c.adopt_consumers(&[nession_erofs::mount_manager::ConsumerRef {
        digest: digest.clone(),
        execution_id: "exec-gone".to_string(),
        generation,
    }]);
    assert!(report.adopted.is_empty(), "{report:?}");
    assert!(
        report
            .unavailable
            .iter()
            .any(|(_, reason)| reason.contains("no longer present")),
        "a missing mount is reported unavailable: {report:?}"
    );
    assert!(
        !manager_c.lookup(&digest).expect("status").mounted,
        "an absent mount is never served as live"
    );
    let mut protected = std::collections::HashSet::new();
    protected.insert(digest.clone());
    assert!(
        manager_c.reclaim_orphans(&protected).reclaimed.is_empty(),
        "a record-protected digest is not reclaimed"
    );
    assert!(
        manager_c
            .reclaim_orphans(&std::collections::HashSet::new())
            .reclaimed
            .contains(&digest),
        "an unprotected stale identity is reclaimed"
    );
    print_evidence(&serde_json::json!({
        "adopted_after_restart": true,
        "missing_mount_reported": true,
        "stale_identity_reclaimed": true,
    }));
}

#[test]
fn a_failed_shared_unmount_is_durable_bounded_and_retryable() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let image_root = dir.path().join("images");
    let (erofsfuse, _) = default_helpers(dir.path());
    let failing = dir.path().join("fail-once-fusermount");
    std::fs::write(
        &failing,
        "#!/bin/sh\n\
         if [ ! -f \"$0.counter\" ]; then : > \"$0.counter\"; exit 1; fi\n\
         exec fusermount3 \"$@\"\n",
    )
    .expect("write failing fusermount");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&failing).expect("stat").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&failing, permissions).expect("chmod");
    }
    let root = dir.path().join("standalone-mounts");
    let digest = sha256_digest(&images.base_digest);
    let manager = standalone_manager(&root, &image_root, &erofsfuse, &failing);
    let verified = nession_erofs::mount_manager::VerifiedImage::new(digest.clone(), images.base)
        .expect("verified image");
    let lease = manager.acquire(&verified, "exec-unmount").expect("acquire");
    let generation = lease.generation().to_string();
    let mountpoint = lease.mountpoint().to_path_buf();
    let started = std::time::Instant::now();
    let error = lease.release().expect_err("the first unmount must fail");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "the failed unmount is bounded"
    );
    assert!(format!("{error:#}").contains("failed"), "{error:#}");
    let status = manager.lookup(&digest).expect("status");
    assert_eq!(
        status.state,
        nession_erofs::mount_manager::MountState::Failed
    );
    assert!(status.mounted, "the live mount is retained");
    assert_eq!(status.consumers, 0);
    assert!(status.failure.is_some(), "the failure is durable evidence");

    manager
        .release_consumers(&digest, "exec-unmount", Some(&generation))
        .expect("the retry succeeds");
    assert!(
        !nession_sandbox::linux::erofs::is_mounted(&mountpoint),
        "the retry removes the physical mount"
    );
    assert!(manager.lookup(&digest).expect("status").failure.is_none());
    print_evidence(&serde_json::json!({
        "failed_unmount_retained": true,
        "retry_succeeded": true,
        "bounded": true,
    }));
}

#[test]
fn concurrent_shared_acquisitions_keep_one_physical_mount() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let image_root = dir.path().join("images");
    let (erofsfuse, fusermount) = default_helpers(dir.path());
    let root = dir.path().join("standalone-mounts");
    let digest = sha256_digest(&images.base_digest);
    let manager = standalone_manager(&root, &image_root, &erofsfuse, &fusermount);
    let verified = nession_erofs::mount_manager::VerifiedImage::new(digest.clone(), images.base)
        .expect("verified image");

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
    let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut threads = Vec::new();
    for index in 0..4 {
        let manager = std::sync::Arc::clone(&manager);
        let verified = verified.clone();
        let barrier = std::sync::Arc::clone(&barrier);
        let observed = std::sync::Arc::clone(&observed);
        threads.push(std::thread::spawn(move || {
            let execution = format!("exec-{index}");
            let lease = manager.acquire(&verified, &execution).expect("acquire");
            observed.lock().expect("observed").push((
                lease.mountpoint().to_path_buf(),
                lease.generation().to_string(),
            ));
            barrier.wait();
            barrier.wait();
            lease.release().expect("release");
        }));
    }
    barrier.wait();
    let observed = observed.lock().expect("observed").clone();
    assert_eq!(observed.len(), 4);
    let mountpoint = observed[0].0.clone();
    let generation = observed[0].1.clone();
    for (candidate, candidate_generation) in &observed {
        assert_eq!(
            candidate, &mountpoint,
            "one physical mount serves all consumers"
        );
        assert_eq!(
            candidate_generation, &generation,
            "all consumers share one mount generation"
        );
    }
    let status = manager.lookup(&digest).expect("status");
    assert_eq!(status.consumers, 4);
    assert!(status.mounted);
    barrier.wait();
    for thread in threads {
        thread.join().expect("consumer thread");
    }
    let status = manager.lookup(&digest).expect("status");
    assert_eq!(status.consumers, 0);
    assert!(
        !status.mounted,
        "the last release unmounts the physical mount"
    );
    print_evidence(&serde_json::json!({
        "consumers": 4,
        "physical_mounts": 1,
        "generation": generation,
    }));
}
