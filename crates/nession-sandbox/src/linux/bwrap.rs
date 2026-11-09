//! Bubblewrap argv construction.
//!
//! The argv is built from the compiled policy only; nothing user-supplied is
//! interpolated into a shell program. A fixed `/bin/sh` launcher enrolls the
//! pane PID in the execution cgroup and opens the pinned seccomp profile as FD
//! 3, then `exec`s Bubblewrap. That launcher is trusted code; the sandboxed
//! shell starts only after the host's launch barrier releases it.
//!
//! Safety prerequisites that apply to every execution, not only to an explicit
//! policy request:
//!
//! - mount, user, PID, IPC and UTS namespaces (the PID namespace also keeps
//!   `/proc` from exposing host processes and their `/proc/<pid>/root`);
//! - the pinned seccomp profile, including the `ioctl(TIOCSTI)` argument check;
//! - no inherited `TMUX`/agent-socket/TTY control environment;
//! - the tmux socket and Agent state are hidden (masked when no filesystem
//!   policy is requested, or refused if a policy would expose them).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::error::{Result, SandboxError};
use crate::linux::seccomp;
use crate::policy::{CompiledFilesystem, CompiledSandboxPolicy};
use crate::settings::SandboxSettings;

/// The mount directory for the bridge and channel inside the sandbox.
pub const SANDBOX_RUN_DIR: &str = "/run/nession";
/// The bridge executable inside the sandbox.
pub const SANDBOX_BRIDGE: &str = "/run/nession/bridge";
/// The channel socket inside the sandbox.
pub const SANDBOX_CHANNEL: &str = "/run/nession/channel.sock";
/// The sandbox-local SOCKS5/HTTP-CONNECT endpoint.
pub const SANDBOX_PROXY_PORT: u16 = 3128;

/// Host paths that must never be reachable from a sandbox.
#[derive(Debug, Clone, Default)]
pub struct ForbiddenPaths {
    /// Files such as the private tmux socket.
    pub files: Vec<PathBuf>,
    /// Directories such as the Agent state directory.
    pub directories: Vec<PathBuf>,
}

