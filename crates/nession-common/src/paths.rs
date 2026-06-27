use std::io;
use std::path::PathBuf;

/// Root directory for all nession runtime files: ~/.nession
pub fn nession_home() -> PathBuf {
    dirs::home_dir()
        .expect("could not determine home directory")
        .join(".nession")
}

/// Server component directory: ~/.nession/server
pub fn server_dir() -> PathBuf {
    nession_home().join("server")
}

/// Agent component directory: ~/.nession/agent
pub fn agent_dir() -> PathBuf {
    nession_home().join("agent")
}

/// Server database path: ~/.nession/server/server.db
pub fn server_db_path() -> PathBuf {
    server_dir().join("server.db")
}

/// Server PID file path: ~/.nession/server/server.pid
pub fn server_pid_path() -> PathBuf {
    server_dir().join("server.pid")
}

/// Agent PID file path: ~/.nession/agent/agent.pid
pub fn agent_pid_path() -> PathBuf {
    agent_dir().join("agent.pid")
}

/// Create server and agent component directories if they don't exist.
pub fn ensure_component_dirs() -> io::Result<()> {
    std::fs::create_dir_all(server_dir())?;
    std::fs::create_dir_all(agent_dir())?;
    Ok(())
}
