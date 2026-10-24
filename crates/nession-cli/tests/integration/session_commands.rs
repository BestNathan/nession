//! Tests for session create and kill commands.

use std::process::Command;

#[test]
fn test_sessions_create_help() {
    let output = Command::new("cargo")
        .args([
            "run", "--bin", "nession", "--", "sessions", "create", "--help",
        ])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Create a new tmux session"));
    assert!(stdout.contains("--agent-id"));
    assert!(stdout.contains("--name"));
    assert!(
        !stdout.contains("--width") && !stdout.contains("--height"),
        "creation states no dimensions; the first attach owns the size (#2268): {stdout}"
    );
}

/// #2268: the removed options must fail as options, not silently succeed as
/// ignored input. The command must not reach the Server.
#[test]
fn test_sessions_create_rejects_removed_dimensions() {
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "sessions",
            "create",
            "--agent-id",
            "test-agent",
            "--name",
            "test-session",
            "--width",
            "111",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(
        !output.status.success(),
        "an ignored dimension must not read as a successful create"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unexpected argument"),
        "the parser must name the removed option: {stderr}"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("Creating session"),
        "the command must fail before contacting the Server: {stdout}"
    );
}

#[test]
fn test_sessions_kill_help() {
    let output = Command::new("cargo")
        .args([
            "run", "--bin", "nession", "--", "sessions", "kill", "--help",
        ])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Kill a tmux session"));
    assert!(stdout.contains("--session-id"));
    assert!(stdout.contains("--force"));
}

#[test]
fn test_sessions_create_no_server() {
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
            "create",
            "--agent-id",
            "test-agent",
            "--name",
            "test-session",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_kill_no_server() {
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
            "kill",
            "--session-id",
            "test-agent:test-session",
            "--force",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_kill_invalid_format() {
    // Should fail when session_id doesn't contain ':'
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "sessions",
            "kill",
            "--session-id",
            "invalid-format-no-colon",
            "--force",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Invalid session ID") || stderr.contains("Expected format"));
}
