use std::io;
use std::path::PathBuf;

/// Environment variable that overrides the nession home directory.
/// When set, all paths (server dir, agent dir, DB, PID, etc.)
/// are resolved relative to this directory instead of `$HOME/.nession`.
pub const NESSION_HOME_ENV: &str = "NESSION_HOME";

/// Root directory for all nession runtime files.
///
/// Resolution order:
/// 1. `$NESSION_HOME` env var — if set, use it directly
/// 2. `$HOME/.nession` — standard XDG-style default
pub fn nession_home() -> io::Result<PathBuf> {
    if let Ok(home) = std::env::var(NESSION_HOME_ENV) {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    dirs::home_dir().map(|h| h.join(".nession")).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not determine home directory (set NESSION_HOME or ensure HOME is set)",
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

/// Server logs directory: ~/.nession/server/logs
pub fn server_logs_dir() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("logs"))
}

/// Agent logs directory: ~/.nession/agent/logs
pub fn agent_logs_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("logs"))
}

/// Agent identity file path: ~/.nession/agent/identity
pub fn agent_identity_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("identity"))
}

/// Agent default config path: ~/.nession/agent-config.toml
pub fn agent_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("agent-config.toml"))
}

/// Server default config path: ~/.nession/server-config.toml
pub fn server_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("server-config.toml"))
}

/// Create server and agent component directories (including logs) if they
/// don't exist.
pub fn ensure_component_dirs() -> io::Result<()> {
    std::fs::create_dir_all(server_dir()?)?;
    std::fs::create_dir_all(server_logs_dir()?)?;
    std::fs::create_dir_all(agent_dir()?)?;
    std::fs::create_dir_all(agent_logs_dir()?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise tests that touch the NESSION_HOME env var — Rust runs tests in
    /// parallel by default, and `set_var`/`remove_var` are process-global (not
    /// thread-safe).  Without this guard `test_nession_home_env_override` can
    /// overwrite the env var while `test_nession_home` is reading it, causing
    /// a spurious assertion failure in CI.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_nession_home() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let home = nession_home().unwrap();
        assert!(home.to_string_lossy().ends_with(".nession"));
    }

    #[test]
    fn test_nession_home_env_override() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().to_path_buf();
        std::env::set_var("NESSION_HOME", tmp.to_string_lossy().as_ref());
        let home = nession_home().unwrap();
        assert_eq!(home, tmp);
        std::env::remove_var("NESSION_HOME");
    }

    #[test]
    fn test_server_dir() {
        let dir = server_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("server"));
    }

    #[test]
    fn test_agent_dir() {
        let dir = agent_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("agent"));
    }

    #[test]
    fn test_server_db_path() {
        let path = server_db_path().unwrap();
        assert!(path.to_string_lossy().ends_with("server.db"));
    }

    #[test]
    fn test_server_pid_path() {
        let path = server_pid_path().unwrap();
        assert!(path.to_string_lossy().ends_with("server.pid"));
    }

    #[test]
    fn test_agent_pid_path() {
        let path = agent_pid_path().unwrap();
        assert!(path.to_string_lossy().ends_with("agent.pid"));
    }

    #[test]
    fn test_server_envs_dir() {
        let dir = server_envs_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("envs"));
    }

    #[test]
    fn test_agent_envs_dir() {
        let dir = agent_envs_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("envs"));
    }

    #[test]
    fn test_agent_identity_path() {
        let path = agent_identity_path().unwrap();
        assert!(path.to_string_lossy().ends_with("identity"));
        assert!(path.to_string_lossy().contains("agent"));
    }

    #[test]
    fn test_agent_config_path() {
        let path = agent_config_path().unwrap();
        assert!(path.to_string_lossy().ends_with("agent-config.toml"));
    }

    #[test]
    fn test_server_config_path() {
        let path = server_config_path().unwrap();
        assert!(path.to_string_lossy().ends_with("server-config.toml"));
    }

    // --- Inlined from tests/paths_test.rs (exact-path assertions) ---

    fn expected_home() -> PathBuf {
        dirs::home_dir()
            .expect("home directory should be available")
            .join(".nession")
    }

    #[test]
    fn test_nession_home_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(nession_home().unwrap(), expected_home());
    }

    #[test]
    fn test_server_dir_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(server_dir().unwrap(), expected_home().join("server"));
    }

    #[test]
    fn test_agent_dir_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(agent_dir().unwrap(), expected_home().join("agent"));
    }

    #[test]
    fn test_server_db_path_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(
            server_db_path().unwrap(),
            expected_home().join("server").join("server.db")
        );
    }

    #[test]
    fn test_server_pid_path_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(
            server_pid_path().unwrap(),
            expected_home().join("server").join("server.pid")
        );
    }

    #[test]
    fn test_agent_pid_path_exact() {
        let _guard = ENV_MUTEX.lock().unwrap();
        assert_eq!(
            agent_pid_path().unwrap(),
            expected_home().join("agent").join("agent.pid")
        );
    }

    #[test]
    fn test_ensure_component_dirs_creates_directories() {
        let _guard = ENV_MUTEX.lock().unwrap();
        ensure_component_dirs().expect("ensure_component_dirs should succeed");
        assert!(server_dir().unwrap().exists());
        assert!(agent_dir().unwrap().exists());
    }
}
