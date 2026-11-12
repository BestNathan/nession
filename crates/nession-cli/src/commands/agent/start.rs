//! `nession agent start` — start the Agent daemon.
//!
//! The background branch re-executes this same command as a detached
//! foreground child. `--config` and `--pid-file` are forwarded, so the child
//! loads the file the parent resolved and records its identity where every
//! later `stop`/`status` looks. The credential travels over stdin, never argv
//! (#2269).

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, release, secret_handoff, startup};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use tracing::info;

/// Run the leaf command.
pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
    auth_token_stdin: bool,
) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Agent, config)?;
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Agent)?;
    // A registered OS service owns the Agent's lifecycle. `start` may report
    // the manager's live process (it is idempotent), but it must not create a
    // second, unmanaged one beside a registered service (#3232 F5).
    match crate::service::guard_agent_lifecycle(
        crate::service::AgentLifecycleAction::Start,
        &state,
    )? {
        crate::service::AgentLifecycleGuard::AlreadyRunning => {
            println!(
                "Agent is already running under {} supervision; start is idempotent.",
                crate::service::manager_name()
            );
            return Ok(());
        }
        crate::service::AgentLifecycleGuard::Proceed => {}
    }
    // One lifecycle command at a time across every installed release. The
    // runtime identity is shared, so the lock must be too. The foreground child
    // of a background start inherits the parent's lock through its marker; it
    // must not take the same lock again.
    let lock = if foreground
        && std::env::var_os(crate::lifecycle::lock::LOCK_HELD_BY_PARENT_ENV).is_some()
    {
        None
    } else {
        Some(LifecycleLock::acquire()?)
    };
    run_with(
        selection,
        foreground,
        state,
        server_url_override,
        auth_token_override,
        auth_token_stdin,
        lock,
    )
    .await
}

