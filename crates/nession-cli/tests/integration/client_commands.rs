use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_nession");

/// A loopback endpoint nothing is listening on (see session_commands.rs).
fn refused_endpoint() -> std::io::Result<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(format!("ws://127.0.0.1:{port}"))
}

/// Run the real CLI binary under an owned home, never a nested `cargo run`
/// (#4597 F08).
fn cli(args: &[&str], server_url: Option<&str>) -> std::io::Result<std::process::Output> {
    let home = tempfile::tempdir()?;
    // not-tmux: runs the nession CLI binary, not a tmux process
    let mut command = Command::new(BIN);
    command
        .env(nession_common::paths::NESSION_HOME_ENV, home.path())
        .env("NESION_NO_UPDATE_CHECK", "1");
    if let Some(url) = server_url {
        command.args(["--server-url", url]);
    }
    command.args(args).output()
}

#[test]
fn test_cli_help() {
    let output = cli(&["--help"], None).unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Distributed tmux session management system"));
    assert!(stdout.contains("agents"));
    assert!(stdout.contains("sessions"));
}

#[test]
fn test_agents_list_help() {
    let output = cli(&["agents", "list", "--help"], None).unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all agents"));
}

#[test]
fn test_sessions_list_help() {
    let output = cli(&["sessions", "list", "--help"], None).unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all sessions"));
    assert!(stdout.contains("--agent-id"));
}

#[test]
fn test_agents_list_no_server() {
    let endpoint = refused_endpoint().unwrap();
    let output = cli(&["agents", "list"], Some(&endpoint)).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_list_no_server() {
    let endpoint = refused_endpoint().unwrap();
    let output = cli(&["sessions", "list"], Some(&endpoint)).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

// The two deserialization tests that lived here fed seven-field and six-field
// JSON into the CLI's own `AgentInfo` / `SessionInfo`. Both types are gone
// (#1015): the CLI renders `WebAgentInfo` and `WebSessionInfo` now, and the
// fixtures above would no longer parse — which is the protection, not a
// casualty. Those structs named 7 and 6 fields against builders that send 13
// and 8, so a reply carrying all of them failed to deserialize and a reply
// carrying fewer than the local copy silently succeeded for the wrong shape.
//
// Decoding is asserted where the types live now: `crates/nession-client/tests/`
// runs it against a real Server's reply rather than against a fixture that
// agreed with a second copy of the same literals.
