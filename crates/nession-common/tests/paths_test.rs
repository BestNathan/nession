use nession_common::paths;
use std::path::PathBuf;

fn expected_home() -> PathBuf {
    dirs::home_dir().unwrap().join(".nession")
}

#[test]
fn test_nession_home() {
    assert_eq!(paths::nession_home().unwrap(), expected_home());
}

#[test]
fn test_server_dir() {
    assert_eq!(paths::server_dir().unwrap(), expected_home().join("server"));
}

#[test]
fn test_agent_dir() {
    assert_eq!(paths::agent_dir().unwrap(), expected_home().join("agent"));
}

#[test]
fn test_server_db_path() {
    assert_eq!(
        paths::server_db_path().unwrap(),
        expected_home().join("server").join("server.db")
    );
}

#[test]
fn test_server_pid_path() {
    assert_eq!(
        paths::server_pid_path().unwrap(),
        expected_home().join("server").join("server.pid")
    );
}

#[test]
fn test_agent_pid_path() {
    assert_eq!(
        paths::agent_pid_path().unwrap(),
        expected_home().join("agent").join("agent.pid")
    );
}

#[test]
fn test_ensure_component_dirs_creates_directories() {
    paths::ensure_component_dirs().expect("ensure_component_dirs should succeed");
    assert!(paths::server_dir().unwrap().exists());
    assert!(paths::agent_dir().unwrap().exists());
}
