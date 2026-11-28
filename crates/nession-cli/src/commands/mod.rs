//! The command router and module inventory.
//!
//! Each leaf command has exactly one handler file. This module only maps the
//! parsed [`crate::args`] tree onto those handlers and resolves the shared
//! inputs: the one remote [`crate::connection::ConnectionContext`] for
//! `agents`/`sessions`, and the daemon overrides for `agent start`/`restart`.
//! Business logic does not live here.

pub mod agent;
pub mod agents;
pub mod config;
pub mod install;
pub mod profile;
pub mod server;
pub mod sessions;
pub mod update;
pub mod version;

use anyhow::{Context, Result};

use crate::args::{
    AgentAction, AgentsAction, Cli, Commands, ConfigAction, ConfigSubAction, CredentialAction,
    ProfileAction, ServerAction, SessionsAction, VersionAction,
};
use crate::connection;

/// Whether a leaf reads `--server-url`.
///
/// The flag is the remote target for `agents`/`sessions`, the endpoint stored
/// by `profile add`/`set`, and the daemon outbound override for `agent start`/
/// `restart`. Every other leaf has no use for it (#2869 SC-03, #4682).
fn consumes_server_url(command: &Commands) -> bool {
    match command {
        Commands::Agent { action } => {
            matches!(
                action,
                AgentAction::Start { .. } | AgentAction::Restart { .. }
            )
        }
        Commands::Agents { .. } | Commands::Sessions { .. } => true,
        Commands::Profile { action } => {
            matches!(
                action,
                ProfileAction::Add { .. } | ProfileAction::Set { .. }
            )
        }
        Commands::Server { .. }
        | Commands::Config { .. }
        | Commands::Install { .. }
        | Commands::Version { .. }
        | Commands::Update { .. } => false,
    }
}

/// Whether a leaf reads `--auth-token`.
///
/// No profile leaf accepts it: client credentials are set through
/// `profile credential set` (prompt/stdin), never as argv (#4682).
fn consumes_auth_token(command: &Commands) -> bool {
    match command {
        Commands::Agent { action } => {
            matches!(
                action,
                AgentAction::Start { .. } | AgentAction::Restart { .. }
            )
        }
        Commands::Agents { .. } | Commands::Sessions { .. } => true,
        Commands::Profile { .. }
        | Commands::Server { .. }
        | Commands::Config { .. }
        | Commands::Install { .. }
        | Commands::Version { .. }
        | Commands::Update { .. } => false,
    }
}

/// Whether a leaf reads `--profile`.
///
/// Only the remote `agents`/`sessions` leaves select a connection profile.
/// Daemon lifecycle never runs profile resolution; profile management leaves
/// name their profile positionally; local-only commands have no remote target.
fn consumes_profile(command: &Commands) -> bool {
    matches!(command, Commands::Agents { .. } | Commands::Sessions { .. })
}

