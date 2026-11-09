//! The CLI's parsing owner: every command, argument and default description.
//!
//! This module declares the **surface** only. Dispatch belongs to
//! [`crate::commands`], configuration resolution to [`crate::configuration`],
//! remote target/credential resolution to [`crate::connection`], and daemon
//! lifecycle primitives to [`crate::lifecycle`]. A new flag is added here and
//! then consumed by exactly one leaf handler, whose file lives under
//! `commands/`.

use clap::{Parser, Subcommand};

/// The complete `nession` command tree.
#[derive(Parser)]
#[command(name = "nession")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Distributed tmux session management system")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Remote Server URL (ws:// or wss://) for `agents`/`sessions`, or the
    /// Agent daemon's outbound Server URL override for `agent start`/
    /// `agent restart`. Overrides NESSION_SERVER_URL, the legacy
    /// NENSION_SERVER_URL alias, and the ws://127.0.0.1:8080 default.
    ///
    /// Commands that do not consume this flag reject it rather than ignoring
    /// it: `server`, `config`, `update`, and agent stop/status/service leaves.
    #[arg(long, global = true)]
    pub server_url: Option<String>,

    /// Remote credential for `agents`/`sessions`, or the Agent daemon's
    /// outbound credential override for `agent start`/`agent restart`.
    /// Overrides NESSION_AUTH_TOKEN, the legacy NENSION_AUTH_TOKEN alias, and
    /// the empty default.
    ///
    /// A value passed here is visible in shell history and in process listings
    /// while the command runs. For repeatable remote operation prefer
    /// `NESSION_AUTH_TOKEN`. Remote commands never read a daemon config
    /// (#2267); an Agent's configured outbound credential is a different
    /// boundary. Commands that do not consume this flag reject it.
    #[arg(long, global = true)]
    pub auth_token: Option<String>,
}

/// The top-level command families.
#[derive(Subcommand)]
pub enum Commands {
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
    /// Manage agent or server configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Self-update nession to the latest version
    Update {
        /// Only check for updates (don't install)
        #[arg(long)]
        check: bool,

        /// Update/downgrade to a specific version
        #[arg(long)]
        version: Option<String>,

        /// Simulate the update without changing files
        #[arg(long)]
        dry_run: bool,

        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,

        /// Also download install.sh installer script
        #[arg(long)]
        include_installer: bool,
    },
}

