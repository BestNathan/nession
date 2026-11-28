//! #4682 SC-02: the one-time Agent endpoint bootstrap, through the real CLI.
//!
//! With an isolated valid Agent config and no client configuration or explicit
//! target, the first eligible `sessions list` selects/imports that endpoint
//! rather than localhost; no daemon credential is copied; later Agent edits,
//! a missing Agent daemon and repeated/concurrent invocations never change the
//! existing selection. Absent/invalid config and missing selection follow the
//! documented distinct behavior.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use super::profile_support::{combined, run, set_credential, Auth, Endpoint, Home};

#[test]
fn first_sessions_list_imports_the_agent_endpoint_not_localhost() {
    let home = Home::new();
    let agent_endpoint = Endpoint::start(Auth::Accept);
    home.write_agent_config(&agent_endpoint.url());

    // First eligible remote command: imports the endpoint, then refuses with
    // credential guidance (the imported profile is unset; daemon credentials
    // are never copied). No daemon is running anywhere in this fixture.
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("no client credential configured"), "{text}");
    assert!(text.contains("profile credential set agent"), "{text}");
    assert!(text.contains(&agent_endpoint.url()), "{text}");
    assert!(
        !text.contains("127.0.0.1:8080"),
        "the imported endpoint, not the legacy loopback, must be named: {text}"
    );
    assert!(!text.contains("daemon-auth-canary-4682"), "{text}");
    assert!(!text.contains("daemon-agent-canary-4682"), "{text}");

    let store = home.store_text().expect("bootstrap created the store");
    assert!(store.contains("current_profile = \"agent\""));
    assert!(store.contains(&agent_endpoint.url()));
    assert!(!store.contains("daemon-auth-canary-4682"));
    assert!(!store.contains("daemon-agent-canary-4682"));

    // With a client credential configured, the same command now dials the
    // imported endpoint with the client canary — never a daemon credential.
    set_credential(&home, "agent", "client-canary-4682");
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        agent_endpoint.presented_token().as_deref(),
        Some("client-canary-4682"),
        "the imported endpoint must be dialled with the client credential"
    );
}

#[test]
fn later_agent_edits_and_repeated_invocations_keep_the_selection() {
    let home = Home::new();
    let original = Endpoint::start(Auth::Accept);
    let changed = Endpoint::start(Auth::Accept);
    home.write_agent_config(&original.url());

    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success()); // credential guidance after import
    set_credential(&home, "agent", "client-canary");
    let store_before = home.store_text().unwrap();

    // The Agent config changes underneath; the client selection must not.
    home.write_agent_config(&changed.url());
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(original.presented_token().as_deref(), Some("client-canary"));
    assert!(changed.was_not_dialled(), "no re-import on Agent change");
    assert_eq!(home.store_text().unwrap(), store_before);

    // Repeated invocations keep dialling the same selected endpoint.
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(output.status.success());
    assert_eq!(original.presented_token().as_deref(), Some("client-canary"));
    assert_eq!(home.store_text().unwrap(), store_before);
}

#[test]
fn concurrent_first_invocations_bootstrap_idempotently() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    home.write_agent_config(&endpoint.url());

    let children: Vec<_> = (0..6)
        .map(|_| {
            home.nession()
                .args(["sessions", "list"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn sessions list")
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().expect("wait");
        // Every first invocation imports then refuses with credential
        // guidance; none may fall back to localhost or copy a daemon secret.
        let text = combined(&output);
        assert!(text.contains("no client credential configured"), "{text}");
        assert!(!text.contains("daemon-auth-canary-4682"), "{text}");
    }
    let store = home.store_text().unwrap();
    assert_eq!(store.matches("[profiles.agent]").count(), 1);
    assert!(store.contains("current_profile = \"agent\""));
    assert!(store.contains(&endpoint.url()));
}

#[test]
fn an_absent_agent_config_keeps_loopback_with_an_actionable_hint() {
    let home = Home::new();
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("ws://127.0.0.1:8080"), "{text}");
    assert!(text.contains("loopback default"), "{text}");
    assert!(text.contains("profile import-agent"), "{text}");
    assert!(
        home.store_text().is_none(),
        "no bogus profile from defaults"
    );
}

#[test]
fn an_invalid_agent_config_fails_without_a_profile_or_fallback() {
    for bad in [
        "this is not toml {{{".to_string(),
        "server_url = 123\n".to_string(),
        "server_url = \"\"\n".to_string(),
        "server_url = \"http://not-ws\"\n".to_string(),
    ] {
        let home = Home::new();
        std::fs::write(home.path().join("agent-config.toml"), &bad).unwrap();
        let output = run(home.nession().args(["sessions", "list"]));
        assert!(!output.status.success(), "{bad:?}");
        let text = combined(&output);
        assert!(
            text.contains("Agent config")
                && (text.contains("refusing to import") || text.contains("invalid server_url")),
            "{bad:?}: {text}"
        );
        assert!(home.store_text().is_none(), "{bad:?}: no bogus profile");
    }

    // A valid config without an explicit server_url is not an import source;
    // the legacy loopback remains permitted.
    let home = Home::new();
    std::fs::write(
        home.path().join("agent-config.toml"),
        "terminal_cols = 96\n",
    )
    .unwrap();
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("ws://127.0.0.1:8080"));
    assert!(home.store_text().is_none());
}

#[test]
fn an_existing_store_without_selection_requires_explicit_choice() {
    let home = Home::new();
    let endpoint = Endpoint::start(Auth::Accept);
    home.write_agent_config(&endpoint.url());

    // Create a store, then clear its selection by removing the current profile.
    let output = run(home.nession().args(["profile", "import-agent"]));
    assert!(output.status.success());
    let output = run(home
        .nession()
        .args(["profile", "remove", "agent", "--force"]));
    assert!(output.status.success());
    assert!(home.store_text().unwrap().contains("schema_version"));

    // Bootstrap must not run again: explicit selection is required.
    let output = run(home.nession().args(["sessions", "list"]));
    assert!(!output.status.success());
    let text = combined(&output);
    assert!(text.contains("no selected profile"), "{text}");
    assert!(text.contains("profile use"), "{text}");
    assert!(endpoint.was_not_dialled());
    assert!(!home.store_text().unwrap().contains("[profiles.agent]"));
}

#[test]
fn explicit_flags_and_env_never_persist_a_profile() {
    let home = Home::new();
    let flag_endpoint = Endpoint::start(Auth::Accept);
    let env_endpoint = Endpoint::start(Auth::Accept);
    home.write_agent_config("ws://agent-endpoint:9/ws");

    let output = run(home.nession().args([
        "--server-url",
        &flag_endpoint.url(),
        "--auth-token",
        "flag-canary",
        "sessions",
        "list",
    ]));
    assert!(output.status.success(), "{}", combined(&output));
    assert_eq!(
        flag_endpoint.presented_token().as_deref(),
        Some("flag-canary")
    );
    assert!(home.store_text().is_none(), "explicit flags never persist");

    let output = run(home
        .nession()
        .env("NESSION_SERVER_URL", env_endpoint.url())
        .args(["sessions", "list"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert!(home.store_text().is_none(), "explicit env never persists");
}
