//! nession CLI - Command-line interface for the nession distributed tmux system.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;

#[derive(Parser)]
#[command(name = "nession")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Distributed tmux session management system")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
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
        #[arg(long, default_value = "/tmp/nession-agent.pid")]
        pid_file: String,
    },
    /// Stop the agent
    Stop {
        /// Path to PID file
        #[arg(long, default_value = "/tmp/nession-agent.pid")]
        pid_file: String,
    },
    /// Show agent status
    Status {
        /// Path to PID file
        #[arg(long, default_value = "/tmp/nession-agent.pid")]
        pid_file: String,
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
        #[arg(long, default_value = "/tmp/nession-server.pid")]
        pid_file: String,
    },
    /// Stop the server
    Stop {
        /// Path to PID file
        #[arg(long, default_value = "/tmp/nession-server.pid")]
        pid_file: String,
    },
    /// Show server status
    Status {
        /// Path to PID file
        #[arg(long, default_value = "/tmp/nession-server.pid")]
        pid_file: String,
    },
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
            } => commands::agent::start(config, foreground, pid_file).await?,
            AgentAction::Stop { pid_file } => commands::agent::stop(pid_file).await?,
            AgentAction::Status { pid_file } => commands::agent::status(pid_file).await?,
        },
        Commands::Server { action } => match action {
            ServerAction::Start {
                config,
                foreground,
                pid_file,
            } => commands::server::start(config, foreground, pid_file).await?,
            ServerAction::Stop { pid_file } => commands::server::stop(pid_file).await?,
            ServerAction::Status { pid_file } => commands::server::status(pid_file).await?,
        },
    }

    Ok(())
}
