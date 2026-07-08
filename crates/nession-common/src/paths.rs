use std::io;
use std::path::PathBuf;

/// Root directory for all nession runtime files: ~/.nession
pub fn nession_home() -> io::Result<PathBuf> {
    dirs::home_dir().map(|h| h.join(".nession")).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not determine home directory",
        )
    })
}

/// Server component directory: ~/.nession/server
pub fn server_dir() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("server"))
}

/// Agent component directory: ~/.nession/agent
pub fn agent_dir() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("agent"))
}

/// Server database path: ~/.nession/server/server.db
pub fn server_db_path() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("server.db"))
}

/// Server PID file path: ~/.nession/server/server.pid
pub fn server_pid_path() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("server.pid"))
}

/// Agent PID file path: ~/.nession/agent/agent.pid
pub fn agent_pid_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("agent.pid"))
}

/// Server env-file directory: ~/.nession/server/envs
pub fn server_envs_dir() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("envs"))
}

/// Agent env-file directory: ~/.nession/agent/envs
pub fn agent_envs_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("envs"))
}

/// Agent default config path: ~/.nession/agent-config.toml
pub fn agent_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("agent-config.toml"))
}

/// Server default config path: ~/.nession/server-config.toml
pub fn server_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("server-config.toml"))
}

/// Create server and agent component directories if they don't exist.
pub fn ensure_component_dirs() -> io::Result<()> {
    std::fs::create_dir_all(server_dir()?)?;
    std::fs::create_dir_all(agent_dir()?)?;
    Ok(())
}
