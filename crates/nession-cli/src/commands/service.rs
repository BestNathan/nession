//! Agent boot autostart service installation/uninstallation.
//!
//! Provides `install-service` and `uninstall-service` subcommands that register
//! a user-level OS service so the agent starts automatically at boot.
//!
//! - Linux: systemd user unit at `~/.config/systemd/user/nession-agent.service`
//! - macOS: launchd LaunchAgent at `~/Library/LaunchAgents/com.nession.agent.plist`
//!
//! The service runs the agent in foreground mode under the service manager's
//! supervision, which handles restarts on failure.

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use crate::utils::pid_file;

/// Name of the systemd user unit (without directory).
#[cfg(target_os = "linux")]
const SYSTEMD_UNIT_NAME: &str = "nession-agent.service";

/// Name of the launchd plist (without directory).
#[cfg(target_os = "macos")]
const LAUNCHD_PLIST_NAME: &str = "com.nession.agent.plist";

/// Install the autostart service for the current user.
///
/// Writes the service unit/plist, enables it, and starts the agent immediately
/// unless a valid PID file indicates it is already running.
pub fn install_service(config_path: Option<String>, pid_file: Option<String>) -> Result<()> {
    let config_path = resolve_config_path(config_path)?;
    if !config_path.exists() {
        anyhow::bail!(
            "Agent config file not found at '{}'.\n\
             Fix: run `nession config agent init` first, then re-run this command.",
            config_path.display()
        );
    }
    let config_path_str = config_path.to_string_lossy().into_owned();

    let pid_file_path = resolve_pid_path(pid_file)?;

    let exe = std::env::current_exe().context("failed to resolve current executable path")?;
    let exe_str = exe.to_string_lossy().into_owned();

    let nession_home = std::env::var("NESSION_HOME").ok();

    install_platform(&config_path_str, &exe_str, nession_home.as_deref())?;

    println!("Autostart service installed.");
    println!("  Binary: {exe_str}");
    println!("  Config: {config_path_str}");
    if let Some(home) = nession_home.as_ref() {
        println!("  NENSION_HOME: {home}");
    }
    println!();
    println!(
        "Note: the binary path is snapshotted now. After `nession update`, \
         re-run `nession agent install-service` to point the service at the new binary."
    );

    // Start the agent immediately unless it is already running.
    let pid_file_str = pid_file_path.to_string_lossy().into_owned();
    let already_running = pid_file::read_pid_file(&pid_file_str)
        .ok()
        .map(pid_file::is_process_running)
        .unwrap_or(false);

    if already_running {
        println!("Agent already running — skipping start (service will manage it on next boot).");
    } else {
        start_agent_now(&config_path_str)?;
    }

    Ok(())
}

/// Uninstall the autostart service for the current user.
///
/// Disables and removes the service unit/plist. Does NOT stop a running agent.
pub fn uninstall_service() -> Result<()> {
    uninstall_platform()?;
    println!("Autostart service uninstalled.");
    println!(
        "Note: the running agent (if any) was NOT stopped. \
         Run `nession agent stop` to stop it manually."
    );
    Ok(())
}

/// Report whether the autostart service is installed.
///
/// Returns one of:
/// - `"installed (systemd)"`
/// - `"installed (launchd)"`
/// - `"not installed"`
pub fn service_status() -> &'static str {
    service_status_platform()
}

