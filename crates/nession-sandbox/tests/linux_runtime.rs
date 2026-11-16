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
        settings.mount_manager = Some(manager.clone());
        // The shared writable Overlay owner (#3582). Its authorized roots are
        // the durable managed Workspace root and the execution workspace root.
        let mut workspace_roots = vec![settings.state_dir.clone()];
        if let Some(root) = &settings.agent_workspaces_root {
            workspace_roots.push(root.clone());
        }
        let lower: std::sync::Arc<dyn nession_sandbox::mount::overlay::LowerProvider> = manager;
        let overlay = nession_sandbox::mount::overlay::OverlayMountManager::open(
            nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                root: dir.join("erofs-overlays"),
                workspace_roots,
                settings: nession_sandbox::mount::overlay::OverlaySettings::new(
                    settings.fuse_overlayfs_path.clone(),
                    settings.fusermount_path.clone(),
                ),
                lower,
                identity: format!("sandbox-test-{}", std::process::id()),
            },
        )
        .expect("open the shared Workspace Overlay manager");
        settings.overlay_manager = Some(overlay);
    }

    /// Create a workspace directory with its durable Overlay upper/work.
    pub(super) fn workspace_storage(
        path: &Path,
    ) -> nession_sandbox::mount::overlay::OverlayStoragePaths {
        std::fs::create_dir_all(path).expect("workspace");
        nession_sandbox::mount::overlay::storage::initialize(path)
            .expect("initialize the durable Overlay storage")
    }

    /// How many physical `fuse-overlayfs` mounts currently exist at `path`.
    pub(super) fn overlay_mount_count(path: &Path) -> usize {
        nession_erofs::mount::mount_entries()
            .iter()
            .filter(|entry| {
                entry.mountpoint == path && entry.fs_type.to_ascii_lowercase().contains("overlayfs")
            })
            .count()
    }

    pub(super) fn executable_script(path: &Path, body: &str) {
        install_via_a_child(path, body);
    }

    /// Install `body` at `bin` with the file created by a **child** process.
    ///
    /// `fork` copies this process's descriptor table, so writing the path a
    /// test executes can leave a concurrently forked child holding it writable
    /// until that child's own `exec`; an `exec` of the same inode then fails
    /// with `ETXTBSY` (#1026, #3504, #3612). The body goes to a path that is
    /// never exec'd and a child `cp` creates `bin`, so this process never
    /// holds a write descriptor on the executable. `chmod` does not open it,
    /// and `rename` is not equivalent (same inode).
    fn install_via_a_child(bin: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let staged = bin.with_extension("src");
        std::fs::write(&staged, body).expect("stage helper script");
        let status = std::process::Command::new("cp")
            .arg(&staged)
            .arg(bin)
            .status()
            .expect("install helper script");
        let _ = std::fs::remove_file(&staged);
        assert!(status.success(), "installing the helper script: cp failed");
        let mut permissions = std::fs::metadata(bin).expect("stat helper").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(bin, permissions).expect("chmod helper");
    }

    pub(super) fn project_image(
        images: &CompositionImages,
    ) -> nession_erofs::mount_manager::VerifiedImage {
        nession_erofs::mount_manager::VerifiedImage::new(
            format!("sha256:{}", images.project_digest),
            images.project.clone(),
        )
        .expect("verified project image")
    }

    /// Open a fresh lower + Overlay manager pair over the same roots, as a new
    /// Agent process would.
    pub(super) fn reopen_managers(settings: &mut SandboxSettings, dir: &Path, identity: &str) {
        settings.mount_manager = None;
        settings.overlay_manager = None;
        attach_named_managers(settings, dir, identity);
    }

    pub(super) fn attach_named_managers(
        settings: &mut SandboxSettings,
        dir: &Path,
        identity: &str,
    ) {
        let image_root = settings
            .erofs_image_root
            .clone()
            .expect("the composition fixture authorizes an image root");
        let lower = nession_erofs::mount_manager::MountManager::open(
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
        let mut workspace_roots = vec![settings.state_dir.clone()];
        if let Some(root) = &settings.agent_workspaces_root {
            workspace_roots.push(root.clone());
        }
        let lower_provider: std::sync::Arc<dyn nession_sandbox::mount::overlay::LowerProvider> =
            lower.clone();
        let overlay = nession_sandbox::mount::overlay::OverlayMountManager::open(
            nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                root: dir.join("erofs-overlays"),
                workspace_roots,
                settings: nession_sandbox::mount::overlay::OverlaySettings::new(
                    settings.fuse_overlayfs_path.clone(),
                    settings.fusermount_path.clone(),
                ),
                lower: lower_provider,
                identity: identity.to_string(),
            },
        )
        .expect("open the shared Workspace Overlay manager");
        settings.mount_manager = Some(lower);
        settings.overlay_manager = Some(overlay);
    }

    /// The child side of the crash-restart proof: acquire the shared Overlay,
    /// write through it and exit without destructors, leaving the physical mounts
    /// and durable identity exactly as an Agent crash would.
    pub(super) fn overlay_crash_child(root: PathBuf) -> ! {
        let managed = root.join("agent-workspaces").join("ws_child");
        let image_root = root.join("images");
        let fusermount = which("fusermount3").expect("fusermount3 for the crash fixture");
        let lower = nession_erofs::mount_manager::MountManager::open(
            nession_erofs::mount_manager::MountManagerConfig {
                root: root.join("erofs-mounts"),
                settings: nession_erofs::mount::MountSettings::new(
                    which("erofsfuse").expect("erofsfuse for the crash fixture"),
                    fusermount.clone(),
                ),
                authorized_roots: vec![image_root.clone()],
                pinner: None,
            },
        )
        .expect("open the crash lower manager");
        let lower_provider: std::sync::Arc<dyn nession_sandbox::mount::overlay::LowerProvider> =
            lower;
        let manager = nession_sandbox::mount::overlay::OverlayMountManager::open(
            nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                root: root.join("erofs-overlays"),
                workspace_roots: vec![root.join("agent-workspaces")],
                settings: nession_sandbox::mount::overlay::OverlaySettings::new(
                    which("fuse-overlayfs").expect("fuse-overlayfs for the crash fixture"),
                    fusermount,
                ),
                lower: lower_provider,
                identity: "overlay-crash".to_string(),
            },
        )
        .expect("open the crash Overlay manager");
        let key = manager
            .resolve_workspace(&managed)
            .expect("the crash workspace is authorized");
        let digest = format!(
            "sha256:{}",
            std::fs::read_to_string(image_root.join("project.digest"))
                .expect("the project digest")
                .trim()
        );
        let image = nession_erofs::mount_manager::VerifiedImage::new(
            digest,
            image_root.join("project.erofs"),
        )
        .expect("the verified project image");
        let lease = manager
            .acquire(
                &nession_sandbox::mount::overlay::OverlayRequest::single(key, image),
                "exec-child",
            )
            .expect("acquire the crash Overlay");
        std::fs::write(lease.mountpoint().join("child-edit.txt"), b"child edit\n")
            .expect("write through the merged view");
        let binding = serde_json::to_vec(&lease.binding()).expect("serialize the binding");
        std::fs::write(root.join("child-binding.json"), binding).expect("write the child binding");
        std::process::exit(0);
    }

    pub(super) fn crash_managers(
        root: &Path,
    ) -> (
        std::sync::Arc<nession_erofs::mount_manager::MountManager>,
        std::sync::Arc<nession_sandbox::mount::overlay::OverlayMountManager>,
    ) {
        let fusermount = which("fusermount3").expect("fusermount3");
        let lower = nession_erofs::mount_manager::MountManager::open(
            nession_erofs::mount_manager::MountManagerConfig {
                root: root.join("erofs-mounts"),
                settings: nession_erofs::mount::MountSettings::new(
                    which("erofsfuse").expect("erofsfuse"),
                    fusermount.clone(),
                ),
                authorized_roots: vec![root.join("images")],
                pinner: None,
            },
        )
        .expect("open the restarted lower manager");
        let lower_provider: std::sync::Arc<dyn nession_sandbox::mount::overlay::LowerProvider> =
            lower.clone();
        let manager = nession_sandbox::mount::overlay::OverlayMountManager::open(
            nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                root: root.join("erofs-overlays"),
                workspace_roots: vec![root.join("agent-workspaces")],
                settings: nession_sandbox::mount::overlay::OverlaySettings::new(
                    which("fuse-overlayfs").expect("fuse-overlayfs"),
                    fusermount,
                ),
                lower: lower_provider,
                identity: "overlay-crash".to_string(),
            },
        )
        .expect("open the restarted Overlay manager");
        (lower, manager)
    }

    pub(super) fn prepare_crash_root(root: &Path) -> (PathBuf, String) {
        let images = build_composition_images(root);
        std::fs::write(root.join("images/project.digest"), &images.project_digest)
            .expect("write the project digest");
        let managed = root.join("agent-workspaces").join("ws_child");
        workspace_storage(&managed);
        (managed, format!("sha256:{}", images.project_digest))
    }

    pub(super) fn spawn_overlay_crash(root: &Path) {
        let mut child = Command::new(std::env::current_exe().expect("the test executable")) // not-tmux: re-runs this test binary as the crash fixture
            .args([
                "--exact",
                "a_crashed_overlay_owner_is_recovered_only_from_verified_identity",
                "--nocapture",
            ])
            .env("NESSON_OVERLAY_CHILD_ROOT", root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the crash fixture");
        let deadline = Instant::now() + Duration::from_secs(120);
        let status = loop {
            match child.try_wait().expect("wait for the crash fixture") {
                Some(status) => break status,
                None if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("the crash fixture did not exit within 120s");
                }
            }
        };
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        assert!(
            status.success(),
            "the crash fixture failed: stdout={stdout} stderr={stderr}"
        );
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
        launch_with_overlay(settings, request, &[])
    }

    /// Apply the prepared image environment the way the Agent's Session create
    /// does: bounded image defaults first, the composed PATH below an explicit
    /// session PATH, explicit Session ENV last (below the runtime-owned
    /// `NESSON_SANDBOX_*` facts).
    pub(super) fn agent_session_environment(
        prepared: &PreparedSandbox,
        overlay: &[(String, String)],
    ) -> Vec<(String, String)> {
        let image = prepared.image_environment();
        let mut envs = image.defaults.clone();
        if !overlay.iter().any(|(key, _)| key == "PATH") {
            if let Some(path) = nession_sandbox::compose_path_prepend(
                &image.path_prepend,
                std::env::var("PATH").ok().as_deref(),
            ) {
                envs.push(("PATH".to_string(), path));
            }
        }
        envs.extend(overlay.iter().cloned());
        envs.extend(prepared.env().iter().cloned());
        envs
    }

    pub(super) fn launch_with_overlay(
        settings: &SandboxSettings,
        request: LaunchRequest,
        overlay: &[(String, String)],
    ) -> Running {
        let prepared = prepare(&request, settings).expect("prepare an execution");
        let environment = agent_session_environment(&prepared, overlay);
        let program = prepared
            .command()
            .first()
            .expect("the launcher has a program");
        let mut command = Command::new(program); // not-tmux: spawns the sandbox trusted launcher
        command.args(prepared.command().get(1..).unwrap_or_default());
        for (key, value) in &environment {
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
            "opt/go",
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
        std::fs::create_dir_all(toolchain_source.join("bin")).expect("toolchain bin");
        std::fs::write(toolchain_source.join("bin/go-tool"), "#!/bin/sh\nexit 0\n")
            .expect("toolchain executable");
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
        composition_policy_with_runtime(
            base_image,
            base_digest,
            workspace_image,
            workspace_digest,
            workspace_write,
            toolchain_image,
            toolchain_digest,
            "/opt/node",
            &[],
            &[],
            None,
        )
    }

    /// A composition whose toolchain target, Config Env defaults and advisory
    /// `path.prepend` are explicit (#3500).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn composition_policy_with_runtime(
        base_image: &Path,
        base_digest: &str,
        workspace_image: &Path,
        workspace_digest: &str,
        workspace_write: &Path,
        toolchain_image: &Path,
        toolchain_digest: &str,
        toolchain_target: &str,
        base_env: &[(&str, &str)],
        toolchain_env: &[(&str, &str)],
        path_prepend: Option<&str>,
    ) -> SandboxPolicy {
        let env = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(name, value)| serde_json::json!({ "name": name, "value": value }))
                .collect::<Vec<_>>()
        };
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
                    "base_env": env(base_env),
                    "toolchains": [
                        {
                            "digest": format!("sha256:{toolchain_digest}"),
                            "source": toolchain_image.to_string_lossy(),
                            "target": toolchain_target,
                            "env": env(toolchain_env),
                            "path_prepend": path_prepend
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
    workspace_storage(&workspace_write);

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

/// #3698 SC-01: an ordered multi-lower Workspace merges deterministically.
/// The first lower shadows later ones, both remain visible where they do not
/// conflict, and the durable upper receives writes.
#[test]
fn ordered_multi_lower_workspace_merges_by_declared_priority() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = dir.path().join("images");
    let base_source = dir.path().join("base-source");
    let top_source = dir.path().join("top-source");
    let bottom_source = dir.path().join("bottom-source");
    for path in [&images, &base_source, &top_source, &bottom_source] {
        std::fs::create_dir_all(path).expect("fixture directory");
    }
    build_base_runtime(
        &base_source,
        Path::new(env!("CARGO_BIN_EXE_nession-sandbox-bridge")),
    );
    std::fs::write(top_source.join("shadow.txt"), "top\n").expect("top shadow");
    std::fs::write(top_source.join("only-top.txt"), "top\n").expect("top file");
    std::fs::write(bottom_source.join("shadow.txt"), "bottom\n").expect("bottom shadow");
    std::fs::write(bottom_source.join("only-bottom.txt"), "bottom\n").expect("bottom file");
    let base_image = images.join("base.erofs");
    let top_image = images.join("top.erofs");
    let bottom_image = images.join("bottom.erofs");
    mkfs_erofs(&base_source, &base_image);
    mkfs_erofs(&top_source, &top_image);
    mkfs_erofs(&bottom_source, &bottom_image);
    let base_digest = sha256_file(&base_image);
    let top_digest = sha256_file(&top_image);
    let bottom_digest = sha256_file(&bottom_image);

    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(images);
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let workspace_write = settings.state_dir.join("workspaces").join("multi-lower");
    workspace_storage(&workspace_write);

    let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
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
                    "lowers": [
                        {
                            "digest": format!("sha256:{top_digest}"),
                            "source": top_image.to_string_lossy()
                        },
                        {
                            "digest": format!("sha256:{bottom_digest}"),
                            "source": bottom_image.to_string_lossy()
                        }
                    ],
                    "write": workspace_write.to_string_lossy()
                },
                "toolchains": []
            }
        },
        "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
        "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
        "enforcement": "required"
    }))
    .expect("multi-lower composition policy");
    let script = "\
set -eu
read shadow < /workspace/shadow.txt
[ \"$shadow\" = top ] && echo SHADOW-TOP
read only_top < /workspace/only-top.txt
[ \"$only_top\" = top ] && echo TOP-VISIBLE
read only_bottom < /workspace/only-bottom.txt
[ \"$only_bottom\" = bottom ] && echo BOTTOM-VISIBLE
printf 'upper\\n' > /workspace/upper-proof.txt
read upper < /workspace/upper-proof.txt
[ \"$upper\" = upper ] && echo UPPER-WRITE
";
    let mut running = launch(
        &settings,
        LaunchRequest {
            policy,
            session_name: format!("multi-lower-{}", std::process::id()),
            instance_id: "instance-multi-lower".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
            tmux_socket: None,
        },
    );
    verify_or_report(&mut running, "the multi-lower launch barrier must verify");
    let record = running.prepared.record().clone();
    let (status, stdout, stderr) = wait_for_exit(&mut running);
    assert!(
        status.success(),
        "the multi-lower shell failed: status={status:?} stdout={stdout} stderr={stderr}"
    );
    for marker in ["SHADOW-TOP", "TOP-VISIBLE", "BOTTOM-VISIBLE", "UPPER-WRITE"] {
        assert!(
            stdout.contains(marker),
            "the multi-lower shell did not prove {marker}: stdout={stdout} stderr={stderr}"
        );
    }
    let overlay = record.overlay.clone().expect("a Workspace Overlay record");
    assert_eq!(
        overlay
            .lowers
            .iter()
            .map(|lower| lower.digest.clone())
            .collect::<Vec<_>>(),
        vec![
            format!("sha256:{top_digest}"),
            format!("sha256:{bottom_digest}")
        ]
    );
    let physical = overlay_mount_count(Path::new(&overlay.mountpoint));
    assert_eq!(physical, 1, "one physical Multi-Lower Overlay");
    let shared = record.shared_mounts.clone();
    running
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the multi-lower composition");
    assert!(
        workspace_write
            .join("upper")
            .join("upper-proof.txt")
            .exists(),
        "the write must land in the durable Workspace upper"
    );
    for consumer in &shared {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(&consumer.mountpoint)),
            "the last consumer must release {}",
            consumer.mountpoint
        );
    }
    assert_cleaned(&settings, &record);
    print_evidence(&serde_json::json!({
        "shadow_top": true,
        "both_lowers_visible": true,
        "durable_upper_write": true,
        "ordered_lowers": overlay.lowers.len(),
        "physical_overlays": physical,
        "lowers_released": true,
    }));
}

/// #3698 SC-02: a writable RootFS merges the immutable Base with an
/// execution-owned transient upper/work. Writes disappear with the execution
/// and never reach the image or another execution.
#[test]
fn a_writable_rootfs_is_transient_and_never_mutates_the_image() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = dir.path().join("images");
    let base_source = dir.path().join("base-source");
    for path in [&images, &base_source] {
        std::fs::create_dir_all(path).expect("fixture directory");
    }
    build_base_runtime(
        &base_source,
        Path::new(env!("CARGO_BIN_EXE_nession-sandbox-bridge")),
    );
    std::fs::write(base_source.join("whiteout.txt"), "base file\n").expect("base marker");
    let base_image = images.join("base.erofs");
    mkfs_erofs(&base_source, &base_image);
    let base_digest = sha256_file(&base_image);
    let base_bytes = std::fs::read(&base_image).expect("base bytes");

    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(images);
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let workspace_write = settings.state_dir.join("workspaces").join("rootfs-bind");
    std::fs::create_dir_all(&workspace_write).expect("bind workspace");

    let launch_rootfs = |session: &str, script: String, settings: &SandboxSettings| {
        let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "rootfs": {
                    "kind": "image",
                    "digest": format!("sha256:{base_digest}"),
                    "writable": true
                },
                "composition": {
                    "base": {
                        "digest": format!("sha256:{base_digest}"),
                        "source": base_image.to_string_lossy()
                    },
                    "base_writable": true,
                    "workspace": {
                        "write": workspace_write.to_string_lossy()
                    },
                    "toolchains": []
                }
            },
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required"
        }))
        .expect("writable RootFS policy");
        launch(
            settings,
            LaunchRequest {
                policy,
                session_name: format!("{session}-{}", std::process::id()),
                instance_id: format!("instance-{session}"),
                working_dir: "/workspace".to_string(),
                inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), script],
                tmux_socket: None,
            },
        )
    };

    let first_script = "\
set -eu
printf 'transient\\n' > /transient-proof.txt
read transient < /transient-proof.txt
[ \"$transient\" = transient ] && echo TRANSIENT-WRITE
read base < /whiteout.txt
[ \"$base\" = 'base file' ] && echo BASE-VISIBLE
printf 'transient file\\n' > /whiteout.txt
read copy < /whiteout.txt
[ \"$copy\" = 'transient file' ] && echo COPYUP-OK
[ ! -e /etc/shadow ] && echo HIDDEN-OK
";
    let mut first = launch_rootfs("rootfs-writable", first_script.to_string(), &settings);
    verify_or_report(&mut first, "the writable RootFS launch barrier must verify");
    let record = first.prepared.record().clone();
    let transient = record
        .transient_rootfs
        .clone()
        .expect("a transient RootFS record");
    let (status, stdout, stderr) = wait_for_exit(&mut first);
    assert!(
        status.success(),
        "the writable RootFS shell failed: status={status:?} stdout={stdout} stderr={stderr}"
    );
    assert!(stdout.contains("TRANSIENT-WRITE"), "{stdout}");
    assert!(stdout.contains("BASE-VISIBLE"), "{stdout}");
    assert!(stdout.contains("COPYUP-OK"), "{stdout}");
    assert!(stdout.contains("HIDDEN-OK"), "{stdout}");
    assert!(
        Path::new(&transient.upper).is_dir(),
        "the transient upper exists while the execution is live"
    );
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the writable RootFS");
    assert!(
        !Path::new(&transient.mountpoint).exists()
            || !nession_sandbox::linux::erofs::is_mounted(Path::new(&transient.mountpoint)),
        "the transient RootFS is unmounted"
    );
    assert!(
        !Path::new(&transient.upper).exists(),
        "the transient upper is removed"
    );
    assert!(
        !Path::new(&transient.work).exists(),
        "the transient work is removed"
    );
    assert_eq!(
        std::fs::read(&base_image).expect("base bytes after"),
        base_bytes,
        "the immutable Base image bytes must not change"
    );
    assert_cleaned(&settings, &record);

    let second_script = "\
set -eu
[ ! -e /transient-proof.txt ] && echo ISOLATED
read base < /whiteout.txt
[ \"$base\" = 'base file' ] && echo COPYUP-ISOLATED
";
    let mut second = launch_rootfs("rootfs-second", second_script.to_string(), &settings);
    verify_or_report(
        &mut second,
        "the second writable RootFS launch barrier must verify",
    );
    let (status, stdout, stderr) = wait_for_exit(&mut second);
    assert!(
        status.success(),
        "the second writable RootFS shell failed: status={status:?} stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("ISOLATED"),
        "a later execution must not see the earlier transient write: {stdout}"
    );
    assert!(
        stdout.contains("COPYUP-ISOLATED"),
        "the modified lower file must reappear unchanged in a later execution: {stdout}"
    );
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the second writable RootFS");
    print_evidence(&serde_json::json!({
        "transient_write_visible": true,
        "copyup_isolated": true,
        "transient_upper_removed": true,
        "base_image_unchanged": true,
        "later_execution_isolated": true,
        "transient_recorded": true,
    }));
}

#[test]
fn a_managed_workspace_keeps_its_durable_upper_across_overlay_reentry() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    // The durable managed Workspace root is authorized separately from the
    // execution state directory (#3407).
    let durable_root = dir.path().join("agent-workspaces");
    settings.agent_workspaces_root = Some(durable_root.clone());
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let managed = durable_root.join("ws_acceptance");
    workspace_storage(&managed);

    let policy = || {
        serde_json::from_value::<SandboxPolicy>(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "composition": {
                    "base": {
                        "digest": format!("sha256:{}", images.base_digest),
                        "source": images.base.to_string_lossy()
                    },
                    "workspace": {
                        "image": {
                            "digest": format!("sha256:{}", images.project_digest),
                            "source": images.project.to_string_lossy()
                        },
                        "write": managed.to_string_lossy(),
                        "ownership": "agent"
                    },
                    "toolchains": []
                }
            },
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required"
        }))
        .expect("managed composition policy fixture")
    };

    // First Enter: write through the Overlay into the durable upper.
    let first_script = "\
set -eu
read line < /workspace/project.txt
[ \"$line\" = project ] && echo LOWER-OK
printf 'durable work\\n' > /workspace/reentry.txt
overlay=no
while IFS= read -r mount; do
  case \"$mount\" in
    *fuse.fuse-overlayfs*) overlay=yes ;;
  esac
