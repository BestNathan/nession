use nession_agent::tmux::manager::SessionManager;
use nession_agent::tmux::ops::TmuxOps;
use nession_agent::tmux::util::check_tmux_available;

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
        // Leading and trailing whitespace. tmux keeps it — measured on 3.6b,
        // `set-environment -t p K 'v '` reads back as `K=v \n` — so a read-back
        // that trimmed tmux's line rather than only its newline would answer
        // with a value nobody wrote, and the roundtrip would have to be believed
        // over tmux. These two cases are what make "unchanged" mean unchanged.
        ("NESSON_TRAILING".to_string(), "v ".to_string()),
        ("NESSON_LEADING".to_string(), " v".to_string()),
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

/// `show_environment` separates "this session does not hold it" from "the
/// question could not be asked".
///
/// Both answers from tmux are a non-zero exit carrying a message on stderr —
/// measured on tmux 3.6b: `unknown variable: X` when the session exists and
/// holds nothing under that name, `no such session: X` when it does not exist.
/// Collapsing the two into one `None` would let a mistyped or already-killed
/// session name read back as "nothing is set", which is #980's shape one layer
/// up: a state that is not, reported as one that is. So both are asserted here,
/// against the same tmux, in one test — a classifier that answered `None` for
/// everything would fail the second, and one that answered `Err` for everything
/// would fail the first.
#[tokio::test]
async fn show_environment_tells_an_unset_variable_apart_from_an_unanswerable_question() {
    let manager = SessionManager::new();
    let session = TestSession::new("showenv-none");
    let name = session.name().to_string();
    manager
        .create_session(&name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let ops = TmuxOps::global();

    assert_eq!(
        ops.show_environment(&name, "NESSON_NEVER_SET")
            .await
            .expect("an existing session that holds nothing under that name is an answer"),
        None,
        "a session that exists and holds nothing must answer None, not an error"
    );

    // The session does not exist. A server is running (the create above made
    // one on this run's socket), so tmux answers in its own words rather than
    // failing to connect.
    let err = ops
        .show_environment("nession_nonexistent_xyz_123", "NESSON_NEVER_SET")
        .await
        .expect_err("a session that does not exist is not an answer of 'unset'");
    assert!(
        err.to_string().contains("no such session"),
        "the failure must carry tmux's own diagnostic rather than only our summary: {err}"
    );
}

/// `show_environment` reads the session it was given, not one of its own
/// choosing.
///
/// `-t` is not decoration on this subcommand: measured on tmux 3.6b with two
/// sessions on one socket, a target-less `show-environment <name>` answered out
/// of a session the caller never named — and reported `unknown variable` for a
/// variable the other session held. So the second assertion is the one that
/// makes the target load-bearing: the variable *is* set, on the other session.
///
/// `first` is created before `second` on purpose. That is the session tmux's own
/// target resolution picks (measured, same tmux), so the ordering is what lets
/// the second assertion catch a query that dropped `-t`: it would answer with
/// `first`'s value instead of nothing.
#[tokio::test]
async fn show_environment_reads_the_session_it_was_given() {
    let manager = SessionManager::new();
    let first = TestSession::new("showenv-first");
    let second = TestSession::new("showenv-second");
    for session in [&first, &second] {
        manager
            .create_session(session.name(), 80, 24, "/tmp", &[])
            .await
            .unwrap();
    }

    let ops = TmuxOps::global();
    ops.set_environment(first.name(), "NESSON_TARGETED", "only-in-first")
        .await
        .expect("set_environment on the first session");

    assert_eq!(
        ops.show_environment(first.name(), "NESSON_TARGETED")
            .await
            .expect("an existing session that holds the variable"),
        Some("only-in-first".to_string()),
    );
    assert_eq!(
        ops.show_environment(second.name(), "NESSON_TARGETED")
            .await
            .expect("an existing session is an answer even when it holds nothing"),
        None,
        "the second session holds nothing under that name; an answer carrying it \
         would mean the query was not bound to the session asked about"
    );
}

/// The variables a caller passes to `create_session` are in the session's
/// environment — and are **not** owed to the `BestEffort` stage-3 propagation.
///
/// This is the evidence for the class `SessionManager` assigns those variables
/// (#991's `Required` vs `BestEffort`). Stage 1 hands them to `new-session -e`,
/// which *is* a stage whose failure is the create's failure — measured on tmux
/// 3.6b, `new-session -e K=V` populates the session environment that
/// `show-environment` reads — and stage 3 repeats them for windows and panes
/// that do not exist yet. The experiment that settles the class is a negative
/// one: with stage 3's propagation loop for these variables turned off, this
/// test still passes, so a stage-3 failure cannot take a caller-visible
/// variable away. That is what makes `BestEffort` honest there rather than a
/// silent downgrade.
///
/// It also covers a production path nothing asserted on: `server_client.rs`
/// passes a flattened env snapshot to `create_session`, and until now no test
/// asked tmux whether those variables arrived — every other call site passes
/// `&[]`. Read back out of tmux, not out of the return value, for #980's reason.
#[tokio::test]
async fn create_session_env_parameter_lands_in_the_session_environment() {
    let manager = SessionManager::new();
    let session = TestSession::new("create-env");
    let name = session.name().to_string();
    let vars = vec![
        (
            "NESSON_CREATE_PLAIN".to_string(),
            "from-the-create".to_string(),
        ),
        ("NESSON_CREATE_SPACED".to_string(), "a b  c".to_string()),
    ];

    manager
        .create_session(&name, 80, 24, "/tmp", &vars)
        .await
        .expect("create with a caller env");

    for (key, expected) in &vars {
        assert_eq!(
            tmux_show_environment(&name, key).await.as_deref(),
            Some(expected.as_str()),
            "{key} was passed to create_session and is not in the session's environment"
        );
    }
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

    // Send keys - should not error. Required class: a line the caller asked to
    // be typed reaching nothing is a failure, not a degraded success.
    TmuxOps::global()
        .send_keys(&session_name, "echo test")
        .await
        .unwrap();

    // Clean up
    manager.kill_session(&session_name).await.unwrap();
}

#[tokio::test]
async fn test_send_keys_nonexistent_session() {
    // Sending keys to a non-existent session should fail
    let ghost = unique_session_name("ghost");
    let result = TmuxOps::global().send_keys(&ghost, "test").await;
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

// ── the injected tmux, from outside the crate (#991 step 6) ─────────────────
//
// `#### Testability` asks for one thing: "a fake tmux binary can exercise the
// complete env mutation path, not only `SessionManager`". These two tests are
// that, driven through the same public API any other consumer of this crate
// would use — deliberately not through a `#[cfg(test)]` seam, which is what the
// old injection point was and why the criterion stayed unmet for two steps.

/// The path, end to end, on a binary that records what it was asked to do.
///
/// Both halves of the proof are here and they are different halves: the call
/// succeeded, *and* the fake's own record says which process ran it and with
/// which argv. The first alone would pass against real tmux (a session that
/// exists accepts `set-environment`), which is the way a substitution test
/// usually proves nothing.
///
/// No tmux and no harness socket: the injected dependency addresses a socket
/// inside this test's temp dir that nothing has bound, so an injection that
/// silently did not take is a failure rather than a pass.
#[cfg(unix)]
#[tokio::test]
async fn a_fake_tmux_exercises_the_env_mutation_path_from_outside_the_crate() {
    use nession_agent::tmux::env::EnvManager;

    let dir = tempfile::tempdir().unwrap();
    let fake = super::FakeTmux::new(dir.path(), "exit 0").expect("install the fake tmux");
    let mut env = EnvManager::new(dir.path().to_path_buf());
    env.with_tmux(fake.dep());

    env.set_environment(
        "nession-fake-sess",
        &[("NESSON_OUTSIDE".to_string(), "v".to_string())],
    )
    .await
    .expect("the injected binary exits 0 for every call");

    assert_eq!(
        fake.calls(),
        vec![vec![
            "set-environment",
            "-t",
            "nession-fake-sess",
            "NESSON_OUTSIDE",
            "v"
        ]],
        "the operation must have run on the injected binary, in the owner's grammar"
    );
}

/// The class, from outside the crate: a required mutation that tmux refuses is
/// an error, and the error carries tmux's own words.
///
/// This is #980's failure mode as a public-API contract. The fake is what makes
/// it checkable without needing real tmux to fail for the right reason — the
/// only way to make real tmux refuse a `set-environment` is a session that does
/// not exist, which is also what a *working* implementation reports.
#[cfg(unix)]
#[tokio::test]
async fn a_refused_required_mutation_is_reported_from_outside_the_crate() {
    use nession_agent::tmux::env::EnvManager;

    let dir = tempfile::tempdir().unwrap();
    let fake = super::FakeTmux::new(
        dir.path(),
        "case \"$1\" in set-environment) echo 'unknown flag -e' >&2; exit 1;; *) exit 0;; esac",
    )
    .expect("install the fake tmux");
    let mut env = EnvManager::new(dir.path().to_path_buf());
    env.with_tmux(fake.dep());

    let err = env
        .set_environment(
            "nession-fake-sess",
            &[("NESSON_OUTSIDE".to_string(), "v".to_string())],
        )
        .await
        .expect_err("a required mutation must not be downgraded to a warning");
    let message = err.to_string();
    assert!(
        message.contains("NESSON_OUTSIDE"),
        "the failure must name the variable: {message}"
    );
    assert!(
        message.contains("unknown flag -e"),
        "and it must carry tmux's own diagnostic: {message}"
    );
}
