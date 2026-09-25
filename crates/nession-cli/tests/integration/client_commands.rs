use std::process::Command;

#[test]
fn test_cli_help() {
    let output = Command::new("cargo")
        .args(["run", "--bin", "nession", "--", "--help"])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Distributed tmux session management system"));
    assert!(stdout.contains("agents"));
    assert!(stdout.contains("sessions"));
}

#[test]
fn test_agents_list_help() {
    let output = Command::new("cargo")
        .args(["run", "--bin", "nession", "--", "agents", "list", "--help"])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all agents"));
}

#[test]
fn test_sessions_list_help() {
    let output = Command::new("cargo")
        .args([
            "run", "--bin", "nession", "--", "sessions", "list", "--help",
        ])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all sessions"));
    assert!(stdout.contains("--agent-id"));
}

#[test]
fn test_agents_list_no_server() {
    // Should fail gracefully when server is not running
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "agents",
            "list",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_list_no_server() {
    // Should fail gracefully when server is not running
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "sessions",
            "list",
        ])
        .output()
        .expect("Failed to execute command");

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
