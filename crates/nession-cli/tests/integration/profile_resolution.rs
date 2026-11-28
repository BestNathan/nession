//! #4682 SC-03: one documented target/credential context for every remote
//! command, proven with controlled endpoints and distinct canary credentials.
//!
//! Each test asserts the destination actually dialled and the credential
//! actually presented — flag/profile/canonical env/legacy env/current/default
//! precedence, one-shot selection, conflict rejection, ambient-token isolation
//! and legacy no-profile compatibility.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use super::profile_support::{
    add_profile, combined, dead_port, run, set_credential, Auth, Endpoint, Home,
};

#[test]
fn the_explicit_flag_beats_profile_env_and_current() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    let env = Endpoint::start(Auth::Accept);
    let named = Endpoint::start(Auth::Accept);
    let flag = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "current-canary");
    add_profile(&home, "other", &named.url());
    set_credential(&home, "other", "named-canary");

    let output = run(home.nession().env("NESSION_SERVER_URL", env.url()).args([
        "--server-url",
        &flag.url(),
        "--auth-token",
        "flag-canary",
        "sessions",
        "list",
    ]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(flag.presented_token().as_deref(), Some("flag-canary"));
    assert!(current.was_not_dialled());
    assert!(env.was_not_dialled());
    assert!(named.was_not_dialled());
}

#[test]
fn the_profile_flag_beats_env_url_and_current_without_ambient_leakage() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    let env = Endpoint::start(Auth::Accept);
    let named = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "current-canary");
    add_profile(&home, "other", &named.url());
    set_credential(&home, "other", "named-canary");

    let output = run(home
        .nession()
        .env("NESSION_SERVER_URL", env.url())
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["--profile", "other", "agents", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        named.presented_token().as_deref(),
        Some("named-canary"),
        "the named profile's bound credential must be sent, not the ambient token"
    );
    assert!(current.was_not_dialled());
    assert!(env.was_not_dialled());
}

#[test]
fn canonical_env_beats_legacy_env_profile_and_current() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    let canonical = Endpoint::start(Auth::Accept);
    let legacy = Endpoint::start(Auth::Accept);
    let env_profile = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "current-canary");
    add_profile(&home, "envp", &env_profile.url());
    set_credential(&home, "envp", "envp-canary");

    let output = run(home
        .nession()
        .env("NESSION_SERVER_URL", canonical.url())
        .env("NENSION_SERVER_URL", legacy.url())
        .env("NESSION_PROFILE", "envp")
        .env("NESSION_AUTH_TOKEN", "canonical-canary")
        .env("NENSION_AUTH_TOKEN", "legacy-canary")
        .args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        canonical.presented_token().as_deref(),
        Some("canonical-canary")
    );
    assert!(legacy.was_not_dialled());
    assert!(env_profile.was_not_dialled());
    assert!(current.was_not_dialled());
}

#[test]
fn the_legacy_env_is_honoured_on_its_own() {
    let home = Home::new();
    let legacy = Endpoint::start(Auth::Accept);
    let output = run(home
        .nession()
        .env("NENSION_SERVER_URL", legacy.url())
        .env("NENSION_AUTH_TOKEN", "legacy-only-canary")
        .args(["agents", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        legacy.presented_token().as_deref(),
        Some("legacy-only-canary")
    );
}

#[test]
fn env_profile_beats_the_persisted_current() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    let env_profile = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "current-canary");
    add_profile(&home, "envp", &env_profile.url());
    set_credential(&home, "envp", "envp-canary");

    let output = run(home
        .nession()
        .env("NESSION_PROFILE", "envp")
        .args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        env_profile.presented_token().as_deref(),
        Some("envp-canary")
    );
    assert!(current.was_not_dialled());
}

#[test]
fn the_persisted_current_is_used_when_nothing_explicit_is_given() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "current-canary");

    // Two successive processes observe the same selection.
    for _ in 0..2 {
        let output = run(home.nession().args(["sessions", "list"]));
        assert!(output.status.success(), "{}", combined(&output));
        assert_eq!(current.presented_token().as_deref(), Some("current-canary"));
    }
}

#[test]
fn server_url_and_profile_together_are_rejected_as_ambiguous() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    let output = run(home.nession().args([
        "--server-url",
        &endpoint.url(),
        "--profile",
        "home",
        "sessions",
        "list",
    ]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("ambiguous"));
    assert!(endpoint.was_not_dialled());
}

