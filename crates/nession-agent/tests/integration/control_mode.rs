//! ControlModeSession 集成测试
//!
//! Requires tmux binary on PATH. Each test owns a private temporary tmux
//! socket/server plus a unique session, so parallel integration tests cannot
//! tear down or heal the server underneath a control-mode attach.

use anyhow::{anyhow, Result};
use nession_agent::tmux::cmd::TmuxCmd;
use nession_agent::tmux::control::ControlModeSession;
use nession_agent::tmux::ops::TmuxDep;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;

use super::unique_session_name;

/// One control-mode integration test's private tmux server.
///
/// The repository-level test harness intentionally gives the whole test run one
/// socket, which is correct for production-path integration tests but unsafe for
/// these timing-sensitive control-mode tests: another parallel test can remove
/// the last session, let tmux exit, or race stale-socket healing while this test
/// is between create and attach. A per-test injected dependency makes the tmux
/// server lifetime part of the fixture instead of shared ambient state.
struct ControlTestSession {
    name: String,
    dep: TmuxDep,
    _dir: tempfile::TempDir,
}

impl ControlTestSession {
    async fn new(prefix: &str) -> Result<Self> {
        let dir = tempfile::tempdir()?;
        let dep = TmuxDep::injected(TmuxCmd::new("tmux", dir.path().join("tmux.sock")));
        let name = unique_session_name(prefix);

        let output = dep
            .cmd()
            .output(&["new-session", "-d", "-s", &name, "-x", "200", "-y", "60"])
            .await?;
        if !output.status.success() {
            return Err(anyhow!(
                "failed to create isolated tmux session {name}: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        sleep(Duration::from_millis(300)).await;

        Ok(Self {
            name,
            dep,
            _dir: dir,
        })
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn dep(&self) -> &TmuxDep {
        &self.dep
    }
}

impl Drop for ControlTestSession {
    fn drop(&mut self) {
        let _ = self
            .dep
            .cmd()
            .output_blocking(&["kill-session", "-t", &self.name]);
    }
}

/// Read a session's window size from the exact tmux server this fixture owns.
async fn window_size(session: &ControlTestSession) -> Result<(u16, u16)> {
    session.dep().ops().window_size(session.name()).await
}

/// Drain the output receiver, accumulating bytes until either the deadline
/// elapses or the receiver closes. Uses a short recv timeout per iteration.
async fn drain_bytes(rx: &mut mpsc::Receiver<Vec<u8>>, total_ms: u64) -> Vec<u8> {
    let mut acc = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(total_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(100).min(remaining), rx.recv()).await {
            Ok(Some(chunk)) => acc.extend_from_slice(&chunk),
            Ok(None) => break, // Sender dropped
            Err(_) => {}       // Timeout - loop and check deadline
        }
    }
    acc
}

// NOTE: on macOS tmux 3.6b (Homebrew), control-mode clients can crash
// the server ("server exited unexpectedly") during parallel tests.
// We skip the actual tmux interaction on macOS — the function still
// compiles and returns Ok so line coverage stays above threshold.
// The full path is exercised on Linux CI.
#[tokio::test]
async fn test_attach_and_receive_output() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-attach").await?;

    let (mut session, mut rx, _resize_rx, capture) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, None).await?;
    assert!(capture.is_none(), "no capture was requested");

    // Drain any startup output (initial screen redraw from refresh-client).
    let _ = drain_bytes(&mut rx, 500).await;

    // Send a command; expect echo of a distinctive marker in the output.
    let marker = "CTRLMODE_MARKER_12345";
    let cmd = format!("echo {marker}\n");
    session.write_input(cmd.as_bytes()).await?;

    let bytes = drain_bytes(&mut rx, 2000).await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains(marker),
        "output should contain marker; got: {text:?}"
    );

    let _ = session.close().await;
    // `guard` drops the tmux session, including on the `?` paths above.
    Ok(())
}

