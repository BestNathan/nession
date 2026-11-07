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
//!
//! **Every generated start argv forwards the resolved `--config` and
//! `--pid-file`.** The immediate start spawned by `install-service` uses the
//! same argv, so the process the service supervises and the process started
//! now record their identity where `stop`/`status` look (#1016). Native
//! service-manager supervision remains the owner of #1016/#363; this module
//! only emits the artifacts and immediate start.

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

use crate::lifecycle::pid_file;

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
    let selection = crate::configuration::ConfigSelection::resolve(
        crate::configuration::ConfigTarget::Agent,
        config_path,
    )?;
    if !selection.path.exists() {
        anyhow::bail!(
            "Agent config file not found at '{}'.\n\
             Fix: run `nession config agent init{}` first, then re-run this command.",
            selection.path.display(),
            if selection.explicit {
                format!(" --config {}", selection.path.display())
            } else {
                String::new()
            }
        );
    }
    let config_path_str = absolute_path(&selection.path)?;

    let pid_file_str = absolute_path(Path::new(&pid_file::resolve_path(
        pid_file,
        pid_file::Component::Agent,
    )))?;

    let exe = std::env::current_exe().context("failed to resolve current executable path")?;
    let exe_str = absolute_path(&exe)?;

    let nession_home = std::env::var("NESSION_HOME")
        .ok()
        .map(|home| absolute_path(Path::new(&home)))
        .transpose()?;

    install_platform(
        &config_path_str,
        &pid_file_str,
        &exe_str,
        nession_home.as_deref(),
    )?;

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

    // Start the agent immediately unless an owned process is already running.
    // Ownership, not a bare pid (#1016): a reused pid is not this Agent.
    let already_running = matches!(
        pid_file::ownership(&pid_file_str),
        Ok(pid_file::Ownership::Alive(_))
    );

    if already_running {
        println!("Agent already running — skipping start (service will manage it on next boot).");
    } else {
        start_agent_now(&config_path_str, &pid_file_str)?;
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
fn install_platform(
    config_path: &str,
    pid_file: &str,
    exe_path: &str,
    nession_home: Option<&str>,
) -> Result<()> {
    let unit_dir = systemd_user_unit_dir()?;
    fs::create_dir_all(&unit_dir).with_context(|| {
        format!(
            "failed to create systemd user unit dir: {}",
            unit_dir.display()
        )
    })?;
    let unit_path = unit_dir.join(SYSTEMD_UNIT_NAME);

    let unit_content = systemd_unit_content(exe_path, config_path, pid_file, nession_home);

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
fn install_platform(
    config_path: &str,
    pid_file: &str,
    exe_path: &str,
    nession_home: Option<&str>,
) -> Result<()> {
    let agents_dir = launchd_agents_dir()?;
    fs::create_dir_all(&agents_dir).with_context(|| {
        format!(
            "failed to create LaunchAgents dir: {}",
            agents_dir.display()
        )
    })?;
    let plist_path = agents_dir.join(LAUNCHD_PLIST_NAME);

    let plist_content = launchd_plist_content(exe_path, config_path, pid_file, nession_home);

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
    _pid_file: &str,
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

/// Make a service path absolute.
///
/// A service manager does not run in the operator's current directory, so a
/// relative `--config`/`--pid-file` would point somewhere else at boot. The
/// path does not have to exist (a pid file usually does not yet).
fn absolute_path(path: &Path) -> Result<String> {
    let absolute = std::path::absolute(path)
        .with_context(|| format!("failed to make '{}' absolute", path.display()))?;
    let text = absolute.to_string_lossy().into_owned();
    if text.contains(['\n', '\r']) {
        anyhow::bail!("service paths must not contain a newline: {text:?}");
    }
    Ok(text)
}

/// Quote one systemd command-line argument.
///
/// systemd unit files are not a shell: arguments are split on whitespace, `%`
/// starts a specifier and `$` starts variable expansion. Every argv element is
/// double-quoted with those characters escaped, so a path with spaces or
/// special characters starts the same file the operator selected (#2869
/// SC-03).
#[cfg(target_os = "linux")]
fn systemd_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(';', "\\;")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// Escape an `Environment=` value: specifiers apply, `$` does not expand there.
#[cfg(target_os = "linux")]
fn systemd_environment_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
}

/// Escape text for an XML text node or attribute value.
#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The systemd user unit this command installs.
///
/// Pure so the emitted argv can be asserted: both `--config` and `--pid-file`
/// must name the selections this process resolved.
#[cfg(target_os = "linux")]
fn systemd_unit_content(
    exe_path: &str,
    config_path: &str,
    pid_file: &str,
    nession_home: Option<&str>,
) -> String {
    let env_lines = nession_home
        .map(|home| {
            format!(
                "Environment=\"NESSION_HOME={}\"\n",
                systemd_environment_value(home)
            )
        })
        .unwrap_or_default();
    let exec_start = [
        exe_path,
        "agent",
        "start",
        "--config",
        config_path,
        "--foreground",
        "--pid-file",
        pid_file,
    ]
    .iter()
    .map(|argument| systemd_quote(argument))
    .collect::<Vec<_>>()
    .join(" ");
    format!(
        "[Unit]\n\
         Description=Nession Agent (boot autostart)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec_start}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         {env_lines}\n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

/// The launchd LaunchAgent plist this command installs.
#[cfg(target_os = "macos")]
fn launchd_plist_content(
    exe_path: &str,
    config_path: &str,
    pid_file: &str,
    nession_home: Option<&str>,
) -> String {
    let env_block = match nession_home {
        Some(home) => format!(
            "  <key>EnvironmentVariables</key>\n  <dict>\n    \
             <key>NESSION_HOME</key>\n    <string>{}</string>\n  </dict>\n",
            xml_escape(home)
        ),
        None => String::new(),
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n  <string>com.nession.agent</string>\n\
         \x20 <key>ProgramArguments</key>\n  <array>\n    \
         <string>{exe}</string>\n    \
         <string>agent</string>\n    \
         <string>start</string>\n    \
         <string>--config</string>\n    \
         <string>{config}</string>\n    \
         <string>--foreground</string>\n    \
         <string>--pid-file</string>\n    \
         <string>{pid}</string>\n  </array>\n\
         {env_block}\
         \x20 <key>RunAtLoad</key>\n  <true/>\n\
         \x20 <key>KeepAlive</key>\n  <true/>\n\
         \x20 <key>StandardOutPath</key>\n  <string>/tmp/nession-agent.launchd.out</string>\n\
         \x20 <key>StandardErrorPath</key>\n  <string>/tmp/nession-agent.launchd.err</string>\n\
         </dict>\n\
         </plist>\n",
        exe = xml_escape(exe_path),
        config = xml_escape(config_path),
        pid = xml_escape(pid_file),
    )
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

/// The command `install-service` spawns immediately after installing.
///
/// Same selections as the generated service artifact, so the running Agent
/// records the identity the service will use on the next boot.
fn immediate_start_command(config_path: &str, pid_file: &str) -> Result<std::process::Command> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe().context("failed to resolve current executable path")?;
    let mut cmd = Command::new(exe);
    cmd.args([
        "agent",
        "start",
        "--config",
        config_path,
        "--foreground",
        "--pid-file",
        pid_file,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    Ok(cmd)
}

/// Spawn a detached agent process running in foreground mode.
fn start_agent_now(config_path: &str, pid_file: &str) -> Result<()> {
    let mut cmd = immediate_start_command(config_path, pid_file)?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_status_returns_known_value() {
        let status = service_status();
        assert!(
            status == "installed (systemd)"
                || status == "installed (launchd)"
                || status == "not installed",
            "unexpected status: {status}"
        );
    }

    /// SC-03: the generated artifact must start the Agent with the same
    /// `--config` and `--pid-file` the command resolved. A dropped pid file
    /// leaves every later `stop`/`status` reading a path nothing wrote.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_systemd_unit_forwards_config_and_pid_file() {
        let unit = systemd_unit_content(
            "/usr/local/bin/nession",
            "/custom/agent.toml",
            "/custom/agent.pid",
            Some("/custom/home"),
        );
        assert!(
            unit.contains(
                "ExecStart=\"/usr/local/bin/nession\" \"agent\" \"start\" \"--config\" \"/custom/agent.toml\" \"--foreground\" \"--pid-file\" \"/custom/agent.pid\""
            ),
            "{unit}"
        );
        assert!(
            unit.contains("Environment=\"NESSION_HOME=/custom/home\""),
            "{unit}"
        );
    }

    /// Parse a systemd ExecStart value back into argv under systemd's quoting
    /// rules: double quotes group whitespace, a backslash escapes the next
    /// character, and `%%`/`$$` are the literal forms of `%`/`$`.
    #[cfg(target_os = "linux")]
    fn parse_systemd_argv(line: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let mut chars = line.chars().peekable();
        while let Some(character) = chars.next() {
            match character {
                '"' => in_quotes = !in_quotes,
                '\\' => {
                    if let Some(escaped) = chars.next() {
                        current.push(escaped);
                    }
                }
                ' ' | '\t' if !in_quotes => {
                    if !current.is_empty() {
                        args.push(std::mem::take(&mut current));
                    }
                }
                '%' => {
                    if chars.peek() == Some(&'%') {
                        let _ = chars.next();
                    }
                    current.push('%');
                }
                '$' => {
                    if chars.peek() == Some(&'$') {
                        let _ = chars.next();
                    }
                    current.push('$');
                }
                _ => current.push(character),
            }
        }
        if !current.is_empty() {
            args.push(current);
        }
        args
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_artifacts_escape_awkward_paths_into_the_same_argv() {
        let exe = "/opt/Nession Tools/bin/nession";
        let config = "/home/me/Config %20 $HOME;dir/agent.toml";
        let pid_file = "/tmp/agent \"quoted\".pid";
        let home = "/home/me/Home %x $y";

        let unit = systemd_unit_content(exe, config, pid_file, Some(home));
        let exec_start = unit
            .lines()
            .find_map(|line| line.strip_prefix("ExecStart="))
            .expect("ExecStart line");

        assert_eq!(
            parse_systemd_argv(exec_start),
            vec![
                exe.to_string(),
                "agent".to_string(),
                "start".to_string(),
                "--config".to_string(),
                config.to_string(),
                "--foreground".to_string(),
                "--pid-file".to_string(),
                pid_file.to_string(),
            ],
            "{exec_start}"
        );
        assert!(
            unit.contains("Environment=\"NESSION_HOME=/home/me/Home %%x $y\""),
            "specifiers are doubled; `$` is not expanded in Environment=: {unit}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_launchd_plist_forwards_config_and_pid_file_with_valid_escaping() {
        let plist = launchd_plist_content(
            "/opt/My Tools/nession",
            "/home/me/Config & Data/agent.toml",
            "/tmp/agent \"quoted\".pid",
            Some("/home/me/Home <x>"),
        );
        for expected in [
            "<string>/opt/My Tools/nession</string>",
            "<string>/home/me/Config &amp; Data/agent.toml</string>",
            "<string>/tmp/agent &quot;quoted&quot;.pid</string>",
            "<string>/home/me/Home &lt;x&gt;</string>",
        ] {
            assert!(plist.contains(expected), "missing {expected}: {plist}");
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("com.nession.agent.plist");
        std::fs::write(&path, &plist).expect("write plist");
        let status = std::process::Command::new("plutil")
            .arg("-lint")
            .arg(&path)
            .status()
            .expect("run plutil");
        assert!(status.success(), "launchd plist must parse: {plist}");
    }

    #[test]
    fn relative_service_paths_are_made_absolute() {
        let relative = absolute_path(Path::new("relative/agent.toml")).expect("absolute");
        assert!(Path::new(&relative).is_absolute(), "{relative}");
        assert!(relative.ends_with("relative/agent.toml"), "{relative}");

        let absolute = absolute_path(Path::new("/already/agent.toml")).expect("absolute");
        assert_eq!(absolute, "/already/agent.toml");
    }

    #[test]
    fn the_immediate_start_uses_the_same_selections() {
        let command =
            immediate_start_command("/custom/agent.toml", "/custom/agent.pid").expect("command");
        let argv: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "agent",
            "start",
            "--config",
            "/custom/agent.toml",
            "--foreground",
            "--pid-file",
            "/custom/agent.pid",
        ] {
            assert!(
                argv.iter().any(|arg| arg == expected),
                "missing {expected}: {argv:?}"
            );
        }
    }

    #[test]
    fn install_service_fails_when_config_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.toml");
        let err = install_service(Some(missing.to_string_lossy().into_owned()), None)
            .expect_err("expected error when config missing");
        let msg = err.to_string();
        assert!(
            msg.contains("run `nession config agent init"),
            "error should hint at init command, got: {msg}"
        );
    }
}