/// `nession agent …`
#[derive(Subcommand)]
pub enum AgentAction {
    /// Start the agent
    Start {
        /// Path to configuration file (default: ~/.nession/agent-config.toml)
        #[arg(short, long)]
        config: Option<String>,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,

        /// Internal: read the auth token handed off by the parent over stdin.
        ///
        /// The child half of the background-start handoff (#2269), not a
        /// user-facing input method. Hidden so it is not advertised as one.
        #[arg(long, hide = true)]
        auth_token_stdin: bool,
    },
    /// Stop the agent
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Restart the agent (stop then start)
    Restart {
        /// Path to configuration file (default: ~/.nession/agent-config.toml)
        #[arg(short, long)]
        config: Option<String>,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

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
    /// Install a user-level OS service to start the agent at boot
    InstallService {
        /// Path to configuration file (default: ~/.nession/agent-config.toml)
        #[arg(short, long)]
        config: Option<String>,

        /// Path to PID file (forwarded to the managed service process)
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Remove the boot autostart service (does not stop a running agent)
    UninstallService,
}

/// `nession server …`
#[derive(Subcommand)]
pub enum ServerAction {
    /// Start the server
    Start {
        /// Path to configuration file (default: ~/.nession/server-config.toml)
        #[arg(short, long)]
        config: Option<String>,

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
    /// Restart the server (stop then start)
    Restart {
        /// Path to configuration file (default: ~/.nession/server-config.toml)
        #[arg(short, long)]
        config: Option<String>,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

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

/// `nession agents …`
#[derive(Subcommand)]
pub enum AgentsAction {
    /// List all agents connected to the server
    List,
}

/// `nession sessions …`
#[derive(Subcommand)]
pub enum SessionsAction {
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

        /// Connection mode: auto (default; P2P candidates then relay), p2p, or relay
        #[arg(short = 'm', long)]
        mode: Option<String>,
    },
    /// Create a new tmux session on an agent
    ///
    /// Creation takes no dimensions: every session starts at the Agent's
    /// default size and the first client to attach states the size it ends up
    /// with (#2268).
    Create {
        /// Agent ID to create the session on
        #[arg(short = 'a', long)]
        agent_id: String,

        /// Name for the new session
        #[arg(short = 'n', long)]
        name: String,

        /// JSON file with a versioned SandboxPolicy to bind to the Session.
        ///
        /// The Agent validates and compiles it; an explicitly requested
        /// guarantee this host cannot install refuses the create rather than
        /// falling back to a Native Session.
        #[arg(long)]
        sandbox_policy: Option<std::path::PathBuf>,
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

/// `nession config …`
#[derive(Subcommand)]
pub enum ConfigAction {
    /// Manage agent configuration
    Agent {
        #[command(subcommand)]
        action: ConfigSubAction,
    },
    /// Manage server configuration
    Server {
        #[command(subcommand)]
        action: ConfigSubAction,
    },
}

/// A `config agent|server` operation.
///
/// Every operation accepts `--config`, so `init`, `show` and `set` all name
/// the same file a daemon was (or will be) started with. Without it, they
/// operate on that target's documented default path.
#[derive(Subcommand)]
pub enum ConfigSubAction {
    /// Initialize default configuration file
    ///
    /// A Server file starts in local no-auth mode: it listens on 127.0.0.1:8080
    /// with an empty auth_token. Remote access is an explicit edit of both
    /// listen_address and auth_token; `--force` rewrites the same safe default.
    Init {
        /// Overwrite existing config file if present
        #[arg(short, long)]
        force: bool,

        /// Config file to write (default: the target's default path)
        #[arg(short, long)]
        config: Option<String>,
    },
    /// Show current configuration
    Show {
        /// Config file to read (default: the target's default path)
        #[arg(short, long)]
        config: Option<String>,
    },
    /// Set a configuration value
    Set {
        /// Configuration key to set (dotted keys address nested fields)
        key: String,
        /// New value (use "" or "none" to clear optional fields)
        value: String,
        /// Config file to edit (default: the target's default path)
        #[arg(short, long)]
        config: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::collections::BTreeMap;

    fn collect_leaf_flags(
        command: &clap::Command,
        path: Vec<String>,
        out: &mut BTreeMap<String, Vec<String>>,
    ) {
        for sub in command.get_subcommands() {
            let name = sub.get_name();
            if name == "help" {
                continue;
            }
            let mut next = path.clone();
            next.push(name.to_string());
            if sub.get_subcommands().next().is_some() {
                collect_leaf_flags(sub, next, out);
            } else {
                let mut flags: Vec<String> = sub
                    .get_arguments()
                    .filter_map(|arg| arg.get_long().map(|long| format!("--{long}")))
                    .filter(|flag| flag != "--help")
                    .collect();
                flags.sort();
                flags.dedup();
                out.insert(next.join(" "), flags);
            }
        }
    }

    /// The complete leaf/flag matrix. A new or renamed flag changes this test;
    /// that is the point — every declared flag must be visible here and
    /// consumed by its leaf handler (SC-03).
    #[test]
    fn the_complete_leaf_command_and_flag_matrix_is_pinned() {
        let mut actual = BTreeMap::new();
        collect_leaf_flags(&Cli::command(), Vec::new(), &mut actual);

        let expected: BTreeMap<String, Vec<String>> = BTreeMap::from([
            (
                "agent start".to_string(),
                strings(&[
                    "--auth-token-stdin",
                    "--config",
                    "--foreground",
                    "--pid-file",
                ]),
            ),
            ("agent stop".to_string(), strings(&["--pid-file"])),
            (
                "agent restart".to_string(),
                strings(&["--config", "--foreground", "--pid-file"]),
            ),
            ("agent status".to_string(), strings(&["--pid-file"])),
            (
                "agent install-service".to_string(),
                strings(&["--config", "--pid-file"]),
            ),
            ("agent uninstall-service".to_string(), strings(&[])),
            (
                "server start".to_string(),
                strings(&["--config", "--foreground", "--pid-file"]),
            ),
            ("server stop".to_string(), strings(&["--pid-file"])),
            (
                "server restart".to_string(),
                strings(&["--config", "--foreground", "--pid-file"]),
            ),
            ("server status".to_string(), strings(&["--pid-file"])),
            ("agents list".to_string(), strings(&[])),
            ("sessions list".to_string(), strings(&["--agent-id"])),
            (
                "sessions attach".to_string(),
                strings(&["--mode", "--session-id"]),
            ),
            (
                "sessions create".to_string(),
                strings(&["--agent-id", "--name", "--sandbox-policy"]),
            ),
            (
                "sessions kill".to_string(),
                strings(&["--force", "--session-id"]),
            ),
            (
                "config agent init".to_string(),
                strings(&["--config", "--force"]),
            ),
            ("config agent show".to_string(), strings(&["--config"])),
            ("config agent set".to_string(), strings(&["--config"])),
            (
                "config server init".to_string(),
                strings(&["--config", "--force"]),
            ),
            ("config server show".to_string(), strings(&["--config"])),
            ("config server set".to_string(), strings(&["--config"])),
            (
                "update".to_string(),
                strings(&[
                    "--check",
                    "--dry-run",
                    "--include-installer",
                    "--version",
                    "--yes",
                ]),
            ),
        ]);

        assert_eq!(actual, expected);
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn the_remote_target_flags_are_global_and_declared_once() {
        let command = Cli::command();
        let flags: Vec<String> = command
            .get_arguments()
            .filter_map(|arg| arg.get_long().map(|long| format!("--{long}")))
            .collect();
        for expected in ["--server-url", "--auth-token"] {
            assert!(
                flags.iter().any(|flag| flag == expected),
                "missing global {expected}: {flags:?}"
            );
        }
    }
}