/// The user-facing path of a parsed command, for diagnostics.
fn command_path(command: &Commands) -> &'static str {
    match command {
        Commands::Agent { action } => match action {
            AgentAction::Start { .. } => "agent start",
            AgentAction::Stop { .. } => "agent stop",
            AgentAction::Restart { .. } => "agent restart",
            AgentAction::Status { .. } => "agent status",
            AgentAction::Logs { .. } => "agent logs",
            AgentAction::InstallService { .. } => "agent install-service",
            AgentAction::UninstallService => "agent uninstall-service",
        },
        Commands::Server { action } => match action {
            ServerAction::Start { .. } => "server start",
            ServerAction::Stop { .. } => "server stop",
            ServerAction::Restart { .. } => "server restart",
            ServerAction::Status { .. } => "server status",
            ServerAction::Logs { .. } => "server logs",
        },
        Commands::Agents { .. } => "agents list",
        Commands::Sessions { action } => match action {
            SessionsAction::List { .. } => "sessions list",
            SessionsAction::Attach { .. } => "sessions attach",
            SessionsAction::Create { .. } => "sessions create",
            SessionsAction::Kill { .. } => "sessions kill",
        },
        Commands::Profile { action } => match action {
            ProfileAction::List => "profile list",
            ProfileAction::Current => "profile current",
            ProfileAction::Add { .. } => "profile add",
            ProfileAction::Use { .. } => "profile use",
            ProfileAction::Show { .. } => "profile show",
            ProfileAction::Set { .. } => "profile set",
            ProfileAction::Remove { .. } => "profile remove",
            ProfileAction::ImportAgent { .. } => "profile import-agent",
            ProfileAction::Test { .. } => "profile test",
            ProfileAction::Credential { action } => match action {
                CredentialAction::Set { .. } => "profile credential set",
                CredentialAction::Clear { .. } => "profile credential clear",
            },
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
            VersionAction::Inspect { .. } => "version inspect",
            VersionAction::Recover { .. } => "version recover",
        },
        Commands::Update { .. } => "update",
    }
}

/// Reject a global flag on a command that never reads it.
///
/// The flags are declared globally so they work both before and after the
/// subcommand (an existing spelling), but "parses" is not "has an effect":
/// silently ignoring `--auth-token` on `server start` would look like a
/// credential was applied when it was not (#2869 SC-03/SC-05). The same
/// applies to `--profile` on daemon/local commands (#4682 SC-06).
fn reject_unconsumed_global_flags(
    command: &Commands,
    server_url: &Option<String>,
    auth_token: &Option<String>,
    profile: &Option<String>,
) -> Result<()> {
    let mut rejected = Vec::new();
    if server_url.is_some() && !consumes_server_url(command) {
        rejected.push("--server-url");
    }
    if auth_token.is_some() && !consumes_auth_token(command) {
        rejected.push("--auth-token");
    }
    if profile.is_some() && !consumes_profile(command) {
        rejected.push("--profile");
    }
    if rejected.is_empty() {
        return Ok(());
    }
    anyhow::bail!(
        "`nession {}` does not consume {}.\n\
         `--server-url`/`--auth-token` select the remote Server for `agents`/`sessions`, \
         store the endpoint for `profile add`/`set` (`--server-url` only), and override an \
         Agent daemon's outbound target for `agent start`/`agent restart`; `--profile` selects \
         a stored client profile for `agents`/`sessions` only. Remove the flag for this command.",
        command_path(command),
        rejected.join(" and ")
    )
}

