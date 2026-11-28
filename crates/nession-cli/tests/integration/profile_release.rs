//! #4682 SC-05: release continuity and archived-version compatibility.
//!
//! The upgrade/failed-upgrade transaction harness (unit tests in
//! `update/transaction.rs`) proves live profile metadata, selection and
//! credential bytes survive every transaction phase. These subprocess tests
//! prove the archived-dispatch contract: a profile-aware archive consumes the
//! installation client context read-only, an unsupported archive is refused
//! for implicit profile-dependent invocations, and the dispatcher hands over
//! the installation home without rebinding it into the archive's daemon state.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::os::unix::fs::PermissionsExt;

use super::profile_support::{add_profile, combined, run, set_credential, Auth, Endpoint, Home};

/// Write a fake archived release whose CLI is a shell script.
fn fake_archive(home: &Home, version: &str, script_body: &str) -> std::path::PathBuf {
    let bin = home.path().join("versions").join(version).join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for name in ["nession", "nession-agent", "nession-server"] {
        let path = bin.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 2\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let cli = bin.join("nession");
    std::fs::write(&cli, script_body).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

const PROFILE_CONTRACT_SCRIPT: &str = "#!/bin/sh\n\
     if [ \"$1\" = \"--client-profile-contract\" ]; then\n\
     echo \"nession-client-profile-v1 0.35.0\"; exit 0; fi\n\
     env > \"$ENV_RECORD\"\n\
     exit 0\n";

#[test]
fn the_dispatcher_hands_the_installation_home_to_a_profile_aware_archive() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    fake_archive(&home, "0.35.0", PROFILE_CONTRACT_SCRIPT);
    let record = home.path().join("env-record.txt");

    let output = run(home
        .nession()
        .env("ENV_RECORD", &record)
        .args(["+0.35.0", "sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    let recorded = std::fs::read_to_string(&record).expect("archive ran");
    assert!(
        recorded.contains(&format!("NESSION_CLIENT_HOME={}", home.path().display())),
        "the installation home must be handed over: {recorded}"
    );
    assert!(
        recorded.contains(&format!(
            "NESSION_HOME={}",
            home.path().join("versions/0.35.0").display()
        )),
        "daemon state stays rebound to the version home: {recorded}"
    );
    assert!(recorded.contains("NESSION_VERSION_DISPATCHED=1"));
}

#[test]
fn an_unsupported_archive_is_refused_for_implicit_profile_context() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    // A legacy archive: no profile contract (the probe fails), records only a
    // real dispatch, never the capability probe.
    fake_archive(
        &home,
        "0.34.0",
        "#!/bin/sh\n\
         if [ \"$1\" = \"--client-profile-contract\" ]; then exit 2; fi\n\
         env > \"$ENV_RECORD\"\nexit 0\n",
    );
    let record = home.path().join("env-record.txt");

    // Implicit current-profile invocation: refused with guidance, not exec'd.
    let output = run(home
        .nession()
        .env("ENV_RECORD", &record)
        .args(["+0.34.0", "sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(
        text.contains("predates client connection profiles"),
        "{text}"
    );
    assert!(text.contains("--server-url"), "{text}");
    assert!(!record.exists(), "the legacy archive must not run");
    assert!(endpoint.was_not_dialled());

    // --profile on a legacy archive: refused clearly.
    let output = run(home.nession().env("ENV_RECORD", &record).args([
        "+0.34.0",
        "--profile",
        "home",
        "sessions",
        "list",
    ]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("does not support --profile"));
    assert!(!record.exists());

    // profile management on a legacy archive: refused.
    let output = run(home
        .nession()
        .env("ENV_RECORD", &record)
        .args(["+0.34.0", "profile", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("predates client connection profiles"));
    assert!(!record.exists());

    // NESSION_PROFILE alone is profile-dependent: refused.
    let output = run(home
        .nession()
        .env("ENV_RECORD", &record)
        .env("NESSION_PROFILE", "home")
        .args(["+0.34.0", "sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("NESSION_PROFILE"));
    assert!(!record.exists());

    // An explicit URL keeps the legacy path: the archive runs, without a
    // client-home handover (it cannot consume one).
    let output = run(home.nession().env("ENV_RECORD", &record).args([
        "+0.34.0",
        "--server-url",
        &endpoint.url(),
        "sessions",
        "list",
    ]));
    assert!(output.status.success(), "{}", combined(&output));
    let recorded = std::fs::read_to_string(&record).unwrap();
    assert!(!recorded.contains("NESSION_CLIENT_HOME="));
}

#[test]
fn a_profile_aware_archive_consumes_the_live_context_read_only() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    set_credential(&home, "home", "archive-canary");
    let store_before = home.store_text().unwrap();

    // The archive home is a separate empty directory: only NESSION_CLIENT_HOME
    // points at the installation's live client context.
    let archive_home = Home::new();
    let archived = || {
        let mut command = home.nession();
        command
            .env("NESSION_HOME", archive_home.path())
            .env("NESSION_VERSION_DISPATCHED", "1")
            .env("NESSION_CLIENT_HOME", home.path());
        command
    };

    // Remote resolution consumes the live selection and credential.
    let output = run(archived().args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        endpoint.presented_token().as_deref(),
        Some("archive-canary")
    );

    // Read-only inspection works against the live store.
    let output = run(archived().args(["profile", "list"]));
    assert!(output.status.success());
    assert!(combined(&output).contains("home"));

    // Every mutation is refused; the live store is untouched.
    for args in [
        vec!["profile", "add", "x", "--server-url", "ws://x/ws"],
        vec!["profile", "use", "home"],
        vec!["profile", "remove", "home", "--force"],
        vec!["profile", "set", "home", "--no-auth"],
        vec!["profile", "import-agent"],
        vec!["profile", "credential", "clear", "home"],
    ] {
        let output = run(archived().args(&args));
        assert!(!output.status.success(), "{args:?}");
        assert!(combined(&output).contains("read-only"), "{args:?}");
    }
    assert_eq!(home.store_text().unwrap(), store_before);
    assert!(home.credential_path("home").exists());
    assert!(
        archive_home.store_text().is_none(),
        "no store in the archive home"
    );
}

#[test]
fn a_dispatched_archive_never_bootstraps() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    home.write_agent_config(&endpoint.url());
    let archive_home = Home::new();
    // An agent config in the archive home must not bootstrap a client store.
    archive_home.write_agent_config("ws://archive-agent:9/ws");

    let mut archived = home.nession();
    archived
        .env("NESSION_HOME", archive_home.path())
        .env("NESSION_VERSION_DISPATCHED", "1")
        .env("NESSION_CLIENT_HOME", home.path());
    let output = run(archived.args(["sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("127.0.0.1:8080"));
    assert!(
        home.store_text().is_none(),
        "no bootstrap into the live home"
    );
    assert!(
        archive_home.store_text().is_none(),
        "no bootstrap into the archive"
    );
}

#[test]
fn an_unsupported_client_schema_is_refused_read_only() {
    let home = Home::new();
    std::fs::write(home.store_path(), "schema_version = 99\n").unwrap();
    let archive_home = Home::new();
    let mut archived = home.nession();
    archived
        .env("NESSION_HOME", archive_home.path())
        .env("NESSION_VERSION_DISPATCHED", "1")
        .env("NESSION_CLIENT_HOME", home.path());
    let output = run(archived.args(["sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("unsupported client connection store schema"));
    assert_eq!(home.store_text().unwrap(), "schema_version = 99\n");
}
