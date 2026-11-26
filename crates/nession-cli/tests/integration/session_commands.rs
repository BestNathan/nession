//! Tests for session create and kill commands.

use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_nession");

/// A loopback endpoint nothing is listening on.
///
/// Binding `:0` and dropping the listener yields a port that was free a moment
/// ago, so the CLI's connection is refused deterministically. The previous
/// fixed `localhost:59999` could be occupied by another test run or an
/// unrelated service, which made a "no server" assertion depend on the host
/// (#4597 F08).
fn refused_endpoint() -> std::io::Result<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(format!("ws://127.0.0.1:{port}"))
}

/// Run the real CLI binary under an owned home, never the developer's
/// `~/.nession` or a nested `cargo run` (#4597 F08).
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
fn test_sessions_create_help() {
    let output = cli(&["sessions", "create", "--help"], None).unwrap();

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
    let endpoint = refused_endpoint().unwrap();
    let output = cli(
        &[
            "sessions",
            "create",
            "--agent-id",
            "test-agent",
            "--name",
            "test-session",
            "--width",
            "111",
        ],
        Some(&endpoint),
    )
    .unwrap();

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
    let output = cli(&["sessions", "kill", "--help"], None).unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Kill a tmux session"));
    assert!(stdout.contains("--session-id"));
    assert!(stdout.contains("--force"));
}

#[test]
fn test_sessions_create_no_server() {
    let endpoint = refused_endpoint().unwrap();
    let output = cli(
        &[
            "sessions",
            "create",
            "--agent-id",
            "test-agent",
            "--name",
            "test-session",
        ],
        Some(&endpoint),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_kill_no_server() {
    let endpoint = refused_endpoint().unwrap();
    let output = cli(
        &[
            "sessions",
            "kill",
            "--session-id",
            "test-agent:test-session",
            "--force",
        ],
        Some(&endpoint),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_kill_invalid_format() {
    let endpoint = refused_endpoint().unwrap();
    let output = cli(
        &[
            "sessions",
            "kill",
            "--session-id",
            "invalid-format-no-colon",
            "--force",
        ],
        Some(&endpoint),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Invalid session ID") || stderr.contains("Expected format"));
}