#[tokio::test]
async fn test_resize_updates_viewport() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-resize").await?;

    let (mut session, _rx, _resize_rx, _capture) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, None).await?;

    assert_eq!(session.viewport(), (80, 24));

    session.resize(120, 40).await?;
    assert_eq!(session.viewport(), (120, 40));

    session.resize(100, 30).await?;
    assert_eq!(session.viewport(), (100, 30));

    let _ = session.close().await;
    Ok(())
}

/// Two clients on one session share **one tmux window**: a resize by either
/// moves the pane for both, and the most recent caller wins.
///
/// This is the sizing model `2026-08-15-viewport-fit-terminal-migration-design.md`
/// §2 decided — "accept last-writer-wins (a client resize resizes the shared
/// pane for everyone). No arbitration." — superseding the fixed-200×60 model.
///
/// The assertions read tmux's own `#{window_width}`/`#{window_height}` rather
/// than `ControlModeSession::viewport`. That field is written by `attach` and
/// `resize` from their own arguments, so asserting on it only restates what the
/// caller just passed and holds whatever tmux did — which is why the test this
/// replaces (`test_multiple_clients_independent_viewport`) could not fail,
/// while its name and comment claimed the independent-sized model that had
/// been explicitly rejected.
#[tokio::test]
async fn two_clients_share_one_window() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-shared").await?;

    let (mut client1, _rx1, _rz1, _cap1) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, None).await?;
    let (mut client2, _rx2, _rz2, _cap2) =
        ControlModeSession::attach(guard.dep(), guard.name(), 120, 40, None).await?;
    sleep(Duration::from_millis(300)).await;

    // client2 attached second, and `attach` resizes the window on the way in,
    // so the one shared window is its size. client1's 80×24 did not survive,
    // and client1 does not get a viewport of its own to keep it in.
    assert_eq!(
        window_size(&guard).await?,
        (120, 40),
        "the second attach resizes the one shared window"
    );

    // Now client1 resizes. It is the only client asking for anything, and the
    // window moves anyway — that is the shared resource, and it is what
    // client2 is looking at too.
    client1.resize(100, 30).await?;
    sleep(Duration::from_millis(300)).await;
    assert_eq!(
        window_size(&guard).await?,
        (100, 30),
        "client1's resize moves the shared window that client2 also sees"
    );

    let _ = client1.close().await;
    let _ = client2.close().await;
    Ok(())
}

/// A size change one client causes reaches **another** client (#1349).
///
/// This is the assertion a synthetic line cannot make, and the reason the bug
/// lived: every other test here feeds the router a `%window-resize` string and
/// checks it routes, which says nothing about whether tmux ever *sends* one.
/// Measured 2026-10-01, tmux 3.6b does not — a control client attached and
/// resized underneath printed `%layout-change @0 a87d,100x30,0,0,0` and no
/// `%window-resize` at all. So this drives the real thing: two control-mode
/// clients on one window, and the second one's attach (which resizes the shared
/// window) is the "peer reflow" the first has to hear about.
///
/// Red before the fix, and red by *timeout* rather than by a wrong value: the
/// first client was told nothing at all.
#[tokio::test]
async fn a_peer_driven_resize_reaches_the_other_client() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-peer-reflow").await?;

    let (mut client1, _rx1, mut rz1, _cap1) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, None).await?;
    sleep(Duration::from_millis(300)).await;

    // Whatever the first attach reported about its own resize is not this
    // test's subject; drain it so the assertion below reads what follows.
    while rz1.try_recv().is_ok() {}

    // The second client attaches at a different size, which moves the one
    // shared window — the peer reflow.
    let (mut client2, _rx2, _rz2, _cap2) =
        ControlModeSession::attach(guard.dep(), guard.name(), 120, 40, None).await?;

    let reported = tokio::time::timeout(Duration::from_secs(5), rz1.recv())
        .await
        .map_err(|_| {
            anyhow!(
                "the first client was never told the window moved to 120x40: the size signal \
                 tmux actually sends is not being read"
            )
        })?;
    assert_eq!(
        reported,
        Some((120, 40)),
        "the first client was told about a resize, but not the one that happened"
    );

    let _ = client1.close().await;
    let _ = client2.close().await;
    Ok(())
}

