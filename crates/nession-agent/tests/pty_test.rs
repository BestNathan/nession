use nession_agent::tmux::pty::PtySession;
use std::time::Duration;
use tokio::time::sleep;

/// Helper: accumulate output until no new bytes arrive within `quiet_ms`.
async fn drain_output(session: &PtySession, quiet_ms: u64, max_total_ms: u64) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(max_total_ms);
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let n = session
            .read_output(&mut buf, quiet_ms)
            .await
            .unwrap_or(0);
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    out
}

#[tokio::test]
async fn test_pty_spawn_and_close_lifecycle() {
    // Spawn a simple shell that stays alive so we can exercise close().
    let session = PtySession::spawn_command("sh", &["-c", "sleep 30"], 80, 24)
        .await
        .expect("spawn should succeed");

    assert!(!session.is_closed().await);
    session.close().await.expect("close should succeed");
    assert!(session.is_closed().await);

    // close() must be idempotent.
    session.close().await.expect("second close should succeed");
    assert!(session.is_closed().await);
}

#[tokio::test]
async fn test_pty_input_output_flow() {
    // Spawn `cat` — it echoes anything written to it.
    let session = PtySession::spawn_command("cat", &[], 80, 24)
        .await
        .expect("spawn should succeed");

    // Give the reader thread a moment to start and any initial prompt/echo
    // to arrive.
    sleep(Duration::from_millis(50)).await;
    let _ = drain_output(&session, 100, 500).await;

    let msg = b"hello pty\n";
    session
        .write_input(msg)
        .await
        .expect("write should succeed");

    // Wait for `cat` to echo the data back through the PTY.
    sleep(Duration::from_millis(200)).await;
    let output = drain_output(&session, 300, 2000).await;
    session.close().await.ok();

    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("hello pty"),
        "expected echoed input in output, got: {:?}",
        output_str
    );
}

#[tokio::test]
async fn test_pty_resize_does_not_panic() {
    let session = PtySession::spawn_command("sh", &["-c", "sleep 5"], 80, 24)
        .await
        .expect("spawn should succeed");

    // Resize must succeed and be safe to call multiple times.
    session.resize(120, 40).await.expect("resize 1");
    session.resize(200, 50).await.expect("resize 2");

    session.close().await.ok();
}

#[tokio::test]
async fn test_pty_drop_cleans_up() {
    let session = PtySession::spawn_command("sh", &["-c", "sleep 30"], 80, 24)
        .await
        .expect("spawn should succeed");

    // Drop without explicit close — Drop impl should kill the child.
    drop(session);
    // Nothing to assert directly; if the child leaked, subsequent test
    // runs would accumulate sleeping `sh` processes. The test passing
    // without hanging is the signal.
}
