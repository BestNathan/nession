//! #4682 SC-04: credential isolation and bounded, sanitized diagnostics.
//!
//! Controlled authenticated endpoints prove profile test success, auth denial,
//! connection refusal and a bounded timeout; no canary secret appears in
//! profile metadata, output, logs, errors or argv; the private-file fallback
//! permissions, endpoint rebinding and backend affinity hold.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use super::profile_support::{
    add_profile, combined, dead_port, run, set_credential, Auth, Endpoint, Home,
};

#[test]
fn profile_test_reports_success_denial_and_refusal_without_mutation() {
    let home = Home::new();
    let accept = Endpoint::start(Auth::Accept);
    let deny = Endpoint::start(Auth::Deny);
    add_profile(&home, "ok", &accept.url());
    set_credential(&home, "ok", "ok-canary");
    add_profile(&home, "denied", &deny.url());
    set_credential(&home, "denied", "denied-canary");

    let output = run(home.nession().args(["profile", "test", "ok"]));
    assert!(output.status.success(), "{}", combined(&output));
    let text = combined(&output);
    assert!(text.contains("connected and authenticated"), "{text}");
    assert!(!text.contains("ok-canary"), "{text}");
    assert_eq!(accept.presented_token().as_deref(), Some("ok-canary"));

    let output = run(home.nession().args(["profile", "test", "denied"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("authentication failed"), "{text}");
    assert!(text.contains("invalid token"), "{text}");
    assert!(text.contains("profile credential set denied"), "{text}");
    assert!(!text.contains("denied-canary"), "{text}");

    let port = dead_port();
    add_profile(&home, "refused", &format!("ws://127.0.0.1:{port}/ws"));
    set_credential(&home, "refused", "refused-canary");
    let store_before = home.store_text().unwrap();
    let output = run(home.nession().args(["profile", "test", "refused"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("connection failed"), "{text}");
    assert!(!text.contains("refused-canary"), "{text}");

    // test never changes the selection or the store.
    assert_eq!(home.store_text().unwrap(), store_before);
}

#[test]
fn profile_test_is_bounded_against_a_silent_endpoint() {
    let home = Home::new();
    let silent = Endpoint::start(Auth::Silent);
    add_profile(&home, "silent", &silent.url());
    set_credential(&home, "silent", "silent-canary");

    let start = std::time::Instant::now();
    let output = run(home.nession().args(["profile", "test", "silent"]));
    let elapsed = start.elapsed();
    assert!(!output.status.success());
    assert!(
        combined(&output).contains("timed out"),
        "{}",
        combined(&output)
    );
    assert!(
        elapsed < std::time::Duration::from_secs(15),
        "the test budget must bound the failure: {elapsed:?}"
    );
}

#[test]
fn profile_test_defaults_to_current_and_refuses_an_unset_credential() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());

    // Unset credential: guidance, no dial, no secret.
    let output = run(home.nession().args(["profile", "test"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("no client credential configured"), "{text}");
    assert!(endpoint.was_not_dialled());

    set_credential(&home, "home", "default-canary");
    let output = run(home.nession().args(["profile", "test"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        endpoint.presented_token().as_deref(),
        Some("default-canary")
    );
}

#[test]
fn no_canary_secret_escapes_through_output_store_or_errors() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    let canary = "escape-canary-4682";
    add_profile(&home, "home", &endpoint.url());
    set_credential(&home, "home", canary);

    let mut all_output = String::new();
    for args in [
        vec!["profile", "list"],
        vec!["profile", "current"],
        vec!["profile", "show", "home"],
        vec!["profile", "test", "home"],
        vec!["sessions", "list"],
        vec!["agents", "list"],
    ] {
        let output = run(home.nession().args(&args));
        all_output.push_str(&combined(&output));
    }
    // A failing connection with the credential bound.
    let port = dead_port();
    let output = run(home.nession().args([
        "profile",
        "set",
        "home",
        "--server-url",
        &format!("ws://127.0.0.1:{port}/ws"),
    ]));
    all_output.push_str(&combined(&output));
    set_credential(&home, "home", canary);
    let output = run(home.nession().args(["sessions", "list"]));
    all_output.push_str(&combined(&output));

    assert!(!all_output.contains(canary), "secret escaped: {all_output}");
    assert!(!home.store_text().unwrap().contains(canary));
    // The credential file holds the secret with private permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = home.credential_path("home");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "credential file must be 0600");
        let dir = home.path().join("client-credentials");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "credential directory must be 0700");
    }
}

#[test]
fn an_external_endpoint_rebind_refuses_the_stale_credential() {
    let home = Home::new();
    let original = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &original.url());
    set_credential(&home, "home", "rebind-canary");

    // An external edit changes the endpoint while keeping the reference: the
    // bound credential no longer matches and must never be sent.
    let store = home.store_text().unwrap();
    let edited = store.replace(&original.url(), "ws://elsewhere:9/ws");
    std::fs::write(home.store_path(), edited).unwrap();

    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("different endpoint"), "{text}");
    assert!(!text.contains("rebind-canary"), "{text}");
    assert!(original.was_not_dialled());
}

#[test]
fn an_unavailable_recorded_backend_is_a_hard_error_not_a_downgrade() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    // Record a keychain-bound reference with no keychain entry: resolution
    // must fail closed (unavailable backend or missing entry), never silently
    // read the file fallback or dial with an empty credential.
    let store = home.store_text().unwrap();
    let edited = store.replace(
        "server_url = ",
        "credential_ref = \"home\"\ncredential_backend = \"keychain\"\nserver_url = ",
    );
    std::fs::write(home.store_path(), edited).unwrap();

    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(
        text.contains("OS credential store") || text.contains("not stored"),
        "{text}"
    );
    assert!(endpoint.was_not_dialled(), "no silent fallback dial");
    assert!(!home.credential_path("home").exists(), "no file created");
}

#[test]
fn credential_commands_reject_global_target_flags() {
    let home = Home::new();
    add_profile(&home, "home", "ws://host:9/ws");
    for args in [
        vec!["profile", "credential", "set", "home", "--auth-token", "x"],
        vec![
            "profile",
            "credential",
            "set",
            "home",
            "--server-url",
            "ws://x",
        ],
        vec!["profile", "credential", "set", "home", "--profile", "home"],
        vec![
            "profile",
            "credential",
            "clear",
            "home",
            "--auth-token",
            "x",
        ],
    ] {
        let output = run(home.nession().args(&args));
        assert!(!output.status.success(), "{args:?}");
        assert!(combined(&output).contains("does not consume"), "{args:?}");
    }
}