// ---------------------------------------------------------------------------
// Platform-specific implementations
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn install_platform(config_path: &str, exe_path: &str, nession_home: Option<&str>) -> Result<()> {
    let unit_dir = systemd_user_unit_dir()?;
    fs::create_dir_all(&unit_dir).with_context(|| {
        format!(
            "failed to create systemd user unit dir: {}",
            unit_dir.display()
        )
    })?;
    let unit_path = unit_dir.join(SYSTEMD_UNIT_NAME);

    let mut env_lines = String::new();
    if let Some(home) = nession_home {
        env_lines.push_str(&format!("Environment=NESSION_HOME={home}\n"));
    }

    let unit_content = format!(
        "[Unit]\n\
         Description=Nession Agent (boot autostart)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exe_path} agent start --config {config_path} --foreground\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         {env_lines}\n\
         [Install]\n\
         WantedBy=default.target\n"
    );

    fs::write(&unit_path, unit_content)
        .with_context(|| format!("failed to write systemd unit: {}", unit_path.display()))?;

    run_cmd("systemctl", &["--user", "daemon-reload"])?;
    run_cmd("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME])?;

    // Best-effort: enable linger so user services start at boot without a login session.
    if let Ok(user) = std::env::var("USER") {
        if let Err(e) = run_cmd("loginctl", &["enable-linger", &user]) {
            eprintln!(
                "Warning: could not enable linger for user '{user}': {e}\n\
                 The agent service may not start at boot until you log in interactively.\n\
                 Fix: run `loginctl enable-linger {user}` manually (may require sudo)."
            );
        }
    } else {
        eprintln!(
            "Warning: $USER not set — could not enable linger.\n\
             Fix: run `loginctl enable-linger <your-username>` manually (may require sudo)."
        );
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_platform() -> Result<()> {
    let unit_dir = systemd_user_unit_dir()?;
    let unit_path = unit_dir.join(SYSTEMD_UNIT_NAME);
    if !unit_path.exists() {
        println!("Service unit not present — nothing to uninstall.");
        return Ok(());
    }

    // Disable first (ignore errors — unit might already be disabled).
    let _ = run_cmd("systemctl", &["--user", "disable", SYSTEMD_UNIT_NAME]);
    fs::remove_file(&unit_path)
        .with_context(|| format!("failed to remove systemd unit: {}", unit_path.display()))?;
    let _ = run_cmd("systemctl", &["--user", "daemon-reload"]);
    Ok(())
}

#[cfg(target_os = "linux")]
fn service_status_platform() -> &'static str {
    match systemd_user_unit_dir() {
        Ok(dir) if dir.join(SYSTEMD_UNIT_NAME).exists() => "installed (systemd)",
        _ => "not installed",
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_unit_dir() -> Result<PathBuf> {
    // Honour $XDG_CONFIG_HOME if set; otherwise ~/.config.
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else {
        let home = std::env::var("HOME")
            .context("$HOME not set — cannot locate systemd user unit directory")?;
        PathBuf::from(home).join(".config")
    };
    Ok(base.join("systemd").join("user"))
}

#[cfg(target_os = "macos")]
fn install_platform(config_path: &str, exe_path: &str, nession_home: Option<&str>) -> Result<()> {
    let agents_dir = launchd_agents_dir()?;
    fs::create_dir_all(&agents_dir).with_context(|| {
        format!(
            "failed to create LaunchAgents dir: {}",
            agents_dir.display()
        )
    })?;
    let plist_path = agents_dir.join(LAUNCHD_PLIST_NAME);

    let env_block = match nession_home {
        Some(home) => format!(
            "  <key>EnvironmentVariables</key>\n  <dict>\n    \
             <key>NESSION_HOME</key>\n    <string>{home}</string>\n  </dict>\n"
        ),
        None => String::new(),
    };

    let plist_content = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n  <string>com.nession.agent</string>\n\
         \x20 <key>ProgramArguments</key>\n  <array>\n    \
         <string>{exe_path}</string>\n    \
         <string>agent</string>\n    \
         <string>start</string>\n    \
         <string>--config</string>\n    \
         <string>{config_path}</string>\n    \
         <string>--foreground</string>\n  </array>\n\
         {env_block}\
         \x20 <key>RunAtLoad</key>\n  <true/>\n\
         \x20 <key>KeepAlive</key>\n  <true/>\n\
         \x20 <key>StandardOutPath</key>\n  <string>/tmp/nession-agent.launchd.out</string>\n\
         \x20 <key>StandardErrorPath</key>\n  <string>/tmp/nession-agent.launchd.err</string>\n\
         </dict>\n\
         </plist>\n"
    );

    fs::write(&plist_path, plist_content)
        .with_context(|| format!("failed to write launchd plist: {}", plist_path.display()))?;

    // Unload first in case an older plist is already loaded (idempotent).
    let _ = run_cmd("launchctl", &["unload", &plist_path.to_string_lossy()]);
    run_cmd("launchctl", &["load", &plist_path.to_string_lossy()])?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn uninstall_platform() -> Result<()> {
    let agents_dir = launchd_agents_dir()?;
    let plist_path = agents_dir.join(LAUNCHD_PLIST_NAME);
    if !plist_path.exists() {
        println!("LaunchAgent plist not present — nothing to uninstall.");
        return Ok(());
    }
    // Unload (ignore errors — might not be loaded).
    let _ = run_cmd("launchctl", &["unload", &plist_path.to_string_lossy()]);
    fs::remove_file(&plist_path)
        .with_context(|| format!("failed to remove launchd plist: {}", plist_path.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn service_status_platform() -> &'static str {
    match launchd_agents_dir() {
        Ok(dir) if dir.join(LAUNCHD_PLIST_NAME).exists() => "installed (launchd)",
        _ => "not installed",
    }
}

#[cfg(target_os = "macos")]
fn launchd_agents_dir() -> Result<PathBuf> {
    let home =
        std::env::var("HOME").context("$HOME not set — cannot locate LaunchAgents directory")?;
    Ok(PathBuf::from(home).join("Library").join("LaunchAgents"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn install_platform(
    _config_path: &str,
    _exe_path: &str,
    _nession_home: Option<&str>,
) -> Result<()> {
    anyhow::bail!(
        "install-service is not supported on this platform.\n\
         Fix: on Linux (systemd) or macOS (launchd) only. \
         On other platforms, configure autostart manually."
    );
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn uninstall_platform() -> Result<()> {
    anyhow::bail!(
        "uninstall-service is not supported on this platform.\n\
         Fix: on Linux (systemd) or macOS (launchd) only."
    );
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn service_status_platform() -> &'static str {
    "not installed"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_config_path(explicit: Option<String>) -> Result<PathBuf> {
    match explicit {
        Some(p) => Ok(PathBuf::from(p)),
        None => nession_common::paths::agent_config_path()
            .context("failed to resolve default agent config path"),
    }
}

fn resolve_pid_path(explicit: Option<String>) -> Result<PathBuf> {
    match explicit {
        Some(p) => Ok(PathBuf::from(p)),
        None => nession_common::paths::agent_pid_path()
            .context("failed to resolve default agent PID path"),
    }
}

/// Spawn a detached agent process running in foreground mode.
///
/// Mirrors the logic in `commands::agent::start` (background branch) but does
/// not go through the full config-reload path — we just want the service to
/// pick up the same config file it was registered with.
fn start_agent_now(config_path: &str) -> Result<()> {
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe().context("failed to resolve current executable path")?;

    let mut cmd = Command::new(&exe);
    cmd.args(["agent", "start", "--config", config_path, "--foreground"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let _child = cmd
        .spawn()
        .context("failed to spawn agent process for immediate start")?;

    println!("Agent started in background.");
    Ok(())
}

/// Run a command, returning a friendly error on failure.
fn run_cmd(program: &str, args: &[&str]) -> Result<()> {
    use std::process::Command;
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("failed to execute `{program}` — is it installed?"))?;
    if !status.success() {
        anyhow::bail!(
            "`{program} {}` failed with exit code {}.\n\
             Fix: check the command output above for details.",
            args.join(" "),
            status.code().unwrap_or(-1)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_status_returns_known_value() {
        // On any platform, the status should be one of the three documented strings.
        let status = service_status();
        assert!(
            status == "installed (systemd)"
                || status == "installed (launchd)"
                || status == "not installed",
            "unexpected status: {status}"
        );
    }

    #[test]
    fn resolve_config_path_uses_default_when_none() {
        // Just verify it does not panic; the actual path depends on $HOME / $NESSION_HOME.
        let _ = resolve_config_path(None);
    }

    #[test]
    fn resolve_config_path_explicit_wins() {
        let p = resolve_config_path(Some("/tmp/does-not-exist.toml".into())).unwrap();
        assert_eq!(p, PathBuf::from("/tmp/does-not-exist.toml"));
    }

    #[test]
    fn install_service_fails_when_config_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.toml");
        let err = install_service(Some(missing.to_string_lossy().into_owned()), None)
            .expect_err("expected error when config missing");
        let msg = err.to_string();
        assert!(
            msg.contains("run `nession config agent init`"),
            "error should hint at init command, got: {msg}"
        );
    }
}