done < /proc/self/mountinfo
[ \"$overlay\" = yes ] && echo OVERLAY-OK
";
    let mut first = launch(
        &settings,
        LaunchRequest {
            policy: policy(),
            session_name: format!("managed-reentry-{}", std::process::id()),
            instance_id: "instance-managed-reentry".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                first_script.to_string(),
            ],
            tmux_socket: None,
        },
    );
    verify_or_report(&mut first, "the first managed composition must verify");
    let (first_status, first_stdout, first_stderr) = wait_for_exit(&mut first);
    assert!(
        first_status.success(),
        "the first managed composition failed: stdout={first_stdout} stderr={first_stderr}"
    );
    for marker in ["LOWER-OK", "OVERLAY-OK"] {
        assert!(
            first_stdout.contains(marker),
            "the first managed composition did not prove {marker}: {first_stdout} {first_stderr}"
        );
    }
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the first composition");
    let durable = managed.join("upper").join("reentry.txt");
    assert_eq!(
        std::fs::read_to_string(&durable).expect("durable upper file"),
        "durable work\n",
        "the sandbox write must land in the managed durable upper"
    );

    // Second Enter: the same lower and the same managed Workspace observe the
    // previously written bytes.
    let second_script = "\
set -eu
read line < /workspace/reentry.txt
[ \"$line\" = 'durable work' ] && echo REENTRY-OK
read project < /workspace/project.txt
[ \"$project\" = project ] && echo LOWER-OK
";
    let mut second = launch(
        &settings,
        LaunchRequest {
            policy: policy(),
            session_name: format!("managed-reentry-{}", std::process::id()),
            instance_id: "instance-managed-reentry".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                second_script.to_string(),
            ],
            tmux_socket: None,
        },
    );
    verify_or_report(
        &mut second,
        "the re-entered managed composition must verify",
    );
    let (second_status, second_stdout, second_stderr) = wait_for_exit(&mut second);
    assert!(
        second_status.success(),
        "the re-entered managed composition failed: stdout={second_stdout} stderr={second_stderr}"
    );
    for marker in ["REENTRY-OK", "LOWER-OK"] {
        assert!(
            second_stdout.contains(marker),
            "the re-entered managed composition did not prove {marker}: {second_stdout} {second_stderr}"
        );
    }
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the second composition");
    assert!(
        managed.is_dir(),
        "cleanup must release the lease, not delete the managed Workspace"
    );
    assert_eq!(
        std::fs::read_to_string(&durable).expect("durable upper survives cleanup"),
        "durable work\n"
    );
    print_evidence(&serde_json::json!({
        "managed_workspace": managed.to_string_lossy(),
        "project_lower_digest": format!("sha256:{}", images.project_digest),
        "first_overlay": true,
        "durable_upper_preserved": true,
        "reentry_same_bytes": true,
        "workspace_survived_cleanup": true,
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
    workspace_storage(&first_write);
    workspace_storage(&second_write);

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
// #3500 image Config Env and mount annotations
// ---------------------------------------------------------------------------

#[test]
fn image_config_defaults_and_the_resolved_prepend_reach_the_sandboxed_process() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let write = settings.state_dir.join("workspaces").join("image-env");
    workspace_storage(&write);

    let policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &write,
        &images.toolchain,
        &images.toolchain_digest,
        "/opt/go",
        &[("IMAGE_LANGUAGE", "base"), ("SHARED", "base")],
        &[("GO_TOOLCHAIN", "image"), ("SHARED", "tool")],
        Some("bin"),
    );
    let request = || LaunchRequest {
        policy: policy.clone(),
        session_name: "image-env".to_string(),
        instance_id: "instance-image-env".to_string(),
        working_dir: "/workspace".to_string(),
        inner_command: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf 'PATH=%s\\n' \"$PATH\"; \
             printf 'GO=%s\\n' \"$GO_TOOLCHAIN\"; \
             printf 'IMAGE=%s\\n' \"$IMAGE_LANGUAGE\"; \
             printf 'SHARED=%s\\n' \"$SHARED\""
                .to_string(),
        ],
        tmux_socket: None,
    };

    let mut first = launch_with_overlay(&settings, request(), &[]);
    verify_or_report(
        &mut first,
        "the image environment barrier must verify before the shell runs",
    );
    let (status, stdout, stderr) = wait_for_exit(&mut first);
    assert!(
        status.success(),
        "the sandboxed shell must exit successfully: stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("PATH=/opt/go/bin:"),
        "the resolved prepend must lead PATH: {stdout}"
    );
    assert!(
        stdout.contains("GO=image"),
        "the toolchain Config Env must reach the process: {stdout}"
    );
    assert!(
        stdout.contains("IMAGE=base"),
        "the Base Runtime Config Env must reach the process: {stdout}"
    );
    assert!(
        stdout.contains("SHARED=tool"),
        "a tool default must sit above a base default: {stdout}"
    );

    // An explicit Session/Sandbox ENV deterministically overrides every image
    // default in the same create; the mounted prepend still leads PATH unless
    // the same create sets PATH itself.
    let mut second = launch_with_overlay(
        &settings,
        request(),
        &[
            ("GO_TOOLCHAIN".to_string(), "session".to_string()),
            ("IMAGE_LANGUAGE".to_string(), "session".to_string()),
            ("SHARED".to_string(), "session".to_string()),
        ],
    );
    verify_or_report(
        &mut second,
        "the explicit-Session-ENV barrier must verify before the shell runs",
    );
    let (status, stdout, stderr) = wait_for_exit(&mut second);
    assert!(
        status.success(),
        "the second sandboxed shell must exit successfully: stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("GO=session")
            && stdout.contains("IMAGE=session")
            && stdout.contains("SHARED=session"),
        "explicit Session ENV must win over image defaults: {stdout}"
    );
    assert!(
        stdout.contains("PATH=/opt/go/bin:"),
        "the mounted executable directory remains on PATH: {stdout}"
    );

    // An explicit PATH in the same create wins over the image prepend.
    let mut third = launch_with_overlay(
        &settings,
        request(),
        &[("PATH".to_string(), "/session/bin:/usr/bin:/bin".to_string())],
    );
    verify_or_report(&mut third, "the explicit-PATH barrier must verify");
    let (status, stdout, _) = wait_for_exit(&mut third);
    assert!(status.success());
    assert!(
        stdout.contains("PATH=/session/bin:/usr/bin:/bin"),
        "an explicit Session PATH wins over the image prepend: {stdout}"
    );

    print_evidence(&serde_json::json!({
        "prepend_on_path": "/opt/go/bin",
        "base_default": "base",
        "tool_default_over_base": "tool",
        "explicit_session_env_over_image": true,
        "explicit_path_wins": true,
    }));
}

#[test]
fn a_missing_prepend_directory_fails_before_any_process_launches() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    // A toolchain image without the declared executable directory.
    let source = dir.path().join("toolchain-no-bin-source");
    std::fs::create_dir_all(source.join("lib")).expect("toolchain source");
    std::fs::write(source.join("lib/only.txt"), "no bin\n").expect("toolchain file");
    let toolchain_no_bin = dir.path().join("images/toolchain-no-bin.erofs");
    mkfs_erofs(&source, &toolchain_no_bin);
    let toolchain_no_bin_digest = sha256_file(&toolchain_no_bin);

    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let write = settings.state_dir.join("workspaces").join("missing-bin");
    workspace_storage(&write);
    let policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &write,
        &toolchain_no_bin,
        &toolchain_no_bin_digest,
        "/opt/go",
        &[],
        &[],
        Some("bin"),
    );
    let request = LaunchRequest {
        policy,
        session_name: "missing-bin".to_string(),
        instance_id: "instance-missing-bin".to_string(),
        working_dir: "/workspace".to_string(),
        inner_command: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "exit 0".to_string(),
        ],
        tmux_socket: None,
    };
    let error = match prepare(&request, &settings) {
        Ok(_) => panic!("a missing executable directory must fail before launch"),
        Err(error) => error,
    };
    let text = format!("{error:#}");
    assert!(
        text.contains("path.prepend") && text.contains("bin"),
        "the refusal must be actionable: {text}"
    );
    // No execution record, process or overlay survives the refused prepare.
    let records = std::fs::read_dir(&settings.state_dir)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "json")
                })
                .count()
        })
        .unwrap_or(0);
    assert_eq!(records, 0, "a refused prepare must not write a record");
    print_evidence(&serde_json::json!({
        "missing_prepend_refused": true,
        "record_written": false,
    }));
}

