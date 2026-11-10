//! The command router and module inventory.
//!
//! Each leaf command has exactly one handler file. This module only maps the
//! parsed [`crate::args`] tree onto those handlers and resolves the two shared
//! inputs (remote target/credential, daemon overrides). Business logic does
//! not live here.

pub mod agent;
pub mod agents;
pub mod config;
pub mod install;
pub mod server;
pub mod sessions;
pub mod update;
pub mod version;

use anyhow::{Context, Result};

use crate::args::{
    AgentAction, AgentsAction, Cli, Commands, ConfigAction, ConfigSubAction, ServerAction,
    SessionsAction, VersionAction,
};
use crate::connection;

/// Whether a leaf's handler actually reads the two global target/credential
/// flags.
///
/// `--server-url`/`--auth-token` are the remote target for `agents`/`sessions`
/// and the daemon outbound override for `agent start`/`restart`. Every other
/// leaf has no use for them (#2869 SC-03).
fn consumes_global_target_flags(command: &Commands) -> bool {
    match command {
        Commands::Agent { action } => {
            matches!(
                action,
                AgentAction::Start { .. } | AgentAction::Restart { .. }
            )
        }
        Commands::Agents { .. } | Commands::Sessions { .. } => true,
        Commands::Server { .. }
        | Commands::Config { .. }
        | Commands::Install { .. }
        | Commands::Version { .. }
        | Commands::Update { .. } => false,
    }
}

/// The user-facing path of a parsed command, for diagnostics.
fn command_path(command: &Commands) -> &'static str {
    match command {
        Commands::Agent { action } => match action {
            AgentAction::Start { .. } => "agent start",
            AgentAction::Stop { .. } => "agent stop",
            AgentAction::Restart { .. } => "agent restart",
            AgentAction::Status { .. } => "agent status",
            AgentAction::InstallService { .. } => "agent install-service",
            AgentAction::UninstallService => "agent uninstall-service",
        },
        Commands::Server { action } => match action {
            ServerAction::Start { .. } => "server start",
            ServerAction::Stop { .. } => "server stop",
            ServerAction::Restart { .. } => "server restart",
            ServerAction::Status { .. } => "server status",
        },
        Commands::Agents { .. } => "agents list",
        Commands::Sessions { action } => match action {
            SessionsAction::List { .. } => "sessions list",
            SessionsAction::Attach { .. } => "sessions attach",
            SessionsAction::Create { .. } => "sessions create",
            SessionsAction::Kill { .. } => "sessions kill",
        },
        Commands::Config { action } => match action {
            ConfigAction::Agent { action } => match action {
                ConfigSubAction::Init { .. } => "config agent init",
                ConfigSubAction::Show { .. } => "config agent show",
                ConfigSubAction::Set { .. } => "config agent set",
            },
            ConfigAction::Server { action } => match action {
                ConfigSubAction::Init { .. } => "config server init",
                ConfigSubAction::Show { .. } => "config server show",
                ConfigSubAction::Set { .. } => "config server set",
            },
        },
        Commands::Install { .. } => "install",
        Commands::Version { action } => match action {
            VersionAction::List => "version list",
        },
        Commands::Update { .. } => "update",
    }
}

/// Reject a global flag on a command that never reads it.
///
/// The flags are declared globally so they work both before and after the
/// subcommand (an existing spelling), but "parses" is not "has an effect":
/// silently ignoring `--auth-token` on `server start` would look like a
/// credential was applied when it was not (#2869 SC-03/SC-05).
fn reject_unconsumed_global_flags(
    command: &Commands,
    server_url: &Option<String>,
    auth_token: &Option<String>,
) -> Result<()> {
    if consumes_global_target_flags(command) {
        return Ok(());
    }
    let mut rejected = Vec::new();
    if server_url.is_some() {
        rejected.push("--server-url");
    }
    if auth_token.is_some() {
        rejected.push("--auth-token");
    }
    if rejected.is_empty() {
        return Ok(());
    }
    anyhow::bail!(
        "`nession {}` does not consume {}.\n\
         `--server-url`/`--auth-token` select the remote Server for `agents`/`sessions` \
         and override an Agent daemon's outbound target for `agent start`/`agent restart`; \
         remove the flag for this command.",
        command_path(command),
        rejected.join(" and ")
    )
}