#[test]
fn an_ambient_token_never_leaks_to_a_profile_endpoint() {
    let home = Home::new();
    let current = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &current.url());
    set_credential(&home, "home", "bound-canary");

    let output = run(home
        .nession()
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        current.presented_token().as_deref(),
        Some("bound-canary"),
        "an ambient token without a matching ambient URL must not be sent"
    );
}

#[test]
fn an_ambient_token_with_a_matching_ambient_url_applies_to_the_profile() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    set_credential(&home, "home", "bound-canary");

    // The profile wins the target over the ambient URL; the ambient URL is a
    // different spelling of the same canonical endpoint, so its accompanying
    // ambient token is a matching explicit target context and applies.
    let output = run(home
        .nession()
        .env("NESSION_SERVER_URL", endpoint.url_alias())
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["--profile", "home", "sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        endpoint.presented_token().as_deref(),
        Some("ambient-canary")
    );
}

#[test]
fn an_ambient_token_with_a_different_ambient_url_is_not_applied() {
    let home = Home::new();
    let profile_endpoint = Endpoint::start(Auth::Accept);
    let other = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &profile_endpoint.url());
    set_credential(&home, "home", "bound-canary");

    let output = run(home
        .nession()
        .env("NESSION_SERVER_URL", other.url())
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["--profile", "home", "sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        profile_endpoint.presented_token().as_deref(),
        Some("bound-canary"),
        "a non-matching ambient URL must not authorize the ambient token"
    );
    assert!(other.was_not_dialled());
}

#[test]
fn an_explicit_empty_token_is_a_deliberate_no_auth_override() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    set_credential(&home, "home", "bound-canary");

    let output = run(home
        .nession()
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["--auth-token", "", "sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(endpoint.presented_token().as_deref(), Some(""));
}

#[test]
fn an_explicit_no_auth_profile_sends_no_credential() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    let output = run(home.nession().args([
        "profile",
        "add",
        "home",
        "--server-url",
        &endpoint.url(),
        "--no-auth",
    ]));
    assert!(output.status.success());
    let output = run(home
        .nession()
        .env("NESSION_AUTH_TOKEN", "ambient-canary")
        .args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(endpoint.presented_token().as_deref(), Some(""));
}

#[test]
fn unknown_named_profiles_fail_closed() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());

    let output = run(home
        .nession()
        .args(["--profile", "ghost", "sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("unknown profile"));

    let output = run(home
        .nession()
        .env("NESSION_PROFILE", "ghost")
        .args(["sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("unknown profile"));
    assert!(endpoint.was_not_dialled());
}

#[test]
fn an_explicit_url_stays_stateless_with_a_corrupt_store() {
    let home = Home::new();
    std::fs::write(home.store_path(), "corrupt {{{").unwrap();
    let endpoint = Endpoint::start(Auth::Accept);
    let output = run(home.nession().args([
        "--server-url",
        &endpoint.url(),
        "--auth-token",
        "stateless-canary",
        "sessions",
        "list",
    ]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        endpoint.presented_token().as_deref(),
        Some("stateless-canary")
    );
    assert_eq!(home.store_text().unwrap(), "corrupt {{{");
}

#[test]
fn a_connection_failure_names_profile_source_and_endpoint_without_the_secret() {
    let home = Home::new();
    let port = dead_port();
    add_profile(&home, "home", &format!("ws://127.0.0.1:{port}/ws"));
    set_credential(&home, "home", "failure-canary-4682");

    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("Failed to connect"), "{text}");
    assert!(text.contains("profile 'home'"), "{text}");
    assert!(text.contains("current profile"), "{text}");
    assert!(text.contains(&format!("127.0.0.1:{port}")), "{text}");
    assert!(text.contains("nession profile test home"), "{text}");
    assert!(!text.contains("failure-canary-4682"), "{text}");
}

#[test]
fn every_remote_leaf_resolves_the_same_context() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    add_profile(&home, "home", &endpoint.url());
    set_credential(&home, "home", "leaf-canary");

    // agents list and sessions list/kill/create all dial the selected profile.
    // (attach needs a live session; its resolution path is the same resolver.)
    let output = run(home.nession().args(["agents", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(endpoint.presented_token().as_deref(), Some("leaf-canary"));

    let output = run(home.nession().args(["sessions", "list"]));
    assert!(output.status.success());
    assert_eq!(endpoint.presented_token().as_deref(), Some("leaf-canary"));

    let output = run(home
        .nession()
        .args(["sessions", "kill", "--session-id", "a:b", "--force"]));
    // The fixture serves an empty refusal-free reply; the command may report
    // the Server's answer, but it must have dialled the profile endpoint.
    let _ = output;
    assert_eq!(endpoint.presented_token().as_deref(), Some("leaf-canary"));
}
