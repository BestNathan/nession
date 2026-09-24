use nession_agent::tmux::manager::SessionManager;
use nession_agent::tmux::util::{check_tmux_available, send_keys};

use super::{tmux_show_environment, unique_session_name, TestSession};

/// What `set_environment` writes is what tmux holds.
///
/// **This is the test that would have caught #980**, and it is the only shape
/// that could: the bug was invisible from the agent side because "the variable
/// is set" and "it is not" produced the same observable behaviour there. The
/// function built `set-environment -t <session> -e KEY=VALUE`, and both halves
/// of that are refused by tmux — `-e` is `new-session`'s flag (`unknown flag
/// -e`, exit 1) and a joined `KEY=VALUE` is not a variable name (`variable
/// name contains =`, exit 1). Every variable it was asked for went unset while
/// every caller reported success. So the assertion has to be a read back out of
/// tmux, on the same socket, through the real `env.rs` path — not the return
/// value.
///
/// The values are the edge cases #991 names, and they are what makes "passed as
/// a separate argv value" observable rather than assumed: a joined
/// `KEY=VALUE`, or anything that re-split the value on whitespace or quotes,
/// changes or loses it. The `=` case is the sharp one — a value containing `=`
/// still reads back byte-identical precisely because nothing reconstructs it
/// into `KEY=VALUE`.
#[tokio::test]
async fn set_environment_round_trips_through_tmux() {
    let manager = SessionManager::new();
    let session = TestSession::new("setenv");
    let name = session.name().to_string();

    manager
        .create_session(&name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let vars = vec![
        (
            "NESSON_PLAIN".to_string(),
            "written-by-the-test".to_string(),
        ),
        ("NESSON_SPACED".to_string(), "a b  c".to_string()),
        (
            "NESSON_QUOTED".to_string(),
            r#"he said "hi" and 'bye'"#.to_string(),
        ),
        ("NESSON_EQUALS".to_string(), "k=v=w".to_string()),
        ("NESSON_EMPTY".to_string(), String::new()),
    ];

    manager
        .env()
        .set_environment(&name, &vars)
        .await
        .expect("set_environment must report success only for variables tmux kept");

    for (key, expected) in &vars {
        assert_eq!(
            tmux_show_environment(&name, key).await.as_deref(),
            Some(expected.as_str()),
            "{key} does not read back as written: tmux holds a different value, or none"
        );
    }
}

/// A refused variable is a failure even when the session is fine.
///
/// The other half of the same test: `set_environment` must not answer `Ok` for
/// a variable tmux refused. `set-environment` rejects a name containing `=`
/// (`variable name contains =`, exit 1 — measured on tmux 3.6b), which is the
/// one input that fails on a session that exists and is healthy, so nothing
/// but the variable itself can account for the result.
///
/// The well-formed variable is the control, and it is deliberately **second**:
/// a loop that returned on the first failure would never reach it, so the
/// assertion that it landed is what keeps "one bad name must not hide the
/// rest" load-bearing rather than incidental.
#[tokio::test]
async fn set_environment_reports_a_refused_variable_rather_than_succeeding() {
    let manager = SessionManager::new();
    let session = TestSession::new("setenv-bad");
    let name = session.name().to_string();

    manager
        .create_session(&name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let err = manager
        .env()
        .set_environment(
            &name,
            &[
                ("NESSON_BAD=NAME".to_string(), "2".to_string()),
                ("NESSON_GOOD_ONE".to_string(), "1".to_string()),
            ],
        )
        .await
        .expect_err("a name tmux refuses must not be reported as a successful mutation");
    let message = err.to_string();
    assert!(
        message.contains("NESSON_BAD=NAME"),
        "the failure must name the variable tmux refused: {message}"
    );
    assert!(
        message.contains("contains ="),
        "the failure must carry tmux's own diagnostic: {message}"
    );

    // The good one was still applied — one bad name does not abandon the rest —
    // and the bad one is absent, so the error is about that variable and not
    // about the session.
    assert_eq!(
        tmux_show_environment(&name, "NESSON_GOOD_ONE")
            .await
            .as_deref(),
        Some("1")
    );
    assert_eq!(tmux_show_environment(&name, "NESSON_BAD=NAME").await, None);
}

#[tokio::test]
async fn test_list_sessions_empty() {
    let manager = SessionManager::new();
    let sessions = manager.list_sessions().await.unwrap();
    // tmux may not be running, so empty list is expected
    // Length is always >= 0 for a Vec, so just check it's valid
    let _ = sessions.len();
}

#[tokio::test]
async fn test_create_and_kill_session() {
    let manager = SessionManager::new();
    let session = TestSession::new("create-kill");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Verify it exists
    let sessions = manager.list_sessions().await.unwrap();
    assert!(sessions.iter().any(|s| s.name == session_name));

    // Kill session
    manager.kill_session(&session_name).await.unwrap();

    // Verify it's gone
    let sessions = manager.list_sessions().await.unwrap();
    assert!(!sessions.iter().any(|s| s.name == session_name));
}

#[tokio::test]
async fn test_list_sessions_reports_pane_foreground_command() {
    let manager = SessionManager::new();
    let session = TestSession::new("foreground");
    let session_name = session.name().to_string();

    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let sessions = manager.list_sessions().await.unwrap();
    let info = sessions
        .iter()
        .find(|s| s.name == session_name)
        .expect("session is listed");
    let command = info
        .foreground_command
        .as_deref()
        .expect("a live pane reports its foreground command");
    assert!(
        !command.is_empty(),
        "foreground command should not be empty, got {command:?}"
    );

    manager.kill_session(&session_name).await.unwrap();
}

#[tokio::test]
async fn test_send_keys() {
    let manager = SessionManager::new();
    let session = TestSession::new("send-keys");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Send keys - should not error
    send_keys(&session_name, "echo test").await.unwrap();

    // Clean up
    manager.kill_session(&session_name).await.unwrap();
}

#[tokio::test]
async fn test_send_keys_nonexistent_session() {
    // Sending keys to a non-existent session should fail
    let ghost = unique_session_name("ghost");
    let result = send_keys(&ghost, "test").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_check_tmux_available() {
    let available = check_tmux_available().await.unwrap();
    // tmux should be available in the test environment
    assert!(available, "tmux should be available for tests");
}

#[tokio::test]
async fn test_kill_nonexistent_session() {
    let manager = SessionManager::new();
    let ghost = unique_session_name("ghost");

    // Killing a non-existent session should fail
    let result = manager.kill_session(&ghost).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_create_duplicate_session() {
    let manager = SessionManager::new();
    let session = TestSession::new("duplicate");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Creating the same session again should fail
    let result = manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await;
    assert!(result.is_err());

    // Clean up
    manager.kill_session(&session_name).await.unwrap();
}