/// Route one parsed command to its single owner.
pub async fn dispatch(cli: Cli) -> Result<()> {
    reject_unconsumed_global_flags(&cli.command, &cli.server_url, &cli.auth_token)?;

    let Cli {
        command,
        server_url,
        auth_token,
    } = cli;

    match command {
        Commands::Agent { action } => match action {
            AgentAction::Start {
                config,
                foreground,
                pid_file,
                auth_token_stdin,
            } => {
                agent::start::run(
                    config,
                    foreground,
                    pid_file,
                    server_url.or_else(connection::environment_server_url),
                    auth_token.or_else(connection::environment_auth_token),
                    auth_token_stdin,
                )
                .await?
            }
            AgentAction::Stop { pid_file } => agent::stop::run(pid_file).await?,
            AgentAction::Restart {
                config,
                foreground,
                pid_file,
            } => {
                agent::restart::run(
                    config,
                    foreground,
                    pid_file,
                    server_url.or_else(connection::environment_server_url),
                    auth_token.or_else(connection::environment_auth_token),
                )
                .await?
            }
            AgentAction::Status { pid_file } => agent::status::run(pid_file).await?,
            AgentAction::InstallService { config, pid_file } => {
                agent::install_service::run(config, pid_file)?
            }
            AgentAction::UninstallService => agent::uninstall_service::run()?,
        },
        Commands::Server { action } => match action {
            ServerAction::Start {
                config,
                foreground,
                pid_file,
            } => server::start::run(config, foreground, pid_file).await?,
            ServerAction::Stop { pid_file } => server::stop::run(pid_file).await?,
            ServerAction::Restart {
                config,
                foreground,
                pid_file,
            } => server::restart::run(config, foreground, pid_file).await?,
            ServerAction::Status { pid_file } => server::status::run(pid_file).await?,
        },
        Commands::Agents { action } => match action {
            AgentsAction::List => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                agents::list::run(&url, &token).await?
            }
        },
        Commands::Sessions { action } => match action {
            SessionsAction::List { agent_id } => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                sessions::list::run(&url, &token, agent_id.as_deref()).await?
            }
            SessionsAction::Attach { session_id, mode } => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                sessions::attach::run(&url, &token, &session_id, mode.as_deref()).await?
            }
            SessionsAction::Create {
                agent_id,
                name,
                sandbox_policy,
            } => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                let policy = sandbox_policy
                    .map(|path| {
                        let text = std::fs::read_to_string(&path)
                            .with_context(|| format!("read Sandbox policy {}", path.display()))?;
                        serde_json::from_str::<
                            nession_protocol::contracts::sandbox::v1::SandboxPolicy,
                        >(&text)
                        .with_context(|| format!("parse Sandbox policy {} as JSON", path.display()))
                    })
                    .transpose()?;
                sessions::create::run(&url, &token, &agent_id, &name, policy).await?
            }
            SessionsAction::Kill { session_id, force } => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                sessions::kill::run(&url, &token, &session_id, force).await?
            }
        },
        Commands::Config { action } => match action {
            ConfigAction::Agent { action } => match action {
                ConfigSubAction::Init { force, config } => config::agent::init::run(force, config)?,
                ConfigSubAction::Show { config } => config::agent::show::run(config)?,
                ConfigSubAction::Set { key, value, config } => {
                    config::agent::set::run(&key, &value, config)?
                }
            },
            ConfigAction::Server { action } => match action {
                ConfigSubAction::Init { force, config } => {
                    config::server::init::run(force, config)?
                }
                ConfigSubAction::Show { config } => config::server::show::run(config)?,
                ConfigSubAction::Set { key, value, config } => {
                    config::server::set::run(&key, &value, config)?
                }
            },
        },
        Commands::Install {
            version,
            dry_run,
            yes,
        } => install::run(version, dry_run, yes).await?,
        Commands::Version { action } => match action {
            VersionAction::List => version::run().await?,
        },
        Commands::Update {
            check,
            version,
            dry_run,
            yes,
            include_installer,
        } => update::run(check, version, dry_run, yes, include_installer).await?,
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    /// One entry per leaf command: the file that owns it.
    ///
    /// This is the checked-in command/module inventory. A new leaf command
    /// without a file (or a file without an entry) fails the inventory test.
    const LEAF_FILES: &[&str] = &[
        "agent/install_service.rs",
        "agent/restart.rs",
        "agent/start.rs",
        "agent/status.rs",
        "agent/stop.rs",
        "agent/uninstall_service.rs",
        "agents/list.rs",
        "config/agent/init.rs",
        "config/agent/set.rs",
        "config/agent/show.rs",
        "config/server/init.rs",
        "config/server/set.rs",
        "config/server/show.rs",
        "install.rs",
        "server/restart.rs",
        "server/start.rs",
        "server/status.rs",
        "server/stop.rs",
        "sessions/attach.rs",
        "sessions/create.rs",
        "sessions/kill.rs",
        "sessions/list.rs",
        "update.rs",
        "version.rs",
    ];

    fn collect_rust_files(dir: &Path, root: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).expect("read command dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                collect_rust_files(&path, root, out);
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && path.file_name().is_some_and(|name| name != "mod.rs")
            {
                out.insert(
                    path.strip_prefix(root)
                        .expect("inside commands")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }

    #[test]
    fn every_leaf_command_has_exactly_one_handler_file() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut found = BTreeSet::new();
        collect_rust_files(&root, &root, &mut found);
        let expected: BTreeSet<String> = LEAF_FILES.iter().map(ToString::to_string).collect();
        assert_eq!(
            found, expected,
            "the leaf-command inventory changed; give the new command one file and list it here"
        );
    }

    #[test]
    fn every_handler_file_exposes_a_run_entry_point() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        for leaf in LEAF_FILES {
            let source = std::fs::read_to_string(root.join(leaf)).expect("read handler");
            assert!(
                source.contains("pub fn run(") || source.contains("pub async fn run("),
                "{leaf} must expose the leaf's `run` entry point"
            );
        }
    }

    #[test]
    fn main_is_only_startup_and_dispatch() {
        let main_path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "src", "main.rs"]
            .iter()
            .collect();
        let main = std::fs::read_to_string(main_path).expect("read main");
        assert!(
            !main.contains("#[derive(Parser)]") && !main.contains("#[derive(Subcommand)]"),
            "Clap definitions belong to args.rs, not main.rs"
        );
        assert!(
            main.lines().count() < 60,
            "main.rs must stay a thin startup/dispatch entrypoint"
        );
    }

    /// Every leaf either consumes the global target flags or rejects them;
    /// none may parse and silently ignore them (#2869 SC-03).
    #[test]
    fn the_global_flag_applicability_matrix_is_pinned() {
        use crate::args::Cli;
        use clap::Parser;

        fn parse(argv: &[&str]) -> Commands {
            let mut args = vec!["nession"];
            args.extend_from_slice(argv);
            Cli::try_parse_from(&args)
                .unwrap_or_else(|error| panic!("{argv:?} must parse: {error}"))
                .command
        }

        let consumed: &[&[&str]] = &[
            &["agent", "start"],
            &["agent", "restart"],
            &["agents", "list"],
            &["sessions", "list"],
            &["sessions", "create", "--agent-id", "a", "--name", "n"],
            &["sessions", "attach", "--session-id", "a:b"],
            &["sessions", "kill", "--session-id", "a:b"],
        ];
        for argv in consumed {
            assert!(
                consumes_global_target_flags(&parse(argv)),
                "{argv:?} must consume the global flags"
            );
        }

        let rejected: &[&[&str]] = &[
            &["agent", "stop"],
            &["agent", "status"],
            &["agent", "install-service"],
            &["agent", "uninstall-service"],
            &["server", "start"],
            &["server", "stop"],
            &["server", "restart"],
            &["server", "status"],
            &["config", "agent", "init"],
            &["config", "agent", "show"],
            &["config", "agent", "set", "terminal_cols", "96"],
            &["config", "server", "init"],
            &["config", "server", "show"],
            &["config", "server", "set", "terminal_cols", "96"],
            &["install", "0.35.0"],
            &["version", "list"],
            &["update"],
        ];
        for argv in rejected {
            let command = parse(argv);
            assert!(
                !consumes_global_target_flags(&command),
                "{argv:?} must not claim to consume the global flags"
            );
            assert!(
                reject_unconsumed_global_flags(&command, &None, &None).is_ok(),
                "absent flags are always fine"
            );
            let error = reject_unconsumed_global_flags(
                &command,
                &Some("ws://example:1".to_string()),
                &Some("do-not-echo-this".to_string()),
            )
            .expect_err("a flag with no effect must be rejected");
            let message = format!("{error:#}");
            assert!(
                message.contains(command_path(&command)) && message.contains("does not consume"),
                "{message}"
            );
            assert!(
                !message.contains("do-not-echo-this"),
                "the rejection must not echo the credential: {message}"
            );
        }
    }
}