impl ForbiddenPaths {
    /// Refuse a filesystem policy that would expose a control path.
    pub fn validate_not_visible(&self, filesystem: &CompiledFilesystem) -> Result<()> {
        for path in self.files.iter().chain(self.directories.iter()) {
            if filesystem.is_visible(path) {
                return Err(SandboxError::InvalidPolicy(format!(
                    "filesystem policy exposes the control path {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
}

/// Where the bridge and channel live for one execution.
#[derive(Debug, Clone)]
pub struct BridgePlacement {
    /// Host path of the bridge executable (the Agent binary).
    pub host_bridge: PathBuf,
    /// Host path of the channel socket.
    pub host_channel: PathBuf,
    /// Stable execution identity.
    pub execution_id: String,
    /// Present for restricted networking.
    pub proxy_listen: Option<SocketAddr>,
    /// The hidden bridge subcommand name.
    pub bridge_subcommand: String,
}

/// One complete launcher argv.
#[derive(Debug, Clone)]
pub struct BwrapPlan {
    pub argv: Vec<String>,
    pub warnings: Vec<String>,
}

/// Build the trusted launcher for one execution.
#[allow(clippy::too_many_arguments)]
pub fn build(
    policy: &CompiledSandboxPolicy,
    working_dir: &Path,
    forbidden: &ForbiddenPaths,
    bridge: &BridgePlacement,
    visible_probes: &[PathBuf],
    hidden_probes: &[PathBuf],
    not_socket_probes: &[PathBuf],
    seccomp_profile: &Path,
    cgroup_procs: Option<&Path>,
    inner_command: &[String],
    settings: &SandboxSettings,
) -> Result<BwrapPlan> {
    if inner_command.is_empty() {
        return Err(SandboxError::Prepare(
            "sandbox launch has no command to execute".to_string(),
        ));
    }
    let mut warnings = Vec::new();
    // Backend baseline namespaces. The policy's `process.linux_namespaces`
    // request is a subset: an unrequested namespace may still be created as a
    // safety prerequisite, and never weakens a requested one.
    let mut args: Vec<String> = vec![
        "--die-with-parent".to_string(),
        "--unshare-user".to_string(),
        "--unshare-pid".to_string(),
        "--unshare-ipc".to_string(),
        "--unshare-uts".to_string(),
    ];
    if policy.namespaces.cgroup {
        args.push("--unshare-cgroup".to_string());
    }
    if let Some(network) = &policy.network {
        if network.blocks_host_network() {
            args.push("--unshare-net".to_string());
        }
    } else {
        // No network policy dimension: no additional restriction.
    }
    args.push("--dev".to_string());
    args.push("/dev".to_string());
    args.push("--proc".to_string());
    args.push("/proc".to_string());
    args.push("--cap-drop".to_string());
    args.push("ALL".to_string());

    match &policy.filesystem {
        Some(filesystem) => {
            forbidden.validate_not_visible(filesystem)?;
            if !filesystem.is_visible(working_dir) {
                return Err(SandboxError::InvalidPolicy(format!(
                    "working directory {} is not visible under filesystem.access",
                    working_dir.display()
                )));
            }
            // The private /tmp must be mounted *before* user paths: a visible
            // workspace under /tmp is bound on top of it. Mounting the tmpfs
            // afterwards would hide that bind.
            if !filesystem.is_visible(Path::new("/tmp")) {
                args.push("--tmpfs".to_string());
                args.push("/tmp".to_string());
                warnings.push(
                    "backend baseline: a private tmpfs /tmp was added because /tmp is not visible"
                        .to_string(),
                );
            }
            // Writable mounts first, read-only mounts after: a later mount
            // wins on an overlapping path. Compilation refuses overlaps, so
            // this ordering is belt-and-braces rather than the primary guard.
            for path in &filesystem.write {
                push_bind(&mut args, "--bind", path, path);
            }
            for path in &filesystem.read {
                push_bind(&mut args, "--ro-bind", path, path);
            }
            for (target, link) in merged_usr_symlinks(filesystem) {
                args.push("--symlink".to_string());
                args.push(target);
                args.push(link);
            }
        }
        None => {
            args.push("--ro-bind".to_string());
            args.push("/".to_string());
            args.push("/".to_string());
            let masked = mask_host_control_paths(&mut args, forbidden, &mut warnings);
            if masked {
                warnings.push(
                    "backend baseline: host control paths were masked because no filesystem policy was requested"
                        .to_string(),
                );
            }
        }
    }

    args.push("--tmpfs".to_string());
    args.push(SANDBOX_RUN_DIR.to_string());
    args.push("--ro-bind".to_string());
    args.push(path_string(&bridge.host_bridge)?);
    args.push(SANDBOX_BRIDGE.to_string());
    args.push("--bind".to_string());
    args.push(path_string(&bridge.host_channel)?);
    args.push(SANDBOX_CHANNEL.to_string());

    args.push("--chdir".to_string());
    args.push(path_string(working_dir)?);

    scrub_control_environment(&mut args);
    if policy
        .network
        .as_ref()
        .is_some_and(crate::policy::CompiledNetwork::requires_proxy)
    {
        unset_proxy_environment(&mut args);
        let endpoint = format!("127.0.0.1:{SANDBOX_PROXY_PORT}");
        args.push("--setenv".to_string());
        args.push("ALL_PROXY".to_string());
        args.push(format!("socks5h://{endpoint}"));
        args.push("--setenv".to_string());
        args.push("HTTPS_PROXY".to_string());
        args.push(format!("http://{endpoint}"));
        args.push("--setenv".to_string());
        args.push("NO_PROXY".to_string());
        args.push(String::new());
        warnings.push(format!(
            "restricted network: only SOCKS5 and HTTP CONNECT through {endpoint} may egress; \
             plain HTTP proxy requests are not supported"
        ));
    }

    // The pinned profile is a backend safety prerequisite as well as the
    // requested `syscall.seccomp` guarantee. Adding it unconditionally means an
    // execution that did not request seccomp cannot have a different TTY/FD
    // surface than one that did.
    let _ = seccomp::interactive_profile_v1()?;
    args.push("--seccomp".to_string());
    args.push("3".to_string());

    args.push("--".to_string());
    args.push(SANDBOX_BRIDGE.to_string());
    args.push(bridge.bridge_subcommand.clone());
    args.push("--channel".to_string());
    args.push(SANDBOX_CHANNEL.to_string());
    args.push("--execution-id".to_string());
    args.push(bridge.execution_id.clone());
    if let Some(listen) = bridge.proxy_listen {
        args.push("--proxy-listen".to_string());
        args.push(listen.to_string());
    }
    for probe in visible_probes {
        args.push("--probe-visible".to_string());
        args.push(path_string(probe)?);
    }
    for probe in hidden_probes {
        args.push("--probe-hidden".to_string());
        args.push(path_string(probe)?);
    }
    for probe in not_socket_probes {
        args.push("--probe-not-socket".to_string());
        args.push(path_string(probe)?);
    }
    args.push("--".to_string());
    args.extend(inner_command.iter().cloned());

    let launcher = settings.launcher_shell.clone();
    let script = launcher_script();
    let mut argv = vec![
        path_string(&launcher)?,
        "-c".to_string(),
        script,
        "nession-sandbox".to_string(),
        cgroup_procs
            .map(path_string)
            .transpose()?
            .unwrap_or_default(),
        path_string(seccomp_profile)?,
        path_string(&settings.bubblewrap_path)?,
    ];
    argv.extend(args);
    Ok(BwrapPlan { argv, warnings })
}

fn launcher_script() -> String {
    // `$1` is the cgroup procs file, `$2` the seccomp profile, the rest the
    // exact Bubblewrap argv. No user-controlled string is interpreted by the
    // shell: the arguments are positional and quoted.
    "set -e\n\
     cg=$1\n\
     prof=$2\n\
     shift 2\n\
     if [ -n \"$cg\" ]; then printf '%s' \"$$\" > \"$cg\"; fi\n\
     exec 3<\"$prof\"\n\
     exec \"$@\"\n"
        .to_string()
}

fn push_bind(args: &mut Vec<String>, flag: &str, source: &Path, destination: &Path) {
    if let (Ok(source), Ok(destination)) = (path_string(source), path_string(destination)) {
        args.push(flag.to_string());
        args.push(source);
        args.push(destination);
    }
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| SandboxError::InvalidPolicy(format!("path {} is not UTF-8", path.display())))
}

/// Mask the tmux socket and Agent state when no filesystem policy hides them.
fn mask_host_control_paths(
    args: &mut Vec<String>,
    forbidden: &ForbiddenPaths,
    warnings: &mut Vec<String>,
) -> bool {
    let mut masked = false;
    let mut masked_directories: Vec<PathBuf> = Vec::new();
    for path in &forbidden.directories {
        if path.exists() {
            args.push("--tmpfs".to_string());
            args.push(path.to_string_lossy().into_owned());
            warnings.push(format!("backend baseline: masked {}", path.display()));
            masked_directories.push(path.clone());
            masked = true;
        }
    }
    // Host runtime state lives under `/run` (Docker/D-Bus/user sockets, pid
    // files). A fresh tmpfs removes all of it without enumerating individual
    // sockets, and makes `/run/nession` mountable on the read-only root.
    let run = Path::new("/run");
    if run.exists() {
        args.push("--tmpfs".to_string());
        args.push("/run".to_string());
        warnings.push("backend baseline: masked /run host runtime state".to_string());
        masked_directories.push(run.to_path_buf());
        masked = true;
    }
    // Do not ask bwrap to create a mount point for a file that a masked
    // directory already hides: `/var/run` is a symlink to `/run` on most
    // hosts, and creating `/var/run/docker.sock` through that symlink after
    // `/run` became a tmpfs fails the whole launch. Canonicalize so the
    // symlinked spelling is recognized as living under the masked directory.
    let canonical_masked: Vec<PathBuf> = masked_directories
        .iter()
        .filter_map(|directory| std::fs::canonicalize(directory).ok())
        .collect();
    for path in &forbidden.files {
        if !path.exists() {
            continue;
        }
        if let Ok(canonical) = std::fs::canonicalize(path) {
            if canonical_masked
                .iter()
                .any(|directory| canonical.starts_with(directory))
            {
                continue;
            }
        }
        args.push("--ro-bind".to_string());
        args.push("/dev/null".to_string());
        args.push(path.to_string_lossy().into_owned());
        warnings.push(format!("backend baseline: masked {}", path.display()));
        masked = true;
    }
    masked
}

fn scrub_control_environment(args: &mut Vec<String>) {
    for name in [
        "TMUX",
        "TMUX_PANE",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "GPG_AGENT_INFO",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
    ] {
        args.push("--unsetenv".to_string());
        args.push(name.to_string());
    }
}

fn unset_proxy_environment(args: &mut Vec<String>) {
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        args.push("--unsetenv".to_string());
        args.push(name.to_string());
    }
}

/// Add merged-`/usr` symlinks for the classic top-level paths so a policy that
/// lists `/usr` can still execute `/bin/sh`. Only links whose host target is
/// itself visible are added.
fn merged_usr_symlinks(filesystem: &CompiledFilesystem) -> Vec<(String, String)> {
    let mut links = Vec::new();
    for link in ["/bin", "/sbin", "/lib", "/lib64"] {
        let link_path = Path::new(link);
        if filesystem.is_visible(link_path) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(link_path) else {
            continue;
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(target) = std::fs::read_link(link_path) else {
            continue;
        };
        if target.is_absolute() {
            continue;
        }
        let resolved = Path::new("/").join(&target);
        if filesystem.is_visible(&resolved) {
            links.push((target.to_string_lossy().into_owned(), link.to_string()));
        }
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::compile;
    use nession_protocol::contracts::sandbox::v1::SandboxPolicy;

    fn compiled(value: serde_json::Value) -> CompiledSandboxPolicy {
        let policy: SandboxPolicy = serde_json::from_value(value).expect("fixture");
        compile(&policy).expect("compiled")
    }

    fn settings() -> SandboxSettings {
        SandboxSettings::new(
            PathBuf::from("/tmp/state"),
            PathBuf::from("/usr/local/bin/nession-agent"),
            PathBuf::from("bwrap"),
            PathBuf::from("/usr/bin/sandbox-exec"),
        )
    }

    fn bridge() -> BridgePlacement {
        BridgePlacement {
            host_bridge: PathBuf::from("/usr/local/bin/nession-agent"),
            host_channel: PathBuf::from("/tmp/state/executions/x/channel.sock"),
            execution_id: "exec-1".to_string(),
            proxy_listen: None,
            bridge_subcommand: "__nession-sandbox-bridge".to_string(),
        }
    }

    #[test]
    fn base_namespaces_are_always_present_and_net_follows_the_policy() {
        let plan = build(
            &compiled(serde_json::json!({
                "enabled": true,
                "network": { "mode": "deny" }
            })),
            Path::new("/tmp"),
            &ForbiddenPaths::default(),
            &bridge(),
            &[],
            &[],
            &[],
            Path::new("/tmp/seccomp"),
            None,
            &["/bin/sh".to_string(), "-l".to_string()],
            &settings(),
        )
        .expect("plan");
        for flag in [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-net",
        ] {
            assert!(plan.argv.contains(&flag.to_string()), "{flag} missing");
        }
    }

    #[test]
    fn no_network_policy_does_not_unshare_the_network() {
        let plan = build(
            &compiled(serde_json::json!({ "enabled": true })),
            Path::new("/tmp"),
            &ForbiddenPaths::default(),
            &bridge(),
            &[],
            &[],
            &[],
            Path::new("/tmp/seccomp"),
            None,
            &["/bin/sh".to_string(), "-l".to_string()],
            &settings(),
        )
        .expect("plan");
        assert!(!plan.argv.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn exposing_the_tmux_socket_is_refused() {
        let filesystem = compiled(serde_json::json!({
            "enabled": true,
            "filesystem": { "access": { "read": ["/tmp"], "write": [] } }
        }));
        let forbidden = ForbiddenPaths {
            files: vec![PathBuf::from("/tmp/tmux.sock")],
            directories: Vec::new(),
        };
        let error = build(
            &filesystem,
            Path::new("/tmp"),
            &forbidden,
            &bridge(),
            &[],
            &[],
            &[],
            Path::new("/tmp/seccomp"),
            None,
            &["/bin/sh".to_string(), "-l".to_string()],
            &settings(),
        )
        .expect_err("policy exposes the tmux socket");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
    }

    #[test]
    fn the_launcher_reads_its_inputs_only_as_positional_arguments() {
        let script = launcher_script();
        assert!(script.contains("cg=$1"));
        assert!(script.contains("exec 3<\"$prof\""));
        assert!(script.contains("exec \"$@\""));
        assert!(!script.contains("${1}"));
        assert!(!script.contains("eval"));
    }

    #[test]
    fn control_environment_is_scrubbed() {
        let mut args = Vec::new();
        scrub_control_environment(&mut args);
        for name in [
            "TMUX",
            "TMUX_PANE",
            "SSH_AUTH_SOCK",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            assert!(args.contains(&name.to_string()));
        }
    }

    #[test]
    fn a_file_hidden_by_a_masked_directory_is_not_bound_through_its_symlink() {
        let dir = tempfile::tempdir().expect("tempdir");
        let masked = dir.path().join("run");
        std::fs::create_dir(&masked).expect("masked directory");
        let file = masked.join("docker.sock");
        std::fs::write(&file, b"").expect("socket stand-in");
        let link = dir.path().join("var-run");
        std::os::unix::fs::symlink(&masked, &link).expect("symlink");
        let linked_file = link.join("docker.sock");
        let forbidden = ForbiddenPaths {
            files: vec![linked_file.clone()],
            directories: vec![masked],
        };
        let mut args = Vec::new();
        let mut warnings = Vec::new();
        assert!(mask_host_control_paths(
            &mut args,
            &forbidden,
            &mut warnings
        ));
        assert!(
            !args.iter().any(|argument| argument == &linked_file.to_string_lossy()),
            "a file already hidden by the masked directory must not be bound through its symlink: {args:?}"
        );
    }
}