#[test]
fn one_layer_in_two_sessions_keeps_distinct_targets_and_environment_without_premature_unmount() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let first_write = settings.state_dir.join("workspaces").join("node");
    let second_write = settings.state_dir.join("workspaces").join("rust");
    workspace_storage(&first_write);
    workspace_storage(&second_write);

    // The same physical EROFS layer is mounted for both Sessions, under two
    // distinct targets with two distinct bounded environments.
    let first_policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &first_write,
        &images.toolchain,
        &images.toolchain_digest,
        "/opt/node",
        &[("SESSION_FLAVOR", "node")],
        &[("TOOL_FLAVOR", "node")],
        Some("bin"),
    );
    let second_policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &second_write,
        &images.toolchain,
        &images.toolchain_digest,
        "/opt/rust",
        &[("SESSION_FLAVOR", "rust")],
        &[("TOOL_FLAVOR", "rust")],
        Some("bin"),
    );
    let launch_policy = |policy: SandboxPolicy, name: &str| {
        launch(
            &settings,
            LaunchRequest {
                policy,
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
    let mut first = launch_policy(first_policy, "layer-first");
    let mut second = launch_policy(second_policy, "layer-second");
    verify_or_report(&mut first, "the first layer Session must verify");
    verify_or_report(&mut second, "the second layer Session must verify");
    let first_record = first.prepared.record().clone();
    let second_record = second.prepared.record().clone();
    let targets = |record: &nession_sandbox::ExecutionRecord| {
        record
            .effective_policy
            .as_ref()
            .and_then(|policy| policy.filesystem.as_ref())
            .and_then(|filesystem| filesystem.composition.as_ref())
            .map(|composition| {
                composition
                    .toolchains
                    .iter()
                    .map(|toolchain| toolchain.target.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    assert_eq!(targets(&first_record), vec!["/opt/node"]);
    assert_eq!(targets(&second_record), vec!["/opt/rust"]);
    let defaults = |record: &nession_sandbox::ExecutionRecord| {
        record
            .effective_policy
            .as_ref()
            .and_then(|policy| policy.filesystem.as_ref())
            .and_then(|filesystem| filesystem.composition.as_ref())
            .map(|composition| {
                (
                    composition
                        .base_env
                        .iter()
                        .map(|entry| (entry.name.clone(), entry.value.clone()))
                        .collect::<Vec<_>>(),
                    composition.toolchains[0]
                        .env
                        .iter()
                        .map(|entry| (entry.name.clone(), entry.value.clone()))
                        .collect::<Vec<_>>(),
                )
            })
            .unwrap_or_default()
    };
    assert_eq!(
        defaults(&first_record),
        (
            vec![("SESSION_FLAVOR".to_string(), "node".to_string())],
            vec![("TOOL_FLAVOR".to_string(), "node".to_string())],
        )
    );
    assert_eq!(
        defaults(&second_record),
        (
            vec![("SESSION_FLAVOR".to_string(), "rust".to_string())],
            vec![("TOOL_FLAVOR".to_string(), "rust".to_string())],
        )
    );
    // One verified layer -> exactly one physical mount shared by both.
    assert_eq!(first_record.shared_mounts.len(), 3);
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
    assert_eq!(first_shared, second_shared);
    for shared in &first_record.shared_mounts {
        assert!(nession_sandbox::linux::erofs::is_mounted(Path::new(
            &shared.mountpoint
        )));
        assert_eq!(
            settings
                .mount_manager
                .as_ref()
                .expect("mount manager")
                .lookup(&shared.digest)
                .expect("known digest")
                .consumers,
            2
        );
    }

    let _ = first.child.kill();
    let _ = first.child.wait();
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the first Session");
    for shared in &first_record.shared_mounts {
        assert!(
            nession_sandbox::linux::erofs::is_mounted(Path::new(&shared.mountpoint)),
            "releasing one Session must not unmount the shared layer"
        );
    }

    let _ = second.child.kill();
    let _ = second.child.wait();
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the second Session");
    for shared in &second_record.shared_mounts {
        assert!(
            !nession_sandbox::linux::erofs::is_mounted(Path::new(&shared.mountpoint)),
            "the last consumer must unmount the shared layer"
        );
    }
    print_evidence(&serde_json::json!({
        "targets": ["/opt/node", "/opt/rust"],
        "distinct_environment": true,
        "shared_layer_mounts": first_record.shared_mounts.len(),
        "premature_unmount": false,
    }));
}

#[test]
fn an_already_running_pane_keeps_its_image_environment_after_a_new_binding() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let first_write = settings.state_dir.join("workspaces").join("running-first");
    let second_write = settings.state_dir.join("workspaces").join("running-second");
    workspace_storage(&first_write);
    workspace_storage(&second_write);
    let first_policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &first_write,
        &images.toolchain,
        &images.toolchain_digest,
        "/opt/node",
        &[("SESSION_FLAVOR", "first")],
        &[("TOOL_FLAVOR", "first")],
        Some("bin"),
    );
    let mut first = launch_with_overlay(
        &settings,
        LaunchRequest {
            policy: first_policy,
            session_name: "running-first".to_string(),
            instance_id: "instance-running-first".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "sleep 30".to_string(),
            ],
            tmux_socket: None,
        },
        &[],
    );
    verify_or_report(&mut first, "the first Pane must verify");
    let read_environment = || {
        std::fs::read(format!("/proc/{}/environ", first.pane_pid))
            .map(|bytes| {
                bytes
                    .split(|byte| *byte == 0)
                    .map(|entry| String::from_utf8_lossy(entry).into_owned())
                    .collect::<Vec<_>>()
            })
            .expect("read the running Pane environment")
    };
    let before = read_environment();
    assert!(
        before.iter().any(|entry| entry == "TOOL_FLAVOR=first"),
        "the first Pane started with its image default: {before:?}"
    );
    assert!(
        before
            .iter()
            .any(|entry| entry.starts_with("PATH=/opt/node/bin:")),
        "the first Pane started with its resolved prepend: {before:?}"
    );

    // A second image binding is prepared while the first Pane keeps running.
    let second_policy = composition_policy_with_runtime(
        &images.base,
        &images.base_digest,
        &images.project,
        &images.project_digest,
        &second_write,
        &images.toolchain,
        &images.toolchain_digest,
        "/opt/rust",
        &[("SESSION_FLAVOR", "second")],
        &[("TOOL_FLAVOR", "second")],
        Some("bin"),
    );
    let second = prepare(
        &LaunchRequest {
            policy: second_policy,
            session_name: "running-second".to_string(),
            instance_id: "instance-running-second".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "exit 0".to_string(),
            ],
            tmux_socket: None,
        },
        &settings,
    )
    .expect("the second composition prepares while the first Pane runs");

    let after = read_environment();
    assert_eq!(
        before, after,
        "an already running Pane must not receive a retroactive PATH or environment change"
    );

    second
        .abort()
        .expect("release the unstarted second composition");
    let _ = first.child.kill();
    let _ = first.child.wait();
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("cleanup the running Pane");
    print_evidence(&serde_json::json!({
        "running_environment_unchanged": true,
        "adopting_a_new_binding_requires_reentry": true,
    }));
}

// ---------------------------------------------------------------------------
// #3449 shared, recoverable EROFS mount manager
// ---------------------------------------------------------------------------

/// #3582 SC-02: two concurrently live executions over one managed Workspace
/// share exactly one physical Overlay; ending execution A keeps B alive, and
/// the last release unmounts without deleting the durable upper/work.
#[test]
fn two_executions_share_one_physical_workspace_overlay_and_release_safely() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    let durable_root = dir.path().join("agent-workspaces");
    settings.agent_workspaces_root = Some(durable_root.clone());
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let managed = durable_root.join("ws_two_consumers");
    workspace_storage(&managed);

    let policy = || {
        composition_policy(
            &images.base,
            &images.base_digest,
            &images.project,
            &images.project_digest,
            &managed,
            &images.toolchain,
            &images.toolchain_digest,
        )
    };
    let request = |name: &str, script: &str| LaunchRequest {
        policy: policy(),
        session_name: format!("{name}-{}", std::process::id()),
        instance_id: format!("instance-{name}"),
        working_dir: "/workspace".to_string(),
        inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
        tmux_socket: None,
    };

    let first_script = "\
set -eu
printf 'shared-write\n' > /workspace/shared.txt
printf 'a-ready\n' > /workspace/a-ready
n=0
while [ ! -f /workspace/b-read ]; do n=$((n+1)); [ \"$n\" -lt 600 ] || { echo A-TIMEOUT; exit 1; }; sleep 0.1; done
printf 'a-ended\n' > /workspace/a-ended
echo A-OK
";
    let second_script = "\
set -eu
n=0
while [ ! -f /workspace/a-ready ]; do n=$((n+1)); [ \"$n\" -lt 600 ] || { echo B-TIMEOUT; exit 1; }; sleep 0.1; done
read line < /workspace/shared.txt
[ \"$line\" = shared-write ] && echo SHARED-WRITE-OK
printf 'b-read\n' > /workspace/b-read
n=0
while [ ! -f /workspace/a-ended ]; do n=$((n+1)); [ \"$n\" -lt 600 ] || { echo B-TIMEOUT-A-END; exit 1; }; sleep 0.1; done
# Execution A has exited; the host releases its consumer during this bounded
# wait. B must keep reading and writing the same durable view afterwards.
sleep 5
read line < /workspace/shared.txt
[ \"$line\" = shared-write ] && echo SHARED-WRITE-AFTER-FIRST-RELEASE-OK
printf 'b-after\n' > /workspace/b-after
echo B-OK
";

    let mut first = launch(&settings, request("shared-a", first_script));
    verify_or_report(&mut first, "execution A must verify");
    let mut second = launch(&settings, request("shared-b", second_script));
    verify_or_report(&mut second, "execution B must verify");

    let first_binding = first
        .prepared
        .record()
        .overlay
        .clone()
        .expect("execution A records its Overlay binding");
    let second_binding = second
        .prepared
        .record()
        .overlay
        .clone()
        .expect("execution B records its Overlay binding");
    assert_eq!(
        first_binding.mountpoint, second_binding.mountpoint,
        "both executions bind one manager-derived mountpoint"
    );
    assert_eq!(first_binding.generation, second_binding.generation);
    let merged = PathBuf::from(&first_binding.mountpoint);
    let physical_overlays = overlay_mount_count(&merged);
    assert_eq!(physical_overlays, 1, "exactly one physical Overlay mount");

    let manager = settings
        .overlay_manager
        .clone()
        .expect("the Overlay manager is configured");
    let key = manager
        .resolve_workspace(&managed)
        .expect("the managed Workspace is authorized");
    let status = manager.lookup(&key).expect("Overlay status");
    assert!(status.mounted && status.verified);
    assert_eq!(
        status.consumers, 2,
        "both executions hold identified leases"
    );

    let (first_status, first_stdout, first_stderr) = wait_for_exit(&mut first);
    assert!(
        first_status.success(),
        "execution A failed: stdout={first_stdout} stderr={first_stderr}"
    );
    assert!(first_stdout.contains("A-OK"), "{first_stdout}");
    first
        .prepared
        .into_handle()
        .cleanup()
        .expect("release execution A");

    let status = manager.lookup(&key).expect("status after execution A");
    assert!(status.mounted, "ending A must not revoke B");
    assert_eq!(status.consumers, 1);
    assert!(
        second
            .child
            .try_wait()
            .expect("execution B status")
            .is_none(),
        "execution B is still live after A's release"
    );

    let (second_status, second_stdout, second_stderr) = wait_for_exit(&mut second);
    assert!(
        second_status.success(),
        "execution B failed: stdout={second_stdout} stderr={second_stderr}"
    );
    for marker in [
        "SHARED-WRITE-OK",
        "SHARED-WRITE-AFTER-FIRST-RELEASE-OK",
        "B-OK",
    ] {
        assert!(
            second_stdout.contains(marker),
            "execution B did not prove {marker}: {second_stdout} {second_stderr}"
        );
    }
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("release execution B");

    assert_eq!(
        overlay_mount_count(&merged),
        0,
        "the last release unmounts the physical Overlay"
    );
    assert_eq!(manager.lookup(&key).expect("final status").consumers, 0);
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("shared.txt"))
            .expect("the durable upper retains the write"),
        "shared-write\n"
    );
    assert!(managed.join("upper").is_dir());
    for binding in [&first_binding, &second_binding] {
        assert!(
            !Path::new(&binding.mountpoint)
                .join("workspace-merged")
                .exists(),
            "no execution-scoped Overlay path exists"
        );
    }
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("b-after"))
            .expect("B's post-release write landed in the durable upper"),
        "b-after\n"
    );
    print_evidence(&serde_json::json!({
        "workspace": managed.to_string_lossy(),
        "physical_overlays": physical_overlays,
        "same_mountpoint": true,
        "same_generation": true,
        "consumers": 2,
        "first_release_kept_mount": true,
        "second_live_after_first_release": true,
        "shared_write_visible": true,
        "durable_upper_preserved": true,
        "unmounted_after_last_release": true,
    }));
}

/// #3698 SC-03: a managed Workspace keeps its ordered lower identity across
/// an Agent-owner restart, and reordered/missing lowers are refused without
/// losing the durable upper.
#[test]
fn a_managed_workspace_keeps_ordered_lowers_across_restart_and_refuses_reordering() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = dir.path().join("images");
    let top_source = dir.path().join("top-source");
    let bottom_source = dir.path().join("bottom-source");
    for path in [&images, &top_source, &bottom_source] {
        std::fs::create_dir_all(path).expect("fixture directory");
    }
    std::fs::write(top_source.join("top.txt"), "top\n").expect("top file");
    std::fs::write(bottom_source.join("bottom.txt"), "bottom\n").expect("bottom file");
    let top_image = images.join("top.erofs");
    let bottom_image = images.join("bottom.erofs");
    mkfs_erofs(&top_source, &top_image);
    mkfs_erofs(&bottom_source, &bottom_image);
    let top_digest = sha256_file(&top_image);
    let bottom_digest = sha256_file(&bottom_image);

    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(images);
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    attach_named_managers(&mut settings, dir.path(), "multi-restart-1");
    let managed = settings
        .state_dir
        .join("workspaces")
        .join("ws_ordered_restart");
    workspace_storage(&managed);

    let image = |path: &Path, digest: &str| {
        nession_erofs::mount_manager::VerifiedImage::new(
            format!("sha256:{digest}"),
            path.to_path_buf(),
        )
        .expect("verified lower")
    };
    let manager = settings
        .overlay_manager
        .clone()
        .expect("the Overlay manager is configured");
    let key = manager
        .resolve_workspace(&managed)
        .expect("authorized workspace");
    let ordered = nession_sandbox::mount::overlay::OverlayRequest::new(
        key.clone(),
        vec![
            image(&top_image, &top_digest),
            image(&bottom_image, &bottom_digest),
        ],
    );
    let first = manager
        .acquire(&ordered, "exec-first")
        .expect("acquire the ordered lowers");
    std::fs::write(
        first.mountpoint().join("restart-edit.txt"),
        b"restart edit\n",
    )
    .expect("write through the merged view");
    assert_eq!(
        first.binding().ordered_lower_digests(),
        vec![
            format!("sha256:{top_digest}"),
            format!("sha256:{bottom_digest}")
        ]
    );
    let second = manager
        .acquire(&ordered, "exec-peer")
        .expect("a second execution shares the ordered Overlay");
    assert_eq!(first.mountpoint(), second.mountpoint());
    assert_eq!(first.generation(), second.generation());
    first.release().expect("release the first execution");
    assert_eq!(
        std::fs::read_to_string(second.mountpoint().join("restart-edit.txt"))
            .expect("the peer still sees the durable edit"),
        "restart edit\n"
    );
    second.release().expect("release the peer execution");

    // A fresh Agent owner sees the same durable upper and the same ordered
    // compatibility key.
    reopen_managers(&mut settings, dir.path(), "multi-restart-2");
    let manager = settings
        .overlay_manager
        .clone()
        .expect("the restarted Overlay manager is configured");
    let reattached = manager
        .acquire(&ordered, "exec-second")
        .expect("the ordered lowers reattach");
    assert_eq!(
        std::fs::read_to_string(reattached.mountpoint().join("restart-edit.txt"))
            .expect("the durable edit"),
        "restart edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(reattached.mountpoint().join("top.txt")).expect("top lower"),
        "top\n"
    );
    assert_eq!(
        std::fs::read_to_string(reattached.mountpoint().join("bottom.txt")).expect("bottom lower"),
        "bottom\n"
    );

    let reordered = nession_sandbox::mount::overlay::OverlayRequest::new(
        key.clone(),
        vec![
            image(&bottom_image, &bottom_digest),
            image(&top_image, &top_digest),
        ],
    );
    let error = manager
        .acquire(&reordered, "exec-reordered")
        .expect_err("a reordered ordered lower set must be refused");
    assert!(format!("{error:#}").contains("ordered lowers"), "{error:#}");
    let missing = nession_sandbox::mount::overlay::OverlayRequest::new(
        key,
        vec![image(&top_image, &top_digest)],
    );
    let error = manager
        .acquire(&missing, "exec-missing")
        .expect_err("a missing lower must be refused");
    assert!(format!("{error:#}").contains("ordered lowers"), "{error:#}");
    reattached.release().expect("release the second execution");
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("restart-edit.txt"))
            .expect("the durable upper edit"),
        "restart edit\n"
    );
    print_evidence(&serde_json::json!({
        "ordered_reattach": true,
        "two_consumers_shared": true,
        "ordered_lowers": 2,
        "reordered_refused": true,
        "missing_lower_refused": true,
        "durable_upper_preserved": true,
    }));
}

