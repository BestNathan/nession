//! nession CLI - Command-line interface for the nession distributed tmux system.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;

mod client;

mod terminal;

/// Default server URL (ws://127.0.0.1:8080).
const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:8080";

/// Default auth token (empty string, should be overridden).
const DEFAULT_AUTH_TOKEN: &str = "";

#[derive(Parser)]
#[command(name = "nession")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Distributed tmux session management system")]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Server URL (ws:// or wss://). Overrides config and NENSION_SERVER_URL env var.
    #[arg(long, global = true, env = "NENSION_SERVER_URL")]
    server_url: Option<String>,

    /// Auth token for server authentication. Overrides config and NENSION_AUTH_TOKEN env var.
    #[arg(long, global = true, env = "NENSION_AUTH_TOKEN")]
    auth_token: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Agent management commands
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// Server management commands
    Server {
        #[command(subcommand)]
        action: ServerAction,
    },
    /// Agents listing and management (connects to central server)
    Agents {
        #[command(subcommand)]
        action: AgentsAction,
    },
    /// Sessions listing and management (connects to central server)
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Start the agent
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "agent-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the agent
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show agent status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}

#[derive(Subcommand)]
enum ServerAction {
    /// Start the server
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "server-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the server
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show server status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}

#[derive(Subcommand)]
enum AgentsAction {
    /// List all agents connected to the server
    List,
}

#[derive(Subcommand)]
enum SessionsAction {
    /// List all sessions (optionally filtered by agent)
    List {
        /// Filter sessions by agent ID
        #[arg(short = 'a', long)]
        agent_id: Option<String>,
    },
    /// Attach to a session (interactive terminal)
    Attach {
        /// Session ID in format "agent_id:session_name"
        #[arg(short = 's', long)]
        session_id: String,

        /// Force connection mode (p2p or relay)
        #[arg(short = 'm', long)]
        mode: Option<String>,
    },
    /// Create a new tmux session on an agent
    Create {
        /// Agent ID to create the session on
        #[arg(short = 'a', long)]
        agent_id: String,

        /// Name for the new session
        #[arg(short = 'n', long)]
        name: String,

        /// Terminal width in columns
        #[arg(long, default_value_t = 80)]
        width: u16,

        /// Terminal height in rows
        #[arg(long, default_value_t = 24)]
        height: u16,
    },
    /// Kill a tmux session on an agent
    Kill {
        /// Session ID in format "agent_id:session_name"
        #[arg(short = 's', long)]
        session_id: String,

        /// Skip confirmation prompt
        #[arg(short = 'f', long)]
        force: bool,
    },
}

/// Resolve the effective server URL from CLI flag, env, or default.
fn resolve_server_url(cli_url: Option<String>) -> String {
    cli_url.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string())
}

/// Resolve the effective auth token from CLI flag, env, or default.
fn resolve_auth_token(cli_token: Option<String>) -> String {
    cli_token.unwrap_or_else(|| DEFAULT_AUTH_TOKEN.to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Agent { action } => match action {
            AgentAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::start(config, foreground, pid_file).await?
            }
            AgentAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::stop(pid_file).await?
            }
            AgentAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::status(pid_file).await?
            }
        },
        Commands::Server { action } => match action {
            ServerAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::start(config, foreground, pid_file).await?
            }
            ServerAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::stop(pid_file).await?
            }
            ServerAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::status(pid_file).await?
            }
        },
        Commands::Agents { action } => match action {
            AgentsAction::List => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::list_agents(&server_url, &auth_token).await?;
            }
        },
        Commands::Sessions { action } => match action {
            SessionsAction::List { agent_id } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::list_sessions(&server_url, &auth_token, agent_id.as_deref())
                    .await?;
            }
            SessionsAction::Attach { session_id, mode } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::attach_session(
                    &server_url,
                    &auth_token,
                    &session_id,
                    mode.as_deref(),
                )
                .await?;
            }
            SessionsAction::Create {
                agent_id,
                name,
                width,
                height,
            } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::create_session(
                    &server_url,
                    &auth_token,
                    &agent_id,
                    &name,
                    width,
                    height,
                )
                .await?;
            }
            SessionsAction::Kill { session_id, force } => {
                // Prompt for confirmation unless --force is set
                if !force {
                    print!(
                        "Are you sure you want to kill session '{}'? [y/N] ",
                        session_id
                    );
                    use std::io::Write;
                    std::io::stdout().flush()?;
                    let mut input = String::new();
                    std::io::stdin().read_line(&mut input)?;
                    let input = input.trim().to_lowercase();
                    if input != "y" && input != "yes" {
                        println!("Aborted.");
                        return Ok(());
                    }
                }

                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::kill_session(&server_url, &auth_token, &session_id).await?;
            }
        },
    }

    Ok(())
}