/// Start with an already-resolved configuration selection and state location,
/// holding the lifecycle lock.
///
/// `restart` uses this entry point so the replacement it validated is the same
/// selection this start loads, and the state file it stopped is the one this
/// start writes.
pub(crate) async fn run_with(
    selection: ConfigSelection,
    foreground: bool,
    state: pid_file::StateFiles,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
    auth_token_stdin: bool,
    lock: Option<LifecycleLock>,
) -> Result<()> {
    // Child half of the background credential handoff (#2269). The parent that
    // re-executed us resolved the effective token and wrote it to our stdin;
    // its value wins over whatever this process parsed for itself, because the
    // parent already applied flag > env > config precedence. Reading it here,
    // first, also means a child that fails for another reason has still taken
    // the credential out of the pipe rather than leaving it there.
    let auth_token_override = if auth_token_stdin {
        if !foreground {
            anyhow::bail!(
                "{} is only valid for the foreground child of a background start",
                secret_handoff::AUTH_TOKEN_STDIN_ARG
            );
        }
        Some(secret_handoff::read_auth_token()?)
    } else {
        auth_token_override
    };

    // Ensure durable component directories exist before file operations. The
    // runtime state directory was already created by `StateFiles::from_cli`
    // for the default location; an explicit `--pid-file` keeps its historical
    // behaviour of not creating its parent.
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Already running, decided by ownership rather than by pid (#1016) — and
    // over both locations, so a still-live daemon from a pre-runtime binary
    // cannot be duplicated merely because the new runtime file is absent.
    //
    // Start is idempotent by requirement: a live Agent is reported and left
    // alone, even when the selected release differs from the running one. Only
    // `restart` replaces a running process.
    let inspection = pid_file::Inspection::of(&state);
    if let Some((record, identity)) = inspection.live() {
        println!(
            "Agent is already running with PID {} (release {}, state file {}); start is idempotent.",
            identity.pid,
            identity.release_version.as_deref().unwrap_or("unknown"),
            record.path
        );
        return Ok(());
    }
    // A live Server from another release is a conflict, not something this
    // command may fix by restarting it.
    release::ensure_no_mixed_release(pid_file::Component::Server, pid_file::Component::Agent)?;
    inspection.clean_dead();
    for warning in inspection.unresolved_warnings("agent") {
        eprintln!("Warning: {warning}");
    }

    let loaded = configuration::load_agent(&selection, &server_url_override, &auth_token_override)?;
    let from_file = loaded.from_file;
    let config = loaded.config;
    let config_path = selection.path.to_string_lossy().into_owned();
    let origin = configuration::describe_origin(&selection.path, from_file);

    if foreground {
        info!("Starting agent in foreground mode");
        println!("Starting nession-agent with {origin}");
        println!("Agent ID: {}", config.agent_id);
        println!("Press Ctrl+C to stop");

        // Record this process's identity together with the configuration it
        // actually loaded, so `status` can report a verified source instead of
        // presenting a default file as live state.
        pid_file::write_identity(
            &state.current,
            pid_file::Component::Agent,
            pid_file::ConfigRecord::from_loaded(&selection.path, from_file),
        )?;

        // A foreground daemon owns the terminal for its whole lifetime. Holding
        // the lifecycle lock here would block every later stop/restart/install,
        // so release it once this process has recorded its identity.
        drop(lock);
        let result = run_agent_foreground(config).await;

        let _ = fs::remove_file(&state.current);

        result?;
    } else {
        info!("Starting agent in background mode");
        let exe = std::env::current_exe()?;

        // The token is not an argument (#2269): see `background_child_command`
        // and `lifecycle::secret_handoff` for the channel it travels over.
        let mut cmd = background_child_command(
            &exe,
            &selection,
            &state.current,
            server_url_override.as_deref(),
            auth_token_override.as_deref(),
        );

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

        // A path only this start knows, so a marker left by an earlier run
        // cannot be mistaken for this child's announcement.
        let marker = startup::ReadyMarker::beside_state_file(&state.current);
        marker.arm(&mut cmd);

        let mut child = cmd.spawn().context("failed to spawn agent process")?;

        // Hand the credential over after spawn, then close the pipe. The child
        // blocks on this read before it can load its config, so the write must
        // not wait for readiness. A failed write leaves a child that can never
        // start, so it is reaped rather than abandoned.
        if let Some(token) = auth_token_override.as_deref() {
            if let Err(error) = secret_handoff::write_auth_token(&mut child, token) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }

        match startup::wait_for_ready(&mut child, &marker, startup::STARTUP_TIMEOUT).await {
            startup::Startup::Serving => {
                let pid = startup::announced_pid(&state.current)?;
                println!("Agent started in background with PID {pid}");
                println!("PID file: {}", state.current);
            }
            startup::Startup::Exited(status) => {
                let detail = startup::child_stderr(&mut child);
                let _ = fs::remove_file(&state.current);
                anyhow::bail!(
                    "Agent exited before it was serving ({status}){}",
                    if detail.is_empty() {
                        "; check the logs".to_string()
                    } else {
                        format!(": {detail}")
                    }
                );
            }
            startup::Startup::TimedOut => {
                startup::terminate(&mut child);
                let detail = startup::child_stderr(&mut child);
                let _ = fs::remove_file(&state.current);
                anyhow::bail!(
                    "Agent did not report itself serving within {}s{}",
                    startup::STARTUP_TIMEOUT.as_secs(),
                    if detail.is_empty() {
                        "; check the logs".to_string()
                    } else {
                        format!(": {detail}")
                    }
                );
            }
        }
        drop(lock);
        if from_file {
            println!("Config: {config_path}");
        } else {
            println!("Config: {origin}");
        }
    }

    Ok(())
}

/// The command a background start re-executes itself with.
///
/// Extracted from [`run`] so the invariants #2269 and #2869 fix are asserted
/// against the same vector the parent actually spawns, rather than a parallel
/// copy built for a test:
///
/// - the resolved credential is not in the child's argument vector (#2269);
/// - an implicit selection stays implicit across re-exec (#2869 SC-01+03). The
///   child resolves the same documented default path itself, so an absent
///   default file still means "use defaults" instead of turning into an
///   explicit `--config` that must exist.
pub(crate) fn background_child_command(
    exe: &Path,
    selection: &ConfigSelection,
    pid_file: &str,
    server_url_override: Option<&str>,
    auth_token_override: Option<&str>,
) -> Command {
    let mut cmd = Command::new(exe);
    let mut child_args: Vec<String> = vec!["agent".to_string(), "start".to_string()];
    if selection.explicit {
        child_args.push("--config".to_string());
        child_args.push(selection.path.to_string_lossy().into_owned());
    }
    child_args.extend([
        "--foreground".to_string(),
        // Forwarded, so the child records its identity where this parent —
        // and every later `stop`/`status` — looks for it (#1016).
        "--pid-file".to_string(),
        pid_file.to_string(),
    ]);
    if let Some(url) = server_url_override {
        child_args.push("--server-url".to_string());
        child_args.push(url.to_string());
    }
    let hands_off_token = auth_token_override.is_some();
    if hands_off_token {
        child_args.push(secret_handoff::AUTH_TOKEN_STDIN_ARG.to_string());
    }
    cmd.args(&child_args)
        .env(crate::lifecycle::lock::LOCK_HELD_BY_PARENT_ENV, "1")
        .stdin(if hands_off_token {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        // Captured until the child either becomes ready or exits: its own
        // failure sentence is more useful than "check the logs" (#2869).
        .stderr(Stdio::piped());
    cmd
}

/// Run the Agent runtime in foreground mode (blocks until shutdown).
async fn run_agent_foreground(config: nession_agent::config::AgentConfig) -> Result<()> {
    // The composition is owned by `nession_agent::runtime` (#1014), not this
    // entrypoint. A background start re-execs this path with the readiness
    // variable set, so this one call serves both a foreground start a user
    // typed and the child of a daemon parent waiting to be told it serves
    // (#1016).
    nession_agent::runtime::run(config, nession_common::readiness::Readiness::from_env()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The credential these tests use. Distinctive enough that a substring
    /// search over the child's vector cannot pass by accident.
    const SECRET: &str = "fake-auth-token-for-2269";

    fn background_command(auth_token_override: Option<&str>) -> Command {
        background_child_command(
            Path::new("/bin/true"),
            &explicit_selection("/custom/agent.toml"),
            "agent.pid",
            None,
            auth_token_override,
        )
    }

    fn explicit_selection(path: &str) -> ConfigSelection {
        ConfigSelection {
            path: Path::new(path).to_path_buf(),
            explicit: true,
        }
    }

    fn implicit_selection(path: &str) -> ConfigSelection {
        ConfigSelection {
            path: Path::new(path).to_path_buf(),
            explicit: false,
        }
    }

    fn argv(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// #2269 at the vector both flag- and env-sourced credentials feed: the
    /// credential selects the *channel*, and the value itself never appears in
    /// the re-executed child's argument vector or environment.
    #[test]
    fn a_resolved_credential_is_carried_by_the_channel_not_the_argv() {
        let command = background_command(Some(SECRET));
        let argv = argv(&command);

        assert!(
            !argv.iter().any(|arg| arg.contains(SECRET)),
            "the re-exec child's argv must not carry the credential: {argv:?}"
        );
        assert!(
            argv.iter()
                .any(|arg| arg == secret_handoff::AUTH_TOKEN_STDIN_ARG),
            "the child must be pointed at the handoff channel instead: {argv:?}"
        );
        let env: Vec<_> = command.get_envs().collect();
        assert!(
            !env.iter()
                .any(|(_, value)| value
                    .is_some_and(|value| value.to_string_lossy().contains(SECRET))),
            "the re-exec child's environment must not carry the credential: {env:?}"
        );
    }

    #[test]
    fn a_start_without_an_override_has_no_handoff_channel() {
        let command = background_command(None);

        let argv = argv(&command);
        assert!(
            !argv
                .iter()
                .any(|arg| arg == secret_handoff::AUTH_TOKEN_STDIN_ARG),
            "no credential, no channel: {argv:?}"
        );
    }

    /// SC-03: the background child receives both the resolved config file and
    /// the resolved PID file. A child that wrote the default path would leave
    /// every later `stop`/`status` looking at a file nothing wrote (#1016).
    #[test]
    fn the_background_child_receives_the_resolved_config_and_pid_file() {
        let command = background_child_command(
            Path::new("/bin/true"),
            &explicit_selection("/custom/agent.toml"),
            "/custom/agent.pid",
            Some("ws://server:1"),
            None,
        );
        let argv = argv(&command);
        for expected in [
            "--config",
            "/custom/agent.toml",
            "--pid-file",
            "/custom/agent.pid",
            "--server-url",
            "ws://server:1",
        ] {
            assert!(
                argv.iter().any(|arg| arg == expected),
                "missing {expected}: {argv:?}"
            );
        }
    }

    /// #2869 SC-01+03: an implicit parent selection must stay implicit in the
    /// child. Passing the resolved default as `--config` would make the child
    /// treat an absent default file as an explicit, missing selection.
    #[test]
    fn an_implicit_selection_is_not_converted_into_an_explicit_flag() {
        let command = background_child_command(
            Path::new("/bin/true"),
            &implicit_selection("/home/me/.nession/agent-config.toml"),
            "/custom/agent.pid",
            None,
            None,
        );
        let argv = argv(&command);

        assert!(
            !argv.iter().any(|arg| arg == "--config"),
            "an implicit selection must not gain --config across re-exec: {argv:?}"
        );
        assert!(
            !argv.iter().any(|arg| arg.ends_with("agent-config.toml")),
            "the resolved default path must not be forwarded: {argv:?}"
        );
        assert!(
            argv.iter().any(|arg| arg == "--pid-file"),
            "the pid file still identifies the child: {argv:?}"
        );
    }
}