/// #3582 SC-03: a detached Workspace reattaches after an Agent restart with
/// its prior edits; a changed lower, missing/symlinked storage, a foreign
/// owner and a foreign competing mount all refuse without changing bytes.
#[test]
fn a_detached_workspace_reattaches_and_unsafe_storage_is_refused() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    let durable_root = dir.path().join("agent-workspaces");
    settings.agent_workspaces_root = Some(durable_root.clone());
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let managed = durable_root.join("ws_reattach");
    workspace_storage(&managed);

    let policy = || {
        composition_policy(
            &images.base,
            &images.base_digest,
            &images.project,
            &images.project_digest,
            &managed,
            &images.toolchain,
            &images.toolchain_digest,
        )
    };
    let request = |script: &str| LaunchRequest {
        policy: policy(),
        session_name: format!("reattach-{}", std::process::id()),
        instance_id: "instance-reattach".to_string(),
        working_dir: "/workspace".to_string(),
        inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
        tmux_socket: None,
    };
    let write_script = "\
set -eu
printf 'durable edit\n' > /workspace/edit.txt
read lower < /workspace/project.txt
[ \"$lower\" = project ] && echo LOWER-OK
";
    let read_script = "\
set -eu
read line < /workspace/edit.txt
[ \"$line\" = 'durable edit' ] && echo EDIT-OK
read lower < /workspace/project.txt
[ \"$lower\" = project ] && echo LOWER-OK
";

    let mut first = launch(&settings, request(write_script));
    verify_or_report(&mut first, "the first execution must verify");
    let (first_status, first_stdout, first_stderr) = wait_for_exit(&mut first);
    assert!(
        first_status.success(),
        "the first execution failed: {first_stdout} {first_stderr}"
    );
    assert!(first_stdout.contains("LOWER-OK"));
    first.prepared.into_handle().cleanup().expect("detach");

    let manager = settings
        .overlay_manager
        .clone()
        .expect("the Overlay manager is configured");
    let key = manager
        .resolve_workspace(&managed)
        .expect("the managed Workspace is authorized");
    assert!(!manager.lookup(&key).expect("status").mounted);
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );

    // Restart: drop this process's owners and open a new pair over the same
    // durable roots, as a new Agent process would.
    drop(manager);
    reopen_managers(
        &mut settings,
        dir.path(),
        &format!("reattach-{}", std::process::id()),
    );
    let manager = settings
        .overlay_manager
        .clone()
        .expect("the reopened Overlay manager");
    let mut second = launch(&settings, request(read_script));
    verify_or_report(&mut second, "the reattached execution must verify");
    let (second_status, second_stdout, second_stderr) = wait_for_exit(&mut second);
    assert!(
        second_status.success(),
        "the reattached execution failed: {second_stdout} {second_stderr}"
    );
    for marker in ["EDIT-OK", "LOWER-OK"] {
        assert!(
            second_stdout.contains(marker),
            "the reattached execution did not prove {marker}: {second_stdout} {second_stderr}"
        );
    }
    second
        .prepared
        .into_handle()
        .cleanup()
        .expect("detach again");
    assert!(!manager.lookup(&key).expect("status").mounted);
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );

    let request_lower = || {
        nession_sandbox::mount::overlay::OverlayRequest::new(
            key.clone(),
            vec![project_image(&images)],
        )
    };

    // A changed lower while the physical Overlay is live is refused and never
    // merges a different Project image into the same durable upper.
    let altered_source = dir.path().join("altered-source");
    let altered_image = dir.path().join("altered-project.erofs");
    std::fs::create_dir_all(&altered_source).expect("altered source");
    std::fs::write(altered_source.join("project.txt"), "altered\n").expect("altered file");
    mkfs_erofs(&altered_source, &altered_image);
    let altered = nession_sandbox::mount::overlay::OverlayRequest::new(
        key.clone(),
        vec![nession_erofs::mount_manager::VerifiedImage::new(
            format!("sha256:{}", sha256_file(&altered_image)),
            altered_image,
        )
        .expect("verified altered image")],
    );
    let live = manager
        .acquire(&request_lower(), "exec-lower-first")
        .expect("acquire the pinned lower");
    let error = manager
        .acquire(&altered, "exec-lower-second")
        .expect_err("a changed lower must be refused");
    assert!(format!("{error:#}").contains("refusing lower"), "{error:#}");
    assert_eq!(
        overlay_mount_count(live.mountpoint()),
        1,
        "the refusal creates no second physical Overlay"
    );
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );
    live.release().expect("release the pinned lower");

    // A missing durable upper after proven storage refuses; it never creates
    // a fresh empty upper over lost bytes.
    let upper = managed.join("upper");
    let work = managed.join("work");
    let upper_aside = dir.path().join("upper-aside");
    std::fs::rename(&upper, &upper_aside).expect("move upper aside");
    let error = manager
        .acquire(&request_lower(), "exec-missing-upper")
        .expect_err("a missing upper must be refused");
    assert!(format!("{error:#}").contains("missing"), "{error:#}");
    assert!(!upper.exists(), "no fresh empty upper is created");
    assert_eq!(
        std::fs::read_to_string(upper_aside.join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );
    std::fs::rename(&upper_aside, &upper).expect("restore upper");

    // A symlinked work directory is refused without touching the upper.
    let work_aside = dir.path().join("work-aside");
    let outside_work = dir.path().join("outside-work");
    std::fs::create_dir_all(&outside_work).expect("outside work");
    std::fs::rename(&work, &work_aside).expect("move work aside");
    std::os::unix::fs::symlink(&outside_work, &work).expect("symlink work");
    let error = manager
        .acquire(&request_lower(), "exec-symlinked-work")
        .expect_err("a symlinked work must be refused");
    assert!(format!("{error:#}").contains("symlink"), "{error:#}");
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );
    std::fs::remove_file(&work).expect("remove symlink");
    std::fs::rename(&work_aside, &work).expect("restore work");

    // A durable owner identity naming another Agent is never taken over.
    let foreign_owner = nession_sandbox::mount::overlay::OwnerRecord {
        agent_identity: "agent-foreign".to_string(),
        mount_namespace: "mnt:[0]".to_string(),
        workspace: key.identity(),
        mountpoint: manager.mountpoint_for(&key).expect("manager mountpoint"),
        generation: "foreign-generation".to_string(),
        updated_at: 0,
    };
    nession_sandbox::mount::overlay::storage::write_owner_record(&managed, &foreign_owner)
        .expect("write a foreign owner record");
    let error = manager
        .acquire(&request_lower(), "exec-foreign-owner")
        .expect_err("a foreign owner must be refused");
    assert!(
        format!("{error:#}").contains("owned by Agent identity"),
        "{error:#}"
    );
    nession_sandbox::mount::overlay::storage::remove_owner_record(&managed);
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );

    // A competing physical mount at the manager-derived mountpoint is never
    // adopted merely because a path exists.
    let foreign_storage = dir.path().join("foreign-storage");
    workspace_storage(&foreign_storage);
    let mountpoint = manager.mountpoint_for(&key).expect("manager mountpoint");
    let lower_lease = settings
        .mount_manager
        .clone()
        .expect("the lower manager is configured")
        .acquire(&project_image(&images), "foreign-lower")
        .expect("mount the foreign lower");
    let overlay_settings = nession_sandbox::mount::overlay::OverlaySettings::new(
        settings.fuse_overlayfs_path.clone(),
        settings.fusermount_path.clone(),
    );
    let foreign_spec = nession_sandbox::mount::overlay::OverlayMountSpec {
        lowers: vec![lower_lease.mountpoint().to_path_buf()],
        upper: foreign_storage.join("upper"),
        work: foreign_storage.join("work"),
        merged: mountpoint.clone(),
    };
    nession_sandbox::mount::overlay::mount::mount_overlay(&foreign_spec, &overlay_settings)
        .expect("mount a competing Overlay");
    let error = manager
        .acquire(&request_lower(), "exec-competing-mount")
        .expect_err("a competing mount must not be adopted");
    assert!(
        format!("{error:#}").contains("never adopted by path"),
        "{error:#}"
    );
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("edit.txt")).expect("durable edit"),
        "durable edit\n"
    );
    nession_sandbox::mount::overlay::mount::unmount_overlay(&overlay_settings, &mountpoint)
        .expect("unmount the competing Overlay");
    lower_lease.release().expect("release the foreign lower");

    print_evidence(&serde_json::json!({
        "reattach_same_upper": true,
        "lower_visible_after_restart": true,
        "changed_lower_refused": true,
        "missing_upper_refused": true,
        "symlinked_work_refused": true,
        "foreign_owner_refused": true,
        "competing_mount_refused": true,
        "upper_unchanged": true,
        "no_fresh_empty_upper": true,
    }));
}

