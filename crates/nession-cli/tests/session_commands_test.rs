//! Tests for session create and kill commands.

use std::process::Command;

#[test]
fn test_sessions_create_help() {
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "sessions",
            "create",
            "--help",
        ])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Create a new tmux session"));
    assert!(stdout.contains("--agent-id"));
    assert!(stdout.contains("--name"));
    assert!(stdout.contains("--width"));
    assert!(stdout.contains("--height"));
}

#[test]
fn test_sessions_kill_help() {
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "sessions",
            "kill",
            "--help",
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