/// Route one parsed command to its single owner.
pub async fn dispatch(cli: Cli) -> Result<()> {
    reject_unconsumed_global_flags(&cli.command, &cli.server_url, &cli.auth_token, &cli.profile)?;

    let Cli {
        command,
        server_url,
        auth_token,
        profile,
        // Intercepted before Clap in `main`; never reaches dispatch.
        lifecycle_contract: _,
        client_profile_contract: _,
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
            AgentAction::Logs(options) => agent::logs::run(options).await?,
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
            ServerAction::Logs(options) => server::logs::run(options).await?,
        },
        Commands::Agents { action } => match action {
            AgentsAction::List => {
                let ctx = connection::resolve_remote(connection::RemoteInputs {
                    server_url,
                    profile,
                    auth_token,
                })
                .await?;
                agents::list::run(&ctx.server_url, &ctx.auth_token)
                    .await
                    .with_context(|| connection::failure_context(&ctx))?
            }
        },
        Commands::Sessions { action } => match action {
            SessionsAction::List { agent_id } => {
                let ctx = connection::resolve_remote(connection::RemoteInputs {
                    server_url,
                    profile,
                    auth_token,
                })
                .await?;
                sessions::list::run(&ctx.server_url, &ctx.auth_token, agent_id.as_deref())
                    .await
                    .with_context(|| connection::failure_context(&ctx))?
            }
            SessionsAction::Attach { session_id, mode } => {
                let ctx = connection::resolve_remote(connection::RemoteInputs {
                    server_url,
                    profile,
                    auth_token,
                })
                .await?;
                sessions::attach::run(
                    &ctx.server_url,
                    &ctx.auth_token,
                    &session_id,
                    mode.as_deref(),
                )
                .await
                .with_context(|| connection::failure_context(&ctx))?
            }
            SessionsAction::Create {
                agent_id,
                name,
                sandbox_policy,
            } => {
                let ctx = connection::resolve_remote(connection::RemoteInputs {
                    server_url,
                    profile,
                    auth_token,
                })
                .await?;
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
                sessions::create::run(&ctx.server_url, &ctx.auth_token, &agent_id, &name, policy)
                    .await
                    .with_context(|| connection::failure_context(&ctx))?
            }
            SessionsAction::Kill { session_id, force } => {
                let ctx = connection::resolve_remote(connection::RemoteInputs {
                    server_url,
                    profile,
                    auth_token,
                })
                .await?;
                sessions::kill::run(&ctx.server_url, &ctx.auth_token, &session_id, force)
                    .await
                    .with_context(|| connection::failure_context(&ctx))?
            }
        },
        Commands::Profile { action } => match action {
            ProfileAction::List => profile::list::run()?,
            ProfileAction::Current => profile::current::run()?,
            ProfileAction::Add { name, no_auth } => profile::add::run(name, server_url, no_auth)?,
            ProfileAction::Use { name } => profile::use_profile::run(&name)?,
            ProfileAction::Show { name } => profile::show::run(&name)?,
            ProfileAction::Set { name, no_auth } => {
                profile::set::run(name, server_url, no_auth).await?
            }
            ProfileAction::Remove { name, force } => profile::remove::run(&name, force).await?,
            ProfileAction::ImportAgent { name, config } => {
                profile::import_agent::run(name, config)?
            }
            ProfileAction::Test { name } => profile::test::run(name).await?,
            ProfileAction::Credential { action } => match action {
                CredentialAction::Set { name, stdin } => {
                    profile::credential::set::run(&name, stdin).await?
                }
                CredentialAction::Clear { name } => profile::credential::clear::run(&name).await?,
            },
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
            local_artifact,
            artifact_sha256,
            policy,
        } => {
            install::run(
                version,
                dry_run,
                yes,
                local_artifact,
                artifact_sha256,
                policy.to_overrides(),
            )
            .await?
        }
        Commands::Version { action } => match action {
            VersionAction::List => version::list::run().await?,
            VersionAction::Inspect { version } => version::inspect::run(version)?,
            VersionAction::Recover { version } => version::recover::run(version)?,
        },
        Commands::Update {
            check,
            version,
            dry_run,
            yes,
            include_installer,
            policy,
        } => {
            update::run(
                check,
                version,
                dry_run,
                yes,
                include_installer,
                policy.to_overrides(),
            )
            .await?
        }
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
        "agent/logs.rs",
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
        "profile/add.rs",
        "profile/credential/clear.rs",
        "profile/credential/set.rs",
        "profile/current.rs",
        "profile/import_agent.rs",
        "profile/list.rs",
        "profile/remove.rs",
        "profile/set.rs",
        "profile/show.rs",
        "profile/test.rs",
        "profile/use_profile.rs",
        "server/logs.rs",
        "server/restart.rs",
        "server/start.rs",
        "server/status.rs",
        "server/stop.rs",
        "sessions/attach.rs",
        "sessions/create.rs",
        "sessions/kill.rs",
        "sessions/list.rs",
        "update.rs",
        "version/inspect.rs",
        "version/list.rs",
        "version/recover.rs",
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

    /// Every leaf either consumes each global flag or rejects it; none may
    /// parse and silently ignore it (#2869 SC-03, #4682 SC-06).
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

        // (argv, consumes --server-url, consumes --auth-token, consumes --profile)
        let matrix: &[(&[&str], bool, bool, bool)] = &[
            (&["agent", "start"], true, true, false),
            (&["agent", "restart"], true, true, false),
            (&["agents", "list"], true, true, true),
            (&["sessions", "list"], true, true, true),
            (
                &["sessions", "create", "--agent-id", "a", "--name", "n"],
                true,
                true,
                true,
            ),
            (
                &["sessions", "attach", "--session-id", "a:b"],
                true,
                true,
                true,
            ),
            (
                &["sessions", "kill", "--session-id", "a:b"],
                true,
                true,
                true,
            ),
            (&["profile", "list"], false, false, false),
            (&["profile", "current"], false, false, false),
            (&["profile", "add", "home"], true, false, false),
            (&["profile", "use", "home"], false, false, false),
            (&["profile", "show", "home"], false, false, false),
            (&["profile", "set", "home"], true, false, false),
            (&["profile", "remove", "home"], false, false, false),
            (&["profile", "import-agent"], false, false, false),
            (&["profile", "test"], false, false, false),
            (
                &["profile", "credential", "set", "home"],
                false,
                false,
                false,
            ),
            (
                &["profile", "credential", "clear", "home"],
                false,
                false,
                false,
            ),
            (&["agent", "stop"], false, false, false),
            (&["agent", "status"], false, false, false),
            (&["agent", "logs"], false, false, false),
            (&["server", "logs"], false, false, false),
            (&["agent", "install-service"], false, false, false),
            (&["agent", "uninstall-service"], false, false, false),
            (&["server", "start"], false, false, false),
            (&["server", "stop"], false, false, false),
            (&["server", "restart"], false, false, false),
            (&["server", "status"], false, false, false),
            (&["config", "agent", "init"], false, false, false),
            (&["config", "agent", "show"], false, false, false),
            (
                &["config", "agent", "set", "terminal_cols", "96"],
                false,
                false,
                false,
            ),
            (&["config", "server", "init"], false, false, false),
            (&["config", "server", "show"], false, false, false),
            (
                &["config", "server", "set", "terminal_cols", "96"],
                false,
                false,
                false,
            ),
            (&["install", "0.35.0"], false, false, false),
            (&["version", "list"], false, false, false),
            (&["update"], false, false, false),
        ];

        for (argv, url, token, profile) in matrix {
            let command = parse(argv);
            assert_eq!(
                consumes_server_url(&command),
                *url,
                "{argv:?} --server-url applicability"
            );
            assert_eq!(
                consumes_auth_token(&command),
                *token,
                "{argv:?} --auth-token applicability"
            );
            assert_eq!(
                consumes_profile(&command),
                *profile,
                "{argv:?} --profile applicability"
            );
            assert!(
                reject_unconsumed_global_flags(&command, &None, &None, &None).is_ok(),
                "absent flags are always fine"
            );
            let error = reject_unconsumed_global_flags(
                &command,
                &Some("ws://example:1".to_string()),
                &Some("do-not-echo-this".to_string()),
                &Some("do-not-echo-profile".to_string()),
            );
            if *url && *token && *profile {
                assert!(error.is_ok(), "{argv:?} consumes all three flags");
            } else {
                let error = error.expect_err("a flag with no effect must be rejected");
                let message = format!("{error:#}");
                assert!(
                    message.contains(command_path(&command))
                        && message.contains("does not consume"),
                    "{message}"
                );
                assert!(
                    !message.contains("do-not-echo-this"),
                    "the rejection must not echo the credential: {message}"
                );
                if !*url {
                    assert!(message.contains("--server-url"), "{message}");
                }
                if !*token {
                    assert!(message.contains("--auth-token"), "{message}");
                }
                if !*profile {
                    assert!(message.contains("--profile"), "{message}");
                }
            }
        }
    }
}