/// #3582 SC-04 (restart half): a process crash during prepare leaves a live
/// physical Overlay; a new manager re-adopts it only from the verified durable
/// identity, and a disappeared mount is reported unavailable, never served.
#[test]
fn a_crashed_overlay_owner_is_recovered_only_from_verified_identity() {
    if let Some(root) = std::env::var_os("NESSON_OVERLAY_CHILD_ROOT") {
        overlay_crash_child(PathBuf::from(root));
    }
    require_composition_tools();
    let root = tempfile::tempdir().expect("tempdir");
    let (managed, lower_digest) = prepare_crash_root(root.path());
    spawn_overlay_crash(root.path());
    let binding: nession_sandbox::mount::overlay::OverlayBinding = serde_json::from_slice(
        &std::fs::read(root.path().join("child-binding.json")).expect("the child binding"),
    )
    .expect("parse the child binding");
    assert_eq!(binding.workspace.directory(), managed);
    let (lower, manager) = crash_managers(root.path());
    let report = manager.adopt_consumers(&[binding.consumer("exec-child")]);
    assert_eq!(report.adopted.len(), 1, "{report:?}");
    assert!(report.unavailable.is_empty(), "{report:?}");
    let status = manager.lookup(&binding.workspace).expect("adopted status");
    assert!(status.mounted && status.verified);
    assert_eq!(status.consumers, 1);
    assert_eq!(
        std::fs::read_to_string(binding.mountpoint.join("child-edit.txt"))
            .expect("the crashed execution's write is readable"),
        "child edit\n"
    );
    manager
        .release_consumers(&binding.workspace, "exec-child", Some(&binding.generation))
        .expect("release the adopted consumer");
    assert_eq!(overlay_mount_count(&binding.mountpoint), 0);
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("child-edit.txt"))
            .expect("the durable upper retains the crash edit"),
        "child edit\n"
    );
    assert_eq!(
        lower
            .lookup(&lower_digest)
            .map(|status| status.consumers)
            .unwrap_or(0),
        0,
        "the verified Overlay unmount released the lower pin"
    );

    // A mount that disappeared is reported unavailable and never served.
    let lost = tempfile::tempdir().expect("lost tempdir");
    prepare_crash_root(lost.path());
    spawn_overlay_crash(lost.path());
    let binding: nession_sandbox::mount::overlay::OverlayBinding = serde_json::from_slice(
        &std::fs::read(lost.path().join("child-binding.json")).expect("the lost binding"),
    )
    .expect("parse the lost binding");
    let (lost_lower, lost_manager) = crash_managers(lost.path());
    let unmount = Command::new(which("fusermount3").expect("fusermount3")) // not-tmux: FUSE unmount helper
        .arg("-u")
        .arg(&binding.mountpoint)
        .status()
        .expect("force the mount loss");
    assert!(unmount.success());
    let report = lost_manager.adopt_consumers(&[binding.consumer("exec-child")]);
    assert!(report.adopted.is_empty(), "{report:?}");
    assert!(
        report
            .unavailable
            .iter()
            .any(|(_, reason)| reason.contains("no longer present")),
        "{report:?}"
    );
    let status = lost_manager
        .lookup(&binding.workspace)
        .expect("lost status");
    assert!(!status.mounted);
    assert!(!status.verified, "an unadopted mount is never verified");
    assert_eq!(
        std::fs::read_to_string(
            binding
                .workspace
                .directory()
                .join("upper")
                .join("child-edit.txt")
        )
        .expect("the lost execution's durable edit"),
        "child edit\n"
    );
    // The stale durable identity and lower consumer are reclaimed without
    // touching the durable upper.
    let reclaimed =
        lost_manager.reclaim_orphans(&nession_sandbox::mount::overlay::ProtectedWorkspaces::new());
    assert_eq!(reclaimed.reclaimed.len(), 1, "{reclaimed:?}");
    let _ = lost_lower.reclaim_orphans(&std::collections::HashSet::new());

    print_evidence(&serde_json::json!({
        "restart_adopted": true,
        "verified_after_restart": true,
        "missing_mount_unavailable": true,
        "durable_upper_preserved": true,
        "lower_released_after_verified_unmount": true,
    }));
}