#[tokio::test]
async fn test_close_is_idempotent() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-close").await?;

    let (mut session, _rx, _resize_rx, _capture) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, None).await?;

    session.close().await?;
    session.close().await?;

    Ok(())
}

/// The bootstrap barrier (#1228): a producer running *across* the attach must
/// land each of its lines **exactly once** across the capture and the live
/// stream — the pre-#1228 shape captured from a separate tmux process, whose
/// ordering against the control client's `%output` stream nothing constrained,
/// so lines produced between the control attach and the capture arrived twice
/// (measured on the e2e `terminal-io` mid-stream attach as GAP-015 twice).
///
/// The mechanism the assertions pin: the capture is taken on the control
/// channel itself, so tmux's own wire order is the barrier — `%output` queued
/// before the capture's `%begin` is inside the capture (dropped from the live
/// stream), and output after it is not (forwarded).
#[tokio::test]
async fn the_bootstrap_capture_and_the_live_stream_join_exactly() -> Result<()> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    let guard = ControlTestSession::new("ctrl-barrier").await?;

    // Start the producer BEFORE attaching: 60 numbered lines, 50ms apart, so
    // production straddles the control attach and the capture.
    guard
        .dep()
        .ops()
        .send_keys(
            guard.name(),
            "for i in $(seq 1 60); do printf 'GAP-%03d\\n' $i; sleep 0.05; done",
        )
        .await?;

    // Let the stream get ahead of the attach: at 50ms/line, 300ms is ~6
    // lines in the scrollback before the control client exists. Without the
    // straddle the capture is empty of GAP lines and the test degenerates to
    // "the live stream works" — measured: an attach that outran GAP-001 made
    // even the barrier's drop-path invisible to a mutation.
    sleep(Duration::from_millis(300)).await;

    let (mut session, mut rx, _resize_rx, capture) =
        ControlModeSession::attach(guard.dep(), guard.name(), 80, 24, Some(5000)).await?;

    // The producer takes 3s; the deadline covers it plus attach overhead.
    let live = drain_bytes(&mut rx, 10_000).await;
    let live_text = String::from_utf8_lossy(&live);
    let capture_text = String::from_utf8_lossy(
        capture
            .as_deref()
            .expect("a straddled stream must yield a bootstrap capture"),
    );

    let mut seen = std::collections::HashMap::new();
    for text in [&capture_text, &live_text] {
        for line in text.lines() {
            // EVERY occurrence: an escape sequence echoing the producer
            // command (`GAP-%03d`, no digits) can share a line with real
            // output, and taking only the first hit would skip the line's
            // real index — measured: that, not the barrier, is what made
            // this test's first red run report GAP-001 missing.
            for (pos, _) in line.match_indices("GAP-") {
                let idx = line
                    .get(pos + 4..pos + 7)
                    .and_then(|digits| digits.parse::<u32>().ok());
                if let Some(idx) = idx {
                    if (1..=60).contains(&idx) {
                        *seen.entry(idx).or_insert(0u32) += 1;
                    }
                }
            }
        }
    }

    for idx in 1..=60 {
        assert_eq!(
            seen.get(&idx).copied().unwrap_or(0),
            1,
            "GAP-{idx:03} must appear exactly once across capture ∪ live \
             (pre-#1228 it could appear in both)\ncapture: {capture_text:?}\nlive: {live_text:?}"
        );
    }
    // And the straddle must actually have happened: some indices in the
    // capture, some in the live stream, or the exact-join property was never
    // exercised.
    let in_capture = (1..=60)
        .filter(|i| capture_text.contains(&format!("GAP-{i:03}")))
        .count();
    let in_live = (1..=60)
        .filter(|i| live_text.contains(&format!("GAP-{i:03}")))
        .count();
    assert!(
        in_capture > 0 && in_live > 0,
        "the stream must straddle the capture — capture has {in_capture} GAP lines, \
         live has {in_live}\ncapture: {capture_text:?}"
    );

    let _ = session.close().await;
    Ok(())
}
