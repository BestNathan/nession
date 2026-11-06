//! The command router and module inventory.
//!
//! Each leaf command has exactly one handler file. This module only maps the
//! parsed [`crate::args`] tree onto those handlers and resolves the two shared
//! inputs (remote target/credential, daemon overrides). Business logic does
//! not live here.

pub mod agent;
pub mod agents;
pub mod config;
pub mod server;
pub mod sessions;
pub mod update;

use anyhow::Result;

use crate::args::{
    AgentAction, AgentsAction, Cli, Commands, ConfigAction, ConfigSubAction, ServerAction,
    SessionsAction,
};
use crate::connection;

/// Route one parsed command to its single owner.
pub async fn dispatch(cli: Cli) -> Result<()> {
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
            SessionsAction::Create { agent_id, name } => {
                let url = connection::resolve_server_url(server_url);
                let token = connection::resolve_auth_token(auth_token);
                sessions::create::run(&url, &token, &agent_id, &name).await?
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
        "server/restart.rs",
        "server/start.rs",
        "server/status.rs",
        "server/stop.rs",
        "sessions/attach.rs",
        "sessions/create.rs",
        "sessions/kill.rs",
        "sessions/list.rs",
        "update.rs",
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
}