/// #3582 SC-04 (failure half): injected mount/unmount failures retain the
/// lower, the durable identity and the upper for a bounded retry; an
/// unverified mount is never Ready and the Sandbox has no Native fallback.
#[test]
fn an_injected_overlay_failure_leaves_recoverable_state_without_data_loss() {
    require_composition_tools();
    let dir = tempfile::tempdir().expect("tempdir");
    let images = build_composition_images(dir.path());
    let mut settings = settings(dir.path());
    settings.erofs_image_root = Some(dir.path().join("images"));
    let durable_root = dir.path().join("agent-workspaces");
    settings.agent_workspaces_root = Some(durable_root.clone());
    attach_mount_manager(&mut settings, dir.path());
    std::fs::create_dir_all(&settings.state_dir).expect("state dir");
    let managed = durable_root.join("ws_failure");
    workspace_storage(&managed);
    let fusermount = which("fusermount3").expect("fusermount3");
    let real_fuse_overlayfs = which("fuse-overlayfs").expect("fuse-overlayfs");
    let lower_manager = settings.mount_manager.clone().expect("the lower manager");
    let project_digest = format!("sha256:{}", images.project_digest);
    let request = |key: &nession_sandbox::mount::overlay::OverlayWorkspaceKey| {
        nession_sandbox::mount::overlay::OverlayRequest::new(
            key.clone(),
            vec![project_image(&images)],
        )
    };
    let open_manager = |root: &Path, helper: PathBuf, fusermount: PathBuf, identity: &str| {
        let lower: std::sync::Arc<dyn nession_sandbox::mount::overlay::LowerProvider> =
            lower_manager.clone();
        nession_sandbox::mount::overlay::OverlayMountManager::open(
            nession_sandbox::mount::overlay::OverlayMountManagerConfig {
                root: root.to_path_buf(),
                workspace_roots: vec![durable_root.clone()],
                settings: nession_sandbox::mount::overlay::OverlaySettings::new(helper, fusermount),
                lower,
                identity: identity.to_string(),
            },
        )
        .expect("open a failure-injection Overlay manager")
    };

    // 1. The mount helper fails.
    let failing_helper = dir.path().join("failing-fuse-overlayfs");
    executable_script(&failing_helper, "#!/bin/sh\nexit 1\n");
    let failing = open_manager(
        &dir.path().join("overlay-failing"),
        failing_helper,
        fusermount.clone(),
        "failure-mount",
    );
    let key = failing
        .resolve_workspace(&managed)
        .expect("the managed Workspace is authorized");
    let error = failing
        .acquire(&request(&key), "exec-mount-failure")
        .expect_err("an injected mount failure must fail the acquire");
    assert!(format!("{error:#}").contains("failed"), "{error:#}");
    let status = failing.lookup(&key).expect("failed status");
    assert_eq!(
        status.state,
        nession_sandbox::mount::overlay::OverlayState::Failed
    );
    assert!(!status.mounted);
    assert!(!status.verified);
    assert_eq!(status.consumers, 0);
    assert_eq!(
        lower_manager
            .lookup(&project_digest)
            .map(|status| status.consumers)
            .unwrap_or(0),
        0,
        "a failed mount released the lower consumer"
    );
    assert!(!managed.join(".nession-overlay/owner.json").exists());

    // 2. The helper reports success without mounting anything.
    let silent_helper = dir.path().join("silent-fuse-overlayfs");
    executable_script(&silent_helper, "#!/bin/sh\nexit 0\n");
    let silent = open_manager(
        &dir.path().join("overlay-silent"),
        silent_helper,
        fusermount.clone(),
        "failure-silent",
    );
    let key = silent
        .resolve_workspace(&managed)
        .expect("the managed Workspace is authorized");
    let error = silent
        .acquire(&request(&key), "exec-unverified-mount")
        .expect_err("an unverified mount must fail the acquire");
    assert!(
        format!("{error:#}").contains("did not become an OverlayFS mount"),
        "{error:#}"
    );
    let status = silent.lookup(&key).expect("unverified status");
    assert!(!status.mounted);
    assert!(!status.verified, "an unverified mount is never ready");

    // 3. The unmount fails once: retain the mount, the lower pin, the durable
    //    identity and the upper; the retry succeeds.
    let fail_once = dir.path().join("fail-once-fusermount");
    executable_script(
        &fail_once,
        &format!(
            "#!/bin/sh\nif [ ! -f \"$0.counter\" ]; then : > \"$0.counter\"; exit 1; fi\nexec {} \"$@\"\n",
            fusermount.display()
        ),
    );
    let retrying = open_manager(
        &dir.path().join("overlay-retry"),
        real_fuse_overlayfs,
        fail_once,
        "failure-unmount",
    );
    let key = retrying
        .resolve_workspace(&managed)
        .expect("the managed Workspace is authorized");
    let lease = retrying
        .acquire(&request(&key), "exec-unmount-failure")
        .expect("acquire before the injected unmount failure");
    std::fs::write(managed.join("upper").join("durable.txt"), b"durable").expect("durable write");
    let error = lease
        .release()
        .expect_err("the injected unmount failure must be reported");
    assert!(format!("{error:#}").contains("failed"), "{error:#}");
    let status = retrying.lookup(&key).expect("failed unmount status");
    assert_eq!(
        status.state,
        nession_sandbox::mount::overlay::OverlayState::Failed
    );
    assert!(status.mounted, "the live mount is retained");
    assert_eq!(status.consumers, 0);
    assert!(
        managed.join(".nession-overlay/owner.json").exists(),
        "the durable identity is retained"
    );
    assert!(
        lower_manager
            .lookup(&project_digest)
            .is_some_and(|status| status.mounted && status.consumers >= 1),
        "the lower pin is never released on a failed Overlay unmount"
    );
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("durable.txt")).expect("durable"),
        "durable"
    );
    retrying
        .release_consumers(&key, "exec-unmount-failure", None)
        .expect("the retry succeeds");
    let status = retrying.lookup(&key).expect("retried status");
    assert!(!status.mounted);
    assert_eq!(status.consumers, 0);
    assert!(!managed.join(".nession-overlay/owner.json").exists());
    assert_eq!(
        lower_manager
            .lookup(&project_digest)
            .map(|status| status.consumers)
            .unwrap_or(0),
        0,
        "the retry releases the lower"
    );
    assert_eq!(
        std::fs::read_to_string(managed.join("upper").join("durable.txt")).expect("durable"),
        "durable"
    );

    // 4. Without the shared Overlay manager a lower-backed composition fails
    //    closed instead of creating a per-execution Overlay or Native fallback.
    let mut no_overlay = settings.clone();
    no_overlay.overlay_manager = None;
    let fallback_dir = durable_root.join("ws_no_fallback");
    workspace_storage(&fallback_dir);
    let error = match prepare(
        &LaunchRequest {
            policy: composition_policy(
                &images.base,
                &images.base_digest,
                &images.project,
                &images.project_digest,
                &fallback_dir,
                &images.toolchain,
                &images.toolchain_digest,
            ),
            session_name: format!("no-fallback-{}", std::process::id()),
            instance_id: "instance-no-fallback".to_string(),
            working_dir: "/workspace".to_string(),
            inner_command: vec!["/bin/sh".to_string()],
            tmux_socket: None,
        },
        &no_overlay,
    ) {
        Ok(_) => panic!("a missing Overlay manager must refuse the composition"),
        Err(error) => error,
    };
    assert!(
        format!("{error:#}").contains("shared Workspace Overlay manager"),
        "{error:#}"
    );

    print_evidence(&serde_json::json!({
        "mount_failure_failed_state": true,
        "mount_failure_not_ready": true,
        "unverified_mount_not_ready": true,
        "failed_unmount_retained_mount": true,
        "lower_pin_retained": true,
        "retry_succeeded": true,
        "durable_upper_preserved": true,
        "durable_identity_cleared_after_retry": true,
        "no_native_fallback": true,
    }));
}

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
    executable_script(
        &failing,
        "#!/bin/sh\n\
         if [ ! -f \"$0.counter\" ]; then : > \"$0.counter\"; exit 1; fi\n\
         exec fusermount3 \"$@\"\n",
    );
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
