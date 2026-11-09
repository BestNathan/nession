//! Print the host's measured Sandbox capabilities as one JSON line.
//!
//! Used by the #2681 Acceptance Cases: a Case whose required mechanism is
//! absent reports Pending with this measured reason instead of inferring a
//! guarantee from source or substituting another OS.

use std::path::PathBuf;

use nession_sandbox::SandboxSettings;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut state_dir = None;
    let mut bridge = None;
    let mut index = 0;
    while index < arguments.len() {
        let Some(argument) = arguments.get(index) else {
            break;
        };
        match argument.as_str() {
            "--state-dir" => {
                index += 1;
                state_dir = arguments.get(index).map(PathBuf::from);
            }
            "--bridge" => {
                index += 1;
                bridge = arguments.get(index).map(PathBuf::from);
            }
            other => {
                eprintln!("nession-sandbox-probe: unknown argument `{other}`");
                std::process::exit(2);
            }
        }
        index += 1;
    }

    let state_dir = state_dir.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("nession-sandbox-probe-{}", std::process::id()))
    });
    let bridge = bridge
        .or_else(|| {
            let executable = std::env::current_exe().ok()?;
            let sibling = executable.parent()?.join("nession-sandbox-bridge");
            sibling.exists().then_some(sibling)
        })
        .unwrap_or_else(|| PathBuf::from("nession-sandbox-bridge"));

    let settings = SandboxSettings::new(
        state_dir,
        bridge,
        PathBuf::from("bwrap"),
        PathBuf::from("/usr/bin/sandbox-exec"),
    );
    let capabilities = nession_sandbox::probe(&settings);

    let namespaces = serde_json::json!({
        "user": capabilities.namespaces.user,
        "pid": capabilities.namespaces.pid,
        "ipc": capabilities.namespaces.ipc,
        "uts": capabilities.namespaces.uts,
        "cgroup": capabilities.namespaces.cgroup,
        "net": capabilities.namespaces.net,
    });
    let cgroup_v2 = capabilities.cgroup_v2.as_ref().map(|support| {
        serde_json::json!({
            "root": support.root.display().to_string(),
            "controllers": support.controllers.iter().collect::<Vec<_>>(),
            "detail": support.detail,
        })
    });
    let seatbelt = capabilities.seatbelt.as_ref().map(|seatbelt| {
        serde_json::json!({
            "filesystem": seatbelt.filesystem,
            "network_deny": seatbelt.network_deny,
            "detail": seatbelt.detail,
        })
    });
    let document = serde_json::json!({
        "platform": capabilities.platform.as_str(),
        "backend": capabilities.backend,
        "unavailable": capabilities.unavailable,
        "namespaces": namespaces,
        "cgroup_v2": cgroup_v2,
        "seccomp": capabilities.seccomp,
        "filesystem": capabilities.filesystem,
        "network_allow": capabilities.network_allow,
        "network_deny": capabilities.network_deny,
        "network_restricted": capabilities.network_restricted,
        "seatbelt": seatbelt,
        "bridge": capabilities.bridge,
        "detail": capabilities.detail,
    });
    match serde_json::to_string(&document) {
        Ok(json) => println!("NESSON_SANDBOX_CAPABILITIES {json}"),
        Err(error) => {
            eprintln!("nession-sandbox-probe: serialize capabilities: {error}");
            std::process::exit(1);
        }
    }
}
